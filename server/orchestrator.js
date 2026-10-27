'use strict';
// 编排器：管理「接力」。
// - 用户发消息 → 被 @ 的成员排队（没 @ 就交给默认成员）
// - 成员一个接一个执行（共用一个项目文件夹，同一时间只有一个在改文件，避免冲突）
// - 成员的最终回复里 @ 了谁，谁就接着做 —— AI 之间就这样自己交流
// - 自动接力达到上限会暂停，等用户确认；用户随时可以停止
// - 成员 @用户 时按会话设置处理：停下来等用户（人工审查）、先问审查模型（自动执行），或者照常往下走（全权代理）
const fs = require('fs');
const adapters = require('./adapters');
const files = require('./files');
const skills = require('./skills');
const acceptance = require('./acceptance');
const { recordRun } = require('./usage');
const models = require('./models');
const { t: tr } = require('./i18n');
const { parseMentions, buildCliPrompt, buildApiMessages, buildReviewPrompt, buildReviewApiMessages, parseVerdict, approvalMode } = require('./prompt');

const { RESUME_FAIL } = require('./adapters/common'); // 续上旧会话失败时换新会话重来

function clip(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// 交付核对：文件卡片只看得到项目文件夹里的改动，写到外面的文件从工具记录里找（用命令写的没法知道）；
// 能改文件的成员这一轮什么都没改，也记下来。两样都显示在消息上，也写进给下一位成员的记录（见 prompt.js 的 renderMsg）
function delivery({ items, changed, status, complete, canWrite }) {
  const wrote = items.filter((it) => (it.k === 'write' || it.k === 'edit') && it.s !== 'error');
  const out = [...new Set(wrote.flatMap((it) => it.out || []))];
  const check = {};
  if (out.length) check.outside = out.slice(0, 50);
  // 依赖、构建产物和 . 开头的文件夹不进快照：工具记录里写了项目里的文件，就不说「没改」；快照被截断时也不下结论
  if (status === 'done' && canWrite && complete && !changed.length && !wrote.some((it) => !it.out)) check.unchanged = true;
  return check;
}

const lastUserSeq = (msgs) => {
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].from === 'user') return msgs[i].seq;
  return 0;
};

function statusFor(it) {
  const d = clip(it.d || '', 48);
  switch (it.k) {
    case 'read': return tr('阅读 {file}', { file: d });
    case 'write': return tr('写入 {file}', { file: d });
    case 'edit': return tr('修改 {file}', { file: d });
    case 'cmd': return tr('运行 {cmd}', { cmd: d });
    case 'search': return tr('查找文件');
    case 'web': return tr('状态::查资料');
    case 'agent': return tr('派出子任务');
    case 'todo': return tr('整理待办');
    default: return tr('调用 {tool}', { tool: it.n || tr('工具') });
  }
}

class Orchestrator {
  constructor(store, bus, usage) {
    this.store = store;
    this.bus = bus;
    this.usage = usage || null; // token 用量（见 usage.js），测试里可以不给
    this.rts = new Map();
  }

  rt(roomId) {
    let r = this.rts.get(roomId);
    if (!r) {
      // pauseReason：limit = 自动接力到了上限；error = 有成员出错，后面的先不做；ask = 有成员在等用户回复（asked 是谁）。
      // review：审查模型正在审查某个成员的请求（这时也不往下走）。
      // task：这次任务从哪条用户消息开始（空闲时发的消息开始一次新任务）；base：任务开始时的文件快照（见 keepBase）
      r = { queue: [], running: null, paused: false, pauseReason: '', failed: null, asked: null, review: null, autoTurns: 0, timer: null, lastSent: 0, task: 0, base: null };
      this.rts.set(roomId, r);
    }
    return r;
  }

  state(roomId) {
    const r = this.rt(roomId);
    const room = this.store.getRoom(roomId);
    return {
      roomId,
      running: r.running ? { agentId: r.running.agentId, startedAt: r.running.startedAt } : null,
      queue: r.queue.map((q) => ({ agentId: q.agentId, auto: !!q.auto, byName: q.byName })),
      paused: r.paused,
      pauseReason: r.paused ? r.pauseReason : '',
      failed: r.paused ? r.failed : null,
      asked: r.paused && r.asked ? { agentId: r.asked.agentId, name: r.asked.name, reason: r.asked.reason || '' } : null,
      review: r.review ? { agentId: r.review.asker.id, name: r.review.asker.name, by: r.review.by, startedAt: r.review.startedAt } : null,
      autoTurns: r.autoTurns,
      sessions: room ? Object.keys(room.sessions || {}) : [], // 哪些成员已经有会话记忆
    };
  }

  progress(roomId) {
    const run = this.rt(roomId).running;
    if (!run) return { roomId, running: null };
    return {
      roomId,
      running: {
        agentId: run.agentId,
        startedAt: run.startedAt,
        status: run.status,
        live: run.live.slice(-4000),
        items: run.items.slice(-60).map((it) => (it.k === 'note' ? { ...it, d: clip(it.d, 1500) } : it)),
        total: run.items.length,
      },
    };
  }

  emitState(roomId) {
    this.bus.send('state', this.state(roomId));
  }

  emitProgress(roomId, now = false) {
    const r = this.rt(roomId);
    const send = () => {
      r.timer = null;
      r.lastSent = Date.now();
      this.bus.send('progress', this.progress(roomId));
    };
    if (now) {
      if (r.timer) clearTimeout(r.timer);
      return send();
    }
    if (r.timer) return;
    r.timer = setTimeout(send, Math.max(0, 150 - (Date.now() - r.lastSent)));
  }

  system(roomId, text, extra = {}) {
    const msg = this.store.addMessage(roomId, { from: 'system', name: '系统', kind: 'system', text, ...extra });
    this.bus.send('message', { roomId, message: msg });
    return msg;
  }

  // 用户没 @ 人时，这条消息交给谁：有人正在干活 → 交给他；空闲 → 默认成员；有人在排队 → 不额外指定
  defaultTargets(room) {
    const r = this.rt(room.id);
    const enabled = room.agents.filter((a) => a.enabled !== false);
    if (r.running) return [r.running.agentId];
    if (r.queue.length) return [];
    const def = enabled.find((a) => a.id === room.settings.defaultAgent) || enabled[0];
    return def ? [def.id] : [];
  }

  resolveTargets(room, text, selfId) {
    const enabled = room.agents.filter((a) => a.enabled !== false);
    let ids = parseMentions(text, enabled);
    if (ids.includes('all')) ids = [...ids.filter((x) => x !== 'all'), ...enabled.map((a) => a.id)];
    return [...new Set(ids)].filter((id) => id !== 'user' && id !== 'all' && id !== selfId);
  }

  // attachments：这条消息带的附件（已经都在项目文件夹里，见 files.js 的 checkAttachments）
  postUser(roomId, text, attachments = []) {
    const room = this.store.getRoom(roomId);
    if (!room) throw new Error(tr('会话不存在'));
    const r = this.rt(roomId);
    // 有成员在等你回复（接力停在那里，或者审查模型正在替你看）：没 @ 人就交给问你的那位。
    // 回复里的成员先做，原来排着的再接着往下
    const waiting = r.review ? r.review.asker.id : r.paused && r.asked ? r.asked.agentId : '';
    let targets = this.resolveTargets(room, text);
    if (!targets.length && waiting && room.agents.some((a) => a.id === waiting && a.enabled !== false)) targets = [waiting];
    if (!targets.length) targets = this.defaultTargets(room);
    const fresh = !this.isBusy(roomId);
    const msg = this.store.addMessage(roomId, { from: 'user', name: '用户', kind: 'user', text, ...(attachments.length ? { attachments } : {}) });
    this.bus.send('message', { roomId, message: msg });
    if (fresh) {
      // 空闲时发的消息开始一次新任务，开始时的文件快照等第一位成员开始工作时再拍
      r.task = msg.seq;
      r.base = null;
    }
    this.cancelReview(r); // 你自己回复了，审查模型不用再替你答
    this.unpause(r);
    r.autoTurns = 0;
    if (waiting) this.enqueueFront(roomId, targets, { auto: false, seq: msg.seq, byName: '用户' });
    else this.enqueue(roomId, targets, { auto: false, seq: msg.seq, byName: '用户' });
    if (!room.agents.some((a) => a.enabled !== false)) {
      this.system(roomId, tr('这个会话还没有成员。点标题栏里的成员按钮添加一个 AI，再发消息。'));
    }
    this.emitState(roomId);
    this.pump(roomId);
    return msg;
  }

  unpause(r) {
    r.paused = false;
    r.pauseReason = '';
    r.failed = null;
    r.asked = null;
  }

  enqueue(roomId, ids, meta) {
    const r = this.rt(roomId);
    for (const id of ids) {
      if (r.queue.some((q) => q.agentId === id)) continue;
      r.queue.push({ agentId: id, ...meta });
    }
  }

  // 插到队伍最前面（你回复在等你的成员、审查模型代你答复时），原来排着的接在后面
  enqueueFront(roomId, ids, meta) {
    const r = this.rt(roomId);
    r.queue = [...ids.map((id) => ({ agentId: id, ...meta })), ...r.queue.filter((q) => !ids.includes(q.agentId))];
  }

  // 排着队的成员名字（暂停时的提示里用）
  queuedNames(room, r) {
    return [...new Set(r.queue.map((q) => room.agents.find((a) => a.id === q.agentId)?.name).filter(Boolean))].join(tr('、'));
  }

  pump(roomId) {
    const r = this.rt(roomId);
    if (r.running || r.paused || r.review) return;
    const room = this.store.getRoom(roomId);
    if (!room) return;
    while (r.queue.length) {
      const next = r.queue[0];
      const agent = room.agents.find((a) => a.id === next.agentId);
      if (!agent || agent.enabled === false) {
        r.queue.shift();
        continue;
      }
      if (next.auto) {
        const max = Math.max(1, Number(room.settings.maxAutoTurns) || 10);
        if (r.autoTurns >= max) {
          r.paused = true;
          r.pauseReason = 'limit';
          const names = this.queuedNames(room, r);
          this.system(roomId, tr('已经自动接力 {n} 轮，先停下来等你确认。点「继续接力」让 {names} 接着做，或者直接发消息给出新指示。', { n: r.autoTurns, names }), { pause: true });
          this.emitState(roomId);
          return;
        }
        r.autoTurns++;
      }
      r.queue.shift();
      this.runTurn(roomId, agent, next)
        .catch((e) => console.error('[orchestrator]', e))
        .finally(() => this.pump(roomId));
      return;
    }
    this.emitState(roomId);
  }

  // 右侧面板的「上下文」：记下成员这一轮结束时上下文用了多少（群聊里的会话；侧边对话、自动审查是另外的会话，不算）。
  // 有的工具要跑完再去读（Codex 的会话记录、OpenCode 的消息），不等它；读到了再推给界面。
  // 工具没说上下文窗口多大、用的是默认模型的，按模型目录补上
  async noteContext(roomId, agent, res, sessionId) {
    let ctx = res && res.context;
    if (!ctx && res && typeof res.contextFetch === 'function') ctx = await res.contextFetch().catch(() => null);
    if (!ctx || !(ctx.used > 0)) return;
    let model = ctx.model || res.model || agent.model || '';
    let window = ctx.window || 0;
    if ((!window || !model) && agent.adapter !== 'openai') {
      const cat = await models.catalog(agent.adapter).catch(() => null);
      if (cat && !model) model = cat.defaultModel || '';
      const m = cat && (cat.models || []).find((x) => x.id === model);
      if (!window && m && m.context) window = m.context;
    }
    const room = this.store.getRoom(roomId);
    if (!room || !room.agents.some((a) => a.id === agent.id)) return;
    if ((room.sessions[agent.id] || null) !== sessionId) return; // 读的时候会话换掉了（改了模型、换了文件夹）：已经过时
    const entry = { used: ctx.used, window, model, at: Date.now(), ...(ctx.parts ? { parts: ctx.parts } : {}) };
    room.context = { ...(room.context || {}), [agent.id]: entry };
    this.store.saveRoom(room);
    this.bus.send('context', { roomId, agentId: agent.id, context: entry });
  }

  async runTurn(roomId, agent, trigger) {
    const r = this.rt(roomId);
    const room = this.store.getRoom(roomId);
    const adapter = adapters.get(agent.adapter);
    const run = (r.running = {
      agentId: agent.id,
      startedAt: Date.now(),
      status: tr('启动中'),
      live: '',
      items: [],
      stopped: false,
      cancel: null,
    });
    this.emitState(roomId);
    this.emitProgress(roomId, true);

    let res;
    let before = null;
    try {
      if (!adapter) throw new Error(tr('未知的接入方式：{name}', { name: agent.adapter }));
      if (!room.workspace || !fs.existsSync(room.workspace)) throw new Error(tr('项目文件夹不存在：{path}', { path: room.workspace || tr('（未设置）') }));
      before = files.snapshot(room.workspace); // 和结束时的快照对比，就知道这一轮动了哪些文件
      this.keepBase(room, r, before, run.startedAt);
      res = await this.invoke(room, agent, adapter, run, trigger);
      // 会话找不到（比如换了项目文件夹）→ 丢掉旧会话，从头带上完整记录重试一次
      if (res.error && !run.stopped && res.usedSession && run.items.length === 0 && RESUME_FAIL.test(`${res.error}\n${res.stderr || ''}`)) {
        delete room.sessions[agent.id];
        delete room.lastSeen[agent.id];
        if (room.context) delete room.context[agent.id];
        res = await this.invoke(room, agent, adapter, run, trigger);
      }
    } catch (e) {
      res = { error: e.message || String(e) };
    }

    const stopped = run.stopped;
    if (res.sessionId) room.sessions[agent.id] = res.sessionId;
    if (res.upto && (res.sessionId || adapter?.stateless)) room.lastSeen[agent.id] = res.upto;
    this.store.saveRoom(room);

    // 最终回复不重复出现在过程记录里
    const items = run.items.slice();
    let text = String(res.text || '').trim();
    const lastNote = [...items].reverse().find((it) => it.k === 'note');
    if (text && items.length && items[items.length - 1].k === 'note' && items[items.length - 1].d.trim() === text) items.pop();
    else if (!text && !res.error && !stopped && lastNote) {
      text = lastNote.d.trim();
      items.splice(items.lastIndexOf(lastNote), 1);
    }

    const status = stopped ? 'stopped' : res.error ? 'error' : 'done';
    const after = before ? files.snapshot(room.workspace) : null;
    const changed = before ? files.diff(before, after, room.workspace) : [];
    const check = delivery({
      items: run.items,
      changed,
      status,
      complete: !!before && !before.truncated && !after.truncated,
      canWrite: agent.permission !== 'readonly',
    });
    const targets = status === 'done' ? this.resolveTargets(room, text, agent.id) : [];
    // 交付验收清单：打开了、并且这一条是在交给用户验收时才核对。核对出了问题也不能弄丢成员的发言
    let accepted;
    if (room.settings.acceptance && status === 'done') {
      try {
        accepted = this.accept(room, r, { agent, text, targets, items: run.items, outside: check.outside, files: changed, after });
      } catch (e) {
        console.error('[acceptance]', e);
      }
    }
    const msg = this.store.addMessage(roomId, {
      from: agent.id,
      name: agent.name,
      role: agent.role || '',
      kind: 'agent',
      adapter: agent.adapter,
      text: text || (status === 'done' ? tr('（没有回复内容）') : ''),
      status,
      error: status === 'error' ? clip(res.error, 3000) : undefined,
      items: items.slice(-300).map((it) => (it.k === 'note' ? { ...it, d: clip(it.d, 4000) } : it)),
      files: changed,
      ...check,
      ...(accepted ? { acceptance: accepted } : {}),
      meta: { ms: Date.now() - run.startedAt, model: res.model || agent.model || '', effort: agent.effort || '' },
    });
    r.running = null;
    this.bus.send('message', { roomId, message: msg });
    this.emitProgress(roomId, true);
    // 记下这一轮用了多少 token（OpenCode 要再去读一次，不等它，接力照常往下走）
    recordRun(this.usage, { room, agent, res, startedAt: run.startedAt, side: false }).catch(() => {});
    this.noteContext(roomId, agent, res, room.sessions[agent.id] || null).catch(() => {});

    if (status === 'done') {
      this.enqueue(roomId, targets, { auto: true, seq: msg.seq, byName: agent.name });
      this.gate(room, r, agent, msg);
    } else if (status === 'error' && r.queue.length) {
      // 这一环出错了，后面排队的成员先不做：等用户修好后让它重试，或者明确跳过
      r.paused = true;
      r.pauseReason = 'error';
      r.failed = { agentId: agent.id, name: agent.name };
      const names = this.queuedNames(room, r);
      this.system(
        roomId,
        tr('{name} 运行出错，接力先暂停，排在后面的 {names} 暂时不做。处理好后点「让 {name} 再试一次」从这一步接着做，或者「跳过，继续接力」。', { name: agent.name, names }),
        { pause: true }
      );
    }
    this.emitState(roomId);
  }

  // 成员 @用户 了（要你拍板、提供信息或验收）：按会话设置的「成员需要你确认时」处理（见 prompt.js 的 approvalMode）。
  // 人工审查：后面还有成员要接着做的话（原来排着的，或者这条里 @ 的），接力停下来等你回复或批准；
  // 自动执行：先交给审查模型（请你验收的也一样，它会转交给你）；全权代理：照常往下走
  gate(room, r, agent, msg) {
    const enabled = room.agents.filter((a) => a.enabled !== false);
    if (!parseMentions(msg.text, enabled).includes('user')) return;
    const mode = approvalMode(room);
    if (mode === 'auto') this.startReview(room, r, agent, msg);
    else if (mode === 'manual' && r.queue.length) this.holdForUser(room, r, agent, msg.seq);
  }

  // 接力停在这里等你：回复问你的那位（它先做），或者点「批准，继续接力」让排着的成员接着做
  holdForUser(room, r, asker, seq, reason = '') {
    r.paused = true;
    r.pauseReason = 'ask';
    r.asked = { agentId: asker.id, name: asker.name, seq, reason };
    const names = this.queuedNames(room, r);
    this.system(room.id, tr('{name} 在等你回复，接力先停在这里，排在后面的 {names} 暂时不做。直接回复它，或者点「批准，继续接力」。', { name: asker.name, names }), { pause: true });
  }

  // 审查模型：会话设置里选的成员（用它的接入方式和模型），或者专门接入的那个（room.reviewer）。一律只读
  reviewerOf(room) {
    const id = room.settings.reviewer;
    const a = id === 'own' ? room.reviewer : id ? room.agents.find((x) => x.id === id) : null;
    return a ? { ...a, permission: 'readonly' } : null;
  }

  startReview(room, r, asker, msg) {
    const rv = this.reviewerOf(room);
    if (!rv) {
      // 选了自动执行，但还没选审查模型：当成人工审查
      if (r.queue.length) this.holdForUser(room, r, asker, msg.seq, tr('还没有选审查模型，先交给你确认'));
      return;
    }
    const review = (r.review = {
      asker: { id: asker.id, name: asker.name, role: asker.role || '' },
      seq: msg.seq,
      by: { name: rv.name, adapter: rv.adapter, model: rv.model || '', own: room.settings.reviewer === 'own' },
      startedAt: Date.now(),
      stopped: false,
      cancel: null,
    });
    this.runReview(room, rv, review, msg)
      .catch((e) => ({ error: e.message || String(e) }))
      .then((out) => this.afterReview(room.id, review, out))
      .catch((e) => console.error('[review]', e))
      .finally(() => this.pump(room.id));
  }

  async runReview(room, rv, review, msg) {
    const adapter = adapters.get(rv.adapter);
    if (!adapter) throw new Error(tr('未知的接入方式：{name}', { name: rv.adapter }));
    if (!room.workspace || !fs.existsSync(room.workspace)) throw new Error(tr('项目文件夹不存在：{path}', { path: room.workspace || tr('（未设置）') }));
    const args = { room, asker: review.asker, msg, messages: this.store.messages(room.id), logPath: this.store.logPath(room) };
    // 每次都是新会话，不带记忆；过程不显示，只看结论
    const ctx = { room, agent: rv, cwd: room.workspace, sessionId: null, emit: () => {} };
    if (adapter.stateless) ctx.apiMessages = buildReviewApiMessages(args);
    else ctx.prompt = buildReviewPrompt(args);
    const h = adapter.run(ctx);
    review.cancel = h.cancel;
    if (review.stopped) h.cancel();
    const out = await h.done;
    recordRun(this.usage, { room, agent: rv, res: out, startedAt: review.startedAt, side: false }).catch(() => {});
    return out;
  }

  // 审查完：代你答复的，问你的那位先接着做（自动接力，算进上限）；转交你的，接力停下来等你
  afterReview(roomId, review, out) {
    const r = this.rt(roomId);
    if (r.review !== review) return; // 停止了，或者你已经自己回复了
    r.review = null;
    const room = this.store.getRoom(roomId);
    if (!room) return;
    const v = (!out.error && parseVerdict(out.text)) || {
      decision: 'escalate',
      reason: out.error ? tr('审查模型运行出错：{error}', { error: clip(out.error, 300) }) : tr('审查模型没有给出明确的结论'),
      reply: '',
    };
    const asker = room.agents.find((a) => a.id === review.asker.id && a.enabled !== false);
    const approve = v.decision === 'approve' && !!asker;
    const msg = this.store.addMessage(roomId, {
      from: 'review',
      name: '自动审查',
      kind: 'review',
      text: approve ? `@${asker.name} ${v.reply || tr('同意，按你推荐的方案继续。')}` : v.reason || tr('这一步要你亲自确认'),
      review: { decision: approve ? 'approve' : 'escalate', reason: v.reason, asker: review.asker, by: review.by, ask: review.seq },
      meta: { ms: Date.now() - review.startedAt, model: out.model || review.by.model },
    });
    this.bus.send('message', { roomId, message: msg });
    if (approve) this.enqueueFront(roomId, [asker.id], { auto: true, seq: msg.seq, byName: '自动审查' });
    else if (r.queue.length) this.holdForUser(room, r, review.asker, review.seq, v.reason);
    this.emitState(roomId);
  }

  cancelReview(r) {
    const review = r.review;
    if (!review) return;
    r.review = null;
    review.stopped = true;
    try {
      if (review.cancel) review.cancel();
    } catch {}
  }

  // 任务开始时的文件快照：就是这次任务第一轮开始前拍的那张（runTurn 的 before），交付验收时用来核对原有文件。
  // 打开了验收清单的会话存一份到磁盘，中途重启 Nightshift 以后还能用
  keepBase(room, r, snap, at) {
    if (r.base) return;
    const msgs = this.store.messages(room.id);
    if (!r.task) r.task = lastUserSeq(msgs);
    if (msgs.some((m) => m.kind === 'agent' && m.seq > r.task)) {
      // 任务已经做过几轮（比如重启以后接着做）：现在拍的不是开始时的样子，用存下来的那张，没有就算没有
      const saved = this.store.loadBaseline(room.id);
      r.base = saved && saved.seq === r.task && saved.ws === room.workspace ? saved : { seq: r.task, none: true };
      return;
    }
    r.base = { seq: r.task, at, ws: room.workspace, snap };
    if (room.settings.acceptance) this.store.saveBaseline(room.id, r.base);
  }

  // 任务做到一半才打开验收清单：把内存里那张快照也存下来
  saveBase(roomId) {
    const r = this.rt(roomId);
    if (r.base && r.base.snap) this.store.saveBaseline(roomId, r.base);
  }

  // 成员这一条发言算交给用户验收的话，按清单核对这次任务（见 acceptance.js），不算就返回 undefined
  accept(room, r, cur) {
    const report = acceptance.parseReport(cur.text);
    if (!acceptance.isDelivery({ text: cur.text, report, handoff: cur.targets.length > 0 })) return undefined;
    const msgs = this.store.messages(room.id);
    const task = r.task || lastUserSeq(msgs);
    const base = r.base && r.base.snap && r.base.ws === room.workspace && r.base.seq === task ? r.base : null;
    const start = msgs.find((m) => m.seq === task);
    const turns = msgs.filter((m) => m.kind === 'agent' && m.seq > task).map((m) => ({ name: m.name, items: m.items, outside: m.outside, files: m.files }));
    turns.push({ name: cur.agent.name, items: cur.items, outside: cur.outside, files: cur.files });
    return acceptance.check({
      root: room.workspace,
      text: cur.text,
      report,
      turns,
      base,
      after: cur.after,
      since: base ? { seq: base.seq, at: base.at } : { seq: task, at: start ? start.ts : 0 },
    });
  }

  async invoke(room, agent, adapter, run, trigger) {
    const messages = this.store.messages(room.id);
    const upto = room.seq;
    const sessionId = adapter.stateless ? null : room.sessions[agent.id] || null;
    const logPath = this.store.logPath(room);
    const ctx = {
      room,
      agent,
      cwd: room.workspace,
      sessionId,
      emit: (ev) => this.onEvent(room.id, run, ev),
    };
    // 最近一条用户消息里用了 /技能 时，附上技能说明。有会话记忆的成员只在第一次看到这条消息时附；API 模型没有记忆，每轮都附
    let skillText = '';
    const lastUser = [...messages].reverse().find((m) => m.from === 'user');
    if (lastUser && (adapter.stateless || lastUser.seq > ((room.lastSeen && room.lastSeen[agent.id]) || 0))) {
      try {
        const used = skills.usedSkills(lastUser.text, skills.listSkills(room.workspace));
        skillText = skills.skillSection(used, adapter.stateless ? 'api' : agent.adapter);
      } catch {}
    }
    if (adapter.stateless) ctx.apiMessages = buildApiMessages({ room, agent, messages, trigger, logPath, skillText });
    else ctx.prompt = buildCliPrompt({ room, agent, messages, fresh: !sessionId, trigger, logPath, skillText });
    const h = adapter.run(ctx);
    run.cancel = h.cancel;
    if (run.stopped) h.cancel();
    const out = await h.done;
    return { ...out, upto, usedSession: sessionId };
  }

  onEvent(roomId, run, ev) {
    if (run.stopped) return;
    switch (ev.type) {
      case 'session':
        run.sessionId = ev.id;
        break;
      case 'status':
        run.status = ev.text;
        break;
      case 'text_start':
        run.live = '';
        break;
      case 'delta':
        run.live += ev.text || '';
        run.status = tr('正在回复');
        break;
      case 'text': {
        const t = String(ev.text || '').trim();
        if (t) run.items.push({ id: 'note' + run.items.length, k: 'note', d: t });
        run.live = '';
        break;
      }
      case 'tool': {
        const it = ev.item || {};
        const ex = it.id && run.items.find((x) => x.id === it.id && x.k !== 'note');
        if (ex) {
          for (const [k, v] of Object.entries(it)) if (v !== undefined && v !== '') ex[k] = v;
        } else {
          run.items.push({ s: 'running', ...it });
        }
        const cur = ex || run.items[run.items.length - 1];
        run.status = cur.s === 'running' ? statusFor(cur) : tr('思考中');
        break;
      }
    }
    this.emitProgress(roomId);
  }

  stop(roomId) {
    const r = this.rt(roomId);
    const hadQueue = r.queue.length > 0 || r.paused || !!r.review;
    r.queue = [];
    this.cancelReview(r);
    this.unpause(r);
    if (r.running) {
      r.running.stopped = true;
      r.running.status = tr('正在停止');
      try {
        if (r.running.cancel) r.running.cancel();
      } catch {}
      this.emitProgress(roomId, true);
    } else if (hadQueue) {
      this.system(roomId, tr('你停止了接力，排队中的成员不会再执行。'));
    }
    this.emitState(roomId);
  }

  // 让某个成员再做一次（比如上次出错了）
  poke(roomId, agentId) {
    const room = this.store.getRoom(roomId);
    const agent = room && room.agents.find((a) => a.id === agentId);
    if (!agent) throw new Error(tr('成员不存在'));
    if (agent.enabled === false) throw new Error(tr('{name} 已停用', { name: agent.name }));
    const r = this.rt(roomId);
    this.cancelReview(r);
    this.unpause(r);
    // 插到队伍最前面：重试成功后，原来排在后面的成员再接着做
    r.queue = r.queue.filter((q) => q.agentId !== agentId);
    r.queue.unshift({ agentId, auto: false, seq: room.seq, byName: '用户' });
    this.emitState(roomId);
    this.pump(roomId);
  }

  resume(roomId) {
    const r = this.rt(roomId);
    this.unpause(r);
    r.autoTurns = 0;
    this.emitState(roomId);
    this.pump(roomId);
  }

  // 成员被删除/停用时，把它从队列里拿掉；正在执行的话先停掉
  dropAgent(roomId, agentId) {
    const r = this.rt(roomId);
    r.queue = r.queue.filter((q) => q.agentId !== agentId);
    if (r.running && r.running.agentId === agentId) {
      r.running.stopped = true;
      try {
        if (r.running.cancel) r.running.cancel();
      } catch {}
    }
    this.emitState(roomId);
  }

  isBusy(roomId) {
    const r = this.rt(roomId);
    return !!r.running || r.queue.length > 0 || !!r.review;
  }

  anyBusy() {
    for (const r of this.rts.values()) if (r.running || r.queue.length || r.review) return true;
    return false;
  }

  stopAll() {
    for (const [roomId, r] of this.rts) {
      r.queue = [];
      this.cancelReview(r);
      if (r.running) {
        r.running.stopped = true;
        try {
          if (r.running.cancel) r.running.cancel();
        } catch {}
      }
      this.rts.set(roomId, r);
    }
  }
}

module.exports = { Orchestrator };

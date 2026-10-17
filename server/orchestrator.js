'use strict';
// 编排器：管理「接力」。
// - 用户发消息 → 被 @ 的成员排队（没 @ 就交给默认成员）
// - 成员一个接一个执行（共用一个项目文件夹，同一时间只有一个在改文件，避免冲突）
// - 成员的最终回复里 @ 了谁，谁就接着做 —— AI 之间就这样自己交流
// - 自动接力达到上限会暂停，等用户确认；用户随时可以停止
const fs = require('fs');
const adapters = require('./adapters');
const files = require('./files');
const skills = require('./skills');
const { recordRun } = require('./usage');
const { t: tr } = require('./i18n');
const { parseMentions, buildCliPrompt, buildApiMessages } = require('./prompt');

const { RESUME_FAIL } = require('./adapters/common'); // 续上旧会话失败时换新会话重来

function clip(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

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
      // pauseReason：limit = 自动接力到了上限；error = 有成员出错，后面的先不做
      r = { queue: [], running: null, paused: false, pauseReason: '', failed: null, autoTurns: 0, timer: null, lastSent: 0 };
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

  postUser(roomId, text) {
    const room = this.store.getRoom(roomId);
    if (!room) throw new Error(tr('会话不存在'));
    let targets = this.resolveTargets(room, text);
    if (!targets.length) targets = this.defaultTargets(room);
    const msg = this.store.addMessage(roomId, { from: 'user', name: '用户', kind: 'user', text });
    this.bus.send('message', { roomId, message: msg });
    const r = this.rt(roomId);
    this.unpause(r);
    r.autoTurns = 0;
    this.enqueue(roomId, targets, { auto: false, seq: msg.seq, byName: '用户' });
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
  }

  enqueue(roomId, ids, meta) {
    const r = this.rt(roomId);
    for (const id of ids) {
      if (r.queue.some((q) => q.agentId === id)) continue;
      r.queue.push({ agentId: id, ...meta });
    }
  }

  pump(roomId) {
    const r = this.rt(roomId);
    if (r.running || r.paused) return;
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
          const names = [...new Set(r.queue.map((q) => room.agents.find((a) => a.id === q.agentId)?.name).filter(Boolean))].join(tr('、'));
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
      res = await this.invoke(room, agent, adapter, run, trigger);
      // 会话找不到（比如换了项目文件夹）→ 丢掉旧会话，从头带上完整记录重试一次
      if (res.error && !run.stopped && res.usedSession && run.items.length === 0 && RESUME_FAIL.test(`${res.error}\n${res.stderr || ''}`)) {
        delete room.sessions[agent.id];
        delete room.lastSeen[agent.id];
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
    const changed = before ? files.diff(before, files.snapshot(room.workspace), room.workspace) : [];
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
      meta: { ms: Date.now() - run.startedAt, model: res.model || agent.model || '', effort: agent.effort || '' },
    });
    r.running = null;
    this.bus.send('message', { roomId, message: msg });
    this.emitProgress(roomId, true);
    // 记下这一轮用了多少 token（OpenCode 要再去读一次，不等它，接力照常往下走）
    recordRun(this.usage, { room, agent, res, startedAt: run.startedAt, side: false }).catch(() => {});

    if (status === 'done') {
      const targets = this.resolveTargets(room, text, agent.id);
      this.enqueue(roomId, targets, { auto: true, seq: msg.seq, byName: agent.name });
    } else if (status === 'error' && r.queue.length) {
      // 这一环出错了，后面排队的成员先不做：等用户修好后让它重试，或者明确跳过
      r.paused = true;
      r.pauseReason = 'error';
      r.failed = { agentId: agent.id, name: agent.name };
      const names = [...new Set(r.queue.map((q) => room.agents.find((a) => a.id === q.agentId)?.name).filter(Boolean))].join(tr('、'));
      this.system(
        roomId,
        tr('{name} 运行出错，接力先暂停，排在后面的 {names} 暂时不做。处理好后点「让 {name} 再试一次」从这一步接着做，或者「跳过，继续接力」。', { name: agent.name, names }),
        { pause: true }
      );
    }
    this.emitState(roomId);
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
    const hadQueue = r.queue.length > 0 || r.paused;
    r.queue = [];
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
    return !!r.running || r.queue.length > 0;
  }

  anyBusy() {
    for (const r of this.rts.values()) if (r.running || r.queue.length) return true;
    return false;
  }

  stopAll() {
    for (const [roomId, r] of this.rts) {
      r.queue = [];
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

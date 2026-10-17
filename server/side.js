'use strict';
// 侧边对话：在右侧面板里单独问某个成员问题。
// - 不发到群聊，不触发接力，和正在进行的接力互不影响（可以边接力边问）
// - 只读：不管成员平时是什么权限，这里一律只能看、不能改文件
// - 用单独的会话（room.sideSessions），不会混进它在群聊里的记忆；每次提问都带上群聊的最新进展
const fs = require('fs');
const adapters = require('./adapters');
const { buildSidePrompt, buildSideApiMessages } = require('./prompt');
const { recordRun } = require('./usage');
const { t: tr } = require('./i18n');

const { RESUME_FAIL } = require('./adapters/common'); // 续上旧会话失败时换新会话重来
const clip = (s, n) => {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + '…' : s;
};

class SideChat {
  constructor(store, bus, usage) {
    this.store = store;
    this.bus = bus;
    this.usage = usage || null;
    this.runs = new Map(); // roomId → 正在回答的那一次
  }

  running(roomId) {
    const run = this.runs.get(roomId);
    if (!run) return null;
    return {
      agentId: run.agentId,
      startedAt: run.startedAt,
      status: run.status,
      live: run.live.slice(-4000),
      items: run.items.slice(-30).map((it) => (it.k === 'note' ? { ...it, d: clip(it.d, 800) } : it)),
      total: run.items.length,
    };
  }

  emit(roomId, run, now) {
    const send = () => {
      run.timer = null;
      run.lastSent = Date.now();
      this.bus.send('side-progress', { roomId, running: this.running(roomId) });
    };
    if (now) {
      clearTimeout(run.timer);
      return send();
    }
    if (!run.timer) run.timer = setTimeout(send, Math.max(0, 150 - (Date.now() - (run.lastSent || 0))));
  }

  ask(roomId, agentId, text) {
    const room = this.store.getRoom(roomId);
    if (!room) throw new Error(tr('会话不存在'));
    const agent = room.agents.find((a) => a.id === agentId);
    if (!agent) throw new Error(tr('成员不存在'));
    if (this.runs.has(roomId)) throw new Error(tr('上一个问题还在回答，等它答完或者先停止'));
    const q = this.store.addSide(roomId, { from: 'user', agentId: agent.id, toName: agent.name, text });
    this.bus.send('side-message', { roomId, message: q });
    const run = { agentId: agent.id, startedAt: Date.now(), status: tr('启动中'), live: '', items: [], stopped: false, cancel: null };
    this.runs.set(roomId, run);
    this.emit(roomId, run, true);
    this.answer(room, agent, q, run)
      .catch((e) => console.error('[side]', e))
      .finally(() => {
        clearTimeout(run.timer);
        this.runs.delete(roomId);
        this.bus.send('side-progress', { roomId, running: null });
      });
    return q;
  }

  async answer(room, agent, question, run) {
    const adapter = adapters.get(agent.adapter);
    let res;
    try {
      if (!adapter) throw new Error(tr('未知的接入方式：{name}', { name: agent.adapter }));
      if (!room.workspace || !fs.existsSync(room.workspace)) throw new Error(tr('项目文件夹不存在：{path}', { path: room.workspace || tr('（未设置）') }));
      res = await this.invoke(room, agent, adapter, question, run);
      if (res.error && !run.stopped && res.usedSession && !run.items.length && RESUME_FAIL.test(`${res.error}\n${res.stderr || ''}`)) {
        delete room.sideSessions[agent.id];
        delete room.sideSeen[agent.id];
        res = await this.invoke(room, agent, adapter, question, run);
      }
    } catch (e) {
      res = { error: e.message || String(e) };
    }
    if (res.sessionId) room.sideSessions[agent.id] = res.sessionId;
    if (!res.error || res.sessionId) room.sideSeen[agent.id] = { main: res.mainSeq || room.seq, side: question.n };
    this.store.saveRoom(room);

    const status = run.stopped ? 'stopped' : res.error ? 'error' : 'done';
    let text = String(res.text || '').trim();
    const items = run.items.slice();
    const last = items[items.length - 1];
    if (text && last && last.k === 'note' && last.d.trim() === text) items.pop();
    else if (!text && status === 'done') {
      const note = [...items].reverse().find((it) => it.k === 'note');
      if (note) {
        text = note.d.trim();
        items.splice(items.lastIndexOf(note), 1);
      }
    }
    const msg = this.store.addSide(room.id, {
      from: agent.id,
      name: agent.name,
      text: text || (status === 'done' ? tr('（没有回复内容）') : ''),
      status,
      error: status === 'error' ? clip(res.error, 3000) : undefined,
      items: items.slice(-100).map((it) => (it.k === 'note' ? { ...it, d: clip(it.d, 2000) } : it)),
      meta: { ms: Date.now() - run.startedAt, model: res.model || agent.model || '' },
    });
    this.bus.send('side-message', { roomId: room.id, message: msg });
    recordRun(this.usage, { room, agent, res, startedAt: run.startedAt, side: true }).catch(() => {});
  }

  async invoke(room, agent, adapter, question, run) {
    const messages = this.store.messages(room.id);
    const side = this.store.sideMessages(room.id).filter((m) => m.n < question.n);
    const mainSeq = room.seq;
    const sessionId = adapter.stateless ? null : room.sideSessions[agent.id] || null;
    const logPath = this.store.logPath(room);
    // 侧边对话一律只读
    const ro = { ...agent, permission: 'readonly' };
    const ctx = {
      room,
      agent: ro,
      cwd: room.workspace,
      sessionId,
      emit: (ev) => this.onEvent(room.id, run, ev),
    };
    if (adapter.stateless) ctx.apiMessages = buildSideApiMessages({ room, agent, messages, side, question: question.text, logPath });
    else {
      ctx.prompt = buildSidePrompt({
        room,
        agent,
        messages,
        side,
        question: question.text,
        fresh: !sessionId,
        seen: room.sideSeen[agent.id],
        logPath,
      });
    }
    const h = adapter.run(ctx);
    run.cancel = h.cancel;
    if (run.stopped) h.cancel();
    const out = await h.done;
    return { ...out, usedSession: sessionId, mainSeq };
  }

  onEvent(roomId, run, ev) {
    if (run.stopped) return;
    switch (ev.type) {
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
        } else run.items.push({ s: 'running', ...it });
        run.status = tr('查看项目');
        break;
      }
    }
    this.emit(roomId, run);
  }

  stop(roomId) {
    const run = this.runs.get(roomId);
    if (!run) return;
    run.stopped = true;
    run.status = tr('正在停止');
    try {
      if (run.cancel) run.cancel();
    } catch {}
    this.emit(roomId, run, true);
  }

  clear(roomId) {
    this.stop(roomId);
    const room = this.store.getRoom(roomId);
    if (room) {
      room.sideSessions = {};
      room.sideSeen = {};
      this.store.saveRoom(room);
    }
    this.store.clearSide(roomId);
    this.bus.send('side-cleared', { roomId });
  }

  anyBusy() {
    return this.runs.size > 0;
  }

  stopAll() {
    for (const id of [...this.runs.keys()]) this.stop(id);
  }
}

module.exports = { SideChat };

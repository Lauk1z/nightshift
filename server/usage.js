'use strict';
// token 用量记录：成员每跑完一轮（群聊或侧边对话）记一行，存在 data/usage.jsonl。
// 和聊天记录分开存，清空聊天记录、删除项目都不会让统计变少。
// 「用量」页按天、按模型汇总，画热力图。
const fs = require('fs');
const path = require('path');

const KINDS = ['input', 'output', 'cacheRead', 'cacheWrite'];
const pad = (n) => String(n).padStart(2, '0');
// 按本机的日期算「哪一天」（服务就跑在你自己的电脑上）
const dayKey = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const total = (r) => r.input + r.output + r.cacheRead + r.cacheWrite;
const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : 0);

function cleanRows(rows) {
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r !== 'object') continue;
    const row = { model: String(r.model || '').slice(0, 120) || 'default' };
    for (const k of KINDS) row[k] = num(r[k]);
    if (total(row)) out.push(row);
  }
  return out;
}

class Usage {
  constructor(dir) {
    this.file = path.join(dir, 'usage.jsonl');
    this.runs = [];
    try {
      for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const run = JSON.parse(line);
          run.rows = cleanRows(run.rows);
          if (run.rows.length && run.ts) this.runs.push(run);
        } catch {}
      }
    } catch {}
  }

  // run：{ ts, roomId, room, agentId, agent, adapter, ms, side, rows: [{ model, input, output, cacheRead, cacheWrite }] }
  record(run) {
    const rows = cleanRows(run.rows);
    if (!rows.length) return null;
    const entry = {
      ts: run.ts || Date.now(),
      roomId: String(run.roomId || ''),
      room: String(run.room || '').slice(0, 60),
      agentId: String(run.agentId || ''),
      agent: String(run.agent || '').slice(0, 30),
      adapter: String(run.adapter || ''),
      ms: num(run.ms),
      side: !!run.side,
      rows,
    };
    this.runs.push(entry);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, JSON.stringify(entry) + '\n', 'utf8');
    } catch {}
    return entry;
  }

  // 给用量页的汇总：每个模型一行；每天每个模型用了多少；每个模型最长的一轮用了多久
  summary() {
    const models = new Map();
    const daily = new Map();
    let longest = 0;
    const longestBy = {};
    let since = 0;
    for (const run of this.runs) {
      if (!since || run.ts < since) since = run.ts;
      const day = dayKey(run.ts);
      if (run.ms > longest) longest = run.ms;
      for (const r of run.rows) {
        // 不知道名字的默认模型按工具分开算（default:codex），界面上显示成「默认模型」
        const key = r.model === 'default' ? `default:${run.adapter || ''}` : r.model;
        let m = models.get(key);
        if (!m) {
          m = { model: key, adapters: [], agents: [], input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, runs: 0, lastTs: 0 };
          models.set(key, m);
        }
        for (const k of KINDS) m[k] += r[k];
        m.total += total(r);
        m.runs += 1;
        if (run.ts > m.lastTs) m.lastTs = run.ts;
        if (run.adapter && !m.adapters.includes(run.adapter)) m.adapters.push(run.adapter);
        if (run.agent && !m.agents.includes(run.agent) && m.agents.length < 6) m.agents.push(run.agent);
        const dk = `${day}\t${key}`;
        daily.set(dk, (daily.get(dk) || 0) + total(r));
        if (run.ms > (longestBy[key] || 0)) longestBy[key] = run.ms;
      }
    }
    return {
      since,
      runs: this.runs.length,
      today: dayKey(Date.now()),
      models: [...models.values()].sort((a, b) => b.total - a.total),
      daily: [...daily].map(([k, t]) => {
        const [d, m] = k.split('\t');
        return { d, m, t };
      }),
      longest: { all: longest, byModel: longestBy },
    };
  }
}

// 群聊和侧边对话跑完一轮都调这个：用量要么已经在结果里，要么（OpenCode）要再去读一次。
// 没写模型的（比如没指定模型的 Codex），用那个工具自己的默认模型名
async function recordRun(usage, { room, agent, res, startedAt, side }) {
  if (!usage || !res) return;
  let rows = res.usage;
  if ((!rows || !rows.length) && typeof res.usageFetch === 'function') {
    try {
      rows = await res.usageFetch();
    } catch {
      rows = null;
    }
  }
  if (!rows || !rows.length) return;
  let fallback = res.model || agent.model || '';
  if (!fallback && rows.some((r) => !r.model)) {
    try {
      const cat = await require('./models').catalog(agent.adapter);
      fallback = (cat && cat.defaultModel) || '';
    } catch {}
  }
  usage.record({
    ts: Date.now(),
    roomId: room.id,
    room: room.name,
    agentId: agent.id,
    agent: agent.name,
    adapter: agent.adapter,
    ms: startedAt ? Date.now() - startedAt : 0,
    side: !!side,
    rows: rows.map((r) => ({ ...r, model: r.model || fallback || 'default' })),
  });
}

module.exports = { Usage, dayKey, recordRun };

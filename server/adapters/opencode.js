'use strict';
// OpenCode：opencode run --format json，prompt 走 stdin，用 --session <id> 续上会话。
// OpenCode 自己能接 DeepSeek / Kimi / Ollama 等很多模型，模型写成 provider/model。
const { runJsonl, runCapture, killTree, detectCli, splitArgs } = require('../proc');
const { rel, outside, clip, tail, makeProbe, addUsage } = require('./common');
const { t: tr } = require('../i18n');

// OpenCode 的 JSON 输出里没有 token 用量。跑完以后用 opencode api 读一下这个会话的消息，
// 把这一轮新出现的回复的用量加起来（读不到就算了，不影响接力）
function opencodeUsage(list, since) {
  const out = [];
  for (const m of Array.isArray(list) ? list : []) {
    if (!m || m.type !== 'assistant' || !m.tokens) continue;
    const created = (m.time && m.time.created) || 0;
    if (created && created < since - 2000) continue;
    const t = m.tokens;
    const model = m.model && m.model.id ? (m.model.providerID ? m.model.providerID + '/' + m.model.id : m.model.id) : '';
    addUsage(out, model, {
      input: t.input,
      output: (Number(t.output) || 0) + (Number(t.reasoning) || 0),
      cacheRead: t.cache && t.cache.read,
      cacheWrite: t.cache && t.cache.write,
    });
  }
  return out;
}

async function fetchUsage(sessionId, since, cwd) {
  if (!sessionId) return [];
  const r = await runCapture('opencode', ['api', 'session.message.list', '--param', 'sessionID=' + sessionId], { timeoutMs: 20000, cwd });
  try {
    const j = JSON.parse(r.stdout);
    return opencodeUsage(Array.isArray(j) ? j : j.data, since);
  } catch {
    return [];
  }
}

const OUTDATED = () => tr('这个版本的 OpenCode 太旧，不支持 run --format json。请先升级（命令行里运行 opencode upgrade），再点左下角「重新检测」。');

// 看当前版本支不支持 JSON 输出，以及 provider/model#variant 这种指定思考强度的写法
const probe = makeProbe(async () => {
  const r = await runCapture('opencode', ['run', '--help'], { timeoutMs: 30000 });
  const h = `${r.stdout}\n${r.stderr}`;
  if (!/--/.test(h)) return { known: false };
  return { known: true, json: /--format\b/.test(h), variant: /#variant/.test(h) };
});

const PERM = {
  readonly: ['--agent', 'plan'],
  edit: [],
  full: ['--auto'],
};

const KIND = {
  read: 'read',
  write: 'write',
  edit: 'edit',
  multiedit: 'edit',
  patch: 'edit',
  apply_patch: 'edit',
  shell: 'cmd',
  bash: 'cmd',
  grep: 'search',
  glob: 'search',
  list: 'search',
  ls: 'search',
  codesearch: 'search',
  webfetch: 'web',
  websearch: 'web',
  todowrite: 'todo',
  todoread: 'todo',
  task: 'agent',
};

function toolItem(p, cwd) {
  const st = p.state || {};
  const i = st.input || {};
  const k = KIND[p.tool] || 'other';
  let d = '';
  if (k === 'read' || k === 'write' || k === 'edit') d = rel(i.filePath || i.path || i.file || '', cwd);
  else if (k === 'cmd') d = i.command || '';
  else if (k === 'search') d = i.pattern || i.query || rel(i.path || '', cwd);
  else if (k === 'web') d = i.url || i.query || '';
  else if (k === 'agent') d = i.description || '';
  else d = clip(JSON.stringify(i), 160);
  const s = st.status === 'completed' ? 'ok' : st.status === 'error' ? 'error' : 'running';
  return { id: p.callID || p.id, k, n: p.tool, d: clip(d, 400), s, ...outside(k, i.filePath || i.path || i.file, cwd) };
}

function buildArgs({ agent, sessionId, caps = {} }) {
  const args = ['run', '--format', 'json', ...(PERM[agent.permission] || PERM.edit)];
  if (agent.model) {
    // 思考强度在 OpenCode 里叫 variant，写成 provider/model#variant；没选模型时没法单独指定，旧版也不支持
    const base = agent.model.split('#')[0];
    args.push('-m', agent.effort && caps.variant !== false ? `${base}#${agent.effort}` : agent.model);
  }
  if (sessionId) args.push('--session', sessionId);
  args.push(...splitArgs(agent.extraArgs));
  return args;
}

module.exports = {
  id: 'opencode',
  label: 'OpenCode',
  cmd: 'opencode',
  buildArgs,
  probe,
  opencodeUsage,
  async detect(force) {
    const base = await detectCli('opencode');
    if (!base.installed) return base;
    const caps = await probe(force);
    return caps.known && !caps.json ? { ...base, outdated: true, hint: OUTDATED() } : base;
  },
  run({ agent, cwd, prompt, sessionId, emit }) {
    let child = null;
    let cancelled = false;
    let sid = sessionId || null;
    let lastText = '';
    let failure = null;

    const onJson = (j) => {
      if (j.sessionID && j.sessionID !== sid) {
        sid = j.sessionID;
        emit({ type: 'session', id: sid });
      }
      const p = j.part || {};
      switch (j.type) {
        case 'step_start':
          emit({ type: 'status', text: tr('思考中') });
          break;
        case 'reasoning':
          emit({ type: 'status', text: tr('思考中') });
          break;
        case 'text':
          if (p.text && p.text.trim()) {
            lastText = p.text;
            emit({ type: 'text', text: p.text });
          }
          break;
        case 'tool_use':
          emit({ type: 'tool', item: toolItem(p, cwd) });
          break;
        case 'error': {
          const e = j.error || {};
          failure = (e.data && e.data.message) || e.message || j.message || e.name || tr('OpenCode 运行出错');
          break;
        }
      }
    };

    const startedAt = Date.now();
    const usageFetch = () => fetchUsage(sid, startedAt, cwd);
    const done = (async () => {
      const caps = await probe();
      if (caps.known && !caps.json) return { error: OUTDATED() };
      if (cancelled) return { error: tr('已中止'), sessionId: sid };
      const r = runJsonl({ cmd: 'opencode', args: buildArgs({ agent, sessionId, caps }), cwd, input: prompt, onJson });
      child = r.child;
      const { code, error, stderr } = await r.done;
      if (error) return { error: error.message, sessionId: sid, stderr, usageFetch };
      if (failure) return { text: lastText, error: failure, sessionId: sid, stderr, usageFetch };
      if (code !== 0 && !lastText) {
        return { error: tail(stderr) || tr('{cmd} 意外退出（退出码 {code}）', { cmd: 'opencode', code }), sessionId: sid, stderr, usageFetch };
      }
      return { text: lastText, error: null, sessionId: sid, model: agent.model || '', stderr, usageFetch };
    })().catch((e) => ({ error: e.message || String(e), sessionId: sid }));

    return {
      done,
      cancel: () => {
        cancelled = true;
        if (child) killTree(child);
      },
    };
  },
};

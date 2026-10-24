'use strict';
// OpenAI Codex：codex exec --json，prompt 走 stdin（参数 "-"），用 codex exec resume <id> 续上会话。
const { runJsonl, runCapture, killTree, detectCli, splitArgs } = require('../proc');
const { rel, outside, clip, prettyCmd, tail, makeProbe, addUsage } = require('./common');
const { t: tr } = require('../i18n');

// 用量在 turn.completed 里：cached_input_tokens 是 input_tokens 里命中缓存的那部分
function codexUsage(u) {
  const inTok = Number(u.input_tokens) || 0;
  const cached = Math.min(inTok, Number(u.cached_input_tokens) || 0);
  return { input: inTok - cached, cacheRead: cached, cacheWrite: u.cache_write_input_tokens, output: u.output_tokens };
}

// 旧版 Codex 没有 exec --json，事件格式也不一样，没法接入，直接提示升级
const OUTDATED = () => tr('这个版本的 Codex 太旧，不支持 exec --json。请先升级（命令行里运行 codex update），再点左下角「重新检测」。');

const probe = makeProbe(async () => {
  const r = await runCapture('codex', ['exec', '--help'], { timeoutMs: 30000 });
  const h = `${r.stdout}\n${r.stderr}`;
  if (!/--/.test(h)) return { known: false };
  return { known: true, json: /--json\b/.test(h) };
});

const PERM = {
  readonly: ['-s', 'read-only'],
  edit: ['-s', 'workspace-write'],
  full: ['--dangerously-bypass-approvals-and-sandbox'],
};

// Codex 的错误有时是一整段 JSON，取出里面给人看的那句话
function readable(msg) {
  const s = String(msg || '').trim();
  if (s.startsWith('{')) {
    try {
      const j = JSON.parse(s);
      const e = j.error || j;
      if (e && typeof e.message === 'string') return e.message;
    } catch {}
  }
  return s;
}

const STATUS = (it) =>
  it.status === 'in_progress' ? 'running' : it.status === 'failed' || (it.exit_code != null && it.exit_code !== 0) ? 'error' : 'ok';

function buildArgs({ agent, cwd, sessionId }) {
  const args = ['exec', '--json', '--skip-git-repo-check', ...(PERM[agent.permission] || PERM.edit), '-C', cwd];
  if (agent.model) args.push('-m', agent.model);
  // 思考强度：Codex 自己不校验取值，界面里只提供模型目录里列出的档位
  if (agent.effort) args.push('-c', `model_reasoning_effort="${agent.effort}"`);
  args.push(...splitArgs(agent.extraArgs));
  if (sessionId) args.push('resume', sessionId, '-');
  else args.push('-');
  return args;
}

module.exports = {
  id: 'codex',
  label: 'Codex',
  cmd: 'codex',
  buildArgs,
  probe,
  codexUsage,
  async detect(force) {
    const base = await detectCli('codex');
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
    let completed = false;
    const warnings = [];
    const usage = [];

    const onJson = (j) => {
      switch (j.type) {
        case 'thread.started':
          if (j.thread_id) {
            sid = j.thread_id;
            emit({ type: 'session', id: sid });
          }
          break;
        case 'turn.started':
          emit({ type: 'status', text: tr('思考中') });
          break;
        case 'item.started':
        case 'item.updated':
        case 'item.completed': {
          const it = j.item || {};
          switch (it.type) {
            case 'agent_message':
              if (j.type === 'item.completed' && it.text && it.text.trim()) {
                lastText = it.text;
                emit({ type: 'text', text: it.text });
              }
              break;
            case 'reasoning':
              emit({ type: 'status', text: tr('思考中') });
              break;
            case 'command_execution':
              emit({ type: 'tool', item: { id: it.id, k: 'cmd', n: 'shell', d: clip(prettyCmd(it.command), 400), s: STATUS(it) } });
              break;
            case 'file_change': {
              const changes = Array.isArray(it.changes) ? it.changes : [];
              const d = changes
                .map((c) => rel(c.path, cwd) + (c.kind === 'add' ? tr('（新建）') : c.kind === 'delete' ? tr('（删除）') : ''))
                .join(tr('、'));
              const allNew = changes.length && changes.every((c) => c.kind === 'add');
              const k = allNew ? 'write' : 'edit';
              const written = changes.filter((c) => c.kind !== 'delete').map((c) => c.path);
              emit({ type: 'tool', item: { id: it.id, k, n: 'patch', d: clip(d, 400), s: STATUS(it), ...outside(k, written, cwd) } });
              break;
            }
            case 'mcp_tool_call':
              emit({ type: 'tool', item: { id: it.id, k: 'other', n: 'mcp', d: [it.server, it.tool].filter(Boolean).join('.'), s: STATUS(it) } });
              break;
            case 'web_search':
              emit({ type: 'tool', item: { id: it.id, k: 'web', n: 'web_search', d: clip(it.query || '', 200), s: STATUS(it) } });
              break;
            case 'todo_list': {
              const items = Array.isArray(it.items) ? it.items : [];
              const doneN = items.filter((x) => x.completed).length;
              emit({ type: 'tool', item: { id: it.id, k: 'todo', n: 'todo', d: tr('{done}/{total} 项完成', { done: doneN, total: items.length }), s: 'ok' } });
              break;
            }
            case 'error':
              if (it.message) warnings.push(it.message);
              break;
          }
          break;
        }
        case 'turn.completed':
          completed = true;
          if (j.usage) addUsage(usage, agent.model || '', codexUsage(j.usage));
          break;
        case 'turn.failed':
          failure = readable(j.error && j.error.message) || tr('Codex 运行失败');
          break;
        case 'error':
          failure = readable(j.message) || tr('Codex 运行出错');
          break;
      }
    };

    const done = (async () => {
      const caps = await probe();
      if (caps.known && !caps.json) return { error: OUTDATED() };
      if (cancelled) return { error: tr('已中止'), sessionId: sid };
      const r = runJsonl({ cmd: 'codex', args: buildArgs({ agent, cwd, sessionId }), cwd, input: prompt, onJson });
      child = r.child;
      const { code, error, stderr } = await r.done;
      if (error) return { error: error.message, sessionId: sid, stderr, usage };
      if (failure) return { text: lastText, error: failure, sessionId: sid, stderr, usage };
      if (!completed && code !== 0) {
        return { text: lastText, error: tail(stderr) || tr('{cmd} 意外退出（退出码 {code}）', { cmd: 'codex', code }), sessionId: sid, stderr, usage };
      }
      return { text: lastText, error: null, sessionId: sid, model: agent.model || '', stderr, warnings, usage };
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

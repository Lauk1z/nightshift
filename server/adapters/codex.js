'use strict';
// OpenAI Codex：codex exec --json，prompt 走 stdin（参数 "-"），用 codex exec resume <id> 续上会话。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runJsonl, runCapture, killTree, detectCli, splitArgs } = require('../proc');
const { rel, outside, clip, prettyCmd, tail, makeProbe, addUsage } = require('./common');
const { t: tr } = require('../i18n');

// 用量在 turn.completed 里：cached_input_tokens 是 input_tokens 里命中缓存的那部分
function codexUsage(u) {
  const inTok = Number(u.input_tokens) || 0;
  const cached = Math.min(inTok, Number(u.cached_input_tokens) || 0);
  return { input: inTok - cached, cacheRead: cached, cacheWrite: u.cache_write_input_tokens, output: u.output_tokens };
}

// 上下文（右侧面板）：exec --json 只给这一轮加起来的用量。最后一次调用模型时的用量和上下文窗口记在 Codex 自己的会话记录里：
// <CODEX_HOME>/sessions/年/月/日/rollout-<时间>-<会话 id>.jsonl 的 token_count 事件，跑完以后读一下文件末尾（只读，不改）
const rollouts = new Map(); // 会话 id → 记录文件
function findRollout(id, home) {
  const known = rollouts.get(id);
  if (known && fs.existsSync(known)) return known;
  const root = path.join(home, 'sessions');
  const dirs = (p) => {
    try {
      return fs
        .readdirSync(p, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => path.join(p, d.name))
        .sort()
        .reverse();
    } catch {
      return [];
    }
  };
  // 新的在前：续上的会话还记在它开始那天的文件夹里，所以一天天往前找
  const days = dirs(root).flatMap((y) => dirs(y).flatMap(dirs)).slice(0, 1000);
  for (const dir of days) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {}
    const hit = names.find((n) => n.endsWith('.jsonl') && n.includes(id));
    if (hit) {
      rollouts.set(id, path.join(dir, hit));
      return path.join(dir, hit);
    }
  }
  return null;
}

// 从文件末尾往前找最后一个 token_count（还有最后用的模型，记在 turn_context 里）
function lastTokenCount(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 1024 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    let info = null;
    let model = '';
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0 && !(info && model); i--) {
      const l = lines[i];
      if (!(info ? l.includes('"turn_context"') : l.includes('"token_count"') || l.includes('"turn_context"'))) continue;
      try {
        const j = JSON.parse(l);
        const p = j.payload || {};
        if (!info && p.type === 'token_count' && p.info && p.info.last_token_usage) info = p.info;
        else if (!model && j.type === 'turn_context' && p.model) model = String(p.model);
      } catch {}
    }
    return info ? { info, model } : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

function codexContext(id, model = '', home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')) {
  const file = id && findRollout(id, home);
  const hit = file && lastTokenCount(file);
  if (!hit) return null;
  const u = hit.info.last_token_usage;
  const used = Number(u.total_tokens) || (Number(u.input_tokens) || 0) + (Number(u.output_tokens) || 0);
  if (!(used > 0)) return null;
  return { used: Math.round(used), window: Math.round(Number(hit.info.model_context_window) || 0), model: model || hit.model };
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
  codexContext,
  reportsContext: true,
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
      const contextFetch = async () => (sid ? codexContext(sid, agent.model || '') : null);
      if (error) return { error: error.message, sessionId: sid, stderr, usage, contextFetch };
      if (failure) return { text: lastText, error: failure, sessionId: sid, stderr, usage, contextFetch };
      if (!completed && code !== 0) {
        return { text: lastText, error: tail(stderr) || tr('{cmd} 意外退出（退出码 {code}）', { cmd: 'codex', code }), sessionId: sid, stderr, usage, contextFetch };
      }
      return { text: lastText, error: null, sessionId: sid, model: agent.model || '', stderr, warnings, usage, contextFetch };
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

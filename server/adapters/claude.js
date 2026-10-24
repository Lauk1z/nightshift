'use strict';
// Claude Code：claude -p --output-format stream-json，prompt 走 stdin，用 --resume 续上会话。
// 不同版本支持的参数不一样（比如旧版没有 --effort），所以先读一次 claude --help，只传当前版本认识的参数。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runJsonl, runCapture, killTree, detectCli, splitArgs } = require('../proc');
const { rel, outside, clip, tail, optionBlock, makeProbe, addUsage } = require('./common');
const { t: tr } = require('../i18n');

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// 读不到 --help 时按新版处理
const MODERN = { known: false, effort: true, efforts: EFFORTS, partial: true, settings: true, modes: [], aliases: [] };

function parseHelp(help) {
  const text = String(help || '');
  if (!/--print\b/.test(text)) return MODERN;
  const effort = optionBlock(text, '--effort');
  const list = (effort.match(/\(([^)]*)\)/) || [])[1] || '';
  return {
    known: true,
    effort: !!effort,
    efforts: list
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^[a-z]+$/.test(s)),
    partial: /--include-partial-messages\b/.test(text),
    settings: /--settings\b/.test(text),
    modes: [...optionBlock(text, '--permission-mode').matchAll(/"(\w+)"/g)].map((m) => m[1]),
    aliases: [...optionBlock(text, '--model').matchAll(/'([a-z][a-z0-9-]*)'/g)].map((m) => m[1]),
  };
}

const probe = makeProbe(async () => {
  const r = await runCapture('claude', ['--help'], { timeoutMs: 30000 });
  return r.stdout ? parseHelp(r.stdout) : MODERN;
});

function permArgs(level, caps) {
  const has = (m) => !caps.modes.length || caps.modes.includes(m);
  if (level === 'full') return ['--permission-mode', 'bypassPermissions'];
  if (level === 'readonly') {
    // 新版叫 dontAsk / manual，旧版叫 default；真正挡住改文件的是 --disallowedTools
    const mode = ['dontAsk', 'manual', 'default'].find(has);
    return [...(mode ? ['--permission-mode', mode] : []), '--disallowedTools', 'Edit,Write,NotebookEdit'];
  }
  return ['--permission-mode', 'acceptEdits'];
}

// 光用 --effort 不够：settings.json 里设置的 CLAUDE_CODE_EFFORT_LEVEL 会盖过它，
// 所以再用 --settings 只为这一次运行覆盖这个变量（不会改动用户的配置文件）。
// 写成文件而不是直接传 JSON 字符串，旧版本的 --settings 只认文件路径。
function effortSettingsFile(level) {
  const dir = path.join(os.tmpdir(), 'agent-chat');
  const file = path.join(dir, `claude-effort-${level}.json`);
  const body = JSON.stringify({ env: { CLAUDE_CODE_EFFORT_LEVEL: level } });
  try {
    if (fs.readFileSync(file, 'utf8') === body) return file;
  } catch {}
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

function buildArgs({ agent, sessionId, caps = MODERN }) {
  const c = { ...MODERN, ...caps };
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (c.partial) args.push('--include-partial-messages');
  args.push(...permArgs(agent.permission, c));
  if (agent.model) args.push('--model', agent.model);
  const levels = c.efforts.length ? c.efforts : EFFORTS;
  if (c.effort && levels.includes(agent.effort)) {
    args.push('--effort', agent.effort);
    if (c.settings) args.push('--settings', effortSettingsFile(agent.effort));
  }
  if (sessionId) args.push('--resume', sessionId);
  args.push(...splitArgs(agent.extraArgs));
  return args;
}

// 用量：最终结果里有按模型分好的 modelUsage；被中止、没有最终结果时，用每条回复各自的用量加起来
function claudeUsage(result, perMessage, model) {
  const out = [];
  const mu = result && result.modelUsage;
  if (mu && typeof mu === 'object' && Object.keys(mu).length) {
    for (const [m, u] of Object.entries(mu)) {
      addUsage(out, m, { input: u.inputTokens, output: u.outputTokens, cacheRead: u.cacheReadInputTokens, cacheWrite: u.cacheCreationInputTokens });
    }
    return out;
  }
  const one = (m, u) =>
    addUsage(out, m, { input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens });
  if (result && result.usage) one(model, result.usage);
  else for (const x of perMessage.values()) one(x.model || model, x.usage);
  return out;
}

function toolItem(b, cwd) {
  const n = b.name || 'tool';
  const i = b.input || {};
  let k = 'other';
  let d = '';
  if (n === 'Read') (k = 'read'), (d = rel(i.file_path, cwd));
  else if (n === 'Write') (k = 'write'), (d = rel(i.file_path, cwd));
  else if (/^(Edit|MultiEdit|NotebookEdit)$/.test(n)) (k = 'edit'), (d = rel(i.file_path || i.notebook_path, cwd));
  else if (/^(Bash|PowerShell)$/.test(n)) (k = 'cmd'), (d = i.command || '');
  else if (/^(Glob|Grep|LS)$/.test(n)) (k = 'search'), (d = i.pattern || i.path || '');
  else if (/^(WebFetch|WebSearch)$/.test(n)) (k = 'web'), (d = i.url || i.query || '');
  else if (/^(Task|Agent)$/.test(n)) (k = 'agent'), (d = i.description || '');
  else if (/^Todo/.test(n)) (k = 'todo'), (d = Array.isArray(i.todos) ? tr('{n} 项待办', { n: i.todos.length }) : '');
  else d = clip(JSON.stringify(i), 160);
  return { id: b.id, k, n, d: clip(d, 400), s: 'running', ...outside(k, i.file_path || i.notebook_path, cwd) };
}

module.exports = {
  id: 'claude',
  label: 'Claude Code',
  cmd: 'claude',
  EFFORTS,
  parseHelp,
  probe,
  buildArgs,
  claudeUsage,
  async detect(force) {
    const base = await detectCli('claude');
    if (base.installed) await probe(force);
    return base;
  },
  run({ agent, cwd, prompt, sessionId, emit }) {
    let child = null;
    let cancelled = false;
    let result = null;
    let sid = sessionId || null;
    let model = '';
    let lastText = '';
    const perMessage = new Map(); // 每条回复的用量（同一条回复会出现好几次，按 id 只记最后一次）

    const onJson = (j) => {
      if (j.type === 'assistant' && j.message && j.message.id && j.message.usage) {
        perMessage.set(j.message.id, { model: j.message.model, usage: j.message.usage });
      }
      if (j.parent_tool_use_id) return; // 子代理内部的消息不展示（用量上面已经记了）
      switch (j.type) {
        case 'system':
          if (j.subtype === 'init') {
            if (j.session_id) {
              sid = j.session_id;
              emit({ type: 'session', id: sid });
            }
            if (j.model) model = j.model;
            emit({ type: 'status', text: tr('思考中') });
          }
          break;
        case 'stream_event': {
          const ev = j.event || {};
          if (ev.type === 'content_block_start') {
            const b = ev.content_block || {};
            if (b.type === 'text') emit({ type: 'text_start' });
            else if (b.type === 'thinking') emit({ type: 'status', text: tr('思考中') });
          } else if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
            emit({ type: 'delta', text: ev.delta.text || '' });
          }
          break;
        }
        case 'assistant':
          for (const b of (j.message && j.message.content) || []) {
            if (b.type === 'text' && b.text && b.text.trim()) {
              lastText = b.text;
              emit({ type: 'text', text: b.text });
            } else if (b.type === 'tool_use') {
              emit({ type: 'tool', item: toolItem(b, cwd) });
            }
          }
          break;
        case 'user':
          for (const b of (j.message && Array.isArray(j.message.content) && j.message.content) || []) {
            if (b.type === 'tool_result') emit({ type: 'tool', item: { id: b.tool_use_id, s: b.is_error ? 'error' : 'ok' } });
          }
          break;
        case 'result':
          result = j;
          break;
      }
    };

    const done = (async () => {
      const caps = await probe();
      if (cancelled) return { error: tr('已中止'), sessionId: sid };
      const args = buildArgs({ agent, sessionId, caps });
      const r = runJsonl({ cmd: 'claude', args, cwd, input: prompt, onJson });
      child = r.child;
      const { code, error, stderr } = await r.done;
      const usage = claudeUsage(result, perMessage, model);
      if (error) return { error: error.message, sessionId: sid, stderr, usage };
      if (result) {
        const failed = result.is_error || (result.subtype && result.subtype !== 'success');
        return {
          text: failed ? '' : typeof result.result === 'string' ? result.result : lastText,
          error: failed ? result.result || (result.errors && result.errors.join('\n')) || result.subtype || tr('Claude 运行出错') : null,
          sessionId: result.session_id || sid,
          model,
          stderr,
          usage,
        };
      }
      return {
        text: lastText,
        error: code === 0 ? null : tail(stderr) || tr('{cmd} 意外退出（退出码 {code}）', { cmd: 'claude', code }),
        sessionId: sid,
        model,
        stderr,
        usage,
      };
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

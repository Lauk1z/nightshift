'use strict';
// Claude Code：claude -p --output-format stream-json，prompt 走 stdin，用 --resume 续上会话。
// 新版的 prompt 也写成 stream-json（--input-format），这一轮做完以后再问它上下文的分类用量（get_context_usage），然后关掉 stdin。
// 不同版本支持的参数不一样（比如旧版没有 --effort），所以先读一次 claude --help，只传当前版本认识的参数。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runJsonl, runCapture, killTree, detectCli, splitArgs } = require('../proc');
const { rel, outside, clip, tail, optionBlock, makeProbe, addUsage, contextOf } = require('./common');
const { t: tr } = require('../i18n');

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const CTX_REQUEST = 'agent-chat-context';

// 读不到 --help 时按新版处理
const MODERN = { known: false, effort: true, efforts: EFFORTS, partial: true, settings: true, streamInput: true, promptTool: true, modes: [], aliases: [] };

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
    streamInput: /--input-format\b/.test(text),
    promptTool: /--permission-prompt-tool\b/.test(text),
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
  const args = ['-p', ...(c.streamInput ? ['--input-format', 'stream-json'] : []), '--output-format', 'stream-json', '--verbose'];
  if (c.partial) args.push('--include-partial-messages');
  args.push(...permArgs(agent.permission, c));
  // 运行命令前问我：要批准的工具（运行命令、上网……）通过 stdin 问 Nightshift（见 run 里的 can_use_tool）
  if (agent.permission === 'ask' && c.streamInput && c.promptTool) args.push('--permission-prompt-tool', 'stdio');
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

// 上下文：这一轮结束时 Claude Code 自己算的（info，get_context_usage 的回答，按系统提示、工具、技能、消息……分好）；
// 问不到（旧版、没回答）就用最后一次调用模型的用量，上下文窗口看 result 的 modelUsage
const KINDS = ['used', 'buffer', 'free', 'deferred'];
function claudeContext(info, last, result, model) {
  if (info && Array.isArray(info.categories) && Number(info.maxTokens) > 0) {
    const parts = info.categories
      .filter((c) => c && c.name && Number(c.tokens) >= 0)
      .slice(0, 24)
      .map((c) => ({
        id: String(c.id || '').slice(0, 60),
        name: String(c.name).slice(0, 60),
        tokens: Math.round(Number(c.tokens)),
        kind: c.isDeferred ? 'deferred' : KINDS.includes(c.kind) ? c.kind : 'used',
      }));
    return { used: Math.round(Number(info.totalTokens)) || 0, window: Math.round(Number(info.maxTokens)), model: String(info.model || model || ''), parts };
  }
  if (!last) return null;
  const u = last.usage || {};
  const m = last.model || model;
  const mu = result && result.modelUsage && typeof result.modelUsage === 'object' ? result.modelUsage[m] || Object.values(result.modelUsage)[0] : null;
  return contextOf(m, { input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens }, mu && mu.contextWindow);
}

// 问你批不批准时给你看的那一段：命令、网址、搜索词、文件，别的就是参数
function askDetail(q) {
  const i = q.input || {};
  const v = i.command || i.url || i.query || i.file_path || i.path;
  return v ? String(v) : clip(JSON.stringify(i), 2000);
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
  claudeContext,
  reportsContext: true,
  canAsk: true, // 支持「运行命令前问我」（要 --input-format 和 --permission-prompt-tool）
  async detect(force) {
    const base = await detectCli('claude');
    if (base.installed) await probe(force);
    return base;
  },
  run({ agent, cwd, prompt, sessionId, emit, askUser }) {
    let child = null;
    let cancelled = false;
    let result = null;
    let sid = sessionId || null;
    let model = '';
    let lastText = '';
    const perMessage = new Map(); // 每条回复的用量（同一条回复会出现好几次，按 id 只记最后一次）
    let last = null; // 最后一条（不是子代理的）回复的用量：问不到上下文的分类用量时，按它算上下文
    let ctxInfo = null;
    let stdinOpen = false;
    let askTimer = null;
    const closeInput = () => {
      clearTimeout(askTimer);
      if (!stdinOpen) return;
      stdinOpen = false;
      try {
        child.stdin.end();
      } catch {}
    };
    // 这一轮做完了：问它上下文的分类用量，回答了（或者等了 5 秒还没回答）就关掉 stdin，它就退出了
    const askContext = () => {
      if (!stdinOpen) return;
      try {
        child.stdin.write(JSON.stringify({ type: 'control_request', request_id: CTX_REQUEST, request: { subtype: 'get_context_usage', detail: 'summary' } }) + '\n');
      } catch {
        return closeInput();
      }
      askTimer = setTimeout(closeInput, 5000);
    };

    const onJson = (j) => {
      if (j.type === 'assistant' && j.message && j.message.id && j.message.usage) {
        perMessage.set(j.message.id, { model: j.message.model, usage: j.message.usage });
        if (!j.parent_tool_use_id) last = { model: j.message.model, usage: j.message.usage };
      }
      if (j.type === 'control_response') {
        const r = j.response || {};
        if (r.request_id !== CTX_REQUEST) return;
        if (r.subtype === 'success') ctxInfo = r.response;
        return closeInput();
      }
      // 运行命令前问我：Claude Code 要用要批准的工具，问你；没法问（没给 askUser）就拒绝
      if (j.type === 'control_request' && j.request && j.request.subtype === 'can_use_tool') {
        const q = j.request;
        const asked = askUser ? askUser({ tool: q.tool_name, title: q.display_name || q.tool_name, detail: askDetail(q), note: q.description || '' }) : Promise.resolve(false);
        asked
          .catch(() => false)
          .then((allow) => {
            if (!stdinOpen) return;
            const response = allow ? { behavior: 'allow', updatedInput: q.input || {} } : { behavior: 'deny', message: tr('用户没有允许这次操作。') };
            try {
              child.stdin.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: j.request_id, response } }) + '\n');
            } catch {}
          });
        return;
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
          askContext();
          break;
      }
    };

    const done = (async () => {
      const caps = await probe();
      if (cancelled) return { error: tr('已中止'), sessionId: sid };
      const args = buildArgs({ agent, sessionId, caps });
      const stream = { ...MODERN, ...caps }.streamInput;
      const input = stream ? JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n' : prompt;
      const r = runJsonl({ cmd: 'claude', args, cwd, input, onJson, keepOpen: stream });
      child = r.child;
      stdinOpen = stream;
      const { code, error, stderr } = await r.done;
      clearTimeout(askTimer);
      const usage = claudeUsage(result, perMessage, model);
      const context = claudeContext(ctxInfo, last, result, model);
      if (error) return { error: error.message, sessionId: sid, stderr, usage, context };
      if (result) {
        const failed = result.is_error || (result.subtype && result.subtype !== 'success');
        return {
          text: failed ? '' : typeof result.result === 'string' ? result.result : lastText,
          error: failed ? result.result || (result.errors && result.errors.join('\n')) || result.subtype || tr('Claude 运行出错') : null,
          sessionId: result.session_id || sid,
          model,
          stderr,
          usage,
          context,
        };
      }
      return {
        text: lastText,
        error: code === 0 ? null : tail(stderr) || tr('{cmd} 意外退出（退出码 {code}）', { cmd: 'claude', code }),
        sessionId: sid,
        model,
        stderr,
        usage,
        context,
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

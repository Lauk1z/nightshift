'use strict';
// Hermes Agent（Nous Research）：hermes chat --query-file - --format stream-json，prompt 从 stdin 读。
// 开头的 system/init 和最后的 result 里有 session_id，下次用 --resume <id> 续上。
// 权限：Hermes 没有只读的文件工具。只读时去掉命令行工具（-t file,web,todo,skills），并在提示开头要求它不改文件；
// 可改文件用它的默认工具（危险命令没人批准就不会运行）；完全权限加 --yolo。
const { runJsonl, runCapture, killTree, detectCli, splitArgs } = require('../proc');
const { rel, clip, tail, makeProbe, addUsage, readableError, segmenter } = require('./common');
const { t: tr } = require('../i18n');

// result.tokens：{ input, output, total, cache_read, cache_write }。
// 有的提供商把命中缓存的部分算在 input 里（total = input + output），这时减掉，和其他工具的口径一致
function hermesUsage(tokens, model) {
  const out = [];
  if (!tokens || typeof tokens !== 'object') return out;
  const n = (v) => Number(v) || 0;
  let input = n(tokens.input);
  const cacheRead = n(tokens.cache_read);
  const cacheWrite = n(tokens.cache_write);
  if (n(tokens.total) && Math.abs(n(tokens.total) - (input + n(tokens.output))) <= 1 && input >= cacheRead + cacheWrite) input -= cacheRead + cacheWrite;
  return addUsage(out, model, { input, output: tokens.output, cacheRead, cacheWrite });
}

const OUTDATED = () => tr('这个版本的 Hermes 太旧，不支持 --format stream-json。请先升级（命令行里运行 hermes update），再点左下角「重新检测」。');
const READONLY_NOTE = '（你现在是只读权限：只能阅读文件和资料，不要修改、创建或删除任何文件。）';

const probe = makeProbe(async () => {
  const r = await runCapture('hermes', ['chat', '--help'], { timeoutMs: 45000 });
  const h = `${r.stdout}\n${r.stderr}`;
  if (!/--/.test(h)) return { known: false };
  return { known: true, json: /stream-json/.test(h) && /--query-file\b/.test(h), reasoning: /--reasoning\b/.test(h) };
});

function buildArgs({ agent, sessionId, caps = {} }) {
  const args = ['chat', '--query-file', '-', '--format', 'stream-json'];
  if (agent.permission === 'readonly') args.push('-t', 'file,web,todo,skills');
  else if (agent.permission === 'full') args.push('--yolo');
  if (agent.model) args.push('-m', agent.model);
  if (agent.effort && caps.reasoning !== false) args.push('--reasoning', agent.effort);
  if (sessionId) args.push('--resume', sessionId);
  args.push(...splitArgs(agent.extraArgs));
  return args;
}

const KIND = {
  read_file: 'read',
  write_file: 'write',
  patch: 'edit',
  search_files: 'search',
  terminal: 'cmd',
  process_manage: 'cmd',
  execute_code: 'cmd',
  web_search: 'web',
  web_extract: 'web',
  x_search: 'web',
  todo_list: 'todo',
  delegate_task: 'agent',
};

function toolItem(j, id, cwd) {
  const i = j.input && typeof j.input === 'object' ? j.input : {};
  const k = KIND[j.name] || (/^browser_/.test(j.name || '') ? 'web' : 'other');
  let d = '';
  if (k === 'read' || k === 'write' || k === 'edit') d = rel(i.path || i.file_path || '', cwd);
  else if (k === 'cmd') d = i.command || i.code || '';
  else if (k === 'search') d = i.pattern || i.query || rel(i.path || '', cwd);
  else if (k === 'web') d = i.url || i.query || (Array.isArray(i.urls) ? i.urls.join(', ') : '');
  else if (k === 'agent') d = i.goal || i.task || i.description || '';
  else d = clip(JSON.stringify(i), 160);
  return { id, k, n: j.name || 'tool', d: clip(d, 400), s: 'running' };
}

module.exports = {
  id: 'hermes',
  label: 'Hermes Agent',
  cmd: 'hermes',
  buildArgs,
  probe,
  hermesUsage,
  async detect(force) {
    const base = await detectCli('hermes', ['--version'], 45000);
    if (!base.installed) return base;
    const caps = await probe(force);
    return caps.known && !caps.json ? { ...base, outdated: true, hint: OUTDATED() } : base;
  },
  run({ agent, cwd, prompt, sessionId, emit }) {
    let child = null;
    let cancelled = false;
    let sid = sessionId || null;
    let model = agent.model || '';
    let failure = null;
    let result = null;
    let toolN = 0;
    const open = new Map(); // 工具名 → 还没出结果的调用 id（旧版的事件里没有 tool_call_id）
    const seg = segmenter(emit);
    const setSession = (id) => {
      if (id && id !== sid) {
        sid = id;
        emit({ type: 'session', id: sid });
      }
    };

    const onJson = (j) => {
      switch (j.type) {
        case 'system':
          setSession(j.session_id);
          if (j.model) model = j.model;
          emit({ type: 'status', text: tr('思考中') });
          break;
        case 'text':
          if (typeof j.text === 'string') seg.delta(j.text);
          break;
        case 'tool_use': {
          seg.close();
          const id = j.tool_call_id || `hermes-${++toolN}`;
          if (!open.has(j.name)) open.set(j.name, []);
          open.get(j.name).push(id);
          emit({ type: 'tool', item: toolItem(j, id, cwd) });
          break;
        }
        case 'tool_result': {
          const list = open.get(j.name) || [];
          const id = j.tool_call_id || list[0];
          const i = list.indexOf(id);
          if (i >= 0) list.splice(i, 1);
          if (id) emit({ type: 'tool', item: { id, s: j.is_error ? 'error' : 'ok' } });
          break;
        }
        case 'result':
          result = j;
          setSession(j.session_id);
          if (j.error) failure = readableError(j.error);
          else if (j.exit_code && j.exit_code !== 0 && !String(j.text || '').trim()) failure = tr('Hermes 没有给出回复（退出码 {code}）', { code: j.exit_code });
          break;
      }
    };

    const done = (async () => {
      const caps = await probe();
      if (caps.known && !caps.json) return { error: OUTDATED() };
      if (cancelled) return { error: tr('已中止'), sessionId: sid };
      const input = agent.permission === 'readonly' ? `${READONLY_NOTE}\n\n${prompt}` : prompt;
      const r = runJsonl({ cmd: 'hermes', args: buildArgs({ agent, sessionId, caps }), cwd, input, onJson });
      child = r.child;
      const { code, error, stderr } = await r.done;
      seg.close();
      const text = (result && String(result.text || '').trim()) || seg.last;
      const usage = hermesUsage(result && result.tokens, model);
      if (error) return { error: error.message, sessionId: sid, stderr, usage };
      if (failure) return { text, error: failure, sessionId: sid, model, stderr, usage };
      if (!result && code !== 0) {
        const err = tail(stderr) || tr('{cmd} 意外退出（退出码 {code}）', { cmd: 'hermes', code });
        return { text, error: err, sessionId: sid, stderr, usage };
      }
      return { text, error: null, sessionId: sid, model, stderr, usage };
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

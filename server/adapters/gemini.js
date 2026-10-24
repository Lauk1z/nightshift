'use strict';
// Gemini CLI（Google）：gemini --output-format stream-json。prompt 走 stdin（不是终端时自动进入非交互模式），
// 第一条 init 里有 session_id，下次用 --resume <id> 续上。
// 权限对应 --approval-mode：default（无人值守时要确认的工具一律不能用，等于只读）/ auto_edit（自动批准改文件）/ yolo。
const { runJsonl, runCapture, killTree, detectCli, splitArgs } = require('../proc');
const { rel, outside, clip, tail, makeProbe, addUsage, readableError, segmenter } = require('./common');
const { t: tr } = require('../i18n');

// result.stats.models 里每个模型一份：input_tokens 含命中缓存的部分，cached + input 是它的拆分
function geminiUsage(stats) {
  const out = [];
  if (!stats || typeof stats !== 'object') return out;
  const one = (model, u) => {
    const all = Number(u.input_tokens) || 0;
    const cached = Math.min(all, Number(u.cached) || 0);
    addUsage(out, model, { input: u.input != null ? u.input : all - cached, cacheRead: cached, output: u.output_tokens });
  };
  const models = stats.models && typeof stats.models === 'object' ? Object.entries(stats.models) : [];
  if (models.length) for (const [m, u] of models) one(m, u || {});
  else one('', stats);
  return out;
}

const OUTDATED = () =>
  tr('这个版本的 Gemini CLI 太旧，不支持 --output-format stream-json。请先升级（命令行里运行 npm install -g @google/gemini-cli），再点左下角「重新检测」。');

const probe = makeProbe(async () => {
  const r = await runCapture('gemini', ['--help'], { timeoutMs: 30000 });
  const h = `${r.stdout}\n${r.stderr}`;
  if (!/--/.test(h)) return { known: false };
  return { known: true, json: /stream-json/.test(h), approval: /--approval-mode\b/.test(h), trust: /--skip-trust\b/.test(h) };
});

const MODE = { readonly: 'default', edit: 'auto_edit', full: 'yolo' };

function buildArgs({ agent, sessionId, caps = {} }) {
  const args = ['--output-format', 'stream-json'];
  const mode = MODE[agent.permission] || MODE.edit;
  if (caps.approval !== false) args.push('--approval-mode', mode);
  else if (mode === 'yolo') args.push('--yolo');
  // 项目文件夹是用户自己选的，直接信任它；不然 Gemini 会把它当成「未受信任的文件夹」，限制工具
  if (caps.trust !== false) args.push('--skip-trust');
  if (agent.model) args.push('-m', agent.model);
  if (sessionId) args.push('--resume', sessionId);
  args.push(...splitArgs(agent.extraArgs));
  return args;
}

const KIND = {
  read_file: 'read',
  read_many_files: 'read',
  write_file: 'write',
  replace: 'edit',
  edit: 'edit',
  smart_edit: 'edit',
  run_shell_command: 'cmd',
  glob: 'search',
  search_file_content: 'search',
  grep: 'search',
  grep_search: 'search',
  list_directory: 'search',
  ls: 'search',
  google_web_search: 'web',
  web_fetch: 'web',
  write_todos: 'todo',
  delegate_to_agent: 'agent',
  codebase_investigator: 'agent',
};

function toolItem(j, cwd) {
  const i = j.parameters && typeof j.parameters === 'object' ? j.parameters : {};
  const k = KIND[j.tool_name] || 'other';
  let d = '';
  if (k === 'read' || k === 'write' || k === 'edit') d = rel(i.file_path || i.absolute_path || i.path || (Array.isArray(i.paths) ? i.paths.join(', ') : ''), cwd);
  else if (k === 'cmd') d = i.command || '';
  else if (k === 'search') d = i.pattern || i.query || rel(i.dir_path || i.path || '', cwd);
  else if (k === 'web') d = i.url || i.query || i.prompt || '';
  else if (k === 'agent') d = i.objective || i.task || i.description || '';
  else d = clip(JSON.stringify(i), 160);
  return { id: j.tool_id, k, n: j.tool_name, d: clip(d, 400), s: 'running', ...outside(k, i.file_path || i.absolute_path || i.path || i.paths, cwd) };
}

module.exports = {
  id: 'gemini',
  label: 'Gemini CLI',
  cmd: 'gemini',
  buildArgs,
  probe,
  geminiUsage,
  async detect(force) {
    const base = await detectCli('gemini');
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
    let usage = [];
    let ended = false;
    const seg = segmenter(emit);

    const onJson = (j) => {
      switch (j.type) {
        case 'init':
          if (j.session_id && j.session_id !== sid) {
            sid = j.session_id;
            emit({ type: 'session', id: sid });
          }
          if (j.model) model = j.model;
          emit({ type: 'status', text: tr('思考中') });
          break;
        case 'message':
          // 开头还会把用户的输入回显一遍（role: user），不用管
          if (j.role === 'assistant' && typeof j.content === 'string') seg.delta(j.content);
          break;
        case 'tool_use':
          seg.close();
          emit({ type: 'tool', item: toolItem(j, cwd) });
          break;
        case 'tool_result':
          if (j.tool_id) emit({ type: 'tool', item: { id: j.tool_id, s: j.status === 'success' ? 'ok' : 'error' } });
          break;
        case 'error':
          if (j.severity !== 'warning' && j.message) failure = readableError(j.message);
          break;
        case 'result':
          ended = true;
          usage = geminiUsage(j.stats);
          // 接口出错时进程照样以 0 退出，只能看这里的 status
          if (j.status === 'error') failure = readableError(j.error && j.error.message) || failure || tr('Gemini CLI 运行出错');
          break;
      }
    };

    const done = (async () => {
      const caps = await probe();
      if (caps.known && !caps.json) return { error: OUTDATED() };
      if (cancelled) return { error: tr('已中止'), sessionId: sid };
      const r = runJsonl({ cmd: 'gemini', args: buildArgs({ agent, sessionId, caps }), cwd, input: prompt, onJson });
      child = r.child;
      const { code, error, stderr } = await r.done;
      seg.close();
      const text = seg.last;
      // 选 auto 时 init 里写的就是 auto，真正用的模型在用量统计里
      const used = (usage[0] && usage[0].model) || model;
      if (error) return { error: error.message, sessionId: sid, stderr, usage };
      if (failure) return { text, error: failure, sessionId: sid, model: used, stderr, usage };
      if (!ended && code !== 0) {
        const why = code === 41 ? tr('Gemini CLI 还没有登录。先在命令行里运行一次 gemini 完成登录，或者设置 GEMINI_API_KEY。') : '';
        const err = [why, tail(stderr)].filter(Boolean).join('\n') || tr('{cmd} 意外退出（退出码 {code}）', { cmd: 'gemini', code });
        return { text, error: err, sessionId: sid, stderr, usage };
      }
      return { text, error: null, sessionId: sid, model: used, stderr, usage };
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

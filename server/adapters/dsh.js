'use strict';
// DeepSeek Harness（deepseek-ai/deepseek-harness，命令是 dsh）：dsh headless --json，任务从 stdin 读（参数 -）。
// 每行一个事件：session（第一行，带 sessionId）、status（turn / step 的开始和结束；step_end 带用量，turn_end 带结束原因）、
// text、thinking、tool_call、tool_result、error，最后一行是 final。turn_end 的原因是 completed 才以 0 退出。
// 下次用 --session-id 续上（只能续在同一个文件夹里建的会话）。
// 模型和思考强度没有命令行参数：每次写一个临时的 --patch 文件，改 agent-default-model 这一项；权限用环境变量 DSH_PERMISSION_MODE。
// headless 只认启动时的环境变量 DEEPSEEK_API_KEY（这个模式下交互式的凭据存储是关着的）：成员设置里填了 Key 就用它，不然用系统里设置的。
// 会话建好以后模型和权限就定下来了，所以改了模型、思考强度、权限要换一个新会话（pinsSession，见 server/index.js）。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runJsonl, runCapture, killTree, detectCli, splitArgs } = require('../proc');
const { rel, outside, clip, tail, makeProbe, addUsage, contextOf, readableError, segmenter } = require('./common');
const { t: tr } = require('../i18n');

// 只读 / 可改文件 / 完全权限，对应 dsh 的三种文件沙箱
const PERM = { readonly: 'read-only', edit: 'workspace-write', full: 'danger-full-access' };
// dsh 的思考档位：off / low / high / max
const EFFORT = { none: 'off' };
const INSTALL = 'npm install -g @deepseek-ai/dsh';

const OUTDATED = () => tr('这个版本的 DeepSeek Harness 太旧，不支持 dsh headless --json。请先升级（命令行里运行 {cmd}），再点左下角「重新检测」。', { cmd: INSTALL });
const NO_KEY = () => tr('DeepSeek Harness 还没有 API Key：在成员设置里填上 DeepSeek 的 API Key，或者在系统环境变量里设置 DEEPSEEK_API_KEY。');

const probe = makeProbe(async () => {
  const r = await runCapture('dsh', ['headless', '--help'], { timeoutMs: 60000 });
  const h = `${r.stdout}\n${r.stderr}`;
  if (!/--/.test(h)) return { known: false };
  return { known: true, json: /--json\b/.test(h), session: /--session-id\b/.test(h) };
});

// 模型（「提供商/模型」或者只写模型名）和思考强度写成一个 patch，叠在 headless 这套配置上面。
// patch 会整个替换这一项的配置（不是合并），所以 provider 和 model 必须都写上：只选了思考强度时用 dsh 自带的默认模型
const DEFAULT_PROVIDER = 'deepseek-official';
const DEFAULT_MODEL = 'deepseek-flash';
function patchText(agent) {
  const m = String(agent.model || '').trim();
  if (!m && !agent.effort) return '';
  const i = m.indexOf('/');
  const provider = i > 0 ? m.slice(0, i) : DEFAULT_PROVIDER;
  const model = (i > 0 ? m.slice(i + 1) : m) || DEFAULT_MODEL;
  const lines = ['- id: agent-default-model', '  config:', `    provider: ${JSON.stringify(provider)}`, `    model: ${JSON.stringify(model)}`];
  if (agent.effort) lines.push(`    reasoningEffort: ${JSON.stringify(EFFORT[agent.effort] || agent.effort)}`);
  return lines.join('\n') + '\n';
}

function buildArgs({ agent, sessionId, patchFile }) {
  const args = ['headless'];
  if (patchFile) args.push('--patch', patchFile);
  args.push('--json');
  if (sessionId) args.push('--session-id', sessionId);
  args.push(...splitArgs(agent.extraArgs), '-');
  return args;
}

function buildEnv(agent) {
  const env = { DSH_PERMISSION_MODE: PERM[agent.permission] || PERM.edit };
  const key = agent.api && agent.api.apiKey;
  if (key) env.DEEPSEEK_API_KEY = key;
  return env;
}

const KIND = {
  read: 'read',
  read_image: 'read',
  write: 'write',
  edit: 'edit',
  str_replace_editor: 'edit',
  bash: 'cmd',
  pwsh: 'cmd',
  run_code: 'cmd',
  terminal_send: 'cmd',
  glob: 'search',
  grep: 'search',
  web_search: 'web',
  web_fetch: 'web',
  subagent: 'agent',
};

function toolItem(j, cwd) {
  const i = j.input && typeof j.input === 'object' ? j.input : {};
  const k = KIND[j.tool] || 'other';
  let d = '';
  if (k === 'read' || k === 'write' || k === 'edit') d = rel(i.file_path || i.path || '', cwd);
  else if (k === 'cmd') d = i.command || i.code || i.input || '';
  else if (k === 'search') d = i.pattern || i.query || rel(i.path || '', cwd);
  else if (k === 'web') d = i.query || i.url || '';
  else if (k === 'agent') d = i.description || i.prompt || i.task || '';
  else d = clip(JSON.stringify(i), 160);
  return { id: j.callId, k, n: j.tool || 'tool', d: clip(String(d), 400), s: 'running', ...outside(k, i.file_path || i.path, cwd) };
}

// step_end 带的用量：inputTokens 不含缓存，缓存另算（和 Anthropic 的接口一样）
function dshUsage(list, u, model) {
  if (!u) return list;
  return addUsage(list, model, { input: u.inputTokens, output: u.outputTokens, cacheRead: u.cacheReadTokens, cacheWrite: u.cacheWriteTokens });
}

module.exports = {
  id: 'dsh',
  label: 'DeepSeek Harness',
  cmd: 'dsh',
  pinsSession: true, // 模型、思考强度、权限在建会话时定下来，改了要换新会话
  buildArgs,
  buildEnv,
  patchText,
  dshUsage,
  probe,
  reportsContext: true,
  async detect(force) {
    const base = await detectCli('dsh');
    if (!base.installed) return base;
    const caps = await probe(force);
    return caps.known && !caps.json ? { ...base, outdated: true, hint: OUTDATED() } : base;
  },
  run({ agent, cwd, prompt, sessionId, emit }) {
    let child = null;
    let cancelled = false;
    let sid = sessionId || null;
    const model = agent.model || ''; // 事件里不带模型名，记成员选的（没选就是 dsh 的默认模型）
    let finalText = '';
    let failure = null;
    let code = '';
    const usage = [];
    let context = null; // 最后一步的用量就是这一轮结束时上下文用了多少
    const seg = segmenter(emit);
    let blockText = false; // 这一段里已经有一块文字了，下一块前面空一行

    const onJson = (j) => {
      switch (j.type) {
        case 'session':
          if (j.sessionId && j.sessionId !== sid) {
            sid = j.sessionId;
            emit({ type: 'session', id: sid });
          }
          break;
        case 'status':
          if (j.phase === 'turn_start' || j.phase === 'step_start') emit({ type: 'status', text: tr('思考中') });
          else if (j.phase === 'step_end') {
            dshUsage(usage, j.usage, model);
            const u = j.usage || {};
            context = contextOf(model, { input: u.inputTokens, output: u.outputTokens, cacheRead: u.cacheReadTokens, cacheWrite: u.cacheWriteTokens }) || context;
          }
          else if (j.phase === 'turn_end') {
            const r = j.reason || {};
            if (r.kind && r.kind !== 'completed') {
              const e = r.error || {};
              code = e.code || code;
              failure = readableError(e.message) || tr('DeepSeek Harness 运行出错（{kind}）', { kind: r.kind });
            } else failure = null;
          }
          break;
        case 'text':
          if (j.text) {
            seg.delta(blockText ? `\n\n${j.text}` : j.text);
            blockText = true;
          }
          break;
        case 'thinking':
          emit({ type: 'status', text: tr('思考中') });
          break;
        case 'tool_call':
          seg.close();
          blockText = false;
          emit({ type: 'tool', item: toolItem(j, cwd) });
          break;
        case 'tool_result':
          if (j.callId) emit({ type: 'tool', item: { id: j.callId, s: j.status === 'error' ? 'error' : 'ok' } });
          break;
        case 'error':
          failure = readableError(j.message) || tr('DeepSeek Harness 运行出错');
          break;
        case 'final':
          if (typeof j.text === 'string' && j.text.trim()) finalText = j.text;
          break;
      }
    };

    const done = (async () => {
      const caps = await probe();
      if (caps.known && !caps.json) return { error: OUTDATED() };
      if (cancelled) return { error: tr('已中止'), sessionId: sid };
      const patch = patchText(agent);
      const patchFile = patch ? path.join(os.tmpdir(), `agentchat-dsh-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.yml`) : null;
      if (patchFile) fs.writeFileSync(patchFile, patch, 'utf8');
      try {
        const r = runJsonl({ cmd: 'dsh', args: buildArgs({ agent, sessionId, patchFile }), cwd, input: prompt, onJson, env: buildEnv(agent) });
        child = r.child;
        const { code: exit, error, stderr } = await r.done;
        seg.close();
        const text = finalText || seg.last;
        if (error) return { error: error.message, sessionId: sid, stderr, usage, context };
        if (code === 'MISSING_CREDENTIAL' || /MISSING_CREDENTIAL/.test(stderr)) return { text, error: NO_KEY(), sessionId: sid, stderr, usage, context };
        if (failure) return { text, error: failure, sessionId: sid, model, stderr, usage, context };
        if (exit !== 0 && !text) return { error: tail(stderr) || tr('{cmd} 意外退出（退出码 {code}）', { cmd: 'dsh', code: exit }), sessionId: sid, stderr, usage, context };
        return { text, error: null, sessionId: sid, model, stderr, usage, context };
      } finally {
        if (patchFile) fs.rm(patchFile, { force: true }, () => {});
      }
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

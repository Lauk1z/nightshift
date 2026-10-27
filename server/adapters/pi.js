'use strict';
// pi（earendil-works/pi，原 pi-coding-agent）：pi --mode json，prompt 走 stdin。
// 第一行是会话头 {"type":"session","id":…}，下次用 --session <id> 续上。
// pi 没有权限系统，权限靠 --tools 限定能用的工具：只读给 read,grep,find,ls；可改文件再加 edit,write；完全权限用默认工具（含 bash）。
const { runJsonl, runCapture, killTree, detectCli, splitArgs } = require('../proc');
const { rel, outside, clip, tail, makeProbe, addUsage, contextOf, readableError, segmenter } = require('./common');
const { t: tr } = require('../i18n');

const TOOLS = { readonly: 'read,grep,find,ls', edit: 'read,grep,find,ls,edit,write', full: '' };
// pi 的思考档位：off / minimal / low / medium / high / xhigh / max（超过模型支持的会自动降下来）
const THINK = { none: 'off' };

const OUTDATED = () => tr('这个版本的 pi 太旧，不支持 --mode json。请先升级（命令行里运行 npm install -g @earendil-works/pi-coding-agent），再点左下角「重新检测」。');

const probe = makeProbe(async () => {
  const r = await runCapture('pi', ['--help'], { timeoutMs: 30000 });
  const h = `${r.stdout}\n${r.stderr}`;
  if (!/--/.test(h)) return { known: false };
  return { known: true, json: /--mode\b/.test(h), thinking: /--thinking\b/.test(h), tools: /--tools\b/.test(h) };
});

function buildArgs({ agent, sessionId, caps = {} }) {
  const args = ['--mode', 'json'];
  const tools = agent.permission in TOOLS ? TOOLS[agent.permission] : TOOLS.edit;
  if (tools && caps.tools !== false) args.push('--tools', tools);
  if (agent.model) args.push('--model', agent.model);
  if (agent.effort && caps.thinking !== false) args.push('--thinking', THINK[agent.effort] || agent.effort);
  if (sessionId) args.push('--session', sessionId);
  args.push(...splitArgs(agent.extraArgs));
  return args;
}

const KIND = { read: 'read', write: 'write', edit: 'edit', bash: 'cmd', grep: 'search', find: 'search', ls: 'search' };

function toolItem(j, cwd) {
  const i = j.args && typeof j.args === 'object' ? j.args : {};
  const k = KIND[j.toolName] || 'other';
  let d = '';
  if (k === 'read' || k === 'write' || k === 'edit') d = rel(i.path || i.file_path || '', cwd);
  else if (k === 'cmd') d = i.command || '';
  else if (k === 'search') d = i.pattern || i.query || rel(i.path || '', cwd);
  else d = clip(JSON.stringify(i), 160);
  return { id: j.toolCallId, k, n: j.toolName || 'tool', d: clip(d, 400), s: 'running', ...outside(k, i.path || i.file_path, cwd) };
}

// 每条回复的 message 里有它自己的用量和模型（provider/model）。最后一条回复的用量就是这一轮结束时上下文用了多少
function piUsage(list, m, fallbackModel) {
  const u = m && m.usage;
  if (!u) return list;
  const model = m.model ? (m.provider ? `${m.provider}/${m.model}` : m.model) : fallbackModel;
  return addUsage(list, model, { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite });
}

const textOf = (m) =>
  (Array.isArray(m.content) ? m.content : [])
    .filter((c) => c && c.type === 'text')
    .map((c) => c.text || '')
    .join('');

module.exports = {
  id: 'pi',
  label: 'pi',
  cmd: 'pi',
  buildArgs,
  probe,
  piUsage,
  reportsContext: true,
  async detect(force) {
    const base = await detectCli('pi');
    if (!base.installed) return base;
    const caps = await probe(force);
    return caps.known && !caps.json ? { ...base, outdated: true, hint: OUTDATED() } : base;
  },
  run({ agent, cwd, prompt, sessionId, emit }) {
    let child = null;
    let cancelled = false;
    let sid = sessionId || null;
    let model = agent.model || '';
    let finalText = '';
    let failure = null;
    const usage = [];
    let last = null; // 最后一条回复的用量（上下文）
    const seg = segmenter(emit);

    const onJson = (j) => {
      switch (j.type) {
        case 'session':
          if (j.id && j.id !== sid) {
            sid = j.id;
            emit({ type: 'session', id: sid });
          }
          break;
        case 'agent_start':
        case 'turn_start':
          emit({ type: 'status', text: tr('思考中') });
          break;
        case 'message_update': {
          const e = j.assistantMessageEvent || {};
          if (e.type === 'text_delta') seg.delta(e.delta || '');
          else if (/^thinking_/.test(e.type || '')) emit({ type: 'status', text: tr('思考中') });
          else if (e.type === 'toolcall_start') seg.close();
          break;
        }
        case 'message_end': {
          const m = j.message || {};
          if (m.role !== 'assistant') break; // 系统提示、用户消息、工具结果也会走一遍
          seg.close();
          piUsage(usage, m, model);
          if (m.model) model = m.provider ? `${m.provider}/${m.model}` : m.model;
          if (m.usage) last = contextOf(model, m.usage);
          const t = textOf(m);
          if (t.trim()) finalText = t;
          // 接口报错时进程照样以 0 退出，错误写在这条回复里；之后自动重试成功了就不算
          if (m.stopReason === 'error' || m.errorMessage) failure = readableError(m.errorMessage) || tr('pi 运行出错');
          else if (m.stopReason !== 'aborted') failure = null;
          break;
        }
        case 'tool_execution_start':
          seg.close();
          emit({ type: 'tool', item: toolItem(j, cwd) });
          break;
        case 'tool_execution_end':
          if (j.toolCallId) emit({ type: 'tool', item: { id: j.toolCallId, s: j.isError ? 'error' : 'ok' } });
          break;
        case 'auto_retry_start':
          emit({ type: 'status', text: tr('出错了，正在重试') });
          break;
        case 'auto_retry_end':
          if (j.success) failure = null;
          else if (j.finalError) failure = readableError(j.finalError);
          break;
      }
    };

    const done = (async () => {
      const caps = await probe();
      if (caps.known && !caps.json) return { error: OUTDATED() };
      if (cancelled) return { error: tr('已中止'), sessionId: sid };
      const r = runJsonl({ cmd: 'pi', args: buildArgs({ agent, sessionId, caps }), cwd, input: prompt, onJson });
      child = r.child;
      const { code, error, stderr } = await r.done;
      seg.close();
      const text = finalText || seg.last;
      const context = last;
      if (error) return { error: error.message, sessionId: sid, stderr, usage, context };
      if (failure) return { text, error: failure, sessionId: sid, model, stderr, usage, context };
      if (code !== 0 && !text) {
        const why = /no api key|no models available|\/login/i.test(stderr) ? tr('pi 还没有能用的模型：在命令行里运行 pi，用 /login 登录，或者设置对应的 API Key。') : '';
        const err = [why, tail(stderr)].filter(Boolean).join('\n') || tr('{cmd} 意外退出（退出码 {code}）', { cmd: 'pi', code });
        return { error: err, sessionId: sid, stderr, usage, context };
      }
      return { text, error: null, sessionId: sid, model, stderr, usage, context };
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

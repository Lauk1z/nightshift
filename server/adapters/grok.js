'use strict';
// Grok Build（xAI）：grok --output-format streaming-json。它不读 stdin，prompt 写进临时文件用 --prompt-file 传。
// 新会话用 -s <自己生成的 UUID> 建，最后一行 end 里也有 sessionId，下次用 --resume <id> 续上。
// 权限对应 --permission-mode：dontAsk（只放行只读的工具和命令）/ acceptEdits（自动批准改文件）/ --always-approve。
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runJsonl, runCapture, killTree, detectCli, splitArgs } = require('../proc');
const { rel, clip, tail, makeProbe, addUsage, readableError, segmenter } = require('./common');
const { t: tr } = require('../i18n');

// end 里的用量：modelUsage 按模型分好，inputTokens 不含命中缓存的部分；没有分模型时用 usage 合计
function grokUsage(end, fallbackModel) {
  const out = [];
  if (!end || typeof end !== 'object') return out;
  const u = end.usage || {};
  const per = end.modelUsage && typeof end.modelUsage === 'object' ? Object.entries(end.modelUsage) : [];
  if (per.length) {
    for (const [m, x] of per) {
      addUsage(out, m, {
        input: x.inputTokens,
        output: x.outputTokens,
        cacheRead: x.cacheReadInputTokens,
        cacheWrite: x.cacheCreationInputTokens != null ? x.cacheCreationInputTokens : per.length === 1 ? u.cache_creation_input_tokens : 0,
      });
    }
  } else {
    addUsage(out, fallbackModel, { input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens });
  }
  return out;
}

const OUTDATED = () => tr('这个版本的 Grok Build 太旧，不支持 streaming-json 输出。请先升级（命令行里运行 grok update），再点左下角「重新检测」。');

const probe = makeProbe(async () => {
  const r = await runCapture('grok', ['--help'], { timeoutMs: 30000 });
  const h = `${r.stdout}\n${r.stderr}`;
  if (!/--/.test(h)) return { known: false };
  return {
    known: true,
    json: /--output-format\b/.test(h),
    promptFile: /--prompt-file\b/.test(h),
    verbatim: /--verbatim\b/.test(h),
    permissionMode: /--permission-mode\b/.test(h),
  };
});

const PERM = {
  readonly: ['--permission-mode', 'dontAsk'],
  edit: ['--permission-mode', 'acceptEdits'],
  full: ['--always-approve'],
};

function buildArgs({ agent, sessionId, newSessionId, promptFile, caps = {}, trust = true }) {
  const args = ['--prompt-file', promptFile, '--output-format', 'streaming-json'];
  // 原样发送：别把消息里的 @名字、/技能 当成 Grok 自己的文件引用和命令
  if (caps.verbatim !== false) args.push('--verbatim');
  // 项目文件夹是用户自己选的：信任它，项目里有 .grok/、.claude/ 配置时无人值守也能启动
  if (trust) args.push('--trust');
  const perm = PERM[agent.permission] || PERM.edit;
  if (perm[0] !== '--permission-mode' || caps.permissionMode !== false) args.push(...perm);
  if (agent.model) args.push('-m', agent.model);
  if (agent.effort) args.push('--effort', agent.effort);
  if (sessionId) args.push('--resume', sessionId);
  else if (newSessionId) args.push('-s', newSessionId);
  args.push(...splitArgs(agent.extraArgs));
  return args;
}

// ACP 的工具种类：read / edit / delete / move / search / execute / fetch / think / other
const KIND = { read: 'read', edit: 'edit', delete: 'edit', move: 'edit', search: 'search', execute: 'cmd', fetch: 'web', think: 'other', other: 'other' };
const STATUS = (s) => (s === 'completed' ? 'ok' : s === 'failed' ? 'error' : 'running');

function toolItem(j, cwd) {
  const i = j.rawInput && typeof j.rawInput === 'object' ? j.rawInput : {};
  const name = j.toolName || '';
  let k = KIND[j.kind] || 'other';
  if (k === 'edit' && /^(write_file|create_file|write)$/i.test(name)) k = 'write';
  if (/todo/i.test(name)) k = 'todo';
  if (/^(task|agent|spawn_?agent|subagent)/i.test(name)) k = 'agent';
  const loc = Array.isArray(j.locations) && j.locations[0] && j.locations[0].path;
  let d = '';
  if (k === 'read' || k === 'write' || k === 'edit') d = rel(i.path || i.file_path || i.target_file || loc || '', cwd);
  else if (k === 'cmd') d = i.command || i.cmd || '';
  else if (k === 'search') d = i.pattern || i.query || i.regex || rel(i.path || loc || '', cwd);
  else if (k === 'web') d = i.url || i.query || '';
  if (!d) d = j.title || clip(JSON.stringify(i), 160);
  return { id: j.toolCallId, k, n: name || j.title || 'tool', d: clip(d, 400), s: STATUS(j.status) };
}

module.exports = {
  id: 'grok',
  label: 'Grok Build',
  cmd: 'grok',
  buildArgs,
  probe,
  grokUsage,
  async detect(force) {
    const base = await detectCli('grok');
    if (!base.installed) return base;
    const caps = await probe(force);
    return caps.known && (!caps.json || !caps.promptFile) ? { ...base, outdated: true, hint: OUTDATED() } : base;
  },
  run({ agent, cwd, prompt, sessionId, emit }) {
    let child = null;
    let cancelled = false;
    let sid = sessionId || null;
    // 新会话自己先定好 id：中途停下来也知道下次该续哪个会话
    const newSessionId = sessionId ? null : crypto.randomUUID();
    let announced = false;
    let failure = null;
    let end = null;
    const seg = segmenter(emit);
    const promptFile = path.join(os.tmpdir(), `agentchat-grok-${crypto.randomBytes(6).toString('hex')}.md`);

    const onJson = (j) => {
      if (newSessionId && !announced && j.type !== 'error') {
        announced = true; // 开始有正常输出，说明会话已经建好了
        sid = newSessionId;
        emit({ type: 'session', id: sid });
      }
      switch (j.type) {
        case 'text':
          if (typeof j.data === 'string') seg.delta(j.data);
          break;
        case 'thought':
          emit({ type: 'status', text: tr('思考中') });
          break;
        case 'tool_call':
          seg.close();
          emit({ type: 'tool', item: toolItem(j, cwd) });
          break;
        case 'tool_call_update':
          if (j.toolCallId && j.status) emit({ type: 'tool', item: { id: j.toolCallId, s: STATUS(j.status) } });
          break;
        case 'max_turns_reached':
          failure = tr('达到了最多轮数，先停下来了');
          break;
        case 'error':
          failure = readableError(j.message) || tr('Grok 运行出错');
          break;
        case 'end':
          end = j;
          if (j.sessionId && j.sessionId !== sid) {
            sid = j.sessionId;
            emit({ type: 'session', id: sid });
          }
          if (j.stopReason === 'refusal') failure = tr('Grok 拒绝了这个请求');
          break;
      }
    };

    const attempt = (caps, trust) => {
      const r = runJsonl({ cmd: 'grok', args: buildArgs({ agent, sessionId, newSessionId, promptFile, caps, trust }), cwd, input: '', onJson });
      child = r.child;
      return r.done;
    };

    const done = (async () => {
      const caps = await probe();
      if (caps.known && (!caps.json || !caps.promptFile)) return { error: OUTDATED() };
      if (cancelled) return { error: tr('已中止'), sessionId: sid };
      fs.writeFileSync(promptFile, prompt, 'utf8');
      try {
        let res = await attempt(caps, true);
        // --trust 是新版才有的隐藏参数，旧版不认识就去掉再来一次
        if (!cancelled && res.code !== 0 && !end && /--trust/.test(res.stderr) && /unexpected|unrecognized|unknown/i.test(res.stderr)) res = await attempt(caps, false);
        const { code, error, stderr } = res;
        seg.close();
        const text = seg.last;
        const usage = grokUsage(end, agent.model || '');
        const model = (usage[0] && usage[0].model) || agent.model || '';
        if (error) return { error: error.message, sessionId: sid, stderr, usage };
        if (failure) return { text, error: failure, sessionId: sid, model, stderr, usage };
        if (code !== 0 && !end) {
          const err = tail(stderr) || tr('{cmd} 意外退出（退出码 {code}）', { cmd: 'grok', code });
          return { text, error: err, sessionId: sid, stderr, usage };
        }
        return { text, error: null, sessionId: sid, model, stderr, usage };
      } finally {
        fs.rm(promptFile, { force: true }, () => {});
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

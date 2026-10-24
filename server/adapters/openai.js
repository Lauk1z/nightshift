'use strict';
// 任意 OpenAI 兼容接口（DeepSeek、通义千问、Kimi、智谱、OpenRouter、Ollama、OpenAI 本身……）。
// 这类模型没有自己的工具，所以这里提供一组只能在项目文件夹内操作的文件工具，
// 让它们也能读写项目文件；「完全权限」时再加上运行命令。
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { killTree, childEnv, IS_WIN } = require('../proc');
const { rel, outside, clip, addUsage } = require('./common');
// 给用户看的（状态、报错）跟着界面语言；工具说明和工具结果是给模型看的，保持中文
const { t: tr } = require('../i18n');

const SKIP_DIRS = new Set(['node_modules', '.git', '.agentchat', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv', 'target']);
const RANK = { readonly: 0, edit: 1, full: 2 };

const TOOLS = {
  list_files: {
    level: 'readonly',
    description: '列出项目文件夹里某个目录的内容，目录名以 / 结尾。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对项目文件夹的目录，默认 "."' },
        recursive: { type: 'boolean', description: '是否递归列出（会跳过 node_modules、.git 等）' },
      },
    },
  },
  read_file: {
    level: 'readonly',
    description: '读取项目文件夹里的一个文本文件。',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  write_file: {
    level: 'edit',
    description: '创建或整体覆盖项目文件夹里的文件，会自动创建所需目录。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
  },
  edit_file: {
    level: 'edit',
    description: '把文件里唯一出现的一段原文替换成新内容。原文必须逐字一致（包括缩进）。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } },
      required: ['path', 'old_text', 'new_text'],
    },
  },
  run_command: {
    level: 'full',
    description: IS_WIN
      ? '在项目文件夹里运行一条 PowerShell 命令并返回输出，最长 120 秒。'
      : '在项目文件夹里运行一条 shell 命令并返回输出，最长 120 秒。',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  },
};

function toolDefs(permission) {
  const lvl = RANK[permission] ?? 1;
  return Object.entries(TOOLS)
    .filter(([, t]) => RANK[t.level] <= lvl)
    .map(([name, t]) => ({ type: 'function', function: { name, description: t.description, parameters: t.parameters } }));
}

function safePath(cwd, p) {
  const root = path.resolve(cwd);
  const full = path.resolve(root, String(p || '.'));
  const a = IS_WIN ? full.toLowerCase() : full;
  const b = IS_WIN ? root.toLowerCase() : root;
  if (a !== b && !a.startsWith(b.endsWith(path.sep) ? b : b + path.sep)) throw new Error('只能访问项目文件夹以内的路径');
  return full;
}

function listFiles(cwd, args) {
  const start = safePath(cwd, args.path || '.');
  const out = [];
  const walk = (dir, depth) => {
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      out.push(`（无法读取 ${rel(dir, cwd) || '.'}：${e.code || e.message}）`);
      return;
    }
    ents.sort((x, y) => y.isDirectory() - x.isDirectory() || x.name.localeCompare(y.name));
    for (const e of ents) {
      if (out.length >= 400) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        out.push(rel(full, cwd) + '/');
        if (args.recursive && depth < 6 && !SKIP_DIRS.has(e.name)) walk(full, depth + 1);
      } else {
        out.push(rel(full, cwd));
      }
    }
  };
  walk(start, 0);
  if (!out.length) return '（空目录）';
  return out.join('\n') + (out.length >= 400 ? '\n…（太多了，已截断）' : '');
}

function readFile(cwd, args) {
  const f = safePath(cwd, args.path);
  if (fs.statSync(f).isDirectory()) return '这是一个目录，请改用 list_files。';
  const buf = fs.readFileSync(f);
  if (buf.subarray(0, 8000).includes(0)) return '（二进制文件，无法按文本读取）';
  const s = buf.toString('utf8');
  return s.length > 200000 ? s.slice(0, 200000) + '\n…（文件太长，已截断）' : s;
}

function runCommand(command, ctx) {
  return new Promise((resolve) => {
    const env = childEnv();
    const child = IS_WIN
      ? spawn(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ' + command],
          { cwd: ctx.cwd, env, windowsHide: true }
        )
      : spawn('/bin/sh', ['-c', command], { cwd: ctx.cwd, env, detached: true });
    ctx.children.add(child);
    let out = '';
    const add = (d) => {
      out += d;
      if (out.length > 60000) out = out.slice(-60000);
    };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const timer = setTimeout(() => {
      killTree(child);
      add('\n（超过 120 秒，已强制结束）');
    }, 120000);
    child.on('error', (e) => {
      clearTimeout(timer);
      ctx.children.delete(child);
      resolve(`无法运行：${e.message}`);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      ctx.children.delete(child);
      resolve(`退出码 ${code}\n${clip(out.trim(), 20000)}`);
    });
    child.stdin.end();
  });
}

async function execTool(name, args, ctx) {
  const lvl = RANK[ctx.permission] ?? 1;
  if (!TOOLS[name]) throw new Error(`没有名为 ${name} 的工具`);
  if (RANK[TOOLS[name].level] > lvl) throw new Error('当前权限不允许使用这个工具');
  const { cwd } = ctx;
  switch (name) {
    case 'list_files':
      return listFiles(cwd, args);
    case 'read_file':
      return readFile(cwd, args);
    case 'write_file': {
      const f = safePath(cwd, args.path);
      const content = String(args.content ?? '');
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, content, 'utf8');
      return `已写入 ${rel(f, cwd)}（${Buffer.byteLength(content)} 字节）`;
    }
    case 'edit_file': {
      const f = safePath(cwd, args.path);
      const s = fs.readFileSync(f, 'utf8');
      const oldT = String(args.old_text ?? '');
      if (!oldT) throw new Error('old_text 不能为空');
      const n = s.split(oldT).length - 1;
      if (n === 0) throw new Error('文件里找不到 old_text，请先用 read_file 确认原文');
      if (n > 1) throw new Error(`old_text 在文件里出现了 ${n} 次，请给出更长、唯一的一段原文`);
      fs.writeFileSync(f, s.replace(oldT, () => String(args.new_text ?? '')), 'utf8');
      return `已修改 ${rel(f, cwd)}`;
    }
    case 'run_command':
      return runCommand(String(args.command || ''), ctx);
  }
}

function toolItem(id, name, args, cwd) {
  const map = { list_files: 'search', read_file: 'read', write_file: 'write', edit_file: 'edit', run_command: 'cmd' };
  const k = map[name] || 'other';
  const d = k === 'cmd' ? args.command || '' : rel(safeRel(cwd, args.path || '.'), cwd);
  // 写到项目外会被 safePath 拦下（这一步显示为失败），这里只是标出来
  return { id, k, n: name, d: clip(d, 400), s: 'running', ...outside(k, args.path, cwd) };
}

function safeRel(cwd, p) {
  try {
    return path.resolve(cwd, String(p));
  } catch {
    return String(p);
  }
}

async function readSse(res, emit, onChunk) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let j;
      try {
        j = JSON.parse(data);
      } catch {
        continue;
      }
      if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
      onChunk(j);
    }
  }
}

// 各家的 usage 写法：OpenAI 把命中缓存的数放在 prompt_tokens_details.cached_tokens，DeepSeek 叫 prompt_cache_hit_tokens
function apiUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const prompt = Number(u.prompt_tokens ?? u.input_tokens) || 0;
  const hit = u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens != null ? u.prompt_tokens_details.cached_tokens : u.prompt_cache_hit_tokens;
  const cached = Math.min(prompt, Number(hit) || 0);
  return { input: prompt - cached, cacheRead: cached, output: u.completion_tokens ?? u.output_tokens };
}

async function chat({ url, key, body, signal, emit }) {
  const send = (b) =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { authorization: 'Bearer ' + key } : {}) },
      body: JSON.stringify(b),
      signal,
    });
  let res = await send(body);
  // 少数接口不认 stream_options（用来要用量的），去掉再试一次
  if (!res.ok && body.stream_options && (res.status === 400 || res.status === 422)) {
    let t = '';
    try {
      t = await res.clone().text();
    } catch {}
    if (/stream_options|include_usage/i.test(t)) {
      delete body.stream_options;
      res = await send(body);
    }
  }
  if (!res.ok) {
    let t = '';
    try {
      t = await res.text();
    } catch {}
    throw new Error(tr('接口返回 {status}：{text}', { status: res.status, text: clip(t, 600) || res.statusText }));
  }
  const out = { content: '', reasoning: '', calls: [], finish: null, usage: null };
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('text/event-stream')) {
    const j = await res.json();
    if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
    const ch = (j.choices && j.choices[0]) || {};
    const msg = ch.message || {};
    out.content = msg.content || '';
    out.reasoning = msg.reasoning_content || '';
    out.calls = (msg.tool_calls || []).map((t) => ({ id: t.id, name: t.function && t.function.name, args: (t.function && t.function.arguments) || '' }));
    out.finish = ch.finish_reason;
    out.usage = apiUsage(j.usage);
    if (out.content) emit({ type: 'delta', text: out.content });
    return out;
  }
  const calls = [];
  await readSse(res, emit, (j) => {
    if (j.usage) out.usage = apiUsage(j.usage);
    const ch = j.choices && j.choices[0];
    if (!ch) return;
    const d = ch.delta || {};
    if (d.content) {
      out.content += d.content;
      emit({ type: 'delta', text: d.content });
    }
    const r = d.reasoning_content || d.reasoning;
    if (r) {
      out.reasoning += r;
      emit({ type: 'status', text: tr('思考中') });
    }
    for (const t of d.tool_calls || []) {
      const k = t.index ?? calls.length;
      const cur = (calls[k] = calls[k] || { id: '', name: '', args: '' });
      if (t.id) cur.id = t.id;
      if (t.function && t.function.name && !cur.name) cur.name = t.function.name;
      if (t.function && t.function.arguments) cur.args += t.function.arguments;
    }
    if (ch.finish_reason) out.finish = ch.finish_reason;
  });
  out.calls = calls.filter(Boolean);
  return out;
}

module.exports = {
  id: 'openai',
  get label() {
    return tr('API 模型');
  },
  stateless: true,
  apiUsage,
  detect: async () => ({ installed: true }),
  run({ agent, cwd, apiMessages, emit }) {
    const ac = new AbortController();
    const ctx = { cwd, permission: agent.permission || 'edit', children: new Set() };
    const api = agent.api || {};
    const cancel = () => {
      ac.abort();
      for (const c of ctx.children) killTree(c);
    };

    const done = (async () => {
      const base = String(api.baseUrl || '').trim().replace(/\/+$/, '');
      if (!/^https?:\/\//i.test(base)) return { error: tr('还没有填写接口地址（Base URL）') };
      if (!agent.model) return { error: tr('还没有填写模型名称') };
      const url = /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';
      const tools = api.tools === false ? [] : toolDefs(ctx.permission);
      const messages = apiMessages.slice();
      const usage = [];
      emit({ type: 'status', text: tr('思考中') });
      try {
        for (let step = 0; step < 40; step++) {
          const body = { model: agent.model };
          if (agent.effort) body.reasoning_effort = agent.effort;
          // 各家特有的参数（比如开启思考模式）由用户在「额外请求参数」里用 JSON 填写
          if (api.extraBody && typeof api.extraBody === 'object') Object.assign(body, api.extraBody);
          body.messages = messages;
          body.stream = true;
          body.stream_options = { include_usage: true }; // 让接口在最后告诉我们用了多少 token
          if (tools.length) body.tools = tools;
          emit({ type: 'text_start' });
          const r = await chat({ url, key: api.apiKey, body, signal: ac.signal, emit });
          if (r.usage) addUsage(usage, agent.model, r.usage);
          if (!r.calls.length) return { text: r.content, model: agent.model, usage };
          if (r.content.trim()) emit({ type: 'text', text: r.content });
          const assistant = {
            role: 'assistant',
            content: r.content || null,
            tool_calls: r.calls.map((c, i) => ({
              id: c.id || `call_${step}_${i}`,
              type: 'function',
              function: { name: c.name, arguments: c.args || '{}' },
            })),
          };
          if (r.reasoning) assistant.reasoning_content = r.reasoning;
          messages.push(assistant);
          for (const tc of assistant.tool_calls) {
            let args = {};
            let out;
            let ok = true;
            try {
              args = JSON.parse(tc.function.arguments || '{}');
            } catch {
              args = {};
            }
            const item = toolItem(tc.id, tc.function.name, args, cwd);
            emit({ type: 'tool', item });
            try {
              out = await execTool(tc.function.name, args, ctx);
            } catch (e) {
              ok = false;
              out = '出错：' + (e.message || String(e));
            }
            emit({ type: 'tool', item: { id: tc.id, s: ok ? 'ok' : 'error' } });
            messages.push({ role: 'tool', tool_call_id: tc.id, content: String(out) });
          }
        }
        return { error: tr('工具调用次数太多（超过 40 轮），已停止'), usage };
      } catch (e) {
        if (ac.signal.aborted) return { error: tr('已中止'), usage };
        return { error: e.message || String(e), usage };
      }
    })();

    return { cancel, done };
  },
};

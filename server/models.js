'use strict';
// 读取各家 AI 工具能用的模型和「思考强度」档位，让界面可以给每个成员单独选择。
//   Claude Code：~/.claude/settings.json 里的模型选项和别名映射
//   Codex：codex debug models（官方模型目录，含每个模型支持的思考档位）
//   OpenCode：opencode api model.list（含每个模型的 variant，也就是思考档位）
//   Gemini CLI：几个模型别名（auto / pro / flash），默认模型在 ~/.gemini/settings.json
//   Grok Build：grok models；pi：pi --list-models；Hermes：只读出它设置里的默认模型
//   API 模型：调用接口自己的 /models
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runCapture } = require('./proc');
const { tail } = require('./adapters/common');
const { t: tr } = require('./i18n');

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh'];
const API_EFFORTS = ['none', 'low', 'medium', 'high'];
const TTL = 5 * 60 * 1000;
const cache = new Map();

function readJson(f) {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
}

// caps 是 claude --help 探测到的版本能力：支持哪些思考强度档位、有哪些模型别名。
// 新电脑上可能没有 settings.json，这时只列出别名（它们会指向官方的最新模型）。
function claudeCatalog(configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), caps = {}) {
  const file = path.join(configDir, 'settings.json');
  const s = readJson(file) || {};
  const env = s.env || {};
  const models = [];
  const seen = new Set();
  const add = (m) => {
    if (!m.id || seen.has(m.id)) return;
    seen.add(m.id);
    models.push(m);
  };
  for (const o of (s.modelPicker && s.modelPicker.options) || []) {
    add({ id: o.model, label: o.label || o.model, note: o.description || '' });
  }
  const aliases = [...new Set([...(caps.aliases || []), 'opus', 'sonnet', 'haiku'])];
  for (const alias of aliases) {
    const up = alias.toUpperCase();
    const mapped = env[`ANTHROPIC_DEFAULT_${up}_MODEL_NAME`] || env[`ANTHROPIC_DEFAULT_${up}_MODEL`];
    add({ id: alias, label: alias, note: mapped ? tr('别名，实际指向 {model}', { model: mapped }) : tr('别名，指向最新的 {alias} 模型', { alias }) });
  }
  const supported = caps.effort !== false;
  return {
    models,
    efforts: supported ? (caps.efforts && caps.efforts.length ? caps.efforts : CLAUDE_EFFORTS) : [],
    effortNote: supported ? '' : tr('这个版本的 Claude Code 还不支持设置思考强度。升级后（命令行里运行 claude update）点左下角「重新检测」。'),
    defaultModel: env.ANTHROPIC_MODEL || s.model || '',
    defaultEffort: supported ? env.CLAUDE_CODE_EFFORT_LEVEL || s.effortLevel || '' : '',
    source: file,
  };
}

// 只读 config.toml 顶层（第一个 [section] 之前）的简单键值
function tomlTop(file) {
  let txt = '';
  try {
    txt = fs.readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  const top = txt.split(/^\s*\[/m)[0];
  const get = (k) => {
    const m = top.match(new RegExp(`^\\s*${k}\\s*=\\s*["']([^"']*)["']`, 'm'));
    return m ? m[1] : '';
  };
  return { model: get('model'), effort: get('model_reasoning_effort') };
}

function parseCodexModels(stdout, conf = {}) {
  const j = JSON.parse(stdout);
  const list = Array.isArray(j) ? j : j.models || [];
  // 有 upgrade 字段的是已有新版替代的旧模型：排到最后并标出来（有些账号已经用不了，比如 ChatGPT 账号不能用 gpt-5.5）
  const legacy = (m) => (m.upgrade && m.upgrade.model ? 1 : 0);
  const models = list
    .filter((m) => m && m.slug && (m.visibility !== 'hide' || m.slug === conf.model))
    .sort((a, b) => legacy(a) - legacy(b) || (a.priority ?? 999) - (b.priority ?? 999))
    .map((m) => {
      const levels = (m.supported_reasoning_levels || []).map((x) => (typeof x === 'string' ? { effort: x } : x));
      return {
        id: m.slug,
        label: (m.display_name || m.slug) + (legacy(m) ? tr('（旧版）') : ''),
        note: legacy(m)
          ? tr('旧版模型，已有新版 {model} 替代；有些账号可能用不了，出错时换一个新版模型。', { model: m.upgrade.model })
          : m.description || '',
        legacy: !!legacy(m),
        efforts: levels.map((x) => x.effort).filter(Boolean),
        effortNotes: Object.fromEntries(levels.map((x) => [x.effort, x.description || ''])),
        defaultEffort: m.default_reasoning_level || '',
      };
    });
  return models;
}

async function codexCatalog() {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const conf = tomlTop(path.join(home, 'config.toml'));
  const r = await runCapture('codex', ['debug', 'models'], { timeoutMs: 45000 });
  let models = [];
  let error = '';
  try {
    models = parseCodexModels(r.stdout, conf);
  } catch {
    // 旧版 Codex 没有 debug models 命令
    error = r.error ? r.error.message : tr('读取 Codex 模型列表失败（版本可能太旧，可以运行 codex update 升级）');
  }
  return { models, efforts: CODEX_EFFORTS, defaultModel: conf.model || '', defaultEffort: conf.effort || '', source: 'codex debug models', error };
}

function variantNames(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : x && (x.id || x.name))).filter(Boolean);
  if (typeof v === 'object') return Object.keys(v);
  return [];
}

function parseOpencodeModels(stdout) {
  const j = JSON.parse(stdout);
  const list = Array.isArray(j) ? j : j.data || [];
  return list
    .filter((m) => m && m.id && m.providerID && m.enabled !== false)
    .map((m) => ({ id: `${m.providerID}/${m.id}`, label: m.name || m.id, note: m.providerID, efforts: variantNames(m.variants) }));
}

// opencode models 的输出：每行一个 provider/model
function parseOpencodePlain(stdout) {
  return String(stdout || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^[\w.@-]+\/\S+$/.test(l))
    .map((id) => ({ id, label: id.slice(id.indexOf('/') + 1), note: id.slice(0, id.indexOf('/')), efforts: [] }));
}

async function opencodeCatalog() {
  const caps = await require('./adapters/opencode').probe();
  const r = await runCapture('opencode', ['api', 'model.list'], { timeoutMs: 60000 });
  let models = [];
  let error = '';
  try {
    models = parseOpencodeModels(r.stdout);
  } catch {
    // 旧版没有 api 命令：退回 opencode models，只有模型名，没有思考强度档位
    const plain = await runCapture('opencode', ['models'], { timeoutMs: 60000 });
    models = parseOpencodePlain(plain.stdout);
    if (!models.length) error = r.error ? r.error.message : tr('读取 OpenCode 模型列表失败（版本可能太旧，可以运行 opencode upgrade 升级）');
  }
  const variants = caps.variant !== false;
  if (!variants) models = models.map((m) => ({ ...m, efforts: [] }));
  let defaultModel = '';
  const d = await runCapture('opencode', ['api', 'model.default'], { timeoutMs: 30000 });
  try {
    const j = JSON.parse(d.stdout);
    const x = j && j.data !== undefined ? j.data : j;
    if (typeof x === 'string') defaultModel = x;
    else if (x && x.providerID) defaultModel = `${x.providerID}/${x.modelID || x.id || x.model}`;
  } catch {}
  return {
    models,
    efforts: [],
    effortNote: variants ? '' : tr('这个版本的 OpenCode 还不支持设置思考强度。升级后（命令行里运行 opencode upgrade）点左下角「重新检测」。'),
    defaultModel,
    defaultEffort: '',
    source: 'opencode api model.list',
    error,
  };
}

// ---------- Gemini CLI：没有列模型的命令，给出它认的几个别名；默认模型在 ~/.gemini/settings.json ----------
function geminiCatalog(home = os.homedir()) {
  const s = readJson(path.join(home, '.gemini', 'settings.json')) || {};
  const def = (s.model && typeof s.model === 'object' ? s.model.name : typeof s.model === 'string' ? s.model : '') || '';
  const models = [
    { id: 'auto', label: 'auto', note: tr('自动选择：复杂的任务用 Pro，简单的用 Flash'), efforts: [] },
    { id: 'pro', label: 'pro', note: tr('Pro 模型，适合复杂的任务'), efforts: [] },
    { id: 'flash', label: 'flash', note: tr('Flash 模型，速度更快'), efforts: [] },
    { id: 'flash-lite', label: 'flash-lite', note: tr('Flash Lite，最快也最省'), efforts: [] },
  ];
  if (def && !models.some((m) => m.id === def)) models.push({ id: def, label: def, note: tr('Gemini CLI 设置里的默认模型'), efforts: [] });
  return {
    models,
    efforts: [],
    effortNote: tr('Gemini CLI 不能在命令行里单独设置思考强度，用的是它自己的设置。'),
    defaultModel: def,
    defaultEffort: '',
    source: '~/.gemini/settings.json',
  };
}

// ---------- pi：pi --list-models 是一张表（provider  model  context  max-out  thinking  images） ----------
const PI_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

function parsePiModels(stdout) {
  const lines = String(stdout || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const head = lines.findIndex((l) => /^provider\s+model\b/i.test(l));
  if (head < 0) return [];
  return lines
    .slice(head + 1)
    .map((l) => l.split(/\s+/))
    .filter((c) => c.length >= 2 && /^[\w.@-]+$/.test(c[0]) && /^[\w.:@/-]+$/.test(c[1]))
    .map(([provider, id, , , thinking]) => ({ id: `${provider}/${id}`, label: id, note: provider, efforts: /^yes$/i.test(thinking || '') ? PI_EFFORTS : [] }));
}

async function piCatalog(home = os.homedir()) {
  const r = await runCapture('pi', ['--list-models'], { timeoutMs: 60000 });
  const models = parsePiModels(r.stdout);
  let error = '';
  if (!models.length) {
    error = /no models available|\/login/i.test(`${r.stdout}\n${r.stderr}`)
      ? tr('pi 还没有能用的模型：在命令行里运行 pi，用 /login 登录，或者设置对应的 API Key。')
      : r.error
        ? r.error.message
        : tr('读取 pi 的模型列表失败');
  }
  const s = readJson(path.join(home, '.pi', 'agent', 'settings.json')) || {};
  const defaultModel = s.defaultModel ? (s.defaultProvider && !String(s.defaultModel).includes('/') ? `${s.defaultProvider}/${s.defaultModel}` : s.defaultModel) : '';
  const level = s.defaultThinkingLevel === 'off' ? 'none' : s.defaultThinkingLevel || '';
  return { models, efforts: PI_EFFORTS, defaultModel, defaultEffort: level, source: 'pi --list-models', error };
}

// ---------- Grok Build：grok models 列出能用的模型；默认模型在 ~/.grok/config.toml 的 [models] default ----------
const GROK_EFFORTS = ['none', 'low', 'medium', 'high'];

function parseGrokModels(stdout) {
  const out = [];
  let def = '';
  for (const raw of String(stdout || '').split(/\r?\n/)) {
    const l = raw.replace(/\x1b\[[0-9;]*m/g, '').trim();
    const m = l.match(/^(?:[*>•✓-]\s*)?([A-Za-z0-9][\w.:/-]*)/);
    if (!m) continue;
    const id = m[1];
    // 只认像模型名的（带数字或连字符），跳过表头和说明文字
    if (/^(models?|name|id|available|default|current|usage|error)$/i.test(id) || !/\d|-/.test(id)) continue;
    if (out.some((x) => x.id === id)) continue;
    if (!def && /\bdefault\b|\(current\)|^\*/i.test(l)) def = id;
    out.push({ id, label: id, note: '', efforts: [] });
  }
  return { models: out, defaultModel: def };
}

function tomlSectionKey(file, section, key) {
  let txt = '';
  try {
    txt = fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
  const parts = txt.split(/^\s*\[([^\]]+)\]\s*$/m);
  for (let i = 1; i < parts.length; i += 2) {
    if (parts[i].trim() !== section) continue;
    const m = parts[i + 1].match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']*)["']`, 'm'));
    if (m) return m[1];
  }
  return '';
}

async function grokCatalog(home = os.homedir()) {
  const r = await runCapture('grok', ['models'], { timeoutMs: 45000 });
  const parsed = parseGrokModels(r.stdout);
  const conf = tomlSectionKey(path.join(process.env.GROK_HOME || path.join(home, '.grok'), 'config.toml'), 'models', 'default');
  const defaultModel = conf || parsed.defaultModel;
  const models = parsed.models;
  if (defaultModel && !models.some((m) => m.id === defaultModel)) models.unshift({ id: defaultModel, label: defaultModel, note: '', efforts: [] });
  let error = '';
  if (!models.length) error = tail(`${r.stderr}\n${r.stdout}`, 300) || (r.error ? r.error.message : tr('读取 Grok 的模型列表失败'));
  return {
    models,
    efforts: GROK_EFFORTS,
    effortNote: '',
    defaultModel,
    defaultEffort: '',
    source: 'grok models',
    error,
  };
}

// ---------- Hermes：模型在它自己的设置里选（hermes model），这里只读出默认模型 ----------
const HERMES_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

// 数据文件夹：HERMES_HOME；Windows 上安装脚本放在 %LOCALAPPDATA%\hermes，其他系统是 ~/.hermes
function hermesHome() {
  if (process.env.HERMES_HOME) return process.env.HERMES_HOME;
  const posix = path.join(os.homedir(), '.hermes');
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const win = path.join(process.env.LOCALAPPDATA, 'hermes');
    if (fs.existsSync(path.join(win, 'config.yaml')) || !fs.existsSync(posix)) return win;
  }
  return posix;
}

// config.yaml 里的 model: 可以直接写模型名，也可以是一段（default / name / model）
function hermesDefaultModel(home = hermesHome()) {
  let txt = '';
  try {
    txt = fs.readFileSync(path.join(home, 'config.yaml'), 'utf8');
  } catch {
    return '';
  }
  const lines = txt.split(/\r?\n/);
  const i = lines.findIndex((l) => /^model\s*:/.test(l));
  if (i < 0) return '';
  const unq = (s) => s.replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, '');
  const inline = unq(lines[i].replace(/^model\s*:/, ''));
  if (inline) return inline;
  for (const l of lines.slice(i + 1)) {
    if (/^\S/.test(l)) break;
    const m = l.match(/^\s+(default|name|model)\s*:\s*(.+)$/);
    if (m && unq(m[2])) return unq(m[2]);
  }
  return '';
}

function hermesCatalog() {
  const def = hermesDefaultModel();
  return {
    models: def ? [{ id: def, label: def, note: tr('Hermes 设置里的默认模型'), efforts: [] }] : [],
    efforts: HERMES_EFFORTS,
    defaultModel: def,
    defaultEffort: '',
    source: 'config.yaml',
  };
}

// DeepSeek Harness：用它自带的模型目录（deepseek-flash 是默认，deepseek-v4-pro 更强）。自己在 dsh 里接的提供商，
// 在「自己输入……」里写成「提供商/模型」。思考档位 off / low / high / max，默认 high
const DSH_EFFORTS = ['none', 'low', 'high', 'max'];
function dshCatalog() {
  return {
    models: [
      { id: 'deepseek-flash', label: 'DeepSeek-V4.1-Flash', note: 'deepseek-flash', efforts: DSH_EFFORTS },
      { id: 'deepseek-v4-pro', label: 'DeepSeek-V4-Pro', note: tr('更强，适合复杂的任务'), efforts: DSH_EFFORTS },
    ],
    efforts: DSH_EFFORTS,
    defaultModel: 'deepseek-flash',
    defaultEffort: 'high',
    source: 'dsh',
  };
}

async function catalog(adapter, force = false) {
  const hit = cache.get(adapter);
  if (!force && hit && (hit.pending || Date.now() - hit.at < TTL)) return hit.pending || hit.data;
  const pending = (async () => {
    switch (adapter) {
      case 'claude':
        return claudeCatalog(undefined, await require('./adapters/claude').probe());
      case 'codex':
        return codexCatalog();
      case 'opencode':
        return opencodeCatalog();
      case 'gemini':
        return geminiCatalog();
      case 'grok':
        return grokCatalog();
      case 'pi':
        return piCatalog();
      case 'hermes':
        return hermesCatalog();
      case 'dsh':
        return dshCatalog();
      case 'openai':
        return { models: [], efforts: API_EFFORTS, defaultModel: '', defaultEffort: '' };
      default:
        throw new Error(tr('未知的接入方式'));
    }
  })();
  cache.set(adapter, { pending });
  try {
    const data = await pending;
    // 读取失败的结果只缓存一小会儿，装好工具后很快就能重新读到
    cache.set(adapter, { at: data.error ? Date.now() - TTL + 15000 : Date.now(), data });
    return data;
  } catch (e) {
    cache.delete(adapter);
    throw e;
  }
}

// OpenAI 兼容接口的 GET /models
async function apiModels(baseUrl, apiKey) {
  const base = String(baseUrl || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/, '');
  if (!/^https?:\/\//i.test(base)) throw new Error(tr('请先填写接口地址'));
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15000);
  try {
    const res = await fetch(base + '/models', { headers: apiKey ? { authorization: 'Bearer ' + apiKey } : {}, signal: ac.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(tr('接口返回 {status}：{text}', { status: res.status, text: text.slice(0, 300) || res.statusText }));
    const j = JSON.parse(text);
    const list = Array.isArray(j) ? j : j.data || j.models || [];
    return [...new Set(list.map((m) => (typeof m === 'string' ? m : m && (m.id || m.name))).filter(Boolean))].sort();
  } catch (e) {
    if (ac.signal.aborted) throw new Error(tr('获取模型列表超时（15 秒）'));
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// 「重新检测」时清掉，让刚装好或刚升级的工具重新读模型列表
function clearCache() {
  cache.clear();
}

module.exports = {
  catalog,
  apiModels,
  clearCache,
  claudeCatalog,
  parseCodexModels,
  parseOpencodeModels,
  parseOpencodePlain,
  tomlTop,
  tomlSectionKey,
  geminiCatalog,
  parsePiModels,
  parseGrokModels,
  hermesDefaultModel,
  hermesHome,
  dshCatalog,
  CLAUDE_EFFORTS,
};

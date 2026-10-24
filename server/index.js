'use strict';
// Nightshift 服务端：本地网页 + REST 接口 + SSE 实时推送。只监听 127.0.0.1。
// 两种用法：命令行直接运行（node server/index.js --open），或由桌面程序（electron/main.js）调用 start()。
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Store, newId, autoTitle } = require('./store');
const { Orchestrator } = require('./orchestrator');
const { SideChat } = require('./side');
const { Terminals } = require('./terminal');
const { Settings } = require('./settings');
const { Usage } = require('./usage');
const i18n = require('./i18n');
const tr = i18n.t; // 给用户看的文字跟着设置里的语言（AI 看的提示词仍然是中文）
const adapters = require('./adapters');
const models = require('./models');
const skills = require('./skills');
const files = require('./files');
const { RESERVED } = require('./prompt');
const { IS_WIN } = require('./proc');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const HOST = '127.0.0.1';
const VERSION = (() => {
  try {
    return require('../package.json').version;
  } catch {
    return '';
  }
})();

// 由 start() 初始化
let DATA = '';
let DESKTOP = false;
let PORT = 0;
let store = null;
let bus = null;
let orch = null;
let side = null;
let terms = null;
let settings = null;
let usage = null;

// ---------- SSE ----------
class Bus {
  constructor() {
    this.clients = new Set();
    setInterval(() => {
      for (const c of this.clients) c.write(': ping\n\n');
    }, 25000).unref();
  }
  add(res) {
    this.clients.add(res);
    res.on('close', () => this.clients.delete(res));
  }
  send(event, data) {
    const s = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of this.clients) c.write(s);
  }
}

// ---------- 工具函数 ----------
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (msg) => new HttpError(400, msg);

const PALETTE = ['#3F6AD8', '#13897A', '#B4610C', '#B0357A', '#5B47C7', '#2F8A3B', '#0E7490', '#9A3412'];

function maskKey(k) {
  if (!k) return '';
  return k.length <= 8 ? '••••' : k.slice(0, 3) + '••••' + k.slice(-4);
}

function publicAgent(a) {
  const out = { ...a };
  if (out.api) out.api = { ...out.api, apiKey: maskKey(out.api.apiKey), hasKey: !!out.api.apiKey };
  return out;
}

function publicRoom(room) {
  const project = store.getProject(room.projectId);
  return {
    id: room.id,
    projectId: room.projectId,
    projectName: project ? project.name : '',
    name: room.name,
    autoName: !!room.autoName,
    pinned: !!room.pinned,
    workspace: room.workspace,
    settings: room.settings,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    agents: room.agents.map(publicAgent),
    sessions: Object.fromEntries(Object.keys(room.sessions || {}).map((k) => [k, true])),
    logPath: store.logPath(room),
  };
}

function roomSummary(room) {
  const msgs = store.messages(room.id);
  const last = [...msgs].reverse().find((m) => m.kind !== 'system');
  return {
    id: room.id,
    projectId: room.projectId,
    name: room.name,
    pinned: !!room.pinned,
    workspace: room.workspace,
    updatedAt: room.updatedAt,
    // 新建会话的弹窗里「照搬某个会话的成员」要显示每个成员的职责和工具
    agents: room.agents.map((a) => ({ id: a.id, name: a.name, color: a.color, role: a.role || '', adapter: a.adapter })),
    busy: orch.isBusy(room.id),
    last: last ? { name: last.from === 'user' ? tr('你') : last.name, text: String(last.text || '').slice(0, 80) } : null,
  };
}

// 项目：名字、文件夹和里面的会话（最近动过的排前面）
function projectSummary(p) {
  const rooms = store.roomsOf(p.id).map(roomSummary);
  return { id: p.id, name: p.name, workspace: p.workspace, createdAt: p.createdAt, busy: rooms.some((r) => r.busy), rooms };
}

function broadcastRooms() {
  bus.send('rooms', store.listRooms().map(roomSummary));
  bus.send('projects', store.listProjects().map(projectSummary));
}

function checkModel(m) {
  m = String(m || '').trim();
  if (m && !/^[\w.:/@#[\]+\-]{1,120}$/.test(m)) throw bad(tr('模型名称里有不支持的字符'));
  return m;
}

// API 模型的「额外请求参数」：一段 JSON 对象，原样合并进请求体
function parseExtraBody(v) {
  if (v === null || v === '') return null;
  let obj = v;
  if (typeof v === 'string') {
    try {
      obj = JSON.parse(v);
    } catch {
      throw bad(tr('额外请求参数不是有效的 JSON'));
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw bad(tr('额外请求参数要写成一个 JSON 对象，例如 {"thinking":{"type":"enabled"}}'));
  if (JSON.stringify(obj).length > 4000) throw bad(tr('额外请求参数太长了'));
  for (const k of ['messages', 'stream', 'tools']) delete obj[k];
  return obj;
}

function cleanAgent(input, room, existing) {
  const a = existing ? { ...existing } : { id: newId('a'), enabled: true, permission: 'edit' };
  if (input.name !== undefined || !existing) {
    const name = String(input.name || '').trim();
    if (!name) throw bad(tr('请给成员起个名字'));
    if (/[\s@`]/.test(name)) throw bad(tr('名字里不能有空格、@ 或反引号'));
    if ([...name].length > 16) throw bad(tr('名字最多 16 个字'));
    if (RESERVED.some((r) => r.toLowerCase() === name.toLowerCase())) throw bad(tr('「{name}」是保留词，换个名字吧', { name }));
    if (room.agents.some((x) => x.id !== a.id && x.name.toLowerCase() === name.toLowerCase())) throw bad(tr('已经有叫「{name}」的成员了', { name }));
    a.name = name;
  }
  if (input.adapter !== undefined || !existing) {
    if (!adapters.get(input.adapter)) throw bad(tr('请选择接入方式'));
    a.adapter = input.adapter;
  }
  if (input.role !== undefined) a.role = String(input.role || '').trim().slice(0, 24);
  if (input.instructions !== undefined) a.instructions = String(input.instructions || '').trim().slice(0, 4000);
  if (input.model !== undefined) a.model = checkModel(input.model);
  if (input.effort !== undefined) {
    const e = String(input.effort || '').trim();
    if (e && !/^[a-z][a-z0-9_-]{0,19}$/.test(e)) throw bad(tr('思考强度设置不正确'));
    a.effort = e;
  }
  if (input.permission !== undefined) {
    if (!['readonly', 'edit', 'full'].includes(input.permission)) throw bad(tr('权限设置不正确'));
    a.permission = input.permission;
  }
  if (input.color !== undefined) a.color = /^#[0-9a-f]{6}$/i.test(input.color) ? input.color : a.color;
  if (!a.color) a.color = PALETTE[room.agents.length % PALETTE.length];
  if (input.extraArgs !== undefined) a.extraArgs = String(input.extraArgs || '').trim().slice(0, 500);
  if (input.enabled !== undefined) a.enabled = !!input.enabled;
  if (input.api !== undefined) {
    const prev = a.api || {};
    const api = { ...prev };
    if (input.api.baseUrl !== undefined) {
      const u = String(input.api.baseUrl || '').trim();
      if (u && !/^https?:\/\/\S+$/i.test(u)) throw bad(tr('接口地址要以 http:// 或 https:// 开头'));
      api.baseUrl = u;
    }
    // 前端拿到的是打码后的 key；原样传回来就表示不修改
    if (input.api.apiKey !== undefined && input.api.apiKey !== maskKey(prev.apiKey)) api.apiKey = String(input.api.apiKey || '').trim();
    if (input.api.tools !== undefined) api.tools = !!input.api.tools;
    if (input.api.extraBody !== undefined) api.extraBody = parseExtraBody(input.api.extraBody);
    a.api = api;
  }
  if (a.adapter === 'openai' && !a.model) throw bad(tr('API 模型需要填写模型名称'));
  return a;
}

// 团队模板：根据这台电脑装了哪些 AI 工具来分配角色。职责文字按建项目时的语言现取
const ROLES = () => ({
  design: {
    role: tr('产品设计'),
    instructions:
      tr('负责把用户的想法变成清晰的产品方案：功能清单、页面结构、交互流程和视觉风格。方案写进 docs/design.md，然后交给负责开发的成员实现。开发完成后检查实现是否符合设计。一般不写业务代码。'),
  },
  dev: {
    role: tr('开发'),
    instructions:
      tr('负责根据设计方案编写和修改代码，让项目能跑起来。完成一个阶段后说明改了哪些文件、怎么运行，然后交给负责审查的成员（没有审查成员就请用户验收）。对设计有疑问直接问设计成员。'),
  },
  review: {
    role: tr('测试审查'),
    instructions:
      tr('负责审查代码和运行效果：找 bug、检查是否符合设计、提出具体的修改意见。发现问题就交给负责开发的成员修复；确认没问题后请用户验收。一般不直接改代码。'),
  },
});
const NAMES = { codex: 'GPT', claude: 'Claude', opencode: 'OpenCode', gemini: 'Gemini', grok: 'Grok', pi: 'Pi', hermes: 'Hermes', dsh: 'DeepSeek' }; // 模板只用命令行工具

function templateAgents(kind, env) {
  if (kind === 'blank') return [];
  const ROLE = ROLES();
  const has = (id) => env[id] && env[id].installed;
  const first = (...ids) => ids.find(has);
  const plan = [
    // 每个角色按顺序找这台电脑上装了的工具
    ['design', first('codex', 'gemini', 'opencode', 'grok', 'claude', 'pi', 'hermes', 'dsh')],
    ['dev', first('claude', 'codex', 'opencode', 'gemini', 'grok', 'pi', 'hermes', 'dsh')],
  ];
  if (kind === 'trio') plan.push(['review', first('opencode', 'gemini', 'grok', 'codex', 'claude', 'pi', 'hermes', 'dsh')]);
  const agents = [];
  for (const [roleKey, adapter] of plan) {
    if (!adapter) continue;
    // 同一个工具担任好几个角色时名字加编号（Claude、Claude-2）：名字里不能有空格，也最多 16 个字
    const same = agents.filter((a) => a.adapter === adapter).length;
    const name = same ? `${NAMES[adapter]}-${same + 1}` : NAMES[adapter];
    agents.push({
      id: newId('a'),
      name,
      adapter,
      model: '',
      role: ROLE[roleKey].role,
      instructions: ROLE[roleKey].instructions,
      permission: 'edit',
      color: PALETTE[agents.length % PALETTE.length],
      enabled: true,
    });
  }
  return agents;
}

function resolveWorkspace(p, create) {
  const ws = String(p || '').trim().replace(/^"|"$/g, '');
  if (!ws) throw bad(tr('请选择项目文件夹'));
  if (!path.isAbsolute(ws)) throw bad(tr('项目文件夹要写完整路径，例如 E:\\Projects\\my-app'));
  const full = path.resolve(ws);
  if (fs.existsSync(full)) {
    if (!fs.statSync(full).isDirectory()) throw bad(tr('这个路径是文件，不是文件夹'));
  } else if (create) {
    fs.mkdirSync(full, { recursive: true });
  } else {
    throw bad(tr('文件夹不存在。勾选「自动创建」或换一个路径'));
  }
  return full;
}

function openPath(p) {
  const cmd = IS_WIN ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    spawn(cmd, [p], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
  } catch {}
}

function listDir(p) {
  if (!p) {
    if (IS_WIN) {
      const drives = [];
      for (const l of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
        try {
          fs.accessSync(l + ':\\');
          drives.push(l + ':\\');
        } catch {}
      }
      return { path: '', parent: null, dirs: drives.map((d) => ({ name: d, path: d })), home: os.homedir() };
    }
    p = '/';
  }
  const full = path.resolve(p);
  let ents = [];
  try {
    ents = fs.readdirSync(full, { withFileTypes: true });
  } catch (e) {
    throw bad(tr('打不开这个文件夹：{reason}', { reason: e.code || e.message }));
  }
  const dirs = ents
    .filter((e) => {
      if (!e.isDirectory() || e.name.startsWith('$')) return false;
      return !['System Volume Information', 'node_modules', '.git'].includes(e.name);
    })
    .map((e) => ({ name: e.name, path: path.join(full, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  const parent = path.dirname(full);
  return { path: full, parent: parent === full ? (IS_WIN ? '' : null) : parent, dirs, home: os.homedir() };
}

// ---------- 路由 ----------
const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, re, keys, handler });
}

function needRoom(id) {
  const room = store.getRoom(id);
  if (!room) throw new HttpError(404, tr('会话不存在'));
  return room;
}

function needProject(id) {
  const p = store.getProject(id);
  if (!p) throw new HttpError(404, tr('项目不存在'));
  return p;
}

route('GET', '/api/env', async (req, { query }) => {
  const refresh = query.get('refresh') === '1';
  if (refresh) models.clearCache(); // 刚装好或升级的工具，模型列表也要重新读
  const env = await adapters.detectAll(refresh);
  let user = '';
  try {
    user = os.userInfo().username;
  } catch {}
  return { adapters: env, platform: process.platform, home: os.homedir(), user, host: os.hostname(), node: process.version, version: VERSION, dataDir: DATA, desktop: DESKTOP };
});

// ---------- 应用设置（你的名字、外观、语言……）和用量统计 ----------
route('GET', '/api/settings', async () => settings.get());

route('PATCH', '/api/settings', async (req, { body }) => {
  const prev = settings.get();
  const next = settings.update(body || {});
  if (next.language !== prev.language) models.clearCache(); // 模型说明是按语言生成后缓存的
  bus.send('settings', next);
  return next;
});

route('GET', '/api/usage', async () => usage.summary());

// 账户菜单里的「使用说明」：就是 README，有界面语言的版本（README.en.md 之类）就用那个
route('GET', '/api/readme', async () => {
  const lang = settings.get().language;
  for (const name of [`README.${lang}.md`, 'README.md']) {
    try {
      return { text: readmeForApp(fs.readFileSync(path.join(ROOT, name), 'utf8')) };
    } catch {}
  }
  throw new HttpError(404, tr('找不到使用说明'));
});

// README 里只给 GitHub 看的部分（图标、截图、语言链接）都写成单独一行的 HTML。
// 界面里的 Markdown 不显示 HTML 和图片，所以把这些整行去掉；代码块里的不动
function readmeForApp(text) {
  const out = [];
  let fence = false;
  for (const line of String(text).split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    else if (!fence && /^\s*(<\/?[a-z][\w-]*(\s[^>]*)?\/?>|<!--)/i.test(line)) continue;
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
}

route('POST', '/api/open-data', async () => {
  openPath(DATA);
  return { ok: true };
});

// 某种接入方式能选的模型和思考强度
route('GET', '/api/models', async (req, { query }) => {
  const adapter = query.get('adapter') || '';
  if (!adapters.get(adapter)) throw bad(tr('未知的接入方式'));
  return models.catalog(adapter, query.get('refresh') === '1');
});

// API 模型：向接口查询可用模型。key 没改动（打码状态）时用已保存的那个
route('POST', '/api/models/remote', async (req, { body }) => {
  let key = String(body.apiKey || '');
  if (body.roomId && body.agentId) {
    const room = store.getRoom(body.roomId);
    const agent = room && room.agents.find((a) => a.id === body.agentId);
    const saved = agent && agent.api && agent.api.apiKey;
    if (saved && (!key || key === maskKey(saved))) key = saved;
  }
  try {
    return { models: await models.apiModels(body.baseUrl, key) };
  } catch (e) {
    throw bad(e.message);
  }
});

// ---------- 项目：一个文件夹，里面可以有好几个会话 ----------
route('GET', '/api/projects', async () => store.listProjects().map(projectSummary));

// 新建项目：同时建好第一个会话，成员按团队模板来
async function createProject(body) {
  const name = String(body.name || '').trim().slice(0, 40);
  if (!name) throw bad(tr('请给项目起个名字'));
  const workspace = resolveWorkspace(body.workspace, !!body.create);
  const env = body.template === 'blank' ? {} : await adapters.detectAll(); // 空白团队用不着检测工具
  const project = store.createProject({ name, workspace });
  const room = store.createRoom({ projectId: project.id, name: tr('新会话'), autoName: true, agents: templateAgents(body.template || 'duo', env) });
  broadcastRooms();
  return { project, room };
}

route('POST', '/api/projects', async (req, { body }) => {
  const { project, room } = await createProject(body);
  return { project: projectSummary(project), room: publicRoom(room) };
});

// 换文件夹：项目里所有会话一起换，各成员的会话记忆都要重新开始（会话和文件夹绑在一起）
function moveProject(project, ws) {
  if (ws === project.workspace) return;
  const rooms = store.roomsOf(project.id);
  if (rooms.some((r) => orch.isBusy(r.id) || side.running(r.id))) throw bad(tr('有成员正在工作，先停止再换文件夹'));
  project.workspace = ws;
  store.saveProject(project);
  for (const room of rooms) {
    room.workspace = ws;
    room.sessions = {};
    room.lastSeen = {};
    room.sideSessions = {};
    room.sideSeen = {};
    store.saveRoom(room);
    bus.send('room', publicRoom(room));
  }
  // 终端也属于项目：开着的都还停在旧文件夹里，容易在那儿找文件、跑测试，所以关掉（界面上会写明原因），新开的在新文件夹里
  terms.killRoom(project.id, { reason: 'moved', to: ws });
}

route('PATCH', '/api/projects/:id', async (req, { params, body }) => {
  const project = needProject(params.id);
  if (body.name !== undefined) {
    const name = String(body.name || '').trim().slice(0, 40);
    if (!name) throw bad(tr('项目名称不能为空'));
    project.name = name;
    store.saveProject(project);
  }
  if (body.workspace !== undefined) moveProject(project, resolveWorkspace(body.workspace, !!body.create));
  for (const room of store.roomsOf(project.id)) bus.send('room', publicRoom(room));
  broadcastRooms();
  return projectSummary(project);
});

route('DELETE', '/api/projects/:id', async (req, { params }) => {
  const project = needProject(params.id);
  for (const room of store.roomsOf(project.id)) {
    orch.stop(room.id);
    side.stop(room.id);
  }
  terms.killRoom(project.id);
  store.deleteProject(project.id);
  broadcastRooms();
  return { ok: true };
});

// 成员配置照搬一份（新的 id，不带会话记忆），默认接收人跟着对上
function copyAgents(from) {
  const ids = {};
  const agents = from.agents.map((a) => {
    const copy = JSON.parse(JSON.stringify(a));
    copy.id = newId('a');
    ids[a.id] = copy.id;
    return copy;
  });
  const settings = { ...from.settings, defaultAgent: ids[from.settings.defaultAgent] || '' };
  return { agents, settings };
}

// 在项目里新建会话：成员默认照搬当前会话（没有就用项目里最近的一个会话），也可以指定团队模板
async function createConversation(project, body) {
  let agents;
  let settings = {};
  if (body.template) agents = templateAgents(body.template, await adapters.detectAll());
  else {
    const from = (body.from && store.getRoom(body.from)) || store.roomsOf(project.id)[0];
    if (from && from.projectId === project.id) ({ agents, settings } = copyAgents(from));
    else agents = templateAgents('duo', await adapters.detectAll());
  }
  const given = String(body.name || '').trim().slice(0, 40);
  const room = store.createRoom({ projectId: project.id, name: given || tr('新会话'), autoName: !given, agents, settings });
  broadcastRooms();
  return room;
}

// 拖动排序：body.ids 是新的先后顺序（项目的，或者某个项目里会话的）
const idList = (body) => (Array.isArray(body && body.ids) ? body.ids.map(String) : []);
route('POST', '/api/projects/order', async (req, { body }) => {
  store.reorderProjects(idList(body));
  broadcastRooms();
  return store.listProjects().map(projectSummary);
});

route('POST', '/api/projects/:id/order', async (req, { params, body }) => {
  const project = needProject(params.id);
  store.reorderRooms(project.id, idList(body));
  broadcastRooms();
  return projectSummary(project);
});

route('POST', '/api/projects/:id/rooms', async (req, { params, body }) => publicRoom(await createConversation(needProject(params.id), body || {})));

// ---------- 会话 ----------
route('GET', '/api/rooms', async () => store.listRooms().map(roomSummary));

// 旧的写法：带 projectId 时在那个项目里新建会话，不带时新建项目（连同第一个会话）
route('POST', '/api/rooms', async (req, { body }) => {
  if (body.projectId) return publicRoom(await createConversation(needProject(body.projectId), body));
  const { room } = await createProject(body);
  return publicRoom(room);
});

route('GET', '/api/rooms/:id', async (req, { params }) => {
  const room = needRoom(params.id);
  const msgs = store.messages(room.id);
  return {
    room: publicRoom(room),
    messages: msgs.slice(-400),
    total: msgs.length,
    state: orch.state(room.id),
    progress: orch.progress(room.id),
  };
});

route('PATCH', '/api/rooms/:id', async (req, { params, body }) => {
  const room = needRoom(params.id);
  if (body.name !== undefined) {
    const name = String(body.name || '').trim().slice(0, 40);
    if (!name) throw bad(tr('会话名称不能为空'));
    room.name = name;
    room.autoName = false;
  }
  // 文件夹属于项目：换了就是整个项目一起换
  if (body.workspace !== undefined) {
    const project = store.getProject(room.projectId);
    if (project) moveProject(project, resolveWorkspace(body.workspace, !!body.create));
  }
  // 置顶 / 取消置顶：都放到那一组的最上面
  if (body.pinned !== undefined && !!body.pinned !== room.pinned) {
    room.pinned = !!body.pinned;
    store.toTop(room);
  }
  if (body.settings) {
    const s = body.settings;
    if (s.maxAutoTurns !== undefined) room.settings.maxAutoTurns = Math.min(100, Math.max(1, Number(s.maxAutoTurns) || 10));
    if (s.defaultAgent !== undefined) room.settings.defaultAgent = room.agents.some((a) => a.id === s.defaultAgent) ? s.defaultAgent : '';
    if (s.acceptance !== undefined) {
      // 任务做到一半才打开：任务开始时的快照这时还在内存里，存一份下来（见 orchestrator.js 的 keepBase）
      if (s.acceptance && !room.settings.acceptance) orch.saveBase(room.id);
      room.settings.acceptance = !!s.acceptance;
    }
  }
  store.saveRoom(room);
  bus.send('room', publicRoom(room));
  broadcastRooms();
  return publicRoom(room);
});

// 删掉一个会话（终端属于项目，留着）
route('DELETE', '/api/rooms/:id', async (req, { params }) => {
  needRoom(params.id);
  orch.stop(params.id);
  side.stop(params.id);
  store.deleteRoom(params.id);
  broadcastRooms();
  return { ok: true };
});

route('POST', '/api/rooms/:id/agents', async (req, { params, body }) => {
  const room = needRoom(params.id);
  const agent = cleanAgent(body, room, null);
  room.agents.push(agent);
  store.saveRoom(room);
  bus.send('room', publicRoom(room));
  broadcastRooms();
  return publicAgent(agent);
});

route('PATCH', '/api/rooms/:id/agents/:aid', async (req, { params, body }) => {
  const room = needRoom(params.id);
  const idx = room.agents.findIndex((a) => a.id === params.aid);
  if (idx < 0) throw new HttpError(404, tr('成员不存在'));
  const prev = room.agents[idx];
  const next = cleanAgent(body, room, prev);
  if (adapters.sessionOutdated(prev, next)) {
    // 换了接入方式，或者改了 DeepSeek Harness 建会话时就定下的设置：旧会话没法续用
    delete room.sessions[prev.id];
    delete room.lastSeen[prev.id];
    delete room.sideSessions[prev.id];
    delete room.sideSeen[prev.id];
  }
  if (next.enabled === false) orch.dropAgent(room.id, prev.id);
  room.agents[idx] = next;
  store.saveRoom(room);
  bus.send('room', publicRoom(room));
  broadcastRooms();
  return publicAgent(next);
});

route('DELETE', '/api/rooms/:id/agents/:aid', async (req, { params }) => {
  const room = needRoom(params.id);
  orch.dropAgent(room.id, params.aid);
  room.agents = room.agents.filter((a) => a.id !== params.aid);
  delete room.sessions[params.aid];
  delete room.lastSeen[params.aid];
  delete room.sideSessions[params.aid];
  delete room.sideSeen[params.aid];
  if (room.settings.defaultAgent === params.aid) room.settings.defaultAgent = '';
  store.saveRoom(room);
  bus.send('room', publicRoom(room));
  broadcastRooms();
  return { ok: true };
});

route('POST', '/api/rooms/:id/agents/:aid/reset', async (req, { params }) => {
  const room = needRoom(params.id);
  delete room.sessions[params.aid];
  delete room.lastSeen[params.aid];
  store.saveRoom(room);
  bus.send('room', publicRoom(room));
  return { ok: true };
});

route('POST', '/api/rooms/:id/agents/:aid/run', async (req, { params }) => {
  needRoom(params.id);
  orch.poke(params.id, params.aid);
  return { ok: true };
});

route('POST', '/api/rooms/:id/messages', async (req, { params, body }) => {
  needRoom(params.id);
  const text = String(body.text || '').trim();
  if (!text) throw bad(tr('消息不能为空'));
  if (text.length > 50000) throw bad(tr('消息太长了（最多 5 万字）'));
  const msg = orch.postUser(params.id, text);
  // 还没起名字的会话：用第一条消息起标题
  const room = store.getRoom(params.id);
  if (room && room.autoName) {
    room.name = autoTitle(text) || room.name;
    room.autoName = false;
    store.saveRoom(room);
    bus.send('room', publicRoom(room));
  }
  broadcastRooms();
  return msg;
});

// 交付验收清单：「待你确认」的项点了通过 / 不通过，没通过的项点了「仍然通过」（verdict 为空就是取消）。
// 结果记在那条消息上，下一位成员的聊天记录里也看得到
route('POST', '/api/rooms/:id/messages/:mid/acceptance', async (req, { params, body }) => {
  needRoom(params.id);
  const verdict = ['pass', 'fail'].includes(body.verdict) ? body.verdict : '';
  const msg = store.updateMessage(params.id, params.mid, (m) => {
    const it = m.acceptance && m.acceptance.items.find((x) => x.id === body.item);
    if (!it || (it.s !== 'user' && it.s !== 'fail')) throw bad(tr('这一项不需要你确认'));
    if (verdict) it.u = verdict;
    else delete it.u;
  });
  if (!msg) throw new HttpError(404, tr('消息不存在'));
  bus.send('message-update', { roomId: params.id, message: msg });
  return msg;
});

route('POST', '/api/rooms/:id/stop', async (req, { params }) => {
  needRoom(params.id);
  orch.stop(params.id);
  return { ok: true };
});

route('POST', '/api/rooms/:id/continue', async (req, { params }) => {
  needRoom(params.id);
  orch.resume(params.id);
  return { ok: true };
});

route('POST', '/api/rooms/:id/clear', async (req, { params }) => {
  const room = needRoom(params.id);
  orch.stop(room.id);
  store.clearMessages(room.id);
  room.sessions = {};
  room.lastSeen = {};
  store.saveRoom(room);
  bus.send('cleared', { roomId: room.id });
  bus.send('room', publicRoom(room));
  broadcastRooms();
  return { ok: true };
});

route('POST', '/api/rooms/:id/open', async (req, { params }) => {
  const room = needRoom(params.id);
  if (!fs.existsSync(room.workspace)) throw bad(tr('项目文件夹不存在'));
  openPath(room.workspace);
  return { ok: true };
});

route('GET', '/api/fs', async (req, { query }) => listDir(query.get('path') || ''));

// 输入 / 时可以选的技能（项目里的 + 本机装好的）
route('GET', '/api/skills', async (req, { query }) => {
  const room = query.get('room') ? store.getRoom(query.get('room')) : null;
  return skills
    .listSkills(room ? room.workspace : '', query.get('refresh') === '1')
    .map(({ name, description, tools, scope }) => ({ name, description, tools, scope }));
});

// 打开项目里的文件：how = open（默认程序）| with（选择程序）| reveal（在文件夹中显示）
route('POST', '/api/rooms/:id/files/open', async (req, { params, body }) => {
  const room = needRoom(params.id);
  const full = files.resolveInside(room.workspace, body.path);
  if (!full) throw bad(tr('只能打开项目文件夹里的文件'));
  if (!fs.existsSync(full)) throw bad(tr('找不到这个文件，可能已经被删除或改名了'));
  const how = ['open', 'with', 'reveal'].includes(body.how) ? body.how : 'open';
  files.openFile(full, how);
  return { ok: true, path: full, revealed: how === 'open' && files.RUNNABLE.test(full) };
});

// 消息里提到的、不在任何项目文件夹里的文件：只能在文件夹中显示，不预览也不打开（免得一点就运行了什么）
route('POST', '/api/files/reveal', async (req, { body }) => {
  const full = files.absolutePath(body.path);
  if (!full) throw bad(tr('只能显示完整路径的文件'));
  if (!fs.existsSync(full)) throw bad(tr('找不到这个文件，可能已经被删除或改名了'));
  files.openFile(full, 'reveal');
  return { ok: true, path: full };
});

// ---------- 右侧面板：文件 ----------
route('GET', '/api/rooms/:id/tree', async (req, { params, query }) => {
  const room = needRoom(params.id);
  if (!fs.existsSync(room.workspace)) throw bad(tr('项目文件夹不存在'));
  let out;
  try {
    out = files.listDir(room.workspace, query.get('path') || '');
  } catch (e) {
    throw bad(e.code === 'ENOENT' ? tr('这个文件夹已经不存在了') : tr('打不开这个文件夹：{reason}', { reason: e.code || e.message }));
  }
  if (!out) throw bad(tr('只能查看项目文件夹里的内容'));
  return out;
});

route('GET', '/api/rooms/:id/find', async (req, { params, query }) => {
  const room = needRoom(params.id);
  const limit = Math.min(500, Math.max(1, Number(query.get('limit')) || 200));
  return { results: files.findFiles(room.workspace, query.get('q') || '', limit) };
});

// ---------- 右侧面板：侧边对话 ----------
route('GET', '/api/rooms/:id/side', async (req, { params }) => {
  needRoom(params.id);
  return { messages: store.sideMessages(params.id).slice(-200), running: side.running(params.id) };
});

route('POST', '/api/rooms/:id/side', async (req, { params, body }) => {
  needRoom(params.id);
  const text = String(body.text || '').trim();
  if (!text) throw bad(tr('问题不能为空'));
  if (text.length > 20000) throw bad(tr('问题太长了（最多 2 万字）'));
  try {
    return side.ask(params.id, String(body.agentId || ''), text);
  } catch (e) {
    throw bad(e.message);
  }
});

route('POST', '/api/rooms/:id/side/stop', async (req, { params }) => {
  needRoom(params.id);
  side.stop(params.id);
  return { ok: true };
});

route('POST', '/api/rooms/:id/side/clear', async (req, { params }) => {
  needRoom(params.id);
  side.clear(params.id);
  return { ok: true };
});

// ---------- 右侧面板：终端 ----------
// 终端属于项目（同一个文件夹）：项目里的会话之间切换时，终端都还在。
// room 参数可以是项目 id，也可以是会话 id（就用它所在的项目）
function termScope(id) {
  const project = store.getProject(id) || store.getProject((store.getRoom(id) || {}).projectId);
  if (!project) throw new HttpError(404, tr('项目不存在'));
  return project;
}

route('GET', '/api/term', async (req, { query }) => {
  const st = terms.available();
  const id = query.get('room');
  return { available: st.ok, error: st.error || '', terminals: id ? terms.forRoom(termScope(id).id) : [] };
});

route('POST', '/api/term', async (req, { body }) => {
  const project = termScope(String(body.roomId || ''));
  try {
    return terms.create({ roomId: project.id, cwd: project.workspace, cols: body.cols, rows: body.rows });
  } catch (e) {
    throw bad(e.message);
  }
});

route('GET', '/api/term/:tid', async (req, { params }) => terms.buffer(params.tid));

route('POST', '/api/term/:tid/input', async (req, { params, body }) => {
  terms.write(params.tid, body.data);
  return { ok: true };
});

route('POST', '/api/term/:tid/resize', async (req, { params, body }) => {
  terms.resize(params.tid, body.cols, body.rows);
  return { ok: true };
});

route('PATCH', '/api/term/:tid', async (req, { params, body }) => terms.rename(params.tid, body.title));

route('DELETE', '/api/term/:tid', async (req, { params }) => {
  terms.kill(params.tid);
  return { ok: true };
});

// ---------- 右侧面板：浏览器 ----------
// 看看本机常用的开发端口上有没有网页在跑（npm run dev 之类），方便一键打开
const DEV_PORTS = [3000, 3001, 3002, 4173, 4200, 4321, 5000, 5173, 5174, 5500, 5501, 8000, 8001, 8080, 8081, 8787, 8888, 9000];
function probePort(port, host) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(300, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}
route('GET', '/api/ports', async () => {
  const ports = DEV_PORTS.filter((p) => p !== PORT);
  const open = await Promise.all(ports.map(async (p) => (await probePort(p, '127.0.0.1')) || (await probePort(p, '::1'))));
  return { ports: ports.filter((p, i) => open[i]).map((port) => ({ port, url: `http://localhost:${port}/` })) };
});

route('GET', '/api/events', async (req, { res }) => {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.write(': hello\n\n');
  bus.add(res);
  return undefined;
});

// ---------- HTTP ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.join(PUBLIC, path.normalize(rel).replace(/^([\\/]\.\.)+/, ''));
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
}

// 预览项目里的文件：/files/<项目 id>/<相对路径>。
// 用 CSP sandbox 把它当成一个「别的网站」，网页里的脚本拿不到 Agent Chat 的身份，也就调不动接口。
const FILE_MIME = {
  ...MIME,
  '.htm': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.pdf': 'application/pdf',
};

function serveWorkspaceFile(res, pathname) {
  const m = pathname.match(/^\/files\/([^/]+)\/(.+)$/);
  const room = m && store.getRoom(m[1]);
  let full = null;
  try {
    full = room && files.resolveInside(room.workspace, decodeURIComponent(m[2]));
  } catch {}
  let st = null;
  try {
    st = full && fs.statSync(full);
  } catch {}
  if (!st || !st.isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end(tr('找不到这个文件'));
    return;
  }
  const ext = path.extname(full).toLowerCase();
  const headers = {
    'content-type': FILE_MIME[ext] || 'application/octet-stream',
    'content-length': st.size,
    'cache-control': 'no-store',
    'content-security-policy': 'sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads',
    'x-content-type-options': 'nosniff',
  };
  // PDF 由浏览器自带的阅读器显示，阅读器在沙盒里打不开；PDF 里的脚本本来就碰不到这个页面
  if (ext === '.pdf') delete headers['content-security-policy'];
  res.writeHead(200, headers);
  fs.createReadStream(full).pipe(res);
}

// 只接受本机页面发来的请求，防止别的网站借你的浏览器操控 AI
function allowed(req) {
  const host = req.headers.host || '';
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) return false;
  const origin = req.headers.origin;
  // 预览里的网页是沙盒（来源是 null），只允许它读项目文件
  if (origin === 'null' && req.method === 'GET' && req.url.startsWith('/files/')) return true;
  if (origin && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(origin)) return false;
  if (req.method !== 'GET' && req.headers['x-agent-chat'] !== '1') return false;
  return true;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) {
        reject(new HttpError(413, tr('请求太大')));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(bad(tr('请求格式不正确')));
      }
    });
    req.on('error', reject);
  });
}

// 界面在 app.js 之前载入 boot.js：设置和语言词典直接写在里面，界面一载入就是对的语言和外观
function bootScript() {
  const st = settings.get();
  const lines = [`window.__BOOT__ = ${JSON.stringify({ settings: st })};`];
  const d = i18n.dict(st.language);
  if (d) lines.push(`window.I18N.preload(${JSON.stringify(st.language)}, ${JSON.stringify(d)});`);
  lines.push(`window.I18N.setLang(${JSON.stringify(st.language)});`);
  if (st.theme === 'light' || st.theme === 'dark') lines.push(`document.documentElement.dataset.theme = ${JSON.stringify(st.theme)};`);
  return lines.join('\n') + '\n';
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (!allowed(req)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('Forbidden');
    return;
  }
  if (url.pathname === '/boot.js' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
    res.end(bootScript());
    return;
  }
  if (!url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET') return res.writeHead(405).end();
    if (url.pathname.startsWith('/files/')) return serveWorkspaceFile(res, url.pathname);
    return serveStatic(req, res, url.pathname);
  }
  const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
  if (!r) {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: tr('接口不存在') }));
    return;
  }
  try {
    const m = url.pathname.match(r.re);
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    const body = req.method === 'GET' ? {} : await readBody(req);
    const out = await r.handler(req, { params, body, query: url.searchParams, res });
    if (out === undefined) return; // SSE 自己处理
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(out));
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error(e);
    if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: e.message || tr('服务器出错了') }));
  }
}

// 端口被占用时自动往后试
function listenOn(server, port, triesLeft) {
  return new Promise((resolve, reject) => {
    const onError = (e) => {
      server.off('listening', onListening);
      if (e.code === 'EADDRINUSE' && triesLeft > 0) resolve(listenOn(server, port + 1, triesLeft - 1));
      else reject(e);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server.address().port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, HOST);
  });
}

// 启动服务。桌面程序和命令行都走这里；一个进程只启动一次。
async function start({ dataDir, port = 3210, desktop = false } = {}) {
  if (store) throw new Error(tr('服务已经启动'));
  DATA = path.resolve(dataDir || path.join(ROOT, 'data'));
  DESKTOP = !!desktop;
  store = new Store(DATA);
  bus = new Bus();
  settings = new Settings(DATA);
  i18n.bind(() => settings.get().language); // 服务端的报错、系统消息跟着设置里的语言
  usage = new Usage(DATA);
  orch = new Orchestrator(store, bus, usage);
  side = new SideChat(store, bus, usage);
  terms = new Terminals(bus);
  const server = http.createServer(handle);
  const actual = await listenOn(server, port, 10);
  PORT = actual;
  const url = `http://${HOST}:${actual}`;
  return {
    url,
    port: actual,
    dataDir: DATA,
    busy: () => orch.anyBusy() || side.anyBusy(),
    // 停掉所有成员并关闭服务（SSE 是长连接，要主动断开）
    close: () =>
      new Promise((resolve) => {
        orch.stopAll();
        side.stopAll();
        terms.killAll();
        server.close(() => resolve());
        if (server.closeAllConnections) server.closeAllConnections();
        setTimeout(resolve, 1500);
      }),
  };
}

module.exports = { start, readmeForApp };

// ---------- 命令行入口 ----------
if (require.main === module) {
  const argv = process.argv.slice(2);
  const argVal = (k) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  start({
    dataDir: argVal('--data') || process.env.AGENT_CHAT_DATA,
    port: Number(argVal('--port') || process.env.PORT || 3210),
  }).then(
    (srv) => {
      console.log('');
      console.log(tr('  {app} 已启动 →  ', { app: 'Nightshift' }) + srv.url);
      console.log(tr('  数据保存在          ') + srv.dataDir);
      console.log(tr('  关闭这个窗口即可退出。'));
      console.log('');
      if (argv.includes('--open')) openPath(srv.url);
      adapters.detectAll().then((env) => {
        const line = Object.values(env)
          .filter((a) => a.cli)
          .map((a) => `${a.label} ${a.installed ? '✓ ' + (a.version || '') : tr('✗ 未安装')}`)
          .join('   ');
        console.log('  ' + line);
      });
      const shutdown = () => srv.close().then(() => process.exit(0));
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    },
    (e) => {
      console.error(tr('启动失败：'), e.message);
      process.exit(1);
    }
  );
}

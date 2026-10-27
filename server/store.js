'use strict';
// 本地存储：
//   data/projects/<项目 id>/project.json  项目：名字和文件夹。一个项目里可以有好几个会话，共用这个文件夹
//   data/rooms/<会话 id>/room.json        会话：成员配置、各成员的会话记忆；messages.jsonl 存聊天记录；
//                                         baseline.json 是打开了交付验收清单时，任务开始时的文件快照
//   data/chats/<文件夹>/                  不属于哪个项目的会话（左边栏「新建会话」）的文件夹，Nightshift 自己建的。
//                                         这种会话也存成一个项目（standalone: true），里面只有它一个会话，界面上不显示项目这一层
// 另外在项目文件夹里给每个会话写一份 .agentchat/chat-<会话 id>.md，方便 AI 回顾更早的讨论，也方便人看。
// （代码里的 room 就是会话，早期版本一个项目只有一个会话，所以叫 room。）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promptText } = require('./acceptance');

const newId = (p) => p + '_' + crypto.randomBytes(5).toString('hex');
const IS_WIN = process.platform === 'win32';
// 比较文件夹路径用：Windows 不分大小写，末尾的斜杠不算
const pathKey = (p) => {
  const s = String(p || '').replace(/[\\/]+$/, '');
  return IS_WIN ? s.toLowerCase() : s;
};

// 用第一条消息给会话起标题（和 Codex 一样）：只取第一行，去掉开头的 @成员 和 /技能，最多 24 个字
function autoTitle(text) {
  const line =
    String(text || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) || '';
  const s = line
    .replace(/[*_`#>~]/g, '')
    .replace(/^(?:[@/][^\s@/]+\s+)+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = [...s];
  return chars.length > 24 ? chars.slice(0, 24).join('') + '…' : s;
}

// 左边栏的顺序是手动排的（拖动）：项目和会话都有 order，小的在前；项目里置顶的会话排在最前面
const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0);
const byPinThenOrder = (a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || byOrder(a, b);
// 按给的 id 顺序排；没列出来的（比如拖动时别处刚新建的）接在后面，保持原来的先后
function arrange(list, ids) {
  const pos = new Map((Array.isArray(ids) ? ids : []).map((id, i) => [String(id), i]));
  const listed = list.filter((x) => pos.has(x.id)).sort((a, b) => pos.get(a.id) - pos.get(b.id));
  return [...listed, ...list.filter((x) => !pos.has(x.id))];
}

function normalizeRoom(r) {
  r.autoName = !!r.autoName; // 还没起名字：发第一条消息时自动用它起标题
  r.pinned = !!r.pinned; // 置顶：在项目里排在最前面
  r.agents = Array.isArray(r.agents) ? r.agents : [];
  r.sessions = r.sessions || {};
  r.lastSeen = r.lastSeen || {};
  r.sideSessions = r.sideSessions || {}; // 侧边对话用的会话，和群聊里的分开
  r.sideSeen = r.sideSeen || {}; // 每个成员上次在侧边对话里回答时，群聊和侧边对话各到了哪一条
  // 每个成员最近一轮结束时上下文用了多少（右侧面板的「上下文」，见 orchestrator.js 的 noteContext）；换了会话就删掉
  r.context = r.context && typeof r.context === 'object' ? r.context : {};
  // acceptance：交付验收清单（见 acceptance.js），默认关。
  // approval：成员 @用户 时怎么办（manual 人工审查 / auto 自动执行 / full 全权代理，见 prompt.js 的 approvalMode）；
  // reviewer：自动执行时的审查模型，是某个成员的 id，或者 'own'（专门接入的那个，存在 r.reviewer）
  r.settings = { maxAutoTurns: 10, defaultAgent: '', acceptance: false, approval: 'manual', reviewer: '', ...(r.settings || {}) };
  r.reviewer = r.reviewer || null;
  r.seq = r.seq || 0;
  return r;
}

function writeAtomic(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

class Store {
  constructor(dir) {
    this.roomsDir = path.join(dir, 'rooms');
    this.projectsDir = path.join(dir, 'projects');
    fs.mkdirSync(this.roomsDir, { recursive: true });
    fs.mkdirSync(this.projectsDir, { recursive: true });
    this.projects = new Map();
    this.rooms = new Map();
    this.msgs = new Map();
    this.side = new Map();
    for (const d of fs.readdirSync(this.projectsDir)) {
      const f = path.join(this.projectsDir, d, 'project.json');
      try {
        const p = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (p && p.id) this.projects.set(p.id, p);
      } catch (e) {
        if (fs.existsSync(f)) console.warn(`[store] 跳过无法读取的项目 ${d}：${e.message}`);
      }
    }
    for (const d of fs.readdirSync(this.roomsDir)) {
      const f = path.join(this.roomsDir, d, 'room.json');
      try {
        const r = normalizeRoom(JSON.parse(fs.readFileSync(f, 'utf8')));
        this.rooms.set(r.id, r);
      } catch (e) {
        if (fs.existsSync(f)) console.warn(`[store] 跳过无法读取的会话 ${d}：${e.message}`);
      }
    }
    this.migrate();
    this.ensureOrder();
  }

  // 还没排过顺序的（旧版本的数据、刚升级上来的项目）：按原来的「最近动过的在前」编一次号，记下来，
  // 这样升级以后左边栏的顺序和以前看到的一样
  ensureOrder() {
    const roomsIn = (pid) => [...this.rooms.values()].filter((r) => r.projectId === pid);
    const pending = (list, at) => {
      if (list.every((x) => typeof x.order === 'number')) return null;
      const fresh = list.filter((x) => typeof x.order !== 'number').sort((a, b) => at(b) - at(a));
      return [...fresh, ...list.filter((x) => typeof x.order === 'number').sort(byOrder)];
    };
    const projectAt = (p) => Math.max(p.updatedAt || 0, ...roomsIn(p.id).map((r) => r.updatedAt || 0));
    const projects = pending([...this.projects.values()], projectAt);
    if (projects) this.number(projects, (p) => this.saveProject(p));
    for (const p of this.projects.values()) {
      const rooms = pending(roomsIn(p.id), (r) => r.updatedAt || 0);
      if (rooms) this.number(rooms, (r) => this.saveRoom(r));
    }
  }

  // 按列表的先后重新编号 0、1、2……，只保存变了的
  number(list, save) {
    list.forEach((x, i) => {
      if (x.order === i) return;
      x.order = i;
      save(x);
    });
  }

  // 拖动排序以后：项目的新顺序，或者某个项目里会话的新顺序（置顶的照样排在前面）
  reorderProjects(ids) {
    this.number(arrange(this.listProjects(), ids), (p) => this.saveProject(p));
  }

  reorderRooms(projectId, ids) {
    this.number(arrange(this.roomsOf(projectId), ids), (r) => this.saveRoom(r));
  }

  // 放到项目里会话列表的最上面（新建、置顶、取消置顶时）。置顶的总在前面，所以取消置顶后排在没置顶的第一个。
  // 不属于项目的会话一个占一个项目，左边栏里排的是项目的先后，所以把项目挪到最上面
  toTop(room) {
    const others = this.roomsOf(room.projectId).filter((r) => r.id !== room.id);
    room.order = others.length ? Math.min(...others.map((r) => r.order ?? 0)) - 1 : 0;
    const p = this.getProject(room.projectId);
    if (p && p.standalone) {
      p.order = Math.min(...[...this.projects.values()].map((x) => x.order ?? 0)) - 1;
      this.saveProject(p);
    }
  }

  // 旧版本里一个项目就是一个会话：按文件夹把它们放进项目里，同一个文件夹的放进同一个项目。
  // 只有一个时，原来的名字给项目用，会话用第一条消息起标题；
  // 几个合在一起时，项目用文件夹名，原来的名字（你起的）留给各自的会话
  migrate() {
    const orphans = [...this.rooms.values()]
      .filter((r) => !r.projectId || !this.projects.has(r.projectId))
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    const groups = new Map();
    for (const r of orphans) {
      const k = pathKey(r.workspace);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    for (const list of groups.values()) {
      const first = list[0];
      const project =
        this.projectFor(first.workspace) ||
        this.createProject(
          {
            name: list.length === 1 ? first.name : path.basename(String(first.workspace || '')) || first.name,
            workspace: first.workspace,
            createdAt: first.createdAt,
            // 记成里面的会话最近动过的时候，不用现在的时间，ensureOrder 才排得出原来的先后
            updatedAt: Math.max(...list.map((r) => r.updatedAt || 0)),
          },
          { top: false } // 先不编号，等 ensureOrder 按最近动过的先后统一排
        );
      for (const r of list) {
        r.projectId = project.id;
        r.workspace = project.workspace;
        if (r.name === project.name) {
          const firstMsg = this.messages(r.id).find((m) => m.kind === 'user');
          const title = firstMsg ? autoTitle(firstMsg.text) : '';
          if (title) r.name = title;
        }
        this.saveRoom(r);
      }
    }
  }

  // ---------- 项目 ----------
  projectDir(id) {
    return path.join(this.projectsDir, id);
  }

  // 按左边栏里排好的顺序（拖动排序；新建的项目在最上面）
  listProjects() {
    return [...this.projects.values()].sort(byOrder);
  }

  getProject(id) {
    return this.projects.get(id) || null;
  }

  projectFor(workspace) {
    const k = pathKey(workspace);
    return [...this.projects.values()].find((p) => pathKey(p.workspace) === k) || null;
  }

  // 项目里的会话：置顶的在前，其余按排好的顺序
  roomsOf(projectId) {
    return [...this.rooms.values()].filter((r) => r.projectId === projectId).sort(byPinThenOrder);
  }

  createProject({ name, workspace, createdAt, updatedAt, standalone }, { top = true } = {}) {
    const now = Date.now();
    const p = { id: newId('p'), name: String(name || '') || path.basename(String(workspace || '')), workspace, createdAt: createdAt || now, updatedAt: updatedAt || now };
    if (standalone) p.standalone = true;
    if (top) p.order = this.projects.size ? Math.min(...[...this.projects.values()].map((x) => x.order ?? 0)) - 1 : 0;
    this.projects.set(p.id, p);
    this.saveProject(p);
    return p;
  }

  saveProject(p) {
    fs.mkdirSync(this.projectDir(p.id), { recursive: true });
    writeAtomic(path.join(this.projectDir(p.id), 'project.json'), JSON.stringify(p, null, 2));
  }

  // 删掉项目和它里面所有的会话记录（项目文件夹里的文件不动）
  deleteProject(id) {
    for (const r of this.roomsOf(id)) this.deleteRoom(r.id);
    this.projects.delete(id);
    fs.rmSync(this.projectDir(id), { recursive: true, force: true });
  }

  // ---------- 会话 ----------
  dir(id) {
    return path.join(this.roomsDir, id);
  }

  listRooms() {
    return [...this.rooms.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  getRoom(id) {
    return this.rooms.get(id) || null;
  }

  // 只给了文件夹（旧的写法）时，放进用这个文件夹的项目里，没有就新建一个
  createRoom({ name, workspace, agents = [], settings = {}, projectId, autoName = false, reviewer = null }) {
    let project = projectId ? this.getProject(projectId) : null;
    if (!project) project = this.projectFor(workspace) || this.createProject({ name, workspace });
    const now = Date.now();
    const room = normalizeRoom({
      id: newId('r'),
      projectId: project.id,
      name,
      workspace: project.workspace,
      agents,
      settings,
      reviewer,
      autoName,
      createdAt: now,
      updatedAt: now,
    });
    this.toTop(room); // 新会话放在项目里没置顶的会话的最上面
    fs.mkdirSync(this.dir(room.id), { recursive: true });
    this.rooms.set(room.id, room);
    this.msgs.set(room.id, []);
    this.saveRoom(room);
    return room;
  }

  saveRoom(room) {
    fs.mkdirSync(this.dir(room.id), { recursive: true });
    writeAtomic(path.join(this.dir(room.id), 'room.json'), JSON.stringify(room, null, 2));
  }

  deleteRoom(id) {
    this.rooms.delete(id);
    this.msgs.delete(id);
    this.side.delete(id);
    fs.rmSync(this.dir(id), { recursive: true, force: true });
  }

  messages(id) {
    if (this.msgs.has(id)) return this.msgs.get(id);
    const list = [];
    const f = path.join(this.dir(id), 'messages.jsonl');
    if (fs.existsSync(f)) {
      for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          list.push(JSON.parse(line));
        } catch {}
      }
    }
    this.msgs.set(id, list);
    return list;
  }

  addMessage(roomId, data) {
    const room = this.getRoom(roomId);
    if (!room) throw new Error('会话不存在');
    const list = this.messages(roomId);
    room.seq += 1;
    const msg = { id: newId('m'), seq: room.seq, ts: Date.now(), ...data };
    list.push(msg);
    fs.appendFileSync(path.join(this.dir(roomId), 'messages.jsonl'), JSON.stringify(msg) + '\n', 'utf8');
    room.updatedAt = msg.ts;
    this.saveRoom(room);
    if (msg.kind !== 'system') this.mirror(room, msg);
    return msg;
  }

  // 改一条已有的消息（比如用户在交付验收清单上点了「通过」）：fn 改好以后整份 messages.jsonl 重写一遍
  updateMessage(roomId, id, fn) {
    const list = this.messages(roomId);
    const msg = list.find((m) => m.id === id);
    if (!msg) return null;
    fn(msg);
    writeAtomic(path.join(this.dir(roomId), 'messages.jsonl'), list.map((m) => JSON.stringify(m) + '\n').join(''));
    return msg;
  }

  clearMessages(roomId) {
    this.msgs.set(roomId, []);
    fs.writeFileSync(path.join(this.dir(roomId), 'messages.jsonl'), '', 'utf8');
    fs.rmSync(path.join(this.dir(roomId), 'baseline.json'), { force: true });
    const room = this.getRoom(roomId);
    if (room) {
      try {
        fs.rmSync(this.logPath(room), { force: true });
      } catch {}
    }
  }

  // ---------- 任务开始时项目文件夹的快照（交付验收清单用，见 orchestrator.js 的 keepBase） ----------
  // 存下来是为了中途重启 Nightshift 以后，交付时还能核对原有文件有没有被删除或覆盖
  saveBaseline(roomId, b) {
    const data = { seq: b.seq, at: b.at, ws: b.ws, truncated: !!b.snap.truncated, files: [...b.snap.map].map(([p, v]) => [p, v.m, v.s]) };
    try {
      fs.mkdirSync(this.dir(roomId), { recursive: true });
      writeAtomic(path.join(this.dir(roomId), 'baseline.json'), JSON.stringify(data));
    } catch {}
  }

  loadBaseline(roomId) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(this.dir(roomId), 'baseline.json'), 'utf8'));
      return { seq: d.seq, at: d.at, ws: d.ws, snap: { map: new Map(d.files.map(([p, m, s]) => [p, { m, s }])), truncated: !!d.truncated } };
    } catch {
      return null;
    }
  }

  // ---------- 侧边对话：单独存在 side.jsonl，不进群聊记录，也不写进项目里的聊天记录文件 ----------
  sideMessages(id) {
    if (this.side.has(id)) return this.side.get(id);
    const list = [];
    const f = path.join(this.dir(id), 'side.jsonl');
    if (fs.existsSync(f)) {
      for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          list.push(JSON.parse(line));
        } catch {}
      }
    }
    this.side.set(id, list);
    return list;
  }

  addSide(roomId, data) {
    if (!this.getRoom(roomId)) throw new Error('会话不存在');
    const list = this.sideMessages(roomId);
    const n = (list.length ? list[list.length - 1].n || list.length : 0) + 1;
    const msg = { id: newId('s'), n, ts: Date.now(), ...data };
    list.push(msg);
    fs.mkdirSync(this.dir(roomId), { recursive: true });
    fs.appendFileSync(path.join(this.dir(roomId), 'side.jsonl'), JSON.stringify(msg) + '\n', 'utf8');
    return msg;
  }

  clearSide(roomId) {
    this.side.set(roomId, []);
    try {
      fs.writeFileSync(path.join(this.dir(roomId), 'side.jsonl'), '', 'utf8');
    } catch {}
  }

  logPath(room) {
    return room.workspace ? path.join(room.workspace, '.agentchat', `chat-${room.id}.md`) : '';
  }

  mirror(room, msg) {
    if (!room.workspace || !fs.existsSync(room.workspace)) return;
    try {
      const dir = path.join(room.workspace, '.agentchat');
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        // 让 git 忽略这个文件夹，不污染项目
        fs.writeFileSync(path.join(dir, '.gitignore'), '*\n', 'utf8');
      }
      const when = new Date(msg.ts).toLocaleString('zh-CN', { hour12: false });
      const who = msg.from === 'user' ? '用户' : msg.name + (msg.role ? `（${msg.role}）` : '');
      let note = msg.status === 'error' ? `\n\n> 运行出错：${String(msg.error || '').slice(0, 500)}` : msg.status === 'stopped' ? '\n\n> 被用户中止' : '';
      if (Array.isArray(msg.attachments) && msg.attachments.length) note += `\n\n> 附件：${msg.attachments.map((a) => a.path + (a.kind === 'dir' ? '（文件夹）' : '')).join('、')}`;
      if (msg.acceptance) note += '\n\n' + promptText(msg.acceptance).replace(/^/gm, '> ');
      fs.appendFileSync(this.logPath(room), `\n## #${msg.seq} ${who}　${when}\n\n${msg.text || ''}${note}\n`, 'utf8');
    } catch {}
  }
}

module.exports = { Store, newId, autoTitle, pathKey };

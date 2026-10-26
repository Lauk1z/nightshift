'use strict';
// 项目文件：
// - 每轮开始前后各拍一张「快照」（路径、修改时间、大小），对比出这一轮新建、修改、删除了哪些文件，
//   显示成消息底部的文件卡片。不管 AI 是用编辑工具还是用命令写的文件，都能对出来。
// - 打开文件：默认程序、「打开方式」选择程序、在文件夹中显示。
// - 附件：拖进输入框、或者点「+」添加的文件和文件夹（见 attach）。
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { t: tr } = require('./i18n');

const IS_WIN = process.platform === 'win32';
// 依赖和构建产物文件太多，变化也不是 AI「交付」的东西，不进快照；以 . 开头的文件夹（.git、.agentchat 等）也跳过
const SKIP = new Set(['node_modules', 'dist', 'build', 'out', 'target', 'coverage', '__pycache__', 'venv', 'bower_components']);
const LIMIT = 20000;

function snapshot(root) {
  const map = new Map();
  let truncated = false;
  const walk = (dir, depth) => {
    if (depth > 12 || truncated) return;
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (map.size >= LIMIT) {
        truncated = true;
        return;
      }
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!e.name.startsWith('.') && !SKIP.has(e.name)) walk(full, depth + 1);
      } else if (e.isFile()) {
        try {
          const st = fs.statSync(full);
          map.set(full, { m: st.mtimeMs, s: st.size });
        } catch {}
      }
    }
  };
  if (root && fs.existsSync(root)) walk(root, 0);
  return { map, truncated };
}

const rel = (root, p) => path.relative(root, p).replace(/\\/g, '/');

function diff(before, after, root) {
  const out = [];
  for (const [p, a] of after.map) {
    const b = before.map.get(p);
    if (!b) out.push({ path: rel(root, p), change: 'add', size: a.s });
    else if (b.m !== a.m || b.s !== a.s) out.push({ path: rel(root, p), change: 'update', size: a.s });
  }
  // 文件太多被截断时，没法判断是不是真的删了
  if (!before.truncated && !after.truncated) {
    for (const p of before.map.keys()) if (!after.map.has(p)) out.push({ path: rel(root, p), change: 'delete' });
  }
  const order = { add: 0, update: 1, delete: 2 };
  return out.sort((x, y) => order[x.change] - order[y.change] || x.path.localeCompare(y.path)).slice(0, 60);
}

// 界面传来的路径（相对路径、绝对路径、AI 写的 /E:/x/y.html、file:// 链接、带 :行号 的）先清理成普通路径
function cleanPath(p) {
  let s = String(p || '').trim().replace(/^<|>$/g, '');
  s = s.replace(/^file:\/\/\/?/i, '');
  try {
    s = decodeURIComponent(s);
  } catch {}
  s = s.replace(/^\/([A-Za-z]:[\\/])/, '$1');
  return s.replace(/#.*$/, '').replace(/:\d+(?::\d+)?$/, '');
}

// 本机上的完整路径（不管在不在项目文件夹里）；相对路径不认，返回 null
function absolutePath(p) {
  const s = cleanPath(p);
  return s && path.isAbsolute(s) ? path.resolve(s) : null;
}

// 解析成项目里的真实路径。跑出项目文件夹的一律返回 null。
function resolveInside(root, p) {
  const s = cleanPath(p);
  if (!s) return null;
  const base = path.resolve(root);
  const full = path.resolve(base, s);
  const a = IS_WIN ? full.toLowerCase() : full;
  const b = IS_WIN ? base.toLowerCase() : base;
  if (a !== b && !a.startsWith(b.endsWith(path.sep) ? b : b + path.sep)) return null;
  return full;
}

// ---------- 文件面板 ----------
// 列出项目里某个文件夹的内容：只读一层，界面展开文件夹时再读下一层。
// node_modules、.git 这类照样列出来，只是标成 heavy，界面上默认不展开、搜索时也不进去。
const HEAVY = new Set([...SKIP, '.git']);
const MAX_ENTRIES = 3000;

function listDir(root, relDir) {
  const full = relDir ? resolveInside(root, relDir) : path.resolve(root);
  if (!full) return null;
  const ents = fs.readdirSync(full, { withFileTypes: true });
  const out = [];
  for (const e of ents.slice(0, MAX_ENTRIES)) {
    const p = path.join(full, e.name);
    let dir = e.isDirectory();
    if (e.isSymbolicLink()) {
      try {
        dir = fs.statSync(p).isDirectory();
      } catch {
        continue; // 指向不存在的地方
      }
    } else if (!dir && !e.isFile()) continue;
    const item = { name: e.name, dir };
    if (dir) {
      if (HEAVY.has(e.name)) item.heavy = true;
    } else {
      try {
        const st = fs.statSync(p);
        item.size = st.size;
        item.mtime = Math.round(st.mtimeMs);
      } catch {}
    }
    out.push(item);
  }
  out.sort((a, b) => b.dir - a.dir || a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' }));
  return { path: rel(path.resolve(root), full), entries: out, truncated: ents.length > MAX_ENTRIES };
}

// 按文件名搜索（输入里带 / 时按相对路径搜），跳过依赖、构建产物和 . 开头的文件夹
function findFiles(root, q, limit = 200) {
  const needle = String(q || '').trim().toLowerCase().replace(/\\/g, '/');
  if (!needle) return [];
  const base = path.resolve(root);
  const byPath = needle.includes('/');
  const out = [];
  let seen = 0;
  const walk = (dir, depth) => {
    if (depth > 14) return;
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (out.length >= limit || ++seen > 60000) return;
      const full = path.join(dir, e.name);
      const isDir = e.isDirectory();
      if (isDir && (HEAVY.has(e.name) || e.name.startsWith('.'))) continue;
      if (!isDir && !e.isFile()) continue;
      const r = rel(base, full);
      if ((byPath ? r.toLowerCase() : e.name.toLowerCase()).includes(needle)) out.push({ path: r, dir: isDir });
      if (isDir) walk(full, depth + 1);
    }
  };
  if (fs.existsSync(base)) walk(base, 0);
  return out;
}

// 双击会直接运行的文件：「打开」时改成在文件夹中显示，免得误点就执行了 AI 写的程序
// ---------- 附件：拖进输入框、或者点「+」添加的文件和文件夹 ----------
// 项目文件夹里的直接用它的相对路径；项目外的复制一份到 .agentchat/attachments/<这一批>/ 里：所有成员都能按相对路径读到，
// 不会进 git（.agentchat 里有 .gitignore），也不算成员改的文件（. 开头的文件夹不进快照）。
// 复制文件夹时跳过依赖和 .git；太大的不复制，让用户先把需要的部分放进项目文件夹
const ATTACH_DIR = '.agentchat/attachments';
const ATTACH_SKIP = new Set(['node_modules', '.git', '__pycache__', 'venv', '.venv']);
const ATTACH_MAX_BYTES = 200 * 1024 * 1024;
const ATTACH_MAX_FILES = 5000;

// .agentchat 是 Nightshift 自己的文件夹，第一次建的时候放一个 .gitignore（聊天记录文件也在这里，见 store.js 的 mirror）
function appDir(root) {
  const dir = path.join(root, '.agentchat');
  fs.mkdirSync(dir, { recursive: true });
  const ignore = path.join(dir, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n', 'utf8');
  return dir;
}

// 这一批附件的文件夹，按添加的时间起名（20261026-143205），同一秒里添加了好几次就加 -2、-3
function newBatch(root) {
  appDir(root);
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  const parent = path.join(root, ATTACH_DIR);
  let name = stamp;
  for (let i = 2; fs.existsSync(path.join(parent, name)); i++) name = `${stamp}-${i}`;
  fs.mkdirSync(path.join(parent, name), { recursive: true });
  return name;
}

// 数一下要复制多少：超过上限返回 null。不跟着符号链接走，免得绕出去或者绕成圈
function measure(src, acc = { files: 0, bytes: 0 }) {
  const st = fs.lstatSync(src);
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      if (e.isSymbolicLink() || (e.isDirectory() && ATTACH_SKIP.has(e.name))) continue;
      if (!measure(path.join(src, e.name), acc)) return null;
    }
  } else if (st.isFile()) {
    acc.files += 1;
    acc.bytes += st.size;
  }
  return acc.files > ATTACH_MAX_FILES || acc.bytes > ATTACH_MAX_BYTES ? null : acc;
}

function copyInto(src, dest) {
  if (!fs.statSync(src).isDirectory()) return fs.copyFileSync(src, dest);
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.isSymbolicLink() || (e.isDirectory() && ATTACH_SKIP.has(e.name))) continue;
    if (e.isDirectory() || e.isFile()) copyInto(path.join(src, e.name), path.join(dest, e.name));
  }
}

// 同一批里重名的，后面的加 (2)、(3)
function freeName(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let n = name;
  for (let i = 2; fs.existsSync(path.join(dir, n)); i++) n = `${stem} (${i})${ext}`;
  return n;
}

// 桌面版：按文件在电脑上的完整路径添加。先全部检查一遍，有一个不行就都不复制
function attach(root, paths) {
  const base = path.resolve(root);
  const plan = paths.map((p) => {
    const full = absolutePath(p);
    let st = null;
    try {
      st = full && fs.statSync(full);
    } catch {}
    const name = (full && path.basename(full)) || String(p);
    if (!st || (!st.isFile() && !st.isDirectory())) throw new Error(tr('找不到「{name}」，可能已经被移动或删除了', { name }));
    const dir = st.isDirectory();
    const inside = resolveInside(base, full);
    if (inside === base) throw new Error(tr('不用添加项目文件夹本身，成员本来就在里面工作'));
    if (inside) return { full, name, dir, size: dir ? undefined : st.size };
    if (dir && resolveInside(full, base)) throw new Error(tr('「{name}」里面包含了项目文件夹，不能整个添加', { name }));
    const m = measure(full);
    if (!m) throw new Error(tr('「{name}」太大了（超过 {mb} MB 或 {n} 个文件）。可以先把需要的部分放进项目文件夹，再添加', { name, mb: ATTACH_MAX_BYTES / 1024 / 1024, n: ATTACH_MAX_FILES }));
    return { full, name, dir, copy: m };
  });
  let target = '';
  return plan.map((x) => {
    if (!x.copy) return { path: rel(base, x.full), name: x.name, kind: x.dir ? 'dir' : 'file', ...(x.dir ? {} : { size: x.size }) };
    if (!target) target = path.join(base, ATTACH_DIR, newBatch(base));
    const dest = path.join(target, freeName(target, x.name));
    copyInto(x.full, dest);
    return { path: rel(base, dest), name: path.basename(dest), kind: x.dir ? 'dir' : 'file', size: x.copy.bytes, ...(x.dir ? { count: x.copy.files } : {}), from: x.full };
  });
}

// 浏览器里拖进来的（拿不到文件在电脑上的位置）：内容传上来，写到这一批的文件夹里。
// relPath 是批次文件夹里的相对路径（整个文件夹拖进来时，里面的文件带着子路径）
function uploadTarget(root, batch, relPath) {
  if (!/^[\w-]{1,40}$/.test(String(batch || ''))) return null;
  const parts = String(relPath || '').split(/[\\/]+/).filter(Boolean);
  if (!parts.length || parts.some((x) => x === '.' || x === '..')) return null;
  return resolveInside(path.join(path.resolve(root), ATTACH_DIR, batch), parts.join('/'));
}

// 发出去之前去掉了的附件：删掉复制过来的那份（只删 .agentchat/attachments 里面的），这一批空了把文件夹也删掉
function removeAttachment(root, relPath) {
  const box = path.join(path.resolve(root), ATTACH_DIR);
  const full = resolveInside(root, String(relPath || ''));
  if (!full || full === box || !resolveInside(box, full)) return false;
  fs.rmSync(full, { recursive: true, force: true });
  const batch = path.dirname(full);
  try {
    if (batch !== box && !fs.readdirSync(batch).length) fs.rmdirSync(batch);
  } catch {}
  return true;
}

// 消息里带的附件：只认项目文件夹里还在的（项目外的已经复制进来了），最多 50 个
function checkAttachments(root, list) {
  if (!Array.isArray(list)) return [];
  const base = path.resolve(root);
  return list.slice(0, 50).map((a) => {
    const full = a && resolveInside(base, String(a.path || ''));
    let st = null;
    try {
      st = full && full !== base && fs.statSync(full);
    } catch {}
    if (!st) throw new Error(tr('找不到附件「{name}」，去掉它再发', { name: String((a && (a.name || a.path)) || '') }));
    const dir = st.isDirectory();
    const item = { path: rel(base, full), name: String(a.name || path.basename(full)).slice(0, 200), kind: dir ? 'dir' : 'file' };
    if (!dir) item.size = st.size;
    else {
      if (Number.isFinite(a.size)) item.size = a.size;
      if (Number.isFinite(a.count)) item.count = a.count;
    }
    if (a.from) item.from = String(a.from).slice(0, 1000);
    return item;
  });
}

const RUNNABLE = /\.(exe|msi|bat|cmd|com|ps1|vbs|vbe|js|jse|wsf|wsh|scr|lnk|reg|hta|cpl|jar|sh)$/i;

function detach(cmd, args, opts = {}) {
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false, ...opts }).unref();
  } catch {}
}

function reveal(full) {
  if (IS_WIN) detach('explorer.exe', [`/select,"${full}"`], { windowsVerbatimArguments: true });
  else if (process.platform === 'darwin') detach('open', ['-R', full]);
  else detach('xdg-open', [path.dirname(full)]);
}

function openFile(full, how) {
  if (how === 'reveal') return reveal(full);
  if (how === 'with') {
    // Windows 自带的「你要如何打开这个文件？」选择框
    if (IS_WIN) {
      const openWith = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenWith.exe');
      if (fs.existsSync(openWith)) return detach(openWith, [full]);
      return detach('rundll32.exe', [`shell32.dll,OpenAs_RunDLL ${full}`], { windowsVerbatimArguments: true });
    }
    return reveal(full);
  }
  if (RUNNABLE.test(full)) return reveal(full);
  if (IS_WIN) detach('explorer.exe', [full]);
  else detach(process.platform === 'darwin' ? 'open' : 'xdg-open', [full]);
}

module.exports = {
  snapshot,
  diff,
  resolveInside,
  absolutePath,
  openFile,
  listDir,
  findFiles,
  RUNNABLE,
  ATTACH_DIR,
  ATTACH_MAX_BYTES,
  appDir,
  newBatch,
  attach,
  uploadTarget,
  removeAttachment,
  checkAttachments,
};

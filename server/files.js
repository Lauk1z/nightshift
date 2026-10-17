'use strict';
// 项目文件：
// - 每轮开始前后各拍一张「快照」（路径、修改时间、大小），对比出这一轮新建、修改、删除了哪些文件，
//   显示成消息底部的文件卡片。不管 AI 是用编辑工具还是用命令写的文件，都能对出来。
// - 打开文件：默认程序、「打开方式」选择程序、在文件夹中显示。
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

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

// 把界面传来的路径（相对路径、绝对路径、AI 写的 /E:/x/y.html、file:// 链接、带 :行号 的）解析成项目里的真实路径。
// 跑出项目文件夹的一律返回 null。
function resolveInside(root, p) {
  let s = String(p || '').trim().replace(/^<|>$/g, '');
  s = s.replace(/^file:\/\/\/?/i, '');
  try {
    s = decodeURIComponent(s);
  } catch {}
  s = s.replace(/^\/([A-Za-z]:[\\/])/, '$1');
  s = s.replace(/#.*$/, '').replace(/:\d+(?::\d+)?$/, '');
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

module.exports = { snapshot, diff, resolveInside, openFile, listDir, findFiles, RUNNABLE };

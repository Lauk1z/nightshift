'use strict';
// 子进程工具：在 Windows 上可靠地找到并启动 claude / codex / opencode 等命令行工具，
// 逐行解析 JSONL 输出，并能整棵进程树一起结束。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { t: tr } = require('./i18n');

const IS_WIN = process.platform === 'win32';
const IN_ELECTRON = !!process.versions.electron;
const cache = new Map();

const splitPath = (s) =>
  String(s || '')
    .split(path.delimiter)
    .map((x) => x.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
const pathKey = (p) => (IS_WIN ? p.toLowerCase() : p).replace(/[\\/]+$/, '');

// Windows：读取系统设置里最新的 PATH（用户 + 系统）。
// 安装新工具时安装程序会改这里，但已经在运行的程序还拿着旧的 PATH，所以检测前要合并一次。
function systemPath() {
  if (!IS_WIN) return Promise.resolve([]);
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script =
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8; [Environment]::GetEnvironmentVariable('Path','Machine'); [Environment]::GetEnvironmentVariable('Path','User')";
  return new Promise((resolve) => {
    execFile(ps, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15000, encoding: 'utf8' }, (err, stdout) => {
      if (err) return resolve([]);
      // 万一有没展开的 %变量%，用当前环境补上
      const expand = (p) => p.replace(/%([^%]+)%/g, (all, name) => process.env[name] ?? all);
      resolve(splitPath(String(stdout).replace(/\r?\n/g, path.delimiter)).map(expand));
    });
  });
}

// 把系统 PATH 里新出现的文件夹并进当前进程的 PATH，返回新增的文件夹
async function refreshPath() {
  const fresh = await systemPath();
  const cur = splitPath(process.env.PATH);
  const seen = new Set(cur.map(pathKey));
  const added = [];
  for (const p of fresh) {
    const k = pathKey(p);
    if (seen.has(k)) continue;
    seen.add(k);
    added.push(p);
  }
  if (added.length) process.env.PATH = [...cur, ...added].join(path.delimiter);
  cache.clear();
  return added;
}

function extraDirs() {
  const home = os.homedir();
  // ~/.grok/bin：Grok Build 的安装脚本默认装在这里
  const dirs = [path.join(home, '.local', 'bin'), path.join(home, '.grok', 'bin')];
  if (IS_WIN) {
    if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm'));
    // Hermes 在 Windows 上装在 %LOCALAPPDATA%\hermes\bin
    if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, 'hermes', 'bin'));
  } else {
    dirs.push('/usr/local/bin', '/opt/homebrew/bin', path.join(home, '.npm-global', 'bin'));
  }
  return dirs;
}

function findOnPath(cmd) {
  const dirs = splitPath(process.env.PATH).concat(extraDirs());
  const exts = IS_WIN ? ['.exe', '.cmd', '.bat', '.com'] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = path.join(dir, cmd + ext);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch {}
    }
  }
  return null;
}

// npm 在 Windows 上生成的 .cmd 包装脚本里写着真正的入口（.js 或 .exe），直接启动入口可以避开 shell 转义问题。
function parseShim(file) {
  let txt;
  try {
    txt = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const re = /"%~?dp0%?\\?([^"%]+?\.(?:c?js|mjs|exe))"/gi;
  const hits = [];
  let m;
  while ((m = re.exec(txt))) hits.push(m[1]);
  const pick =
    hits.filter((h) => /node_modules/i.test(h)).pop() ||
    hits.filter((h) => !/^\\?node\.exe$/i.test(h)).pop();
  if (!pick) return null;
  const full = path.join(path.dirname(file), pick);
  return fs.existsSync(full) ? full : null;
}

// 用什么来运行 npm 包里的 .js 入口：普通 Node 下就是自己；打包成桌面程序后 process.execPath 是 Electron，
// 优先用系统里的 node，没有的话让 Electron 以纯 Node 模式运行。
function nodeRunner() {
  if (!IN_ELECTRON) return { file: process.execPath, env: null };
  const sys = findOnPath('node');
  if (sys) return { file: sys, env: null };
  return { file: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
}

function resolveCommand(cmd) {
  if (cache.has(cmd)) return cache.get(cmd);
  let file = null;
  if (path.isAbsolute(cmd)) {
    if (fs.existsSync(cmd)) file = cmd;
  } else {
    file = findOnPath(cmd);
  }
  let res = null;
  if (file) {
    if (IS_WIN && /\.(cmd|bat)$/i.test(file)) {
      const target = parseShim(file);
      if (target && /\.(c?js|mjs)$/i.test(target)) {
        const node = nodeRunner();
        res = { file: node.file, pre: [target], path: file, env: node.env };
      } else if (target) res = { file: target, pre: [], path: file };
      else res = { file, pre: [], path: file, shell: true };
    } else {
      res = { file, pre: [], path: file };
    }
  }
  cache.set(cmd, res);
  return res;
}

function clearCache() {
  cache.clear();
}

// 如果本程序是在某个 Claude Code / Codex 会话里被启动的，那些会话注入的环境变量会让子进程认错身份，这里清掉。
const KEEP = /^(CLAUDE_CODE_GIT_BASH_PATH|CLAUDE_CONFIG_DIR)$/i;
function childEnv(extra = {}) {
  const env = { ...process.env };
  const nested = 'CLAUDECODE' in env || 'CLAUDE_CODE_ENTRYPOINT' in env;
  for (const k of Object.keys(env)) {
    if (KEEP.test(k)) continue;
    if (k === 'CLAUDECODE') delete env[k];
    else if (nested && /^(CLAUDE|ANTHROPIC)_/i.test(k)) delete env[k];
    else if (/^CODEX_(THREAD_ID|SANDBOX.*|MANAGED_BY.*)$/i.test(k)) delete env[k];
  }
  env.NO_COLOR = '1';
  return Object.assign(env, extra);
}

function quoteForShell(a) {
  if (/^[\w.:/\\@#=+\-[\]]+$/.test(a)) return a;
  return '"' + String(a).replace(/"/g, '\\"') + '"';
}

function spawnTool(cmd, args, opts = {}) {
  const r = resolveCommand(cmd);
  if (!r) {
    const err = new Error(tr('找不到命令「{cmd}」。请确认已经安装，并且在命令行里能直接运行 {cmd}。', { cmd }));
    err.code = 'ENOENT';
    throw err;
  }
  const fullArgs = [...r.pre, ...args];
  return spawn(r.shell ? quoteForShell(r.file) : r.file, r.shell ? fullArgs.map(quoteForShell) : fullArgs, {
    cwd: opts.cwd,
    env: opts.env || childEnv({ ...(r.env || {}), ...(opts.extraEnv || {}) }), // extraEnv：这一次运行额外加的环境变量
    windowsHide: true,
    shell: !!r.shell,
    detached: !IS_WIN,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  try {
    if (IS_WIN) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      process.kill(-child.pid, 'SIGTERM');
    }
  } catch {
    try {
      child.kill();
    } catch {}
  }
}

// 启动一个输出 JSONL 的命令行工具：prompt 从 stdin 写入，每行 JSON 回调 onJson。
// keepOpen：写完 input 先不关 stdin（Claude Code 的 --input-format stream-json 这一轮做完以后还要再问它话），
// 由调用的一方在用完以后 child.stdin.end()
function runJsonl({ cmd, args, cwd, input, onJson, onLine, env, keepOpen = false }) {
  const child = spawnTool(cmd, args, { cwd, extraEnv: env });
  let buf = '';
  let stderr = '';
  const flush = (line) => {
    line = line.trim();
    if (!line) return;
    let obj = null;
    if (line[0] === '{') {
      try {
        obj = JSON.parse(line);
      } catch {}
    }
    if (obj) onJson(obj);
    else if (onLine) onLine(line);
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        flush(line);
      } catch (e) {
        console.error('[parse]', e);
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => {
    stderr = (stderr + d).slice(-20000);
  });
  const done = new Promise((resolve) => {
    child.on('error', (error) => resolve({ code: -1, error, stderr }));
    child.on('close', (code, signal) => {
      try {
        flush(buf);
      } catch {}
      resolve({ code, signal, stderr });
    });
  });
  child.stdin.on('error', () => {});
  if (keepOpen) child.stdin.write(input == null ? '' : input, 'utf8');
  else child.stdin.end(input == null ? '' : input, 'utf8');
  return { child, done };
}

// 运行一个命令并收集全部输出（用来读模型列表这类一次性信息）
function runCapture(cmd, args, { timeoutMs = 30000, cwd } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnTool(cmd, args, { cwd });
    } catch (error) {
      return resolve({ code: -1, stdout: '', stderr: error.message, error });
    }
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-20000)));
    const timer = setTimeout(() => killTree(child), timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr, error });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end();
  });
}

function detectCli(cmd, args = ['--version'], timeoutMs = 20000) {
  const r = resolveCommand(cmd);
  if (!r) return Promise.resolve({ installed: false });
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnTool(cmd, args);
    } catch {
      return resolve({ installed: false });
    }
    let out = '';
    const finish = (extra) => {
      clearTimeout(timer);
      const v = out.match(/\d+\.\d+\.\d+[\w.\-+]*/);
      resolve({ installed: true, path: r.path, version: v ? v[0] : '', ...extra });
    };
    const timer = setTimeout(() => {
      killTree(child);
      finish({ slow: true });
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ installed: false });
    });
    child.on('close', () => finish());
    child.stdin.end();
  });
}

// 把用户填写的「额外参数」按命令行的习惯拆成数组：空格分隔，引号内的空格保留，引号本身去掉。
function splitArgs(s) {
  s = String(s || '');
  const out = [];
  let cur = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (/\s/.test(ch)) {
      if (cur !== null) out.push(cur);
      cur = null;
    } else if (ch === '"' || ch === "'") {
      const j = s.indexOf(ch, i + 1);
      const end = j < 0 ? s.length : j;
      cur = (cur ?? '') + s.slice(i + 1, end);
      i = end;
    } else {
      cur = (cur ?? '') + ch;
    }
  }
  if (cur !== null) out.push(cur);
  return out;
}

module.exports = {
  IS_WIN,
  IN_ELECTRON,
  resolveCommand,
  clearCache,
  refreshPath,
  systemPath,
  childEnv,
  spawnTool,
  killTree,
  runJsonl,
  runCapture,
  detectCli,
  splitArgs,
};

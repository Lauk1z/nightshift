'use strict';
// 内置终端：用 node-pty 开真正的终端（Windows 上是系统的 ConPTY），界面用 xterm.js 显示。
// 输出合并成小块，通过 /api/events 的 term 事件推给界面；输入、改大小走普通请求。
// 每个终端记住最近一段输出，界面刷新或切回这个项目时能恢复屏幕内容。
const fs = require('fs');
const path = require('path');
const { IS_WIN, resolveCommand, childEnv } = require('./proc');
const { newId } = require('./store');
const { t: tr } = require('./i18n');

const MAX_BUFFER = 400 * 1024;
const FLUSH_MS = 12;

let pty = null;
let loadError = '';
function loadPty() {
  if (pty || loadError) return pty;
  try {
    pty = require('@lydell/node-pty');
  } catch (e) {
    loadError = (e && e.message) || String(e);
  }
  return pty;
}

// Windows：装了 PowerShell 7 就用它，没有就用系统自带的 Windows PowerShell
function pickShell() {
  if (IS_WIN) {
    const pwsh = resolveCommand('pwsh');
    if (pwsh && /\.exe$/i.test(pwsh.file)) return { file: pwsh.file, args: ['-NoLogo'], name: 'PowerShell' };
    const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return { file: fs.existsSync(sys) ? sys : 'powershell.exe', args: ['-NoLogo'], name: 'Windows PowerShell' };
  }
  const sh = process.env.SHELL || (fs.existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/bash');
  return { file: sh, args: ['-l'], name: path.basename(sh) };
}

function shellEnv() {
  const env = childEnv({ TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'AgentChat' });
  delete env.NO_COLOR; // 给 AI 用的进程关掉了颜色，终端里要保留
  return env;
}

class Terminals {
  constructor(bus) {
    this.bus = bus;
    this.list = new Map();
  }

  available() {
    return loadPty() ? { ok: true } : { ok: false, error: loadError };
  }

  info(t) {
    return { id: t.id, roomId: t.roomId, title: t.title, shell: t.shell, cwd: t.cwd, exited: t.exited, code: t.code, createdAt: t.createdAt };
  }

  forRoom(roomId) {
    return [...this.list.values()].filter((t) => t.roomId === roomId).map((t) => this.info(t));
  }

  get(id) {
    const t = this.list.get(id);
    if (!t) {
      const e = new Error(tr('终端已经关闭了'));
      e.status = 404;
      throw e;
    }
    return t;
  }

  create({ roomId, cwd, cols, rows }) {
    if (!loadPty()) throw new Error(tr('终端不可用：{reason}', { reason: loadError }));
    if (!cwd || !fs.existsSync(cwd)) throw new Error(tr('项目文件夹不存在'));
    const shell = pickShell();
    const n = this.forRoom(roomId).length;
    const t = {
      id: newId('t'),
      roomId,
      cwd,
      shell: shell.name,
      title: n ? tr('终端 {n}', { n: n + 1 }) : tr('终端'),
      buffer: '',
      seq: 0, // 每推一块输出加一：界面重新接上时，靠它判断哪些输出已经在缓冲里了
      pending: '',
      timer: null,
      exited: false,
      code: null,
      createdAt: Date.now(),
    };
    t.proc = pty.spawn(shell.file, shell.args, {
      name: 'xterm-256color',
      cols: clampSize(cols, 80),
      rows: clampSize(rows, 24),
      cwd,
      env: shellEnv(),
    });
    t.proc.onData((d) => this.output(t, d));
    t.proc.onExit(({ exitCode }) => {
      this.flush(t);
      t.exited = true;
      t.code = exitCode;
      this.bus.send('term-exit', { id: t.id, roomId: t.roomId, code: exitCode });
    });
    this.list.set(t.id, t);
    return this.info(t);
  }

  output(t, d) {
    t.pending += d;
    if (!t.timer) t.timer = setTimeout(() => this.flush(t), FLUSH_MS);
  }

  flush(t) {
    clearTimeout(t.timer);
    t.timer = null;
    if (!t.pending) return;
    const data = t.pending;
    t.pending = '';
    t.buffer += data;
    if (t.buffer.length > MAX_BUFFER) {
      // 从一行的开头截断，免得把半个控制序列留在开头
      const cut = t.buffer.indexOf('\n', t.buffer.length - MAX_BUFFER);
      t.buffer = t.buffer.slice(cut >= 0 ? cut + 1 : t.buffer.length - MAX_BUFFER);
    }
    t.seq += 1;
    this.bus.send('term', { id: t.id, seq: t.seq, data });
  }

  buffer(id) {
    const t = this.get(id);
    this.flush(t);
    return { ...this.info(t), buffer: t.buffer, seq: t.seq };
  }

  write(id, data) {
    const t = this.get(id);
    if (t.exited) return;
    t.proc.write(String(data || ''));
  }

  resize(id, cols, rows) {
    const t = this.get(id);
    if (t.exited) return;
    try {
      t.proc.resize(clampSize(cols, 80), clampSize(rows, 24));
    } catch {}
  }

  rename(id, title) {
    const t = this.get(id);
    t.title = String(title || '').trim().slice(0, 30) || t.title;
    return this.info(t);
  }

  kill(id) {
    const t = this.list.get(id);
    if (!t) return;
    this.list.delete(id);
    clearTimeout(t.timer);
    if (!t.exited) {
      try {
        t.proc.kill();
      } catch {}
    }
  }

  killRoom(roomId) {
    for (const t of [...this.list.values()]) if (t.roomId === roomId) this.kill(t.id);
  }

  killAll() {
    for (const id of [...this.list.keys()]) this.kill(id);
  }

  anyRunning() {
    for (const t of this.list.values()) if (!t.exited) return true;
    return false;
  }
}

function clampSize(v, def) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 2 ? Math.min(n, 1000) : def;
}

module.exports = { Terminals, pickShell, loadPty };

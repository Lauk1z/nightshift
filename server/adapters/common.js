'use strict';
const path = require('path');

// 适配器向编排器汇报的事件：
//   { type: 'session', id }            会话 id（下次用它续上记忆）
//   { type: 'status', text }           当前状态，如「思考中」
//   { type: 'text_start' }             开始输出一段新文字
//   { type: 'delta', text }            流式文字片段
//   { type: 'text', text }             一段完整的文字（中间说明）
//   { type: 'tool', item }             工具调用，按 item.id 更新：{ id, k, n, d, s }
//        k: read | write | edit | cmd | search | web | agent | todo | other
//        s: running | ok | error

function rel(p, cwd) {
  if (!p) return '';
  const s = String(p);
  try {
    const r = path.relative(cwd, s);
    if (r && !r.startsWith('..') && !path.isAbsolute(r)) return r.replace(/\\/g, '/');
  } catch {}
  return s.replace(/\\/g, '/');
}

function clip(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// Codex 在 Windows 上会把命令包进 powershell.exe -Command '...'，显示时剥掉外壳。
function prettyCmd(c) {
  c = String(c || '').trim();
  let m = c.match(/powershell(?:\.exe)?"?\s+(?:-\w+\s+)*?-Command\s+(['"])([\s\S]*)\1\s*$/i);
  if (m) return m[2];
  m = c.match(/^"?[^"\s]*?(?:bash|sh|zsh)(?:\.exe)?"?\s+-l?c\s+(['"])([\s\S]*)\1\s*$/);
  if (m) return m[2];
  return c;
}

function tail(s, n = 1500) {
  s = String(s || '').trim();
  return s.length > n ? '…' + s.slice(-n) : s;
}

// 从命令行工具的 --help 输出里取出某个选项的完整说明（包括折行），用来判断当前版本支持什么
function optionBlock(help, flag) {
  const lines = String(help || '').split(/\r?\n/);
  const re = new RegExp(`^\\s*(?:-\\w,\\s*)?${flag.replace(/[-]/g, '\\-')}(?![\\w-])`);
  const i = lines.findIndex((l) => re.test(l));
  if (i < 0) return '';
  const out = [lines[i]];
  for (const l of lines.slice(i + 1)) {
    if (!l.trim() || /^\s{0,6}-/.test(l)) break; // 空行或下一个选项
    out.push(l);
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

// 探测结果只在第一次用到或「重新检测」时读取，避免每次运行都多跑一遍 --help
function makeProbe(load) {
  let pending = null;
  return (force) => {
    if (force || !pending) pending = Promise.resolve().then(load);
    return pending;
  };
}

// token 用量统一成 { model, input, output, cacheRead, cacheWrite }：
// input 不含命中缓存的部分，output 含思考用的 token。同一个模型的几次调用合并成一行
const tok = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : 0);
function addUsage(list, model, u) {
  const row = { model: String(model || ''), input: tok(u.input), output: tok(u.output), cacheRead: tok(u.cacheRead), cacheWrite: tok(u.cacheWrite) };
  if (!row.input && !row.output && !row.cacheRead && !row.cacheWrite) return list;
  const same = list.find((r) => r.model === row.model);
  if (same) for (const k of ['input', 'output', 'cacheRead', 'cacheWrite']) same[k] += row[k];
  else list.push(row);
  return list;
}

// 接口报错常常是一层套一层的 JSON 字符串（Gemini、pi 都会这样），取出最里面给人看的那句话；
// 开头有 HTTP 状态码的（401 {...}）把状态码留着
function readableError(msg) {
  const raw = String(msg || '').trim();
  let s = raw;
  for (let i = 0; i < 4 && /\\"/.test(s); i++) s = s.replace(/\\\\/g, '\\').replace(/\\"/g, '"').replace(/\\n/g, '\n');
  const hits = [...s.matchAll(/"message"\s*:\s*"([^"{}]+)"/g)].map((m) => m[1].trim()).filter(Boolean);
  if (!hits.length) return raw;
  const code = raw.match(/^(\d{3})\b/);
  return (code ? code[1] + ' ' : '') + hits[hits.length - 1];
}

// 流式文字分段：一段文字开始时告诉界面（text_start），一个字一个字地推（delta）；
// 开始调用工具前把这段收尾，成为一条「过程说明」（text）。最后一段通常就是最终回复。
function segmenter(emit) {
  let open = false;
  let cur = '';
  let last = '';
  return {
    delta(t) {
      if (!t) return;
      if (!open) {
        open = true;
        cur = '';
        emit({ type: 'text_start' });
      }
      cur += t;
      emit({ type: 'delta', text: t });
    },
    close() {
      if (!open) return;
      open = false;
      if (cur.trim()) {
        last = cur;
        emit({ type: 'text', text: cur });
      }
    },
    get last() {
      return open && cur.trim() ? cur : last;
    },
  };
}

// 续上旧会话失败（会话被删了、换了电脑……）时各家的说法：遇到就换一个新会话重来
const RESUME_FAIL =
  /no conversation found|session.{0,40}not found|could not find session|couldn't find session|no session (found|matching|with)|session.{0,40}(does not|doesn't) exist|no rollout found|thread.{0,40}not found|unknown session|failed to resume|cannot resume|invalid session|omit --session-id/i;

module.exports = { rel, clip, prettyCmd, tail, optionBlock, makeProbe, addUsage, readableError, segmenter, RESUME_FAIL };

'use strict';
// 查看某一轮改了什么：用撤销存下的改之前、改之后的内容（见 checkpoints.js）逐行对比，做成和 git diff 一样的几段，
// 每段前后带 3 行没改的。新建的文件整个算新加的，删掉的整个算删掉的。
// 对比用 Myers 算法；先去掉开头和结尾相同的行，剩下的改动太多（改了上千处）就不细算了，按整段替换显示

const CONTEXT = 3;
const MAX_EDITS = 2000; // Myers 最多算到这么多处改动，再多就按整段替换
const MAX_LINES = 1500; // 一个文件最多显示这么多行，再多的截掉

function splitLines(text) {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop(); // 末尾的换行不算一行
  return lines;
}

// 二进制文件：前 8000 个字节里有 0
const isBinary = (buf) => buf.subarray(0, 8000).includes(0);

// Myers 算法：返回 [['=', 旧行号, 新行号] | ['-', 旧行号, null] | ['+', null, 新行号]]（行号从 0 开始）。
// 只记每一步用到的那一段（-d-1 到 d+1），改动处数超过 maxD 就返回 null
function myers(a, b, maxD) {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    if (d > maxD) return null;
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  const at = (w, d, k) => w[k + d + 1];
  const out = [];
  let x = n;
  let y = m;
  for (let d = found; d >= 0; d--) {
    const w = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(w, d, k - 1) < at(w, d, k + 1)) ? k + 1 : k - 1;
    const prevX = at(w, d, prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      out.push(['=', x - 1, y - 1]);
      x--;
      y--;
    }
    if (d > 0) out.push(x === prevX ? ['+', null, y - 1] : ['-', x - 1, null]);
    x = prevX;
    y = prevY;
  }
  return out.reverse();
}

// 整个对比：开头、结尾相同的行先拿掉，中间的用 Myers；算不过来就整段删掉再整段加上
function editScript(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const out = [];
  for (let i = 0; i < start; i++) out.push(['=', i, i]);
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const mid = myers(midA, midB, MAX_EDITS);
  if (mid) for (const [t, i, j] of mid) out.push([t, i === null ? null : i + start, j === null ? null : j + start]);
  else {
    for (let i = start; i < endA; i++) out.push(['-', i, null]);
    for (let j = start; j < endB; j++) out.push(['+', null, j]);
  }
  for (let i = 0; i < a.length - endA; i++) out.push(['=', endA + i, endB + i]);
  return out;
}

// 两段文字的对比：多了几行、少了几行，和带上下文的几段（hunks）。
// 每段的 lines 是 [类型, 旧行号, 新行号, 文字]，行号从 1 开始，类型是 add / del / ctx。
// 内容不一样、逐行看却一样：只差在换行符（CRLF 和 LF）或者末尾的空行，标成 eolOnly
function diffText(before, after) {
  const a = splitLines(before);
  const b = splitLines(after);
  const ops = editScript(a, b);
  let add = 0;
  let del = 0;
  for (const [t] of ops) {
    if (t === '+') add++;
    else if (t === '-') del++;
  }
  const changed = ops.map((op, i) => (op[0] === '=' ? -1 : i)).filter((i) => i >= 0);
  const hunks = [];
  let shown = 0;
  let truncated = false;
  let i = 0;
  while (i < changed.length) {
    // 一段：从这处改动往前 3 行，到后面隔得不远（不超过 6 行）的改动都算进来，再往后 3 行
    let last = changed[i];
    let j = i + 1;
    while (j < changed.length && changed[j] - last <= CONTEXT * 2 + 1) last = changed[j++];
    const from = Math.max(0, changed[i] - CONTEXT);
    const to = Math.min(ops.length - 1, last + CONTEXT);
    const lines = [];
    for (let k = from; k <= to; k++) {
      if (shown >= MAX_LINES) {
        truncated = true;
        break;
      }
      const [t, oi, ni] = ops[k];
      const text = t === '+' ? b[ni] : a[oi];
      lines.push([t === '+' ? 'add' : t === '-' ? 'del' : 'ctx', oi === null ? null : oi + 1, ni === null ? null : ni + 1, text]);
      shown++;
    }
    if (lines.length) hunks.push({ lines });
    if (truncated) break;
    i = j;
  }
  const eolOnly = !add && !del && before !== after;
  return { add, del, hunks, ...(truncated ? { truncated: true } : {}), ...(eolOnly ? { eolOnly: true } : {}) };
}

// 撤销记录里的一个文件（checkpoints.js 的 record）→ 给界面看的对比。read(sha1) 读存下的内容，读不到返回 null
function fileChanges(e, read) {
  const out = { path: e.path, change: e.change };
  if (e.big) return { ...out, big: true };
  const before = e.before ? read(e.before) : Buffer.alloc(0);
  const after = e.after ? read(e.after) : Buffer.alloc(0);
  if (!before || !after) return { ...out, missing: true };
  if (isBinary(before) || isBinary(after)) return { ...out, binary: true };
  return { ...out, ...diffText(before.toString('utf8'), after.toString('utf8')) };
}

module.exports = { diffText, fileChanges, editScript, splitLines, MAX_LINES };

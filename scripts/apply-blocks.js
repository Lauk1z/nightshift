'use strict';
// 按「原文 → 新文」块批量改文件（整理翻译时用）。块的写法：
//   @@@ FILE 路径
//   @@@ OLD            （或 @@@ OLD ALL：出现几次就换几次）
//   ……原文，可以多行……
//   @@@ NEW
//   ……新文……
//   @@@ END
// 每个原文必须在文件里找得到（不写 ALL 时还必须只出现一次），否则整批都不写入。
const fs = require('fs');
const path = require('path');

const patch = fs.readFileSync(process.argv[2], 'utf8').replace(/\r\n/g, '\n');
const root = process.argv[3] || process.cwd();
const files = new Map();
let file = null;
let mode = null;
let all = false;
let oldBuf = [];
let newBuf = [];
const errors = [];
let count = 0;

function load(p) {
  if (!files.has(p)) files.set(p, fs.readFileSync(path.join(root, p), 'utf8'));
  return files.get(p);
}

for (const line of patch.split('\n')) {
  const m = line.match(/^@@@ (FILE|OLD|NEW|END)(?: (.*))?$/);
  if (!m) {
    if (mode === 'old') oldBuf.push(line);
    else if (mode === 'new') newBuf.push(line);
    continue;
  }
  if (m[1] === 'FILE') {
    file = m[2].trim();
    load(file);
  } else if (m[1] === 'OLD') {
    mode = 'old';
    all = (m[2] || '').trim() === 'ALL';
    oldBuf = [];
    newBuf = [];
  } else if (m[1] === 'NEW') mode = 'new';
  else if (m[1] === 'END') {
    const a = oldBuf.join('\n');
    const b = newBuf.join('\n');
    const s = files.get(file);
    const n = s.split(a).length - 1;
    if (!n) errors.push(`${file}: 找不到 ⟶ ${a.slice(0, 120)}`);
    else if (n > 1 && !all) errors.push(`${file}: 出现了 ${n} 次（要全部替换请写 OLD ALL）⟶ ${a.slice(0, 120)}`);
    else {
      files.set(file, s.split(a).join(b));
      count++;
    }
    mode = null;
  }
}
if (errors.length) {
  console.error(errors.join('\n'));
  console.error(`\n${errors.length} 处有问题，什么都没写入`);
  process.exit(1);
}
for (const [p, s] of files) fs.writeFileSync(path.join(root, p), s);
console.log(`改了 ${count} 处`);

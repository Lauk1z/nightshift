'use strict';
// 一次性的整理工具：把带中文的普通字符串 '……' 包成 tr('……')。
// 不动：含 HTML 的、模板字符串（手工改）、跳过列表里的行（比如 @用户 这些协议里的固定写法）。
// 用法：node scripts/i18n-wrap.js 文件 [--skip 行号,行号] [--dry]
const fs = require('fs');
const { scan, CJK } = require('./i18n-scan');

const args = process.argv.slice(2);
const file = args[0];
const dry = args.includes('--dry');
const skipArg = args[args.indexOf('--skip') + 1];
const skip = new Set(args.includes('--skip') ? skipArg.split(',').map(Number) : []);
const fn = args.includes('--fn') ? args[args.indexOf('--fn') + 1] : 'tr';

const src = fs.readFileSync(file, 'utf8');
const lines = src.split('\n');
const hits = scan(src).filter((x) => x.kind === 'str' && CJK.test(x.text));
let out = '';
let last = 0;
let n = 0;
for (const h of hits) {
  if (skip.has(h.line)) continue;
  if (/</.test(h.text)) continue; // 含 HTML 的手工改
  const before = src.slice(Math.max(0, h.start - fn.length - 1), h.start);
  if (before.endsWith(fn + '(') || /\bt\($/.test(before)) continue; // 已经包过
  const lineText = lines[h.line - 1];
  if (/USER_ALIASES|ALL_ALIASES|RESERVED|new RegExp|\.test\(|\.match\(/.test(lineText) && !/tr\(/.test(lineText)) {
    console.log(`skip ${h.line}: ${lineText.trim().slice(0, 100)}`);
    continue;
  }
  const q = src[h.start];
  const end = h.start + 1 + h.text.length + 1;
  if (src[end - 1] !== q) {
    console.log(`?? ${h.line}: 找不到结尾的引号，跳过`);
    continue;
  }
  out += src.slice(last, h.start) + `${fn}(` + src.slice(h.start, end) + ')';
  last = end;
  n++;
}
out += src.slice(last);
if (!dry) fs.writeFileSync(file, out);
console.log(`${file}: 包了 ${n} 处${dry ? '（试运行）' : ''}`);

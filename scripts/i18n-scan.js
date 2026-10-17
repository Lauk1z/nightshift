'use strict';
// 找出代码里所有带中文的字符串（跳过注释），翻译界面时用来检查有没有漏掉的文字。
// 用法：node scripts/i18n-scan.js 文件…        只列出还没有用 tr()/t() 包起来的
//       node scripts/i18n-scan.js --all 文件…  全部列出
const fs = require('fs');

const CJK = /[㐀-鿿豈-﫿　-〿＀-￯]/;

// 一个够用的 JS 词法扫描：认得注释、字符串、模板字符串（含 ${} 嵌套）和大部分正则
function scan(src) {
  const out = [];
  let i = 0;
  let line = 1;
  let prevSig = '';
  const stack = []; // 模板字符串里的 ${ 层数
  const push = (kind, text, ln, start) => out.push({ kind, text, line: ln, start });
  const regexOk = () => !prevSig || /[(,=:[!&|?{};+\-*%<>~^]$/.test(prevSig) || /\b(return|typeof|case|in|of|new|delete|void|throw)$/.test(prevSig);
  function readTemplate() {
    // 现在 src[i] 是 ` 或者从 } 回到模板里；读到下一个 ${ 或结尾的 `
    let buf = '';
    const ln = line;
    const start = i;
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') {
        buf += src[i] + src[i + 1];
        i += 2;
        continue;
      }
      if (c === '`') {
        i++;
        push('tpl', buf, ln, start);
        return 'end';
      }
      if (c === '$' && src[i + 1] === '{') {
        i += 2;
        push('tpl', buf, ln, start);
        stack.push(0);
        return 'expr';
      }
      if (c === '\n') line++;
      buf += c;
      i++;
    }
    return 'end';
  }
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') {
      line++;
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      const end = e < 0 ? src.length : e + 2;
      for (let k = i; k < end; k++) if (src[k] === '\n') line++;
      i = end;
      continue;
    }
    if (c === "'" || c === '"') {
      const ln = line;
      const start = i;
      let buf = '';
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') {
          buf += src[i] + src[i + 1];
          i += 2;
          continue;
        }
        if (src[i] === '\n') break;
        buf += src[i++];
      }
      i++;
      push('str', buf, ln, start);
      prevSig = 'x';
      continue;
    }
    if (c === '`') {
      i++;
      readTemplate();
      prevSig = 'x';
      continue;
    }
    if (c === '/' && regexOk()) {
      // 正则：读到没有转义、不在 [] 里的 /
      let inClass = false;
      i++;
      while (i < src.length && src[i] !== '\n') {
        const d = src[i];
        if (d === '\\') {
          i += 2;
          continue;
        }
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) break;
        i++;
      }
      i++;
      while (/[a-z]/i.test(src[i] || '')) i++;
      prevSig = 'x';
      continue;
    }
    if (stack.length) {
      if (c === '{') stack[stack.length - 1]++;
      else if (c === '}') {
        if (stack[stack.length - 1] === 0) {
          stack.pop();
          i++;
          readTemplate();
          prevSig = 'x';
          continue;
        }
        stack[stack.length - 1]--;
      }
    }
    // 记住上一个有意义的字符或单词，用来判断 / 是除号还是正则
    if (/[A-Za-z0-9_$]/.test(c)) {
      let w = '';
      while (i < src.length && /[A-Za-z0-9_$]/.test(src[i])) w += src[i++];
      prevSig = w;
      continue;
    }
    prevSig = c;
    i++;
  }
  return out;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  let count = 0;
  for (const f of args.filter((a) => !a.startsWith('--'))) {
    const src = fs.readFileSync(f, 'utf8');
    const lines = src.split('\n');
    const hits = scan(src).filter((x) => CJK.test(x.text));
    const left = hits.filter((x) => {
      if (all) return true;
      // 已经是 tr('…') / t('…') 的第一个参数，就不算漏掉
      const before = src.slice(Math.max(0, x.start - 4), x.start);
      return !/(\btr|\bt)\($/.test(before);
    });
    if (!left.length) continue;
    console.log(`\n== ${f}（${left.length}）`);
    for (const x of left) {
      count++;
      console.log(`${String(x.line).padStart(5)} ${x.kind} ${JSON.stringify(x.text).slice(0, 160)}   ⟵ ${lines[x.line - 1].trim().slice(0, 90)}`);
    }
  }
  console.log(`\n共 ${count} 处`);
}

module.exports = { scan, CJK };

'use strict';
// 收集代码里所有 tr('…') / t('…') 的源文（简体中文），检查各语言词典有没有漏翻、多余或占位符对不上。
// 用法：node scripts/i18n-keys.js            检查 public/i18n/ 下的每个词典，有问题时退出码为 1
//       node scripts/i18n-keys.js --list     列出全部源文（JSON 数组）
//       node scripts/i18n-keys.js --missing en  只列出 en 词典缺的源文（JSON 数组）
const fs = require('fs');
const path = require('path');
const { scan } = require('./i18n-scan');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'public', 'i18n');
const SOURCES = [
  'public/app.js',
  'public/panel.js',
  'public/markdown.js',
  'public/account.js',
  'electron/main.js',
  ...fs.readdirSync(path.join(ROOT, 'server')).filter((f) => f.endsWith('.js')).map((f) => 'server/' + f),
  ...fs.readdirSync(path.join(ROOT, 'server', 'adapters')).filter((f) => f.endsWith('.js')).map((f) => 'server/adapters/' + f),
];

// 字符串字面量里的转义还原成真正的字符
function unescape(raw) {
  return raw.replace(/\\(u\{[0-9a-f]+\}|u[0-9a-f]{4}|x[0-9a-f]{2}|.)/gis, (m, e) => {
    if (e[0] === 'u' && e.length > 1) return String.fromCodePoint(parseInt(e.replace(/[u{}]/g, ''), 16));
    if (e[0] === 'x' && e.length === 3) return String.fromCharCode(parseInt(e.slice(1), 16));
    return { n: '\n', t: '\t', r: '\r', 0: '\0', b: '\b', f: '\f', v: '\v' }[e] ?? e;
  });
}

function collect() {
  const keys = new Map(); // 源文 → 第一次出现的位置
  const problems = [];
  for (const rel of SOURCES) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const tok of scan(src)) {
      const before = src.slice(Math.max(0, tok.start - 4), tok.start);
      if (!/(\btr|\bt)\($/.test(before)) continue;
      if (tok.kind === 'tpl') {
        problems.push(`${rel}:${tok.line} 翻译函数里用了模板字符串，改成 {名字} 占位符`);
        continue;
      }
      const key = unescape(tok.text);
      if (!keys.has(key)) keys.set(key, `${rel}:${tok.line}`);
    }
  }
  return { keys, problems };
}

// 占位符：{name}，以及英文单复数 {n|file|files} 里的 n
const holes = (s) =>
  [...String(s).matchAll(/\{(\w+)(?:\|[^}]*)?\}/g)]
    .map((m) => m[1])
    .sort()
    .filter((x, i, a) => a.indexOf(x) === i)
    .join(',');

function check() {
  const { keys, problems } = collect();
  let bad = problems.length;
  for (const p of problems) console.log('  ✗ ' + p);
  const langs = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => f.endsWith('.json')) : [];
  for (const f of langs) {
    const dict = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
    const missing = [...keys.keys()].filter((k) => typeof dict[k] !== 'string' || !dict[k]);
    const extra = Object.keys(dict).filter((k) => !keys.has(k));
    const mismatch = [...keys.keys()].filter((k) => typeof dict[k] === 'string' && holes(dict[k]) !== holes(k));
    console.log(`${f}：${Object.keys(dict).length} 条，缺 ${missing.length}，多余 ${extra.length}，占位符不一致 ${mismatch.length}`);
    for (const k of missing.slice(0, 40)) console.log(`  缺   ${JSON.stringify(k)}  (${keys.get(k)})`);
    for (const k of extra.slice(0, 40)) console.log(`  多余 ${JSON.stringify(k)}`);
    for (const k of mismatch) console.log(`  占位符 ${JSON.stringify(k)} → ${JSON.stringify(dict[k])}`);
    bad += missing.length + mismatch.length;
  }
  console.log(`源文共 ${keys.size} 条`);
  return bad;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === '--list') {
    console.log(JSON.stringify([...collect().keys.keys()], null, 1));
  } else if (args[0] === '--missing') {
    const f = path.join(DIR, `${args[1]}.json`);
    const dict = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
    console.log(JSON.stringify([...collect().keys.keys()].filter((k) => !dict[k]), null, 1));
  } else {
    process.exitCode = check() ? 1 : 0;
  }
}

module.exports = { collect, holes, SOURCES };

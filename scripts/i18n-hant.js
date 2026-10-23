'use strict';
// 由简体源文生成繁体中文词典和使用说明（台湾用语）：node scripts/i18n-hant.js
// 用 OpenCC（opencc-js，只在开发时需要）。转得不合适的词在 FIX 里改，改完重新生成。
const fs = require('fs');
const path = require('path');
const OpenCC = require('opencc-js');
const { collect } = require('./i18n-keys');

const convert = OpenCC.Converter({ from: 'cn', to: 'twp' });
// [转换后的写法, 想要的写法]，按顺序替换（长的写在前面）
const FIX = [
  ['許可權', '權限'], // OpenCC 把「权限」拆成了「许可 权」
  ['二進位制', '二進位'],
  ['引數', '參數'],
  ['賬', '帳'],
  ['這臺', '這台'],
  ['前臺', '前景'],
  ['後臺', '背景'],
  ['此電腦', '本機'],
  ['配置檔案', '設定檔'],
  ['配置', '設定'],
  ['壓縮包', '壓縮檔'],
  ['獲取', '取得'],
  ['列表', '清單'],
  ['新建', '新增'],
  ['終端', '終端機'],
  ['清屏', '清除畫面'],
  ['後退', '上一頁'],
  ['前進', '下一頁'],
  ['退出碼', '結束代碼'],
  ['退出', '結束'],
  ['檔案管理器', '檔案總管'],
  ['開啟資料資料夾', '開啟 data 資料夾'],
  ['資料資料夾', 'data 資料夾'],
  // 「接口」指 API；「界面」才是介面
  ['介面地址', 'API 位址'],
  ['介面返回', 'API 回傳'],
  ['介面沒有返回', 'API 沒有回傳'],
  ['介面不認', 'API 不認'],
  ['介面不存在', 'API 不存在'],
  ['OpenAI 介面', 'OpenAI API'],
];
const plain = (k) => (k.includes('::') ? k.slice(k.indexOf('::') + 2) : k);

const out = {};
for (const key of collect().keys.keys()) {
  let v = convert(plain(key));
  for (const [a, b] of FIX) v = v.split(a).join(b);
  out[key] = v;
}
fs.writeFileSync(path.join(__dirname, '..', 'public', 'i18n', 'zh-Hant.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log(`zh-Hant.json：${Object.keys(out).length} 条`);

// 使用说明也转一份：README.md → README.zh-Hant.md
// 截图换成繁体界面的；最上面的语言链接改成指向简体版和英文版
const README_FIX = [
  ['docs/screenshots/zh-Hans/', 'docs/screenshots/zh-Hant/'],
  ['<a href="README.en.md">English</a> · <a href="README.zh-Hant.md">繁體中文</a>', '<a href="README.md">简体中文</a> · <a href="README.en.md">English</a>'],
];
const root = path.join(__dirname, '..');
let readme = convert(fs.readFileSync(path.join(root, 'README.md'), 'utf8'));
for (const [a, b] of FIX) readme = readme.split(a).join(b);
for (const [a, b] of README_FIX) {
  if (!readme.includes(a)) throw new Error(`README.md 里找不到：${a}`);
  readme = readme.split(a).join(b);
}
fs.writeFileSync(path.join(root, 'README.zh-Hant.md'), readme, 'utf8');
console.log('README.zh-Hant.md');

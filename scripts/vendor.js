'use strict';
// 把界面要用的第三方库（xterm.js 终端）从 node_modules 复制到 public/vendor。
// 界面本身不依赖 node_modules：打包进 exe 和浏览器版都直接用这里的文件。
// 升级 xterm 后运行一次：npm run vendor
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'public', 'vendor', 'xterm');
const FILES = [
  ['@xterm/xterm/lib/xterm.js', 'xterm.js'],
  ['@xterm/xterm/css/xterm.css', 'xterm.css'],
  ['@xterm/xterm/LICENSE', 'LICENSE.txt'],
  ['@xterm/addon-fit/lib/addon-fit.js', 'addon-fit.js'],
  ['@xterm/addon-web-links/lib/addon-web-links.js', 'addon-web-links.js'],
];

fs.mkdirSync(OUT, { recursive: true });
for (const [from, to] of FILES) {
  const src = path.join(ROOT, 'node_modules', from);
  let text = fs.readFileSync(src, 'utf8');
  // 不带 .map 文件，去掉指向它的注释，免得开发者工具里报找不到
  text = text.replace(/\n?\/\/# sourceMappingURL=\S+\s*$/, '\n');
  fs.writeFileSync(path.join(OUT, to), text);
  console.log(`${from} → public/vendor/xterm/${to}`);
}

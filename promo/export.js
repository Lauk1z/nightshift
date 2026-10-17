'use strict';
// 把 promo.html 导出成视频或截图。用项目里装好的 Electron，不需要 ffmpeg：
//   npx electron promo/export.js                          → promo/Nightshift-promo.mp4（1920×1080，30 帧，H.264）
//   npx electron promo/export.js --stills 2,7.5,12 [--dir 文件夹]  → 那几秒的截图（检查画面用）
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const stills = arg('--stills');
const dir = arg('--dir') || path.join(__dirname, 'stills');
const out = arg('--out') || path.join(__dirname, 'Nightshift-promo.mp4');

app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1280, height: 720, webPreferences: { backgroundThrottling: false } });
  // 页面里打印的进度转到命令行（新旧版本 Electron 的事件参数不一样）
  win.webContents.on('console-message', (e, level, message) => {
    const msg = typeof message === 'string' ? message : e.message;
    if (/^\[export\]/.test(msg || '')) console.log(msg);
  });
  try {
    await win.loadFile(path.join(__dirname, 'promo.html'), { query: { mode: 'export' } });
    if (stills) {
      fs.mkdirSync(dir, { recursive: true });
      for (const t of stills.split(',').map(Number)) {
        const url = await win.webContents.executeJavaScript(`still(${t})`);
        fs.writeFileSync(path.join(dir, `still-${t}.png`), Buffer.from(url.split(',')[1], 'base64'));
      }
      console.log(`[stills] ${stills} → ${dir}`);
    } else {
      const started = Date.now();
      const bytes = await win.webContents.executeJavaScript('exportMP4()');
      fs.writeFileSync(out, Buffer.from(bytes));
      console.log(`[done] ${out}  ${(bytes.length / 1048576).toFixed(1)} MB  ${Math.round((Date.now() - started) / 1000)} 秒`);
    }
  } catch (e) {
    console.log('[error]', (e && e.message) || e);
    app.exit(1);
    return;
  }
  app.exit(0);
});

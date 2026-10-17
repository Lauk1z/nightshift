'use strict';
// 把原图做成 README 用的图：窗口截图加上 Windows 11 那样的圆角、细边框和阴影；
// 弹窗截图按记下的区域裁出来，用弹窗自己的圆角。
// 由 index.js 用 Electron 运行：electron frame.js <临时文件夹> <输出文件夹> <图名…>
// 读 <临时文件夹>/raw/<图名>.png 和旁边的 .json（语言、种类、外观、缩放比例、裁剪区域），存到 <输出文件夹>/<语言>/<种类>.png
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const [work, outRoot, ...names] = process.argv.slice(2);
// 画图用的窗口也会建配置文件夹，放在临时文件夹里（不然会建在系统的 AppData 下面）
app.setPath('userData', path.join(work, 'ud', 'frame'));

function job(name) {
  const info = JSON.parse(fs.readFileSync(path.join(work, 'raw', name + '.json'), 'utf8'));
  const light = info.theme === 'light';
  return {
    src: path.join(work, 'raw', name + '.png'),
    out: path.join(outRoot, info.lang, info.kind + '.png'),
    scale: info.scale,
    crop: info.rect || null,
    radius: info.rect ? info.radius || 12 : 8,
    // 细边框只给窗口加，弹窗自己带边框
    border: info.rect ? null : light ? 'rgba(0,0,0,0.16)' : 'rgba(255,255,255,0.13)',
    shadow: light ? 'rgba(15,23,42,0.22)' : 'rgba(0,0,0,0.45)',
  };
}

// 在页面里画：读进来的是 data URL，画完也返回 data URL
function draw(job, dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const s = job.scale;
      const [cx, cy, cw, ch] = job.crop ? job.crop.map((v) => Math.round(v * s)) : [0, 0, img.width, img.height];
      const blur = Math.round(22 * s);
      const dy = Math.round(8 * s);
      const pad = Math.round(blur * 1.4);
      const W = cw + pad * 2;
      const H = ch + pad * 2;
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      const g = c.getContext('2d');
      const r = job.radius * s;
      const shape = () => {
        g.beginPath();
        g.roundRect(pad, pad, cw, ch, r);
      };
      // 阴影：先用实色填一次形状（图会盖住它）
      g.save();
      g.shadowColor = job.shadow;
      g.shadowBlur = blur;
      g.shadowOffsetY = dy;
      g.fillStyle = '#000';
      shape();
      g.fill();
      g.restore();
      // 截图本身，裁成圆角
      g.save();
      shape();
      g.clip();
      g.drawImage(img, cx, cy, cw, ch, pad, pad, cw, ch);
      g.restore();
      if (job.border) {
        g.save();
        g.strokeStyle = job.border;
        g.lineWidth = Math.max(1, Math.round(s));
        g.beginPath();
        g.roundRect(pad + 0.5, pad + 0.5, cw - 1, ch - 1, r);
        g.stroke();
        g.restore();
      }
      resolve({ url: c.toDataURL('image/png'), w: W, h: H });
    };
    img.onerror = () => reject(new Error('读不了图片'));
    img.src = dataUrl;
  });
}

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
    await win.loadURL('data:text/html,<meta charset=utf-8><body></body>');
    for (const name of names) {
      const j = job(name);
      const data = 'data:image/png;base64,' + fs.readFileSync(j.src).toString('base64');
      const r = await win.webContents.executeJavaScript(`(${draw.toString()})(${JSON.stringify(j)}, ${JSON.stringify(data)})`);
      const buf = Buffer.from(r.url.slice(r.url.indexOf(',') + 1), 'base64');
      fs.mkdirSync(path.dirname(j.out), { recursive: true });
      fs.writeFileSync(j.out, buf);
      console.log(path.relative(outRoot, j.out), `${r.w}x${r.h}`, Math.round(buf.length / 1024) + 'KB');
    }
  } catch (e) {
    console.log('加框失败：' + ((e && e.stack) || e));
    app.exit(1);
    return;
  }
  app.exit(0);
});

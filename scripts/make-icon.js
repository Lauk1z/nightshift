'use strict';
// 生成应用图标，深浅色各一套：
//   深色 Nightshift（夜班）：深夜蓝的底，一弯月亮，月亮的缺口里亮着提示符 >_，旁边两颗星
//   浅色 Dayshift（日班）：晴空蓝的底，一轮太阳，太阳里写着提示符 >_
//   build/icon.png、build/icon.ico          Nightshift：exe、安装包、开始菜单用这个
//   build/icon-day.png、build/icon-day.ico  Dayshift：浅色外观时窗口和任务栏换成这个
// 用有向距离场直接画，每个尺寸单独渲染、边缘抗锯齿。小尺寸时线条加粗、提示符放大、去掉星星这类细节，
// 保证 16px 也看得清。坐标都按 64×64 的设计稿写。不依赖任何第三方库。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'build');
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const clamp = (v) => Math.max(0, Math.min(1, v));

// ---------- 距离场：负数在形状里面 ----------
const circle = (cx, cy, r) => (x, y) => Math.hypot(x - cx, y - cy) - r;
// 线段加圆头（胶囊），w 是线宽
function segment(ax, ay, bx, by, w) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  return (x, y) => {
    const t = clamp(((x - ax) * dx + (y - ay) * dy) / len2);
    return Math.hypot(x - (ax + t * dx), y - (ay + t * dy)) - w / 2;
  };
}
// 折线：几段胶囊合在一起
const polyline = (pts, w) => {
  const segs = pts.slice(1).map((p, i) => segment(pts[i][0], pts[i][1], p[0], p[1], w));
  return (x, y) => Math.min(...segs.map((f) => f(x, y)));
};
// 圆角方块（整张图标的底）
const tile = (r) => (x, y) => {
  const qx = Math.abs(x - 32) - (30 - r);
  const qy = Math.abs(y - 32) - (30 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};

// ---------- 两套图案：返回一层层的 [距离场, 颜色] ----------
function night(size) {
  const small = size <= 32;
  const BG = '#12183A';
  const layers = [
    [tile(14), BG],
    [circle(27, 34, 18), '#F3E9CF'], // 月亮
    [circle(37, 27, 15), BG], // 用底色盖掉一块，剩下一弯
  ];
  // 提示符 >_ 在月亮的缺口里；小尺寸时放大、加粗
  const w = small ? 5.2 : 3.6;
  const p = small
    ? { chev: [[33.5, 19.5], [41.5, 27], [33.5, 34.5]], under: [44.5, 34.5, 51, 34.5] }
    : { chev: [[35, 22], [41, 27.5], [35, 33]], under: [44, 33, 50, 33] };
  layers.push([polyline(p.chev, w), '#FFB547'], [segment(...p.under, w), '#FFB547']);
  if (size >= 48) layers.push([circle(51, 13, 1.6), '#F3E9CF'], [circle(56, 20, 1.2), '#F3E9CF']);
  return layers;
}

function day(size) {
  const small = size <= 32;
  const SUN = '#FFB23A';
  const layers = [[tile(14), '#CFE6FF']];
  // 八道光芒，小尺寸时更粗、离太阳稍远一点，免得糊成一团
  const [r1, r2, rw] = small ? [21.5, 25, 5] : [21, 25, 3.4];
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    layers.push([segment(32 + r1 * Math.cos(a), 32 + r1 * Math.sin(a), 32 + r2 * Math.cos(a), 32 + r2 * Math.sin(a), rw), SUN]);
  }
  layers.push([circle(32, 32, 16), SUN]);
  // 太阳在正中，里面写着提示符 >_（和夜班对应：提示符都在天体里）
  const w = small ? 5 : 3.8;
  const p = small
    ? { chev: [[22.5, 24], [30.5, 32], [22.5, 40]], under: [34, 40, 41.5, 40] }
    : { chev: [[23.5, 25], [30.5, 31.5], [23.5, 38]], under: [33.5, 38, 40.5, 38] };
  layers.push([polyline(p.chev, w), '#24304F'], [segment(...p.under, w), '#24304F']);
  return layers;
}

function render(size, scene) {
  const layers = scene(size).map(([f, c]) => [f, hex(c)]);
  const k = size / 64; // 设计稿 1 个单位是多少像素
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / k;
      const dy = (y + 0.5) / k;
      let col = [0, 0, 0];
      let alpha = 0;
      for (const [f, c] of layers) {
        const a = clamp(0.5 - f(dx, dy) * k); // 距离换算成像素，边缘半个像素的过渡
        if (a <= 0) continue;
        const outA = a + alpha * (1 - a);
        col = col.map((v, i) => (c[i] * a + v * alpha * (1 - a)) / (outA || 1));
        alpha = outA;
      }
      const o = (y * size + x) * 4;
      px[o] = Math.round(col[0]);
      px[o + 1] = Math.round(col[1]);
      px[o + 2] = Math.round(col[2]);
      px[o + 3] = Math.round(alpha * 255);
    }
  }
  return px;
}

// ---------- PNG / ICO ----------
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size, scene) {
  const px = render(size, scene);
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // 不做行滤波
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ICO 文件里直接存 PNG（Windows Vista 以后都支持）。20、40 是 125%、250% 缩放下任务栏用的尺寸
function ico(sizes, scene) {
  const images = sizes.map((s) => ({ s, data: png(s, scene) }));
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = 6 + dir.length;
  images.forEach(({ s, data }, i) => {
    const o = i * 16;
    dir[o] = s >= 256 ? 0 : s;
    dir[o + 1] = s >= 256 ? 0 : s;
    dir.writeUInt16LE(1, o + 4); // 色彩平面
    dir.writeUInt16LE(32, o + 6); // 位深
    dir.writeUInt32LE(data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([head, dir, ...images.map((x) => x.data)]);
}

const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
fs.mkdirSync(OUT, { recursive: true });
for (const [name, scene] of [
  ['icon', night],
  ['icon-day', day],
]) {
  fs.writeFileSync(path.join(OUT, name + '.png'), png(512, scene));
  fs.writeFileSync(path.join(OUT, name + '.ico'), ico(SIZES, scene));
}
console.log('已生成 build/icon.png、icon.ico（Nightshift）和 build/icon-day.png、icon-day.ico（Dayshift）');

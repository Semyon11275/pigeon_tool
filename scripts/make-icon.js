// 图标生成：白边裁剪 → 透明圆角 → 多尺寸缩放 → ico 组装 + 应用内 PNG
// 用法: node scripts/make-icon.js
'use strict';
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const SRC = path.join(__dirname, '..', 'build', 'icon-source.png');
const OUT_DIR = path.join(__dirname, '..', 'build');
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const CORNER_RATIO = 0.225; // 与系统图标一致的圆角比例

function decode() { return PNG.sync.read(fs.readFileSync(SRC)); }

// 找出非白像素包围盒（裁掉四周留白）
function trimBbox(img) {
  const { width: w, height: h, data } = img;
  const isContent = (x, y) => {
    const i = (y * w + x) * 4;
    const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
    if (a < 16) return false;
    return (255 - r) + (255 - g) + (255 - b) > 36; // 距白色足够远
  };
  let top = h, bottom = 0, left = w, right = 0;
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      if (isContent(x, y)) {
        if (y < top) top = y;
        if (y > bottom) bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }
  return { top, bottom, left, right };
}

// 区域平均缩放（图标下采样足够好）
function resize(img, size) {
  const out = new PNG({ width: size, height: size });
  const { width: w, height: h, data: s } = img;
  for (let y = 0; y < size; y++) {
    const y0 = Math.floor(y * h / size), y1 = Math.max(y0 + 1, Math.floor((y + 1) * h / size));
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor(x * w / size), x1 = Math.max(x0 + 1, Math.floor((x + 1) * w / size));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1 && yy < h; yy++) {
        for (let xx = x0; xx < x1 && xx < w; xx++) {
          const i = (yy * w + xx) * 4;
          const al = s[i + 3] / 255;
          r += s[i] * al; g += s[i + 1] * al; b += s[i + 2] * al; a += s[i + 3]; n++;
        }
      }
      const o = (y * size + x) * 4;
      const sumAl = a / 255;
      if (sumAl > 0) { out.data[o] = r / sumAl; out.data[o + 1] = g / sumAl; out.data[o + 2] = b / sumAl; }
      out.data[o + 3] = a / n;
    }
  }
  return out;
}

// 透明圆角（1px 抗锯齿过渡）
function roundCorners(img) {
  const { width: w, height: h, data } = img;
  const r = Math.round(Math.min(w, h) * CORNER_RATIO);
  const inRounded = (x, y) => {
    let cx = x, cy = y;
    if (x < r && y < r) { cx = r; cy = r; }
    else if (x >= w - r && y < r) { cx = w - r; cy = r; }
    else if (x < r && y >= h - r) { cx = r; cy = h - r; }
    else if (x >= w - r && y >= h - r) { cx = w - r; cy = h - r; }
    else return 255;
    const dx = x - cx, dy = y - cy;
    const d = Math.sqrt(dx * dx + dy * dy);
    return Math.max(0, Math.min(255, Math.round((r - d + 0.5) * 255)));
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const mask = inRounded(x, y);
      if (mask < 255) data[i + 3] = Math.min(data[i + 3], mask);
    }
  }
  return img;
}

function crop(img, box) {
  const w = box.right - box.left + 1, h = box.bottom - box.top + 1;
  const out = new PNG({ width: w, height: h });
  PNG.bitblt(img, out, box.left, box.top, w, h, 0, 0);
  return out;
}

function icoFromPngs(entries) {
  // entries: [{size, data(Buffer of PNG)}] — Vista+ 支持 PNG 直接内嵌
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + 16 * entries.length;
  const blobs = [];
  entries.forEach((e, i) => {
    const o = i * 16;
    dir[o] = e.size >= 256 ? 0 : e.size;
    dir[o + 1] = e.size >= 256 ? 0 : e.size;
    dir[o + 2] = 0; dir[o + 3] = 0;
    dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(e.data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.data.length;
    blobs.push(e.data);
  });
  return Buffer.concat([header, dir, ...blobs]);
}

// ---- 主流程 ----
const src = decode();
const box = trimBbox(src);
console.log(`源图 ${src.width}x${src.height}，内容区 (${box.left},${box.top})-(${box.right},${box.bottom})`);
const trimmed = crop(src, box);
console.log(`裁剪后 ${trimmed.width}x${trimmed.height}`);

const square = Math.min(trimmed.width, trimmed.height);
const centered = (() => { // 居中取正方形
  const out = new PNG({ width: square, height: square });
  PNG.bitblt(trimmed, out, Math.floor((trimmed.width - square) / 2), Math.floor((trimmed.height - square) / 2), square, square, 0, 0);
  return out;
})();

const pngs = {};
for (const size of SIZES) {
  const img = roundCorners(resize(centered, size));
  pngs[size] = PNG.sync.write(img);
}
// 应用内品牌图（大一点）
fs.writeFileSync(path.join(__dirname, '..', 'renderer', 'pigeon-icon.png'), (() => {
  const img = roundCorners(resize(centered, 256));
  return PNG.sync.write(img);
})());
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'pigeon.ico'), icoFromPngs(SIZES.map(size => ({ size, data: pngs[size] }))));
fs.writeFileSync(path.join(OUT_DIR, 'pigeon-256.png'), pngs[256]);
console.log('生成完成: build/pigeon.ico +' + SIZES.join('/') + ' + renderer/pigeon-icon.png');

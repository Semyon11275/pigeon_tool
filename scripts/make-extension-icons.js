// 生成浏览器扩展图标：build/icon-source.png → extension/icons/icon{16,48,128}.png
// 用法：node scripts/make-extension-icons.js
'use strict';
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const SRC = path.join(__dirname, '..', 'build', 'icon-source.png');
const OUT_DIR = path.join(__dirname, '..', 'extension', 'icons');
const SIZES = [16, 48, 128];

// 双线性缩放（小尺寸图标用最近邻会糊边）
function resize(src, w, h) {
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = (x + 0.5) * src.width / w - 0.5;
      const sy = (y + 0.5) * src.height / h - 0.5;
      const x0 = Math.max(0, Math.floor(sx)), x1 = Math.min(src.width - 1, x0 + 1);
      const y0 = Math.max(0, Math.floor(sy)), y1 = Math.min(src.height - 1, y0 + 1);
      const fx = sx - x0, fy = sy - y0;
      for (let c = 0; c < 4; c++) {
        const p00 = src.data[(y0 * src.width + x0) * 4 + c];
        const p10 = src.data[(y0 * src.width + x1) * 4 + c];
        const p01 = src.data[(y1 * src.width + x0) * 4 + c];
        const p11 = src.data[(y1 * src.width + x1) * 4 + c];
        out.data[(y * w + x) * 4 + c] =
          (p00 * (1 - fx) + p10 * fx) * (1 - fy) + (p01 * (1 - fx) + p11 * fx) * fy;
      }
    }
  }
  return out;
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const src = PNG.sync.read(fs.readFileSync(SRC));
for (const s of SIZES) {
  fs.writeFileSync(path.join(OUT_DIR, `icon${s}.png`), PNG.sync.write(resize(src, s, s)));
  console.log('icon', s, 'done');
}

// 生成性能测试库（P2-01 基线/优化对比用）：N 个条目 + 缩略图，不依赖真实数据。
// 用法：node scripts/make-perf-library.js [数量，默认 2000]
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const { PNG } = require('pngjs');
const lib = require('../lib/library');

const N = parseInt(process.argv[2], 10) || 2000;
const root = process.argv[3] || path.join(os.tmpdir(), 'pigeon-perf.pigeon');

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ table[(c ^ buf[i]) & 0xFF];
  return (c ^ -1) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function makePng(w, h, top, bottom) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const off = y * (1 + w * 3);
    raw[off] = 0;
    const tt = h > 1 ? y / (h - 1) : 0;
    for (let x = 0; x < w; x++) {
      raw[off + 1 + x * 3] = Math.round(top[0] + (bottom[0] - top[0]) * tt + (x % 7) * 2);
      raw[off + 2 + x * 3] = Math.round(top[1] + (bottom[1] - top[1]) * tt);
      raw[off + 3 + x * 3] = Math.round(top[2] + (bottom[2] - top[2]) * tt);
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw, { level: 1 })), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

(async () => {
  const t0 = Date.now();
  fs.rmSync(root, { recursive: true, force: true });
  await lib.createLibrary(root, '性能测试库');
  const f1 = await lib.addFolder(root, '分类一');
  const f2 = await lib.addFolder(root, '分类二', f1.id);
  const palette = [
    [[46, 204, 113], [26, 188, 156]], [[52, 152, 219], [155, 89, 182]],
    [[241, 196, 15], [230, 126, 34]], [[149, 165, 166], [44, 62, 80]],
  ];
  const shapes = [[320, 200], [200, 320], [240, 240], [400, 160]];
  const tagPool = ['海报', '插画', '摄影', '截图', '纹理', '网页', '图标'];
  const nameBase = ['素材', '参考', '灵感', '草稿'];
  for (let i = 0; i < N; i++) {
    const [w, h] = shapes[i % shapes.length];
    const [top, bottom] = palette[i % palette.length];
    const bigW = 320 + (i % 8) * 260, bigH = Math.round(bigW * h / w); // 元数据里的"原尺寸"做差异化
    const item = await lib.createItemFromBuffer(root, {
      buffer: makePng(40, 30, top, bottom), // 原件用小图（性能测试不测解码）
      name: `${nameBase[i % 4]} ${String(i).padStart(5, '0')}`,
      ext: 'png',
      folderIds: i % 5 === 0 ? [f1.id] : i % 11 === 0 ? [f1.id, f2.id] : [],
      url: '', srcUrl: '',
    });
    const patch = { width: bigW, height: bigH, btime: Date.now() - (N - i) * 3600e3, rating: i % 6 };
    const tags = [];
    if (i % 3 === 0) tags.push(tagPool[i % tagPool.length]);
    if (i % 7 === 0) tags.push('多标签');
    if (tags.length) patch.tags = tags;
    await lib.updateItem(root, item.id, patch);
    // 缩略图（160px 档，快速生成）
    fs.writeFileSync(path.join(lib.itemDir(root, item.id), 'thumbnail.png'), makePng(160, Math.round(160 * h / w), top, bottom));
    if (i % 500 === 0) console.log('built', i, '/', N, ((Date.now() - t0) / 1000).toFixed(1) + 's');
  }
  console.log(`性能库就绪：${root}（${N} 条，含缩略图，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`);
})();

// 生成截图套件（PIGEON_SHOT=1）用的独立测试资料库，并写入开发配置的 lastLibrary。
// 用法：node scripts/make-shot-library.js [库路径]
// 库里是程序生成的纯色/渐变 PNG（尺寸、颜色、标签、评分、文件夹多样），
// 不引用任何真实资料库；删除即可清理。
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const lib = require('../lib/library');

const positional = process.argv.slice(2).filter(a => !a.startsWith('--'));
const APPLY = process.argv.includes('--apply');
const root = positional[0] || path.join(os.tmpdir(), 'pigeon-shot-lib.pigeon');

// ---- 纯色/双色 PNG 生成（与 main.js 的 makePng 同思路，独立复制以免循环依赖） ----
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
    const t = h > 1 ? y / (h - 1) : 0;
    const rgb = [
      Math.round(top[0] + (bottom[0] - top[0]) * t),
      Math.round(top[1] + (bottom[1] - top[1]) * t),
      Math.round(top[2] + (bottom[2] - top[2]) * t),
    ];
    for (let x = 0; x < w; x++) {
      raw[off + 1 + x * 3] = rgb[0]; raw[off + 2 + x * 3] = rgb[1]; raw[off + 3 + x * 3] = rgb[2];
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

(async () => {
  await fs.rmSync(root, { recursive: true, force: true });
  await lib.createLibrary(root, '截图测试库');
  const f1 = await lib.addFolder(root, '书籍排版');
  const f2 = await lib.addFolder(root, '字体', f1.id);
  const palette = [
    [[46, 204, 113], [26, 188, 156]], [[52, 152, 219], [155, 89, 182]],
    [[241, 196, 15], [230, 126, 34]], [[231, 76, 60], [214, 69, 65]],
    [[149, 165, 166], [44, 62, 80]], [[243, 156, 18], [241, 196, 15]],
  ];
  const shapes = [[1600, 900], [900, 1400], [1200, 1200], [800, 600], [2000, 640]];
  let n = 0;
  for (let i = 0; i < 18; i++) {
    const [w, h] = shapes[i % shapes.length];
    const [top, bottom] = palette[i % palette.length];
    const item = await lib.createItemFromBuffer(root, {
      buffer: makePng(w, h, top, bottom),
      name: '测试素材 ' + String(++n).padStart(2, '0'), ext: 'png',
      folderIds: i % 4 === 0 ? [f1.id] : i % 7 === 0 ? [f1.id, f2.id] : [],
    });
    await lib.updateItem(root, item.id, {
      tags: i % 3 === 0 ? ['海报'] : i % 3 === 1 ? ['蓝色', '渐变'] : ['素材'],
      rating: i % 5, star: i % 6 === 0,
    });
  }
  // 一张进回收站（回收站视图有内容）
  const del = await lib.createItemFromBuffer(root, { buffer: makePng(400, 300, [100, 100, 100], [40, 40, 40]), name: '已删除样例', ext: 'png' });
  await lib.updateItem(root, del.id, { isDeleted: true });

  // 视觉核查素材（P2-04）：超长文件名 + 大量标签
  const longName = '超长文件名样例-排版参考-第' + '零一二三四五六七八九'.repeat(4) + '号-视觉边界测试';
  const longItem = await lib.createItemFromBuffer(root, { buffer: makePng(800, 500, [243, 156, 18], [241, 196, 15]), name: longName.slice(0, 60), ext: 'png' });
  await lib.updateItem(root, longItem.id, { tags: ['海报', '插画', '摄影', '截图', '纹理', '网页', '图标', '排版', '参考', '灵感', '草稿', '多标签'] });
  const manyTags = await lib.createItemFromBuffer(root, { buffer: makePng(600, 600, [52, 152, 219], [155, 89, 182]), name: '大量标签样例', ext: 'png' });
  await lib.updateItem(root, manyTags.id, { tags: ['标签一', '标签二', '标签三', '标签四', '标签五', '标签六', '标签七', '标签八', '标签九', '标签十', '标签十一', '标签十二'] });

  // 配置隔离：默认不改开发配置，只打印路径；显式传 --apply 才写入 lastLibrary
  if (APPLY) {
    const cfgPath = path.join(process.env.APPDATA || '', 'Pigeon', 'config.json');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      cfg.lastLibrary = root;
      const libs = new Set([root, ...(cfg.libraries || []).filter(p => !/pigeon-shot-lib\.pigeon$/i.test(p))]);
      cfg.libraries = [...libs].slice(0, 12);
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
      console.log('已写入开发配置 lastLibrary =', root);
    } else {
      console.warn('未找到开发配置，请手动打开该库：', root);
    }
  } else {
    console.log('未写入配置（加 --apply 可设为开发模式的当前库）');
  }
  console.log('截图测试库就绪：', root, '（条目 19，含回收站 1）');
})();

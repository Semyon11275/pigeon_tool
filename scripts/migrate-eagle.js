// 一次性迁移脚本：把 Eagle 资料库复制成 Pigeon 库（不改动原库）
// 用法: node scripts/migrate-eagle.js <eagle库路径> <pigeon库路径>
'use strict';
const path = require('path');
const lib = require('../lib/library');

async function main() {
  const src = process.argv[2] || 'E:\\eagel资源库\\素材.library';
  const dest = process.argv[3] || path.join(require('os').homedir(), 'Documents', 'Pigeon', '素材.pigeon');
  console.log('Eagle 库 :', src);
  console.log('Pigeon 库 :', dest);
  const t0 = Date.now();
  const r = await lib.importFromEagle(src, dest, (done, total) => {
    process.stdout.write(`\r导入中 ${done}/${total}`);
  });
  const items = await lib.scanItems(dest);
  const meta = await lib.openLibrary(dest);
  console.log(`\n完成：${r.total} 个源条目，${items.length} 个成功导入，${meta.folders.length} 个顶层文件夹，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch(e => { console.error(e); process.exit(1); });

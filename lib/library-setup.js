'use strict';
const path = require('path');
function safeName(name) {
  let value = String(name || '我的资料库').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').trim().slice(0, 80);
  if (!value || /^\.+$/.test(value)) value = '我的资料库';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) value = '_' + value;
  return value;
}
async function create(o) {
  const name = safeName(o.name);
  // Reserve an unused directory atomically; never overwrite an existing library.
  try { await o.fs.ensureDir(o.base); }
  catch (e) { throw new Error('无法在程序目录创建资料库，请将程序移到可写文件夹后重试：' + o.base + '（' + e.message + '）'); }
  let root;
  for (let n = 1; ; n++) {
    root = path.join(o.base, name + (n === 1 ? '' : ' ' + n) + '.pigeon');
    try { await o.fs.mkdir(root); break; }
    catch (e) { if (e.code !== 'EEXIST') throw new Error('无法在程序目录创建资料库，请将程序移到可写文件夹后重试：' + o.base + '（' + e.message + '）'); }
  }
  const meta = await o.createLibrary(root, name);
  const result = { root, meta, shortcuts: [], warning: '' };
  if (o.shortcuts) {
    const links = [
      { name: 'Pigeon', details: { target: o.executable, args: o.packaged ? '' : '"' + o.appDir + '"', cwd: o.packaged ? path.dirname(o.executable) : o.appDir, description: '打开 Pigeon 素材管理器', ...(o.icon ? { icon: o.icon, iconIndex: 0 } : {}) } },
      { name: 'Pigeon - ' + path.basename(root, '.pigeon'), details: { target: root, description: '打开 Pigeon 资料库文件夹' } },
    ];
    for (const link of links) {
      // A development run must not add another launcher beside an installed Pigeon.
      if (link.name === 'Pigeon' && await o.fs.pathExists(path.join(o.desktop, 'Pigeon.lnk'))) continue;
      try {
        let file = path.join(o.desktop, link.name + '.lnk'), n = 2;
        while (await o.fs.pathExists(file)) file = path.join(o.desktop, link.name + ' (' + n++ + ').lnk');
        if (!o.writeShortcut(file, link.details)) throw new Error('系统未能写入快捷方式');
        result.shortcuts.push(file);
      } catch (e) { result.warning += '资料库已保留，但桌面快捷方式「' + link.name + '」创建失败：' + e.message + '\n'; }
    }
  }
  return result;
}
module.exports = { create, safeName };

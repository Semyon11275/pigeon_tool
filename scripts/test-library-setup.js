'use strict';
const assert = require('assert/strict');
const fs = require('fs-extra');
const path = require('path');
const { create } = require('../lib/library-setup');
const lib = require('../lib/library');
(async () => {
  if (!process.env.PIGEON_TEST_TMP) throw new Error('PIGEON_TEST_TMP required');
  const dir = await fs.mkdtemp(path.join(process.env.PIGEON_TEST_TMP, 'library-setup-'));
  const links = [];
  const options = { fs, base: path.join(dir, '程序', 'data', 'libraries'), name: '../我的资料库', createLibrary: lib.createLibrary,
    shortcuts: true, desktop: path.join(dir, '桌面'), executable: 'E:\\Pigeon\\electron.exe', appDir: 'E:\\开发 目录\\Pigeon', packaged: false, icon: 'E:\\Pigeon\\resources\\pigeon.ico',
    writeShortcut(file, details) { links.push({file, details}); fs.outputFileSync(file, 'fixture'); return true; } };
  const a = await create(options), b = await create(options);
  assert.notEqual(a.root, b.root);
  assert.equal(path.dirname(a.root), options.base);
  assert.ok(await fs.pathExists(path.join(a.root, 'metadata.json')));
  assert.equal(new Set(links.map(x => x.file)).size, 3);
  assert.equal(links[0].details.args, '"E:\\开发 目录\\Pigeon"');
  assert.equal(links[1].details.target, a.root);
  assert.equal(links.filter(x => path.basename(x.file) === 'Pigeon.lnk').length, 1);
  assert.equal(links[0].details.icon, options.icon);
  assert.equal(links[0].details.iconIndex, 0);
  const c = await create({...options, writeShortcut() { throw new Error('denied'); }});
  assert.ok(c.warning.includes('denied'));
  assert.ok(await fs.pathExists(path.join(c.root, 'metadata.json')));
  const d = await create({...options, shortcuts: false, writeShortcut() { throw new Error('must not call'); }});
  assert.equal(d.shortcuts.length, 0);
  console.log('PASS: automatic location, safe name, distinct libraries/links, development launch arguments, shortcut failure preserves library, opt-out');
})().catch(e => { console.error(e); process.exitCode = 1; });

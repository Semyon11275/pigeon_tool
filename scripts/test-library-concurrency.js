'use strict';
// Real library functions; filesystem-only memory double. No user library/config writes.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = process.argv.includes('--baseline')
  ? require('node:child_process').execFileSync('git', ['show', '7082727:lib/library.js'], { encoding: 'utf8' })
  : fs.readFileSync(path.join(__dirname, '../lib/library.js'), 'utf8');
async function check(operation, removedBeforeLock) {
  const root = path.resolve('memory-only');
  const itemPath = path.join(root, 'images', 'I.info', 'metadata.json');
  const clone = x => JSON.parse(JSON.stringify(x));
  const data = new Map();
  let lib, armed = true, injected = false;
  const memoryFs = {
    ensureDir: async () => {}, readdir: async () => ['I.info'],
    writeJson: async (p, x) => data.set(p, clone(x)),
    rename: async (a, b) => { assert(data.has(a)); data.set(b, data.get(a)); data.delete(a); },
    remove: async p => data.delete(p),
    readJson: async p => {
      if (!data.has(p)) {
        assert.equal(path.basename(p), 'metadata.json');
        return { folders: [{ id: 'A', children: [] }, { id: 'B', children: [] }], smartFolders: [], tagsGroups: [] };
      }
      const snapshot = clone(data.get(p));
      // The scan keeps its old snapshot while an actual updateItem writes newer state.
      if (p === itemPath && armed) {
        armed = false; injected = true;
        await lib.updateItem(root, 'I', {
          tags: removedBeforeLock ? ['user-added'] : ['old', 'user-added'],
          folders: removedBeforeLock ? ['B'] : ['A', 'B'], rating: 5,
        });
      }
      return snapshot;
    },
  };
  const ctx = { module: { exports: {} }, require: n => n === 'fs-extra' ? memoryFs : require(n), process, setTimeout, Buffer };
  vm.runInNewContext(source, ctx);
  lib = ctx.module.exports;
  data.set(itemPath, { id: 'I', name: 'item', ext: 'png', tags: ['old'], folders: ['A'], rating: 0 });
  let result;
  if (operation === 'renameTag') result = await lib.renameTag(root, 'old', 'new');
  if (operation === 'mergeTags') result = await lib.mergeTags(root, ['old'], 'new');
  if (operation === 'deleteTag') result = await lib.deleteTag(root, 'old');
  if (operation === 'removeFolder') result = await lib.removeFolder(root, 'A');
  const final = data.get(itemPath);
  assert(injected, 'interleave must actually execute');
  assert.equal(final.rating, 5);
  if (operation === 'removeFolder') assert.deepEqual(final.folders, ['B']);
  else {
    const expected = removedBeforeLock || operation === 'deleteTag' ? ['user-added'] : operation === 'renameTag' ? ['new', 'user-added'] : ['user-added', 'new'];
    assert.deepEqual(final.tags, expected);
    assert.equal(result.updated, removedBeforeLock ? 0 : 1);
    assert.equal(result.failures.length, 0);
  }
}
(async () => {
  let failures = 0;
  for (const operation of ['renameTag', 'mergeTags', 'deleteTag', 'removeFolder']) {
    for (const removed of [false, true]) {
      const label = operation + (removed ? ': recheck latest condition' : ': preserve concurrent addition');
      try { await check(operation, removed); console.log('PASS ' + label); }
      catch (e) { failures++; console.error('FAIL ' + label + ': ' + e.message); }
    }
  }
  console.log('LIBRARY_CONCURRENCY ' + (8 - failures) + '/8');
  process.exitCode = failures ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });

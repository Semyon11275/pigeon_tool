// Pigeon — 资料库核心逻辑（纯 Node，不依赖 Electron，可单独测试）
// 数据格式与 Eagle .library 兼容：每个条目一个 .info 文件夹（原文件 + thumbnail.png + metadata.json）
'use strict';
const fs = require('fs-extra');
const path = require('path');

const ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
function genId() {
  let s = '';
  for (let i = 0; i < 12; i++) s += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
  return s;
}

function nowMs() { return Date.now(); }

// ---------- 图像尺寸探测（手写头解析，jpg/png/gif/webp/bmp） ----------
function probeImageSize(buf) {
  if (buf.length < 24) return null;
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // GIF
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  // BMP
  if (buf[0] === 0x42 && buf[1] === 0x4d) {
    return { width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)) };
  }
  // WEBP (VP8/VP8L/VP8X)
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const fourcc = buf.toString('ascii', 12, 16);
    if (fourcc === 'VP8 ' && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (fourcc === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    if (fourcc === 'VP8X') {
      return { width: (buf.readUIntLE(24, 3)) + 1, height: (buf.readUIntLE(27, 3)) + 1 };
    }
  }
  // JPEG
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) { off++; continue; }
      const marker = buf[off + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
      }
      const len = buf.readUInt16BE(off + 2);
      off += 2 + len;
    }
  }
  return null;
}

// ---------- 库的创建与打开 ----------
function libraryFilePath(root) { return path.join(root, 'metadata.json'); }
function imagesDir(root) { return path.join(root, 'images'); }

async function createLibrary(root, name) {
  await fs.ensureDir(imagesDir(root));
  const meta = {
    folders: [], smartFolders: [], quickAccess: [], tagsGroups: [],
    modificationTime: nowMs(), applicationVersion: 'Pigeon 0.3.0', name: name || path.basename(root).replace(/\.pigeon$/, ''),
  };
  await fs.writeJson(libraryFilePath(root), meta, { spaces: 2 });
  await fs.writeJson(path.join(root, 'tags.json'), { historyTags: [], starredTags: [] }, { spaces: 2 });
  return meta;
}

async function openLibrary(root) {
  const meta = await fs.readJson(libraryFilePath(root));
  meta.__root = root;
  return meta;
}

async function saveLibraryMeta(root, meta) {
  const copy = Object.assign({}, meta);
  delete copy.__root;
  copy.modificationTime = nowMs();
  await jsonAtomicWrite(libraryFilePath(root), copy);
}

// ---------- 数据可靠性：原子写入 + 素材级锁 ----------
// 原子写：先写同目录临时文件，再用原生 fs.rename 原子替换（libuv 在 POSIX/Windows
// 均为单步替换语义；不要用 fs.move——其 overwrite 实现是"先删目标再改名"，中间失败旧文件已丢）。
// 临时文件名含 pid+时间戳+随机段，并发写入互不冲突；替换失败时尽力清理临时文件、旧文件保持可读。
let _renameForTest = null; // 测试注入（模拟替换失败/延迟），生产为 null
// Windows 上目标文件被并发读者瞬时占用时 rename 会 EPERM——按错误码退避重试，
// 每次尝试本身仍是原子替换；无错误码（测试注入）或不可重试错误立即抛出
async function renameWithRetry(a, b, tries = 10) {
  for (let i = 0; ; i++) {
    try {
      return await fs.rename(a, b);
    } catch (e) {
      const retryable = e && ['EPERM', 'EACCES', 'EBUSY', 'EAGAIN'].includes(e.code);
      if (!retryable || i >= tries) throw e;
      await new Promise(r => setTimeout(r, 5 + i * 10));
    }
  }
}
async function jsonAtomicWrite(file, obj) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await fs.writeJson(tmp, obj, { spaces: 2 });
  const doRename = _renameForTest || renameWithRetry;
  try {
    await doRename(tmp, file);
  } catch (e) {
    await fs.remove(tmp).catch(() => {});
    throw e;
  }
}
function jsonAtomicWriteSync(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

// 素材级串行锁：同一素材的读-改-写排队执行，并发补丁不会互相覆盖字段；
// 锁在结束后自动清理，不随库增长泄漏
const itemLocks = new Map(); // id → 尾部 Promise
function withItemLock(id, fn) {
  const run = (itemLocks.get(id) || Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => {});
  itemLocks.set(id, tail);
  tail.then(() => { if (itemLocks.get(id) === tail) itemLocks.delete(id); });
  return run;
}
// 库级元数据「读-改-写」串行锁：addFolder/removeFolder/标签引用更新/默认标签/
// 智能文件夹写入等并发操作不会互相覆盖（锁顺序恒为 meta→item，无死锁）
function withMetaLock(root, fn) { return withItemLock('meta:' + root, fn); }

async function scanItems(root) {
  const dir = imagesDir(root);
  const entries = await fs.readdir(dir);
  const items = [];
  for (const name of entries) {
    if (!name.endsWith('.info')) continue;
    try {
      const m = await fs.readJson(path.join(dir, name, 'metadata.json'));
      items.push(m);
    } catch (e) { /* 跳过损坏条目 */ }
  }
  return items;
}

function itemDir(root, id) { return path.join(imagesDir(root), id + '.info'); }
async function readItem(root, id) { return fs.readJson(path.join(itemDir(root, id), 'metadata.json')); }
// writeItem 也纳入素材级锁（外部直接调用不再绕过并发保护）；
// updateItemLocked 已持锁，内部走无锁的 writeItemLocked（锁不可重入，避免自锁）
async function writeItem(root, item) {
  return withItemLock(item.id, () => writeItemLocked(root, item));
}
async function writeItemLocked(root, item) {
  const dir = itemDir(root, item.id);
  await fs.ensureDir(dir);
  item.lastModified = nowMs();
  await jsonAtomicWrite(path.join(dir, 'metadata.json'), item);
  return item;
}

// ---------- 文件夹 ----------
function findFolder(folders, id, parent = null) {
  for (const f of folders) {
    if (f.id === id) return { folder: f, parent, list: folders };
    const hit = findFolder(f.children || [], id, f);
    if (hit) return hit;
  }
  return null;
}

async function addFolder(root, name, parentId = null) {
  return withMetaLock(root, async () => {
    const meta = await openLibrary(root);
    const folder = { id: genId(), name: name || '未命名文件夹', description: '', children: [], modificationTime: nowMs(), tags: [], password: '', passwordTips: '', defaultTags: [] };
    if (parentId) {
      const hit = findFolder(meta.folders, parentId);
      if (!hit) throw new Error('父文件夹不存在');
      hit.folder.children.push(folder);
    } else {
      meta.folders.push(folder);
    }
    await saveLibraryMeta(root, meta);
    return folder;
  });
}

async function renameFolder(root, id, name) {
  return withMetaLock(root, async () => {
    const meta = await openLibrary(root);
    const hit = findFolder(meta.folders, id);
    if (!hit) throw new Error('文件夹不存在');
    hit.folder.name = name;
    hit.folder.modificationTime = nowMs();
    await saveLibraryMeta(root, meta);
  });
}

// 收集文件夹自身与全部后代 id（删除时需一并清理素材关联）
function collectFolderIds(folder, out = []) {
  out.push(folder.id);
  for (const c of folder.children || []) collectFolderIds(c, out);
  return out;
}

async function removeFolder(root, id) {
  return withMetaLock(root, async () => {
    const meta = await openLibrary(root);
    const hit = findFolder(meta.folders, id);
    if (!hit) throw new Error('文件夹不存在');
    // 从树上摘掉的是整个子树（children 随节点一起移除）
    const removedIds = collectFolderIds(hit.folder);
    hit.list.splice(hit.list.indexOf(hit.folder), 1);
    await saveLibraryMeta(root, meta);
    // 从所有条目上摘掉被删除的全部文件夹 id（含子文件夹，避免残留失效关联）。
    // 扫描只筛候选；归属清理在锁内基于最新 folders 数组过滤——扫描后素材
    // 并发加入的其他文件夹不会被旧快照算出的数组覆盖
    const removedSet = new Set(removedIds);
    const items = await module.exports.scanItems(root);
    for (const it of items) {
      if (!(it.folders || []).some(f => removedSet.has(f))) continue;
      await mergeIntoItem(root, it.id, (fresh) => {
        if (!(fresh.folders || []).some(f => removedSet.has(f))) return;
        fresh.folders = (fresh.folders || []).filter(f => !removedSet.has(f));
      });
    }
    return removedIds;
  });
}

// ---------- 标签操作（P1-01）：条目、智能文件夹（条件+范围）、标签群组、文件夹默认标签四处引用同步 ----------
// 更新库元数据里的全部标签引用；失败时 saveLibraryMeta 抛错（元数据保持旧内容，可安全重试）
async function patchTagRefsInMeta(root, fn) {
  return withMetaLock(root, async () => {
    const meta = await openLibrary(root);
    for (const sf of meta.smartFolders || []) {
      const f = sf.filter || {};
      if (Array.isArray(f.tags)) f.tags = [...new Set(fn(f.tags))];
      // 智能文件夹的标签范围引用（scope.kind === 'tag' 时 scope.id 是标签名）
      if (f.scope && f.scope.kind === 'tag' && typeof f.scope.id === 'string') {
        const mapped = fn([f.scope.id]);
        if (!mapped.length || !mapped[0]) {
          delete f.scope; // 范围标签被删除：范围失效，应用时回退全部素材
        } else if (mapped[0] !== f.scope.id) {
          f.scope.id = mapped[0];
          f.scope.label = '#' + mapped[0];
        }
      }
    }
    for (const g of meta.tagsGroups || []) {
      if (Array.isArray(g.tags)) g.tags = [...new Set(fn(g.tags))];
    }
    // 文件夹默认标签（含全部子文件夹）
    const walkFolders = (list) => list.forEach(fd => {
      if (Array.isArray(fd.defaultTags)) fd.defaultTags = [...new Set(fn(fd.defaultTags))];
      if (fd.children) walkFolders(fd.children);
    });
    walkFolders(meta.folders || []);
    await saveLibraryMeta(root, meta);
  });
}

async function renameTag(root, oldTag, newTag) {
  if (!oldTag || !newTag || oldTag === newTag) return { updated: 0, failures: [] };
  const failures = [];
  let updated = 0;
  // 扫描只用于筛候选；标签替换在锁内基于最新数组计算并复判条件——
  // 扫描后用户并发新增的标签不会被旧快照算出的数组覆盖
  for (const it of await module.exports.scanItems(root)) {
    if (!(it.tags || []).includes(oldTag)) continue;
    try {
      let hit = false;
      await mergeIntoItem(root, it.id, (fresh) => {
        const cur = fresh.tags || [];
        if (!cur.includes(oldTag)) return; // 锁内复判：候选条件可能已被并发操作改掉
        hit = true;
        fresh.tags = [...new Set(cur.map(t => (t === oldTag ? newTag : t)))];
      });
      if (hit) updated++;
    } catch (e) { failures.push({ id: it.id, error: String((e && e.message) || e) }); }
  }
  await patchTagRefsInMeta(root, list => list.map(t => (t === oldTag ? newTag : t)));
  return { updated, failures };
}

async function mergeTags(root, sources, target) {
  const src = [...new Set((sources || []).filter(t => t && t !== target))];
  if (!src.length || !target) return { updated: 0, failures: [] };
  const srcSet = new Set(src);
  const failures = [];
  let updated = 0;
  for (const it of await module.exports.scanItems(root)) {
    if (!(it.tags || []).some(t => srcSet.has(t))) continue;
    try {
      let hit = false;
      await mergeIntoItem(root, it.id, (fresh) => {
        const cur = fresh.tags || [];
        if (!cur.some(t => srcSet.has(t))) return; // 锁内复判
        hit = true;
        fresh.tags = [...new Set([...cur.filter(t => !srcSet.has(t)), target])];
      });
      if (hit) updated++;
    } catch (e) { failures.push({ id: it.id, error: String((e && e.message) || e) }); }
  }
  await patchTagRefsInMeta(root, list => list.map(t => (srcSet.has(t) ? target : t)));
  return { updated, failures };
}

async function deleteTag(root, tag) {
  if (!tag) return { updated: 0, failures: [] };
  const failures = [];
  let updated = 0;
  for (const it of await module.exports.scanItems(root)) {
    if (!(it.tags || []).includes(tag)) continue;
    try {
      let hit = false;
      await mergeIntoItem(root, it.id, (fresh) => {
        const cur = fresh.tags || [];
        if (!cur.includes(tag)) return; // 锁内复判
        hit = true;
        fresh.tags = cur.filter(t => t !== tag);
      });
      if (hit) updated++;
    } catch (e) { failures.push({ id: it.id, error: String((e && e.message) || e) }); }
  }
  await patchTagRefsInMeta(root, list => list.filter(t => t !== tag));
  return { updated, failures };
}

// ---------- 文件夹默认标签（P1-06） ----------
async function setFolderDefaultTags(root, folderId, tags) {
  return withMetaLock(root, async () => {
    const meta = await openLibrary(root);
    const hit = findFolder(meta.folders, folderId);
    if (!hit) throw new Error('文件夹不存在');
    hit.folder.defaultTags = [...new Set((tags || []).map(t => String(t).trim()).filter(Boolean))].slice(0, 20);
    await saveLibraryMeta(root, meta);
    return hit.folder.defaultTags;
  });
}
// 文件夹（含祖先链）默认标签并集：加入该文件夹时自动打上；移出时不回收
function folderDefaultTags(folders, folderId) {
  const chain = [];
  const walk = (list, trail) => {
    for (const f of list) {
      if (f.id === folderId) { chain.push(...trail, f); return true; }
      if (walk(f.children || [], [...trail, f])) return true;
    }
    return false;
  };
  if (!walk(folders || [], [])) return [];
  return [...new Set(chain.flatMap(f => f.defaultTags || []))];
}


// 锁内合并写：读取最新值 → mutator 直接修改其字段 → 落盘。
// 用于「在最新状态上合并」的写路径（AI 打标、扩展标签合并等）——调用方持有的
// 旧对象可能落后于用户并发修改，完整对象回写会把新字段覆盖回旧值。
// 完整对象写入（writeItem）仅限新建/迁移等调用方独占条目的场景。
async function mergeIntoItem(root, id, mutator) {
  return withItemLock(id, async () => {
    const fresh = await readItem(root, id);
    const allowed = ['name', 'tags', 'rating', 'annotation', 'folders', 'url', 'width', 'height', 'duration', 'palettes', 'size', 'ext', 'isDeleted', 'star', 'phash', 'exif'];
    const before = {};
    for (const k of allowed) before[k] = fresh[k];
    mutator(fresh);
    let changed = false;
    for (const k of allowed) if (fresh[k] !== before[k]) changed = true;
    if (!changed) return fresh;
    return module.exports.writeItemLocked(root, fresh);
  });
}

// ---------- 条目操作 ----------
// 同一素材的修改串行排队（字段级补丁基于锁内新读取合并，并发不丢字段）
async function updateItem(root, id, patch) {
  return withItemLock(id, () => updateItemLocked(root, id, patch));
}
async function updateItemLocked(root, id, patch) {
  const item = await readItem(root, id);
  let renamed = null;
  // 改名时同步磁盘上的原文件名（否则 pigeon:// 链接会失效）
  if (patch.name && patch.name !== item.name) {
    const dir = itemDir(root, id);
    const oldFile = path.join(dir, item.name + '.' + item.ext);
    let newName = patch.name;
    let newFile = path.join(dir, newName + '.' + item.ext);
    if (await fs.pathExists(oldFile)) {
      let n = 1;
      while ((await fs.pathExists(newFile)) && newFile.toLowerCase() !== oldFile.toLowerCase()) {
        newName = `${patch.name} (${n++})`;
        newFile = path.join(dir, newName + '.' + item.ext);
      }
      await fs.rename(oldFile, newFile);
      renamed = { oldFile, newFile };
      patch = Object.assign({}, patch, { name: newName });
    }
  }
  const allowed = ['name', 'tags', 'rating', 'annotation', 'folders', 'url', 'width', 'height', 'duration', 'palettes', 'size', 'ext', 'isDeleted', 'star', 'phash', 'exif'];
  for (const k of allowed) if (k in patch) item[k] = patch[k];
  try {
    // 经导出面调用无锁写入（已持素材锁）：测试可临时替换 writeItemLocked 模拟元数据写失败
    return await module.exports.writeItemLocked(root, item);
  } catch (e) {
    // 元数据写失败：把磁盘文件名恢复回去，避免出现文件新名/元数据旧名的不一致
    if (renamed) await fs.rename(renamed.newFile, renamed.oldFile).catch(() => {});
    throw e;
  }
}

// 从内存缓冲建立条目（URL 下载 / 剪贴板共用）
async function createItemFromBuffer(root, { buffer, name, ext, url, srcUrl, folderIds = [] }) {
  const id = genId();
  const dir = itemDir(root, id);
  await fs.ensureDir(dir);
  const safeName = (name || '未命名').replace(/[\\/:*?"<>|]/g, '_').trim() || '未命名';
  const file = path.join(dir, safeName + '.' + ext);
  await fs.writeFile(file, buffer);
  const stat = await fs.stat(file);
  let width = null, height = null;
  if (IMAGE_EXTS.has(ext) && ext !== 'svg') {
    try {
      const dim = probeImageSize(buffer);
      if (dim) { width = dim.width; height = dim.height; }
    } catch (e) {}
  }
  const item = {
    id, name: safeName, size: stat.size,
    btime: Date.now(), mtime: Date.now(), ext,
    tags: [], folders: folderIds.slice(), isDeleted: false,
    url: url || srcUrl || '', srcUrl: srcUrl || '', annotation: '', modificationTime: Date.now(),
    width, height, rating: 0, star: false, palettes: [],
  };
  if (VIDEO_EXTS.has(ext)) item.duration = null;
  await writeItem(root, item);
  return item;
}

async function md5File(filePath) {
  const crypto = require('crypto');
  return new Promise((res, rej) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath);
    stream.on('data', d => hash.update(d));
    stream.on('end', () => res(hash.digest('hex')));
    stream.on('error', rej);
  });
}

async function trashItems(root, ids, deleted = true) {
  for (const id of ids) await updateItem(root, id, { isDeleted: deleted });
}

// ---------- 导入 ----------
function defaultThumbnailName(originalName) {
  const ext = path.extname(originalName) || '';
  const base = path.basename(originalName, ext);
  return base + '_thumbnail.png';
}

// 从 Eagle .library 导入到 Pigeon 库（复制模式，绝不触碰原库）
async function importFromEagle(srcRoot, destRoot, onProgress) {
  const srcMeta = await openLibrary(srcRoot);
  let destMeta;
  try { destMeta = await openLibrary(destRoot); }
  catch (e) { destMeta = await createLibrary(destRoot, path.basename(destRoot).replace(/\.pigeon$/, '')); }

  // 1. 文件夹树直接复制（保留 id，条目的 folders 引用才有效）
  destMeta.folders = srcMeta.folders || [];
  destMeta.smartFolders = srcMeta.smartFolders || [];
  destMeta.tagsGroups = srcMeta.tagsGroups || [];
  await saveLibraryMeta(destRoot, destMeta);

  // 2. 逐条复制
  const srcItemsDir = path.join(srcRoot, 'images');
  const entries = (await fs.readdir(srcItemsDir)).filter(n => n.endsWith('.info'));
  let done = 0;
  for (const entry of entries) {
    const srcItemDir = path.join(srcItemsDir, entry);
    try {
      const m = await fs.readJson(path.join(srcItemDir, 'metadata.json'));
      const destItemDir = itemDir(destRoot, m.id);
      await fs.ensureDir(destItemDir);
      // 原文件
      const srcFile = path.join(srcItemDir, m.name + '.' + m.ext);
      if (await fs.pathExists(srcFile)) await fs.copy(srcFile, path.join(destItemDir, m.name + '.' + m.ext));
      // Eagle 的缩略图：<name>_thumbnail.png（可能还有 .gif 等），统一找
      const srcFiles = await fs.readdir(srcItemDir);
      const thumb = srcFiles.find(f => f.endsWith('_thumbnail.png')) || srcFiles.find(f => /thumbnail/i.test(f));
      if (thumb) await fs.copy(path.join(srcItemDir, thumb), path.join(destItemDir, 'thumbnail.png'));
      // 元数据（补 Pigeon 字段）
      const destMetaItem = Object.assign({}, m, { rating: m.rating || 0, star: m.star || false });
      await writeItem(destRoot, destMetaItem);
    } catch (e) { /* 单条失败不影响整体 */ }
    done++;
    if (onProgress && done % 10 === 0) onProgress(done, entries.length);
  }
  if (onProgress) onProgress(entries.length, entries.length);
  return { total: entries.length };
}

// 展开路径：目录递归收集文件（跳过 .info、隐藏文件、库自身文件）
async function expandPaths(paths) {
  const out = [];
  const SKIP_NAMES = new Set(['metadata.json', 'tags.json', 'actions.json', 'mtime.json', 'saved-filters.json', 'Desktop.ini', 'Thumbs.db']);
  async function walk(p) {
    const stat = await fs.stat(p);
    if (stat.isFile()) {
      const base = path.basename(p);
      if (!base.startsWith('.') && !SKIP_NAMES.has(base) && !base.endsWith('_thumbnail.png')) out.push(p);
      return;
    }
    if (stat.isDirectory()) {
      if (p.endsWith('.info') || p.endsWith('.library') || p.endsWith('.pigeon')) return;
      for (const name of await fs.readdir(p)) await walk(path.join(p, name));
    }
  }
  for (const p of paths) await walk(p);
  return out;
}

// 从本机文件导入（复制进库 + 生成元数据；缩略图/尺寸由渲染进程补齐）
const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg']);
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v']);

async function importFiles(root, srcPaths, folderIds = []) {
  const files = await expandPaths(srcPaths);
  const created = [];
  const failures = [];
  for (const src of files) {
    try {
      const stat = await fs.stat(src);
      if (!stat.isFile()) continue;
      const ext = path.extname(src).slice(1).toLowerCase();
      if (!ext) continue;
      const id = genId();
      const name = path.basename(src, path.extname(src));
      const dir = itemDir(root, id);
      await fs.ensureDir(dir);
      const destFile = path.join(dir, name + '.' + ext);
      await fs.copy(src, destFile);

      let width = null, height = null;
      if (IMAGE_EXTS.has(ext) && ext !== 'svg') {
        try {
          const fsp = require('fs').promises;
          const fh = await fsp.open(destFile, 'r');
          const buf = Buffer.alloc(Math.min(1024 * 256, stat.size));
          await fh.read(buf, 0, buf.length, 0);
          await fh.close();
          const dim = probeImageSize(buf);
          if (dim) { width = dim.width; height = dim.height; }
        } catch (e) { /* 尺寸探测失败不阻塞导入 */ }
      }
      const item = {
        id, name, size: stat.size,
        btime: stat.birthtimeMs || nowMs(), mtime: stat.mtimeMs,
        ext, tags: [], folders: folderIds.slice(), isDeleted: false,
        url: '', annotation: '', modificationTime: nowMs(),
        width, height, rating: 0, star: false,
        palettes: [],
      };
      if (VIDEO_EXTS.has(ext)) item.duration = null;
      await writeItem(root, item);
      created.push(item);
    } catch (e) {
      // 单文件失败不影响整体，但要可追踪（供自动导入/批量导入报告）
      failures.push({ src, error: String((e && e.message) || e).slice(0, 120) });
    }
  }
  created.failures = failures;
  return created;
}

module.exports = {
  genId, probeImageSize, createLibrary, openLibrary, saveLibraryMeta, scanItems,
  readItem, writeItem, writeItemLocked, addFolder, renameFolder, removeFolder, updateItem, trashItems,
  importFromEagle, importFiles, expandPaths, createItemFromBuffer, md5File, itemDir, imagesDir,
  IMAGE_EXTS, VIDEO_EXTS, collectFolderIds, findFolder,
  jsonAtomicWrite, renameWithRetry, withItemLock, withMetaLock, mergeIntoItem,
  renameTag, mergeTags, deleteTag, setFolderDefaultTags, folderDefaultTags,
};
// 注意：须在 module.exports 赋值之后再挂访问器（否则会被整体替换掉）
Object.defineProperty(module.exports, '__renameForTest', {
  get: () => _renameForTest,
  set: (v) => { _renameForTest = v; },
});

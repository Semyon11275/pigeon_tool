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
  await fs.writeJson(libraryFilePath(root), copy, { spaces: 2 });
}

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
async function writeItem(root, item) {
  const dir = itemDir(root, item.id);
  await fs.ensureDir(dir);
  item.lastModified = nowMs();
  await fs.writeJson(path.join(dir, 'metadata.json'), item, { spaces: 2 });
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
  const meta = await openLibrary(root);
  const folder = { id: genId(), name: name || '未命名文件夹', description: '', children: [], modificationTime: nowMs(), tags: [], password: '', passwordTips: '' };
  if (parentId) {
    const hit = findFolder(meta.folders, parentId);
    if (!hit) throw new Error('父文件夹不存在');
    hit.folder.children.push(folder);
  } else {
    meta.folders.push(folder);
  }
  await saveLibraryMeta(root, meta);
  return folder;
}

async function renameFolder(root, id, name) {
  const meta = await openLibrary(root);
  const hit = findFolder(meta.folders, id);
  if (!hit) throw new Error('文件夹不存在');
  hit.folder.name = name;
  hit.folder.modificationTime = nowMs();
  await saveLibraryMeta(root, meta);
}

async function removeFolder(root, id) {
  const meta = await openLibrary(root);
  const hit = findFolder(meta.folders, id);
  if (!hit) throw new Error('文件夹不存在');
  hit.list.splice(hit.list.indexOf(hit.folder), 1);
  await saveLibraryMeta(root, meta);
  // 从所有条目上摘掉这个文件夹
  const items = await scanItems(root);
  for (const it of items) {
    if (it.folders && it.folders.includes(id)) {
      it.folders = it.folders.filter(f => f !== id);
      await writeItem(root, it);
    }
  }
}

// ---------- 条目操作 ----------
async function updateItem(root, id, patch) {
  const item = await readItem(root, id);
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
      patch = Object.assign({}, patch, { name: newName });
    }
  }
  const allowed = ['name', 'tags', 'rating', 'annotation', 'folders', 'url', 'width', 'height', 'duration', 'palettes', 'size', 'ext', 'isDeleted', 'star', 'phash', 'exif'];
  for (const k of allowed) if (k in patch) item[k] = patch[k];
  return writeItem(root, item);
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
    } catch (e) { /* 跳过失败文件 */ }
  }
  return created;
}

module.exports = {
  genId, probeImageSize, createLibrary, openLibrary, saveLibraryMeta, scanItems,
  readItem, writeItem, addFolder, renameFolder, removeFolder, updateItem, trashItems,
  importFromEagle, importFiles, expandPaths, createItemFromBuffer, md5File, itemDir, imagesDir,
  IMAGE_EXTS, VIDEO_EXTS,
};

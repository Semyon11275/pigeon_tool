// Pigeon — Electron 主进程
'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, protocol, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const lib = require('./lib/library');

// Windows 系统目录自带旧版 onnxruntime.dll，会在 DLL 检索中抢先命中导致崩溃；
// 进程启动第一时间加载我们自己的原生模块（其依赖 DLL 在同目录，优先解析），先入为主
try {
  const ortMain = __dirname.replace('app.asar', 'app.asar.unpacked');
  require(path.join(ortMain, 'node_modules', 'onnxruntime-node'));
} catch (e1) {
  try { require('onnxruntime-node'); } catch (e2) { /* 开发环境或未安装时静默 */ }
}

const isShot = !!process.env.PIGEON_SHOT || !!process.env.PIGEON_FUNC_TEST || !!process.env.PIGEON_FORMAT_TEST;

// ---------- 便携模式（绿色版）：数据目录跟程序走 ----------
// 打包版启用：配置和资料库存放在 exe 旁的 data\ 文件夹，库路径以 libraries/ 相对形式记录，
// 整个文件夹拷到任何位置（含 U 盘）都能继续使用。开发模式保持系统 userData。
function portableRoot() { return path.join(path.dirname(process.execPath), 'data'); }
function portableLibrariesDir() { return path.join(portableRoot(), 'libraries'); }
const isPortable = app.isPackaged;
function toPortablePath(p) {
  if (!isPortable || !p) return p;
  const rel = path.relative(portableLibrariesDir(), p);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return 'libraries/' + rel.split(path.sep).join('/');
  return p;
}
function fromPortablePath(p) {
  if (isPortable && p && /^libraries[\\/]/i.test(p)) return path.join(portableLibrariesDir(), p.replace(/^libraries[\\/]/i, ''));
  return p;
}
if (isPortable) {
  try { app.setPath('userData', path.join(portableRoot(), 'userdata')); } catch (e) {}
}

// ---------- 配置 ----------
function configPath() { return path.join(app.getPath('userData'), 'config.json'); }
async function getConfig() {
  try { return await fs.readJson(configPath()); } catch (e) { return {}; }
}
async function setConfig(patch) {
  const cfg = Object.assign(await getConfig(), patch);
  await fs.outputJson(configPath(), cfg, { spaces: 2 });
  return cfg;
}
function defaultLibraryPath() {
  return path.join(app.getPath('documents'), 'Pigeon', '素材.pigeon');
}

let win = null;

function createWindow() {
  const iconPath = path.join(__dirname, 'build', 'pigeon.ico');
  win = new BrowserWindow({
    width: 1560, height: 940, minWidth: 960, minHeight: 600,
    frame: false,
    backgroundColor: '#1F2023',
    show: false,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      webviewTag: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  // 任务栏/Alt-Tab 图标（nativeImage 支持 asar 路径）
  try {
    const appIcon = nativeImage.createFromPath(path.join(__dirname, 'renderer', 'pigeon-icon.png'));
    if (!appIcon.isEmpty()) win.setIcon(appIcon);
  } catch (e) {}
  win.on('maximize', () => win.webContents.send('window:maximized', true));
  win.on('unmaximize', () => win.webContents.send('window:maximized', false));
  return win;
}

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// ---------- 设置（β 功能：自动导入 / 截图收集 / 全局快捷键 / AI 识别） ----------
const { globalShortcut, desktopCapturer, screen } = require('electron');
const SETTINGS_DEFAULTS = {
  autoImport: { enabled: false, folders: ['', '', ''] },
  capture: { enabled: false, hotkey: 'Ctrl+Alt+A' },
  globalHotkey: { enabled: false, show: 'Ctrl+Alt+P', paste: 'Ctrl+Shift+Alt+V' },
  ai: { enabled: false, autoTag: true, semanticSearch: true, model: 'Chinese-CLIP RN50' },
  wallpaper: { enabled: true, mode: 'default', opacity: 0.5 },
};
function mergeSettings(stored) {
  const out = JSON.parse(JSON.stringify(SETTINGS_DEFAULTS));
  for (const k of Object.keys(stored || {})) {
    if (typeof out[k] === 'object' && out[k] && !Array.isArray(out[k])) out[k] = Object.assign(out[k], stored[k]);
    else out[k] = stored[k];
  }
  if (!out.autoImport.folders) out.autoImport.folders = ['', '', ''];
  while (out.autoImport.folders.length < 3) out.autoImport.folders.push('');
  // 用户从没配置过监听文件夹时，第 1 槽默认指向系统下载目录
  const userSetFolders = stored && stored.autoImport && Array.isArray(stored.autoImport.folders);
  if (!userSetFolders && !out.autoImport.folders[0]) {
    try { out.autoImport.folders[0] = app.getPath('downloads'); } catch (e) {}
  }
  return out;
}
let watcherHandles = [];
function stopWatchers() {
  for (const w of watcherHandles) { try { w.close(); } catch (e) {} }
  watcherHandles = [];
}
function applyAutoImport(settings) {
  stopWatchers();
  if (!settings.autoImport.enabled) return;
  for (const dir of settings.autoImport.folders) {
    if (!dir || !(fs.existsSync(dir))) continue;
    let pending = new Set(), timer = null;
    const flush = async () => {
      const files = [...pending];
      pending = new Set();
      if (!files.length || !currentLibraryRoot()) return;
      // 等写入完成（大小稳定）
      await new Promise(r => setTimeout(r, 600));
      const stable = [];
      for (const f of files) {
        try {
          const s1 = (await fs.stat(f)).size;
          await new Promise(r => setTimeout(r, 400));
          const s2 = (await fs.stat(f)).size;
          if (s1 === s2 && s2 > 0) stable.push(f);
        } catch (e) {}
      }
      if (!stable.length || !currentLibraryRoot()) return;
      const created = await lib.importFiles(currentLibraryRoot(), stable, []);
      await aiTagNewItems(created);
      if (created.length && win && !win.isDestroyed()) {
        win.webContents.send('pigeon:imported', created);
      }
    };
    try {
      const w = fs.watch(dir, (event, filename) => {
        if (!filename) return;
        const full = path.join(dir, filename);
        pending.add(full);
        clearTimeout(timer);
        timer = setTimeout(flush, 1200);
      });
      watcherHandles.push(w);
    } catch (e) { console.warn('[pigeon] 监听失败:', dir, e.message); }
  }
}
function applyGlobalHotkeys(settings) {
  try { globalShortcut.unregisterAll(); } catch (e) {}
  if (settings.capture.enabled && settings.capture.hotkey) {
    try {
      globalShortcut.register(settings.capture.hotkey, () => startCapture());
    } catch (e) { console.warn('[pigeon] 截图快捷键注册失败:', e.message); }
  }
  if (settings.globalHotkey.enabled) {
    try {
      if (settings.globalHotkey.show) globalShortcut.register(settings.globalHotkey.show, () => {
        if (!win) return;
        if (win.isVisible() && win.isFocused()) win.hide();
        else { win.show(); win.focus(); }
      });
      if (settings.globalHotkey.paste) globalShortcut.register(settings.globalHotkey.paste, async () => {
        const img = clipboard.readImage();
        if (img.isEmpty()) return;
        const root = currentLibraryRoot();
        if (!root) return;
        const item = await importItemFromBuffer(root, {
          buffer: img.toPNG(), name: '快捷收藏 ' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-'),
          type: 'image/png', folderIds: [],
        });
        await aiTagNewItems([item]);
        if (win && !win.isDestroyed()) {
          win.show(); win.focus();
          win.webContents.send('pigeon:imported', [item]);
        }
      });
    } catch (e) { console.warn('[pigeon] 全局快捷键注册失败:', e.message); }
  }
}
function applySettings(settings) {
  applyAutoImport(settings);
  applyGlobalHotkeys(settings);
}

// ---------- 截图收集（β）：整屏捕获 → 覆盖窗框选 → 裁剪入库 ----------
let captureWin = null;
let captureBase = null; // nativeImage 整屏原图
async function startCapture() {
  try {
    const display = screen.getPrimaryDisplay();
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: display.size.width, height: display.size.height },
    });
    if (!sources.length) return;
    captureBase = sources[0].thumbnail;
    if (captureBase.isEmpty()) return;
    if (captureWin) { try { captureWin.close(); } catch (e) {} }
    captureWin = new BrowserWindow({
      show: false, fullscreen: true, frame: false, alwaysOnTop: true,
      webPreferences: { preload: path.join(__dirname, 'renderer', 'capture-preload.js'), contextIsolation: true },
    });
    await captureWin.loadFile(path.join(__dirname, 'renderer', 'capture.html'));
    const dataUrl = captureBase.toDataURL();
    captureWin.webContents.executeJavaScript(`window.__init(${JSON.stringify(dataUrl)})`);
    captureWin.show();
  } catch (e) {
    console.warn('[pigeon] 截图失败:', e.message);
    closeCapture();
  }
}
function closeCapture() {
  if (captureWin) { try { captureWin.close(); } catch (e) {} captureWin = null; }
}
async function finishCapture(rect) {
  try {
    let img = captureBase;
    if (rect && rect.w > 4 && rect.h > 4) {
      // nativeImage.crop 需要 { x, y, width, height }
      img = captureBase.crop({
        x: Math.round(rect.x), y: Math.round(rect.y),
        width: Math.round(rect.w), height: Math.round(rect.h),
      });
    }
    if (img.isEmpty()) return;
    const root = currentLibraryRoot();
    if (!root) return;
    const name = '截图 ' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const item = await importItemFromBuffer(root, { buffer: img.toPNG(), name, type: 'image/png', folderIds: [] });
    await aiTagNewItems([item]);
    if (win && !win.isDestroyed()) {
      win.webContents.send('pigeon:imported', [item]);
      if (!win.isVisible()) win.show();
    }
  } catch (e) { console.warn('[pigeon] 截图入库失败:', e.message); }
  finally { closeCapture(); }
}

// ---------- PDF 首页缩略图（隐藏窗口用 Chromium 内置 PDF 查看器渲染后截图） ----------
let pdfWin = null;
async function generatePdfThumbnail(root, item) {
  try {
    if (!pdfWin || pdfWin.isDestroyed()) {
      pdfWin = new BrowserWindow({ show: false, width: 620, height: 800, webPreferences: { plugins: true } });
    }
    const url = 'pigeon://item/' + item.id + '/' + encodeURIComponent(item.name + '.' + item.ext);
    await pdfWin.loadURL(url);
    await new Promise(r => setTimeout(r, 2200));
    const img = await pdfWin.webContents.capturePage();
    if (img.isEmpty()) return;
    const size = img.getSize();
    const scaled = size.width > 480 ? img.resize({ width: 480 }) : img;
    await fs.writeFile(path.join(lib.itemDir(root, item.id), 'thumbnail.png'), scaled.toPNG());
    await lib.updateItem(root, item.id, { width: size.width, height: size.height });
    Object.assign(item, { width: size.width, height: size.height });
  } catch (e) { console.warn('[pigeon] PDF 缩略图失败:', item && item.name, e.message); }
}

function withTimeout(promise, ms, label = 'operation') {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} 超时（${Math.round(ms / 1000)}s）`)), ms)),
  ]);
}

// 在页面里执行脚本；页面自身跳转会打断执行，带重试
async function pageEval(wc, script, retries = 3) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try { return await wc.executeJavaScript(script); }
    catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  throw lastErr;
}

async function extractPageImages(url) {
  const w = new BrowserWindow({
    show: false, width: 1440, height: 900,
    webPreferences: { contextIsolation: true, nodeIntegration: false, images: true },
  });
  try {
    try {
      await withTimeout(w.loadURL(url, { userAgent: BROWSER_UA }), 30000, '打开页面');
    } catch (e) {
      // 页面自身的 JS 跳转/重定向会中断 loadURL（ERR_ABORTED），等待新导航完成即可
      if (!/ERR_ABORTED/i.test(String(e))) throw e;
    }
    await withTimeout(new Promise(res => {
      if (w.webContents.isLoading()) w.webContents.once('did-stop-loading', () => setTimeout(res, 600));
      else setTimeout(res, 600);
    }), 15000, '等待页面加载');
    await new Promise(r => setTimeout(r, 1800));
    // 分步滚动触发懒加载（微脚本，避免被页面跳转打断）
    for (let i = 0; i < 6; i++) {
      await pageEval(w.webContents, `window.scrollBy(0, Math.floor(window.innerHeight * 0.9)); "ok"`).catch(() => {});
      await new Promise(r => setTimeout(r, 350));
    }
    await pageEval(w.webContents, `window.scrollTo(0, 0); "ok"`).catch(() => {});
    await new Promise(r => setTimeout(r, 500));
    const data = await withTimeout(pageEval(w.webContents, `
      (() => {
        const abs = (u) => { try { return new URL(u, location.href).href; } catch (e) { return null; } };
        const skip = (u) => !u || /^(data|blob|javascript):/i.test(u) || /\\/svg(\\?|$)/i.test(u) || /\\/(null|undefined)(\\?|$)/i.test(u);
        const metas = [...document.querySelectorAll('meta[property="og:image"], link[rel="image_src"], meta[name="twitter:image"]')].map(m => abs(m.content || m.href)).filter(Boolean);
        const imgs = [...document.querySelectorAll('img')]
          .map(i => i.currentSrc || i.src || i.getAttribute('data-src') || i.getAttribute('data-original'))
          .map(abs).filter(u => u && !skip(u));
        const vids = [...document.querySelectorAll('video')].map(v => abs(v.poster)).filter(Boolean);
        const all = [...new Set([...metas, ...imgs, ...vids])].slice(0, 200);
        return { title: document.title || '', images: all, count: all.length };
      })()
    `, 2), 30000, '提取图片');
    return data;
  } finally {
    try { w.destroy(); } catch (e) {}
  }
}

// ---------- 网络收集：下载单张图片并入库 ----------
const EXT_BY_MIME = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/bmp': 'bmp', 'image/avif': 'avif', 'video/mp4': 'mp4',
  'image/tiff': 'tif', 'image/heic': 'heic', 'image/heif': 'heif', 'image/svg+xml': 'svg',
};

// TIFF 缩略图：与 Eagle 相同方案（UTIF 解码 → 原始像素 → nativeImage → PNG）
async function generateTiffThumbnail(root, item) {
  let UTIF;
  try { UTIF = require('utif'); } catch (e) { return; }
  try {
    const file = path.join(lib.itemDir(root, item.id), item.name + '.' + item.ext);
    const buf = await fs.readFile(file);
    const ifds = UTIF.decode(buf);
    if (!ifds || !ifds.length) return;
    UTIF.decodeImage(buf, ifds[0]);
    const rgba = UTIF.toRGBA8(ifds[0]);
    const w = ifds[0].width, h = ifds[0].height;
    if (!w || !h) return;
    // RGBA → BGRA（nativeImage.createFromBitmap 要求）
    const bgra = Buffer.from(rgba);
    for (let i = 0; i < bgra.length; i += 4) {
      const r = bgra[i]; bgra[i] = bgra[i + 2]; bgra[i + 2] = r;
    }
    const img = nativeImage.createFromBitmap(bgra, { width: w, height: h });
    if (img.isEmpty()) return;
    const scaled = w > 640 ? img.resize({ width: 640 }) : img;
    await fs.writeFile(path.join(lib.itemDir(root, item.id), 'thumbnail.png'), scaled.toPNG());
    await lib.updateItem(root, item.id, { width: w, height: h });
    Object.assign(item, { width: w, height: h });
  } catch (e) {
    console.warn('[pigeon] TIFF 缩略图失败:', item && item.name, e.message);
  }
}
function guessNameExtFromUrl(u) {
  try {
    const p = new URL(u).pathname;
    const base = decodeURIComponent(p.split('/').pop() || '');
    const m = base.match(/^(.*?)\.([a-z0-9]{1,5})$/i);
    return { name: base.replace(/\.[a-z0-9]{1,5}$/i, ''), ext: m ? m[2].toLowerCase() : null };
  } catch (e) { return { name: '', ext: null }; }
}

// 从渲染进程传来的文件字节建立条目（网页拖图等虚拟文件）
async function importItemFromBuffer(root, { buffer, name, type, folderIds }) {
  // 扩展名：优先文件名，其次 MIME 类型
  let ext = null, base = (name || '').replace(/\.[a-z0-9]{1,5}$/i, '');
  const m = (name || '').match(/\.([a-z0-9]{1,5})$/i);
  if (m) ext = m[1].toLowerCase();
  if (!ext && type) ext = EXT_BY_MIME[type.split(';')[0].toLowerCase()] || (type.startsWith('image/') ? type.split('/')[1].replace('jpeg', 'jpg') : null);
  if (!ext) ext = 'png';
  if (!base) base = '拖入图片';
  return lib.createItemFromBuffer(root, { buffer, name: base, ext, url: '', folderIds: folderIds || [] });
}

async function importFromUrl(srcUrl, pageUrl, folderIds) {
  const root = currentLibraryRoot();
  if (!root) throw new Error('未打开资料库');
  let resp = await net_fetch2(srcUrl, pageUrl);
  // 部分图床带 Referer 反而 403，去掉重试一次
  if (resp.status === 403 || resp.status === 401) {
    resp = await net_fetch2(srcUrl, null);
  }
  if (!resp.ok) {
    throw new Error(`下载失败 HTTP ${resp.status}：${srcUrl.slice(0, 80)}`);
  }
  const type = (resp.headers.get('content-type') || '').split(';')[0].toLowerCase();
  if (type.includes('text/html')) {
    return { ok: false, html: true, url: srcUrl };
  }
  const buf = Buffer.from(await withTimeout(resp.arrayBuffer(), 60000, '下载数据'));
  if (!buf.length) throw new Error('下载内容为空');
  const guess = guessNameExtFromUrl(srcUrl);
  const ext = guess.ext && guess.ext.length <= 5 ? guess.ext : (EXT_BY_MIME[type] || 'jpg');
  let name = guess.name || '网络图片';
  const item = await lib.createItemFromBuffer(root, {
    buffer: buf, name, ext,
    url: pageUrl || srcUrl,
    srcUrl: srcUrl,
    folderIds: folderIds || [],
  });
  if (['tif', 'tiff'].includes(item.ext)) await generateTiffThumbnail(root, item);
  if (item.ext === 'pdf') await generatePdfThumbnail(root, item);
  await aiTagNewItems([item]);
  return { ok: true, item };
}

function net_fetch2(url, referrer) {
  const { net } = require('electron');
  // 注意：Referer 必须用 referrer 选项，塞进 headers 会被 Chromium 拦截（ERR_BLOCKED_BY_CLIENT）
  const opts = { headers: { 'User-Agent': BROWSER_UA }, session: win.webContents.session };
  if (referrer) opts.referrer = referrer;
  return withTimeout(net.fetch(url, opts), 45000, '请求资源');
}

// ---------- 自定义协议：pigeon://item/<id>/<文件名> ----------
// 必须在 app ready 之前注册 scheme
protocol.registerSchemesAsPrivileged([
  { scheme: 'pigeon', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);
function attachItemProtocolHandler() {
  const { net } = require('electron');
  protocol.handle('pigeon', async (request) => {
    try {
      const u = new URL(request.url);
      // URL 会把 item 解析为 host：pigeon://item/<id>/<file> → host='item', pathname='/<id>/<file>'
      if (u.host === 'wallpaper') {
        const dataDir = path.join(portableRoot(), 'data');
        const files = (await fs.pathExists(dataDir)) ? (await fs.readdir(dataDir)).filter(f => f.startsWith('wallpaper-current.')) : [];
        if (!files.length) return new Response('not found', { status: 404 });
        const wf = path.join(dataDir, files[0]);
        const st2 = await fs.stat(wf);
        const body = await fs.readFile(wf);
        return new Response(body, { headers: { 'Content-Type': MIME[files[0].split('.').pop().toLowerCase()] || 'image/jpeg', 'Access-Control-Allow-Origin': '*' } });
      }
      if (u.host !== 'item') return new Response('bad request', { status: 400 });
      const parts = u.pathname.split('/').filter(Boolean).map(s => { try { return decodeURIComponent(s); } catch (e) { return s; } });
      if (parts.length < 2) return new Response('bad request', { status: 400 });
      const root = currentLibraryRoot();
      if (!root) return new Response('no library', { status: 404 });
      const file = path.join(lib.imagesDir(root), parts[0] + '.info', parts.slice(1).join('/'));
      if (!(await fs.pathExists(file))) return new Response('not found', { status: 404 });
      const stat = await fs.stat(file);
      const mime = MIME[parts[parts.length - 1].split('.').pop().toLowerCase()] || 'application/octet-stream';
      // Range 支持（视频拖动进度条必需）
      const range = request.headers.get('Range');
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        let start = m && m[1] ? parseInt(m[1], 10) : 0;
        let end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
        if (isNaN(start) || start >= stat.size) start = 0;
        if (isNaN(end) || end >= stat.size) end = stat.size - 1;
        const stream = fs.createReadStream(file, { start, end });
        const body = require('stream').Readable.toWeb(stream);
        return new Response(body, {
          status: 206,
          headers: {
            'Content-Type': mime,
            'Content-Range': `bytes ${start}-${end}/${stat.size}`,
            'Content-Length': String(end - start + 1),
            'Accept-Ranges': 'bytes',
            'Access-Control-Allow-Origin': '*',
          },
        });
      }
      const stream = fs.createReadStream(file);
      const body = require('stream').Readable.toWeb(stream);
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': mime, 'Content-Length': String(stat.size), 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' },
      });
    } catch (e) {
      return new Response('error: ' + e.message, { status: 500 });
    }
  });
}

const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/x-m4v',
  mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg',
  psd: 'image/vnd.adobe.photoshop', pdf: 'application/pdf', txt: 'text/plain',
};

let currentLibraryRoot = () => null;

// ---------- IPC ----------
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    try { return { ok: true, data: await fn(...args) }; }
    catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  });
}

let aiRuntime = null;
async function aiTagNewItems(items) {
  try {
    const cfg = await getConfig();
    if (!cfg.settings || !cfg.settings.ai || !cfg.settings.ai.enabled || !cfg.settings.ai.autoTag) return items;
    const ai = getAiRuntime();
    if (!(await ai.ensureModel())) return items;
    await ai.loadVectors(currentLibraryRoot());
    for (const item of items) {
      try {
        const vec = await ai.embedItem(currentLibraryRoot(), item);
        if (!vec) continue;
        const tags = await ai.autoTagItem(currentLibraryRoot(), item, vec);
        if (tags.length) {
          item.tags = [...new Set([...(item.tags || []), ...tags])];
          await lib.writeItem(currentLibraryRoot(), item);
        }
      } catch (e) {}
    }
  } catch (e) {}
  return items;
}

function getAiRuntime() {
  if (!aiRuntime) {
    const { AiRuntime } = require('./lib/ai');
    let dir = path.join(isPortable ? portableRoot() : app.getPath('userData'), 'models');
    // 开发模式下便携目录里若有已转换模型，直接复用
    if (!isPortable) {
      const devAlt = path.join(app.getPath('desktop'), 'Pigeon', 'data', 'models');
      if (fs.existsSync(path.join(devAlt, 'visual.onnx'))) dir = devAlt;
    }
    fs.ensureDirSync(dir);
    aiRuntime = new AiRuntime(dir);
    try {
      if (fs.existsSync(path.join(portableRoot(), 'clip_cn_rn50.pt'))) {
        // 兼容：权重在便携根目录时移动到 models
        fs.moveSync(path.join(portableRoot(), 'clip_cn_rn50.pt'), path.join(dir, 'clip_cn_rn50.pt'), { overwrite: true });
      }
    } catch (e) {}
    aiRuntime.modelsDir = dir;
  }
  return aiRuntime;
}

function registerIpc() {
  handle('config:get', () => getConfig());
  handle('config:set', (patch) => setConfig(patch));
  handle('window:min', () => win.minimize());
  handle('window:max', () => (win.isMaximized() ? win.unmaximize() : win.maximize()));
  handle('window:close', () => win.close());

  handle('dialog:pickDirectory', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('dialog:pickFiles', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] });
    return r.canceled ? [] : r.filePaths;
  });

  // 记住资料库（便携模式下保存相对路径）
  async function rememberLibrary(root) {
    const cfg = await getConfig();
    const libs = [...new Set([toPortablePath(root), ...(cfg.libraries || [])])].slice(0, 12);
    await setConfig({ lastLibrary: toPortablePath(root), libraries: libs });
  }

  handle('library:open', async (root) => {
    root = fromPortablePath(root);
    const meta = await lib.openLibrary(root);
    currentLibraryRoot = () => root;
    try { getAiRuntime().loadVectors(root); } catch (e) {}
    await rememberLibrary(root);
    return meta;
  });
  handle('library:create', async (name) => {
    const dir = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    if (dir.canceled || !dir.filePaths[0]) throw new Error('已取消');
    const root = path.join(dir.filePaths[0], (name || '未命名') + '.pigeon');
    const meta = await lib.createLibrary(root, name);
    currentLibraryRoot = () => root;
    await rememberLibrary(root);
    return meta;
  });
  handle('library:importEagle', async (srcRoot, destDir, name) => {
    if (!(await fs.pathExists(srcRoot)) || !(await fs.pathExists(path.join(srcRoot, 'metadata.json')))) {
      throw new Error('不是有效的 Eagle 资料库（缺 metadata.json）');
    }
    const target = destDir || (isPortable ? portableLibrariesDir() : path.join(app.getPath('documents'), 'Pigeon'));
    const libName = name || path.basename(srcRoot).replace(/[\\/]+$/, '').replace(/\.library$/, '');
    const root = path.join(target, libName + '.pigeon');
    await lib.importFromEagle(srcRoot, root);
    const meta = await lib.openLibrary(root);
    currentLibraryRoot = () => root;
    await rememberLibrary(root);
    return { root, meta };
  });
  handle('library:meta', async () => {
    const root = currentLibraryRoot();
    if (!root) throw new Error('未打开资料库');
    return lib.openLibrary(root);
  });

  handle('items:list', async () => {
    const root = currentLibraryRoot();
    if (!root) throw new Error('未打开资料库');
    const items = await lib.scanItems(root);
    // 拼音索引（全拼 + 首字母），供搜索用
    let Pinyin = null;
    try { Pinyin = require('tiny-pinyin'); } catch (e) {}
    const pyCache = new Map();
    for (const it of items) {
      if (!Pinyin) break;
      const key = it.name;
      if (pyCache.has(key)) { it._py = pyCache.get(key); continue; }
      let py = null;
      try {
        if (Pinyin.isSupported() && /\p{Script=Han}/u.test(key)) {
          py = {
            full: Pinyin.getFullChars(key).toLowerCase(),
            head: Pinyin.getCamelChars(key).toLowerCase(),
          };
        }
      } catch (e) {}
      pyCache.set(key, py);
      it._py = py;
    }
    return items;
  });
  handle('item:update', (id, patch) => {
    const root = currentLibraryRoot();
    return lib.updateItem(root, id, patch);
  });
  handle('item:trash', (ids, deleted) => {
    const root = currentLibraryRoot();
    return lib.trashItems(root, ids, deleted !== false);
  });
  handle('item:deletePermanent', async (ids) => {
    const root = currentLibraryRoot();
    for (const id of ids) {
      await fs.remove(lib.itemDir(root, id));
    }
  });

  handle('folder:add', (name, parentId) => currentLibraryRoot() && lib.addFolder(currentLibraryRoot(), name, parentId));
  handle('folder:rename', (id, name) => lib.renameFolder(currentLibraryRoot(), id, name));
  handle('folder:remove', (id) => lib.removeFolder(currentLibraryRoot(), id));

  handle('import:files', async (paths, folderIds) => {
    const root = currentLibraryRoot();
    if (!root) throw new Error('未打开资料库');
    const created = await lib.importFiles(root, paths, folderIds || []);
    for (const item of created) {
      if (['tif', 'tiff'].includes(item.ext)) await generateTiffThumbnail(root, item);
      if (item.ext === 'pdf') await generatePdfThumbnail(root, item);
    }
    await aiTagNewItems(created);
    return created;
  });
  handle('import:buffer', async (name, type, arrayBuffer, folderIds) => {
    const root = currentLibraryRoot();
    if (!root) throw new Error('未打开资料库');
    const item = await importItemFromBuffer(root, { buffer: Buffer.from(arrayBuffer), name, type, folderIds });
    if (['tif', 'tiff'].includes(item.ext)) await generateTiffThumbnail(root, item);
    return item;
  });
  handle('import:clipboard', async (folderIds) => {
    const root = currentLibraryRoot();
    const img = clipboard.readImage();
    if (img.isEmpty()) return [];
    const id = lib.genId();
    const dir = lib.itemDir(root, id);
    await fs.ensureDir(dir);
    const name = '剪贴板图片 ' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const png = name + '.png';
    await fs.writeFile(path.join(dir, png), img.toPNG());
    const size = img.getSize();
    const item = {
      id, name, size: (await fs.stat(path.join(dir, png))).size,
      btime: Date.now(), mtime: Date.now(), ext: 'png',
      tags: [], folders: folderIds || [], isDeleted: false, url: '', annotation: '',
      modificationTime: Date.now(), width: size.width, height: size.height,
      rating: 0, star: false, palettes: [],
    };
    await lib.writeItem(root, item);
    return [item];
  });
  // 渲染进程生成缩略图后写回
  handle('item:saveThumbnail', async (id, arrayBuffer) => {
    const root = currentLibraryRoot();
    const file = path.join(lib.itemDir(root, id), 'thumbnail.png');
    await fs.writeFile(file, Buffer.from(arrayBuffer));
  });

  handle('shell:reveal', (id) => {
    const root = currentLibraryRoot();
    return shell.showItemInFolder(path.join(lib.itemDir(root, id)));
  });
  handle('shell:open', async (id) => {
    const root = currentLibraryRoot();
    const item = await lib.readItem(root, id);
    return shell.openPath(path.join(lib.itemDir(root, id), item.name + '.' + item.ext));
  });
  handle('shell:openExternal', (url) => shell.openExternal(url));
  handle('clipboard:writeText', (t) => clipboard.writeText(t));
  handle('clipboard:readPaste', () => {
    const img = clipboard.readImage();
    const text = clipboard.readText() || '';
    const html = clipboard.readHTML() || '';
    return {
      hasImage: !img.isEmpty(),
      text, html,
    };
  });

  // ---- 网络收集 ----
  handle('web:extractImages', (url) => extractPageImages(url));
  handle('net:importFromUrl', (srcUrl, pageUrl, folderIds) => importFromUrl(srcUrl, pageUrl, folderIds));

  // ---- 导出 ----
  handle('item:exportTo', async (ids) => {
    const root = currentLibraryRoot();
    const dir = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    if (dir.canceled || !dir.filePaths[0]) return 0;
    const dest = dir.filePaths[0];
    let n = 0;
    for (const id of ids) {
      const item = await lib.readItem(root, id);
      const src = path.join(lib.itemDir(root, id), item.name + '.' + item.ext);
      if (await fs.pathExists(src)) {
        let target = path.join(dest, item.name + '.' + item.ext);
        let k = 1;
        while (await fs.pathExists(target)) target = path.join(dest, `${item.name} (${k++}).` + item.ext);
        await fs.copy(src, target);
        n++;
      }
    }
    return n;
  });
  handle('library:exportCsv', async (ids) => {
    const root = currentLibraryRoot();
    const all = await lib.scanItems(root);
    const meta = await lib.openLibrary(root);
    const pathOf = (fid) => {
      const walk = (list, trail) => {
        for (const f of list) {
          if (f.id === fid) return [...trail, f.name].join('/');
          const x = walk(f.children || [], [...trail, f.name]);
          if (x) return x;
        }
        return null;
      };
      return walk(meta.folders || [], []) || '';
    };
    const rows = ids && ids.length ? all.filter(i => ids.includes(i.id)) : all;
    const r = await dialog.showSaveDialog(win, {
      defaultPath: 'pigeon导出.csv',
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (r.canceled || !r.filePath) return null;
    const esc2 = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
    const head = ['ID', '名称', '格式', '大小', '宽', '高', '评分', '星标', '标签', '文件夹', '来源URL', '注释', '添加日期'];
    const lines = [head.join(',')];
    for (const it of rows) {
      lines.push([it.id, it.name, it.ext, it.size, it.width, it.height, it.rating || 0, it.star ? 1 : 0,
        (it.tags || []).join(' '), (it.folders || []).map(pathOf).join(' | '), it.url || '', it.annotation || '', fmtDateMs(it.btime)].map(esc2).join(','));
    }
    await fs.writeFile(r.filePath, '\ufeff' + lines.join('\r\n'), 'utf8');
    return r.filePath;
  });

  // ---- 重复扫描（MD5） ----
  handle('scan:md5All', async () => {
    const root = currentLibraryRoot();
    const items = (await lib.scanItems(root)).filter(i => !i.isDeleted);
    const out = {};
    for (const it of items) {
      try {
        const h = await lib.md5File(path.join(lib.itemDir(root, it.id), it.name + '.' + it.ext));
        out[it.id] = h;
      } catch (e) { out[it.id] = null; }
    }
    return out;
  });

  // ---- EXIF ----
  handle('item:exif', async (id) => {
    const root = currentLibraryRoot();
    const item = await lib.readItem(root, id);
    if (item.exif) return item.exif;
    if (!['jpg', 'jpeg', 'tif', 'tiff'].includes(item.ext)) return null;
    let parser;
    try { parser = require('exif-parser'); } catch (e) { return null; }
    const file = path.join(lib.itemDir(root, id), item.name + '.' + item.ext);
    const buf = await fs.readFile(file);
    try {
      const r = parser.create(buf).parse();
      const tags = r.tags || {};
      const exif = {
        camera: [tags.Make, tags.Model].filter(Boolean).join(' ') || null,
        lens: tags.LensModel || null,
        aperture: tags.FNumber || null,
        shutter: tags.ExposureTime ? `1/${Math.round(1 / tags.ExposureTime)}s` : null,
        iso: tags.ISO || null,
        focalLength: tags.FocalLength ? `${Math.round(tags.FocalLength)}mm` : null,
        takenAt: tags.DateTimeOriginal || tags.CreateDate || null,
      };
      await lib.updateItem(root, id, { exif });
      return exif;
    } catch (e) { return null; }
  });

  // ---- 智能文件夹 ----
  handle('library:setSmartFolders', async (sfs) => {
    const root = currentLibraryRoot();
    const meta = await lib.openLibrary(root);
    meta.smartFolders = sfs;
    await lib.saveLibraryMeta(root, meta);
    return meta.smartFolders;
  });

  // ---- 多库 ----
  handle('library:listKnown', async () => {
    const cfg = await getConfig();
    return cfg.libraries || (cfg.lastLibrary ? [cfg.lastLibrary] : []);
  });

  handle('app:version', () => app.getVersion() + '-demo');
  // ---- 壁纸 ----
  handle('wallpaper:pickImage', async () => {
    const dir = portableRoot();
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp'] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const ext = path.extname(r.filePaths[0]).slice(1).toLowerCase() || 'png';
    const dest = path.join(dir, 'data', 'wallpaper-current.' + ext);
    await fs.copy(r.filePaths[0], dest, { overwrite: true });
    // 清理其它扩展名的旧壁纸
    for (const e2 of ['jpg', 'jpeg', 'png', 'webp', 'bmp']) {
      if (e2 !== ext) await fs.remove(path.join(dir, 'data', 'wallpaper-current.' + e2)).catch(() => {});
    }
    return 'pigeon://wallpaper/current.' + ext + '?t=' + Date.now();
  });

  // ---- 设置（β） ----
  handle('settings:get', async () => {
    const cfg = await getConfig();
    return mergeSettings(cfg.settings);
  });
  handle('settings:set', async (patch) => {
    const cfg = await getConfig();
    const merged = mergeSettings(Object.assign({}, cfg.settings, patch));
    await setConfig({ settings: merged });
    applySettings(merged);
    return merged;
  });
  handle('settings:modelsDir', async () => {
    const dir = path.join(portableRoot(), 'data', 'models');
    await fs.ensureDir(dir);
    return dir;
  });
  handle('settings:openModelsDir', async () => {
    const dir = path.join(portableRoot(), 'data', 'models');
    await fs.ensureDir(dir);
    shell.openPath(dir);
    return dir;
  });
  handle('settings:modelStatus', async () => {
    const dir = path.join(portableRoot(), 'data', 'models');
    const has = (f) => { try { return fs.statSync(path.join(dir, f)).size > 1024; } catch (e) { return false; } };
    const weights = has('clip_cn_rn50.pt');
    const visual = has('visual.onnx'), text = has('text.onnx'), vocab = has('vocab.txt');
    const ai = getAiRuntime();
    let runtimeReady = false, vectorCount = 0;
    try { runtimeReady = await ai.ensureModel(); vectorCount = Object.keys(ai.vectors).length; } catch (e) {}
    return { dir, weights, visual, text, vocab, ready: visual && text && vocab, runtimeReady, vectorCount };
  });
  handle('ai:semanticSearch', async (query, topN) => {
    const cfg = await getConfig();
    if (!cfg.settings || !cfg.settings.ai || !cfg.settings.ai.enabled) throw new Error('AI 未启用');
    const ai = getAiRuntime();
    await ai.ensureModel();
    const qv = await ai.embedQuery(query);
    const root = currentLibraryRoot();
    const items = await lib.scanItems(root);
    const scored = [];
    for (const it of items) {
      if (it.isDeleted) continue;
      let vec = ai.vectors[it.id];
      if (!vec) {
        try { vec = await ai.embedItem(root, it); } catch (e) { continue; }
      }
      if (!vec) continue;
      scored.push({ id: it.id, score: Math.round(ai.cosine(qv, vec) * 1000) / 1000 });
    }
    scored.sort((a, b) => b.score - a.score);
    ai.saveVectors();
    return scored.filter(s => s.score > 0.15).slice(0, topN || 60);
  });
  handle('ai:embedMissing', async () => {
    const cfg = await getConfig();
    if (!cfg.settings || !cfg.settings.ai || !cfg.settings.ai.enabled) return { done: true, count: 0 };
    const ai = getAiRuntime();
    if (!(await ai.ensureModel())) return { done: false, count: 0 };
    const root = currentLibraryRoot();
    const targets = (await lib.scanItems(root)).filter(i => !i.isDeleted && !ai.vectors[i.id] && (lib.IMAGE_EXTS.has(i.ext) || ['tif', 'tiff', 'pdf', 'heic', 'heif'].includes(i.ext)));
    let done = 0;
    for (const it of targets) {
      try { await ai.embedItem(root, it); } catch (e) {}
      done++;
      if (win && !win.isDestroyed() && done % 5 === 0) win.webContents.send('pigeon:ai-progress', { done, total: targets.length });
    }
    aiRuntime.saveVectors();
    return { done: true, count: done };
  });
  handle('ai:autoTagItem', async (id) => {
    const root = currentLibraryRoot();
    const item = await lib.readItem(root, id);
    const ai = getAiRuntime();
    await ai.loadVectors(root);
    const vec = ai.vectors[id] || null;
    const tags = await ai.autoTagItem(root, item, vec);
    if (tags.length) {
      item.tags = [...new Set([...(item.tags || []), ...tags])];
      await lib.writeItem(root, item);
    }
    return tags;
  });
}

// 截图窗口事件（capture-preload 发来）
ipcMain.on('capture:done', (_e, rect) => finishCapture(rect));
ipcMain.on('capture:cancel', () => closeCapture());

function fmtDateMs(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---------- 格式兼容性自检（PIGEON_FORMAT_TEST=1 时运行） ----------
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
// 生成纯色 PNG（测试夹具用）
function makePng(w, h, rgb) {
  const zlib = require('zlib');
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8bit RGB
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const off = y * (1 + w * 3);
    raw[off] = 0;
    for (let x = 0; x < w; x++) {
      raw[off + 1 + x * 3] = rgb[0]; raw[off + 2 + x * 3] = rgb[1]; raw[off + 3 + x * 3] = rgb[2];
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

async function buildFormatTestLibrary() {
  const UTIF = require('utif');
  const root = path.join(app.getPath('temp'), 'pigeon-format-test.pigeon');
  await fs.remove(root);
  await lib.createLibrary(root, '格式测试');
  const mk = async (name, ext, buffer) => lib.createItemFromBuffer(root, { buffer, name, ext, folderIds: [] });
  const png = makePng(160, 100, [70, 130, 220]);
  const items = [];
  items.push(await mk('控制组PNG', 'png', png));
  items.push(await mk('avif测试(AV1内容流)', 'avif', png)); // Chromium 内容嗅探解码，验证渲染链路
  items.push(await mk('svg测试', 'svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="#e6a23c"/><circle cx="60" cy="40" r="25" fill="#fff"/></svg>')));
  // 真 TIFF（UTIF 编码，与 Eagle 内置方案同源）
  const w = 150, h = 90;
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) { rgba[i * 4] = 60; rgba[i * 4 + 1] = 160; rgba[i * 4 + 2] = 90; rgba[i * 4 + 3] = 255; }
  const tif = Buffer.from(UTIF.encodeImage(rgba, w, h));
  items.push(await mk('tiff测试(UTIF解码)', 'tif', tif));
  items.push(await mk('heic测试(预期占位)', 'heic', png));
  for (const item of items) {
    if (['tif', 'tiff'].includes(item.ext)) await generateTiffThumbnail(root, item);
  }
  return { root, expect: { png: 'render', avif: 'render', svg: 'render', tif: 'render', heic: 'fallback' } };
}

async function formatTestShot(test) {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const prevCfg = test.prevLastLibrary;
  // 等窗口加载完测试库
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const ready = await win.webContents.executeJavaScript(`!!(window.__test && document.querySelector('#grid .item'))`).catch(() => false);
    if (ready) break;
  }
  // 触发导入后处理（缩略图/尺寸），渲染链路生效
  await win.webContents.executeJavaScript(`window.__test.processAll && window.__test.processAll()`);
  await sleep(4000);
  const rows = await win.webContents.executeJavaScript(`
    [...document.querySelectorAll('#grid .item')].map(card => {
      const img = card.querySelector('.media img');
      const fb = card.querySelector('.ext-fallback');
      return {
        name: card.querySelector('.name-overlay') ? card.querySelector('.name-overlay').textContent : '',
        rendered: !!(img && img.complete && img.naturalWidth > 0),
        fallback: !!fb,
      };
    })
  `);
  const byName = {};
  for (const r of rows) {
    if (r.name.includes('avif')) byName.avif = r;
    else if (r.name.includes('tiff')) byName.tif = r;
    else if (r.name.includes('svg')) byName.svg = r;
    else if (r.name.includes('heic')) byName.heic = r;
    else if (r.name.includes('PNG')) byName.png = r;
  }
  let pass = true;
  const report = {};
  for (const [ext, want] of Object.entries(test.expect)) {
    const r = byName[ext];
    const got = !r ? 'missing' : (r.fallback ? 'fallback' : (r.rendered ? 'render' : 'loading'));
    const ok = got === want;
    if (!ok) pass = false;
    report[ext] = { want, got, ok };
  }
  const img = await win.webContents.capturePage();
  const fmtShots = path.join(app.getPath('temp'), 'pigeon-shots');
  fs.mkdirSync(fmtShots, { recursive: true });
  await fs.writeFile(path.join(fmtShots, '8-formats.png'), img.toPNG());
  console.log('[pigeon] FORMAT_CHECK ' + JSON.stringify({ pass, report }));
  await setConfig({ lastLibrary: prevCfg.lastLibrary || defaultLibraryPath() });
  app.exit(pass ? 0 : 2);
}

function makeTestPdf() {
  const objects = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  objects[3] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>';
  const stream = 'BT /F1 24 Tf 40 100 Td (Pigeon PDF test) Tj ET';
  objects[4] = '<< /Length ' + stream.length + ' >>\nstream\n' + stream + '\nendstream';
  objects[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  let out = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 1; i <= 5; i++) { offsets[i] = out.length; out += i + ' 0 obj\n' + objects[i] + '\nendobj\n'; }
  const xref = out.length;
  out += 'xref\n0 6\n0000000000 65535 f \n';
  for (let i = 1; i <= 5; i++) out += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  out += 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF';
  return Buffer.from(out, 'binary');
}

async function captureFullForTest() {
  await startCapture();
  await new Promise(r => setTimeout(r, 1200));
  if (captureBase && !captureBase.isEmpty()) {
    const size = captureBase.getSize();
    await finishCapture({ x: 0, y: 0, w: size.width, h: size.height });
  } else closeCapture();
}

// ---------- 功能回归测试（PIGEON_FUNC_TEST=1）：核心库操作 + 网络导入链路 ----------
async function funcTest() {
  const results = {};
  // 1. 核心库操作（最初两轮写的部分，逐项验证）
  const root = path.join(app.getPath('temp'), 'pigeon-func-test.pigeon');
  await fs.remove(root);
  await lib.createLibrary(root, '功能测试');
  currentLibraryRoot = () => root;
  const png = makePng(80, 60, [10, 200, 100]);
  const items = [];
  for (let i = 0; i < 3; i++) items.push(await lib.createItemFromBuffer(root, { buffer: png, name: '测试' + i, ext: 'png' }));
  // 改名 → 磁盘文件必须同步
  await lib.updateItem(root, items[0].id, { name: '改名测试' });
  results.renameDiskSync = await fs.pathExists(path.join(lib.itemDir(root, items[0].id), '改名测试.png'));
  // 元数据更新
  await lib.updateItem(root, items[0].id, { tags: ['甲', '乙'], rating: 4, annotation: '注释' });
  const r0 = await lib.readItem(root, items[0].id);
  results.updateMeta = r0.tags.length === 2 && r0.rating === 4 && r0.annotation === '注释';
  // 多文件夹归属
  const f1 = await lib.addFolder(root, '文件夹A');
  const f2 = await lib.addFolder(root, '文件夹B', f1.id);
  await lib.updateItem(root, items[1].id, { folders: [f1.id, f2.id] });
  results.multiFolder = (await lib.readItem(root, items[1].id)).folders.length === 2;
  // 回收站 / 还原 / 永久删除
  await lib.trashItems(root, [items[2].id], true);
  results.trash = (await lib.scanItems(root)).find(i => i.id === items[2].id).isDeleted === true;
  await lib.trashItems(root, [items[2].id], false);
  results.restore = !(await lib.scanItems(root)).find(i => i.id === items[2].id).isDeleted;
  // MD5
  results.md5 = !!(await lib.md5File(path.join(lib.itemDir(root, items[0].id), '改名测试.png')));
  // 网页拖图链路（虚拟文件字节直存，如 avif）
  const dragged = await importItemFromBuffer(root, { buffer: png, name: '网页拖图.avif', type: 'image/avif', folderIds: [f1.id].filter(Boolean) });
  results.bufferImport = dragged.ext === 'avif' && (await lib.readItem(root, dragged.id)).ext === 'avif';
  // 2. 网络导入链路端到端（提取 → 逐张下载入库）
  console.log('[pigeon] FUNC_TEST 阶段1完成，开始网络链路');
  try {
    const data = await extractPageImages('https://cn.bing.com/images/search?q=poster+design');
    const imgs = data.images || [];
    results.extractCount = imgs.length;
    results.blobCandidates = imgs.filter(u => u.startsWith('blob:')).length;
    // 矩阵实验：定位 ERR_BLOCKED_BY_CLIENT 的触发条件
    const testUrl = imgs.find(u => /^https?:\/\//i.test(u));
    if (testUrl) {
      results.refererHeaderCheck = await (async () => {
        try {
          const { net } = require('electron');
          const r = await withTimeout(net.fetch(testUrl, { headers: { 'User-Agent': BROWSER_UA, 'Referer': 'https://cn.bing.com/' }, session: win.webContents.session }), 30000, 'v');
          return r.ok ? 'ok' : 'HTTP ' + r.status;
        } catch (e) { return String(e.message).replace(/^.*?(net::)?/, '').slice(0, 40); }
      })();
    }
    let ok = 0; const errs = [];
    for (const u of imgs.filter(u => /^https?:\/\//i.test(u)).slice(0, 3)) {
      try { const r = await importFromUrl(u, 'https://cn.bing.com/images/search?q=poster+design', []); if (r.ok) ok++; else errs.push('html:' + u.slice(0, 60)); }
      catch (e) { errs.push(String(e.message).slice(0, 120)); }
    }
    results.importOk = ok;
    results.importErrors = errs;
    results.afterImportScan = (await lib.scanItems(root)).length;
  } catch (e) { results.networkError = String(e.message).slice(0, 200); }
  // 3. Pinterest 实测（可能受网络环境影响，只记录不判定）
  console.log('[pigeon] FUNC_TEST bing链路完成，开始 Pinterest 探测');
  try {
    const pd = await extractPageImages('https://www.pinterest.com/search/pins/?q=poster%20design');
    const pimgs = pd.images || [];
    results.pinterestExtract = pimgs.length;
    results.pinterestBlob = pimgs.filter(u => u.startsWith('blob:')).length;
    const first = pimgs.find(u => /^https?:\/\//i.test(u));
    if (first) {
      try { const r = await importFromUrl(first, 'https://www.pinterest.com/', []); results.pinterestImport = r.ok ? 'ok ext=' + r.item.ext : 'html'; }
      catch (e) { results.pinterestImport = 'ERR ' + String(e.message).slice(0, 150); }
    } else results.pinterestImport = 'no-candidate';
  } catch (e) { results.pinterestExtract = 'ERR ' + String(e.message).slice(0, 150); }
  // β 功能断言：自动导入 / 截图 / PDF 缩略图
  const watchDir = path.join(app.getPath('temp'), 'pigeon-watch-test');
  await fs.remove(watchDir); await fs.ensureDir(watchDir);
  const beforeWatch = (await lib.scanItems(root)).length;
  applyAutoImport(mergeSettings({ autoImport: { enabled: true, folders: [watchDir] } }));
  await fs.writeFile(path.join(watchDir, 'watched.png'), png);
  await new Promise(r => setTimeout(r, 5000));
  results.autoImport = (await lib.scanItems(root)).length > beforeWatch;
  stopWatchers();
  await fs.remove(watchDir);

  const beforeCap = (await lib.scanItems(root)).length;
  await captureFullForTest();
  await new Promise(r => setTimeout(r, 1500));
  results.capture = (await lib.scanItems(root)).length > beforeCap;

  const pdfItem = await lib.createItemFromBuffer(root, { buffer: makeTestPdf(), name: 'PDF测试', ext: 'pdf' });
  await generatePdfThumbnail(root, pdfItem);
  results.pdfThumb = fs.existsSync(path.join(lib.itemDir(root, pdfItem.id), 'thumbnail.png'));

  // AI 闭环断言：图像/文本向量化 + 概念打标
  try {
    const ai = getAiRuntime();
    await ai.ensureModel();
    ai.loadVectors(root);
    const aiItem = await lib.createItemFromBuffer(root, { buffer: png, name: 'AI测试图', ext: 'png' });
    const vec = await ai.embedItem(root, aiItem);
    results.aiVecDim = vec ? vec.length : 0;
    results.aiSelfSim = Math.round(ai.cosine(vec, vec) * 100) / 100;
    results.aiQueryDim = (await ai.embedQuery('一只鹅在雪地里')).length;
    results.aiTags = await ai.autoTagItem(root, aiItem, vec);
  } catch (e) { results.aiError = String(e.message).slice(0, 120); }

  // 壁纸断言：默认开启 + 背景图已设置
  const wpState = await win.webContents.executeJavaScript(`({ cls: document.body.classList.contains('wallpaper-on'), bg: (document.getElementById('wallpaper').style.backgroundImage || '').slice(0, 50) })`);
  results.wallpaperOn = wpState.cls === true && wpState.bg.length > 0;

  console.log('[pigeon] FUNC_TEST ' + JSON.stringify(results));
  await fs.remove(root);
  app.exit(0);
}

// ---------- 截图模式（开发自检用） ----------
async function shotMode() {
  const fsx = require('fs-extra');
  const outDir = path.join(__dirname, 'shots');
  await fsx.ensureDir(outDir);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const shot = async (name) => {
    const img = await win.webContents.capturePage();
    await fsx.writeFile(path.join(outDir, name), img.toPNG());
    console.log('shot:', name);
  };
  await sleep(3000);
  await win.webContents.executeJavaScript(`window.__test && window.__test.selectFirst()`);
  await sleep(800);
  await shot('1-browse-inspector.png');
  await win.webContents.executeJavaScript(`window.__test && window.__test.openPreview()`);
  await sleep(1500);
  await shot('2-preview.png');
  await win.webContents.executeJavaScript(`window.__test && window.__test.closePreview()`);
  await win.webContents.executeJavaScript(`window.__test && window.__test.openBrowser()`);
  await sleep(8000);
  await shot('5-browser.png');
  await win.webContents.executeJavaScript(`window.__test && window.__test.closeBrowser()`);
  await win.webContents.executeJavaScript(`window.__test && window.__test.openUrlModal('https://www.bing.com/images/search?q=pigeon')`);
  await sleep(14000);
  await shot('6-url-import.png');
  await win.webContents.executeJavaScript(`window.__test && window.__test.closeUrlModal(); window.__test.hideMenus();`);
  await win.webContents.executeJavaScript(`window.__test && window.__test.showDup()`);
  await sleep(800);
  await win.webContents.executeJavaScript(`window.__test && window.__test.runDupScanUi()`);
  await sleep(600);
  await shot('7-duplicate.png');
  await win.webContents.executeJavaScript(`window.__test && window.__test.closeDupModal(); window.__test.hideMenus(); window.__test.search('ai');`);
  await sleep(600);
  await shot('4-search.png');
  await win.webContents.executeJavaScript(`window.__test && window.__test.search(''); window.__test.setLayout('list'); window.__test.selectFirst();`);
  await sleep(1000);
  await shot('9-list.png');
  const folderOk = await win.webContents.executeJavaScript(`window.__test.newFolderFlow('回归测试文件夹')`);
  console.log('[pigeon] FOLDER_CHECK ' + JSON.stringify({ folderOk }));
  const pal = await win.webContents.executeJavaScript(`window.__test.paletteCheck()`);
  console.log('[pigeon] PALETTE_CHECK ' + JSON.stringify(pal));
  await win.webContents.executeJavaScript(`window.__test.removeFolderByName('回归测试文件夹')`);
  await sleep(400);
  await win.webContents.executeJavaScript(`window.__test && window.__test.setLayout('waterfall'); window.__test.openSettings();`);
  await sleep(900);
  await shot('10-settings.png');
  await win.webContents.executeJavaScript(`window.__test && window.__test.closeSettings(); window.__test.setLayout('grid');`);
  const wp = await win.webContents.executeJavaScript(`window.__test.enableWallpaper()`);
  await sleep(800);
  await shot('11-wallpaper.png');
  console.log('[pigeon] WALLPAPER_CHECK ' + JSON.stringify({ wp }));
  await win.webContents.executeJavaScript(`window.__test && window.__test.setLayout('waterfall');`);
  await win.webContents.executeJavaScript(`window.__test && window.__test.enableWallpaperOff && window.__test.enableWallpaperOff();`);
  console.log('done');
  app.exit(0);
}

// ---------- 启动 ----------
app.whenReady().then(async () => {
  let formatTest = null;
  if (isPortable) {
    try { await fs.ensureDir(portableLibrariesDir()); } catch (e) {}
  }
  try {
    const cfg = await getConfig();
    applySettings(mergeSettings(cfg.settings));
  } catch (e) {}
  if (isShot) {
    const cfg = await getConfig();
    if (process.env.PIGEON_FORMAT_TEST) {
      // 在窗口创建前构建测试库并切换配置，确保渲染器加载的是测试数据
      formatTest = await buildFormatTestLibrary();
      formatTest.prevLastLibrary = cfg.lastLibrary || defaultLibraryPath();
      await setConfig({ lastLibrary: formatTest.root });
    } else if (!cfg.lastLibrary && (await fs.pathExists(defaultLibraryPath()))) {
      await setConfig({ lastLibrary: defaultLibraryPath() });
    }
  }
  registerIpc();  createWindow();
  attachItemProtocolHandler();
  if (isShot) {
    setTimeout(() => {
      const run = process.env.PIGEON_FUNC_TEST ? funcTest()
        : process.env.PIGEON_FORMAT_TEST ? formatTestShot(formatTest)
        : shotMode();
      run.catch(e => { console.error(e); app.exit(1); });
    }, 500);
  }
});
app.on('window-all-closed', () => app.quit());

// Pigeon — Electron 主进程
'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, protocol, nativeImage } = require('electron');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs-extra');
const lib = require('./lib/library');
const shortcutConfig = require('./lib/shortcuts');
const readClipboard = () => require('./lib/clipboard').readClipboard(clipboard, nativeImage);
let activeJobs = 0, updateStopping = false;
let updater = null;
function trackedJob(fn) { return async function(...args) { if (updateStopping) throw new Error('正在准备更新，请稍后重试'); activeJobs++; try { return await fn.apply(this,args); } finally { activeJobs--; } }; }
let hotkeyErrors = [];
function registerGlobalKey(key, action) { if (!key) return; try { if (!globalShortcut.register(key.replace(/Comma/g,',').replace(/Period/g,'.').replace(/Arrow(Left|Right|Up|Down)/g,'$1'), action)) hotkeyErrors.push(key + ' 已被其他程序占用，未启用'); } catch(e) { hotkeyErrors.push(key + '：' + e.message); } }

// Windows 系统目录自带旧版 onnxruntime.dll，会在 DLL 检索中抢先命中导致崩溃；
// 进程启动第一时间加载我们自己的原生模块（其依赖 DLL 在同目录，优先解析），先入为主
try {
  const ortMain = __dirname.replace('app.asar', 'app.asar.unpacked');
  require(path.join(ortMain, 'node_modules', 'onnxruntime-node'));
} catch (e1) {
  try { require('onnxruntime-node'); } catch (e2) { /* 开发环境或未安装时静默 */ }
}

const isShot = !!process.env.PIGEON_SHOT || !!process.env.PIGEON_FUNC_TEST || !!process.env.PIGEON_FORMAT_TEST || !!process.env.PIGEON_PERF;

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
  autoImport: { enabled: false, folders: [] },
  capture: { enabled: false, hotkey: 'Ctrl+Alt+A' },
  globalHotkey: { enabled: false, show: 'Ctrl+Alt+P', paste: 'Ctrl+Shift+Alt+V' },
  ai: { enabled: false, autoTag: true, semanticSearch: true, model: 'Chinese-CLIP RN50' },
  shortcuts: {},
  updates: { checkOnStart: true, autoDownload: false },
  wallpaper: { enabled: true, mode: 'default', opacity: 0.5 },
};
// 自动导入条目规范化（P1-05）：{path, folderId, tags}；兼容旧版字符串路径数组
function normalizeAutoImportEntry(e) {
  if (typeof e === 'string') return { path: e, folderId: '', tags: [] };
  if (e && typeof e === 'object') {
    return { path: e.path || '', folderId: e.folderId || '', tags: Array.isArray(e.tags) ? e.tags.map(t => String(t).slice(0, 40)) : [] };
  }
  return { path: '', folderId: '', tags: [] };
}
function mergeSettings(stored) {
  const out = JSON.parse(JSON.stringify(SETTINGS_DEFAULTS));
  for (const k of Object.keys(stored || {})) {
    if (typeof out[k] === 'object' && out[k] && !Array.isArray(out[k])) out[k] = Object.assign(out[k], stored[k]);
    else out[k] = stored[k];
  }
  const raw = stored && stored.autoImport && Array.isArray(stored.autoImport.folders) ? stored.autoImport.folders : null;
  const list = (raw || []).map(normalizeAutoImportEntry).slice(0, 3);
  while (list.length < 3) list.push({ path: '', folderId: '', tags: [] });
  // 用户从没配置过监听文件夹时，第 1 槽默认指向系统下载目录
  if (!raw && !list[0].path) {
    try { list[0].path = app.getPath('downloads'); } catch (e) {}
  }
  out.autoImport.folders = list;
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
  for (const entry of settings.autoImport.folders) {
    const dir = entry.path;
    if (!dir || !(fs.existsSync(dir))) continue;
    let pending = new Set(), timer = null;
    const flush = async () => {
      const files = [...pending];
      pending = new Set();
      const root = currentLibraryRoot(); // 收库以稳定后的当前库为准（切库时收入切换后的库）
      if (!files.length || !root) return;
      // 等写入完成（大小稳定）——未写完的文件不会入库
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
      // 目标文件夹属于当前库才映射；失效（被删/不属于该库）则收入未分类并记录
      let folderIds = [];
      if (entry.folderId) {
        try {
          const meta = await lib.openLibrary(root);
          folderIds = lib.findFolder(meta.folders, entry.folderId) ? [entry.folderId] : [];
        } catch (e) {}
        if (!folderIds.length) console.warn('[pigeon] 自动导入目标文件夹不在当前库，收入未分类:', entry.folderId);
      }
      const created = await lib.importFiles(root, stable, folderIds);
      await aiTagNewItems(created, root);
      // 默认标签：并集合并，不动素材已有标签
      if (entry.tags && entry.tags.length) {
        for (const it of created) {
          try {
            const merged = [...new Set([...(it.tags || []), ...entry.tags])];
            if (merged.length !== (it.tags || []).length) await lib.updateItem(root, it.id, { tags: merged });
          } catch (e) {}
        }
      }
      if (created.failures && created.failures.length) {
        console.warn('[pigeon] 自动导入部分失败:', JSON.stringify(created.failures.slice(0, 5)));
      }
      if (created.length && win && !win.isDestroyed()) {
        win.webContents.send('pigeon:imported', created);
      }
    };
    try {
      const w = fs.watch(dir, (event, filename) => {
        if (!filename) return;
        const full = path.join(dir, filename);
        pending.add(full); // 同一文件的重复事件在 flush 时自然合并为一次导入
        clearTimeout(timer);
        timer = setTimeout(flush, 1200);
      });
      watcherHandles.push(w);
    } catch (e) { console.warn('[pigeon] 监听失败:', dir, e.message); }
  }
}
function applyGlobalHotkeys(settings) {
  hotkeyErrors = [];
  try { globalShortcut.unregisterAll(); } catch (e) {}
  if (settings.capture.enabled && settings.capture.hotkey) {
    try {
      registerGlobalKey(settings.capture.hotkey, () => startCapture());
    } catch (e) { console.warn('[pigeon] 截图快捷键注册失败:', e.message); }
  }
  if (settings.globalHotkey.enabled) {
    try {
      if (settings.globalHotkey.show) registerGlobalKey(settings.globalHotkey.show, () => {
        if (!win) return;
        if (win.isVisible() && win.isFocused()) win.hide();
        else { win.show(); win.focus(); }
      });
      if (settings.globalHotkey.paste) registerGlobalKey(settings.globalHotkey.paste, async () => {
        const root = currentLibraryRoot();
        if (!root) return;
        const { image: img } = await readClipboard();
        if (img.isEmpty()) return;
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

// rootOverride：显式指定目标库（批量收藏整批绑定同一库时使用）；默认当前库
async function importFromUrl(srcUrl, pageUrl, folderIds, rootOverride) {
  const root = rootOverride || currentLibraryRoot();
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
  await aiTagNewItems([item], root);
  return { ok: true, item };
}

function net_fetch2(url, referrer) {
  const { net } = require('electron');
  // 注意：Referer 必须用 referrer 选项，塞进 headers 会被 Chromium 拦截（ERR_BLOCKED_BY_CLIENT）
  const opts = { headers: { 'User-Agent': BROWSER_UA }, session: win.webContents.session };
  if (referrer) opts.referrer = referrer;
  return withTimeout(net.fetch(url, opts), 45000, '请求资源');
}

// ---------- 浏览器扩展本机接收服务（P0-01） ----------
// 扩展 → http://127.0.0.1:<port>（带配对令牌）→ 这里 → 复用 importFromUrl 入库。
// 服务不直接写资料库；不读取/转发浏览器 Cookie 等敏感信息（扩展只提交图片 URL）。
const { createBridgeServer } = require('./lib/bridge-server');
let bridge = null;         // createBridgeServer 实例
let bridgePort = null;     // 实际监听端口

// 一次收藏任务的注册表：弹窗一次「收藏」可能拆成多个 ≤60 张的子批（跨多个 HTTP 请求），
// taskId 由服务端签发并绑定任务开始时的资料库；子批次即使中途切库也写同一个库。
// 客户端只能携带服务端签发的 16 位十六进制 id，不能指定任意磁盘路径。
const bridgeTasks = new Map(); // taskId → { root, at }
const BRIDGE_TASK_TTL = 30 * 60e3;
let bridgeNow = () => Date.now(); // 可控时钟：funcTest 用（快进验证过期，不必实际等待）
function pruneBridgeTasks() {
  const now = bridgeNow();
  for (const [k, t] of bridgeTasks) if (now - t.at > BRIDGE_TASK_TTL) bridgeTasks.delete(k);
}
function libraryNameOf(root) { return path.basename(root).replace(/\.pigeon$/, ''); }

function currentLibraryName() {
  const root = currentLibraryRoot();
  return root ? path.basename(root).replace(/\.pigeon$/, '') : null;
}

async function startBridge() {
  const cfg = await getConfig();
  let token = cfg.bridgeToken;
  if (!token || !/^[a-f0-9]{32,64}$/.test(token)) {
    token = crypto.randomBytes(24).toString('hex'); // 48 位十六进制
    await setConfig({ bridgeToken: token });
  }
  bridge = createBridgeServer({
    token,
    getInfo: () => ({ version: app.getVersion(), library: currentLibraryName() }),
    listFolders: async () => {
      const root = currentLibraryRoot();
      if (!root) return [];
      const meta = await lib.openLibrary(root);
      const out = [];
      const walk = (list, trail) => list.forEach(f => {
        out.push({ id: f.id, name: f.name, path: [...trail, f.name].join('/') });
        walk(f.children || [], [...trail, f.name]);
      });
      walk(meta.folders || [], []);
      return out;
    },
    saveItems: trackedJob(async ({ items, folderId, tags, taskId }) => {
      // 任务身份：一次收藏的所有子批次使用同一个目标库。第一批由服务端签发 taskId，
      // 后续子批次沿用；任务过期或伪造的 taskId 一律整批拒绝。
      let task = null;
      if (taskId) {
        task = bridgeTasks.get(taskId);
        // 先判过期、再决定接受与续期：闲置超过 TTL 的任务必须拒绝，
        // 不能先刷新 task.at 让它躲过清理（顺序错误会让过期任务复活）
        if (!task || (bridgeNow() - task.at) > BRIDGE_TASK_TTL) {
          if (task) bridgeTasks.delete(taskId);
          return { batchError: '收藏任务已过期或不存在，请重新发起收藏（已成功项不会重复导入）' };
        }
        task.at = bridgeNow();
      }
      // 任务的资料库身份：第一批固定为当时的当前库；子批次不再跟随当前库变化
      const root = task ? task.root : currentLibraryRoot();
      if (!root) return { batchError: 'Pigeon 未打开资料库' };
      if (folderId) {
        // 目标文件夹必须属于任务的目标库：切库后旧页面的 folderId 会造成孤儿归属
        const meta = await lib.openLibrary(root);
        if (!lib.findFolder(meta.folders || [], folderId)) {
          return { batchError: '目标文件夹不属于收藏任务的目标资料库，整批已取消' };
        }
      }
      let tid = task ? taskId : crypto.randomBytes(8).toString('hex').toUpperCase();
      pruneBridgeTasks();
      if (!task) bridgeTasks.set(tid, { root, at: bridgeNow() });
      // 重试去重：库内已有相同 srcUrl 的素材时跳过，避免重复导入已成功项
      const existing = new Set(
        (await lib.scanItems(root)).filter(i => !i.isDeleted && i.srcUrl).map(i => i.srcUrl));
      const folderIds = folderId ? [folderId] : [];
      const created = [];
      const results = [];
      for (const e of items) {
        if (existing.has(e.srcUrl)) {
          results.push({ srcUrl: e.srcUrl, ok: true, skipped: true, reason: '资料库已存在，已跳过' });
          continue;
        }
        try {
          const r = e.data ? { ok: true, item: await lib.createItemFromBuffer(root, {
            buffer: Buffer.from(e.data,'base64'), ext: EXT_BY_MIME[e.mime] || e.mime.split('/')[1].replace('svg+xml','svg'),
            name: e.name || '网页图片', url: e.pageUrl || '', srcUrl: e.srcUrl, folderIds,
          }) } : await importFromUrl(e.srcUrl, e.pageUrl || '', folderIds, root);
          if (r && r.ok) {
            const it = r.item;
            if (tags && tags.length) {
              // 锁内与最新标签合并（下载期间的状态不再整对象回写）
              await lib.mergeIntoItem(root, it.id, (fresh) => {
                fresh.tags = [...new Set([...(fresh.tags || []), ...tags])];
              });
            }
            existing.add(e.srcUrl);
            created.push(it);
            results.push({ srcUrl: e.srcUrl, ok: true, item: { id: it.id, name: it.name } });
          } else {
            results.push({ srcUrl: e.srcUrl, ok: false, error: '该地址返回的不是图片（HTML 页面）' });
          }
        } catch (err) {
          results.push({ srcUrl: e.srcUrl, ok: false, error: String((err && err.message) || err).slice(0, 160) });
        }
      }
      // 只在用户仍停留在任务目标库时通知渲染端补缩略图，避免把 A 库条目推进 B 库界面
      if (created.length && win && !win.isDestroyed() && currentLibraryRoot() === root) {
        win.webContents.send('pigeon:imported', created);
      }
      return { results, taskId: tid, library: libraryNameOf(root) };
    }),
  });
  const listening = await bridge.start();
  if (!listening) {
    console.warn('[pigeon] 扩展接收服务启动失败：39770-39774 端口都被占用');
    bridgePort = null;
    return { port: null, token };
  }
  bridgePort = listening.port;
  console.log('[pigeon] 扩展接收服务已启动：127.0.0.1:' + bridgePort);
  return { port: bridgePort, token };
}
app.on('before-quit', () => { if (bridge) bridge.stop(); });

// ---------- 自定义协议：pigeon://item/<id>/<文件名> ----------
// 必须在 app ready 之前注册 scheme
protocol.registerSchemesAsPrivileged([
  { scheme: 'pigeon', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
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
const itemsPyCache = new Map(); // 文件名 → 拼音索引（进程级缓存，大库重复 reload 免重算）

// ---------- 拖出原文件（Alt+拖动 → 资源管理器 / 外部应用） ----------
const DRAG_OUT_MAX = 2000; // 单次拖出上限：超过整批拒绝并明确提示，不静默截断
// 解析素材 id → 库内原文件绝对路径；丢失的文件计入 missing（供提示与测试断言复用）。
// 超过上限时返回 overflow（整批拒绝），不返回部分文件让用户误以为全部拖出成功。
async function resolveDragOutFiles(root, ids) {
  const list = Array.isArray(ids) ? ids : [];
  if (list.length > DRAG_OUT_MAX) return { files: [], missing: 0, overflow: list.length };
  const files = [];
  let missing = 0;
  for (const id of list) {
    try {
      const item = await lib.readItem(root, id);
      const p = path.join(lib.itemDir(root, id), item.name + '.' + item.ext);
      if (await fs.pathExists(p)) files.push(p);
      else missing++;
    } catch (e) { missing++; }
  }
  return { files, missing, overflow: 0 };
}
function dragOutIcon() {
  try {
    const img = nativeImage.createFromPath(path.join(__dirname, 'renderer', 'pigeon-icon.png'));
    if (!img.isEmpty()) return img.resize({ width: 64, height: 64 });
  } catch (e) {}
  return nativeImage.createEmpty();
}

// ---------- IPC ----------
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    const task = channel.startsWith('updates:') ? fn : trackedJob(fn);
    try { return { ok: true, data: await task(...args) }; }
    catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  });
}

let aiRuntime = null;
async function aiTagNewItems(items, rootOverride) {
  try {
    const root = rootOverride || currentLibraryRoot();
    if (!root) return items;
    const cfg = await getConfig();
    if (!cfg.settings || !cfg.settings.ai || !cfg.settings.ai.enabled || !cfg.settings.ai.autoTag) return items;
    const ai = getAiRuntime();
    if (!(await ai.ensureModel())) return items;
    await ai.loadVectors(root);
    for (const item of items) {
      try {
        const vec = await ai.embedItem(root, item);
        if (!vec) continue;
        const tags = await ai.autoTagItem(root, item, vec);
        if (tags.length) {
          // 推理耗时期间用户可能已改评分/注释/标签：锁内与最新标签合并，不回写旧对象
          await lib.mergeIntoItem(root, item.id, (fresh) => {
            fresh.tags = [...new Set([...(fresh.tags || []), ...tags])];
          });
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
    // 测试/开发环境可用 PIGEON_MODELS_DIR 指定模型目录
    if (process.env.PIGEON_MODELS_DIR && fs.existsSync(path.join(process.env.PIGEON_MODELS_DIR, 'visual.onnx'))) {
      dir = process.env.PIGEON_MODELS_DIR;
    } else if (!isPortable) {
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
  handle('updates:status', () => updater.snapshot());
  handle('updates:check', () => updater.check());
  handle('updates:download', () => updater.download());
  handle('updates:install', async () => {
    const ready = await win.webContents.executeJavaScript('window.__pigeonBeginUpdate && window.__pigeonBeginUpdate()');
    if (!ready) throw new Error('素材处理尚未完成，请稍后再更新');
    try { return await updater.install(); }
    catch(e) { updateStopping=false; await win.webContents.executeJavaScript('window.__pigeonCancelUpdate && window.__pigeonCancelUpdate()'); throw e; }
  });
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
  handle('library:create', async (name, options = {}) => {
    const base = isShot ? path.join(app.getPath('userData'), 'libraries')
      : path.join(app.isPackaged ? path.dirname(process.execPath) : __dirname, 'data', 'libraries');
    const result = await require('./lib/library-setup').create({
      base, name, createLibrary: lib.createLibrary, fs,
      desktop: app.getPath('desktop'),
      shortcuts: !isShot && options.desktopShortcut !== false && process.platform === 'win32',
      executable: process.execPath, appDir: __dirname, packaged: app.isPackaged,
      icon: app.isPackaged ? path.join(path.dirname(process.execPath), 'resources', 'pigeon.ico') : path.join(__dirname, 'build', 'pigeon.ico'),
      writeShortcut: (file, details) => shell.writeShortcutLink(file, 'create', details),
    });
    currentLibraryRoot = () => result.root;
    await rememberLibrary(result.root);
    if (!isShot) await dialog.showMessageBox(win, { type: 'info', title: '资料库已创建', message: '资料库已创建', detail: '保存位置：' + result.root + '\n' + (result.shortcuts.length ? '桌面快捷方式已创建。' : '') + (result.warning ? '\n' + result.warning : ''), buttons: ['开始使用', '打开资料库文件夹'] }).then(async r => { if (r.response === 1) await shell.openPath(result.root); });
    return result;
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
    // 拼音索引（全拼 + 首字母）供搜索用；缓存进程级复用（大库每次 reload 免重算）
    let Pinyin = null;
    try { Pinyin = require('tiny-pinyin'); } catch (e) {}
    for (const it of items) {
      if (!Pinyin) break;
      const key = it.name;
      if (itemsPyCache.has(key)) { it._py = itemsPyCache.get(key); continue; }
      let py = null;
      try {
        if (Pinyin.isSupported() && /\p{Script=Han}/u.test(key)) {
          py = {
            full: Pinyin.getFullChars(key).toLowerCase(),
            head: Pinyin.getCamelChars(key).toLowerCase(),
          };
        }
      } catch (e) {}
      itemsPyCache.set(key, py);
      it._py = py;
    }
    return items;
  });
  handle('item:update', (id, patch, rootOverride) => {
    // rootOverride：批量/撤销等长操作显式绑定目标库（中途切库不改写入目标）；默认当前库
    const root = (typeof rootOverride === 'string' && rootOverride) || currentLibraryRoot();
    if (!root) throw new Error('未打开资料库');
    return lib.updateItem(root, id, patch);
  });
  handle('item:readIn', (root, id) => {
    if (typeof root !== 'string' || !root) throw new Error('未指定资料库');
    return lib.readItem(root, id);
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
  // 文件夹默认标签（P1-06）
  handle('folder:setDefaultTags', (id, tags) => lib.setFolderDefaultTags(currentLibraryRoot(), id, tags));
  handle('folder:defaultTagsOf', async (id) => {
    const meta = await lib.openLibrary(currentLibraryRoot());
    return lib.folderDefaultTags(meta.folders, id);
  });

  // ---- 标签管理（P1-01） ----
  handle('tags:rename', (oldTag, newTag) => lib.renameTag(currentLibraryRoot(), oldTag, newTag));
  handle('tags:merge', (sources, target) => lib.mergeTags(currentLibraryRoot(), sources, target));
  handle('tags:delete', (tag) => lib.deleteTag(currentLibraryRoot(), tag));
  handle('library:setTagsGroups', async (groups) => {
    const root = currentLibraryRoot();
    return lib.withMetaLock(root, async () => {
      const meta = await lib.openLibrary(root);
      meta.tagsGroups = groups || [];
      await lib.saveLibraryMeta(root, meta);
      return meta.tagsGroups;
    });
  });

  // ---- 转换导出（P2-03）：渲染端 canvas 转码后经这里落盘（重名自动加序号） ----
  handle('dialog:pickExportDir', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('item:writeExportFile', async (dir, suggested, arrayBuffer) => {
    let name = String(suggested || '导出文件').replace(/[\\/:*?"<>|]/g, '_');
    let target = path.join(dir, name);
    let k = 1;
    const m = name.match(/^(.*?)(\.[^.]+)$/);
    while (await fs.pathExists(target)) {
      name = `${m ? m[1] : name} (${k++})${m ? m[2] : ''}`;
      target = path.join(dir, name);
    }
    await fs.writeFile(target, Buffer.from(arrayBuffer));
    return name;
  });

  // 拖出原文件：渲染进程在 dragstart（Alt 按下）时同步 send，这里发起系统级文件拖拽。
  // 只拖出副本（copy），不会移动/删除库内文件。
  ipcMain.on('item:dragOut', async (event, ids) => {
    const root = currentLibraryRoot();
    if (!root || !Array.isArray(ids) || !ids.length) return;
    const { files, missing, overflow } = await resolveDragOutFiles(root, ids);
    if (overflow) {
      event.sender.send('pigeon:dragOutResult', {
        ok: false,
        error: `选择了 ${ids.length} 个，超过单次拖出上限 ${DRAG_OUT_MAX}，已取消；请减少选择分次拖出`,
        overflow,
      });
      return;
    }
    if (!files.length) {
      event.sender.send('pigeon:dragOutResult', { ok: false, error: '原文件丢失：没有可拖出的文件', missing });
      return;
    }
    try {
      event.sender.startDrag({ files, icon: dragOutIcon() });
      if (missing) event.sender.send('pigeon:dragOutResult', { ok: true, count: files.length, missing });
    } catch (e) {
      event.sender.send('pigeon:dragOutResult', { ok: false, error: String((e && e.message) || e), missing });
    }
  });

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
    const { image: img } = await readClipboard();
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
  handle('clipboard:readPaste', async () => {
    const { image: img, text, html } = await readClipboard();
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
    return lib.withMetaLock(root, async () => {
      const meta = await lib.openLibrary(root);
      meta.smartFolders = sfs;
      await lib.saveLibraryMeta(root, meta);
      return meta.smartFolders;
    });
  });

  // ---- 多库 ----
  handle('library:listKnown', async () => {
    const cfg = await getConfig();
    return cfg.libraries || (cfg.lastLibrary ? [cfg.lastLibrary] : []);
  });

  handle('app:version', () => app.getVersion() + '-demo');
  // ---- 浏览器扩展 ----
  handle('bridge:info', async () => {
    const cfg = await getConfig();
    return {
      running: bridgePort != null,
      port: bridgePort,
      token: cfg.bridgeToken || '',
      library: currentLibraryName(),
    };
  });
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
  handle('settings:hotkeyStatus', () => hotkeyErrors);
  handle('settings:get', async () => {
    const cfg = await getConfig();
    return mergeSettings(cfg.settings);
  });
  handle('settings:set', async (patch) => {
    const cfg = await getConfig();
    const merged = mergeSettings(Object.assign({}, cfg.settings, patch));
    shortcutConfig.validate(merged.shortcuts, { '全局截图': merged.capture.hotkey, '全局显示': merged.globalHotkey.show, '全局粘贴': merged.globalHotkey.paste });
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
    if (!(await ai.ensureModel())) throw new Error('AI 模型未就绪');
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
    // 不在全库侧截断 top-N：范围/筛选由渲染端在打分结果之上应用，先截断会漏掉本应命中的条目
    const hits = scored.filter(s => s.score > 0.15);
    return topN ? hits.slice(0, topN) : hits;
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
      // 推理期间用户可能已改评分/注释/标签：锁内与最新标签合并，不回写旧对象（与自动打标同规）
      await lib.mergeIntoItem(root, id, (fresh) => {
        fresh.tags = [...new Set([...(fresh.tags || []), ...tags])];
      });
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
  const root = path.join(app.getPath('temp'), 'pigeon-func-test.pigeon');
  const rootB = path.join(app.getPath('temp'), 'pigeon-func-switch-b.pigeon');
  // 快照配置：测试会切换当前库与 AI 设置；无论正常/异常结束都在 finally 恢复，不污染开发配置
  const cfgBefore = await getConfig();
  const prevLastLibrary = cfgBefore.lastLibrary || '';
  const prevLibraries = (cfgBefore.libraries || []).filter(p => p !== rootB && p !== root && !/pigeon-(func|format)-test\.pigeon$/i.test(p));
  const prevSettings = cfgBefore.settings || null;
  let exitCode = 0;
  try {
  await fs.remove(root);
  await fs.remove(rootB);
  await lib.createLibrary(rootB, '切换库B');
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

  // P0-04：删除父文件夹需级联清理整棵子树的素材关联，且不影响其他文件夹归属
  const fc1 = await lib.addFolder(root, '级联父');
  const fc2 = await lib.addFolder(root, '级联子', fc1.id);
  const fc3 = await lib.addFolder(root, '级联孙', fc2.id);
  const fOther = await lib.addFolder(root, '无关夹');
  await lib.updateItem(root, items[1].id, { folders: [fc3.id, fOther.id] });
  const removedIds = await lib.removeFolder(root, fc1.id);
  const cascadeItem = await lib.readItem(root, items[1].id);
  const metaCascade = await lib.openLibrary(root);
  results.folderDeleteCascade = Array.isArray(removedIds) && removedIds.length === 3
    && !cascadeItem.folders.includes(fc3.id)
    && cascadeItem.folders.includes(fOther.id)
    && !JSON.stringify(metaCascade.folders).includes(fc2.id)
    && !JSON.stringify(metaCascade.folders).includes(fc3.id)
    && (await fs.pathExists(path.join(lib.itemDir(root, items[1].id), items[1].name + '.' + items[1].ext)));

  // P0-03：拖出原文件的路径解析（多选 / 中文名带空格 / 原文件丢失计数）
  const cn = await lib.createItemFromBuffer(root, { buffer: png, name: '中文名 带空格', ext: 'png' });
  const drag1 = await resolveDragOutFiles(root, [items[0].id, cn.id]);
  results.dragOutResolve = drag1.files.length === 2 && drag1.missing === 0
    && drag1.files.every(f => f.startsWith(path.join(root, 'images')) && fs.existsSync(f));
  await fs.remove(path.join(lib.itemDir(root, cn.id), '中文名 带空格.png'));
  const drag2 = await resolveDragOutFiles(root, [cn.id, items[0].id]);
  results.dragOutMissing = drag2.files.length === 1 && drag2.missing === 1;

  // 【缺陷用例 P2】拖出不得静默截断：501 项必须全部处理，不得丢 1 项无声无息
  const manyIds = Array.from({ length: 501 }, (_, i) => [items[0].id, items[1].id][i % 2]);
  const drag3 = await resolveDragOutFiles(root, manyIds);
  results.dragOutOverflow501 = drag3.files.length === 501 && drag3.missing === 0 && !drag3.overflow;
  // 超过单次上限：整批拒绝并给出数量，不允许部分成功让用户误以为全部拖出
  const hugeIds = Array.from({ length: 2001 }, () => items[0].id);
  const drag4 = await resolveDragOutFiles(root, hugeIds);
  results.dragOutOverflowRefuse = drag4.files.length === 0 && drag4.overflow === 2001;

  // ---- 数据可靠性（原子写入 / 并发字段合并 / 改名回退） ----
  const drItem = await lib.createItemFromBuffer(root, { buffer: png, name: '可靠测试', ext: 'png' });
  await lib.updateItem(root, drItem.id, { annotation: '甲', rating: 3 });
  await Promise.all([
    lib.updateItem(root, drItem.id, { annotation: '乙' }),
    lib.updateItem(root, drItem.id, { rating: 5, star: true }),
  ]);
  const drAfter = await lib.readItem(root, drItem.id);
  results.concurrentFields = drAfter.annotation === '乙' && drAfter.rating === 5 && drAfter.star === true;
  // 改名回退：模拟元数据写失败，磁盘文件应保持原名（不留文件新名/元数据旧名的不一致）
  const realWriteItem = lib.writeItemLocked;
  lib.writeItemLocked = async () => { throw new Error('模拟写入失败'); };
  let rollbackThrew = false;
  try { await lib.updateItem(root, drItem.id, { name: '改名应回退' }); } catch (e) { rollbackThrew = true; }
  lib.writeItemLocked = realWriteItem;
  results.renameRollback = rollbackThrew
    && (await fs.pathExists(path.join(lib.itemDir(root, drItem.id), '可靠测试.png')))
    && !(await fs.pathExists(path.join(lib.itemDir(root, drItem.id), '改名应回退.png')));
  // 原子写：全部操作后库内不残留 .tmp- 临时文件
  const tmpLeft = [];
  const scanTmp = async (dir) => {
    for (const n of await fs.readdir(dir)) {
      const p = path.join(dir, n);
      if ((await fs.stat(p)).isDirectory()) await scanTmp(p);
      else if (n.includes('.tmp-')) tmpLeft.push(p);
    }
  };
  await scanTmp(root);
  results.atomicNoTmpLeft = tmpLeft.length === 0;
  // 【四返 P1】原子替换：替换失败时旧内容必须仍可读（fs.move 是"先删后移"，不满足）。
  // 用独立测试文件做靶子，不碰真实条目元数据。
  const atomicTarget = path.join(lib.itemDir(root, drItem.id), 'atomic-test.json');
  await fs.writeJson(atomicTarget, { keep: true });
  const beforeAtomic = await fs.readJson(atomicTarget);
  lib.__renameForTest = async () => { throw new Error('模拟替换失败'); };
  let replaceThrew = false;
  try { await lib.jsonAtomicWrite(atomicTarget, { gone: true }); } catch (e) { replaceThrew = true; }
  lib.__renameForTest = null;
  results.atomicReplaceFailKeepsOld = replaceThrew
    && JSON.stringify(await fs.readJson(atomicTarget)) === JSON.stringify(beforeAtomic);
  // 【四返 P1】并发原子写：交错读永不损坏/缺失；最终为某次完整写入
  // 【五返 P2】断言修正：必须对 await 后的读取结果计数（旧版在数 Promise 对象，永真）
  const payloads = Array.from({ length: 8 }, (_, i) => ({ i, pad: 'x'.repeat(300) }));
  lib.__renameForTest = async (a, b) => { await new Promise(r => setTimeout(r, 5)); return lib.renameWithRetry(a, b); };
  const cJobs = payloads.map(p => lib.jsonAtomicWrite(atomicTarget, p));
  const cReadPromises = [];
  for (let k = 0; k < 40; k++) cReadPromises.push(fs.readJson(atomicTarget).then(() => 'ok', () => 'READ_FAIL'));
  const allOutcomes = await Promise.all([...cJobs, ...cReadPromises]);
  lib.__renameForTest = null;
  const readOutcomes = allOutcomes.slice(cJobs.length);
  const readFailsFound = readOutcomes.filter(r => r === 'READ_FAIL').length;
  const finalAtomic = await fs.readJson(atomicTarget);
  results.atomicConcurrentNoTorn = readFailsFound === 0 && payloads.some(p => p.i === finalAtomic.i);
  // 门禁灵敏度自检：注入一次必然失败的读取，必须能被检出（防断言再次退化为永真）
  results.concurrentReadGateSensitive = ['ok', await Promise.reject(new Error('x')).catch(() => 'READ_FAIL'), 'ok']
    .filter(r => r === 'READ_FAIL').length === 1;
  // 【四返】库级元数据读-改-写必须串行：并发建 8 个文件夹不丢失
  await Promise.all(Array.from({ length: 8 }, (_, i) => lib.addFolder(root, '并发夹' + i)));
  const metaAfterRace = await lib.openLibrary(root);
  results.metaLockConcurrentFolders = metaAfterRace.folders.filter(f => f.name.startsWith('并发夹')).length === 8;
  // 【四返】writeItem 全量覆写并发：文件始终完整（回归）
  const ow = await lib.createItemFromBuffer(root, { buffer: png, name: '覆写并发', ext: 'png' });
  await Promise.all(Array.from({ length: 6 }, (_, i) => lib.writeItem(root, Object.assign({}, ow, { annotation: '覆写' + i }))));
  const owAfter = await lib.readItem(root, ow.id);
  results.writeItemConcurrentNoTorn = typeof owAfter.annotation === 'string' && owAfter.annotation.startsWith('覆写');

  // ---- P1-01 库层：标签重命名/合并/删除的引用一致性 ----
  const tA = await lib.createItemFromBuffer(root, { buffer: png, name: '标签甲', ext: 'png' });
  const tB = await lib.createItemFromBuffer(root, { buffer: png, name: '标签乙', ext: 'png' });
  await lib.updateItem(root, tA.id, { tags: ['旧名', '保留'] });
  await lib.updateItem(root, tB.id, { tags: ['旧名'] });
  const sfMeta = await lib.openLibrary(root);
  sfMeta.smartFolders = [
    { id: 'sf1', name: '智能旧', filter: { search: '', exts: [], tags: ['旧名'], minRating: 0, shape: '', days: 0, color: null } },
    { id: 'sfScope', name: '范围夹', filter: { search: '', exts: [], tags: [], minRating: 0, shape: '', days: 0, color: null, scope: { kind: 'tag', id: '旧名', label: '#旧名' } } },
  ];
  sfMeta.tagsGroups = [{ id: 'g1', name: '群组', tags: ['旧名', '别的'] }];
  await lib.saveLibraryMeta(root, sfMeta);
  const fDef = await lib.addFolder(root, '默认引用夹');
  await lib.setFolderDefaultTags(root, fDef.id, ['旧名']);
  const rn = await lib.renameTag(root, '旧名', '新名');
  const rnA = await lib.readItem(root, tA.id);
  const rnMeta = await lib.openLibrary(root);
  results.tagRename = rn.updated === 2 && rn.failures.length === 0
    && rnA.tags.join() === '新名,保留'
    && rnMeta.smartFolders[0].filter.tags.join() === '新名'
    && rnMeta.tagsGroups[0].tags.join() === '新名,别的';
  // 【四返 P2】标签引用必须覆盖：文件夹默认标签 + 智能文件夹标签范围
  const fDefAfterRename = lib.findFolder(rnMeta.folders, fDef.id).folder;
  const sfScopeAfterRename = rnMeta.smartFolders.find(s => s.id === 'sfScope');
  const refsRenameOk = fDefAfterRename.defaultTags.join() === '新名'
    && sfScopeAfterRename.filter.scope && sfScopeAfterRename.filter.scope.id === '新名';
  const mg = await lib.mergeTags(root, ['保留'], '合并目标');
  const mgA = await lib.readItem(root, tA.id);
  results.tagMerge = mg.updated === 1 && mg.failures.length === 0 && mgA.tags.join() === '新名,合并目标';
  const dl = await lib.deleteTag(root, '新名');
  const dlA = await lib.readItem(root, tA.id);
  const dlB = await lib.readItem(root, tB.id);
  const dlMeta = await lib.openLibrary(root);
  results.tagDelete = dl.updated === 2 && dlA.tags.join() === '合并目标' && dlB.tags.length === 0
    && dlMeta.smartFolders[0].filter.tags.length === 0;
  // 【四返 P2】删除后：默认标签清空、标签范围失效回退（不残留旧引用）
  const fDefAfterDel = lib.findFolder(dlMeta.folders, fDef.id).folder;
  const sfScopeAfterDel = dlMeta.smartFolders.find(s => s.id === 'sfScope');
  const refsDeleteOk = (fDefAfterDel.defaultTags || []).length === 0
    && !(sfScopeAfterDel.filter.scope && sfScopeAfterDel.filter.scope.id);
  results.tagRefsFull = refsRenameOk && refsDeleteOk;

  // ---- P1-06 库层：文件夹默认标签（祖先继承并集） ----
  const dfParent = await lib.addFolder(root, '默认标签父');
  const dfChild = await lib.addFolder(root, '默认标签子', dfParent.id);
  await lib.setFolderDefaultTags(root, dfParent.id, ['父标签']);
  await lib.setFolderDefaultTags(root, dfChild.id, ['子标签']);
  results.folderDefaultTagsLib = lib.folderDefaultTags((await lib.openLibrary(root)).folders, dfChild.id).join() === '父标签,子标签';

  // ---- 六返 P1：扫描后并发修改不得被旧数组补丁覆盖 ----
  // 经 scanItems 接缝在「扫描完成、返回快照」前注入一次基于最新值的用户修改；
  // 被测操作拿到的是改动前快照——旧代码按快照算好 tags/folders 整组传给 updateItem，
  // 会把并发新增内容覆盖掉；修复后操作须在锁内基于最新数组重算并复判条件。
  const withScanInterleave = (rootPath, mutate) => {
    const realScanItems = lib.scanItems;
    let armed = true;
    lib.scanItems = async function (r) {
      const items = await realScanItems(r);
      if (armed && r === rootPath) { armed = false; await mutate(); }
      return items; // 返回注入前的快照
    };
    let done = false;
    return () => { if (!done) { lib.scanItems = realScanItems; done = true; } };
  };
  const addUserTag = async (id, tag) => {
    const cur = await lib.readItem(root, id);
    await lib.updateItem(root, id, { tags: [...new Set([...(cur.tags || []), tag])] });
  };
  const addUserFolder = async (id, fid) => {
    const cur = await lib.readItem(root, id);
    await lib.updateItem(root, id, { folders: [...new Set([...(cur.folders || []), fid])] });
  };
  let restore6 = () => {};
  try {
    const it6 = await lib.createItemFromBuffer(root, { buffer: png, name: '六返标签', ext: 'png' });
    // 1) 重命名：扫描后新增用户标签
    await lib.updateItem(root, it6.id, { tags: ['六旧', '六留'] });
    restore6 = withScanInterleave(root, () => addUserTag(it6.id, '六新增'));
    const r6 = await lib.renameTag(root, '六旧', '六新');
    restore6();
    const it6a = await lib.readItem(root, it6.id);
    results.tagInterleaveRename = r6.updated === 1
      && it6a.tags.includes('六新') && it6a.tags.includes('六留') && it6a.tags.includes('六新增');
    // 2) 合并：扫描后新增用户标签
    await lib.updateItem(root, it6.id, { tags: ['六合并源', '六留2'] });
    restore6 = withScanInterleave(root, () => addUserTag(it6.id, '六新增2'));
    const m6 = await lib.mergeTags(root, ['六合并源'], '六合并目标');
    restore6();
    const it6b = await lib.readItem(root, it6.id);
    results.tagInterleaveMerge = m6.updated === 1
      && it6b.tags.includes('六合并目标') && it6b.tags.includes('六留2') && it6b.tags.includes('六新增2')
      && !it6b.tags.includes('六合并源');
    // 3) 删除：扫描后新增用户标签
    await lib.updateItem(root, it6.id, { tags: ['六删', '六留3'] });
    restore6 = withScanInterleave(root, () => addUserTag(it6.id, '六新增3'));
    const d6 = await lib.deleteTag(root, '六删');
    restore6();
    const it6c = await lib.readItem(root, it6.id);
    results.tagInterleaveDelete = d6.updated === 1
      && it6c.tags.includes('六新增3') && it6c.tags.includes('六留3') && !it6c.tags.includes('六删');
    // 4) 删除文件夹：扫描后素材另加入文件夹 C——B 与 C 的归属都必须保留
    const fA6 = await lib.addFolder(root, '六返夹A');
    const fB6 = await lib.addFolder(root, '六返夹B');
    const fC6 = await lib.addFolder(root, '六返夹C');
    await lib.updateItem(root, it6.id, { folders: [fA6.id, fB6.id] });
    restore6 = withScanInterleave(root, () => addUserFolder(it6.id, fC6.id));
    await lib.removeFolder(root, fA6.id);
    restore6();
    const it6d = await lib.readItem(root, it6.id);
    const f6 = it6d.folders || [];
    results.folderInterleaveRemove = f6.includes(fB6.id) && f6.includes(fC6.id) && !f6.includes(fA6.id);
  } catch (e) {
    results.interleaveError = String(e.message).slice(0, 200);
  } finally {
    restore6();
  }

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
  // β 功能断言：自动导入（P1-05：目录→目标文件夹+默认标签；未写完/重复事件/切库/目标失效）
  const watchDir = path.join(app.getPath('temp'), 'pigeon-watch-test');
  await fs.remove(watchDir); await fs.ensureDir(watchDir);
  const fWatch = await lib.addFolder(root, '自动导入目标');
  applyAutoImport(mergeSettings({ autoImport: { enabled: true, folders: [{ path: watchDir, folderId: fWatch.id, tags: ['自动', '导入'] }] } }));
  await fs.writeFile(path.join(watchDir, 'watched.png'), png);
  // 未写完文件：flush（1.2s）前追加一次 —— 大小稳定检查应只入库最终版一次
  await new Promise(r => setTimeout(r, 300));
  await fs.appendFile(path.join(watchDir, 'watched.png'), Buffer.from([0]));
  await new Promise(r => setTimeout(r, 5000));
  const wItems = (await lib.scanItems(root)).filter(i => i.name === 'watched');
  const wItem = wItems[0];
  results.autoImport = wItems.length === 1 && !!wItem
    && (wItem.folders || []).includes(fWatch.id)
    && (wItem.tags || []).includes('自动') && (wItem.tags || []).includes('导入')
    && wItem.size === png.length + 1;
  // 切库：flush 时的当前库收到文件（收入切换后的库 B）
  currentLibraryRoot = () => rootB;
  await fs.writeFile(path.join(watchDir, 'watched2.png'), png);
  await new Promise(r => setTimeout(r, 5000));
  currentLibraryRoot = () => root;
  results.autoImportSwitchLib = (await lib.scanItems(rootB)).filter(i => i.name === 'watched2').length === 1;
  // 目标文件夹被删：收入未分类而不是失败/悬空关联
  await lib.removeFolder(root, fWatch.id);
  await fs.writeFile(path.join(watchDir, 'watched3.png'), png);
  await new Promise(r => setTimeout(r, 5000));
  const w3 = (await lib.scanItems(root)).filter(i => i.name === 'watched3');
  results.autoImportDeletedFolder = w3.length === 1 && (w3[0].folders || []).length === 0;
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

  // 【五返 P1】AI 推理期间用户修改评分/注释/标签：旧对象不得覆盖新字段（锁内合并到最新值）
  try {
    const aiR = getAiRuntime();
    const modelReady = await aiR.ensureModel().catch(() => false);
    const cfgPrevAI = await getConfig();
    if (modelReady) {
      // 完整真实路径：embedItem 期间注入一次用户修改，autoTagItem 固定返回 AI标签
      await setConfig({ settings: mergeSettings({ ai: { enabled: true, autoTag: true } }) });
      const itp = await lib.createItemFromBuffer(root, { buffer: png, name: 'AI交错', ext: 'png' });
      await lib.updateItem(root, itp.id, { rating: 0, annotation: '', tags: [] });
      const realEmbed = aiR.embedItem.bind(aiR);
      const realAuto = aiR.autoTagItem.bind(aiR);
      aiR.embedItem = async (r, item) => {
        await lib.updateItem(root, itp.id, { rating: 5, annotation: '用户注释', tags: ['用户标签'] });
        return realEmbed(r, item);
      };
      aiR.autoTagItem = async () => ['AI标签'];
      await aiTagNewItems([await lib.readItem(root, itp.id)]);
      aiR.embedItem = realEmbed;
      aiR.autoTagItem = realAuto;
      await setConfig({ settings: cfgPrevAI.settings || mergeSettings({}) });
      const after = await lib.readItem(root, itp.id);
      results.aiMergeNoStaleOverwrite = after.rating === 5 && after.annotation === '用户注释'
        && (after.tags || []).includes('用户标签') && (after.tags || []).includes('AI标签')
        && (after.tags || []).length === 2;
    } else {
      // 模型缺失时退化为直接验证合并原语：并发补丁与锁内合并不互相覆盖
      const itq = await lib.createItemFromBuffer(root, { buffer: png, name: '合并原语', ext: 'png' });
      await lib.updateItem(root, itq.id, { rating: 0, tags: [] });
      const p = lib.updateItem(root, itq.id, { rating: 5, annotation: '用户注释' });
      await lib.mergeIntoItem(root, itq.id, f => { f.tags = [...(f.tags || []), 'AI标签']; });
      await p;
      const after = await lib.readItem(root, itq.id);
      results.aiMergeNoStaleOverwrite = after.rating === 5 && after.annotation === '用户注释'
        && (after.tags || []).join() === 'AI标签';
    }
  } catch (e) { results.aiMergeError = String(e.message).slice(0, 160); }

  // 壁纸断言：默认开启 + 背景图已设置
  const wpState = await win.webContents.executeJavaScript(`({ cls: document.body.classList.contains('wallpaper-on'), bg: (document.getElementById('wallpaper').style.backgroundImage || '').slice(0, 50) })`);
  results.wallpaperOn = wpState.cls === true && wpState.bg.length > 0;

  // 设置面板：浏览器扩展区块渲染与状态回填（P0-01 UI 冒烟）
  const bridgeUi = await win.webContents.executeJavaScript(`(async () => {
    window.__test.openSettings();
    await new Promise(r => setTimeout(r, 500));
    const t = {
      hasSection: !!document.querySelector('#bridge-status'),
      status: (document.querySelector('#bridge-status') || {}).textContent || '',
      url: (document.querySelector('#bridge-url') || {}).textContent || '',
      token: (document.querySelector('#bridge-token') || {}).textContent || '',
    };
    window.__test.closeSettings();
    return t;
  })()`);
  results.bridgeSettingsUi = bridgeUi.hasSection && /运行中/.test(bridgeUi.status)
    && /127\.0\.0\.1:\d+/.test(bridgeUi.url) && bridgeUi.token.length > 5;

  // 首次启动：真实走渲染器「新建资料库」API（便携版自动落位 data/libraries）
  if (isPortable) {
    const cr = await win.webContents.executeJavaScript(`
      window.pigeon.library.create('首启建库测试').then(r => ({ root: r.root, name: r.meta.name }))
    `);
    results.firstRunCreate = !!cr.root && fs.existsSync(path.join(cr.root, 'metadata.json'));
    await fs.remove(cr.root);
  } else {
    results.firstRunCreate = 'skipped (dev)';
  }

  // P0-01：扩展接收服务端到端（离线：本地静态 PNG 服务 + 真实 HTTP 调用）
  if (bridgePort) {
    const http = require('http');
    // 静态服务：第一张图（/a1）下载完成时把当前库切到 B——
    // 旧代码在每张下载前重读当前库，第二张就会写进 B（复现跨库混写）
    let flipOnce = false;
    const staticSrv = http.createServer((req, res) => {
      if (!flipOnce && req.url.startsWith('/a1')) { flipOnce = true; currentLibraryRoot = () => rootB; }
      res.setHeader('Content-Type', 'image/png'); res.end(png);
    });
    await new Promise(r => staticSrv.listen(0, '127.0.0.1', r));
    const staticPort = staticSrv.address().port;
    const pngUrl = `http://127.0.0.1:${staticPort}/%E6%B5%8B%E8%AF%95%E5%9B%BE.png`;
    const httpReq = (p, opts) => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: bridgePort, path: p, ...opts }, res => {
        let data = ''; res.on('data', c => data += c); res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      req.on('error', reject);
      if (opts.body) req.write(opts.body);
      req.end();
    });
    try {
      const bcfg = await getConfig();
      const noToken = await httpReq('/ping', {});
      results.bridgeNoToken = noToken.status === 401;
      const badOrigin = await httpReq('/ping', { headers: { 'x-pigeon-token': bcfg.bridgeToken, origin: 'http://evil.example' } });
      results.bridgeBadOrigin = badOrigin.status === 403;
      const pingOk = await httpReq('/ping', { headers: { 'x-pigeon-token': bcfg.bridgeToken } });
      results.bridgePing = JSON.parse(pingOk.body).app === 'Pigeon';
      const foldersOk = await httpReq('/folders', { headers: { 'x-pigeon-token': bcfg.bridgeToken } });
      results.bridgeFolders = Array.isArray(JSON.parse(foldersOk.body).folders);
      const fExt = await lib.addFolder(root, '扩展收藏夹');
      const saveBody = JSON.stringify({ items: [{ srcUrl: pngUrl, pageUrl: 'http://127.0.0.1/page' }], folderId: fExt.id, tags: ['扩展', '测试'] });
      const save1 = await httpReq('/save', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-pigeon-token': bcfg.bridgeToken }, body: saveBody });
      const r1 = JSON.parse(save1.body).results[0];
      let diskOk = false, metaOk = false;
      if (r1.ok && r1.item) {
        diskOk = await fs.pathExists(path.join(lib.itemDir(root, r1.item.id), r1.item.name + '.png'));
        if (diskOk) {
          const m = await lib.readItem(root, r1.item.id);
          metaOk = (m.folders || []).includes(fExt.id) && (m.tags || []).includes('扩展')
            && m.url === 'http://127.0.0.1/page' && m.srcUrl === pngUrl;
        }
      }
      results.bridgeSave = diskOk && metaOk;
      // 入库链路完整性：pigeon:imported → 渲染端 postProcess 应生成缩略图。
      // 紧跟 save1 轮询（避免后续 60 张批量挤占渲染队列导致抖动）
      let thumbOk = false;
      if (r1.ok && r1.item) {
        for (let i = 0; i < 30 && !thumbOk; i++) {
          await new Promise(r2 => setTimeout(r2, 500));
          thumbOk = await fs.pathExists(path.join(lib.itemDir(root, r1.item.id), 'thumbnail.png'));
        }
      }
      results.bridgeThumbAfterImport = thumbOk;
      const save2 = await httpReq('/save', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-pigeon-token': bcfg.bridgeToken }, body: saveBody });
      results.bridgeDupSkip = JSON.parse(save2.body).results[0].skipped === true;
      const save3 = await httpReq('/save', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-pigeon-token': bcfg.bridgeToken }, body: JSON.stringify({ items: [{ srcUrl: 'http://127.0.0.1:1/不可达.png' }] }) });
      const s3 = JSON.parse(save3.body);
      results.bridgeFailVisible = s3.results[0].ok === false && typeof s3.results[0].error === 'string' && s3.summary.failed === 1;

      // Browser-side download reserves a library before fetching bytes; source URL need not be reachable by desktop.
      currentLibraryRoot = () => root;
      const byteHeaders = { 'Content-Type': 'application/json', 'x-pigeon-token': bcfg.bridgeToken, origin: 'chrome-extension://capture-test' };
      const reserve = await httpReq('/tasks', {method:'POST',headers:byteHeaders,body:JSON.stringify({folderId:fExt.id,tags:['浏览器字节']})});
      const reserved = JSON.parse(reserve.body);
      currentLibraryRoot = () => rootB;
      const byteUrl='https://private.example.invalid/image.png';
      const byteSave=await httpReq('/save',{method:'POST',headers:byteHeaders,body:JSON.stringify({taskId:reserved.taskId,folderId:fExt.id,tags:['浏览器字节'],items:[{srcUrl:byteUrl,pageUrl:'https://private.example.invalid/project',mime:'image/png',data:png.toString('base64')}]})});
      const byteResult=JSON.parse(byteSave.body).results?.[0];
      const byteMeta=byteResult?.ok ? await lib.readItem(root,byteResult.item.id) : null;
      results.bridgeBrowserBytes=reserve.status===200 && !!byteMeta && byteMeta.srcUrl===byteUrl && byteMeta.url==='https://private.example.invalid/project' && byteMeta.tags.includes('浏览器字节') && byteMeta.folders.includes(fExt.id)
        && (await fs.readFile(path.join(lib.itemDir(root,byteMeta.id),byteMeta.name+'.png'))).equals(png)
        && !(await fs.pathExists(lib.itemDir(rootB,byteMeta.id)));
      const invalidBytes=await httpReq('/save',{method:'POST',headers:byteHeaders,body:JSON.stringify({items:[{srcUrl:byteUrl,mime:'image/png',data:'not base64'}]})});
      results.bridgeInvalidBytes=invalidBytes.status===400;
      // 【缺陷用例 P1】切库后，旧库的 folderId 必须被整批拒绝（避免孤儿归属/跨库混写）
      currentLibraryRoot = () => rootB;
      const guard = await httpReq('/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-pigeon-token': bcfg.bridgeToken },
        body: JSON.stringify({ items: [{ srcUrl: pngUrl }], folderId: fExt.id, tags: [] }),
      });
      const guardJ = JSON.parse(guard.body);
      results.bridgeFolderGuard = guard.status === 400 && /文件夹/.test(String(guardJ.error || ''));
      currentLibraryRoot = () => root;

      // 【缺陷用例 P1】下载中切库：整批（下载+元数据+标签）必须都落在批次开始时的库
      const beforeB = (await lib.scanItems(rootB)).length;
      const sw = await httpReq('/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-pigeon-token': bcfg.bridgeToken },
        body: JSON.stringify({
          items: [
            { srcUrl: `http://127.0.0.1:${staticPort}/a1.png`, pageUrl: 'http://127.0.0.1/page' },
            { srcUrl: `http://127.0.0.1:${staticPort}/flip.png`, pageUrl: 'http://127.0.0.1/page' },
          ],
          tags: ['切库'],
        }),
      });
      currentLibraryRoot = () => root; // 无论批次中发生什么，后续以 A 为准
      const swJ = JSON.parse(sw.body);
      const itemsA = (await lib.scanItems(root)).filter(i => (i.tags || []).includes('切库'));
      const filesInA = [];
      for (const it of itemsA) filesInA.push(await fs.pathExists(path.join(lib.itemDir(root, it.id), it.name + '.' + it.ext)));
      results.bridgeSwitchLib = swJ.summary && swJ.summary.saved === 2
        && itemsA.length === 2 && filesInA.every(Boolean)
        && (await lib.scanItems(rootB)).length === beforeB;

      // 【缺陷用例 P2】服务端 60/61 批量边界：61 拒绝并说明，60 整批成功
      const H = { 'Content-Type': 'application/json', 'x-pigeon-token': bcfg.bridgeToken };
      const mkBody = (n) => JSON.stringify({ items: Array.from({ length: n }, (_, i) => ({ srcUrl: `http://127.0.0.1:${staticPort}/t${i}.png` })), tags: ['批量'] });
      const over = await httpReq('/save', { method: 'POST', headers: H, body: mkBody(61) });
      results.bridgeBatchLimit = over.status === 400 && /60/.test(String((JSON.parse(over.body) || {}).error || ''));
      const full = await httpReq('/save', { method: 'POST', headers: H, body: mkBody(60) });
      const fullJ = JSON.parse(full.body);
      results.bridgeBatch60 = full.status === 200 && fullJ.summary && fullJ.summary.saved === 60;

      // 【缺陷用例 P1·二次返工】一次收藏任务（61 张 = 60+1 两批）跨批次切库：
      // 弹窗第一批不带 taskId，拿到服务端返回的任务身份；批间用户切到 B 库；
      // 第二批必须凭 taskId 继续写 A 库——不能悄悄改目标库（「未分类」无 folderId 挡不住）
      const mkN = (n, off) => Array.from({ length: n }, (_, i) => ({ srcUrl: `http://127.0.0.1:${staticPort}/task${off + i}.png` }));
      const t1 = await httpReq('/save', { method: 'POST', headers: H, body: JSON.stringify({ items: mkN(60, 0) }) });
      const t1j = JSON.parse(t1.body);
      currentLibraryRoot = () => rootB; // 第一批完成、第二批未发：用户切库
      const t2 = await httpReq('/save', { method: 'POST', headers: H, body: JSON.stringify({ items: mkN(1, 60), taskId: t1j.taskId }) });
      currentLibraryRoot = () => root;
      const t2j = JSON.parse(t2.body);
      const taskItems = (await lib.scanItems(root)).filter(i => /\/task\d+\.png$/.test(i.srcUrl || ''));
      const taskFiles = [];
      for (const it of taskItems) taskFiles.push(await fs.pathExists(path.join(lib.itemDir(root, it.id), it.name + '.' + it.ext)));
      results.bridgeTaskAcrossSwitch = /^[A-F0-9]{16}$/.test(t1j.taskId || '')
        && t2.status === 200 && t2j.summary && t2j.summary.saved === 1
        && taskItems.length === 61 && taskFiles.every(Boolean)
        && (await lib.scanItems(rootB)).length === beforeB; // B 库保持为空
      // 服务端不接受伪造/未知任务身份
      const forged = await httpReq('/save', { method: 'POST', headers: H, body: JSON.stringify({ items: mkN(1, 99), taskId: 'DEADBEEFDEADBEEF' }) });
      results.bridgeTaskForgedId = forged.status === 400;
      // 【缺陷用例 P2·三次返工】任务过期顺序：必须先判过期、再决定接受与续期。
      // 可控时钟快进 31 分钟（BRIDGE_TASK_TTL=30 分钟），不实际等待。
      try {
        const jumpMs = Date.now() + 31 * 60e3;
        bridgeNow = () => jumpMs;
        const expReq = await httpReq('/save', { method: 'POST', headers: H, body: JSON.stringify({ items: mkN(1, 100), taskId: t1j.taskId }) });
        bridgeNow = () => Date.now();
        const expJ = JSON.parse(expReq.body);
        results.bridgeTaskExpired = expReq.status === 400 && /过期/.test(String(expJ.error || ''));
      } catch (e2) {
        bridgeNow = () => Date.now();
        results.bridgeTaskExpired = false;
      }
    } catch (e) {
      results.bridgeError = String(e.message).slice(0, 200);
    } finally {
      staticSrv.close();
    }
  } else {
    results.bridgeError = '接收服务未启动';
  }

  // P0-02：渲染端 AI 搜索遵守范围与筛选（在临时测试库上验证，不触碰用户库）
  try {
    const scope = await win.webContents.executeJavaScript(`
      (async () => {
        await openLibrary(${JSON.stringify(root)});
        const buf = Uint8Array.from(atob(${JSON.stringify(png.toString('base64'))}), c => c.charCodeAt(0)).buffer;
        const mk = (name, folders) => window.pigeon.import.buffer(name, 'image/png', buf, folders);
        const fA = await window.pigeon.folders.add('AI范围A');
        const fB = await window.pigeon.folders.add('AI范围B');
        const a1 = await mk('范围甲1.png', [fA.id]);
        const a2 = await mk('范围甲2.png', [fA.id]);
        const cross = await mk('范围跨.png', [fA.id, fB.id]);
        const b1 = await mk('范围乙1.png', [fB.id]);
        const tr = await mk('范围废.png', [fA.id]);
        await window.pigeon.items.trash([tr.id], true);
        await window.pigeon.items.update(a1.id, { rating: 5 });
        await reload();
        // 注入模拟 AI 结果：乙/废分数最高——若实现错误（先按全库分数排序再过滤）它们会越界出现
        const scored = [[a1, .50], [a2, .40], [cross, .45], [b1, .90], [tr, .99]];
        state.aiMode = true;
        state.search = '范围测试';
        state.aiResults = { query: '范围测试', ids: scored.map(s => s[0].id), scores: Object.fromEntries(scored.map(s => [s[0].id, s[1]])) };
        const t = {};
        state.view = { kind: 'folder', id: fA.id, label: 'AI范围A' };
        t.folderScope = computeVisible().map(i => i.name).join('|') === '范围甲1|范围跨|范围甲2';
        state.filters.minRating = 3;
        t.filterRespect = computeVisible().map(i => i.name).join('|') === '范围甲1';
        state.filters.minRating = 0;
        state.view = { kind: 'all', id: null, label: '全部' };
        t.allViewOrder = computeVisible().map(i => i.name).join('|') === '范围乙1|范围甲1|范围跨|范围甲2';
        // AI ⇄ 普通切换不丢搜索词
        document.getElementById('btn-ai-chip').click();
        t.toggleKeepsQuery = !state.aiMode && state.search === '范围测试';
        document.getElementById('btn-ai-chip').click();
        // 清空搜索：立即回到普通列表，不残留 AI 空态
        document.getElementById('search-clear').click();
        t.clearSearchRestores = state.search === '' && computeVisible().length > 0;
        return t;
      })()
    `);
    results.aiScopeFolder = scope.folderScope === true;
    results.aiScopeFilter = scope.filterRespect === true;
    results.aiAllView = scope.allViewOrder === true;
    results.aiToggleKeeps = scope.toggleKeepsQuery === true;
    results.aiClearSearch = scope.clearSearchRestores === true;

    // 在途请求生命周期：可控延迟 Promise 精确控制完成顺序，五个场景独立断言。
    // 不用真实模型（避免把错误路径当成功路径），不靠空 scores 模拟旧结果。
    const inflight = await win.webContents.executeJavaScript(`
      (async () => {
        const t = {};
        const flush = () => new Promise(r => setTimeout(r, 30));
        const busyOn = () => document.querySelector('.search-box').classList.contains('busy');
        const ctrl = [];
        window.__test.aiSearchImpl = (q) => new Promise((res, rej) => ctrl.push({ q, res, rej }));
        state.aiMode = true;
        state.search = '第一';
        // —— 场景 1 成功乱序：后发先至；旧请求后到必须被丢弃 ——
        runSemanticSearch('第一');
        runSemanticSearch('第二');
        ctrl[1].res([{ id: 'x2', score: .9 }]);
        await flush();
        t.orderSuccessLatest = !!(state.aiResults && state.aiResults.query === '第二' && state.aiResults.ids[0] === 'x2');
        ctrl[0].res([{ id: 'x1', score: .8 }]);
        await flush();
        t.orderSuccessStaleDropped = !!(state.aiResults && state.aiResults.query === '第二' && state.aiResults.ids[0] === 'x2');
        // —— 场景 2 失败乱序：最新的失败态不得被旧请求的成功覆盖 ——
        ctrl.length = 0;
        runSemanticSearch('旧成功');
        runSemanticSearch('新失败');
        ctrl[1].rej(new Error('模拟失败'));
        await flush();
        t.orderFailureLatest = !!(state.aiResults && state.aiResults.query === '新失败' && state.aiResults.ids.length === 0);
        ctrl[0].res([{ id: 'y1', score: .7 }]);
        await flush();
        t.orderFailureStaleDropped = !!(state.aiResults && state.aiResults.query === '新失败' && state.aiResults.ids.length === 0);
        // —— 场景 3 切库：A 库在途请求，切到 B 库并选中素材后返回 ——
        // 不得写 aiResults、不得清空选择；busy 归属：切库自动重查在途时，旧请求不得摘掉它的 busy
        ctrl.length = 0;
        state.search = '跨库';
        runSemanticSearch('跨库');
        await openLibrary(${JSON.stringify(rootB)});
        state.selection.clear(); state.selection.add('B库选中');
        const busyBeforeStale = busyOn();          // 自动重查在途 → 应为 true
        ctrl[0].res([{ id: 'A库旧结果', score: .99 }]);
        await flush();
        const busyAfterStale = busyOn();           // 自动重查仍在途 → 必须仍为 true
        if (ctrl.length > 1) { ctrl[1].res([]); await flush(); } // 让切库后的自动重查完成（其结果是合法的新状态）
        // 旧请求的结果不得出现（自动重查可能合法写入同名 query 的空结果，用分数表区分）
        t.switchLibInflightDropped = state.selection.has('B库选中')
          && !(state.aiResults && state.aiResults.scores && state.aiResults.scores['A库旧结果']);
        t.busyNotStolenByStale = busyBeforeStale === true && busyAfterStale === true && busyOn() === false;
        // —— 场景 4 清空搜索（按钮）：在途请求，清空并选中素材后返回 ——
        // 上下文失效必须立即清除 busy（旧代码会残留 true）
        ctrl.length = 0;
        state.aiMode = true; state.search = '将清空';
        runSemanticSearch('将清空');
        document.getElementById('search-clear').click();
        const busyAfterClearBtn = busyOn();
        state.selection.clear(); state.selection.add('清空后选中');
        ctrl[0].res([{ id: 'z', score: .9 }]);
        await flush();
        t.clearSearchInflightDropped = state.search === '' && state.selection.has('清空后选中')
          && (!state.aiResults || state.aiResults.query !== '将清空');
        t.clearSearchBusyCleared = busyAfterClearBtn === false && busyOn() === false;
        // —— 场景 5 退出 AI 模式：在途请求，切普通模式并选中素材后返回 ——
        ctrl.length = 0;
        state.aiMode = true; state.search = '将退出';
        runSemanticSearch('将退出');
        document.getElementById('btn-ai-chip').click();
        const busyAfterChipOff = busyOn();
        state.selection.clear(); state.selection.add('退出后选中');
        ctrl[0].res([{ id: 'w', score: .9 }]);
        await flush();
        t.exitAiInflightDropped = state.aiMode === false && state.aiResults === null
          && state.selection.has('退出后选中');
        t.exitAiBusyCleared = busyAfterChipOff === false && busyOn() === false;
        // —— 场景 6 键盘删空（真实 input 事件 → debounce 入口）：在途请求返回不得写状态/清选择 ——
        ctrl.length = 0;
        state.aiMode = true; state.search = '键盘清空';
        const kbInp = document.getElementById('search');
        kbInp.value = '键盘清空';
        runSemanticSearch('键盘清空');
        kbInp.value = '';
        kbInp.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 480)); // 等 debounce(200ms) 生效
        state.selection.clear(); state.selection.add('键盘清空后选中');
        ctrl[0].res([{ id: 'kb', score: .9 }]);
        await flush();
        t.keyboardClearInflightDropped = state.search === '' && state.selection.has('键盘清空后选中')
          && (!state.aiResults || state.aiResults.query !== '键盘清空');
        // —— 场景 7 加载状态归属（同库两请求）：旧请求结束不得摘掉新请求的 busy ——
        ctrl.length = 0;
        state.aiMode = true; state.search = '归属';
        runSemanticSearch('归属旧');
        runSemanticSearch('归属新');
        const owned = busyOn();
        ctrl[0].res([{ id: 'o', score: .9 }]);
        await flush();
        const kept = busyOn();
        ctrl[1].res([{ id: 'n', score: .9 }]);
        await flush();
        t.busyOwnership = owned === true && kept === true && busyOn() === false;
        window.__test.aiSearchImpl = null;
        return t;
      })()
    `);
    results.aiOrderSuccess = inflight.orderSuccessLatest === true && inflight.orderSuccessStaleDropped === true;
    results.aiOrderFailure = inflight.orderFailureLatest === true && inflight.orderFailureStaleDropped === true;
    results.aiSwitchLibInflight = inflight.switchLibInflightDropped === true;
    results.aiClearSearchInflight = inflight.clearSearchInflightDropped === true;
    results.aiExitAiInflight = inflight.exitAiInflightDropped === true;
    results.aiKeyboardClearInflight = inflight.keyboardClearInflightDropped === true;
    results.aiBusyClearedOnInvalidate = inflight.clearSearchBusyCleared === true && inflight.exitAiBusyCleared === true;
    results.aiBusyNotStolen = inflight.busyNotStolenByStale === true;
    results.aiBusyOwnership = inflight.busyOwnership === true;
    currentLibraryRoot = () => root; // 回到 A 库
  } catch (e) {
    results.aiScopeError = String(e.message).slice(0, 200);
  }

  // ---- P1/P2 渲染端验收：默认标签 / 撤销重做 / 范围筛选 / 智能文件夹 / 转换导出 ----
  const convDir = path.join(app.getPath('temp'), 'pigeon-conv-test');
  await fs.remove(convDir).catch(() => {});
  await fs.ensureDir(convDir);
  try {
    const p1t = await win.webContents.executeJavaScript(`
      (async () => {
        await openLibrary(${JSON.stringify(root)});
        state.aiMode = false; // 前一组 AI 在途测试可能把模式留在开——这里测的是普通链路
        document.getElementById('btn-ai-chip').classList.remove('on');
        const t = {};
        const buf = Uint8Array.from(atob(${JSON.stringify(png.toString('base64'))}), c => c.charCodeAt(0)).buffer;
        const mk = (name, patch) => window.pigeon.import.buffer(name, 'image/png', buf, (patch && patch.folders) || [])
          .then(async it => { if (patch) { delete patch.folders; if (Object.keys(patch).length) await window.pigeon.items.update(it.id, patch); } return it; });
        const resetFilters = () => { state.filters = { exts:new Set(), tags:new Set(), minRating:0, shape:'', days:0, color:null, minSize:0, minW:0, minH:0, minDur:0, maxDur:0 }; };
        // —— P1-06 文件夹默认标签：父设置→子加入继承；手动标签保留；移出不回收 ——
        const fP = await window.pigeon.folders.add('渲染默认父');
        const fC = await window.pigeon.folders.add('渲染默认子', fP.id);
        await window.pigeon.folders.setDefaultTags(fP.id, ['渲染父标']);
        await reload();
        const dItem = await mk('默认标签示例.png', { tags: ['手动标签'] });
        await reload(true);
        await addItemsToFolder([dItem.id], fC.id); // 内部已 reload
        let cur = state.items.find(i => i.id === dItem.id);
        t.folderTagsApplied = (cur.tags || []).includes('渲染父标') && (cur.tags || []).includes('手动标签') && (cur.folders || []).includes(fC.id);
        await window.pigeon.items.update(dItem.id, { folders: [] });
        await reload(true);
        t.folderTagsKeptAfterRemove = (state.items.find(i => i.id === dItem.id).tags || []).includes('渲染父标');
        // —— P1-02 撤销 / 重做 ——
        const u1 = await mk('撤销甲.png');
        const u2 = await mk('撤销乙.png');
        await reload(true);
        await addTagToItems([u1.id, u2.id], '撤销测试');
        await undoOne();
        t.undoTag = !(state.items.find(i => i.id === u1.id).tags || []).includes('撤销测试');
        await redoOne();
        t.redoTag = (state.items.find(i => i.id === u1.id).tags || []).includes('撤销测试');
        await addItemsToFolder([u1.id], fC.id);   // 归档同时会打默认标签
        await undoOne();
        cur = state.items.find(i => i.id === u1.id);
        t.undoArchive = !(cur.folders || []).includes(fC.id) && !(cur.tags || []).includes('渲染父标');
        state.selection.clear(); state.selection.add(u2.id);
        await trashSelection();
        t.trashed = state.items.find(i => i.id === u2.id).isDeleted === true;
        await undoOne();
        t.undoTrash = state.items.find(i => i.id === u2.id).isDeleted === false;
        await applyBatchRename([u1.id], '{name}-批量');
        t.batchRenamed = state.items.find(i => i.id === u1.id).name === '撤销甲-批量';
        await undoOne();
        t.undoBatchRename = state.items.find(i => i.id === u1.id).name === '撤销甲';
        // 部分失败：撤销条目里混入不存在的 id —— 只影响坏项，好项照常撤销
        const pOk = await mk('部分失败甲.png');
        await window.pigeon.items.update(pOk.id, { rating: 5 });
        await reload(true);
        undoStacks.get(state.root).undo.push({ root: state.root, label: '构造部分失败', ops: [
          { id: 'BAD000000001', patch: { rating: 5 } },
          { id: pOk.id, patch: { rating: 0 } },
        ] });
        await undoOne();
        t.undoPartialFail = state.items.find(i => i.id === pOk.id).rating === 0;
        // 切库隔离：A 库历史不被 B 库消费
        const depthA = undoStacks.get(state.root).undo.length;
        await openLibrary(${JSON.stringify(rootB)});
        await undoOne(); // B 库没有历史 → 应提示且不动 A
        t.undoIsolated = undoStacks.get(${JSON.stringify(root)}).undo.length === depthA;
        await openLibrary(${JSON.stringify(root)});
        // —— P1-03 范围筛选：大小 / 宽高 / 时长；未知值不计入 ——
        const fBig = await mk('大文件.png', { size: 5 * 1048576, width: 1920, height: 1080 });
        const fSmall = await mk('小文件.png', { size: 100 * 1024, width: 640, height: 480 });
        const fNoDim = await mk('未知尺寸.png', { width: null, height: null, size: 300 * 1048576 });
        const fVid = await window.pigeon.import.buffer('视频样例.mp4', 'video/mp4', buf, []);
        await window.pigeon.items.update(fVid.id, { duration: 65 });
        const fVidShort = await window.pigeon.import.buffer('短视频样例.mp4', 'video/mp4', buf, []);
        await window.pigeon.items.update(fVidShort.id, { duration: 5 });
        await reload(true);
        state.view = { kind: 'all', id: null, label: '全部' };
        document.getElementById('search-clear').click();
        resetFilters();
        const only = () => computeVisible().map(i => i.name);
        state.filters.minSize = 1048576;
        t.sizeFilter = only().includes('大文件') && only().includes('未知尺寸') && !only().includes('小文件');
        state.filters.minSize = 0; state.filters.minW = 1000;
        t.widthFilter = only().includes('大文件') && !only().includes('未知尺寸');
        state.filters.minW = 0; state.filters.minH = 1000;
        t.heightFilter = only().includes('大文件') && !only().includes('小文件');
        state.filters.minH = 0; state.filters.minDur = 30;
        t.durationFilter = only().includes('视频样例') && !only().includes('大文件');
        t.diagDur = 'dur30:' + only().slice(0, 5).join('|');
        state.filters.minDur = 0; state.filters.maxDur = 10;
        // 语义：时长筛选只作用于音视频（图片/未知时长不计入）
        t.maxDurationFilter = only().includes('短视频样例') && !only().includes('视频样例') && !only().includes('大文件');
        t.diagDurMax = 'dur10:' + only().slice(0, 5).join('|');
        state.filters.maxDur = 0;
        // 筛选 chips 展示（可单独清除入口存在）
        state.filters.minSize = 1048576; state.filters.minW = 1000;
        renderFilterBar();
        t.filterChips = $$('#filter-bar .chip').length >= 3;
        // —— P1-04 智能文件夹：范围保存 + 重新加载（模拟重启）后一致 + 旧格式兼容 ——
        const fScope = await window.pigeon.folders.add('智能范围夹');
        await addItemsToFolder([fBig.id], fScope.id);
        state.view = { kind: 'folder', id: fScope.id, label: '智能范围夹' };
        state.filters.minSize = 1048576; state.filters.minW = 1000;
        state.smartFolders = [...(state.smartFolders || []), { id: 'sft1', name: '智能测试夹', filter: {
          search: '', exts: [], tags: [], minRating: 0, shape: '', days: 0, color: null,
          minSize: 1048576, minW: 1000, minH: 0, minDur: 0, maxDur: 0, scope: scopeOfView(),
        } }];
        state.smartFolders = await api.smartFolders.set(state.smartFolders);
        await reload(); // 模拟重启：从库元数据重新读取
        const sf = state.smartFolders.find(s => s.id === 'sft1');
        await applySmartFolder(sf);
        t.sfScopeApplied = state.view.kind === 'folder' && state.view.id === fScope.id;
        t.sfFilterApplied = state.filters.minSize === 1048576 && state.filters.minW === 1000
          && computeVisible().every(i => (i.size || 0) >= 1048576 && (i.width || 0) >= 1000)
          && computeVisible().some(i => i.id === fBig.id);
        // 旧格式（无 scope / 无数值字段）：按全部素材应用，不报错
        state.smartFolders = await api.smartFolders.set([...state.smartFolders.filter(s => s.id !== 'sfold1'), { id: 'sfold1', name: '旧格式夹', filter: { search: '大文件', exts: [], tags: [] } }]);
        await reload();
        await applySmartFolder(state.smartFolders.find(s => s.id === 'sfold1'));
        t.sfOldCompat = state.view.kind === 'all' && state.search === '大文件' && computeVisible().some(i => i.name === '大文件');
        t.diagOld = 'view=' + state.view.kind + ' q=' + state.search + ' n=' + computeVisible().length + ' first=' + (computeVisible()[0] || {}).name;
        window.__lastP1Diag = { dur: (t.diagDur || '') + ' // ' + (t.diagDurMax || ''), old: t.diagOld };
        document.getElementById('search-clear').click();
        resetFilters();
        state.view = { kind: 'all', id: null, label: '全部' };
        renderAll();
        // —— P2-03 转换导出核心（不弹对话框）：JPEG 魔数 / 最大边 / 透明白底 / 不支持反馈 / 重名落盘 ——
        const big = state.items.find(i => i.name === '大文件');
        const cv = await convertBlobFor(big, { fmt: 'jpeg', quality: 0.9, maxSide: 5 });
        const cvBytes = new Uint8Array(await cv.arrayBuffer());
        t.convertJpegMagic = cvBytes[0] === 0xFF && cvBytes[1] === 0xD8;
        const bmp = await createImageBitmap(cv);
        t.convertMaxSide = Math.max(bmp.width, bmp.height) <= 5;
        const c2 = document.createElement('canvas'); c2.width = 8; c2.height = 8;
        const tBlob = await new Promise(r => c2.toBlob(r, 'image/png'));
        await window.pigeon.import.buffer('透明样例.png', 'image/png', await tBlob.arrayBuffer(), []);
        await reload(true);
        const cv2 = await convertBlobFor(state.items.find(i => i.name === '透明样例'), { fmt: 'jpeg', quality: 0.9, maxSide: 0 });
        const bmp2 = await createImageBitmap(cv2);
        const cc = document.createElement('canvas'); cc.width = 8; cc.height = 8;
        cc.getContext('2d').drawImage(bmp2, 0, 0);
        const px = cc.getContext('2d').getImageData(0, 0, 1, 1).data;
        t.convertJpegWhiteBg = px[0] > 240 && px[1] > 240 && px[2] > 240;
        await window.pigeon.import.buffer('不支持样例.tif', 'image/tiff', buf, []);
        await reload(true);
        let cvErr = '';
        try { await convertBlobFor(state.items.find(i => i.name === '不支持样例'), { fmt: 'png', quality: 1, maxSide: 0 }); }
        catch (e) { cvErr = String(e.message); }
        t.convertUnsupportedMsg = /不支持/.test(cvErr);
        const n1 = await api.exportFiles.write(${JSON.stringify(convDir)}, '重名导出.png', cvBytes.buffer.slice(0));
        const n2 = await api.exportFiles.write(${JSON.stringify(convDir)}, '重名导出.png', cvBytes.buffer.slice(0));
        t.exportRename = n1 === '重名导出.png' && n2 === '重名导出 (1).png';
        return t;
      })()
    `);
    results.p1FolderDefaultTags = p1t.folderTagsApplied === true && p1t.folderTagsKeptAfterRemove === true;
    results.p1UndoTag = p1t.undoTag === true && p1t.redoTag === true;
    results.p1UndoArchive = p1t.undoArchive === true;
    results.p1UndoTrash = p1t.trashed === true && p1t.undoTrash === true;
    results.p1UndoBatchRename = p1t.batchRenamed === true && p1t.undoBatchRename === true;
    results.p1UndoPartialFail = p1t.undoPartialFail === true;
    results.p1UndoIsolated = p1t.undoIsolated === true;
    results.p1SizeFilter = p1t.sizeFilter === true;
    results.p1DimFilter = p1t.widthFilter === true && p1t.heightFilter === true;
    results.p1DurationFilter = p1t.durationFilter === true && p1t.maxDurationFilter === true;
    results.p1FilterChips = p1t.filterChips === true;
    results.p1SmartFolderScope = p1t.sfScopeApplied === true && p1t.sfFilterApplied === true;
    results.p1SmartFolderOldCompat = p1t.sfOldCompat === true;
    results.p2Convert = p1t.convertJpegMagic === true && p1t.convertMaxSide === true
      && p1t.convertJpegWhiteBg === true && p1t.convertUnsupportedMsg === true;
    results.p2ExportRename = p1t.exportRename === true;
  } catch (e) {
    results.p1Error = String(e && (e.stack || e.message) || e).slice(0, 500);
  }

  // ---- 四返 P1：批量操作与撤销贯穿绑定资料库（操作中途切库 + 两库共享素材 ID） ----
  try {
    // 【五返补】手动打标真实 IPC 入口（ai:autoTagItem）：主进程侧注入「推理期间用户修改」
    const aiRManual = getAiRuntime();
    const realAutoTagManual = aiRManual.autoTagItem.bind(aiRManual);
    aiRManual.autoTagItem = async (r, item, vec) => {
      await lib.updateItem(r, item.id, { rating: 5, annotation: '用户注释', tags: ['用户标签'] });
      return ['手动AI'];
    };
    let xlib = null;
    try {
      // 造一个 A/B 两库共享相同 ID 的素材（复制 .info 目录，模拟复制/迁移库保留相同 ID）
      const sharedSrc = await lib.createItemFromBuffer(root, { buffer: png, name: '共享ID素材', ext: 'png' });
      await fs.copy(lib.itemDir(root, sharedSrc.id), path.join(lib.imagesDir(rootB), sharedSrc.id + '.info'));
      xlib = await win.webContents.executeJavaScript(`
      (async () => {
        await openLibrary(${JSON.stringify(root)});
        state.aiMode = false;
        const t = {};
        const sharedId = ${JSON.stringify(sharedSrc.id)};
        const buf = Uint8Array.from(atob(${JSON.stringify(png.toString('base64'))}), c => c.charCodeAt(0)).buffer;
        // —— 批量归档中途切库：所有写入仍落原库；B 库同 ID 素材不被改动 ——
        const fX = await window.pigeon.folders.add('跨库归档夹');
        await reload();
        const s1 = await window.pigeon.import.buffer('跨库甲.png', 'image/png', buf, []);
        const s2 = await window.pigeon.import.buffer('跨库乙.png', 'image/png', buf, []);
        await reload(true);
        let hookCalls = 0;
        window.__test.itemOpHook = async () => { hookCalls++; if (hookCalls === 1) await openLibrary(${JSON.stringify(rootB)}); };
        await addItemsToFolder([s1.id, s2.id], fX.id);
        window.__test.itemOpHook = null;
        await openLibrary(${JSON.stringify(root)});
        const a1 = state.items.find(i => i.id === s1.id);
        const a2 = state.items.find(i => i.id === s2.id);
        t.batchAllInOrigLib = !!(a1 && a2) && (a1.folders || []).includes(fX.id) && (a2.folders || []).includes(fX.id);
        const bShared = await window.pigeon.items.readIn(${JSON.stringify(rootB)}, sharedId);
        t.batchNoWriteToSwitchedLib = !(bShared.folders || []).includes(fX.id);
        // —— 撤销中途切库：inverse 全部落原库；B 库同 ID 素材不被改动 ——
        undoStacks.get(state.root).undo.push({ root: state.root, label: '构造跨库撤销', ops: [
          { id: s1.id, patch: { star: true } },
          { id: s2.id, patch: { star: true } },
        ] });
        hookCalls = 0;
        window.__test.itemOpHook = async () => { hookCalls++; if (hookCalls === 1) await openLibrary(${JSON.stringify(rootB)}); };
        await undoOne();
        window.__test.itemOpHook = null;
        await openLibrary(${JSON.stringify(root)});
        t.undoAppliedInOrigLib = state.items.find(i => i.id === s1.id).star === true
          && state.items.find(i => i.id === s2.id).star === true;
        const bShared2 = await window.pigeon.items.readIn(${JSON.stringify(rootB)}, sharedId);
        t.undoNoWriteToSwitchedLib = bShared2.star !== true;
        // —— 五返补：手动打标（真实 IPC 入口 window.pigeon.ai.autoTag → ai:autoTagItem）——
        // 推理期间用户已改评分/注释/标签（主进程侧注入），打标结果须与用户修改共存
        const mt = await window.pigeon.import.buffer('手动打标交错.png', 'image/png', buf, []);
        await window.pigeon.items.update(mt.id, { rating: 0, annotation: '', tags: [] });
        await reload(true);
        const mtTags = await window.pigeon.ai.autoTag(mt.id);
        await reload(true);
        const mtr = state.items.find(i => i.id === mt.id);
        t.manualAiTagMerge = (mtTags || []).includes('手动AI')
          && !!mtr && mtr.rating === 5 && mtr.annotation === '用户注释'
          && (mtr.tags || []).includes('用户标签') && (mtr.tags || []).includes('手动AI');
        return t;
      })()
    `);
    } finally {
      aiRManual.autoTagItem = realAutoTagManual; // 异常也必须恢复真实打标，不留替身
    }
    results.p4UndoCrossLibSafe = xlib.batchAllInOrigLib === true && xlib.batchNoWriteToSwitchedLib === true
      && xlib.undoAppliedInOrigLib === true && xlib.undoNoWriteToSwitchedLib === true;
    results.p5ManualAiTagMerge = xlib.manualAiTagMerge === true;
  } catch (e) {
    results.p4Error = String(e.message).slice(0, 300);
  }

  try {
    const d = await win.webContents.executeJavaScript('({ dur: (window.__lastP1Diag && window.__lastP1Diag.dur) || "", old: (window.__lastP1Diag && window.__lastP1Diag.old) || "" })');
    results.p1DiagDur = d.dur; results.p1DiagOld = d.old;
  } catch (e) {}

  // 汇总：仅对确定性断言判定通过/失败（网络环境相关项只记录）
  try {
    results.shortcutContext = await win.webContents.executeJavaScript(`
      (async()=>{
        const before=await api.settings.get();
        try {
          settingsCache=await api.settings.set({shortcuts:{...before.shortcuts,search:'Ctrl+Shift+F'}});
          await renderSettings();
          $('#settings-panel').classList.remove('hidden');
          document.activeElement?.blur();
          const fire=()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'F',ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true}));
          fire(); const modalBlocked=document.activeElement!==$('#search');
          closeSettings(); hideMenu(); fire(); const remapped=document.activeElement===$('#search');
          const editor=document.createElement('textarea');document.body.appendChild(editor);editor.focus();fire();
          const editingKept=document.activeElement===editor;editor.remove();
          return modalBlocked && remapped && editingKept;
        } finally { settingsCache=await api.settings.set({shortcuts:before.shortcuts || {}});closeSettings(); }
      })()
    `);
  } catch(e) { results.shortcutError=String(e.message); }
  const ASSERT_KEYS = ['renameDiskSync', 'updateMeta', 'multiFolder', 'trash', 'restore', 'md5', 'bufferImport',
    'folderDeleteCascade', 'dragOutResolve', 'dragOutMissing', 'dragOutOverflow501', 'dragOutOverflowRefuse',
    'concurrentFields', 'renameRollback', 'atomicNoTmpLeft',
    'atomicReplaceFailKeepsOld', 'atomicConcurrentNoTorn', 'concurrentReadGateSensitive',
    'metaLockConcurrentFolders', 'writeItemConcurrentNoTorn',
    'aiMergeNoStaleOverwrite',
    'tagRename', 'tagMerge', 'tagDelete', 'tagRefsFull', 'folderDefaultTagsLib',
    'tagInterleaveRename', 'tagInterleaveMerge', 'tagInterleaveDelete', 'folderInterleaveRemove',
    'autoImport', 'autoImportSwitchLib', 'autoImportDeletedFolder', 'capture', 'pdfThumb', 'wallpaperOn', 'bridgeSettingsUi',
    'p1FolderDefaultTags', 'p1UndoTag', 'p1UndoArchive', 'p1UndoTrash', 'p1UndoBatchRename', 'p1UndoPartialFail', 'p1UndoIsolated',
    'p1SizeFilter', 'p1DimFilter', 'p1DurationFilter', 'p1FilterChips',
    'p1SmartFolderScope', 'p1SmartFolderOldCompat', 'p2Convert', 'p2ExportRename',
    'p4UndoCrossLibSafe', 'p5ManualAiTagMerge',
    'aiScopeFolder', 'aiScopeFilter', 'aiAllView', 'aiToggleKeeps', 'aiClearSearch',
    'aiOrderSuccess', 'aiOrderFailure', 'aiSwitchLibInflight', 'aiClearSearchInflight', 'aiExitAiInflight',
    'aiKeyboardClearInflight', 'aiBusyClearedOnInvalidate', 'aiBusyNotStolen', 'aiBusyOwnership',
    'shortcutContext', 'bridgeBrowserBytes', 'bridgeInvalidBytes',
    'bridgeNoToken', 'bridgeBadOrigin', 'bridgePing', 'bridgeFolders', 'bridgeSave', 'bridgeDupSkip', 'bridgeFailVisible',
    'bridgeFolderGuard', 'bridgeSwitchLib', 'bridgeBatchLimit', 'bridgeBatch60', 'bridgeThumbAfterImport',
    'bridgeTaskAcrossSwitch', 'bridgeTaskForgedId', 'bridgeTaskExpired'];
  const failed = ASSERT_KEYS.filter(k => results[k] !== true);
  console.log('[pigeon] FUNC_TEST ' + JSON.stringify(results));
  console.log('[pigeon] FUNC_TEST_SUMMARY ' + (failed.length ? 'FAIL ' + failed.join(',') : 'PASS'));
  exitCode = failed.length ? 3 : 0;
  } catch (e) {
    results.fatalError = String((e && e.message) || e).slice(0, 300);
    console.log('[pigeon] FUNC_TEST ' + JSON.stringify(results));
    console.log('[pigeon] FUNC_TEST_SUMMARY FAIL fatalError:' + results.fatalError);
    exitCode = 4;
  } finally {
    // 配置恢复与清理必须执行：提前异常也不能跳过
    await fs.remove(root).catch(() => {});
    await fs.remove(rootB).catch(() => {});
    const restore = { lastLibrary: prevLastLibrary, libraries: prevLibraries };
    if (prevSettings) restore.settings = prevSettings;
    await setConfig(restore).catch(() => {});
    app.exit(exitCode);
  }
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
  // ---- P2-04 视觉核查截图：关壁纸 / 小窗口 ----
  const setWallpaper = async (on) => {
    await win.webContents.executeJavaScript(`window.__test.setWallpaper && window.__test.setWallpaper(${on})`);
    await sleep(600);
  };
  await setWallpaper(false);
  await shot('12-wallpaper-off.png');
  await setWallpaper(true);
  // 小窗口（最小尺寸 960x600）
  const orig = win.getSize();
  win.setSize(960, 600);
  await sleep(1200);
  await shot('13-small-window.png');
  win.setSize(orig[0], orig[1]);
  await sleep(1200);
  // 对比度（数学计算，P2-04）：正文色 vs 底色；壁纸开启时按最不利混合（中灰壁纸 × 0.5 透明度）
  const contrast = await win.webContents.executeJavaScript(`(() => {
    const lum = (rgb) => { const c = rgb.map(v => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); }); return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]; };
    const ratio = (a, b) => { const s = [lum(a), lum(b)].sort((p, q) => q - p); return Math.round(((s[0] + .05) / (s[1] + .05)) * 100) / 100; };
    const parse = (s) => (String(s).match(/\\d+/g) || []).slice(0, 3).map(Number);
    const text = parse(getComputedStyle(document.body).color);
    const base = [31, 32, 35];
    const wpOn = document.body.classList.contains('wallpaper-on');
    const op = wpOn ? 0.5 : 0;
    const worst = base.map(v => Math.round(v * (1 - op) + 128 * op));
    return { textVsBase: ratio(text, base), textVsWallpaperWorst: ratio(text, worst), dimVsWallpaperWorst: ratio([154, 155, 160], worst), wallpaperOn: wpOn };
  })()`);
  console.log('[pigeon] CONTRAST ' + JSON.stringify(contrast));
  console.log('done');
  app.exit(0);
}

// ---------- 性能测量（P2-01）：加载/全量重渲染/多选/筛选/滚动重排，输出 JSON ----------
async function perfTest() {
  const root = process.env.PIGEON_PERF_LIB || path.join(app.getPath('temp'), 'pigeon-perf.pigeon');
  currentLibraryRoot = () => root;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  await sleep(2500); // 等首屏稳定
  const r = await win.webContents.executeJavaScript(`
    (async () => {
      await openLibrary(${JSON.stringify(root)});
      await new Promise(r2 => setTimeout(r2, 1200));
      const t = {};
      t.items = state.items.length;
      const s0 = performance.now(); await reload(true); t.reloadMs = Math.round((performance.now() - s0) * 10) / 10;
      // —— 渲染计量（区分口径）：首批可交互 / 全部卡片完成 / 长任务采样 ——
      // 口径说明：longtask 观察器只报告超过阈值（约 50ms）的条目，maxBlock=0 只能说明
      // 「采样窗口内未观察到超阈值长任务」，不等于最大主线程耗时；观察器不可用或自检
      // 失败时标记采样无效，不输出 0 值结论。
      let maxBlockAll = 0;
      let selfTestBlock = 0;
      let selfTestRunning = false;
      let po = null;
      let poSupported = false;
      try {
        po = new PerformanceObserver(list => {
          for (const e of list.getEntries()) {
            maxBlockAll = Math.max(maxBlockAll, e.duration);
            if (selfTestRunning) selfTestBlock = Math.max(selfTestBlock, e.duration);
          }
        });
        po.observe({ entryTypes: ['longtask'] });
        poSupported = true;
      } catch (e) { poSupported = false; }
      t.longtaskSupported = poSupported;
      if (poSupported) {
        // 自检：故意阻塞 ~120ms，观察器必须收到条目——证明后续「未观察到」是有效采样
        selfTestRunning = true;
        const spinStart = performance.now();
        while (performance.now() - spinStart < 120) { /* 故意阻塞 */ }
        await new Promise(r2 => setTimeout(r2, 80)); // 等回调派发
        selfTestRunning = false;
      }
      t.observerSelfTestMs = Math.round(selfTestBlock);
      t.observerValid = poSupported && selfTestBlock >= 100;
      maxBlockAll = 0;
      const s1 = performance.now();
      renderGrid();
      t.renderFirstMs = Math.round((performance.now() - s1) * 10) / 10;   // 首批（250 张）同步完成
      let waited = 0;
      while (document.querySelectorAll('#grid .item').length < visible.length && waited < 15000) {
        await new Promise(r2 => requestAnimationFrame(r2));
        waited++;
      }
      t.renderTotalMs = Math.round((performance.now() - s1) * 10) / 10;   // 全部卡片建立完成
      await new Promise(r2 => setTimeout(r2, 120)); // 等最后的观察器回调派发
      t.renderLongtaskMaxMs = t.observerValid ? Math.round(maxBlockAll) : null; // null = 采样无效
      if (po) po.disconnect();
      t.allCardsBuilt = document.querySelectorAll('#grid .item').length >= visible.length;
      // —— 以下操作全部在「全部卡片已建立」后测量，与基线同口径 ——
      const s2 = performance.now();
      document.activeElement && document.activeElement.blur();
      window.dispatchEvent(new KeyboardEvent('keydown', { ctrlKey: true, key: 'a', bubbles: true }));
      t.selectAllMs = Math.round((performance.now() - s2) * 10) / 10;
      const card0 = document.querySelector('#grid .item');
      if (card0) {
        const s2b = performance.now();
        card0.onclick({ ctrlKey: true }); // 真实 ctrl 点选处理器
        t.ctrlClickMs = Math.round((performance.now() - s2b) * 10) / 10;
      }
      const s3 = performance.now();
      state.selection.clear();
      $$('#grid .item').forEach(c => c.classList.remove('selected'));
      t.clearSelMs = Math.round((performance.now() - s3) * 10) / 10;
      const s4 = performance.now();
      for (let i = 0; i < 5; i++) layoutGrid();
      t.layoutX5Ms = Math.round((performance.now() - s4) * 10) / 10;
      const s5 = performance.now();
      state.filters.minW = 1000;
      renderGrid();
      t.filterFirstMs = Math.round((performance.now() - s5) * 10) / 10;
      let w2 = 0;
      while (document.querySelectorAll('#grid .item').length < visible.length && w2 < 15000) {
        await new Promise(r2 => requestAnimationFrame(r2));
        w2++;
      }
      t.filterTotalMs = Math.round((performance.now() - s5) * 10) / 10;
      t.filterVisible = visible.length;
      state.filters.minW = 0; renderGrid();
      await new Promise(r2 => setTimeout(r2, 2500));
      t.domNodes = document.querySelectorAll('#grid .item').length;
      return t;
    })()
  `).catch(e => ({ error: String(e.message).slice(0, 200) }));
  console.log('[pigeon] PERF ' + JSON.stringify(r));
  app.exit(0);
}

// Job wrappers also cover auto-import and clipboard capture.
importFromUrl = trackedJob(importFromUrl);
importItemFromBuffer = trackedJob(importItemFromBuffer);
aiTagNewItems = trackedJob(aiTagNewItems);
finishCapture = trackedJob(finishCapture);
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
    } else if (!process.env.PIGEON_PERF && !cfg.lastLibrary && (await fs.pathExists(defaultLibraryPath()))) {
      await setConfig({ lastLibrary: defaultLibraryPath() });
    }
  }
  updater = require('./lib/updater').createUpdater({ app, baseDir: isPortable ? portableRoot() : app.getPath('userData'),
    canInstall: () => { if(activeJobs || captureWin) return false; updateStopping=true; return true; } });
  await updater.restore();
  registerIpc();  createWindow();
  if (!isShot) win.webContents.once('did-finish-load', async () => {
    const cfg=await getConfig(); const options=mergeSettings(cfg.settings).updates;
    if(updater.snapshot().status==='ready') { win.webContents.send('pigeon:update',updater.snapshot()); return; }
    if(options.checkOnStart) {
      const st=await updater.check();
      if(st.status==='available') {
        win.webContents.send('pigeon:update',st);
        if(options.autoDownload) { const downloaded=await updater.download(); if(!win.isDestroyed()) win.webContents.send('pigeon:update',downloaded); }
      }
    }
  });
  attachItemProtocolHandler();
  startBridge().catch(e => console.warn('[pigeon] 扩展接收服务启动失败:', e.message));
  if (isShot) {
    setTimeout(() => {
      const run = process.env.PIGEON_FUNC_TEST ? funcTest()
        : process.env.PIGEON_FORMAT_TEST ? formatTestShot(formatTest)
        : process.env.PIGEON_PERF ? perfTest()
        : shotMode();
      run.catch(e => { console.error(e); app.exit(1); });
    }, 500);
  }
});
app.on('window-all-closed', () => app.quit());

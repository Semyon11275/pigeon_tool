// 扩展隔离测试：不依赖真实浏览器，用 mock 的 chrome / DOM 直接驱动
//   - background.js：右键菜单「点击事件」触发收藏（不是只测保存接口）
//   - content.js：懒加载收集、srcset 尺寸依据、去重、占位图
//   - common.js：分批边界（60/61/121）
// 用法：node scripts/test-extension.js   （失败 exit 1，输出 EXT_TEST_SUMMARY）
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const EXT = path.join(__dirname, '..', 'extension');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let passed = 0, failed = 0;
const failures = [];
function check(name, cond) {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; failures.push(name); console.log('  ✗', name); }
}

// ---------- 加载扩展脚本到独立全局环境 ----------
function loadScript(file, globals) {
  const sandbox = vm.createContext(globals);
  vm.runInContext(fs.readFileSync(path.join(EXT, file), 'utf8'), sandbox, { filename: file });
  return sandbox;
}

// =====================================================================
// 1) background.js —— 右键收藏必须由 contextMenus.onClicked 点击事件接通
// ======================================================================
async function testBackground() {
  console.log('[background] 右键收藏链路');
  const fetches = [];
  let notification = null;
  const listeners = { installed: [], message: [], ctxClick: [] };
  const menus = { created: [], removeAllCb: null };
  const g = {
    chrome: {
      runtime: {
        onInstalled: { addListener: (cb) => listeners.installed.push(cb) },
        onMessage: { addListener: (cb) => listeners.message.push(cb) },
      },
      contextMenus: {
        create: (opt) => menus.created.push(opt),
        removeAll: (cb) => { menus.removeAllCb = cb; },
        onClicked: { addListener: (cb) => listeners.ctxClick.push(cb) },
      },
      storage: { local: { get: async () => ({ token: 'T0'.repeat(24), port: 39770 }), set: async () => {} } },
      tabs: { query: async () => [], sendMessage: async () => {} },
      scripting: { executeScript: async () => {} },
      notifications: { create: (o) => { notification = o; } },
    },
    fetch: async (url, opts) => {
      fetches.push({ url, opts });
      return { ok: true, status: 200, json: async () => ({ ok: true, results: [{ srcUrl: 'saved', ok: true, item: { name: 'n' } }], summary: { saved: 1, skipped: 0, failed: 0 } }) };
    },
    console,
  };
  loadScript('background.js', g);

  // 安装事件 → 创建菜单
  listeners.installed.forEach(cb => cb());
  menus.removeAllCb && menus.removeAllCb();
  check('onInstalled 后创建了 image 右键菜单', menus.created.length === 1 && menus.created[0].contexts.includes('image'));

  // 【缺陷用例】点击监听器必须注册（旧代码为 0）
  check('contextMenus.onClicked 已注册（点击监听器数量=1）', listeners.ctxClick.length === 1);

  // 【缺陷用例】从「点击事件」触发完整收藏链路
  const click = { menuItemId: 'pigeon-save-image', srcUrl: 'https://img.example/pic.png', pageUrl: 'https://page.example/article' };
  listeners.ctxClick.forEach(cb => cb(click, { url: click.pageUrl, id: 1 }));
  await sleep(80);
  const saveCall = fetches.find(f => f.url.includes('/save'));
  check('点击后发出 /save 请求', !!saveCall);
  if (saveCall) {
    const body = JSON.parse(saveCall.opts.body);
    const headers = saveCall.opts.headers || {};
    check('请求携带配对令牌', headers['X-Pigeon-Token'] === 'T0'.repeat(24));
    check('请求体含图片地址与来源页', body.items[0].srcUrl === click.srcUrl && body.items[0].pageUrl === click.pageUrl);
    await sleep(50);
    check('成功后弹系统通知（不静默）', !!notification && /Pigeon/.test(notification.title));
  }

  // 菜单 ID 校验：别的菜单项点击不得触发收藏
  fetches.length = 0;
  notification = null;
  listeners.ctxClick.forEach(cb => cb({ menuItemId: 'other-menu', srcUrl: 'https://x/1.png' }, { url: 'https://p' }));
  await sleep(50);
  check('其它菜单 ID 点击不触发收藏', fetches.length === 0);
}

// =====================================================================
// 2) content.js —— 懒加载 / srcset 尺寸依据 / 去重
// ======================================================================
function runCollect(imgs, extras = {}) {
  let respond = null;
  const bySel = {
    'img': imgs,
    'picture source[srcset]': extras.pictureSources || [],
    'meta[property="og:image"], meta[name="twitter:image"], link[rel="image_src"]': extras.metas || [],
    'a[href]': extras.links || [],
    'video[poster]': extras.videos || [],
  };
  const g = {
    chrome: { runtime: { onMessage: { addListener: (cb) => { respond = cb; } } } },
    window: {},
    location: { href: 'https://page.example/post' },
    document: { title: '示例页面', querySelectorAll: (sel) => bySel[sel] || [] },
    URL,
  };
  g.window = g;
  loadScript('content.js', g);
  let sent = null;
  respond({ type: 'PIGEON_COLLECT' }, null, (v) => { sent = v; });
  return sent;
}
const mkImg = (o) => ({
  src: o.src || '', currentSrc: o.currentSrc || o.src || '',
  naturalWidth: o.w || 0, naturalHeight: o.h || 0, alt: o.alt || '',
  getAttribute: (n) => (o.attrs || {})[n] ?? null,
});

async function testContent() {
  console.log('[content] 扫图收集');
  const find = (res, u) => (res ? res.items.find(i => i.srcUrl === u) : null);

  // 【缺陷用例】懒加载：src 是占位图时，data-src 的真实地址必须独立进入候选
  const t1 = runCollect([
    mkImg({ src: 'https://cdn.example/placeholder.gif', w: 1, h: 1, attrs: { 'data-src': 'https://cdn.example/real.jpg' } }),
  ]);
  check('懒加载：真实地址 data-src 进入候选', !!find(t1, 'https://cdn.example/real.jpg'));
  check('懒加载：占位图地址也在候选（可见即可选）', !!find(t1, 'https://cdn.example/placeholder.gif'));
  check('懒加载：真实地址不冒用占位图尺寸（尺寸未知=0）', find(t1, 'https://cdn.example/real.jpg') && find(t1, 'https://cdn.example/real.jpg').w === 0);

  // 【缺陷用例】srcset 高清候选不得使用当前小图的尺寸
  const t2 = runCollect([
    mkImg({
      src: 'https://cdn.example/small.jpg', currentSrc: 'https://cdn.example/small.jpg', w: 200, h: 150,
      attrs: { srcset: 'https://cdn.example/small.jpg 200w, https://cdn.example/big.jpg 1600w' },
    }),
  ]);
  const big = find(t2, 'https://cdn.example/big.jpg');
  check('srcset：高清候选进入列表', !!big);
  check('srcset：高清候选不得冒用 200px 小图尺寸', big && big.w === 0);
  check('srcset：当前渲染图保留自己的真实尺寸', find(t2, 'https://cdn.example/small.jpg') && find(t2, 'https://cdn.example/small.jpg').w === 200);

  // 浏览器已选中大图时：大图候选保留真实尺寸
  const t3 = runCollect([
    mkImg({
      currentSrc: 'https://cdn.example/big.jpg', w: 1600, h: 1200,
      attrs: { srcset: 'https://cdn.example/small.jpg 200w, https://cdn.example/big.jpg 1600w' },
    }),
  ]);
  check('srcset：currentSrc 即高清图时保留 1600 尺寸', find(t3, 'https://cdn.example/big.jpg') && find(t3, 'https://cdn.example/big.jpg').w === 1600);

  // data: 占位图：跳过计数，真实地址照常收集
  const t4 = runCollect([
    mkImg({ src: 'data:image/gif;base64,R0lGOD', w: 1, h: 1, attrs: { 'data-src': 'https://cdn.example/lazy2.png' } }),
  ]);
  check('data: 占位图被跳过并计数', t4 && t4.skippedInline >= 1);
  check('data: 占位图不影响真实地址收集', !!find(t4, 'https://cdn.example/lazy2.png'));

  // 未加载图片（naturalWidth=0）：仍进入候选、尺寸未知
  const t5 = runCollect([mkImg({ src: 'https://cdn.example/unloaded.webp' })]);
  check('未加载图片进入候选（尺寸未知）', !!find(t5, 'https://cdn.example/unloaded.webp') && find(t5, 'https://cdn.example/unloaded.webp').w === 0);

  // 去重合并：两个入口指向同一真实地址 → 单条候选
  const t6 = runCollect([
    mkImg({ src: 'https://cdn.example/dup.gif', attrs: { 'data-src': 'https://cdn.example/same.jpg' } }),
    mkImg({ src: 'https://cdn.example/same.jpg', w: 800, h: 600 }),
  ]);
  const dup = t6 ? t6.items.filter(i => i.srcUrl === 'https://cdn.example/same.jpg') : [];
  check('重复候选合并为一条', dup.length === 1);
  check('合并后尺寸取已知一侧（800）', dup[0] && dup[0].w === 800);

  // og:image / 图片直链 / 视频封面
  const t7 = runCollect(
    [mkImg({ src: 'https://cdn.example/a.png', w: 100, h: 100 })],
    {
      metas: [{ content: 'https://cdn.example/og.jpg' }],
      links: [{ href: 'https://cdn.example/linked.jpg', textContent: '查看大图' }],
      videos: [{ poster: 'https://cdn.example/poster.jpg', videoWidth: 1920, videoHeight: 1080 }],
    });
  check('og:image 进入候选', !!find(t7, 'https://cdn.example/og.jpg'));
  check('图片直链 <a> 进入候选', !!find(t7, 'https://cdn.example/linked.jpg'));
  check('视频封面进入候选', !!find(t7, 'https://cdn.example/poster.jpg'));
}

// =====================================================================
// 4) popup × background：收藏任务后台执行（真实 doSave → 真实 SW 任务循环）
// ======================================================================
async function testPopup() {
  console.log('[popup×background] 收藏任务后台执行（61 张，弹窗可关闭）');
  // —— 最小 DOM stub：className 与 classList 同步 ——
  function mkClassList(owner) {
    const list = () => owner.className.split(/\s+/).filter(Boolean);
    return {
      add: (...a) => { const s = new Set(list()); a.forEach(x => s.add(x)); owner.className = [...s].join(' '); },
      remove: (...a) => { const s = new Set(list()); a.forEach(x => s.delete(x)); owner.className = [...s].join(' '); },
      toggle: (c) => { const s = new Set(list()); s.has(c) ? s.delete(c) : s.add(c); owner.className = [...s].join(' '); },
      contains: (c) => list().includes(c),
    };
  }
  function mkEl(id) {
    const e = {
      id, value: '', textContent: '', innerHTML: '', className: '', disabled: false, checked: true,
      title: '', src: '', loading: '', onclick: null, onchange: null, children: [], options: [],
      appendChild(c) { this.children.push(c); return c; },
    };
    e.classList = mkClassList(e);
    return e;
  }
  const els = {};
  for (const id of ['conn', 'btn-gear', 'view-settings', 'view-main', 'inp-token', 'inp-port', 'btn-save-cfg',
    'cfg-msg', 'page-info', 'size-filter', 'sel-all', 'pick-count', 'grid', 'no-img', 'folder', 'tags', 'btn-save', 'result']) {
    els[id] = mkEl(id);
  }
  els['size-filter'].value = '0'; // 全部尺寸
  let domReady = null;
  const documentStub = {
    title: '测试页',
    addEventListener: (_ev, cb) => { domReady = cb; },
    querySelector: (s) => els[s.replace('#', '')] || null,
    getElementById: (id) => els[id] || null,
    querySelectorAll: (sel) => {
      if (sel === '#grid .cell.sel') return els.grid.children.filter(c => c.classList.contains('sel'));
      if (sel === '#grid .cell') return els.grid.children.slice();
      return [];
    },
    createElement: () => mkEl(''),
  };
  // —— background 上下文：真实 background.js；fetch = 服务端任务契约 mock ——
  let currentLib = 'A';
  const saves = [];   // 每次 /save 的 {taskId, n, rootUsed}
  const bgStorage = new Map();
  let bgRouter = null;
  let lastNotify = null;
  const mode = { fail: false }; // 业务失败模式：/save 返回 200 + ok:false + 逐项错误
  const SERVER = { TOKEN: 'e'.repeat(48), TASK_ID: 'AB12CD34EF56AB12' };
  const bgFetch = async (url, opts) => {
    if (url.includes('/ping')) return { ok: true, status: 200, json: async () => ({ ok: true, app: 'Pigeon', library: currentLib }) };
    if (url.includes('/folders')) return { ok: true, status: 200, json: async () => ({ ok: true, folders: [] }) };
    if (url.includes('/save')) {
      const body = JSON.parse(opts.body);
      if (mode.fail) {
        return { ok: true, status: 200, json: async () => ({
          ok: false,
          results: body.items.map(it => ({ srcUrl: it.srcUrl, ok: false, error: '404 Not Found' })),
          summary: { saved: 0, skipped: 0, failed: body.items.length },
          taskId: SERVER.TASK_ID, library: 'A库',
        }) };
      }
      const rootUsed = body.taskId ? 'A' : currentLib; // 服务端契约：taskId → 任务绑定的库
      saves.push({ taskId: body.taskId || null, n: body.items.length, rootUsed });
      if (saves.length === 1) currentLib = 'B'; // 第一批完成后用户切库（复现现场）
      return { ok: true, status: 200, json: async () => ({
        ok: true,
        results: body.items.map(it => ({ srcUrl: it.srcUrl, ok: true, item: { name: 'n' } })),
        summary: { saved: body.items.length, skipped: 0, failed: 0 },
        taskId: SERVER.TASK_ID, library: 'A库',
      }) };
    }
    return { ok: false, status: 404, json: async () => ({ ok: false, error: 'not found' }) };
  };
  const bgChrome = {
    runtime: {
      onInstalled: { addListener() {} },
      onMessage: { addListener: (cb) => { bgRouter = cb; } },
    },
    contextMenus: { create() {}, removeAll(cb) { cb && cb(); }, onClicked: { addListener() {} } },
    storage: { local: {
      get: async (keys) => {
        const out = {};
        for (const k of Array.isArray(keys) ? keys : [keys]) {
          if (k === 'taskState') out.taskState = bgStorage.get('taskState');
          else if (k === 'token') out.token = SERVER.TOKEN;
          else if (k === 'port') out.port = 39770;
        }
        return out;
      },
      set: async (o) => { for (const [k, v] of Object.entries(o)) bgStorage.set(k, v); },
    } },
    tabs: { query: async () => [] },
    scripting: { executeScript: async () => {} },
    notifications: { create: (o) => { lastNotify = o; } },
  };
  loadScript('background.js', { chrome: bgChrome, fetch: bgFetch, console });
  if (!bgRouter) { check('background 消息路由已注册', false); return; }
  check('background 消息路由已注册', true);
  // —— popup 上下文：真实 popup.js + common.js；sendMessage 桥接到 background 路由 ——
  const sendMessage = (msg, cb) => { bgRouter(msg, {}, cb); };
  const ctx = vm.createContext({
    chrome: { runtime: { sendMessage }, storage: { local: { get: async () => ({}), set: async () => {} } } },
    document: documentStub, console, setTimeout,
  });
  vm.runInContext(fs.readFileSync(path.join(EXT, 'common.js'), 'utf8'), ctx, { filename: 'common.js' });
  vm.runInContext(
    fs.readFileSync(path.join(EXT, 'popup', 'popup.js'), 'utf8') + '\n;globalThis.__popup = { doSave };',
    ctx, { filename: 'popup.js' });
  // DOMContentLoaded：绑定事件并扫描当前页（COLLECT 由 background 经 tabs 桥接返回 61 张）
  bgChrome.tabs.query = async () => [{ id: 1, url: 'https://page.example/p' }];
  bgChrome.tabs.sendMessage = async () => ({ pageUrl: 'https://page.example/p', title: '示例', skippedInline: 0, items: Array.from({ length: 61 }, (_, i) => ({ srcUrl: `https://cdn.example/${i}.png`, w: 800, h: 600 })) });
  await domReady();
  check('扫描到 61 张候选并全选', els.grid.children.length === 61 && els['btn-save'].textContent.includes('61'));
  // —— 发起收藏后「关闭弹窗」：不持有 popup 的任何引用/回调，任务在 background 继续 ——
  const done = ctx.__popup.doSave(); // 不 await：模拟用户立刻关闭弹窗
  let st = null;
  for (let i = 0; i < 40 && (!st || st.status === 'running'); i++) {
    await sleep(120);
    st = bgStorage.get('taskState') || null;
  }
  check('弹窗关闭后任务在后台完成（status=done）', !!st && st.status === 'done');
  check('61 张自动分为 60+1 两批', saves.length === 2 && saves[0].n === 60 && saves[1].n === 1);
  check('第二批携带第一批返回的任务身份 taskId', saves[1] && saves[1].taskId === SERVER.TASK_ID);
  check('两批写入同一个目标库（批间切库不换库）', saves.length === 2 && saves.every(s => s.rootUsed === 'A'));
  check('后台任务汇总成功 61（saved=61）', !!st && st.saved === 61 && st.failed === 0);
  check('完成通知已弹出（含写入库名）', !!lastNotify && /收藏完成/.test(lastNotify.title) && /A库/.test(lastNotify.message));
  await done; // popup 轮询也拿到终态
  check('弹窗汇总显示成功 61', els.result.textContent.includes('成功 61'));
  // 重开弹窗：TASK_STATUS 能看到刚结束的任务摘要
  const reopen = await new Promise((res2) => sendMessage({ type: 'TASK_STATUS' }, res2));
  check('重开弹窗可查看任务结果（TASK_STATUS）', !!(reopen && reopen.ok && reopen.data && reopen.data.saved === 61));
  // —— 【四返 P2】合法业务失败（HTTP 200 + ok:false + 逐项错误）：不得记成通信失败丢结果 ——
  bgStorage.delete('taskState');
  saves.length = 0;
  currentLib = 'A';
  mode.fail = true;
  sendMessage({ type: 'SAVE_TASK', items: [{ srcUrl: 'https://x/fail1.png' }], folderId: '', tags: [] }, () => {});
  let fst = null;
  for (let i = 0; i < 30 && (!fst || fst.status === 'running'); i++) {
    await sleep(120);
    fst = bgStorage.get('taskState') || null;
  }
  mode.fail = false;
  check('业务失败：任务正常结束（status=done，非中断）', !!fst && fst.status === 'done');
  check('业务失败：保留逐项结果（results 非空、failed=1）', !!fst && Array.isArray(fst.results) && fst.results.length === 1 && fst.failed === 1 && fst.saved === 0);
  check('业务失败：完成摘要含「失败 1」且不显示「通信失败」', !!lastNotify && /失败 1/.test(lastNotify.message) && !/通信失败/.test(lastNotify.message));
}

// =====================================================================
// 5) 协议贯穿：真实 background 序列化 → 真实 bridge-server 校验（HTTP 直连）
//    两端不再各自模拟成功响应；首次收藏（无任务 ID）必须被真实服务端接受
// ======================================================================
async function testProtocol() {
  console.log('[protocol] 后台序列化 × 服务端校验');
  const { createBridgeServer } = require('../lib/bridge-server');
  const http = require('http');
  const TOKEN = 'e'.repeat(48);
  const server = createBridgeServer({
    token: TOKEN,
    getInfo: () => ({ version: 'test', library: '测试库' }),
    listFolders: async () => [],
    saveItems: async ({ items }) => {
      const results = items.map(e => ({ srcUrl: e.srcUrl, ok: true, item: { id: 'i1', name: 'n' } }));
      return { results, taskId: 'FF00AA11BB22CC33', library: '测试库' };
    },
  });
  const listening = await server.start();
  if (!listening) { check('本地接收服务可启动', false); return; }
  try {
    // —— 真实 background.js：右键点击产生真实序列化请求（fetch 捕获） ——
    const fetches = [];
    const listeners = { installed: [], ctxClick: [] };
    const menus = { created: [], removeAllCb: null };
    const bg = {
      chrome: {
        runtime: { onInstalled: { addListener: cb => listeners.installed.push(cb) }, onMessage: { addListener() {} } },
        contextMenus: { create: o => menus.created.push(o), removeAll: cb => { menus.removeAllCb = cb; }, onClicked: { addListener: cb => listeners.ctxClick.push(cb) } },
        storage: { local: { get: async () => ({ token: TOKEN, port: listening.port }), set: async () => {} } },
        tabs: { query: async () => [] }, scripting: { executeScript: async () => {} },
        notifications: { create() {} },
      },
      fetch: async (url, opts) => {
        fetches.push({ url, opts });
        return { ok: true, status: 200, json: async () => ({ ok: true, results: [{ ok: true }], summary: { saved: 1, skipped: 0, failed: 0 } }) };
      },
      console,
    };
    loadScript('background.js', bg);
    listeners.installed.forEach(cb => cb());
    if (menus.removeAllCb) menus.removeAllCb();
    listeners.ctxClick.forEach(cb => cb(
      { menuItemId: 'pigeon-save-image', srcUrl: 'http://127.0.0.1/x/first.png', pageUrl: 'http://p.example/' },
      { url: 'http://p.example/', id: 1 }));
    await sleep(80);
    const req = fetches.find(f => f.url.includes('/save'));
    check('首次收藏（右键）已发出 /save 请求', !!req);
    if (!req) return;
    const bodyObj = JSON.parse(req.opts.body);
    // 【缺陷用例 P1·三次返工】第一批必须省略 taskId 字段（旧代码发 taskId:"" 被服务端判不合法）
    check('首次收藏请求省略 taskId 字段（协议：第一批不带）', !('taskId' in bodyObj) || bodyObj.taskId === undefined);
    // —— 把真实序列化出的请求原样投递给真实服务端（含真实鉴权头与扩展来源） ——
    const post = (body) => new Promise((resolve, reject) => {
      const u = new URL(req.url);
      const r = http.request({
        host: '127.0.0.1', port: u.port, path: u.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Pigeon-Token': req.opts.headers['X-Pigeon-Token'], Origin: 'chrome-extension://abc' },
      }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
      r.on('error', reject);
      r.write(body);
      r.end();
    });
    const real = await post(req.opts.body);
    const realJ = JSON.parse(real.body);
    check('真实后台请求被真实服务端接受（200 并签发 taskId）',
      real.status === 200 && /^[A-F0-9]{16}$/.test(realJ.taskId || ''));
    // 服务端容错：空字符串 taskId 视同未提供（不拒绝旧客户端）
    const tolerant = await post(JSON.stringify({ items: [{ srcUrl: 'http://127.0.0.1/x/tolerant.png' }], taskId: '' }));
    check('服务端把空字符串 taskId 视同未提供（容错）', tolerant.status === 200);
  } finally {
    server.stop();
  }
}

// =====================================================================
// 6) common.js —— 分批边界（>60 张不能整批失败）
// ======================================================================
function testCommon() {
  console.log('[common] 自动分批');
  let mod = null;
  try {
    vm.runInThisContext(fs.readFileSync(path.join(EXT, 'common.js'), 'utf8'));
    mod = globalThis.PigeonExt || null;
  } catch (e) { mod = null; }
  check('common.js 提供分批函数', !!mod && typeof mod.chunkItems === 'function');
  if (mod) {
    const mk = (n) => Array.from({ length: n }, (_, i) => ({ srcUrl: 'https://x/' + i }));
    const c60 = mod.chunkItems(mk(60));
    check('60 张 → 1 批', c60.length === 1 && c60[0].length === 60);
    const c61 = mod.chunkItems(mk(61));
    check('61 张 → 2 批（60+1）', c61.length === 2 && c61[0].length === 60 && c61[1].length === 1);
    const c125 = mod.chunkItems(mk(125));
    check('125 张 → 3 批（60+60+5）', c125.length === 3 && c125[2].length === 5);
    const flat = c125.flat();
    check('分批不丢不重', flat.length === 125 && new Set(flat.map(i => i.srcUrl)).size === 125);
    check('空选择 → 0 批', mod.chunkItems([]).length === 0);
  }
}

(async () => {
  await testBackground();
  testContent();
  await testPopup();
  await testProtocol();
  testCommon();
  console.log('[pigeon] EXT_TEST_SUMMARY ' + (failed ? `FAIL ${failed}（${failures.join('、')}）` : `PASS ${passed}`));
  process.exit(failed ? 1 : 0);
})();

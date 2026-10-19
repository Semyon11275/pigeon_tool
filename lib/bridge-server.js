// Pigeon — 浏览器扩展本机通信服务
// 只监听 127.0.0.1；所有写操作必须携带配对令牌；来源仅限浏览器扩展（chrome-/edge-/moz-extension）。
// 服务本身不直接写资料库，保存动作通过回调交由主进程复用既有入库逻辑。
'use strict';
const http = require('http');

const PORT_CANDIDATES = [39770, 39771, 39772, 39773, 39774];
const MAX_BODY_BYTES = 18 * 1024 * 1024;   // 请求体上限 1MB
const MAX_ITEMS = 60;                  // 单批最多收藏数
const MAX_URL_LEN = 2048;
const EXT_ORIGIN_RE = /^(chrome|edge|moz)-extension:\/\//i;

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length) {
    // 长度不同也要做一次等长比较，避免按长度提前泄密
    const n = Math.max(ba.length, bb.length);
    const ca = Buffer.alloc(n), cb = Buffer.alloc(n);
    ba.copy(ca); bb.copy(cb);
    require('crypto').timingSafeEqual(ca, cb);
    return false;
  }
  return require('crypto').timingSafeEqual(ba, bb);
}

function isAllowedOrigin(origin) {
  if (!origin) return true;           // 非浏览器环境（curl、本机脚本）
  return EXT_ORIGIN_RE.test(origin);
}

function sendJson(res, status, obj, origin) {
  const body = JSON.stringify(obj);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  };
  if (origin && EXT_ORIGIN_RE.test(origin)) headers['Access-Control-Allow-Origin'] = origin;
  res.writeHead(status, headers);
  res.end(body);
}

// 校验 /save 请求体，返回 { error } 或规范化后的 { items, folderId, tags }
function normalizeSavePayload(body, allowEmpty = false) {
  if (!body || typeof body !== 'object') return { error: '请求体必须是 JSON 对象' };
  const rawItems = body.items;
  if (!Array.isArray(rawItems) || (!rawItems.length && !allowEmpty)) return { error: 'items 不能为空' };
  if (rawItems.length > MAX_ITEMS) return { error: `单批最多 ${MAX_ITEMS} 张图片` };
  const items = [];
  for (const it of rawItems) {
    if (!it || typeof it !== 'object') return { error: 'items 内必须是对象' };
    const srcUrl = typeof it.srcUrl === 'string' ? it.srcUrl.trim() : '';
    if (!/^https?:\/\//i.test(srcUrl)) return { error: `不支持的地址（仅 http/https）：${String(srcUrl).slice(0, 80)}` };
    if (srcUrl.length > MAX_URL_LEN) return { error: '图片地址过长' };
    const pageUrl = typeof it.pageUrl === 'string' && /^https?:\/\//i.test(it.pageUrl) && it.pageUrl.length <= MAX_URL_LEN ? it.pageUrl : '';
    const name = typeof it.name === 'string' ? it.name.slice(0, 120) : '';
    const item={ srcUrl, pageUrl, name };
    if (it.data != null) {
      if (rawItems.length !== 1 || typeof it.data !== 'string' || it.data.length > 16*1024*1024 || (it.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(it.data)) || !it.data.length) return { error: '图片字节不合法或超过 12MB' };
      if (!/^image\/(png|jpeg|gif|webp|avif|bmp|svg\+xml)$/.test(it.mime || '')) return { error: '不支持的图片类型' };
      item.data=it.data; item.mime=it.mime;
    }
    items.push(item);
  }
  let folderId = '';
  if (body.folderId != null) {
    if (typeof body.folderId !== 'string' || body.folderId.length > 64) return { error: 'folderId 不合法' };
    folderId = body.folderId.trim();
  }
  // 任务身份：16 位十六进制，由服务端签发；客户端不能借它传任意路径。
  // 空字符串视同未提供（兼容省略字段或旧客户端发空串的首批请求）。
  let taskId = '';
  if (body.taskId != null && body.taskId !== '') {
    if (typeof body.taskId !== 'string' || !/^[A-Fa-f0-9]{16}$/.test(body.taskId)) return { error: 'taskId 不合法' };
    taskId = body.taskId;
  }
  let tags = [];
  if (body.tags != null) {
    if (!Array.isArray(body.tags)) return { error: 'tags 必须是数组' };
    if (body.tags.length > 10) return { error: '最多 10 个标签' };
    tags = body.tags.map(t => String(t).trim().slice(0, 40)).filter(Boolean);
  }
  return { items, folderId, tags, taskId };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// handlers: { token, getInfo, listFolders, saveItems }
//   getInfo() -> { version, library } | { version, library: null }
//   listFolders() -> [{ id, name, path }]
//   saveItems({ items, folderId, tags }) -> [{ srcUrl, ok, skipped?, reason?, error?, item? }]
function createBridgeServer(handlers) {
  let server = null;
  let port = null;

  async function dispatch(req, res) {
    const origin = req.headers.origin || '';
    const u = new URL(req.url, 'http://127.0.0.1');

    // 预检：仅对扩展来源放行
    if (req.method === 'OPTIONS') {
      if (!isAllowedOrigin(origin)) { res.writeHead(403); res.end(); return; }
      res.writeHead(204, {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Pigeon-Token',
        'Access-Control-Max-Age': '86400',
      });
      res.end();
      return;
    }

    // 鉴权：扩展写/读接口都要求令牌（ping 也校验，避免无令牌探测）
    const token = req.headers['x-pigeon-token'] || '';
    if (!token || !timingSafeEqualStr(token, handlers.token)) {
      sendJson(res, 401, { ok: false, error: '配对令牌缺失或不正确' }, origin);
      return;
    }
    if (!isAllowedOrigin(origin)) {
      sendJson(res, 403, { ok: false, error: '来源不被允许' }, origin);
      return;
    }

    if (req.method === 'GET' && u.pathname === '/ping') {
      const info = handlers.getInfo();
      sendJson(res, 200, { ok: true, app: 'Pigeon', version: info.version, library: info.library }, origin);
      return;
    }
    if (req.method === 'GET' && u.pathname === '/folders') {
      const folders = await handlers.listFolders();
      sendJson(res, 200, { ok: true, folders }, origin);
      return;
    }
    if (req.method === 'POST' && ['/save','/tasks'].includes(u.pathname)) {
      const raw = await readBody(req, MAX_BODY_BYTES);
      let body;
      try { body = JSON.parse(raw.toString('utf8')); }
      catch (e) { sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' }, origin); return; }
      const norm = normalizeSavePayload(u.pathname === '/tasks' ? {...body, items:[]} : body, u.pathname === '/tasks');
      if (norm.error) { sendJson(res, 400, { ok: false, error: norm.error }, origin); return; }
      const r = await handlers.saveItems(norm);
      // 整批拒绝（未开库 / 任务过期 / 目标文件夹不属于任务库等）：400 + 明确原因，不做部分成功
      if (r && r.batchError) {
        sendJson(res, 400, { ok: false, error: r.batchError }, origin);
        return;
      }
      if(u.pathname === '/tasks') { sendJson(res,200,{ok:true,taskId:r.taskId,library:r.library},origin); return; }
      const results = r.results;
      const summary = {
        saved: results.filter(x => x.ok && !x.skipped).length,
        skipped: results.filter(x => x.ok && x.skipped).length,
        failed: results.filter(x => !x.ok).length,
      };
      // taskId/library：任务身份与实际写入的库名，供客户端后续子批次沿用与展示
      sendJson(res, 200, { ok: summary.failed < results.length, results, summary, taskId: r.taskId, library: r.library }, origin);
      return;
    }
    sendJson(res, 404, { ok: false, error: '未知接口' }, origin);
  }

  return {
    async start() {
      for (const p of PORT_CANDIDATES) {
        const srv = http.createServer((req, res) => {
          dispatch(req, res).catch((e) => {
            try { sendJson(res, 500, { ok: false, error: String((e && e.message) || e) }); } catch (e2) {}
          });
        });
        const ok = await new Promise((resolve) => {
          srv.once('error', () => resolve(false));
          srv.listen(p, '127.0.0.1', () => resolve(true));
        });
        if (ok) { server = srv; port = p; return { port: p }; }
      }
      return null;
    },
    stop() {
      if (server) { try { server.close(); } catch (e) {} server = null; port = null; }
    },
    get port() { return port; },
  };
}

module.exports = { createBridgeServer };

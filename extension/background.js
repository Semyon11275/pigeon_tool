// Pigeon 浏览器扩展 — MV3 Service Worker
// 职责：右键菜单收藏单图；代理与桌面端接收服务的 HTTP 通信（统一在此携带配对令牌）；桌面通知结果。
// 只提交图片 URL，不读取、不上传浏览器的 Cookie / 令牌等任何敏感信息。
'use strict';

const DEFAULT_PORT = 39770;

async function getCfg() {
  const { token, port } = await chrome.storage.local.get(['token', 'port']);
  return { token: token || '', port: port || DEFAULT_PORT };
}

async function pigeonFetch(path, opts = {}) {
  const { token, port } = await getCfg();
  if (!token) {
    throw Object.assign(new Error('未配置配对码：点击右上角 ⚙，粘贴 Pigeon 设置里的配对码'), { noToken: true });
  }
  let resp;
  try {
    resp = await fetch(`http://127.0.0.1:${port}` + path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', 'X-Pigeon-Token': token, ...(opts.headers || {}) },
    });
  } catch (e) {
    // fetch 网络层失败 = 桌面端未启动 / 端口不通
    throw Object.assign(new Error('无法连接 Pigeon 桌面端（127.0.0.1:' + port + '）'), { offline: true });
  }
  if (resp.status === 401) {
    throw Object.assign(new Error('配对码不正确：请到 Pigeon 设置里复制最新配对码'), { badToken: true });
  }
  if (!resp.ok) {
    let msg = 'HTTP ' + resp.status;
    try { const j = await resp.json(); if (j && j.error) msg = j.error; } catch (e) {}
    throw new Error(msg);
  }
  return resp.json();
}

function saveItems(items, { folderId, tags, taskId } = {}) {
  // 协议约定：第一批（无任务 ID）必须省略 taskId 字段，由服务端签发；
  // 服务端会把空字符串视同未提供，但新请求不应携带该字段
  const body = { items, folderId: folderId || '', tags: tags || [] };
  if (taskId) body.taskId = taskId;
  return pigeonFetch('/save', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function notify(title, message) {
  try {
    chrome.notifications.create({
      type: 'basic', iconUrl: 'icons/icon128.png', title, message,
    });
  } catch (e) { /* 通知失败不影响收藏结果 */ }
}

// ---- 右键收藏 ----
async function saveFromContext(info, tab) {
  const { folderId = '', tags = [] } = await chrome.storage.local.get(['folderId', 'tags']);
  try {
    const r = await saveItems(
      [{ srcUrl: info.srcUrl, pageUrl: info.pageUrl || (tab && tab.url) || '' }],
      { folderId, tags });
    const res = r.results && r.results[0];
    if (res && res.ok && !res.skipped) notify('已收藏到 Pigeon', (res.item && res.item.name) || info.srcUrl.slice(0, 70));
    else if (res && res.skipped) notify('Pigeon：图片已存在', '资料库中已有该图片，未重复导入');
    else notify('收藏失败', (res && res.error) || '未知原因');
  } catch (e) {
    if (e.offline) notify('无法连接 Pigeon', '请先启动 Pigeon 桌面端（未启动时不会显示收藏成功）');
    else notify('收藏失败', e.message);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'pigeon-save-image', title: '收藏此图片到 Pigeon', contexts: ['image'] });
  });
});

// 右键菜单点击 → 收藏。只响应本扩展创建的菜单项，避免影响其他扩展的同页菜单
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'pigeon-save-image') return;
  saveFromContext(info, tab);
});

// ---- 收藏任务后台执行（P0 集成验收项）：批量循环在 Service Worker 里跑 ----
// 弹窗只负责发起与查看进度；任务状态写入 chrome.storage，弹窗关闭不中断，
// 重新打开弹出窗可继续查看进度与结果。
let taskRunning = false;
function chunkList(arr, size) { const out = []; for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size)); return out; }
async function runSaveTask({ items, folderId, tags, browserDownload, tabId }) {
  if (taskRunning) return { ok: false, error: '已有收藏任务在进行中，请稍候在弹出窗查看进度' };
  if (!Array.isArray(items) || !items.length || items.length > 2000) return {ok:false,error:'请选择 1–2000 张图片'};
  items = items.map(it=>({...it})); tags=[...(tags || [])];
  taskRunning = true;
  const st = {
    status: 'running', done: 0, total: items.length,
    saved: 0, skipped: 0, failed: 0, results: [],
    taskId: null, library: '', aborted: null, at: Date.now(),
  };
  const persist = () => chrome.storage.local.set({ taskState: st });
  try {
    await persist();
    if(browserDownload) {
      const reservation=await pigeonFetch('/tasks',{method:'POST',body:JSON.stringify({folderId:folderId || '',tags:tags || []})});
      st.taskId=reservation.taskId;st.library=reservation.library;await persist();
    }
    for (let part of chunkList(items, browserDownload ? 1 : 60)) {
      if(browserDownload) {
        const source=part[0];
        try {
          const image=await chrome.tabs.sendMessage(tabId,{type:'PIGEON_FETCH_IMAGE',url:source.srcUrl});
          if(!image?.ok) throw new Error(image?.error || '浏览器下载失败');
          part=[{...source,data:image.data,mime:image.mime}];
        } catch(e) {
          st.results.push({srcUrl:source.srcUrl,ok:false,error:'浏览器下载：'+e.message});st.failed++;st.done++;await persist();continue;
        }
      }
      // saveItems 返回的是服务端响应体本身（{ok, results, summary, taskId, library}）
      const r = await saveItems(part, { folderId, tags, taskId: st.taskId });
      if (!r) { st.aborted = '通信失败（Pigeon 未启动或网络中断）'; break; }
      if (Array.isArray(r.results) && r.summary) {
        // 合法业务响应：即使本批全部失败（HTTP 200 + ok:false + 逐项错误）也要保留
        // 逐项结果与计数并继续后续批次——不得当成通信失败丢弃
        if (r.taskId) st.taskId = r.taskId;
        if (r.library) st.library = r.library;
        st.results.push(...r.results);
        st.saved += r.summary.saved || 0;
        st.skipped += r.summary.skipped || 0;
        st.failed += r.summary.failed || 0;
        st.done += part.length;
        await persist();
        continue;
      }
      // 批级拒绝（400：任务过期 / 文件夹不属于目标库等，pigeonFetch 已抛错走 catch；
      // 这里兜底格式异常的响应）
      st.aborted = (r && r.error) || '响应格式异常';
      break;
    }
  } catch (e) {
    st.aborted = (e && e.message) || String(e);
  } finally {
    st.status = st.aborted ? 'aborted' : 'done';
    await persist().catch(e => { taskRunning = false; throw e; });
    notify(st.aborted ? '收藏中断' : '收藏完成',
      `成功 ${st.saved} · 跳过 ${st.skipped} · 失败 ${st.failed}`
      + (st.aborted ? `\n${st.aborted}\n已成功项重试不会重复导入` : '')
      + (st.library ? `\n已收进「${st.library}」` : ''));
    taskRunning = false;
  }
  return { ok: !st.aborted };
}

// ---- 弹出窗消息路由（所有网络请求集中在后台，弹出窗随时可关） ----
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (_sender?.tab && !(typeof chrome.runtime.getURL === 'function' && (_sender.url || '').startsWith(chrome.runtime.getURL('')))) throw new Error('网页内容脚本不能调用桌面写入接口');
      if (msg.type === 'PING') {
        sendResponse({ ok: true, data: await pigeonFetch('/ping') });
      } else if (msg.type === 'FOLDERS') {
        sendResponse({ ok: true, data: await pigeonFetch('/folders') });
      } else if (msg.type === 'SAVE') {
        sendResponse({ ok: true, data: await saveItems(msg.items, { folderId: msg.folderId, tags: msg.tags, taskId: msg.taskId }) });
      } else if (msg.type === 'SAVE_TASK') {
        // 弹窗发起的整次收藏（任务在后台执行，弹窗关闭不中断）
        if(taskRunning) { sendResponse({ok:false,error:'已有收藏任务正在运行'}); return; }
        if(!Array.isArray(msg.items) || !msg.items.length || msg.items.length>2000) { sendResponse({ok:false,error:'请选择 1–2000 张图片'}); return; }
        runSaveTask(msg).catch(e=>notify('收藏失败',e.message));
        sendResponse({ok:true});
      } else if (msg.type === 'TASK_STATUS') {
        const { taskState } = await chrome.storage.local.get('taskState');
        if (taskState && taskState.status === 'running' && !taskRunning) {
          taskState.status = 'aborted'; taskState.aborted = '浏览器后台已重启，请检查已保存结果后重试未完成项';
          await chrome.storage.local.set({ taskState });
        }
        sendResponse({ ok: true, data: taskState || null });
       } else if (msg.type === 'OPEN_COLLECTOR') {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !/^https?:/i.test(tab.url || '')) throw new Error('请先打开要采集的网页');
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
        await chrome.windows.create({ url: chrome.runtime.getURL('popup/popup.html') + '?tabId=' + tab.id, type: 'popup', width: 820, height: 760 });
        sendResponse({ ok: true });
      } else if (msg.type === 'COLLECT' || msg.type === 'WATCH') {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const tab = Number.isInteger(msg.tabId) ? await chrome.tabs.get(msg.tabId) : tabs[0];
        if (!tab || !tab.id) throw new Error('找不到当前标签页');
        if (!/^https?:/i.test(tab.url || '')) throw new Error('该页面不支持收集（非 http/https 页面）');
        try {
          const res = await chrome.tabs.sendMessage(tab.id, { type: msg.type === 'WATCH' ? 'PIGEON_WATCH' : 'PIGEON_COLLECT', enabled: !!msg.enabled });
          sendResponse({ ok: true, data: { ...res, tabId: tab.id } });
        } catch (e) {
          // 内容脚本未注入（首次使用）：注入后重试一次
          try {
            await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
            const res = await chrome.tabs.sendMessage(tab.id, { type: 'PIGEON_COLLECT' });
            sendResponse({ ok: true, data: res });
          } catch (e2) {
            throw new Error('无法读取该页面（浏览器内置页面或商店页等受限制页面）');
          }
        }
      } else {
        sendResponse({ ok: false, error: '未知消息类型' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message, offline: !!e.offline, noToken: !!e.noToken, badToken: !!e.badToken });
    }
  })();
  return true; // 异步 sendResponse
});

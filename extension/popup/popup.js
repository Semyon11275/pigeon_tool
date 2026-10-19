// Pigeon 扩展弹出窗：连接状态 → 扫描页面 → 勾选/尺寸筛选 → 选文件夹/标签 → 批量收藏
'use strict';

const $ = (s) => document.querySelector(s);
const send = (msg) => new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));

let candidates = [];   // 扫描到的候选 [{srcUrl, pageUrl?, w, h, alt}]
let folderList = [];
let model = new PigeonExt.Selection();
let sourceTabId = typeof location !== 'undefined' ? Number(new URLSearchParams(location.search).get('tabId')) || null : null;
let extraLimit = '';
let pageIdentity = '', watching = false, busyScan = false, watchTimer = null;
let savedPicks = null;
function visibleCandidates() { return candidates.filter(passSizeFilter); }
function persistPicks() {
  if (pageIdentity) chrome.storage.local.set({ collectionSelection: { pageUrl: pageIdentity, picks: [...model.picks], versions: Object.fromEntries(model.items.filter(it=>it.manualVariant).map(it=>[it.id,it.srcUrl])) } });
}
function optional(id, fn) { const el = $(id); if (el) fn(el); }


function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ---- 连接状态 ----
async function ping() {
  const conn = $('#conn');
  const r = await send({ type: 'PING' });
  if (r && r.ok) {
    conn.textContent = '● 已连接' + (r.data.library ? ' · ' + r.data.library : '');
    conn.className = 'conn ok';
    return true;
  }
  conn.textContent = r && r.noToken ? '● 未配置' : '● 未连接';
  conn.className = 'conn bad';
  $('#cfg-msg').textContent = r ? r.error : '通信失败';
  return false;
}

async function loadFolders() {
  const r = await send({ type: 'FOLDERS' });
  const sel = $('#folder');
  folderList = (r && r.ok && r.data.folders) || [];
  // 保留已选中的值（重开弹出窗时恢复上次选择）
  const stored=await chrome.storage.local.get(['folderId']);
  const prev = sel.value || stored.folderId || '';
  sel.innerHTML = '<option value="">不放入文件夹（未分类）</option>'
    + folderList.map(f => `<option value="${esc(f.id)}">${esc(f.path)}</option>`).join('');
  if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
}

// ---- 扫描页面 ----
async function collect() {
  const info = $('#page-info');
  info.textContent = '正在扫描当前页面...';
  if (busyScan) return;
  busyScan = true;
  let r;
  try { r = await send({ type: 'COLLECT', tabId: sourceTabId }); } finally { busyScan = false; }
  if (!r || !r.ok) {
    info.textContent = r ? r.error : '扫描失败';
    // Keep the user's selection on temporary communication failure.
    updateBtn();
    return;
  }
  const data = r.data;
  sourceTabId = data.tabId || sourceTabId;
  const first = pageIdentity !== data.pageUrl;
  if (first) { model = new PigeonExt.Selection(); pageIdentity = data.pageUrl; }
  const autoNew = first || !!$('#auto-new')?.checked;
  model.merge((data.items || []).map(it => ({ ...it, pageUrl: it.pageUrl || data.pageUrl })), false);
  candidates = model.items;
  optional('#scope', el=>{if(!data.projectAvailable && el.value==='project')el.value='all';});
  if (first && savedPicks?.pageUrl === pageIdentity) model.picks = new Set(savedPicks.picks.filter(id => model.byId.has(id)));
  else if (autoNew) {
    // Only new candidates matching the current filters are auto-selected.
    const known = new Set(candidates.filter(it => it._seen).map(it => it.id));
    model.selectVisible(visibleCandidates().filter(it => !known.has(it.id)), true);
  }
  if(first && savedPicks?.pageUrl===pageIdentity) for(const it of candidates) { const variant=it.variants?.find(v=>v.srcUrl===savedPicks.versions?.[it.id]); if(variant)Object.assign(it,variant,{id:it.id,manualVariant:true}); }
  candidates.forEach(it => { it._seen = true; });
  watching = !!data.watching;
  optional('#watch', el => { el.checked = watching; });
  optional('#scope-project', el => { el.disabled = !data.projectAvailable; });
  if (data.limited) extraLimit = ' · 已达 2000 张上限，请分次采集';
  else extraLimit = '';
  persistPicks();
  const extra = [];
  if (data.skippedInline) extra.push(`${data.skippedInline} 张 data:/blob: 图片无法收藏`);
  info.textContent = `「${data.title || '页面'}」找到 ${candidates.length} 张候选` + (extra.length ? `（${extra.join('，')}）` : '') + extraLimit;
  renderGrid();
}

function passSizeFilter(it) {
  if ($('#scope')?.value === 'project' && !it.project) return false;
  const format = $('#format-filter')?.value || '';
  if (format) {
    let ext = ''; try { ext = new URL(it.srcUrl).pathname.split('.').pop().toLowerCase(); } catch (e) {}
    if (format === 'jpeg' ? !['jpg', 'jpeg'].includes(ext) : ext !== format) return false;
  }
  const ratio = $('#ratio-filter')?.value || '';
  if ($('#unknown-only')?.checked && it.w && it.h) return false;
  if (ratio && (!it.w || !it.h || (ratio === 'wide' ? it.w <= it.h : ratio === 'tall' ? it.h <= it.w : Math.abs(it.w / it.h - 1) > 0.1))) return false;
  const min = +$('#size-filter').value;
  if (!min) return true;
  // 尺寸未知（0）的候选保留，不因筛选丢失；已知尺寸不达标的排除
  return !it.w || !it.h ? true : Math.max(it.w, it.h) >= min;
}

function renderGrid() {
  const grid = $('#grid');
  grid.innerHTML = '';
  const shown = candidates.filter(passSizeFilter);
  $('#no-img').classList.toggle('hidden', shown.length > 0);
  if (!shown.length && candidates.length) {
    $('#no-img').textContent = '当前尺寸筛选下没有候选，试试放宽尺寸条件';
  } else {
    $('#no-img').textContent = '这个页面上没有发现可收藏的图片';
  }

  for (const it of shown) {
    const cell = document.createElement('div');
    cell.className = 'cell' + (model.picks.has(it.id) ? ' sel' : '');
    // 上次失败的项默认不勾选；其余默认全选
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = it.srcUrl;
    img.onerror = () => cell.classList.add('err'); // 热链被防：仅预览失败，仍可尝试收藏
    cell.appendChild(img);
    const dim = document.createElement('div');
    dim.className = 'dim';
    dim.textContent = it.w && it.h ? `${it.w}×${it.h}` : '尺寸未知';
    cell.appendChild(dim);
    img.onload=()=>{ if(img.naturalWidth && img.naturalHeight) { it.w=img.naturalWidth;it.h=img.naturalHeight;dim.textContent=it.w+'×'+it.h; } };
    if(it.variants?.length>1) {
      const picker=document.createElement('select'); picker.title='选择图片版本';
      picker.innerHTML=it.variants.map((v,i)=>'<option value="'+i+'">版本 '+(i+1)+(v.w?' · '+v.w+'px':' · 尺寸未知')+'</option>').join('');
      picker.value=String(it.variants.findIndex(v=>v.srcUrl===it.srcUrl));
      picker.onclick=e=>e.stopPropagation();
      picker.onchange=e=>{e.stopPropagation();const v=it.variants[+picker.value];Object.assign(it,v,{id:it.id,manualVariant:true});persistPicks();renderGrid();};
      cell.appendChild(picker);
    }
    cell.title = it.srcUrl;
    cell.onclick = () => { model.toggle(it.id); cell.classList.toggle('sel', model.picks.has(it.id)); persistPicks(); syncSelAll(); updateBtn(); };
    cell.ondblclick = () => {
      const preview = $('#image-preview');
      if (preview) { preview.src = it.srcUrl; $('#preview-dialog').showModal(); }
    };
    grid.appendChild(cell);
  }
  syncSelAll();
  updateBtn();
}

function selected() { return { items: model.selected() }; }
function syncSelAll() {
  const shown = visibleCandidates();
  const count = shown.filter(it => model.picks.has(it.id)).length;
  $('#sel-all').checked = !!shown.length && count === shown.length;
  $('#sel-all').indeterminate = count > 0 && count < shown.length;
}
function updateBtn() {
  const n = model.selected().length;
  const shown = visibleCandidates();
  const hidden = n - shown.filter(it => model.picks.has(it.id)).length;
  $('#btn-save').disabled = n === 0;
  $('#btn-save').textContent = n ? '收藏到 Pigeon（' + n + '）' : '收藏到 Pigeon';
  $('#pick-count').textContent = '已选 ' + n + ' · 隐藏 ' + hidden + ' · 显示 ' + shown.length;
}
async function setWatch(enabled) {
  const r = await send({ type: 'WATCH', enabled, tabId: sourceTabId });
  if (!r?.ok) { $('#page-info').textContent = r?.error || '无法开始检测'; return; }
  watching = enabled;
  if (watchTimer) clearInterval(watchTimer);
  watchTimer = enabled ? setInterval(collect, 1500) : null;
  await collect();
}

// ---- 收藏（任务在后台 Service Worker 执行：弹窗关闭不中断，重开可看进度/结果） ----
async function doSave() {
  const { items } = selected();
  if (!items.length) return;
  const btn = $('#btn-save');
  const result = $('#result');
  btn.disabled = true;
  result.className = 'msg';
  result.textContent = `收藏中（0/${items.length}）...`;
  const folderId = $('#folder').value;
  const tags = $('#tags').value.split(/[,，]/).map(s => s.trim()).filter(Boolean).slice(0, 10);
  chrome.storage.local.set({ folderId, tags }); // 记住本次选择，右键收藏沿用
  const start = await send({
    type: 'SAVE_TASK',
    items: items.map(it => ({ srcUrl: it.srcUrl, pageUrl: it.pageUrl || '', name: it.alt || '' })),
    folderId, tags, browserDownload: !!$('#browser-download')?.checked, tabId: sourceTabId,
  });
  if (!start || !start.ok) {
    result.className = 'msg err';
    result.textContent = (start && start.error) || '通信失败';
    btn.disabled = false;
    updateBtn();
    return;
  }
  // 轮询后台任务进度（弹窗即使关闭，任务仍在后台继续）
  for (;;) {
    await new Promise(r => setTimeout(r, 400));
    const s = await send({ type: 'TASK_STATUS' });
    const st = s && s.ok && s.data;
    if (!st) break;
    if (st.status === 'running') {
      result.textContent = `收藏中（${st.done}/${st.total}）...` + (st.library ? ` →「${st.library}」` : '');
      continue;
    }
    renderTaskSummary(st);
    break;
  }
  btn.disabled = false;
  updateBtn();
}
function renderTaskSummary(st) {
  const result = $('#result');
  const fails = (st.results || []).filter(x => !x.ok);
  let txt = `成功 ${st.saved} · 跳过 ${st.skipped}（已存在） · 失败 ${st.failed}`
    + (st.done < st.total ? `（进行到 ${st.done}/${st.total}）` : '');
  if (st.library) txt += `\n已收进资料库「${st.library}」`;
  if (st.aborted) txt += `\n中断：${st.aborted}（已成功项重试不会重复导入）`;
  optional('#retry-failed', el => { el.hidden = !fails.length && !st.aborted; el.onclick=()=>{
    model.picks.clear();
    const succeeded=new Set((st.results || []).filter(x=>x.ok).map(x=>x.srcUrl));
    const retry=st.aborted ? candidates.filter(it=>!succeeded.has(it.srcUrl)) : candidates.filter(it=>fails.some(f=>f.srcUrl===it.srcUrl));
    retry.forEach(it=>model.picks.add(it.id));
    persistPicks();renderGrid();
  }; });
  if (fails.length) {
    txt += '\n失败原因（最多显示 3 条）：\n' + fails.slice(0, 3).map(f => `· ${f.error}\n  ${f.srcUrl.slice(0, 70)}`).join('\n');
    result.className = 'msg err';
  } else {
    result.className = 'msg ok';
  }
  result.textContent = txt;
}
async function showRunningTaskIfAny() {
  try {
    const s = await send({ type: 'TASK_STATUS' });
    const st = s && s.ok && s.data;
    if (st && st.status === 'running') {
      $('#page-info').textContent = `后台收藏进行中（${st.done}/${st.total}）——关闭弹窗不影响，稍后回来查看结果`;
    } else if (st && (st.status === 'done' || st.status === 'aborted') && Date.now() - (st.at || 0) < 10 * 60e3) {
      renderTaskSummary(st);
    }
  } catch (e) { /* 状态不可用时忽略 */ }
}

// ---- 设置视图 ----
async function openSettings(prefill) {
  $('#view-settings').classList.remove('hidden');
  $('#view-main').classList.add('hidden');
  const { token, port } = await chrome.storage.local.get(['token', 'port']);
  $('#inp-token').value = prefill || token || '';
  $('#inp-port').value = port || 39770;
}
async function saveCfg() {
  const token = $('#inp-token').value.trim();
  const port = +$('#inp-port').value || 39770;
  await chrome.storage.local.set({ token, port });
  $('#cfg-msg').textContent = '已保存，正在测试连接...';
  const ok = await ping();
  if (ok) {
    $('#cfg-msg').textContent = '连接成功 ✓';
    $('#view-settings').classList.add('hidden');
    $('#view-main').classList.remove('hidden');
    await loadFolders();
    await collect();
  } else {
    $('#cfg-msg').className = 'msg err';
  }
}

// ---- 启动 ----
document.addEventListener('DOMContentLoaded', async () => {
  $('#btn-gear').onclick = () => openSettings();
  $('#btn-save-cfg').onclick = saveCfg;
  $('#sel-all').onchange = () => { model.selectVisible(visibleCandidates(), $('#sel-all').checked); persistPicks(); renderGrid(); };
  $('#size-filter').onchange = () => { renderGrid(); chrome.storage.local.set({ captureFilters: { size: $('#size-filter').value, scope: $('#scope')?.value, format: $('#format-filter')?.value, ratio: $('#ratio-filter')?.value } }); };
  $('#btn-save').onclick = doSave;
  optional('#btn-window', el => { if(sourceTabId) el.hidden=true; el.onclick = async () => { const r = await send({ type: 'OPEN_COLLECTOR' }); if (!r?.ok) $('#page-info').textContent = r?.error || '打开失败'; }; });
  optional('#btn-rescan', el => { el.onclick = collect; });
  optional('#watch', el => { el.onchange = () => setWatch(el.checked); });
  for (const id of ['#scope', '#format-filter', '#ratio-filter', '#unknown-only']) optional(id, el => { el.onchange = () => { renderGrid(); chrome.storage.local.set({ captureFilters: { size: $('#size-filter').value, scope: $('#scope')?.value, format: $('#format-filter')?.value, ratio: $('#ratio-filter')?.value } }); }; });
  optional('#btn-clear', el => { el.onclick = () => { model.picks.clear(); persistPicks(); renderGrid(); }; });
  optional('#preview-close', el => { el.onclick = () => { $('#preview-dialog').close(); $('#image-preview').src = ''; }; });
  const prefs = await chrome.storage.local.get(['collectionSelection', 'captureFilters', 'tags']);
  savedPicks = prefs.collectionSelection;
  if (prefs.tags) $('#tags').value = prefs.tags.join(', ');
  if (prefs.captureFilters) {
    for (const [key,id] of Object.entries({size:'#size-filter',scope:'#scope',format:'#format-filter',ratio:'#ratio-filter'})) optional(id, el => { el.value = prefs.captureFilters[key] || ''; });
  }

  const ok = await ping();
  if (!ok) { openSettings(); return; }
  await loadFolders();
  await collect();
  if(watching && !watchTimer) watchTimer=setInterval(collect,1500);
  await showRunningTaskIfAny(); // 有后台任务在跑（或刚结束）时直接展示进度/结果
});

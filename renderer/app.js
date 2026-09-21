// Pigeon — 渲染进程（复刻 Eagle 核心交互）
'use strict';

// ================= 工具 =================
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

function fmtSize(n) {
  if (n == null) return '-';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 ** 3) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 ** 3).toFixed(2) + ' GB';
}
function fmtDate(ms) {
  if (!ms) return '-';
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtDuration(s) {
  if (s == null) return null;
  const m = Math.floor(s / 60), sec = Math.round(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}
function itemUrl(item, file) { return `pigeon://item/${item.id}/${encodeURIComponent(file)}`; }
function itemFileName(item) { return item.name + '.' + item.ext; }
const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg']);
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'm4v', 'mkv', 'avi']);
const FONT_EXTS = new Set(['ttf', 'otf', 'ttc', 'woff', 'woff2']);
// Chromium 原生可解码（大图/网格直接 <img> 渲染）
const RENDERABLE_IMG_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg']);
// canvas 可安全采样（生成缩略图/调色板/pHash）
const CANVAS_IMG_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp']);
function isImage(item) { return IMAGE_EXTS.has(item.ext) || RENDERABLE_IMG_EXTS.has(item.ext); }
function isVideo(item) { return VIDEO_EXTS.has(item.ext); }
function isFont(item) { return FONT_EXTS.has(item.ext); }
function orientation(item) {
  if (!item.width || !item.height) return 'unknown';
  const r = item.width / item.height;
  if (r > 2.2 || r < 1 / 2.2) return 'pano';
  if (r > 1.15) return 'landscape';
  if (r < 1 / 1.15) return 'portrait';
  return 'square';
}
function colorDist(a, b) {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}
const COLOR_SWATCHES = [
  ['黑', [20, 20, 20]], ['灰', [128, 128, 128]], ['白', [245, 245, 245]],
  ['红', [220, 50, 47]], ['橙', [240, 130, 40]], ['黄', [235, 210, 60]],
  ['绿', [90, 180, 80]], ['青', [60, 190, 190]], ['蓝', [55, 110, 220]],
  ['紫', [140, 80, 200]], ['粉', [235, 130, 170]], ['棕', [140, 95, 60]],
];
// pHash 汉明距离（64bit hex）
function hamming(a, b) {
  try {
    let x = BigInt('0x' + a) ^ BigInt('0x' + b);
    let n = 0;
    while (x) { if (x & 1n) n++; x >>= 1n; }
    return n;
  } catch (e) { return 64; }
}

// ================= 状态 =================
const state = {
  items: [], meta: { folders: [] }, root: null,
  view: { kind: 'all', id: null, label: '全部' },
  search: '',
  filters: { exts: new Set(), tags: new Set(), minRating: 0, shape: '', days: 0, color: null },
  smartFolders: [],
  sort: { key: 'btime', dir: -1 },
  aiMode: false, aiResults: null,
  zoom: +(localStorage.getItem('pigeon.zoom') || 220),
  layout: localStorage.getItem('pigeon.layout') || 'waterfall',
  selection: new Set(),
  anchorId: null,
  randomSeed: [],
  inspectorOpen: true,
  expanded: new Set(),
  previewIndex: -1,
};
let visible = []; // 当前可见条目（排序后）

function findFolder(id, list = state.meta.folders) {
  for (const f of list) {
    if (f.id === id) return f;
    const hit = findFolder(id, f.children || []);
    if (hit) return hit;
  }
  return null;
}
function folderPath(id) {
  const walk = (list, trail) => {
    for (const f of list) {
      if (f.id === id) return [...trail, f.name];
      const r = walk(f.children || [], [...trail, f.name]);
      if (r) return r;
    }
    return null;
  };
  return walk(state.meta.folders, []) || ['?'];
}
function allTags() {
  const m = new Map();
  for (const it of state.items) {
    if (it.isDeleted) continue;
    for (const t of it.tags || []) m.set(t, (m.get(t) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}
function allExts() {
  const m = new Map();
  for (const it of state.items) {
    if (it.isDeleted) continue;
    m.set(it.ext, (m.get(it.ext) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function computeVisible() {
  const v = state.view, f = state.filters, q = state.search.trim().toLowerCase();
  // AI 语义模式：整库按相似度排序
  if (state.aiMode && q && state.aiResults) {
    if (state.aiResults.query === q) {
      return state.aiResults.ids.map(id => state.items.find(i => i.id === id)).filter(Boolean);
    }
    return [];
  }
  const v2 = v; // 保留原视图逻辑
  let list;
  if (v.kind === 'trash') list = state.items.filter(i => i.isDeleted);
  else {
    list = state.items.filter(i => !i.isDeleted);
    if (v.kind === 'folder') list = list.filter(i => (i.folders || []).includes(v.id));
    else if (v.kind === 'unfiled') list = list.filter(i => !(i.folders || []).length);
    else if (v.kind === 'untagged') list = list.filter(i => !(i.tags || []).length);
    else if (v.kind === 'tag') list = list.filter(i => (i.tags || []).includes(v.id));
    else if (v.kind === 'recent') list = list.slice().sort((a, b) => b.btime - a.btime).slice(0, 200);
    else if (v.kind === 'random') list = shuffleStable(list);
  }
  if (q) {
    list = list.filter(i =>
      i.name.toLowerCase().includes(q) ||
      (i._py && (i._py.full.includes(q) || i._py.head.includes(q))) ||
      (i.tags || []).some(t => t.toLowerCase().includes(q)) ||
      (i.annotation || '').toLowerCase().includes(q) ||
      (i.url || '').toLowerCase().includes(q));
  }
  if (f.exts.size) list = list.filter(i => f.exts.has(i.ext));
  if (f.tags.size) list = list.filter(i => [...f.tags].every(t => (i.tags || []).includes(t)));
  if (f.minRating) list = list.filter(i => (i.rating || 0) >= f.minRating);
  if (f.shape) list = list.filter(i => orientation(i) === f.shape);
  if (f.color) list = list.filter(i => (i.palettes || []).some(p => colorDist(p.color, f.color) < 120));
  if (f.days) {
    const cut = Date.now() - f.days * 86400e3;
    list = list.filter(i => (i.btime || 0) >= cut);
  }
  if (v.kind === 'similar') {
    const target = state.items.find(i => i.id === v.id);
    if (!target || !target.phash) list = [];
    else {
      list = list
        .filter(i => i.id !== v.id && i.phash)
        .map(i => [i, hamming(target.phash, i.phash)])
        .filter(x => x[1] < 24)
        .sort((a, b) => a[1] - b[1])
        .map(x => x[0]);
    }
    return list; // 相似视图不受排序/其他筛选影响
  }
  if (!['recent', 'random'].includes(v.kind)) {
    const dir = state.sort.dir;
    list = list.slice().sort((a, b) => {
      let r = 0;
      if (state.sort.key === 'name') r = a.name.localeCompare(b.name, 'zh');
      else if (state.sort.key === 'size') r = (a.size || 0) - (b.size || 0);
      else if (state.sort.key === 'rating') r = (a.rating || 0) - (b.rating || 0);
      else if (state.sort.key === 'mtime') r = (a.mtime || 0) - (b.mtime || 0);
      else r = (a.btime || 0) - (b.btime || 0);
      return r * dir;
    });
  }
  return list;
}
function shuffleStable(list) {
  if (state.randomSeed.length !== list.length) {
    state.randomSeed = list.map(() => Math.random());
  }
  return list.map((it, i) => [it, state.randomSeed[i]]).sort((a, b) => a[1] - b[1]).map(x => x[0]);
}

// ================= 侧栏 =================
const ICONS = {
  folder: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 4a1.5 1.5 0 011.5-1.5h3l1.6 1.6H13A1.5 1.5 0 0114.5 5.5V12A1.5 1.5 0 0113 13.5H3A1.5 1.5 0 011.5 12V4z"/></svg>',
  tag: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M2 2h5l7 7-5 5-7-7V2z" stroke-linejoin="round"/><circle cx="5.2" cy="5.2" r="1" fill="currentColor" stroke="none"/></svg>',
  inbox: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M2 9l2-6h8l2 6v3.5a1 1 0 01-1 1H3a1 1 0 01-1-1V9z" stroke-linejoin="round"/><path d="M2 9h3.5l1 1.8h3L10.5 9H14"/></svg>',
  trash: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.2a1 1 0 001 .8h3.6a1 1 0 001-.8l.7-8.2" stroke-linecap="round"/></svg>',
  clock: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.4 1.6" stroke-linecap="round"/></svg>',
  dice: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="2.5" y="2.5" width="11" height="11" rx="2.5"/><circle cx="5.6" cy="5.6" r=".9" fill="currentColor" stroke="none"/><circle cx="10.4" cy="10.4" r=".9" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r=".9" fill="currentColor" stroke="none"/></svg>',
  star: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M8 2l1.8 3.8 4.2.5-3.1 2.9.8 4.1L8 11.3l-3.7 2 .8-4.1L2 6.3l4.2-.5L8 2z" stroke-linejoin="round"/></svg>',
};

const cnt = (fn) => state.items.filter(fn).length;

function specialViews() {
  return [
    { kind: 'all', label: '全部', icon: ICONS.inbox, count: cnt(i => !i.isDeleted) },
    { kind: 'unfiled', label: '未分类', icon: ICONS.inbox, count: cnt(i => !i.isDeleted && !(i.folders || []).length) },
    { kind: 'untagged', label: '未标签', icon: ICONS.tag, count: cnt(i => !i.isDeleted && !(i.tags || []).length) },
    { kind: 'recent', label: '最近添加', icon: ICONS.clock, count: null },
    { kind: 'random', label: '随机', icon: ICONS.dice, count: null },
  ];
}

function renderSidebar() {
  const sb = $('#sidebar');
  sb.innerHTML = '';
  // 库视图
  const sec1 = el('div', 'sb-section');
  sec1.appendChild(el('div', 'sb-header', '库'));
  for (const v of specialViews()) {
    const row = el('div', 'sb-item' + (state.view.kind === v.kind ? ' active' : ''));
    row.innerHTML = `${v.icon}<span class="label">${v.label}</span>` + (v.count != null ? `<span class="count">${v.count}</span>` : '');
    row.onclick = () => setView({ kind: v.kind, id: null, label: v.label });
    sec1.appendChild(row);
  }
  // 回收站
  const trashCount = cnt(i => i.isDeleted);
  const trow = el('div', 'sb-item' + (state.view.kind === 'trash' ? ' active' : ''));
  trow.innerHTML = `${ICONS.trash}<span class="label">回收站</span><span class="count">${trashCount || ''}</span>`;
  trow.onclick = () => setView({ kind: 'trash', id: null, label: '回收站' });
  sec1.appendChild(trow);
  sb.appendChild(sec1);

  // 智能文件夹
  const secS = el('div', 'sb-section');
  const hS = el('div', 'sb-header', '智能文件夹');
  secS.appendChild(hS);
  for (const sf of state.smartFolders) {
    const row = el('div', 'sb-item');
    row.innerHTML = `<span style="width:15px;text-align:center;flex:none">⚡</span><span class="label">${esc(sf.name)}</span>`;
    row.onclick = () => applySmartFolder(sf);
    row.oncontextmenu = (e) => {
      e.preventDefault();
      showMenu(e.clientX, e.clientY, [
        { label: '重命名', action: async () => {
          const name = await prompt2('重命名智能文件夹', '新名称', sf.name);
          if (name) {
            sf.name = name;
            state.smartFolders = await api.smartFolders.set(state.smartFolders);
            renderSidebar();
          }
        } },
        { sep: true },
        { label: '删除', danger: true, action: async () => {
          state.smartFolders = state.smartFolders.filter(x => x.id !== sf.id);
          state.smartFolders = await api.smartFolders.set(state.smartFolders);
          renderSidebar();
        } },
      ]);
    };
    secS.appendChild(row);
  }
  if (!state.smartFolders.length) secS.appendChild(el('div', 'sb-item', '<span class="label" style="color:var(--text-faint)">设置筛选条件后可保存</span>'));
  sb.appendChild(secS);

  // 文件夹
  const sec2 = el('div', 'sb-section');
  const h2 = el('div', 'sb-header', '文件夹');
  const add = el('button', 'sb-add', '+');
  add.title = '新建文件夹';
  add.onclick = (e) => { e.stopPropagation(); newFolderDialog(null); };
  h2.appendChild(add);
  sec2.appendChild(h2);
  const renderTree = (list, depth) => {
    for (const f of list) {
      const childCount = (id) => state.items.filter(i => !i.isDeleted && (i.folders || []).includes(id)).length;
      const expanded = state.expanded.has(f.id);
      const hasChildren = (f.children || []).length > 0;
      const row = el('div', 'sb-item' + (state.view.kind === 'folder' && state.view.id === f.id ? ' active' : ''));
      row.dataset.folderId = f.id;
      row.innerHTML = `
        <span class="twisty ${hasChildren ? '' : 'leaf'} ${expanded ? 'expanded' : ''}"><svg viewBox="0 0 10 10" width="8" height="8"><path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round"/></svg></span>
        ${ICONS.folder}<span class="label">${esc(f.name)}</span><span class="count">${childCount(f.id) || ''}</span>`;
      row.style.paddingLeft = (16 + depth * 14) + 'px';
      row.onclick = () => setView({ kind: 'folder', id: f.id, label: f.name });
      row.oncontextmenu = (e) => {
        e.preventDefault();
        showMenu(e.clientX, e.clientY, [
          { label: '新建子文件夹', action: () => newFolderDialog(f.id) },
          { label: '重命名', action: () => renameFolderDialog(f) },
          { sep: true },
          { label: '删除文件夹', danger: true, action: () => removeFolderConfirm(f) },
        ]);
      };
      const tw = $('.twisty', row);
      if (hasChildren) tw.onclick = (e) => { e.stopPropagation(); toggleExpand(f.id); };
      // 拖放：把条目加进文件夹
      row.ondragover = (e) => { if (e.dataTransfer.types.includes('text/pigeon-items')) { e.preventDefault(); row.classList.add('drop-target'); } };
      row.ondragleave = () => row.classList.remove('drop-target');
      row.ondrop = (e) => {
        e.preventDefault(); row.classList.remove('drop-target');
        const ids = JSON.parse(e.dataTransfer.getData('text/pigeon-items') || '[]');
        if (ids.length) addItemsToFolder(ids, f.id);
      };
      sec2.appendChild(row);
      if (expanded) renderTree(f.children || [], depth + 1);
    }
  };
  renderTree(state.meta.folders, 0);
  sb.appendChild(sec2);

  // 标签
  const tags = allTags();
  const sec3 = el('div', 'sb-section');
  sec3.appendChild(el('div', 'sb-header', `标签（${tags.length}）`));
  for (const [tag, n] of tags.slice(0, 40)) {
    const row = el('div', 'sb-item' + (state.view.kind === 'tag' && state.view.id === tag ? ' active' : ''));
    row.innerHTML = `<span class="tag-dot"></span><span class="label">${esc(tag)}</span><span class="count">${n}</span>`;
    row.onclick = () => setView({ kind: 'tag', id: tag, label: '#' + tag });
    row.ondragover = (e) => { if (e.dataTransfer.types.includes('text/pigeon-items')) e.preventDefault(); };
    row.ondrop = (e) => {
      e.preventDefault();
      const ids = JSON.parse(e.dataTransfer.getData('text/pigeon-items') || '[]');
      if (ids.length) addTagToItems(ids, tag);
    };
    sec3.appendChild(row);
  }
  if (!tags.length) sec3.appendChild(el('div', 'sb-item', '<span class="label" style="color:var(--text-faint)">暂无标签，选中文件按 Ctrl+T 添加</span>'));
  sb.appendChild(sec3);
}

function setView(v) {
  state.view = v;
  state.selection.clear();
  state.anchorId = null;
  if (v.kind === 'random') state.randomSeed = [];
  renderAll();
}
function toggleExpand(id) {
  if (state.expanded.has(id)) state.expanded.delete(id); else state.expanded.add(id);
  renderSidebar();
}

// ================= 网格 =================
function renderGrid() {
  visible = computeVisible();
  const grid = $('#grid');
  grid.innerHTML = '';
  grid.classList.toggle('list-mode', state.layout === 'list');
  $('#empty-hint').classList.toggle('hidden', visible.length > 0);
  if (!visible.length) {
    const hint = $('#empty-hint');
    const msg = state.search ? `没有找到与「${esc(state.search)}」相关的项目` :
      state.view.kind === 'trash' ? '回收站是空的' : '这里还没有内容，拖入文件或点击右上角「导入」';
    hint.innerHTML = `<div class="big">🪿</div><div>${msg}</div>`;
  }

  const frag = document.createDocumentFragment();
  visible.forEach((item, idx) => {
    const card = buildItemCard(item, idx);
    frag.appendChild(card);
  });
  grid.appendChild(frag);
  layoutGrid();
  renderViewTitle();
  renderStatus();
}

function buildItemCard(item, idx) {
  const card = el('div', 'item' + (state.selection.has(item.id) ? ' selected' : ''));
  card.dataset.id = item.id;
  card.dataset.idx = idx;
  const knownRatio = item.width && item.height ? item.width / item.height : (isVideo(item) ? 16 / 9 : 1);
  card.dataset.ratio = String(knownRatio);

  const media = el('div', 'media');
  attachItemMedia(item, media);
  card.appendChild(media);

  // 列表模式的文字信息（其他布局下由 CSS 隐藏）
  const meta = el('div', 'meta-lines');
  const durTxt = fmtDuration(item.duration);
  const tagsN = (item.tags || []).length;
  meta.innerHTML = `<div class="n1">${esc(item.name)}</div>
    <div class="n2">${esc(item.ext.toUpperCase())}${item.width && item.height ? ` · ${item.width}×${item.height}` : ''} · ${fmtSize(item.size)}${durTxt ? ' · ' + durTxt : ''} · ${fmtDate(item.btime)}${tagsN ? ' · ' + tagsN + ' 个标签' : ''}</div>`;
  card.appendChild(meta);

  const overlay = el('div', 'name-overlay', esc(item.name));
  card.appendChild(overlay);
  const dur = fmtDuration(item.duration);
  if (isVideo(item)) {
    card.appendChild(el('div', 'badge', dur ? dur : '▶'));
    card.appendChild(el('div', 'type-icon', item.ext.toUpperCase()));
  } else if (!isImage(item)) {
    card.appendChild(el('div', 'type-icon', item.ext.toUpperCase()));
  }
  if (item.star) card.appendChild(el('div', 'star-flag', '⭐'));
  if (state.aiResults && state.aiResults.scores[item.id] != null) {
    card.appendChild(el('div', 'score-badge', (state.aiResults.scores[item.id] * 100).toFixed(0) + '%'));
  }

  // 选择
  card.onclick = (e) => {
    if (e.ctrlKey || e.metaKey) {
      if (state.selection.has(item.id)) state.selection.delete(item.id);
      else { state.selection.add(item.id); state.anchorId = item.id; }
      renderGrid(); renderInspector(); renderStatus();
    } else if (e.shiftKey && state.anchorId) {
      const a = visible.findIndex(i => i.id === state.anchorId);
      const b = idx;
      state.selection.clear();
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) state.selection.add(visible[i].id);
      renderGrid(); renderInspector(); renderStatus();
    } else {
      state.selection.clear(); state.selection.add(item.id); state.anchorId = item.id;
      $$('#grid .item.selected').forEach(x => x.classList.remove('selected'));
      card.classList.add('selected');
      renderInspector(); renderStatus();
    }
  };
  card.ondblclick = () => openPreview(idx);
  // 拖动（拖到侧栏文件夹）
  card.draggable = true;
  card.ondragstart = (e) => {
    if (!state.selection.has(item.id)) { state.selection.clear(); state.selection.add(item.id); }
    e.dataTransfer.setData('text/pigeon-items', JSON.stringify([...state.selection]));
    e.dataTransfer.effectAllowed = 'copyMove';
  };
  card.oncontextmenu = (e) => {
    e.preventDefault(); e.stopPropagation();
    if (!state.selection.has(item.id)) {
      state.selection.clear(); state.selection.add(item.id); state.anchorId = item.id;
      renderGrid(); renderInspector(); renderStatus();
    }
    showItemMenu(e.clientX, e.clientY, item);
  };
  return card;
}

function attachItemMedia(item, media) {
  const setFallback = () => {
    media.innerHTML = '';
    if (isVideo(item)) {
      const v = el('video');
      v.src = itemUrl(item, itemFileName(item));
      v.muted = true; v.preload = 'metadata'; v.loop = true;
      v.onmouseenter = () => v.play().catch(() => {});
      v.onmouseleave = () => { v.pause(); };
      media.appendChild(v);
    } else if (isFont(item)) {
      const box = el('div', 'font-sample', `<div class="fx">Ag 龙</div><div class="fc">${esc(item.name)}</div>`);
      media.appendChild(box);
      const fc = new FontFace('pigeon-font-' + item.id, `url(${itemUrl(item, itemFileName(item))})`);
      fc.load().then(f => {
        document.fonts.add(f);
        $('.fx', box).style.fontFamily = `'pigeon-font-${item.id}'`;
      }).catch(() => {});
    } else {
      media.innerHTML = `<div class="ext-fallback"><span style="font-size:22px">📄</span><span>${esc(item.ext)}</span></div>`;
    }
  };
  if (isFont(item)) { setFallback(); return; }
  // 所有条目先尝试 thumbnail.png；不可解码格式（tif/psd 等）靠主进程预生成的缩略图显示
  const img = el('img');
  img.loading = 'lazy';
  img.decoding = 'async';
  img.src = itemUrl(item, 'thumbnail.png');
  img.onerror = () => {
    if (RENDERABLE_IMG_EXTS.has(item.ext)) {
      img.onerror = setFallback;
      img.src = itemUrl(item, itemFileName(item));
    } else setFallback();
  };
  media.appendChild(img);
}

// 瀑布流 / 网格布局
function layoutGrid() {
  const grid = $('#grid');
  if (state.layout === 'list') { grid.style.height = 'auto'; return; }
  const wrap = $('#grid-wrap');
  const W = wrap.clientWidth - 28; // padding
  const gap = 10;
  const target = state.zoom;
  const cols = Math.max(1, Math.floor((W + gap) / (target + gap)));
  const colW = (W - gap * (cols - 1)) / cols;
  const heights = new Array(cols).fill(0);
  const cards = $$('#grid .item');
  for (const card of cards) {
    const ratio = parseFloat(card.dataset.ratio) || 1;
    const h = Math.max(50, state.layout === 'grid'
      ? colW * 0.78
      : colW / Math.max(ratio, 0.2));
    let c = 0;
    for (let i = 1; i < cols; i++) if (heights[i] < heights[c]) c = i;
    card.style.width = colW + 'px';
    card.style.height = h + 'px';
    card.style.transform = `translate(${c * (colW + gap)}px, ${heights[c]}px)`;
    heights[c] += h + gap;
  }
  grid.style.height = Math.max(0, Math.max(...heights) - gap) + 'px';
}
const relayout = debounce(layoutGrid, 80);

// 视图标题 & 状态栏
function renderViewTitle() {
  const v = state.view;
  const t = $('#view-title');
  let label = v.label;
  if (v.kind === 'folder') {
    const p = folderPath(v.id).join(' / ');
    label = p;
  }
  t.innerHTML = `${esc(label)}<small>${visible.length} 个项目</small>`;
}
function renderStatus() {
  $('#status-count').textContent = `共 ${state.items.filter(i => !i.isDeleted).length} 个项目`;
  $('#status-sel').textContent = state.selection.size ? `已选 ${state.selection.size} 个` : '';
  $('#status-lib').textContent = state.root || '';
}

// ================= 信息面板 =================
function renderInspector() {
  const insp = $('#inspector');
  insp.classList.toggle('collapsed', !state.inspectorOpen);
  $('#btn-inspector').classList.toggle('on', state.inspectorOpen);
  insp.innerHTML = '';
  const ids = [...state.selection];
  if (!ids.length) {
    insp.innerHTML = '<div class="insp-empty">未选择项目<br><span style="font-size:11px">点击缩略图查看详情</span></div>';
    return;
  }
  if (ids.length > 1) {
    const items = state.items.filter(i => ids.includes(i.id));
    const sec = el('div', 'insp-multi');
    sec.innerHTML = `<div class="num">${ids.length}</div><div style="color:var(--text-faint)">已选定项目</div>`;
    insp.appendChild(sec);
    insp.appendChild(buildBatchTagSection(items));
    insp.appendChild(buildBatchRatingSection(items));
    insp.appendChild(buildBatchFolderSection(items));
    const acts = el('div', 'insp-actions');
    const del = el('button', 'danger', '删除所选');
    del.onclick = () => trashSelection();
    acts.appendChild(del);
    insp.appendChild(acts);
    return;
  }
  const item = state.items.find(i => i.id === ids[0]);
  if (!item) return;

  // 缩略图
  const thumb = el('div', 'insp-thumb');
  const img = el('img');
  img.src = itemUrl(item, 'thumbnail.png');
  img.onerror = () => { img.onerror = () => { thumb.innerHTML = '<span style="color:var(--text-faint)">无预览</span>'; }; img.src = itemUrl(item, itemFileName(item)); };
  thumb.appendChild(img);
  insp.appendChild(thumb);

  // 名称
  const secName = el('div', 'insp-section');
  secName.appendChild(el('div', 'insp-label', '标题'));
  const nameInput = el('input', 'insp-name');
  nameInput.value = item.name;
  nameInput.onchange = async () => {
    if (!nameInput.value.trim()) { nameInput.value = item.name; return; }
    await api.items.update(item.id, { name: nameInput.value.trim() });
    item.name = nameInput.value.trim();
    renderGrid();
  };
  secName.appendChild(nameInput);
  insp.appendChild(secName);

  // 评分
  const secRating = el('div', 'insp-section');
  secRating.appendChild(el('div', 'insp-label', '评分'));
  const stars = el('div', 'stars');
  for (let i = 1; i <= 5; i++) {
    const s = el('button', i <= (item.rating || 0) ? 'on' : '', '★');
    s.onclick = async () => {
      const nr = i === item.rating ? 0 : i;
      await api.items.update(item.id, { rating: nr });
      item.rating = nr; renderInspector(); renderStatus();
    };
    stars.appendChild(s);
  }
  secRating.appendChild(stars);
  insp.appendChild(secRating);

  // 标签
  insp.appendChild(buildTagSection(item));

  // 文件夹归属
  const secF = el('div', 'insp-section');
  secF.appendChild(el('div', 'insp-label', '所属文件夹'));
  const chips = el('div', 'folder-chips');
  if (!(item.folders || []).length) chips.innerHTML = '<span style="color:var(--text-faint);font-size:11.5px">未分类</span>';
  for (const fid of item.folders || []) {
    const chip = el('span', 'folder-chip', `${esc(folderPath(fid).join('/'))}<span class="x" title="移出">×</span>`);
    $('.x', chip).onclick = async () => {
      item.folders = item.folders.filter(x => x !== fid);
      await api.items.update(item.id, { folders: item.folders });
      renderAll();
    };
    chips.appendChild(chip);
  }
  secF.appendChild(chips);
  insp.appendChild(secF);

  // 注释
  const secNote = el('div', 'insp-section');
  secNote.appendChild(el('div', 'insp-label', '注释'));
  const note = el('textarea', 'insp-annotation');
  note.placeholder = '添加注释...';
  note.value = item.annotation || '';
  let noteTimer;
  note.oninput = () => {
    clearTimeout(noteTimer);
    noteTimer = setTimeout(async () => {
      item.annotation = note.value;
      await api.items.update(item.id, { annotation: note.value });
    }, 500);
  };
  secNote.appendChild(note);
  insp.appendChild(secNote);

  // 基本信息
  const secInfo = el('div', 'insp-section');
  secInfo.appendChild(el('div', 'insp-label', '基本信息'));
  const info = el('div', 'insp-info');
  const rows = [
    ['格式', item.ext.toUpperCase()],
    ['尺寸', (item.width && item.height) ? `${item.width} × ${item.height}` : '-'],
    ['大小', fmtSize(item.size)],
    ['时长', fmtDuration(item.duration) || '-'],
    ['添加日期', fmtDate(item.btime)],
    ['修改日期', fmtDate(item.mtime)],
  ];
  for (const [k, v] of rows) info.appendChild(el('div', 'insp-row', `<span class="k">${k}</span><span class="v">${esc(v)}</span>`));
  if (item.url) {
    const row = el('div', 'insp-row', `<span class="k">来源</span>`);
    const v = el('span', 'v');
    const a = el('a', '', '打开来源链接 ↗');
    a.onclick = () => api.shell.openExternal(item.url);
    a.title = item.url;
    v.appendChild(a);
    row.appendChild(v);
    info.appendChild(row);
  }
  secInfo.appendChild(info);
  insp.appendChild(secInfo);

  // EXIF（JPEG 拍摄参数，异步加载）
  if (['jpg', 'jpeg', 'tif', 'tiff'].includes(item.ext)) {
    api.exif.get(item.id).then(exif => {
      if (!exif || !insp.contains(secInfo)) return;
      const rows = [];
      if (exif.camera) rows.push(['相机', exif.camera]);
      if (exif.focalLength) rows.push(['焦距', exif.focalLength]);
      if (exif.aperture) rows.push(['光圈', 'f/' + exif.aperture]);
      if (exif.shutter) rows.push(['快门', exif.shutter]);
      if (exif.iso) rows.push(['ISO', exif.iso]);
      if (exif.takenAt) rows.push(['拍摄时间', fmtDate(exif.takenAt)]);
      if (!rows.length) return;
      const secE = el('div', 'insp-section');
      secE.appendChild(el('div', 'insp-label', '拍摄信息'));
      const ei = el('div', 'insp-info');
      for (const [k, v] of rows) ei.appendChild(el('div', 'insp-row', `<span class="k">${k}</span><span class="v">${esc(v)}</span>`));
      secE.appendChild(ei);
      insp.insertBefore(secE, acts);
    }).catch(() => {});
  }

  // 调色板
  if ((item.palettes || []).length) {
    const secP = el('div', 'insp-section');
    secP.appendChild(el('div', 'insp-label', '调色板'));
    const pal = el('div', 'palette');
    for (const p of item.palettes.slice(0, 5)) {
      const [r, g, b] = p.color;
      const hex = '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
      const sw = el('div', 'swatch');
      sw.style.background = hex;
      sw.title = `${hex} · ${p.ratio}%`;
      sw.innerHTML = `<i>${p.ratio}%</i>`;
      sw.onclick = () => api.clipboard.writeText(hex);
      pal.appendChild(sw);
    }
    secP.appendChild(pal);
    insp.appendChild(secP);
  }

  // 操作
  const acts = el('div', 'insp-actions');
  const mk = (label, fn, cls = '') => { const b = el('button', cls, label); b.onclick = fn; acts.appendChild(b); };
  mk('在资源管理器显示', () => api.shell.reveal(item.id));
  mk('打开文件', () => api.shell.open(item.id));
  mk('复制文件名', () => api.clipboard.writeText(itemFileName(item)));
  if (item.url) mk('复制链接', () => api.clipboard.writeText(item.url));
  const delB = el('button', 'danger', item.isDeleted ? '永久删除' : '删除');
  delB.onclick = () => item.isDeleted ? deleteForever([item.id]) : trashSelection();
  acts.appendChild(delB);
  insp.appendChild(acts);
}

// 标签编辑区（单个）
function buildTagSection(item) {
  const sec = el('div', 'insp-section');
  sec.appendChild(el('div', 'insp-label', '标签'));
  const wrap = el('div', 'tag-editor');
  const renderChips = () => {
    wrap.innerHTML = '';
    for (const t of item.tags || []) {
      const chip = el('span', 'tag-chip', `${esc(t)}<span class="x">×</span>`);
      $('.x', chip).onclick = async () => {
        item.tags = item.tags.filter(x => x !== t);
        await api.items.update(item.id, { tags: item.tags });
        renderAll();
      };
      wrap.appendChild(chip);
    }
    const input = el('input', 'tag-add');
    input.placeholder = '+ 标签';
    input.onkeydown = async (e) => {
      if (e.key === 'Enter' && input.value.trim()) {
        e.preventDefault();
        const t = input.value.trim();
        if (!item.tags.includes(t)) {
          item.tags = [...(item.tags || []), t];
          await api.items.update(item.id, { tags: item.tags });
          renderAll();
        }
      }
    };
    wrap.appendChild(input);
  };
  renderChips();
  sec.appendChild(wrap);
  return sec;
}
function buildBatchTagSection(items) {
  const sec = el('div', 'insp-section');
  sec.appendChild(el('div', 'insp-label', '批量添加标签'));
  const wrap = el('div', 'tag-editor');
  const input = el('input', 'tag-add');
  input.placeholder = '输入标签，回车应用';
  input.style.width = '100%';
  input.onkeydown = async (e) => {
    if (e.key === 'Enter' && input.value.trim()) {
      const t = input.value.trim();
      for (const it of items) {
        if (!(it.tags || []).includes(t)) {
          it.tags = [...(it.tags || []), t];
          await api.items.update(it.id, { tags: it.tags });
        }
      }
      input.value = ''; renderAll();
    }
  };
  wrap.appendChild(input);
  sec.appendChild(wrap);
  return sec;
}
function buildBatchRatingSection(items) {
  const sec = el('div', 'insp-section');
  sec.appendChild(el('div', 'insp-label', '批量评分'));
  const stars = el('div', 'stars');
  for (let i = 1; i <= 5; i++) {
    const s = el('button', '', '★');
    s.onclick = async () => {
      for (const it of items) { it.rating = i; await api.items.update(it.id, { rating: i }); }
      renderAll();
    };
    stars.appendChild(s);
  }
  sec.appendChild(stars);
  return sec;
}
function buildBatchFolderSection(items) {
  const sec = el('div', 'insp-section');
  sec.appendChild(el('div', 'insp-label', '添加到文件夹'));
  const chips = el('div', 'folder-chips');
  const flat = [];
  const walk = (list, d) => list.forEach(f => { flat.push([f, d]); walk(f.children || [], d + 1); });
  walk(state.meta.folders, 0);
  for (const [f, d] of flat) {
    const chip = el('span', 'folder-chip', `${'─'.repeat(d)} ${esc(f.name)}`);
    chip.onclick = () => addItemsToFolder(items.map(i => i.id), f.id);
    chips.appendChild(chip);
  }
  sec.appendChild(chips);
  return sec;
}

// ================= 预览 =================
function openPreview(idx) {
  if (idx < 0 || idx >= visible.length) return;
  state.previewIndex = idx;
  renderPreview();
  $('#preview').classList.remove('hidden');
}
function closePreview() {
  if (slideTimer) { clearInterval(slideTimer); slideTimer = null; }
  $('#preview').classList.add('hidden');
  state.previewIndex = -1;
}
function previewStep(d) {
  const n = state.previewIndex + d;
  if (n >= 0 && n < visible.length) { state.previewIndex = n; renderPreview(); }
}
let pvZoom = 1, pvPanX = 0, pvPanY = 0;
function renderPreview() {
  const item = visible[state.previewIndex];
  const pv = $('#preview');
  pv.innerHTML = '';
  pvZoom = 1; pvPanX = 0; pvPanY = 0;
  if (!item) { closePreview(); return; }

  const top = el('div', 'pv-top');
  top.innerHTML = `<span class="pv-title">${esc(item.name)}</span>
    <span class="pv-meta">${item.ext.toUpperCase()}${item.width ? ` · ${item.width}×${item.height}` : ''}${fmtDuration(item.duration) ? ' · ' + fmtDuration(item.duration) : ''} · ${fmtSize(item.size)} · ${state.previewIndex + 1}/${visible.length}</span>`;
  const closeB = el('button', 'pv-close', '✕');
  closeB.onclick = closePreview;
  top.appendChild(closeB);
  pv.appendChild(top);

  const stage = el('div', 'pv-stage');
  if (isVideo(item)) {
    const v = el('video');
    v.src = itemUrl(item, itemFileName(item));
    v.controls = true; v.autoplay = true; v.loop = true;
    stage.appendChild(v);
  } else if (item.ext === 'pdf') {
    const emb = el('embed');
    emb.type = 'application/pdf';
    emb.src = itemUrl(item, itemFileName(item));
    emb.style.cssText = 'width:100%;height:100%;border-radius:6px';
    stage.appendChild(emb);
  } else if (isImage(item)) {
    const img = el('img');
    // 优先原图；解码失败（tif/psd 等）回退缩略图
    img.src = RENDERABLE_IMG_EXTS.has(item.ext)
      ? itemUrl(item, itemFileName(item))
      : itemUrl(item, 'thumbnail.png');
    img.onerror = () => {
      if (img.src.includes('thumbnail.png')) return;
      img.onerror = () => { stage.innerHTML = '<div style="color:var(--text-dim)">无法解码此格式</div>'; };
      img.src = itemUrl(item, 'thumbnail.png');
    };
    const applyT = () => { img.style.transform = `translate(${pvPanX}px,${pvPanY}px) scale(${pvZoom})`; };
    img.onload = applyT;
    img.onwheel = (e) => {
      e.preventDefault();
      pvZoom = Math.min(8, Math.max(0.2, pvZoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      applyT();
    };
    let drag = null;
    img.onmousedown = (e) => { drag = { x: e.clientX, y: e.clientY, px: pvPanX, py: pvPanY }; img.style.cursor = 'grabbing'; };
    window.addEventListener('mousemove', pvMouseMove = (e) => {
      if (drag) { pvPanX = drag.px + e.clientX - drag.x; pvPanY = drag.py + e.clientY - drag.y; applyT(); }
    });
    window.addEventListener('mouseup', () => { drag = null; img.style.cursor = 'grab'; });
    stage.appendChild(img);
  } else {
    stage.innerHTML = `<div style="text-align:center"><div style="font-size:60px">📄</div><p style="margin-top:10px;color:var(--text-dim)">该格式暂不支持预览</p><button class="tb-btn" style="margin:12px auto" id="pv-open">用系统默认程序打开</button></div>`;
    $('#pv-open', stage).onclick = () => api.shell.open(item.id);
  }
  const prev = el('button', 'pv-nav prev', '‹');
  const next = el('button', 'pv-nav next', '›');
  prev.onclick = () => previewStep(-1);
  next.onclick = () => previewStep(1);
  stage.appendChild(prev); stage.appendChild(next);
  pv.appendChild(stage);

  const bottom = el('div', 'pv-bottom');
  const star = el('span', 'pv-star' + (item.star ? ' on' : ''), '⭐');
  star.title = '加星标';
  star.onclick = async () => { item.star = !item.star; await api.items.update(item.id, { star: item.star }); renderPreview(); renderGrid(); };
  bottom.appendChild(star);
  const stars = el('span', 'stars');
  for (let i = 1; i <= 5; i++) {
    const s = el('button', i <= (item.rating || 0) ? 'on' : '', '★');
    s.onclick = async () => {
      const nr = i === item.rating ? 0 : i;
      await api.items.update(item.id, { rating: nr });
      item.rating = nr; renderPreview();
    };
    stars.appendChild(s);
  }
  bottom.appendChild(stars);
  const slide = el('button', '', '▶ 幻灯片');
  slide.id = 'pv-slide';
  slide.style.cssText = 'height:26px;padding:0 10px;border-radius:13px;background:var(--bg-hover);color:var(--text-dim);font-size:11.5px';
  slide.onclick = toggleSlideshow;
  bottom.appendChild(slide);
  if ((item.tags || []).length) {
    const tags = el('span', 'pv-tags');
    for (const t of item.tags) tags.appendChild(el('span', 'tag-chip', esc(t)));
    bottom.appendChild(tags);
  }
  pv.appendChild(bottom);
}
let pvMouseMove = null;

// ================= 菜单 =================
function showMenu(x, y, entries) {
  const layer = $('#menu-layer');
  layer.innerHTML = '';
  layer.classList.remove('hidden');
  const menu = el('div', 'menu');
  for (const e of entries) {
    if (e.sep) { menu.appendChild(el('div', 'sep')); continue; }
    const mi = el('div', 'mi' + (e.danger ? ' danger' : '') + (e.disabled ? ' disabled' : ''));
    mi.innerHTML = `${e.label}${e.shortcut ? `<span class="sc">${e.shortcut}</span>` : '<span class="arrow">›</span>'}`;
    if (e.action) mi.onclick = () => { hideMenu(); e.action(); };
    if (e.sub) {
      mi.onmouseenter = () => {
        $$('.menu .submenu').forEach(s => s.remove());
        const sub = el('div', 'menu submenu');
        const r = mi.getBoundingClientRect();
        sub.style.left = (r.right + 4) + 'px';
        sub.style.top = r.top + 'px';
        for (const se of e.sub) {
          if (se.sep) { sub.appendChild(el('div', 'sep')); continue; }
          const smi = el('div', 'mi' + (se.danger ? ' danger' : ''), se.label);
          smi.onclick = (ev) => { ev.stopPropagation(); hideMenu(); se.action(); };
          sub.appendChild(smi);
        }
        layer.appendChild(sub);
      };
    }
    menu.appendChild(mi);
  }
  layer.appendChild(menu);
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = Math.min(x, window.innerWidth - mw - 8) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - mh - 8) + 'px';
  layer.oncontextmenu = (e) => e.preventDefault();
}
function hideMenu() { const l = $('#menu-layer'); l.classList.add('hidden'); l.innerHTML = ''; }

function flattenedFolders() {
  const out = [];
  const walk = (list, d) => list.forEach(f => { out.push([f, d]); walk(f.children || [], d + 1); });
  walk(state.meta.folders, 0);
  return out;
}
const REVERSE_ENGINES = [
  ['Google Lens', (u) => 'https://lens.google.com/uploadbyurl?url=' + encodeURIComponent(u)],
  ['Bing 图片', (u) => 'https://www.bing.com/images/search?view=detailv2&iss=sbi&q=imgurl:' + encodeURIComponent(u)],
  ['百度识图', (u) => 'https://graph.baidu.com/details?isfromtusoupc=1&tn=pc&image_url=' + encodeURIComponent(u)],
  ['搜狗识图', (u) => 'https://pic.sogou.com/ris?query=' + encodeURIComponent(u)],
  ['TinEye', (u) => 'https://tineye.com/search?url=' + encodeURIComponent(u)],
  ['Yandex', (u) => 'https://yandex.com/images/search?rpt=imageview&url=' + encodeURIComponent(u)],
  ['SauceNAO', (u) => 'https://saucenao.com/search.php?url=' + encodeURIComponent(u)],
];
function reverseSearchSubs(item) {
  const direct = item.srcUrl || (/^https?:/.test(item.url || '') ? item.url : '');
  const subs = REVERSE_ENGINES.map(([name, make]) => ({
    label: name,
    action: () => {
      if (direct) api.shell.openExternal(make(direct));
      else { api.shell.openExternal(make('').split('?')[0]); toast('该图片没有来源链接，请在打开的页面手动上传'); }
    },
  }));
  subs.push({ sep: true });
  subs.push({ label: direct ? '来源：' + direct.slice(0, 40) + '…' : '来源：无（本地文件）', action: () => {} });
  return subs;
}

function showItemMenu(x, y, item) {
  const sel = [...state.selection];
  const inTrash = state.view.kind === 'trash';
  const folderSub = flattenedFolders().map(([f, d]) => ({
    label: `${'　'.repeat(d)}${esc(f.name)}`,
    action: () => addItemsToFolder(sel, f.id),
  }));
  const entries = [];
  if (inTrash) {
    entries.push({ label: '还原', action: async () => { await api.items.trash(sel, false); await reload(); } });
    entries.push({ label: '永久删除', danger: true, action: () => deleteForever(sel) });
    entries.push({ sep: true });
    entries.push({ label: '清空回收站', danger: true, action: async () => {
      const all = state.items.filter(i => i.isDeleted).map(i => i.id);
      if (all.length) deleteForever(all);
    } });
  } else {
    entries.push({ label: '打开预览', shortcut: '空格', action: () => openPreview(visible.findIndex(i => i.id === item.id)) });
    entries.push({ label: '用系统程序打开', action: () => api.shell.open(item.id) });
    entries.push({ label: '在资源管理器显示', action: () => api.shell.reveal(item.id) });
    entries.push({ sep: true });
    entries.push({ label: '添加到文件夹', sub: folderSub.length ? folderSub : [{ label: '（无文件夹）', action: () => {} }] });
    if (isImage(item)) entries.push({ label: '查找相似图像', action: () => findSimilar(item) });
    entries.push({ label: '以图搜图 (β)', sub: reverseSearchSubs(item) });
    if (state.view.kind === 'folder') {
      entries.push({ label: '从该文件夹移出', action: async () => {
        for (const id of sel) {
          const it = state.items.find(i => i.id === id);
          it.folders = (it.folders || []).filter(f => f !== state.view.id);
          await api.items.update(id, { folders: it.folders });
        }
        await reload();
      } });
    }
    entries.push({ sep: true });
    entries.push({ label: '评分', sub: [0, 1, 2, 3, 4, 5].map(n => ({ label: n ? '★'.repeat(n) : '清除评分', action: async () => {
      for (const id of sel) await api.items.update(id, { rating: n });
      await reload();
    } })) });
    entries.push({ label: '删除', danger: true, shortcut: 'Del', action: () => trashSelection() });
  }
  entries.push({ sep: true });
  entries.push({ label: '复制文件名', action: () => api.clipboard.writeText(itemFileName(item)) });
  entries.push({ label: '复制来源链接', disabled: !item.url, action: () => api.clipboard.writeText(item.url) });
  entries.push({ sep: true });
  if (sel.length > 1) {
    entries.push({ label: '批量重命名...', action: () => batchRenameDialog() });
  }
  entries.push({ label: '导出到文件夹...', action: async () => {
    const n = await api.items.exportTo(sel);
    toast(n ? `已导出 ${n} 个文件` : '已取消');
  } });
  showMenu(x, y, entries);
}

// 空白处右键
$('#grid-wrap').oncontextmenu = (e) => {
  if (e.target.closest('.item')) return;
  e.preventDefault();
  const entries = [
    { label: '导入文件...', action: importFilesDialog },
    { label: '导入文件夹...', action: importFolderDialog },
    { label: '从 URL / 网页导入...', action: () => openUrlModal() },
    { label: '粘贴导入', shortcut: 'Ctrl+V', action: pasteImport },
    { sep: true },
    { label: '新建文件夹', action: () => newFolderDialog(state.view.kind === 'folder' ? state.view.id : null) },
    { label: '刷新', shortcut: 'F5', action: () => reload() },
  ];
  showMenu(e.clientX, e.clientY, entries);
};
$('#menu-layer').onclick = hideMenu;

// ================= 动作 =================
async function addItemsToFolder(ids, folderId) {
  for (const id of ids) {
    const it = state.items.find(i => i.id === id);
    if (!it) continue;
    it.folders = [...new Set([...(it.folders || []), folderId])];
    await api.items.update(id, { folders: it.folders });
  }
  toast(`已添加 ${ids.length} 个项目到「${findFolder(folderId)?.name}」`);
  await reload();
}
async function addTagToItems(ids, tag) {
  for (const id of ids) {
    const it = state.items.find(i => i.id === id);
    if (!it) continue;
    it.tags = [...new Set([...(it.tags || []), tag])];
    await api.items.update(id, { tags: it.tags });
  }
  toast(`已为 ${ids.length} 个项目添加标签 #${tag}`);
  await reload();
}
async function trashSelection() {
  const ids = [...state.selection];
  if (!ids.length) return;
  await api.items.trash(ids, true);
  state.selection.clear();
  await reload();
  toast(`已移入回收站 ${ids.length} 个项目`);
}
async function deleteForever(ids) {
  if (!(await confirm2(`确定永久删除 ${ids.length} 个文件？\n此操作不可恢复！`))) return;
  await api.items.deletePermanent(ids);
  state.items = state.items.filter(i => !ids.includes(i.id));
  state.selection.clear();
  await reload();
  toast(`已永久删除 ${ids.length} 个项目`);
}
async function newFolderDialog(parentId) {
  const name = await prompt2('新建文件夹', '文件夹名称');
  if (name) { await api.folders.add(name, parentId); await reload(); }
}
async function renameFolderDialog(f) {
  const name = await prompt2('重命名文件夹', '新名称', f.name);
  if (name) { await api.folders.rename(f.id, name); await reload(); }
}
async function removeFolderConfirm(f) {
  if (await confirm2(`删除文件夹「${f.name}」？\n（其中的文件不会被删除，将变为未分类）`)) {
    await api.folders.remove(f.id);
    if (state.view.kind === 'folder' && state.view.id === f.id) setView({ kind: 'all', id: null, label: '全部' });
    else await reload();
  }
}

// 导入
async function importFilesDialog() {
  const paths = await api.dialog.pickFiles();
  if (!paths.length) return;
  await doImport(paths);
}
async function importFolderDialog() {
  const dir = await api.dialog.pickDirectory();
  if (!dir) return;
  await doImport([dir]); // 主进程会递归展开目录
}
async function importClipboard() {
  const folderIds = state.view.kind === 'folder' ? [state.view.id] : [];
  const created = await api.import.clipboard(folderIds);
  if (!created.length) { toast('剪贴板里没有图片'); return; }
  state.items.push(...created);
  await reload();
  postProcess(created);
  toast(`已导入剪贴板图片 ${created.length} 个`);
}
async function doImport(paths) {
  const folderIds = state.view.kind === 'folder' ? [state.view.id] : [];
  const created = await api.import.files(paths, folderIds);
  if (!created.length) { toast('没有可导入的文件'); return; }
  state.items.push(...created);
  state.view = { kind: 'all', id: null, label: '全部' }; // 确保能看到
  await reload();
  postProcess(created);
  toast(`已导入 ${created.length} 个文件`);
}

// 导入后处理：生成缩略图 + 调色板 + 尺寸
function postProcess(items) {
  for (const item of items) setTimeout(() => processItem(item), 50);
}
async function processItem(item) {
  try {
    if (CANVAS_IMG_EXTS.has(item.ext)) await genImageExtras(item);
    else if (item.ext === 'heic' || item.ext === 'heif') await genHeicExtras(item);
    else if (item.ext === 'pdf') await genPdfPreviewReady(item);
    else if (isVideo(item)) await genVideoExtras(item);
    else if (item.ext === 'svg') await genSvgDims(item);
  } catch (e) { console.warn('postProcess失败', item.name, e); }
}
// HEIC/HEIF：libheif wasm 解码（与 Eagle 同方案）→ 缩略图 + 调色板 + 尺寸
async function genHeicExtras(item) {
  if (typeof heic2any !== 'function') return;
  const resp = await fetch(itemUrl(item, itemFileName(item)));
  const blob = await resp.blob();
  const out = await heic2any({ blob, toType: 'image/png', quality: 0.9 });
  const pngBlob = Array.isArray(out) ? out[0] : out;
  const img = await loadImageEl(URL.createObjectURL(pngBlob));
  const patch = { width: img.naturalWidth, height: img.naturalHeight };
  const { canvas } = drawToCanvas(img, 640);
  const tBlob = await new Promise(r => canvas.toBlob(r, 'image/png'));
  await api.items.saveThumbnail(item.id, await tBlob.arrayBuffer());
  const { canvas: small } = drawToCanvas(img, 64);
  const palettes = extractPalette(small);
  if (palettes.length) patch.palettes = palettes;
  Object.assign(item, patch);
  await api.items.update(item.id, patch);
}
async function genPdfPreviewReady(item) { /* PDF 首页缩略图由主进程隐藏窗口生成 */ }
async function genSvgDims(item) {
  if (item.width && item.height) return;
  const img = await loadImageEl(itemUrl(item, itemFileName(item)));
  const patch = { width: img.naturalWidth || null, height: img.naturalHeight || null };
  Object.assign(item, patch);
  await api.items.update(item.id, patch);
}
function loadImageEl(url, useCrossOrigin = true) {
  return new Promise((res, rej) => {
    const img = new Image();
    // pigeon:// 对页面是跨源：canvas 采样必须走匿名 CORS，否则画布被污染、取色抛异常
    if (useCrossOrigin) img.crossOrigin = 'anonymous';
    img.onload = () => res(img);
    img.onerror = () => {
      if (useCrossOrigin) loadImageEl(url, false).then(res, rej);
      else rej(new Error('图片加载失败'));
    };
    img.src = url;
  });
}
async function genImageExtras(item) {
  // 已有缩略图则跳过
  let thumbOk = true;
  try { await loadImageEl(itemUrl(item, 'thumbnail.png')); } catch (e) { thumbOk = false; }
  const img = await loadImageEl(itemUrl(item, itemFileName(item)));
  const patch = { width: img.naturalWidth, height: img.naturalHeight };
  if (!thumbOk) {
    const { canvas, } = drawToCanvas(img, 640);
    const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
    await api.items.saveThumbnail(item.id, await blob.arrayBuffer());
  }
  if (!(item.palettes || []).length) {
    const { canvas } = drawToCanvas(img, 64);
    const palettes = extractPalette(canvas);
    if (palettes.length) patch.palettes = palettes;
  }
  Object.assign(item, patch);
  await api.items.update(item.id, patch);
}
function drawToCanvas(img, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return { canvas };
}
function extractPalette(canvas) {
  const ctx = canvas.getContext('2d');
  const { width: w, height: h } = canvas;
  const data = ctx.getImageData(0, 0, w, h).data;
  const buckets = new Map();
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
    if (a < 40) continue;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bk = buckets.get(key) || { r: 0, g: 0, b: 0, n: 0 };
    bk.r += r; bk.g += g; bk.b += b; bk.n++;
    buckets.set(key, bk);
  }
  const total = [...buckets.values()].reduce((s, b) => s + b.n, 0) || 1;
  const sorted = [...buckets.values()].sort((a, b) => b.n - a.n);
  const out = [];
  for (const bk of sorted) {
    const c = [Math.round(bk.r / bk.n), Math.round(bk.g / bk.n), Math.round(bk.b / bk.n)];
    // 跳过与已有颜色太接近的桶
    if (out.some(p => Math.abs(p.color[0] - c[0]) + Math.abs(p.color[1] - c[1]) + Math.abs(p.color[2] - c[2]) < 60)) continue;
    out.push({ color: c, ratio: Math.round(bk.n / total * 100) });
    if (out.length >= 5) break;
  }
  return out;
}
async function genVideoExtras(item) {
  return new Promise((res) => {
    const v = document.createElement('video');
    v.muted = true;
    v.crossOrigin = 'anonymous';
    v.src = itemUrl(item, itemFileName(item));
    v.preload = 'metadata';
    const finish = async (extra = {}) => {
      const patch = { width: v.videoWidth || item.width, height: v.videoHeight || item.height, duration: v.duration || item.duration, ...extra };
      Object.assign(item, patch);
      await api.items.update(item.id, patch);
      if (extra.thumbnail) { /* 已在 saveThumbnail 写过 */ }
      res();
    };
    let thumbSaved = false;
    v.onloadedmetadata = () => {
      try { v.currentTime = Math.min(0.5, (v.duration || 1) / 3); } catch (e) { }
    };
    v.onseeked = async () => {
      if (thumbSaved) return;
      thumbSaved = true;
      try {
        const canvas = document.createElement('canvas');
        canvas.width = v.videoWidth; canvas.height = v.videoHeight;
        canvas.getContext('2d').drawImage(v, 0, 0);
        // 有 Eagle 缩略图则不覆盖：先探测
        let has = true;
        try { await loadImageEl(itemUrl(item, 'thumbnail.png')); } catch (e) { has = false; }
        if (!has && canvas.width) {
          const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
          await api.items.saveThumbnail(item.id, await blob.arrayBuffer());
        }
      } catch (e) { }
      finish();
    };
    v.onerror = () => finish();
    setTimeout(() => res(), 15000); // 兜底
  });
}

// ================= 筛选 / 排序 =================
const SORT_LABELS = { btime: '添加时间', name: '文件名', size: '大小', rating: '评分', mtime: '修改时间' };
function renderFilterBar() {
  const bar = $('#filter-bar');
  const f = state.filters;
  const chips = [];
  for (const e of f.exts) chips.push(['格式', e.toUpperCase(), () => f.exts.delete(e)]);
  for (const t of f.tags) chips.push(['标签', t, () => f.tags.delete(t)]);
  if (f.minRating) chips.push(['评分', '≥ ' + f.minRating, () => f.minRating = 0]);
  if (f.shape) chips.push(['形状', { landscape: '横图', portrait: '竖图', square: '方形', pano: '全景' }[f.shape], () => f.shape = '']);
  if (f.days) chips.push(['日期', `近 ${f.days} 天`, () => f.days = 0]);
  if (f.color) {
    const name = (COLOR_SWATCHES.find(s => colorDist(s[1], f.color) < 10) || ['自定义', f.color])[0];
    chips.push(['颜色', name, () => f.color = null]);
  }
  if (state.search) chips.push(['搜索', state.search, () => { state.search = ''; $('#search').value = ''; }]);
  const active = chips.length > 0;
  bar.classList.toggle('hidden', !active);
  bar.innerHTML = '';
  for (const [k, v, off] of chips) {
    const c = el('span', 'chip', `<b>${k}</b> ${esc(v)}<span class="x">✕</span>`);
    $('.x', c).onclick = () => { off(); renderAll(); };
    bar.appendChild(c);
  }
  if (active) {
    const c = el('span', 'chip clear', '清空全部');
    c.onclick = () => { state.filters = { exts: new Set(), tags: new Set(), minRating: 0, shape: '', days: 0, color: null }; renderAll(); };
    bar.appendChild(c);
    const save = el('span', 'chip', '⚡ 保存为智能文件夹');
    save.style.background = 'rgba(245,185,66,.15)';
    save.style.color = 'var(--star)';
    save.onclick = async () => {
      const name = await prompt2('保存为智能文件夹', '名称', state.search || '新智能文件夹');
      if (!name) return;
      state.smartFolders = [...(state.smartFolders || []), {
        id: Math.random().toString(36).slice(2, 10),
        name,
        filter: {
          search: state.search, exts: [...f.exts], tags: [...f.tags],
          minRating: f.minRating, shape: f.shape, days: f.days, color: f.color,
        },
      }];
      state.smartFolders = await api.smartFolders.set(state.smartFolders);
      renderSidebar();
      toast(`已保存智能文件夹「${name}」`);
    };
    bar.appendChild(save);
  }
}
function showFilterPanel() {
  const f = state.filters;
  const entries = [];
  const exts = allExts().slice(0, 12);
  entries.push({ label: '── 格式 ──', disabled: true, action: () => {} });
  for (const [e, n] of exts) {
    const on = f.exts.has(e);
    entries.push({ label: (on ? '✓ ' : '　') + `${e.toUpperCase()}（${n}）`, action: () => { on ? f.exts.delete(e) : f.exts.add(e); renderAll(); } });
  }
  entries.push({ sep: true });
  entries.push({ label: '── 形状 ──', disabled: true, action: () => {} });
  for (const [k, label] of [['', '全部'], ['landscape', '横图'], ['portrait', '竖图'], ['square', '方形'], ['pano', '全景']]) {
    const on = f.shape === k;
    entries.push({ label: (on ? '✓ ' : '　') + label, action: () => { f.shape = k; renderAll(); } });
  }
  entries.push({ sep: true });
  entries.push({ label: '── 评分 ──', disabled: true, action: () => {} });
  for (let n = 0; n <= 5; n++) {
    const on = f.minRating === n;
    entries.push({ label: (on ? '✓ ' : '　') + (n ? `≥ ${n} 星` : '不限'), action: () => { f.minRating = n; renderAll(); } });
  }
  entries.push({ sep: true });
  entries.push({ label: '── 添加日期 ──', disabled: true, action: () => {} });
  for (const [d, label] of [[0, '不限'], [1, '今日'], [7, '近 7 天'], [30, '近 30 天']]) {
    const on = f.days === d;
    entries.push({ label: (on ? '✓ ' : '　') + label, action: () => { f.days = d; renderAll(); } });
  }
  entries.push({ sep: true });
  entries.push({ label: '── 颜色 ──', disabled: true, action: () => {} });
  for (const [name, rgb] of COLOR_SWATCHES) {
    const on = f.color && colorDist(rgb, f.color) < 10;
    entries.push({ label: (on ? '✓ ' : '　') + name, action: () => { f.color = on ? null : rgb; renderAll(); } });
  }
  const tags = allTags().slice(0, 15);
  if (tags.length) {
    entries.push({ sep: true });
    entries.push({ label: '── 标签 ──', disabled: true, action: () => {} });
    for (const [t, n] of tags) {
      const on = f.tags.has(t);
      entries.push({ label: (on ? '✓ ' : '　') + `${t}（${n}）`, action: () => { on ? f.tags.delete(t) : f.tags.add(t); renderAll(); } });
    }
  }
  // 过滤掉 disabled 的说明行单独渲染
  const r = $('#btn-filter').getBoundingClientRect();
  showMenu(r.left, r.bottom + 6, entries.map(e => ({ ...e, label: e.disabled ? `<span style="color:var(--text-faint);font-size:11px">${e.label}</span>` : e.label })));
}
function showSortPanel() {
  const entries = [];
  for (const [k, label] of Object.entries(SORT_LABELS)) {
    const on = state.sort.key === k;
    entries.push({ label: (on ? (state.sort.dir === 1 ? '↑ ' : '↓ ') : '　') + label, action: () => {
      if (state.sort.key === k) state.sort.dir *= -1;
      else state.sort = { key: k, dir: k === 'name' ? 1 : -1 };
      $('#sort-label').textContent = SORT_LABELS[state.sort.key];
      renderGrid(); renderFilterBar();
    } });
  }
  const r = $('#btn-sort').getBoundingClientRect();
  showMenu(r.left, r.bottom + 6, entries);
}
async function refreshAiChipVisibility() {
  try {
    const cfg = await api.getConfig();
    const on = cfg.settings && cfg.settings.ai && cfg.settings.ai.enabled && cfg.settings.ai.semanticSearch;
    $('#btn-ai-chip').classList.toggle('hidden', !on);
  } catch (e) {}
}
async function runSemanticSearch(q) {
  $('#search').parentElement.classList.add('busy');
  try {
    const ranked = await api.ai.search(q, 100);
    state.aiResults = { query: q, ids: ranked.map(r => r.id), scores: Object.fromEntries(ranked.map(r => [r.id, r.score])) };
    state.selection.clear();
    renderGrid(); renderInspector(); renderStatus();
  } catch (e) {
    toast('语义搜索失败：' + e.message);
  }
}

function showImportPanel() {
  const entries = [
    { label: '导入文件...', action: importFilesDialog },
    { label: '导入文件夹...', action: importFolderDialog },
    { label: '从 URL / 网页导入...', action: () => openUrlModal() },
    { label: '粘贴剪贴板图片 / 链接', shortcut: 'Ctrl+V', action: pasteImport },
  ];
  const r = $('#btn-import').getBoundingClientRect();
  showMenu(r.left, r.bottom + 6, entries);
}

// ================= 提示 =================
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2200);
}
// 简易对话框（替代 prompt/confirm，Electron 禁用原生弹窗）
function prompt2(title, placeholder, value = '') {
  return new Promise((res) => {
    const layer = el('div');
    layer.style.cssText = 'position:fixed;inset:0;z-index:500;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center';
    const box = el('div');
    box.style.cssText = 'background:#2A2C31;border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:18px;width:320px;box-shadow:0 12px 40px rgba(0,0,0,.5)';
    box.innerHTML = `<div style="font-weight:600;margin-bottom:10px">${esc(title)}</div>`;
    const input = el('input');
    input.value = value;
    input.placeholder = placeholder || '';
    input.style.cssText = 'width:100%;background:var(--bg-hover);border:1px solid transparent;border-radius:6px;padding:7px 9px;font-size:13px;outline:none;color:var(--text)';
    input.onfocus = () => input.style.borderColor = 'var(--accent)';
    const btns = el('div');
    btns.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:14px';
    const cancel = el('button', null, '取消');
    const ok = el('button', null, '确定');
    for (const b of [cancel, ok]) {
      b.style.cssText = 'height:30px;padding:0 16px;border-radius:6px;font-size:12.5px;background:var(--bg-hover);color:var(--text)';
    }
    ok.style.background = 'var(--accent)'; ok.style.color = '#fff';
    const done = (v) => { layer.remove(); res(v); };
    ok.onclick = () => done(input.value.trim() || null);
    cancel.onclick = () => done(null);
    input.onkeydown = (e) => {
      if (e.key === 'Enter') done(input.value.trim() || null);
      if (e.key === 'Escape') done(null);
    };
    btns.append(cancel, ok);
    box.append(input, btns);
    layer.appendChild(box);
    layer.onclick = (e) => { if (e.target === layer) done(null); };
    document.body.appendChild(layer);
    input.focus(); input.select();
  });
}
function confirm2(msg) {
  return new Promise((res) => {
    const layer = el('div');
    layer.style.cssText = 'position:fixed;inset:0;z-index:500;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center';
    const box = el('div');
    box.style.cssText = 'background:#2A2C31;border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:18px;width:340px;box-shadow:0 12px 40px rgba(0,0,0,.5);white-space:pre-line;font-size:13px;line-height:1.6';
    box.textContent = msg;
    const btns = el('div');
    btns.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:14px';
    const cancel = el('button', null, '取消');
    const ok = el('button', null, '确定');
    for (const b of [cancel, ok]) b.style.cssText = 'height:30px;padding:0 16px;border-radius:6px;font-size:12.5px;background:var(--bg-hover);color:var(--text)';
    ok.style.background = 'var(--danger)'; ok.style.color = '#fff';
    const done = (v) => { layer.remove(); res(v); };
    ok.onclick = () => done(true);
    cancel.onclick = () => done(false);
    btns.append(cancel, ok);
    box.appendChild(btns);
    layer.appendChild(box);
    layer.onclick = (e) => { if (e.target === layer) done(false); };
    document.body.appendChild(layer);
  });
}

// ================= 渲染总入口 =================
function renderAll() {
  renderSidebar();
  renderGrid();
  renderInspector();
  renderFilterBar();
  renderStatus();
}
function backfillMissingData() {
  // 存量修补：无调色板/无尺寸的图片走一遍后处理（幂等）
  setTimeout(() => {
    const targets = state.items.filter(i => !i.isDeleted && CANVAS_IMG_EXTS.has(i.ext) && (!(i.palettes || []).length || !i.width));
    targets.forEach((it, i) => setTimeout(() => processItem(it), i * 40));
  }, 2500);
}

async function reload(keepSelection = false) {
  if (!state.root) return;
  state.items = await api.items.list();
  state.meta = await api.library.meta();
  state.smartFolders = state.meta.smartFolders || [];
  if (!keepSelection) state.selection.clear();
  renderAll();
}

// ================= 事件绑定 =================
const api = window.pigeon;

function bindToolbar() {
  $('#search').addEventListener('input', debounce(async (e) => {
    state.search = e.target.value;
    if (state.aiMode && state.search.trim()) {
      await runSemanticSearch(state.search.trim());
      return;
    }
    state.aiResults = null;
    renderGrid(); renderFilterBar();
  }, 200));
  $('#search-clear').onclick = () => { $('#search').value = ''; state.search = ''; renderGrid(); renderFilterBar(); };
  $('#btn-filter').onclick = showFilterPanel;
  $('#btn-sort').onclick = showSortPanel;
  $('#btn-import').onclick = showImportPanel;
  $('#btn-inspector').onclick = () => { state.inspectorOpen = !state.inspectorOpen; renderInspector(); relayout(); };
  $('#btn-browser').onclick = () => {
    if ($('#browser-panel').classList.contains('hidden')) openBrowser('https://www.bing.com/images');
    else closeBrowser();
  };
  $('#btn-gray').onclick = () => {
    document.body.classList.toggle('gray');
    $('#btn-gray').classList.toggle('on');
  };
  $('#btn-dup').onclick = openDupModal;
  $('#btn-settings').onclick = () => openSettings();
  $('#btn-ai-chip').onclick = async () => {
    state.aiMode = !state.aiMode;
    $('#btn-ai-chip').classList.toggle('on', state.aiMode);
    state.aiResults = null;
    renderGrid(); renderFilterBar(); renderViewTitle();
    if (state.aiMode && state.search.trim()) runSemanticSearch(state.search.trim());
  };
  refreshAiChipVisibility();
  $('#library-name').onclick = showLibraryMenu;
  // 浏览器面板
  const wv = $('#br-webview');
  $('#br-back').onclick = () => { try { wv.goBack(); } catch (e) {} };
  $('#br-fwd').onclick = () => { try { wv.goForward(); } catch (e) {} };
  $('#br-reload').onclick = () => { try { wv.reload(); } catch (e) {} };
  $('#br-close').onclick = closeBrowser;
  $('#br-external').onclick = () => { const u = $('#br-url').value.trim(); if (u) api.shell.openExternal(u); };
  $('#br-url').onkeydown = (e) => {
    if (e.key === 'Enter') {
      let u = $('#br-url').value.trim();
      if (u && !/^https?:\/\//i.test(u)) u = 'https://' + u;
      if (u) { try { wv.loadURL(u); } catch (err) {} }
    }
  };
  // URL 导入弹窗
  $('#url-fetch').onclick = fetchAndShowImages;
  $('#url-cancel').onclick = closeUrlModal;
  $('#url-import').onclick = importSelectedImages;
  $('#url-input').onkeydown = (e) => { if (e.key === 'Enter') fetchAndShowImages(); };
  $('#url-grid').onclick = (e) => { const c = e.target.closest('.url-cell'); if (c) updateUrlImportBtn(); };
  // 查重弹窗
  $('#dup-close').onclick = closeDupModal;
  $('#dup-merge').onclick = mergeDupGroups;
  $('#dup-modal').onclick = (e) => { if (e.target.id === 'dup-modal') closeDupModal(); };
  $('#url-modal').onclick = (e) => { if (e.target.id === 'url-modal') closeUrlModal(); };
  $$('#view-group button').forEach(b => {
    b.classList.toggle('on', b.dataset.layout === state.layout);
    b.onclick = () => {
      state.layout = b.dataset.layout;
      localStorage.setItem('pigeon.layout', state.layout);
      $$('#view-group button').forEach(x => x.classList.toggle('on', x === b));
      renderGrid();
    };
  });
  const zoom = $('#zoom');
  zoom.value = state.zoom;
  zoom.addEventListener('input', debounce((e) => {
    state.zoom = +e.target.value;
    localStorage.setItem('pigeon.zoom', state.zoom);
    layoutGrid();
  }, 40));
  // 窗口控制
  $('#win-min').onclick = () => api.window.min();
  $('#win-max').onclick = () => api.window.max();
  $('#win-close').onclick = () => api.window.close();
  api.window.onMaximized((m) => $('#win-max').classList.toggle('on', m));
}

function bindGlobal() {
  // 空白处点击取消选择
  $('#grid-wrap').onclick = (e) => {
    if (e.target.id === 'grid-wrap' || e.target.id === 'grid') {
      state.selection.clear();
      $$('#grid .item.selected').forEach(x => x.classList.remove('selected'));
      renderInspector(); renderStatus();
    }
  };
  // 预览：点击背景关闭
  $('#preview').addEventListener('mousedown', (e) => {
    if (e.target.id === 'preview') closePreview();
  });
  // 主进程推送的导入（自动导入 / 截图 / 全局快捷收藏）
  api.onImported((items) => {
    if (!items || !items.length) return;
    state.items.push(...items);
    reload();
    postProcess(items);
    toast(`已收入 ${items.length} 个文件`);
  });
  new ResizeObserver(relayout).observe($('#grid-wrap'));

  // 键盘
  window.addEventListener('keydown', (e) => {
    const inInput = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);
    if (e.key === 'Escape') {
      if (!$('#settings-panel').classList.contains('hidden')) closeSettings();
      else if (!$('#url-modal').classList.contains('hidden')) closeUrlModal();
      else if (!$('#dup-modal').classList.contains('hidden')) closeDupModal();
      else if (!$('#browser-panel').classList.contains('hidden')) closeBrowser();
      else if (!$('#preview').classList.contains('hidden')) closePreview();
      else if (!$('#menu-layer').classList.contains('hidden')) hideMenu();
      else if (inInput) document.activeElement.blur();
      else { state.selection.clear(); renderGrid(); renderInspector(); renderStatus(); }
      return;
    }
    if (!$('#url-modal').classList.contains('hidden') || !$('#dup-modal').classList.contains('hidden')) return;
    if (!$('#browser-panel').classList.contains('hidden')) {
      if (e.ctrlKey && e.key === 'l') { e.preventDefault(); $('#br-url').focus(); $('#br-url').select(); }
      return;
    }
    if (inInput) return;
    if (!$('#preview').classList.contains('hidden')) {
      if (e.key === 'ArrowLeft') previewStep(-1);
      if (e.key === 'ArrowRight') previewStep(1);
      if (e.key === ' ') { e.preventDefault(); closePreview(); }
      return;
    }
    if (e.ctrlKey && e.key === 'f') { e.preventDefault(); $('#search').focus(); return; }
    if (e.ctrlKey && e.key === 'a') {
      e.preventDefault();
      visible.forEach(i => state.selection.add(i.id));
      renderGrid(); renderInspector(); renderStatus();
      return;
    }
    if (e.ctrlKey && e.key === 'v') { pasteImport(); return; }
    if (e.ctrlKey && e.key === 'u') { e.preventDefault(); openUrlModal(); return; }
    if (e.ctrlKey && e.key === 't') {
      e.preventDefault();
      const input = $('.tag-add');
      if (input) { input.focus(); }
      return;
    }
    if (e.key === 'Delete') { if (state.selection.size) trashSelection(); return; }
    if (e.key === 'F2' && state.selection.size === 1) {
      const input = $('.insp-name');
      if (input) { input.focus(); input.select(); }
      return;
    }
    if (e.key === ' ') {
      e.preventDefault();
      if (state.selection.size === 1) {
        const idx = visible.findIndex(i => i.id === [...state.selection][0]);
        if (idx >= 0) openPreview(idx);
      }
      return;
    }
    if (e.key === 'F5') { reload(); return; }
    if (e.altKey && ['1', '2', '3'].includes(e.key)) {
      const layouts = ['waterfall', 'grid', 'list'];
      state.layout = layouts[+e.key - 1];
      localStorage.setItem('pigeon.layout', state.layout);
      $$('#view-group button').forEach(x => x.classList.toggle('on', x.dataset.layout === state.layout));
      renderGrid();
    }
  });

  // 外部文件拖放导入
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if ([...e.dataTransfer.types].includes('Files')) {
      dragDepth++;
      $('#drop-overlay').classList.remove('hidden');
    }
  });
  window.addEventListener('dragleave', () => {
    dragDepth--;
    if (dragDepth <= 0) $('#drop-overlay').classList.add('hidden');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('#drop-overlay').classList.add('hidden');
    const files = [...e.dataTransfer.files];
    const uri = e.dataTransfer.getData('text/uri-list');
    const html = e.dataTransfer.getData('text/html');
    // 先同步读取所有拖入文件的字节（网页拖来的图片是虚拟文件，没有磁盘路径）
    const reads = files.map(f => f.arrayBuffer().then(b => ({ file: f, buf: b })).catch(() => null));
    const loaded = (await Promise.all(reads)).filter(Boolean);
    const folderIds = currentFolderIds();
    const paths = [];
    const created = [];
    const failed = [];
    for (const { file: f, buf } of loaded) {
      let p = '';
      try { p = api.getPathForFile(f) || ''; } catch (err) {}
      if (p) { paths.push(p); continue; } // 本地文件走路径导入
      try {
        created.push(await api.import.buffer(f.name, f.type, buf, folderIds));
      } catch (err) { failed.push(f.name || '未知文件'); }
    }
    if (paths.length) await doImport(paths);
    if (created.length) {
      state.items.push(...created);
      await reload();
      postProcess(created);
      toast(`已导入 ${created.length} 个文件` + (failed.length ? `，${failed.length} 个失败` : ''));
      return;
    }
    if (failed.length) { toast(`导入失败：${failed[0]}`); return; }
    if (paths.length) return;
    // 虚拟文件为零时：从网页拖来的图片按 URI 列表 / HTML 片段处理
    if (uri) {
      const url = uri.split('\n').map(s => s.trim()).find(s => /^https?:\/\//i.test(s) && !s.startsWith('#'));
      if (url) { urlImportFlow(url); return; }
    }
    if (html) {
      const src = extractImgFromHtml(html);
      if (src && /^https?:/i.test(src)) { urlImportFlow(src); return; }
    }
  });

  // 网格滚动条触底不用管；窗口尺寸变化重排
  window.addEventListener('resize', relayout);
}

// ================= 欢迎页 =================
async function renderWelcome() {
  const w = $('#welcome');
  w.classList.remove('hidden');
  w.innerHTML = `
    <div class="welcome-card">
      <img class="pigeon-img" src="pigeon-icon.png">
      <h1>Pigeon</h1>
      <p>一个为自己打造的素材收集与管理工具。兼容 Eagle 资料库格式，可以直接导入现有的 .library 继续使用。</p>
      <div class="btns">
        <button class="primary" id="wl-import">导入 Eagle 资料库（.library）</button>
        <button id="wl-open">打开已有资料库（.pigeon）</button>
        <button id="wl-create">新建资料库（自动存放在程序目录）</button>
      </div>
      <div class="status" id="wl-status"></div>
    </div>`;
  const status = (t) => $('#wl-status').textContent = t;
  $('#wl-import').onclick = async () => {
    const dir = await api.dialog.pickDirectory();
    if (!dir) return;
    try {
      status('导入中，请稍候（复制到便携版 data/libraries 或 Documents，不影响原库）...');
      const { root } = await api.library.importEagle(dir, null, null);
      status('完成：' + root);
      await openLibrary(root);
    } catch (e) {
      status('失败：' + e.message);
    }
  };
  $('#wl-open').onclick = async () => {
    const dir = await api.dialog.pickDirectory();
    if (!dir) return;
    try { await openLibrary(dir); } catch (e) { status('打开失败：' + e.message); }
  };
  $('#wl-create').onclick = async () => {
    try {
      const r = await api.library.create('我的资料库');
      await openLibrary(r.root);
    } catch (e) { console.error('[pigeon] wl-create失败', e); status('失败：' + e.message); }
  };
}
async function openLibrary(root) {
  const meta = await api.library.open(root);
  state.root = root;
  state.meta = meta;
  $('#library-name').textContent = meta.name || root.split(/[\\/]/).pop().replace(/\.pigeon$/, '');
  $('#welcome').classList.add('hidden');
  await reload();
  backfillMissingData();
}

// ================= 智能文件夹 =================
async function applySmartFolder(sf) {
  state.view = { kind: 'all', id: null, label: sf.name };
  state.search = sf.filter.search || '';
  $('#search').value = state.search;
  state.filters = {
    exts: new Set(sf.filter.exts || []),
    tags: new Set(sf.filter.tags || []),
    minRating: sf.filter.minRating || 0,
    shape: sf.filter.shape || '',
    days: sf.filter.days || 0,
    color: sf.filter.color || null,
  };
  state.selection.clear();
  renderAll();
}

// ================= pHash / 相似 =================
function grayFromCanvas(canvas) {
  const ctx = canvas.getContext('2d');
  const { width: w, height: h } = canvas;
  const d = ctx.getImageData(0, 0, w, h).data;
  const g = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  return { g, w, h };
}
function dct2(matrix, w, h) {
  // 二维 DCT-II（行/列分离）
  const tmp = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let u = 0; u < w; u++) {
      let s = 0;
      for (let x = 0; x < w; x++) s += matrix[y * w + x] * Math.cos((2 * x + 1) * u * Math.PI / (2 * w));
      tmp[y * w + u] = s;
    }
  }
  const out = new Float64Array(w * h);
  for (let u = 0; u < w; u++) {
    for (let v = 0; v < h; v++) {
      let s = 0;
      for (let y = 0; y < h; y++) s += tmp[y * w + u] * Math.cos((2 * y + 1) * v * Math.PI / (2 * h));
      out[v * w + u] = s;
    }
  }
  return out;
}
async function ensurePhash(item) {
  if (item.phash) return item.phash;
  if (!isImage(item) || item.ext === 'svg') return null;
  try {
    let img;
    try { img = await loadImageEl(itemUrl(item, 'thumbnail.png')); }
    catch (e) { img = await loadImageEl(itemUrl(item, itemFileName(item))); }
    const N = 32;
    const canvas = document.createElement('canvas');
    canvas.width = N; canvas.height = N;
    canvas.getContext('2d').drawImage(img, 0, 0, N, N);
    const { g } = grayFromCanvas(canvas);
    const d = dct2(g, N, N);
    const low = [];
    for (let v = 1; v <= 8; v++) for (let u = 1; u <= 8; u++) low.push(d[v * N + u]);
    const median = low.slice().sort((a, b) => a - b)[31];
    let bits = 0n;
    for (let i = 0; i < 64; i++) if (low[i] > median) bits |= (1n << BigInt(i));
    const hex = bits.toString(16).padStart(16, '0');
    item.phash = hex;
    api.items.update(item.id, { phash: hex }).catch(() => {});
    return hex;
  } catch (e) { return null; }
}
async function ensureAllPhashes(onProgress) {
  const targets = state.items.filter(i => !i.isDeleted && isImage(i) && !i.phash);
  let done = 0;
  for (const it of targets) {
    await ensurePhash(it);
    done++;
    if (onProgress && done % 10 === 0) onProgress(done, targets.length);
  }
}
async function findSimilar(item) {
  toast('正在计算感知哈希...');
  await ensurePhash(item);
  await ensureAllPhashes((d, t) => { if (d % 50 === 0) toast(`正在计算感知哈希 ${d}/${t}`); });
  state.selection.clear();
  setView({ kind: 'similar', id: item.id, label: '相似于 ' + item.name });
}

// ================= 重复扫描 =================
function openDupModal() {
  $('#dup-modal').classList.remove('hidden');
  $('#dup-groups').innerHTML = '';
  $('#dup-status').textContent = '';
  $('#dup-actions').classList.add('hidden');
  $('#dup-body').innerHTML = `
    <div class="dup-modes">
      <button id="dup-mode-same"><b>扫描「相同」文件</b><span>MD5 校验，找出内容完全一致的文件</span></button>
      <button id="dup-mode-similar"><b>扫描「相似」图像</b><span>感知哈希 pHash，找出看起来相似的图片</span></button>
    </div>`;
  $('#dup-mode-same').onclick = () => runDupScan('same');
  $('#dup-mode-similar').onclick = () => runDupScan('similar');
}
function closeDupModal() { $('#dup-modal').classList.add('hidden'); }

let dupGroups = [];
async function runDupScan(mode) {
  const status = $('#dup-status');
  const groupsBox = $('#dup-groups');
  groupsBox.innerHTML = '';
  dupGroups = [];
  if (mode === 'same') {
    status.textContent = '正在计算 MD5...';
    const hashes = await api.scan.md5All();
    const byHash = new Map();
    for (const it of state.items) {
      if (it.isDeleted || !hashes[it.id]) continue;
      if (!byHash.has(hashes[it.id])) byHash.set(hashes[it.id], []);
      byHash.get(hashes[it.id]).push(it);
    }
    dupGroups = [...byHash.entries()].filter(([, g]) => g.length > 1).map(([h, g]) => g);
  } else {
    status.textContent = '正在计算感知哈希...';
    await ensureAllPhashes((d, t) => { status.textContent = `正在计算感知哈希 ${d}/${t}`; });
    const imgs = state.items.filter(i => !i.isDeleted && i.phash);
    const used = new Set();
    for (let i = 0; i < imgs.length; i++) {
      if (used.has(imgs[i].id)) continue;
      const group = [imgs[i]];
      used.add(imgs[i].id);
      for (let j = i + 1; j < imgs.length; j++) {
        if (used.has(imgs[j].id)) continue;
        if (hamming(imgs[i].phash, imgs[j].phash) < 10) { group.push(imgs[j]); used.add(imgs[j].id); }
      }
      if (group.length > 1) dupGroups.push(group);
    }
  }
  status.textContent = dupGroups.length
    ? `发现 ${dupGroups.length} 组重复，共 ${dupGroups.reduce((s, g) => s + g.length, 0)} 个文件。每组勾选保留项（默认保留最优），其余将合并元数据后移入回收站。`
    : '未发现重复文件。';
  if (!dupGroups.length) return;
  // 渲染分组，默认保留最优（像素面积最大）
  for (const g of dupGroups) {
    g.sort((a, b) => (b.width * b.height || 0) - (a.width * a.height || 0) || (b.size || 0) - (a.size || 0));
    g[0].__keep = true;
    for (let k = 1; k < g.length; k++) g[k].__keep = false;
  }
  renderDupGroups();
  $('#dup-actions').classList.remove('hidden');
}
function renderDupGroups() {
  const box = $('#dup-groups');
  box.innerHTML = '';
  for (const g of dupGroups) {
    const div = el('div', 'dup-group');
    const waste = g.filter(i => !i.__keep).reduce((s, i) => s + (i.size || 0), 0);
    div.appendChild(el('div', 'dg-head', `<b>${g.length} 个文件</b> · 合并可节省 ${fmtSize(waste)} · 点击缩略图切换保留项`));
    const row = el('div', 'dg-row');
    for (const it of g) {
      const t = el('div', 'dup-thumb ' + (it.__keep ? 'keep' : 'trash'));
      const img = el('img');
      img.src = itemUrl(it, 'thumbnail.png');
      img.onerror = () => { img.remove(); };
      t.appendChild(img);
      t.appendChild(el('span', 'dg-tag', it.__keep ? '保留' : '移除'));
      t.appendChild(el('div', 'dg-name', `${esc(it.name)} · ${it.width ? it.width + '×' + it.height : fmtSize(it.size)}`));
      t.onclick = () => {
        g.forEach(x => x.__keep = false);
        it.__keep = true;
        renderDupGroups();
      };
      row.appendChild(t);
    }
    div.appendChild(row);
    box.appendChild(div);
  }
}
async function mergeDupGroups() {
  const toTrash = [];
  let merged = 0;
  for (const g of dupGroups) {
    const keep = g.find(i => i.__keep);
    const rest = g.filter(i => !i.__keep);
    if (!keep || !rest.length) continue;
    // 合并元数据：并集标签/文件夹、最高评分、拼接注释
    const patch = {};
    patch.tags = [...new Set(g.flatMap(i => i.tags || []))];
    patch.folders = [...new Set(g.flatMap(i => i.folders || []))];
    patch.rating = Math.max(...g.map(i => i.rating || 0));
    patch.star = g.some(i => i.star);
    const notes = g.map(i => i.annotation).filter(Boolean);
    patch.annotation = notes.length > 1 ? notes.join('\n---\n') : (notes[0] || '');
    await api.items.update(keep.id, patch);
    Object.assign(keep, patch);
    toTrash.push(...rest.map(i => i.id));
    merged++;
  }
  if (toTrash.length) {
    await api.items.trash(toTrash, true);
    for (const id of toTrash) { const it = state.items.find(i => i.id === id); if (it) it.isDeleted = true; }
  }
  closeDupModal();
  await reload();
  toast(`已合并 ${merged} 组，${toTrash.length} 个重复项移入回收站`);
}

// ================= URL 导入 =================
function openUrlModal(prefillUrl) {
  $('#url-modal').classList.remove('hidden');
  $('#url-grid').innerHTML = '';
  $('#url-status').textContent = '提示：也可以直接把网页图片拖进窗口，或 Ctrl+V 粘贴链接';
  $('#url-import').disabled = true;
  $('#url-import').textContent = '导入所选（0）';
  if (prefillUrl) {
    $('#url-input').value = prefillUrl;
    fetchAndShowImages();
  } else {
    setTimeout(() => $('#url-input').focus(), 50);
  }
}
function closeUrlModal() { $('#url-modal').classList.add('hidden'); }

let urlCandidates = [];
async function fetchAndShowImages() {
  const url = $('#url-input').value.trim();
  if (!/^https?:\/\//i.test(url)) { $('#url-status').textContent = '请输入 http(s):// 开头的链接'; return; }
  const status = $('#url-status');
  status.textContent = '正在打开页面并提取图片（约需几秒）...';
  $('#url-fetch').disabled = true;
  try {
    // 图片直链：直接导入
    if (/\.(jpe?g|png|gif|webp|avif|bmp|ico|svg|mp4)(\?|$)/i.test(url)) {
      status.textContent = '识别为图片直链，直接导入...';
      const r = await api.web.importFromUrl(url, url, currentFolderIds());
      if (r.ok) {
        state.items.push(r.item);
        await reload();
        postProcess([r.item]);
        closeUrlModal();
        toast(`已导入：${r.item.name}`);
      } else {
        status.textContent = '该链接返回的是网页，正在提取页面图片...';
      }
    }
    const data = await api.web.extractImages(url);
    urlCandidates = data.images || [];
    $('#url-grid').innerHTML = '';
    for (const src of urlCandidates) {
      const cell = el('div', 'url-cell sel');
      cell.dataset.src = src;
      const img = el('img');
      img.loading = 'lazy';
      img.src = src;
      img.onerror = () => cell.remove();
      cell.appendChild(img);
      cell.onclick = () => cell.classList.toggle('sel');
      $('#url-grid').appendChild(cell);
    }
    updateUrlImportBtn();
    status.textContent = `${data.title ? '「' + data.title + '」 · ' : ''}找到 ${$$('#url-grid .url-cell').length} 张图片，点击取消不需要的`;
  } catch (e) {
    status.textContent = '获取失败：' + e.message;
  } finally {
    $('#url-fetch').disabled = false;
  }
}
function updateUrlImportBtn() {
  const n = $$('#url-grid .url-cell.sel').length;
  const b = $('#url-import');
  b.textContent = `导入所选（${n}）`;
  b.disabled = !n;
}
async function importSelectedImages() {
  const sel = $$('#url-grid .url-cell.sel').map(c => c.dataset.src);
  const pageUrl = $('#url-input').value.trim();
  const status = $('#url-status');
  const btn = $('#url-import');
  btn.disabled = true;
  const created = [];
  const failures = [];
  for (let i = 0; i < sel.length; i++) {
    status.textContent = `下载中 ${i + 1}/${sel.length}...`;
    try {
      const r = await api.web.importFromUrl(sel[i], pageUrl, currentFolderIds());
      if (r.ok) created.push(r.item);
      else failures.push('网页地址');
    } catch (e) { failures.push(String(e.message).slice(0, 60)); }
  }
  if (created.length) {
    state.items.push(...created);
    await reload();
    postProcess(created);
  }
  closeUrlModal();
  if (created.length) toast(`已导入 ${created.length}/${sel.length} 张图片` + (failures.length ? `，${failures.length} 张失败` : ''));
  else toast(`导入失败：${failures[0] || '未知原因'}`);
}
function currentFolderIds() {
  return state.view.kind === 'folder' ? [state.view.id] : [];
}
async function urlImportFlow(url) {
  // 单个 URL：直链直接导入，网页则打开选择器
  try {
    if (/\.(jpe?g|png|gif|webp|avif|bmp|ico|svg|mp4)(\?|$)/i.test(url)) {
      const r = await api.web.importFromUrl(url, url, currentFolderIds());
      if (r.ok) {
        state.items.push(r.item);
        await reload();
        postProcess([r.item]);
        toast(`已导入：${r.item.name}`);
        return;
      }
    }
  } catch (e) { /* 落到选择器 */ }
  openUrlModal(url);
}
function extractImgFromHtml(html) {
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const img = doc.querySelector('img[src]');
    return img ? img.src : null;
  } catch (e) { return null; }
}
async function pasteImport() {
  const p = await api.clipboard.readPaste();
  if (p.hasImage) { importClipboard(); return; }
  const text = (p.text || '').trim();
  if (/^https?:\/\/\S+$/i.test(text)) { urlImportFlow(text); return; }
  const src = extractImgFromHtml(p.html || '');
  if (src && /^https?:/i.test(src)) { urlImportFlow(src); return; }
  toast('剪贴板里没有图片或链接');
}

// ================= 内置浏览器 =================
function openBrowser(url) {
  const panel = $('#browser-panel');
  panel.classList.remove('hidden');
  const wv = $('#br-webview');
  if (url) wv.loadURL(url).catch(() => {});
  if (!wv._bound) {
    wv._bound = true;
    wv.addEventListener('dom-ready', () => {
      $('#br-url').value = wv.getURL().startsWith('about:') ? '' : wv.getURL();
    });
    wv.addEventListener('did-start-loading', () => $('#br-loading').classList.add('on'));
    wv.addEventListener('did-stop-loading', () => {
      $('#br-loading').classList.remove('on');
      const u = wv.getURL();
      if (!u.startsWith('about:')) $('#br-url').value = u;
    });
    // 右键菜单：保存图片到 Pigeon
    wv.addEventListener('context-menu', (e, params) => {
      e.preventDefault();
      const entries = [];
      if (params.mediaType === 'image' && params.srcURL) {
        entries.push({ label: '⬇ 保存此图片到 Pigeon', action: async () => {
          const r = await api.web.importFromUrl(params.srcURL, params.pageURL, currentFolderIds());
          if (r.ok) {
            state.items.push(r.item);
            await reload();
            postProcess([r.item]);
            toast(`已导入：${r.item.name}`);
          } else toast('该地址不是图片');
        } });
        entries.push({ label: '复制图片链接', action: () => api.clipboard.writeText(params.srcURL) });
        entries.push({ sep: true });
      }
      if (params.linkURL) {
        entries.push({ label: '在新标签打开链接', action: () => wv.loadURL(params.linkURL).catch(() => {}) });
        entries.push({ label: '复制链接地址', action: () => api.clipboard.writeText(params.linkURL) });
      }
      entries.push({ label: '在系统浏览器打开此页', action: () => api.shell.openExternal(params.pageURL || wv.getURL()) });
      showMenu(params.x, params.y, entries);
    });
  }
}
function closeBrowser() {
  $('#browser-panel').classList.add('hidden');
}

// ================= 批量重命名 =================
function batchRenameDialog() {
  const ids = [...state.selection];
  if (ids.length < 2) { toast('请选择多个文件'); return; }
  const layer = el('div');
  layer.style.cssText = 'position:fixed;inset:0;z-index:500;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center';
  const box = el('div');
  box.style.cssText = 'background:#26282D;border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:18px;width:400px';
  box.innerHTML = `<div style="font-weight:600;margin-bottom:10px">批量重命名（${ids.length} 个文件）</div>
    <div style="font-size:11.5px;color:var(--text-faint);margin-bottom:8px">可用变量：{name} 原名 · {n} 序号 · {date} 今日日期</div>`;
  const input = el('input');
  input.value = '{name} (1)';
  input.style.cssText = 'width:100%;background:var(--bg-hover);border:1px solid transparent;border-radius:6px;padding:7px 9px;font-size:13px;outline:none;color:var(--text)';
  const preview = el('div');
  preview.style.cssText = 'font-size:11.5px;color:var(--text-dim);margin-top:8px;min-height:34px';
  const applyT = () => {
    const items = ids.map(id => state.items.find(i => i.id === id));
    const pat = input.value;
    const d = new Date();
    const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const mk = (it, n) => pat.replace(/\{name\}/g, it ? it.name : '').replace(/\{n\}/g, String(n)).replace(/\{date\}/g, date) + '.' + (it ? it.ext : '');
    preview.textContent = `预览：${esc(mk(items[0], 1))} → ${esc(mk(items[1], 2))}${ids.length > 2 ? ' ...' : ''}`;
  };
  input.oninput = applyT;
  applyT();
  const btns = el('div');
  btns.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:14px';
  const cancel = el('button', null, '取消');
  const ok = el('button', null, '应用');
  for (const b of [cancel, ok]) b.style.cssText = 'height:30px;padding:0 16px;border-radius:6px;font-size:12.5px;background:var(--bg-hover);color:var(--text)';
  ok.style.background = 'var(--accent)'; ok.style.color = '#fff';
  cancel.onclick = () => layer.remove();
  ok.onclick = async () => {
    const pat = input.value;
    const d = new Date();
    const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    let n = 1;
    for (const id of ids) {
      const it = state.items.find(i => i.id === id);
      if (!it) continue;
      const newName = pat.replace(/\{name\}/g, it.name).replace(/\{n\}/g, String(n++)).replace(/\{date\}/g, date);
      if (newName && newName !== it.name) {
        const r = await api.items.update(id, { name: newName });
        Object.assign(it, r);
      }
    }
    layer.remove();
    await reload(true);
    toast('批量重命名完成');
  };
  btns.append(cancel, ok);
  box.append(input, preview, btns);
  layer.appendChild(box);
  layer.onclick = (e) => { if (e.target === layer) layer.remove(); };
  document.body.appendChild(layer);
  input.focus(); input.select();
}

// ================= 多库切换 =================
async function showLibraryMenu() {
  const libs = await api.library.listKnown();
  const entries = libs.map(p => ({
    label: (p === state.root ? '✓ ' : '　') + p.split(/[\\/]/).filter(Boolean).pop(),
    action: () => openLibrary(p).catch(e => toast(e.message)),
  }));
  if (libs.length) entries.push({ sep: true });
  entries.push({ label: '打开其他资料库...', action: async () => {
    const dir = await api.dialog.pickDirectory();
    if (dir) { try { await openLibrary(dir); } catch (e) { toast(e.message); } }
  } });
  entries.push({ label: '导入 Eagle 资料库...', action: () => { closeBrowser(); renderWelcome(); } });
  entries.push({ sep: true });
  entries.push({ label: '导出当前视图为 CSV...', action: exportCsv });
  showMenu(60, 40, entries);
}
async function exportCsv() {
  const p = await api.library.exportCsv(state.selection.size ? [...state.selection] : null);
  if (p) toast('已导出：' + p);
}

// ================= 幻灯片 =================
let slideTimer = null;
function toggleSlideshow() {
  const btn = $('#pv-slide');
  if (slideTimer) {
    clearInterval(slideTimer);
    slideTimer = null;
    if (btn) btn.textContent = '▶ 幻灯片';
    return;
  }
  if (btn) btn.textContent = '⏸ 暂停';
  slideTimer = setInterval(() => {
    const next = (state.previewIndex + 1) % visible.length;
    previewStep(next - state.previewIndex);
  }, 3000);
}

// ================= 设置面板（β） =================
let customWallpaperUrl = '';
function applyWallpaper() {
  const wp = (settingsCache && settingsCache.wallpaper) || { enabled: false, mode: 'default', opacity: 0.45 };
  const on = !!wp.enabled;
  document.body.classList.toggle('wallpaper-on', on);
  const w = $('#wallpaper');
  w.style.opacity = wp.opacity != null ? wp.opacity : 0.45;
  if (!on) { w.classList.add('hidden'); return; }
  w.classList.remove('hidden');
  if (wp.mode === 'custom' && wp.customUrl) {
    w.style.backgroundImage = `url('${wp.customUrl}')`;
  } else {
    w.style.backgroundImage = "url('pigeon-wallpaper-default.png')";
  }
}

function openSettings() {
  const panel = $('#settings-panel');
  if (panel.classList.contains('hidden')) { panel.classList.remove('hidden'); renderSettings(); }
  else panel.classList.add('hidden');
}
function closeSettings() { $('#settings-panel').classList.add('hidden'); }

let settingsCache = null;
async function renderSettings() {
  settingsCache = await api.settings.get();
  applyWallpaper();
  const el2 = $('#settings-body');
  const ms = settingsCache.autoImport;
  el2.innerHTML = '<div class="set-back"><button id="set-back">← 返回</button></div>' + `
    <div class="set-section">
      <div class="set-head"><span class="set-title">自动导入</span><span class="beta-tag">β</span>
        <label class="switch"><input type="checkbox" id="set-ai-import" ${ms.enabled ? 'checked' : ''}><i></i></label>
      </div>
      <div class="set-note">监视以下文件夹，发现新文件自动收进当前资料库（默认第 1 个为系统下载目录）</div>
      ${ms.folders.map((f, i) => `
        <div class="set-folder">
          <span class="folder-idx">${i + 1}</span>
          <span class="folder-path" id="set-folder-${i}">${f ? esc(f) : '未设置'}</span>
          <button data-folder="${i}" class="pick">${f ? '更换' : '选择'}</button>
          <button data-folder="${i}" class="clear" ${f ? '' : 'disabled'}>清除</button>
        </div>`).join('')}
    </div>
    <div class="set-section">
      <div class="set-head"><span class="set-title">截图收集</span><span class="beta-tag">β</span>
        <label class="switch"><input type="checkbox" id="set-capture" ${settingsCache.capture.enabled ? 'checked' : ''}><i></i></label>
      </div>
      <div class="set-note">按 <b>${esc(settingsCache.capture.hotkey)}</b> 呼出截图，拖动框选后自动收入「未分类」。快捷键固定为 Ctrl+Alt+A。</div>
    </div>
    <div class="set-section">
      <div class="set-head"><span class="set-title">全局快捷键</span><span class="beta-tag">β</span>
        <label class="switch"><input type="checkbox" id="set-hotkey" ${settingsCache.globalHotkey.enabled ? 'checked' : ''}><i></i></label>
      </div>
      <div class="set-note">
        <b>${esc(settingsCache.globalHotkey.show)}</b> 全局显示 / 隐藏 Pigeon<br>
        <b>${esc(settingsCache.globalHotkey.paste)}</b> 在任何应用里按下，把剪贴板图片直接收进资料库
      </div>
    </div>
    <div class="set-section">
      <div class="set-head"><span class="set-title">外观 · 壁纸</span><span class="beta-tag">β</span>
        <label class="switch"><input type="checkbox" id="set-wallpaper" ${settingsCache.wallpaper.enabled ? 'checked' : ''}><i></i></label>
      </div>
      <div class="set-note">半透明壁纸铺底，为界面垫上一层底色。默认示例图为「水上由岐」。</div>
      <div class="mc-btns" style="margin:8px 0">
        <button id="wp-default">使用默认示例图</button>
        <button id="wp-custom">选择自定义图片...</button>
      </div>
      <div class="set-note">透明度：<input type="range" id="wp-opacity" min="0.15" max="0.95" step="0.05" value="${settingsCache.wallpaper.opacity != null ? settingsCache.wallpaper.opacity : 0.45}" style="width:160px;vertical-align:middle"> <span id="wp-opacity-val">${settingsCache.wallpaper.opacity != null ? settingsCache.wallpaper.opacity : 0.45}</span></div>
    </div>
    <div class="set-section">
      <div class="set-head"><span class="set-title">AI 本地识别（Chinese-CLIP RN50）</span><span class="beta-tag">β</span>
        <label class="switch"><input type="checkbox" id="set-ai" ${settingsCache.ai.enabled ? 'checked' : ''}><i></i></label>
      </div>
      <div class="set-note">中文图文对齐模型，用于<b>语义搜索</b>（用一句话搜图）与<b>自动打标</b>（导入时按相似度命中概念标签）。完全本地运行，无需联网。</div>
      <div class="model-card">
        <div class="mc-row"><span>模型</span><b>Chinese-CLIP RN50</b></div>
        <div class="mc-row"><span>体积</span>约 308 MB（Apache-2.0 开源许可）</div>
        <div class="mc-row"><span>状态</span><span id="model-status">检测中...</span></div>
        <div class="mc-row"><span>自动打标</span><label class="switch sm"><input type="checkbox" id="set-autotag" ${settingsCache.ai.autoTag ? 'checked' : ''}><i></i></label></div>
        <div class="mc-row"><span>语义搜索</span><label class="switch sm"><input type="checkbox" id="set-semsearch" ${settingsCache.ai.semanticSearch ? 'checked' : ''}><i></i></label></div>
        <div class="set-note" style="margin-top:6px">模型文件需手动放置到 data/models 目录（visual.onnx / text.onnx / vocab.txt）。推理引擎将在后续版本接入，当前版本提供模型管理与配置。</div>
        <div class="mc-btns">
          <button id="model-open">打开模型文件夹</button>
          <button id="model-refresh">重新检测</button>
        </div>
      </div>
    </div>
    <div class="set-section">
      <div class="set-head"><span class="set-title">关于</span></div>
      <div class="set-note" id="about-version">Pigeon · 数据存于程序旁 data 目录，整个文件夹可随身携带</div>
    </div>`;

  try {
  $('#set-ai-import').onchange = (e) => saveSettings({ autoImport: Object.assign({}, settingsCache.autoImport, { enabled: e.target.checked }) });
  $$('#settings-body .set-folder button.pick').forEach(b => b.onclick = async () => {
    const dir = await api.dialog.pickDirectory();
    if (!dir) return;
    const i = +b.dataset.folder;
    settingsCache.autoImport.folders[i] = dir;
    await saveSettings({ autoImport: settingsCache.autoImport });
    renderSettings();
  });
  $$('#settings-body .set-folder button.clear').forEach(b => b.onclick = async () => {
    const i = +b.dataset.folder;
    settingsCache.autoImport.folders[i] = '';
    await saveSettings({ autoImport: settingsCache.autoImport });
    renderSettings();
  });
  $('#set-capture').onchange = (e) => saveSettings({ capture: Object.assign({}, settingsCache.capture, { enabled: e.target.checked }) });
  $('#set-hotkey').onchange = (e) => saveSettings({ globalHotkey: Object.assign({}, settingsCache.globalHotkey, { enabled: e.target.checked }) });
  $('#set-wallpaper').onchange = async (e) => {
    await saveSettings({ wallpaper: Object.assign({}, settingsCache.wallpaper, { enabled: e.target.checked }) });
    applyWallpaper();
  };
  $('#wp-default').onclick = async () => {
    await saveSettings({ wallpaper: Object.assign({}, settingsCache.wallpaper, { mode: 'default' }) });
    applyWallpaper();
    toast('已使用默认示例图');
  };
  $('#wp-custom').onclick = async () => {
    const url = await api.wallpaper.pickImage();
    if (!url) return;
    await saveSettings({ wallpaper: Object.assign({}, settingsCache.wallpaper, { mode: 'custom', customUrl: url }) });
    applyWallpaper();
    toast('壁纸已更新');
  };
  $('#wp-opacity').oninput = debounce(async (e) => {
    const v = parseFloat(e.target.value);
    $('#wp-opacity-val').textContent = v;
    await saveSettings({ wallpaper: Object.assign({}, settingsCache.wallpaper, { opacity: v }) });
    applyWallpaper();
  }, 200);
  $('#set-ai').onchange = async (e) => {
    await saveSettings({ ai: Object.assign({}, settingsCache.ai, { enabled: e.target.checked }) });
    refreshAiChipVisibility();
    if (e.target.checked) {
      toast('正在为存量图片建立向量索引...');
      const r = await api.ai.embedMissing();
      if (r.done) { toast(`向量索引就绪（新增 ${r.count} 张）`); refreshModelStatus(); }
    }
  };
  $('#set-autotag').onchange = (e) => saveSettings({ ai: Object.assign({}, settingsCache.ai, { autoTag: e.target.checked }) });
  $('#set-semsearch').onchange = (e) => saveSettings({ ai: Object.assign({}, settingsCache.ai, { semanticSearch: e.target.checked }) });
  $('#model-open').onclick = () => api.settings.openModelsDir();
  $('#model-refresh').onclick = refreshModelStatus;
  $('#set-back').onclick = closeSettings;
  refreshModelStatus();
  api.appVersion().then(v => { const a = $('#about-version'); if (a) a.innerHTML = 'Pigeon v' + v + ' · 数据存于程序旁 data 目录，整个文件夹可随身携带'; });
  } catch (e) { console.error('[pigeon] renderSettings绑定失败', e); }
}
async function refreshModelStatus() {
  const st = await api.settings.modelStatus();
  const el2 = $('#model-status');
  if (!el2) return;
  el2.innerHTML = st.runtimeReady ? `<span style="color:#67c23a">已就绪 ✓ 语义搜索与自动打标可用 · 已向量化 ${st.vectorCount} 张</span>`
    : st.ready ? '<span style="color:#e6a23c">模型文件齐全，正在初始化推理引擎...</span>'
    : st.weights ? '<span style="color:#e6a23c">官方权重已下载 ✓ · 待转换为 ONNX（下一版本提供一键转换）</span>'
    : '<span style="color:var(--text-faint)">未下载（缺少 clip_cn_rn50.pt ≈ 308MB）</span>';
}
async function saveSettings(patch) {
  settingsCache = await api.settings.set(patch);
  toast('设置已保存');
}

// ================= 测试钩子（截图自检用） =================
window.__test = {
  selectFirst: () => {
    if (!visible.length) return;
    state.selection.clear(); state.selection.add(visible[0].id);
    state.anchorId = visible[0].id;
    renderGrid(); renderInspector(); renderStatus();
  },
  openPreview: () => openPreview(0),
  closePreview,
  showFilter: () => showFilterPanel(),
  hideMenus: () => hideMenu(),
  openBrowser: () => openBrowser('https://www.bing.com/images'),
  closeBrowser,
  openUrlModal: (u) => openUrlModal(u),
  closeUrlModal,
  showDup: () => openDupModal(),
  openSettings: () => openSettings(),
  closeSettings: () => closeSettings(),
  closeDupModal: () => closeDupModal(),
  processAll: () => { postProcess(state.items.filter(i => !i.thumbnailDone)); state.items.forEach(i => i.thumbnailDone = true); },
  runDupScanUi: () => {
    // 演示用：取真实条目渲染分组界面（不执行合并）
    const pool = state.items.filter(i => !i.isDeleted && isImage(i)).slice(0, 8);
    if (pool.length >= 4) {
      dupGroups = [[pool[0], pool[1]], [pool[2], pool[3]]];
      for (const g of dupGroups) {
        g.sort((a, b) => (b.width * b.height || 0) - (a.width * a.height || 0));
        g[0].__keep = true;
        for (let k = 1; k < g.length; k++) g[k].__keep = false;
      }
      renderDupGroups();
      $('#dup-status').textContent = `发现 ${dupGroups.length} 组重复（演示数据）`;
      $('#dup-actions').classList.remove('hidden');
    } else runDupScan('same');
  },
  search: (q) => { $('#search').value = q; state.search = q; renderGrid(); renderFilterBar(); },
  paletteCheck: async () => {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 200; canvas.height = 150;
      const ctx = canvas.getContext('2d');
      const grad = ctx.createLinearGradient(0, 0, 200, 150);
      grad.addColorStop(0, '#E34234'); grad.addColorStop(0.5, '#2F6FE0'); grad.addColorStop(1, '#F5F5F0');
      ctx.fillStyle = grad; ctx.fillRect(0, 0, 200, 150);
      ctx.fillStyle = '#F5B942'; ctx.fillRect(150, 110, 40, 30);
      const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
      const buf = await blob.arrayBuffer();
      const item = await api.import.buffer('调色板测试.png', 'image/png', buf, []);
      state.items.push(item);
      await genImageExtras(item);
      const result = { palettes: (item.palettes || []).length, thumbOk: !!item.width };
      state.items = state.items.filter(i => i.id !== item.id);
      await api.items.deletePermanent([item.id]);
      return result;
    } catch (e) { return { error: String(e.message || e).slice(0, 80) }; }
  },
  newFolderFlow: async (name) => {
    newFolderDialog();
    await new Promise(r => setTimeout(r, 120));
    const layer = [...document.body.children].pop();
    const input = layer.querySelector('input');
    if (!input) return false;
    input.value = name;
    [...layer.querySelectorAll('button')].find(b => b.textContent === '确定').click();
    await new Promise(r => setTimeout(r, 900));
    return [...document.querySelectorAll('#sidebar .sb-item .label')].some(l => l.textContent === name);
  },
  removeFolderByName: async (name) => {
    const find = (list) => { for (const f of list) { if (f.name === name) return f; const r = find(f.children || []); if (r) return r; } return null; };
    const f = find(state.meta.folders);
    if (!f) return false;
    await api.folders.remove(f.id);
    await reload();
    return true;
  },
  enableWallpaper: async () => {
    settingsCache = settingsCache || {};
    await saveSettings({ wallpaper: { enabled: true, mode: 'default', opacity: 0.45 } });
    applyWallpaper();
    const w = document.getElementById('wallpaper');
    const probe = new Image();
    const loadOk = await new Promise(r => { probe.onload = () => r(true); probe.onerror = () => r(false); probe.src = 'pigeon-wallpaper-default.png'; });
    return {
      cls: document.body.classList.contains('wallpaper-on'),
      bg: (w.style.backgroundImage || '').slice(0, 60),
      display: getComputedStyle(w).display,
      z: getComputedStyle(w).zIndex,
      loadOk,
    };
  },
  setLayout: (l) => {
    state.layout = l;
    localStorage.setItem('pigeon.layout', l);
    $$('#view-group button').forEach(x => x.classList.toggle('on', x.dataset.layout === l));
    renderGrid();
  },
};

// ================= 全局错误上报（便于主进程日志排查） =================
window.addEventListener('error', (e) => console.error('[pigeon]', e.message, e.filename + ':' + e.lineno));
window.addEventListener('unhandledrejection', (e) => console.error('[pigeon] promise:', e.reason && e.reason.message || e.reason));

// ================= 启动 =================
(async function init() {
  bindToolbar();
  bindGlobal();
  $('#sort-label').textContent = SORT_LABELS[state.sort.key];
  try {
    const cfg = await api.getConfig();
    settingsCache = await api.settings.get(); // 合并默认值后的设置（含壁纸默认开启）
    applyWallpaper();
    if (cfg.lastLibrary) await openLibrary(cfg.lastLibrary);
    else await renderWelcome();
  } catch (e) {
    console.error(e);
    await renderWelcome();
  }
})();

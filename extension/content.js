// Pigeon 浏览器扩展 — 内容脚本（由后台按需注入，收到 PIGEON_COLLECT 消息时扫描当前页面）
// 只收集图片 URL 与展示尺寸，不读取页面 Cookie、localStorage 等任何敏感信息。
(() => {
  if (window.__pigeonCollectorBound) return;
  window.__pigeonCollectorBound = true;

  const IMG_LINK_RE = /\.(jpe?g|png|gif|webp|avif|bmp|svg)(\?|#|$)/i;

  function abs(u) {
    if (typeof u !== 'string' || !u.trim()) return null;
    try { return new URL(u, location.href).href; } catch (e) { return null; }
  }
  // srcset 里取最宽候选（高清优先）
  function parseSrcset(ss) {
    let best = null, bestW = -1;
    for (const part of String(ss || '').split(',')) {
      const seg = part.trim().split(/\s+/);
      if (!seg[0]) continue;
      const w = seg[1] && seg[1].endsWith('w') ? parseInt(seg[1], 10) : 0;
      if (w >= bestW) { bestW = w; best = seg[0]; }
    }
    return best;
  }

  const history = new Map();
  let observer = null, timer = null, pageIdentity = location.href;
  const LIMIT = 2000;
  function contextFor(node) {
    const host = location.hostname || '';
    const site = /(^|\.)pinterest\./i.test(host) ? 'Pinterest' : /(^|\.)behance\.net$/i.test(host) ? 'Behance' : /(^|\.)zcool\.com\.cn$/i.test(host) ? '站酷' : '网页';
    let pageUrl = location.href;
    if (site === 'Pinterest' && node && node.closest) {
      const pin = node.closest('a[href*="/pin/"]') || node.closest('[data-test-id="pin"]')?.querySelector('a[href*="/pin/"]');
      if (pin) pageUrl = abs(pin.href) || pageUrl;
    }
    const selectors = site === 'Behance' ? '.project-module, .project-modules, [data-testid="project-module"]'
      : site === '站酷' ? '.work-content-box, .work-content, .work-show-box, .work-details-content' : '';
    const project = !!(selectors && node && node.closest && node.closest(selectors));
    return { pageUrl, site, project };
  }
  function assetKey(url, node) {
    try {
      const u=new URL(url);
      if (/(^|\.)pinimg\.com$/.test(u.hostname)) return u.hostname+u.pathname.replace(/^\/(originals|\d+x[^/]*)\//,'/asset/');
      if (node && node.tagName === 'IMG') {
        const original=node.getAttribute('data-original') || node.getAttribute('data-src') || node.currentSrc || node.src;
        if(original && /^https?:/.test(abs(original) || '')) return abs(original);
      }
    } catch(e) {}
    return url;
  }
  function collectImages() {
    const out = new Map(); // 绝对 URL 去重合并：url → {srcUrl, w, h, alt}
    let skippedInline = 0; // data:/blob: 等无法通过桌面端下载的图
    const add = (u, w, h, alt, node) => {
      if (!u) return;
      if (/^(data|blob|javascript):/i.test(u)) { skippedInline++; return; }
      if (!/^https?:\/\//i.test(u)) return;
      if (u.length > 2048) return;
      const rec = out.get(u) || { id: u, assetId: assetKey(u,node), srcUrl: u, w: 0, h: 0, alt: '', ...contextFor(node) };
      if (contextFor(node).project) rec.project = true;
      rec.w = Math.max(rec.w || 0, w || 0);
      rec.h = Math.max(rec.h || 0, h || 0);
      if (alt && !rec.alt) rec.alt = String(alt).replace(/\s+/g, ' ').slice(0, 100);
      out.set(u, rec);
    };

    // <img>：渲染地址（currentSrc 含 srcset 生效结果）与懒加载真实地址各自独立收集，
    // 再由 Map 去重合并——src 有占位图时 data-src 不会丢；懒加载/高清候选的尺寸未知（0），
    // 不冒用当前渲染的小图尺寸，避免 ≥800 筛选误杀高清图
    for (const img of document.querySelectorAll('img')) {
      const renderedUrl = abs(img.currentSrc || img.src);
      if (renderedUrl) add(renderedUrl, img.naturalWidth, img.naturalHeight, img.alt, img);
      const lazy = img.getAttribute('data-src') || img.getAttribute('data-original')
        || img.getAttribute('data-lazy-src') || img.getAttribute('data-actualsrc')
        || img.getAttribute('data-echo');
      if (lazy) {
        const lu = abs(lazy);
        if (lu && lu !== renderedUrl) add(lu, 0, 0, img.alt, img);
      }
      const ss = img.getAttribute('data-srcset') || img.getAttribute('data-lazy-srcset') || img.getAttribute('srcset');
      if (ss) {
        const bu = abs(parseSrcset(ss));
        // bu === renderedUrl 时上面的 add 已带上真实尺寸，这里不重复收集
        if (bu && bu !== renderedUrl) add(bu, 0, 0, img.alt, img);
      }
    }
    for (const node of document.querySelectorAll('main [style*="background"], article [style*="background"], .project-module [style*="background"], .work-content [style*="background"]')) {
      const css=node.style?.backgroundImage || '';
      for (const match of css.matchAll(/url\(["']?([^"')]+)["']?\)/g)) add(abs(match[1]),0,0,'',node);
    }
    // <picture><source srcset>
    for (const s of document.querySelectorAll('picture source[srcset]')) {
      add(abs(parseSrcset(s.getAttribute('srcset'))), 0, 0, '', s);
    }
    // og:image / twitter:image
    for (const m of document.querySelectorAll('meta[property="og:image"], meta[name="twitter:image"], link[rel="image_src"]')) {
      add(abs(m.content || m.href), 0, 0, document.title);
    }
    // 指向图片文件的链接（点开大图的场景）
    for (const a of document.querySelectorAll('a[href]')) {
      if (IMG_LINK_RE.test(a.href)) add(abs(a.href), 0, 0, a.textContent.trim(), a);
    }
    // 视频封面
    for (const v of document.querySelectorAll('video[poster]')) {
      add(abs(v.poster), v.videoWidth, v.videoHeight, '', v);
    }

    // Keep discovery order (especially project pages); append lazy-loaded assets.
    if (pageIdentity !== location.href) { history.clear(); pageIdentity = location.href; }
    for (const [key, value] of out) {
      if (history.has(key)) Object.assign(history.get(key), value);
      else if (history.size < LIMIT) history.set(key, value);
    }
    return { pageUrl: location.href, title: (document.title || '').slice(0, 120),
      items: [...history.values()], skippedInline, watching: !!observer,
      limited: history.size >= LIMIT, projectAvailable: [...history.values()].some(it => it.project) };
  }
  function watch(on) {
    if (observer) observer.disconnect();
    observer = null;
    if (timer) clearTimeout(timer);
    if (on) {
      observer = new MutationObserver(() => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { timer = null; collectImages(); }, 350);
      });
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true,
        attributeFilter: ['src', 'srcset', 'data-src', 'data-original', 'data-srcset'] });
    }
    return collectImages();
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'PIGEON_FETCH_IMAGE') {
      (async () => {
        try {
          const url = abs(msg.url);
          if (!history.has(url)) throw new Error('只能下载当前采集列表中的图片');
          const response = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(25000) });
          if (!response.ok) throw new Error('HTTP ' + response.status);
          const mime=(response.headers.get('content-type') || '').split(';')[0];
          if (!/^image\/(png|jpeg|gif|webp|avif|bmp|svg\+xml)$/.test(mime)) throw new Error('返回内容不是支持的图片');
          const chunks=[]; let size=0;
          const reader=response.body.getReader();
          try { for(;;) { const {done,value:chunk}=await reader.read(); if(done)break;size+=chunk.length;if(size>12*1024*1024)throw new Error('单张超过 12MB，请使用桌面下载');chunks.push(chunk); } }
          finally { await reader.cancel().catch(()=>{}); }
          const blob=new Blob(chunks,{type:mime});
          const data=await new Promise((resolve,reject)=>{const reader=new FileReader(); reader.onload=()=>resolve(reader.result.split(',')[1]); reader.onerror=reject; reader.readAsDataURL(blob);});
          sendResponse({ok:true,data,mime});
        } catch(e) { sendResponse({ok:false,error:e.message || '浏览器下载失败'}); }
      })();
      return true;
    }
    if (msg && msg.type === 'PIGEON_COLLECT') sendResponse(collectImages());
    if (msg && msg.type === 'PIGEON_WATCH') sendResponse(watch(!!msg.enabled));
    return false; // 同步返回
  });
})();

// Pigeon 扩展共享工具。popup 经 <script> 加载，隔离测试经 node/vm 加载，都挂到 globalThis。
// 服务端单批上限 60（lib/bridge-server.js），超过必须分批提交，不能整批失败。
(function (g) {
  'use strict';
  const BATCH_SIZE = 60;
  function chunkItems(items, size) {
    const n = size || BATCH_SIZE;
    const out = [];
    for (let i = 0; i < (items || []).length; i += n) out.push(items.slice(i, i + n));
    return out;
  }
  // Selection is data-owned: filtering/repainting never changes a user's picks.
  class Selection {
    constructor() { this.items = []; this.picks = new Set(); this.byId = new Map(); }
    merge(items, selectNew = false) {
      for (const item of items) {
        const id = item.assetId || item.id || item.srcUrl;
        const old = this.byId.get(id);
        if (old) {
          const variants=old.variants;
          const found=variants.find(v=>v.srcUrl===item.srcUrl);
          if(found) Object.assign(found,item); else variants.push({...item});
          // Promote only measured larger candidates, unless the user chose a version.
          if(!old.manualVariant && (item.w || 0)*(item.h || 0) > (old.w || 0)*(old.h || 0)) Object.assign(old,item,{id,variants});
          old.project=old.project || item.project;
        }
        else { const copy = { ...item, id, variants:[{...item}] }; this.items.push(copy); this.byId.set(id, copy); if (selectNew) this.picks.add(id); }
      }
    }
    toggle(id) { this.picks.has(id) ? this.picks.delete(id) : this.picks.add(id); }
    selectVisible(items, value) { items.forEach(it => value ? this.picks.add(it.id) : this.picks.delete(it.id)); }
    selected() { return this.items.filter(it => this.picks.has(it.id)).map(it => ({ ...it })); }
  }
  g.PigeonExt = { chunkItems, BATCH_SIZE, Selection };
})(globalThis);

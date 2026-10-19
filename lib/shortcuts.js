(function (g) {
  'use strict';
  const commands = [
    ['search','搜索','Ctrl+F','main'], ['selectAll','全选素材','Ctrl+A','main'],
    ['paste','粘贴导入','Ctrl+V','main'], ['url','链接导入','Ctrl+U','main'],
    ['tag','添加标签','T','main'], ['trash','移入回收站','Delete','main'],
    ['rename','重命名','F2','main'], ['preview','预览 / 关闭预览','Space','both'],
    ['previous','上一张','ArrowLeft','preview'], ['next','下一张','ArrowRight','preview'],
    ['undo','撤销','Ctrl+Z','main'], ['redo','重做','Ctrl+Y','main'],
    ['refresh','刷新','F5','main'], ['filter','筛选','Alt+F','main'],
    ['waterfall','瀑布流','Alt+1','main'], ['grid','网格','Alt+2','main'], ['list','列表','Alt+3','main'],
    ['settings','设置','Ctrl+Comma','main'],
  ].map(([id,label,key,scope]) => ({id,label,key,scope}));
  const aliases = { ' ': 'Space', ',': 'Comma', '.':'Period', '+':'Plus', Control:'Ctrl', Esc:'Escape', Del:'Delete', Left:'ArrowLeft', Right:'ArrowRight', Up:'ArrowUp', Down:'ArrowDown' };
  function normalize(value) {
    if (!value) return '';
    const parts = String(value).split('+').map(s => s.trim()).filter(Boolean);
    const key = aliases[parts.pop()] || String(value).split('+').pop().trim();
    const mods = ['Ctrl','Alt','Shift','Meta'].filter(k => parts.includes(k) || k === 'Ctrl' && parts.includes('Control'));
    if (parts.some(k => !['Ctrl','Control','Alt','Shift','Meta'].includes(k))) throw new Error('无效的修饰键');
    const normalized = key.length === 1 ? key.toUpperCase() : key;
    if (!/^(?:[A-Z0-9]|F(?:[1-9]|1[0-2])|Space|Comma|Period|Plus|Delete|Backspace|Enter|Tab|Home|End|PageUp|PageDown|ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Escape)$/.test(normalized)) throw new Error('不支持此按键');
    return [...mods,normalized].join('+');
  }
  function fromEvent(e) {
    if (e.isComposing || e.keyCode === 229 || ['Control','Alt','Shift','Meta','Dead','Process'].includes(e.key)) return '';
    try { return normalize([e.ctrlKey?'Ctrl':'',e.altKey?'Alt':'',e.shiftKey?'Shift':'',e.metaKey?'Meta':'',aliases[e.key] || e.key].filter(Boolean).join('+')); } catch (_) { return ''; }
  }
  function bindings(custom = {}) { return Object.fromEntries(commands.map(c => [c.id, normalize(Object.prototype.hasOwnProperty.call(custom,c.id) ? custom[c.id] : c.key)])); }
  function validate(custom, globals = {}) {
    const keys = bindings(custom);
    const reserved = new Set(['Escape','Alt+F4','Ctrl+Alt+Delete','Meta+L','Alt+Tab','Ctrl+Shift+Escape']);
    const rows = commands.map(c => ({...c,key:keys[c.id]})).concat(Object.entries(globals).map(([label,key]) => ({label,key:normalize(key),scope:'global'})));
    for (let i=0;i<rows.length;i++) {
      const a=rows[i]; if (!a.key) continue;
      if (reserved.has(a.key) || a.key.startsWith('Meta+')) throw new Error(a.label+' 使用了系统保留键');
      if (a.scope==='global' && !/^(Ctrl|Alt)\+/.test(a.key)) throw new Error('全局快捷键必须包含 Ctrl 或 Alt');
      for(let j=0;j<i;j++) {
        const b=rows[j];
        if(a.key===b.key && (a.scope===b.scope || ['both','global'].includes(a.scope) || ['both','global'].includes(b.scope))) throw new Error(a.label+' 与「'+b.label+'」冲突：'+a.key);
      }
    }
    return keys;
  }
  function resolve(e, custom, scope='main') {
    if (e.defaultPrevented || e.isComposing || e.repeat) return null;
    const key=fromEvent(e), keys=bindings(custom);
    return commands.find(c => (c.scope===scope || c.scope==='both') && keys[c.id] && keys[c.id]===key)?.id || null;
  }
  function display(key) { return key.replace(/ArrowLeft/g,'←').replace(/ArrowRight/g,'→').replace(/ArrowUp/g,'↑').replace(/ArrowDown/g,'↓').replace(/Comma/g,',').replace(/Period/g,'.').replace(/Space/g,'空格'); }
  const api={commands,normalize,fromEvent,bindings,validate,resolve,display};
  if(typeof module!=='undefined') module.exports=api; else g.PigeonShortcuts=api;
})(globalThis);

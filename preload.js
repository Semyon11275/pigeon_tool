// Pigeon — 预加载：把主进程能力以安全方式暴露给渲染进程
'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = (channel, ...args) => ipcRenderer.invoke(channel, ...args).then(r => {
  if (!r || r.ok !== true) throw new Error(r && r.error || 'IPC 失败');
  return r.data;
});

contextBridge.exposeInMainWorld('pigeon', {
  getPathForFile: (file) => webUtils.getPathForFile(file),
  getConfig: () => call('config:get'),
  setConfig: (patch) => call('config:set', patch),
  window: {
    min: () => call('window:min'),
    max: () => call('window:max'),
    close: () => call('window:close'),
    onMaximized: (cb) => ipcRenderer.on('window:maximized', (_e, v) => cb(v)),
  },
  dialog: {
    pickDirectory: () => call('dialog:pickDirectory'),
    pickFiles: () => call('dialog:pickFiles'),
  },
  library: {
    open: (root) => call('library:open', root),
    create: (name, options) => call('library:create', name, options),
    importEagle: (src, destDir, name) => call('library:importEagle', src, destDir, name),
    meta: () => call('library:meta'),
    listKnown: () => call('library:listKnown'),
    exportCsv: (ids) => call('library:exportCsv', ids),
  },
  items: {
    list: () => call('items:list'),
    update: (id, patch, rootOverride) => call('item:update', id, patch, rootOverride),
    readIn: (root, id) => call('item:readIn', root, id),
    trash: (ids, deleted) => call('item:trash', ids, deleted),
    deletePermanent: (ids) => call('item:deletePermanent', ids),
    saveThumbnail: (id, buf) => call('item:saveThumbnail', id, buf),
    exportTo: (ids) => call('item:exportTo', ids),
    dragOut: (ids) => ipcRenderer.send('item:dragOut', ids),
  },
  bridge: {
    info: () => call('bridge:info'),
  },
  folders: {
    add: (name, parentId) => call('folder:add', name, parentId),
    rename: (id, name) => call('folder:rename', id, name),
    remove: (id) => call('folder:remove', id),
    setDefaultTags: (id, tags) => call('folder:setDefaultTags', id, tags),
    defaultTagsOf: (id) => call('folder:defaultTagsOf', id),
  },
  tags: {
    rename: (oldTag, newTag) => call('tags:rename', oldTag, newTag),
    merge: (sources, target) => call('tags:merge', sources, target),
    delete: (tag) => call('tags:delete', tag),
    setGroups: (groups) => call('library:setTagsGroups', groups),
  },
  exportFiles: {
    pickDir: () => call('dialog:pickExportDir'),
    write: (dir, name, buf) => call('item:writeExportFile', dir, name, buf),
  },
  import: {
    files: (paths, folderIds) => call('import:files', paths, folderIds),
    clipboard: (folderIds) => call('import:clipboard', folderIds),
    buffer: (name, type, arrayBuffer, folderIds) => call('import:buffer', name, type, arrayBuffer, folderIds),
  },
  web: {
    extractImages: (url) => call('web:extractImages', url),
    importFromUrl: (srcUrl, pageUrl, folderIds) => call('net:importFromUrl', srcUrl, pageUrl, folderIds),
  },
  scan: {
    md5All: () => call('scan:md5All'),
  },
  exif: {
    get: (id) => call('item:exif', id),
  },
  smartFolders: {
    set: (sfs) => call('library:setSmartFolders', sfs),
  },
  shell: {
    reveal: (id) => call('shell:reveal', id),
    open: (id) => call('shell:open', id),
    openExternal: (url) => call('shell:openExternal', url),
  },
  clipboard: {
    writeText: (t) => call('clipboard:writeText', t),
    readPaste: () => call('clipboard:readPaste'),
  },
  settings: {
    get: () => call('settings:get'),
    hotkeyStatus: () => call('settings:hotkeyStatus'),
    set: (patch) => call('settings:set', patch),
    modelsDir: () => call('settings:modelsDir'),
    openModelsDir: () => call('settings:openModelsDir'),
    modelStatus: () => call('settings:modelStatus'),
  },
  wallpaper: {
    pickImage: () => call('wallpaper:pickImage'),
  },
  updates: {
    status: () => call('updates:status'), check: () => call('updates:check'),
    download: () => call('updates:download'), install: () => call('updates:install'),
    onState: cb => ipcRenderer.on('pigeon:update', (_e,st) => cb(st)),
  },
  appVersion: () => call('app:version'),
  onImported: (cb) => ipcRenderer.on('pigeon:imported', (_e, items) => cb(items)),
  onAiProgress: (cb) => ipcRenderer.on('pigeon:ai-progress', (_e, p) => cb(p)),
  onDragOutResult: (cb) => ipcRenderer.on('pigeon:dragOutResult', (_e, r) => cb(r)),
  ai: {
    search: (query, topN) => call('ai:semanticSearch', query, topN),
    embedMissing: () => call('ai:embedMissing'),
    autoTag: (id) => call('ai:autoTagItem', id),
  },
});

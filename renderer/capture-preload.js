// 截图覆盖窗预加载
'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('capture', {
  done: (rect) => ipcRenderer.send('capture:done', rect),
  cancel: () => ipcRenderer.send('capture:cancel'),
});

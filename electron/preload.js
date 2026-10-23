'use strict';
// 只给界面开放这几个功能，界面拿不到 Node 或文件系统
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  platform: process.platform,
  webview: true, // 右侧面板的浏览器可以用 <webview>
  pickFolder: (start) => ipcRenderer.invoke('pick-folder', String(start || '')),
  notify: (title, body) => ipcRenderer.invoke('notify', { title, body }),
  copy: (text) => ipcRenderer.invoke('copy', String(text || '')),
  paste: () => ipcRenderer.invoke('paste'),
  setTitleBar: (colors) => ipcRenderer.invoke('titlebar', { color: colors && colors.color, symbolColor: colors && colors.symbolColor }),
  action: (name) => ipcRenderer.invoke('app-action', String(name || '')),
  setTheme: (theme) => ipcRenderer.invoke('set-theme', String(theme || 'system')),
  // 自动更新（electron/updater.js）：现在的状态、马上检查、重启并安装下载好的新版本；状态变了会调用 onUpdate 给的函数
  updateState: () => ipcRenderer.invoke('update-state'),
  checkUpdate: () => ipcRenderer.invoke('update-check'),
  installUpdate: () => ipcRenderer.invoke('update-install'),
  onUpdate: (fn) => {
    ipcRenderer.on('update-state', (e, s) => fn(s));
  },
});

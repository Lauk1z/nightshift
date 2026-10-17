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
});

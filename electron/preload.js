// Claud.io preload: the small, explicit API the studio page may use.
const { contextBridge, ipcRenderer } = require('electron');

const fileListeners = [];
ipcRenderer.on('open-file', (_e, f) => fileListeners.forEach(cb => cb(f)));

contextBridge.exposeInMainWorld('claudio', {
  version: ipcRenderer.sendSync('app-version'),
  platform: process.platform,
  openExternal: url => ipcRenderer.send('open-external', String(url)),
  onOpenFile: cb => { fileListeners.push(cb); ipcRenderer.send('renderer-ready'); },
  update: {
    check: () => ipcRenderer.send('update-check'),
    install: () => ipcRenderer.send('update-install'),
    onStatus: cb => ipcRenderer.on('update-status', (_e, s) => cb(s)),
  },
});

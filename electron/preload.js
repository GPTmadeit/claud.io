// Claud.io preload: the small, explicit API the studio page may use.
const { contextBridge, ipcRenderer } = require('electron');

const fileListeners = [];
ipcRenderer.on('open-file', (_e, f) => fileListeners.forEach(cb => cb(f)));

contextBridge.exposeInMainWorld('claudio', {
  version: ipcRenderer.sendSync('app-version'),
  platform: process.platform,
  openExternal: url => ipcRenderer.send('open-external', String(url)),
  onOpenFile: cb => { fileListeners.push(cb); ipcRenderer.send('renderer-ready'); },
  gpu: {
    enabled: ipcRenderer.sendSync('gpu-enabled'),
    info: () => ipcRenderer.invoke('gpu-info'),
    set: on => ipcRenderer.send('gpu-set', !!on),
  },
  promptSync: (message, def, lang) => ipcRenderer.sendSync('prompt-sync', String(message == null ? '' : message), def == null ? '' : String(def), lang === 'de' ? 'de' : 'en'),
  setZoom: k => ipcRenderer.send('zoom-set', +k),
  update: {
    check: () => ipcRenderer.send('update-check'),
    install: () => ipcRenderer.send('update-install'),
    onStatus: cb => ipcRenderer.on('update-status', (_e, s) => cb(s)),
  },
});

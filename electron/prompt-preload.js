// Preload for the small prompt() window (Electron has no built-in window.prompt).
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('promptBridge', { done: (id, value) => ipcRenderer.send('prompt-result', id, value) });

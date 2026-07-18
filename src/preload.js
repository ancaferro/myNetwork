'use strict';
const { contextBridge, ipcRenderer, clipboard } = require('electron');
// Single source of truth for the version — bumped in package.json on release,
// so the UI updates automatically without touching any markup.
const { version } = require('../package.json');

contextBridge.exposeInMainWorld('api', {
  version,
  copy: (text) => clipboard.writeText(String(text)),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  getInterfaces: () => ipcRenderer.invoke('interfaces'),
  startScan: (opts) => ipcRenderer.invoke('scan:start', opts),
  cancelScan: () => ipcRenderer.invoke('scan:cancel'),
  getCache: () => ipcRenderer.invoke('cache:get'),
  clearCache: () => ipcRenderer.invoke('cache:clear'),
  exportCsv: (rows) => ipcRenderer.invoke('export:csv', rows),
  exportJson: (rows) => ipcRenderer.invoke('export:json', rows),
  startMonitor: (hosts) => ipcRenderer.invoke('monitor:start', hosts),
  stopMonitor: () => ipcRenderer.invoke('monitor:stop'),
  onMonitorHost: (cb) => ipcRenderer.on('monitor:host', (_e, u) => cb(u)),

  winMinimize: () => ipcRenderer.invoke('win:minimize'),
  winMaximize: () => ipcRenderer.invoke('win:maximize'),
  winClose: () => ipcRenderer.invoke('win:close'),

  onPhase: (cb) => ipcRenderer.on('scan:phase', (_e, p) => cb(p)),
  onProgress: (cb) => ipcRenderer.on('scan:progress', (_e, p) => cb(p)),
  onHost: (cb) => ipcRenderer.on('scan:host', (_e, h) => cb(h)),
  onError: (cb) => ipcRenderer.on('scan:error', (_e, m) => cb(m)),
  onDone: (cb) => ipcRenderer.on('scan:done', (_e, d) => cb(d)),
  onWinState: (cb) => ipcRenderer.on('win:state', (_e, s) => cb(s)),
});

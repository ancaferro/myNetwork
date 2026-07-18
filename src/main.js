'use strict';
const { app, BrowserWindow, ipcMain, dialog, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { Scan } = require('./scanner');
const { detectInterfaces } = require('./scanner/net-utils');
const { defaultRoute, pingAlive } = require('./scanner/discovery');
const { probePort, serviceName, DEFAULT_PORTS } = require('./scanner/ports');

const ICON_PATH = path.join(__dirname, '..', 'build', 'icon.png');

let win = null;
let currentScan = null;

// ---- Last-scan cache --------------------------------------------------------
function cacheFile() {
  return path.join(app.getPath('userData'), 'last-scan.json');
}

function loadCache() {
  try {
    const raw = fs.readFileSync(cacheFile(), 'utf8');
    const data = JSON.parse(raw);
    if (data && Array.isArray(data.hosts)) return data;
  } catch {
    /* no cache yet or unreadable */
  }
  return null;
}

function saveCache(data) {
  try {
    fs.writeFileSync(cacheFile(), JSON.stringify(data), 'utf8');
  } catch {
    /* non-fatal — caching is best-effort */
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 760,
    minHeight: 520,
    backgroundColor: '#ece9d8',
    icon: ICON_PATH,
    frame: false, // custom Luna title bar in the renderer
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.on('maximize', () => win.webContents.send('win:state', { maximized: true }));
  win.on('unmaximize', () => win.webContents.send('win:state', { maximized: false }));

  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopMonitor();
  if (process.platform !== 'darwin') app.quit();
});

// ---- IPC --------------------------------------------------------------------
ipcMain.handle('interfaces', async () => {
  try {
    const interfaces = detectInterfaces();
    let gatewayIface = null;
    let gateway = null;
    try {
      const dr = await defaultRoute();
      gatewayIface = dr.iface;
      gateway = dr.gateway;
    } catch {
      /* ignore — fall back to heuristic order */
    }

    for (const i of interfaces) {
      i.isDefault = gatewayIface != null && i.name === gatewayIface;
      if (i.isDefault) i.gateway = gateway;
    }
    // Interface holding the default route comes first; rest keep their order.
    interfaces.sort((a, b) => (b.isDefault === true) - (a.isDefault === true));

    return { ok: true, interfaces, gatewayIface };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('cache:get', () => loadCache());

ipcMain.handle('cache:clear', () => {
  try {
    fs.unlinkSync(cacheFile());
  } catch {
    /* already gone */
  }
  return { ok: true };
});

ipcMain.handle('scan:start', (event, opts) => {
  if (currentScan) currentScan.cancel();
  const scan = new Scan(opts);
  currentScan = scan;

  const collected = new Map(); // ip -> latest host state (events arrive per layer)

  const send = (channel, payload) => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send(channel, payload);
  };

  scan.on('phase', (p) => send('scan:phase', p));
  scan.on('progress', (p) => send('scan:progress', p));
  scan.on('host', (h) => {
    collected.set(h.ip, h);
    send('scan:host', h);
  });
  scan.on('error', (msg) => send('scan:error', msg));
  scan.on('done', (d) => {
    // Persist the run so it can be restored on next launch.
    if (!d.cancelled) {
      saveCache({
        target: opts.target,
        cidr: d.cidr,
        at: Date.now(),
        elapsedMs: d.elapsedMs,
        liveCount: d.liveCount,
        hosts: [...collected.values()],
      });
    }
    send('scan:done', d);
    if (currentScan === scan) currentScan = null;
  });

  // start() handles its own known errors via emit('error'); this catch is a
  // backstop so any unexpected throw still reaches the UI instead of vanishing.
  scan.start().catch((e) => send('scan:error', (e && e.message) || String(e)));
  return { ok: true };
});

ipcMain.handle('scan:cancel', () => {
  if (currentScan) {
    currentScan.cancel();
    return { ok: true };
  }
  return { ok: false };
});

// ---- Window controls (frameless) -------------------------------------------
ipcMain.handle('win:minimize', () => win && win.minimize());
ipcMain.handle('win:maximize', () => {
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.handle('win:close', () => win && win.close());

// ---- CSV export -------------------------------------------------------------
function csvCell(v) {
  const s = v == null ? '' : String(v);
  // Guard against CSV formula injection, then quote if needed.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

ipcMain.handle('export:csv', async (event, rows) => {
  if (!Array.isArray(rows) || rows.length === 0) return { ok: false, error: 'No results to export' };

  const header = ['IP', 'Hostname', 'MAC', 'Vendor', 'RTT (ms)', 'Open ports', 'Ports'];
  const lines = [header.join(',')];
  for (const r of rows) {
    const ports = (r.ports || []).map((p) => `${p.port}${p.service ? '/' + p.service : ''}`).join('; ');
    lines.push(
      [r.ip, r.hostname || '', r.mac || '', r.vendor || '', r.rtt != null ? r.rtt : '', r.openCount || 0, ports]
        .map(csvCell)
        .join(',')
    );
  }
  const csv = '﻿' + lines.join('\r\n') + '\r\n'; // BOM for Excel

  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export scan results',
    defaultPath: 'mynetwork-scan.csv',
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (canceled || !filePath) return { ok: false, cancelled: true };

  try {
    fs.writeFileSync(filePath, csv, 'utf8');
    return { ok: true, filePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ---- Monitoring -------------------------------------------------------------
let monitor = null;

function notify(title, body) {
  try {
    if (Notification.isSupported()) new Notification({ title, body, icon: ICON_PATH }).show();
  } catch {
    /* notifications are best-effort */
  }
}

function stopMonitor() {
  if (monitor) {
    clearInterval(monitor.t1);
    clearInterval(monitor.t2);
    monitor = null;
  }
}

function monitorSend(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// hosts: [{ ip, ports:[{port,proto,service,banner}] }]
// A host must miss this many consecutive rounds before it's shown offline —
// prevents flicker from the occasional dropped ping. Coming back is instant.
const OFFLINE_STRIKES = 3;

function startMonitor(hosts) {
  stopMonitor();
  const state = new Map(hosts.map((h) => [h.ip, { online: true, misses: 0, ports: h.ports || [] }]));

  const pingRound = async () => {
    await Promise.all(
      [...state.keys()].map(async (ip) => {
        const r = await pingAlive(ip, 1200, 2);
        const st = state.get(ip);
        if (!st) return;
        st.misses = r.alive ? 0 : st.misses + 1;
        // Online again on the first reply; offline only after enough misses in a row.
        const nowOnline = r.alive ? true : st.misses < OFFLINE_STRIKES ? st.online : false;
        if (nowOnline !== st.online) {
          st.online = nowOnline;
          notify(nowOnline ? 'Host is back online' : 'Host went offline', ip);
        }
        // Send the debounced state (not the raw ping) so the dot doesn't flicker.
        monitorSend('monitor:host', { ip, online: st.online, rtt: r.rtt });
      })
    );
  };

  const portRound = async () => {
    for (const [ip, st] of state) {
      if (!st.online) continue;
      const known = st.ports.filter((p) => p.proto === 'tcp').map((p) => p.port);
      const toCheck = [...new Set([...known, ...DEFAULT_PORTS])];
      const found = [];
      await Promise.all(
        toCheck.map(async (port) => {
          const r = await probePort(ip, port, 800);
          if (r.open) found.push({ port, proto: 'tcp', service: serviceName(port, 'tcp'), banner: r.banner });
        })
      );
      const udpKept = st.ports.filter((p) => p.proto === 'udp');
      st.ports = [...found.sort((a, b) => a.port - b.port), ...udpKept];
      monitorSend('monitor:host', { ip, online: true, ports: st.ports, portsUpdated: true });
    }
  };

  pingRound(); // immediate first sweep
  monitor = {
    t1: setInterval(pingRound, 60 * 1000),
    t2: setInterval(portRound, 5 * 60 * 1000),
  };
  return { ok: true, count: state.size };
}

ipcMain.handle('monitor:start', (e, hosts) => startMonitor(Array.isArray(hosts) ? hosts : []));
ipcMain.handle('monitor:stop', () => {
  stopMonitor();
  return { ok: true };
});

ipcMain.handle('export:json', async (event, rows) => {
  if (!Array.isArray(rows) || rows.length === 0) return { ok: false, error: 'No results to export' };

  const doc = {
    tool: 'myNetwork',
    exportedAt: new Date().toISOString(),
    count: rows.length,
    hosts: rows,
  };
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export scan results',
    defaultPath: 'mynetwork-scan.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (canceled || !filePath) return { ok: false, cancelled: true };

  try {
    fs.writeFileSync(filePath, JSON.stringify(doc, null, 2), 'utf8');
    return { ok: true, filePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

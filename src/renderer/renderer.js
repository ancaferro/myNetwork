'use strict';

const $ = (sel) => document.querySelector(sel);
const el = {
  iface: $('#iface'),
  target: $('#target'),
  portset: $('#portset'),
  customFields: $('#custom-fields'),
  customTcp: $('#customTcp'),
  customUdp: $('#customUdp'),
  pingTimeout: $('#pingTimeout'),
  portTimeout: $('#portTimeout'),
  scanBtn: $('#scanBtn'),
  monitorBtn: $('#monitorBtn'),
  clearBtn: $('#clearBtn'),
  search: $('#search'),
  preserve: $('#preserve'),
  sbStatus: $('#sb-status'),
  sbMode: $('#sb-mode'),
  sbCount: $('#sb-count'),
  sbLive: $('#sb-live'),
  sbPorts: $('#sb-ports'),
  sbElapsed: $('#sb-elapsed'),
  progressFill: $('#progress-fill'),
  empty: $('#empty'),
  tbody: $('#tbody'),
  thead: document.querySelector('table.hosts thead'),
  menubar: $('#menubar'),
  menuPopup: $('#menu-popup'),
  aboutOverlay: $('#about-overlay'),
};

let interfaces = [];
let scanning = false;
let monitoring = false;
const hostRows = new Map(); // ip -> { tr, data }
let sortKey = 'ip';
let sortDir = 1;
let timerId = null;
let startedAt = 0;

// ---- Init -------------------------------------------------------------------
async function init() {
  // Wire the UI first so a failing interface lookup can't leave the buttons dead.
  wireEvents();
  wireIpc();
  try {
    const res = await window.api.getInterfaces();
    if (res && res.ok) {
      interfaces = res.interfaces;
      el.iface.innerHTML = interfaces
        .map((i, idx) => `<option value="${idx}">${i.isDefault ? '★ ' : ''}${i.name} (${i.cidrs.join(', ')})</option>`)
        .join('');
      if (interfaces.length) restoreTargetSelection();
      else el.sbStatus.textContent = 'No active interfaces found';
    }
  } catch {
    el.sbStatus.textContent = 'Could not read network interfaces';
  }
  restoreCache();
}

// ---- Persisted interface / Range -------------------------------------------
function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem('mynetwork.target') || 'null');
  } catch {
    return null;
  }
}
function saveSettings() {
  const i = interfaces[Number(el.iface.value) || 0];
  try {
    localStorage.setItem(
      'mynetwork.target',
      JSON.stringify({ ifaceName: i ? i.name : null, cidrs: i ? i.cidrs.join(', ') : null, range: el.target.value })
    );
  } catch {
    /* storage unavailable — non-fatal */
  }
}

// Restore the previously used interface + Range. The Range only changes on its
// own when the interface's addresses actually changed since last time.
function restoreTargetSelection() {
  const saved = loadSettings();
  if (saved && saved.ifaceName) {
    const idx = interfaces.findIndex((i) => i.name === saved.ifaceName);
    if (idx >= 0) {
      el.iface.value = String(idx);
      const currentCidrs = interfaces[idx].cidrs.join(', ');
      // Interface unchanged -> keep the saved Range (incl. manual edits).
      // Interface addresses changed -> adopt the new network.
      el.target.value = saved.cidrs === currentCidrs ? saved.range || currentCidrs : currentCidrs;
      saveSettings();
      return;
    }
  }
  // No saved selection (or that interface is gone) -> default gateway interface.
  el.iface.value = '0';
  applyInterface(0);
  saveSettings();
}

function applyInterface(idx) {
  const i = interfaces[idx];
  if (!i) return;
  // Multiple addresses on one interface -> comma-separated Range.
  el.target.value = i.cidrs.join(', ');
}

// ---- Cached results ---------------------------------------------------------
async function restoreCache() {
  const cache = await window.api.getCache();
  if (!cache || !cache.hosts || !cache.hosts.length) return;
  resetResults();
  for (const h of cache.hosts) upsertHost(h);
  el.empty.classList.add('hidden');
  if (cache.elapsedMs != null) el.sbElapsed.textContent = fmtElapsed(cache.elapsedMs);
  el.progressFill.style.width = '100%';
  el.sbStatus.textContent = `Cached: ${cache.cidr || cache.target} (${relTime(cache.at)})`;
}

// ---- Events -----------------------------------------------------------------
function wireEvents() {
  el.iface.addEventListener('change', (e) => {
    applyInterface(Number(e.target.value));
    saveSettings();
  });
  el.target.addEventListener('input', saveSettings);
  el.portset.addEventListener('change', () => {
    el.customFields.classList.toggle('hidden', el.portset.value !== 'custom');
    updateModeInfo();
  });
  el.customTcp.addEventListener('input', updateModeInfo);
  el.customUdp.addEventListener('input', updateModeInfo);
  updateModeInfo();
  el.scanBtn.addEventListener('click', () => (scanning ? cancelScan() : startScan()));
  el.monitorBtn.addEventListener('click', () => (monitoring ? stopMonitoring() : startMonitoring()));
  el.clearBtn.addEventListener('click', clearResults);
  el.target.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !scanning) startScan();
  });
  el.search.addEventListener('input', applyFilter);

  el.thead.querySelectorAll('th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (sortKey === key) sortDir = -sortDir;
      else {
        sortKey = key;
        sortDir = 1;
      }
      el.thead.querySelectorAll('th').forEach((h) => h.classList.remove('sort-asc', 'sort-desc'));
      th.classList.add(sortDir === 1 ? 'sort-asc' : 'sort-desc');
      sortRows();
    });
  });

  // Row copy: IP cell -> IP, MAC cell -> MAC, anything else -> whole row as JSON.
  el.tbody.addEventListener('click', (e) => {
    const tr = e.target.closest('tr');
    if (!tr) return;
    const cell = e.target.closest('td.c-ip, td.c-mac');
    if (cell && !cell.classList.contains('muted')) {
      const text = cell.textContent.trim();
      if (text && text !== '—') {
        window.api.copy(text);
        cell.classList.add('copied');
        setTimeout(() => cell.classList.remove('copied'), 550);
        el.sbStatus.textContent = `Copied: ${text}`;
      }
      return;
    }
    // Otherwise copy the full host record as JSON.
    const rec = hostRows.get(tr.dataset.ipaddr);
    if (rec) {
      window.api.copy(JSON.stringify(rec.data, null, 2));
      tr.classList.add('copied-row');
      setTimeout(() => tr.classList.remove('copied-row'), 550);
      el.sbStatus.textContent = `Copied JSON: ${tr.dataset.ipaddr}`;
    }
  });

  $('#btn-min').addEventListener('click', () => window.api.winMinimize());
  $('#btn-max').addEventListener('click', () => window.api.winMaximize());
  $('#btn-close').addEventListener('click', () => window.api.winClose());

  wireMenus();
  $('#about-ok').addEventListener('click', hideAbout);
  $('#about-close').addEventListener('click', hideAbout);
}

// ---- Menu bar ---------------------------------------------------------------
const MENUS = {
  file: [
    { label: 'Export to CSV…', action: exportCsv },
    { label: 'Export to JSON…', action: exportJson },
    { label: 'Clear results', action: clearResults },
    { sep: true },
    { label: 'Exit', action: () => window.api.winClose() },
  ],
  scan: [
    { label: 'Start', action: () => !scanning && startScan(), enabled: () => !scanning },
    { label: 'Stop', action: () => scanning && cancelScan(), enabled: () => scanning },
  ],
  help: [{ label: 'About myNetwork…', action: showAbout }],
};

function wireMenus() {
  el.menubar.querySelectorAll('.menu').forEach((m) => {
    m.addEventListener('click', (e) => {
      e.stopPropagation();
      openMenu(m);
    });
  });
  document.addEventListener('click', closeMenu);
}

function openMenu(m) {
  const items = MENUS[m.dataset.menu];
  if (!items) return;
  if (m.classList.contains('open')) return closeMenu();
  closeMenu();
  m.classList.add('open');
  el.menuPopup.innerHTML = items
    .map((it, i) => {
      if (it.sep) return '<div class="sep"></div>';
      const disabled = it.enabled && !it.enabled() ? ' disabled' : '';
      return `<div class="mi${disabled}" data-i="${i}">${it.label}</div>`;
    })
    .join('');
  const r = m.getBoundingClientRect();
  el.menuPopup.style.left = `${r.left}px`;
  el.menuPopup.style.top = `${r.bottom}px`;
  el.menuPopup.classList.remove('hidden');
  el.menuPopup.querySelectorAll('.mi').forEach((mi) => {
    if (mi.classList.contains('disabled')) return;
    mi.addEventListener('click', (e) => {
      e.stopPropagation();
      const it = items[Number(mi.dataset.i)];
      closeMenu();
      if (it && it.action) it.action();
    });
  });
}

function closeMenu() {
  el.menuPopup.classList.add('hidden');
  el.menubar.querySelectorAll('.menu.open').forEach((m) => m.classList.remove('open'));
}

function showAbout() { el.aboutOverlay.classList.remove('hidden'); }
function hideAbout() { el.aboutOverlay.classList.add('hidden'); }

// ---- Mode explanation (status bar) ------------------------------------------
function updateModeInfo() {
  const mode = el.portset.value;
  // [protocol chip, active?, tooltip]
  let parts;
  if (mode === 'fast') {
    parts = [['ICMP', true, 'Host discovery (ping)'], ['TCP', true, 'Popular ports only'], ['UDP', false, 'Not scanned in Fast']];
  } else if (mode === 'custom') {
    const hasTcp = parsePortSpec(el.customTcp.value).length > 0;
    const hasUdp = parsePortSpec(el.customUdp.value).length > 0;
    parts = [
      ['ICMP', true, 'Host discovery (ping)'],
      ['TCP', hasTcp, hasTcp ? 'Custom TCP range' : 'No TCP ports entered'],
      ['UDP', hasUdp, hasUdp ? 'Custom UDP range' : 'No UDP ports entered'],
    ];
  } else {
    parts = [['ICMP', true, 'Host discovery (ping)'], ['TCP', true, 'All ports 1–65535'], ['UDP', true, 'Common UDP services']];
  }

  el.sbMode.innerHTML =
    '<span class="lbl">Mode:</span>' +
    parts
      .map(
        ([name, on, tip]) =>
          `<span class="mchip ${name.toLowerCase()} ${on ? 'on' : 'off'}" title="${esc(tip)}">${name}</span>`
      )
      .join('');
}

// ---- Scan control -----------------------------------------------------------
// Parse "22,80,8000-8100" into a sorted, de-duplicated list of ports.
function parsePortSpec(str) {
  const out = new Set();
  for (const tok of String(str || '').split(/[\s,;]+/)) {
    if (!tok) continue;
    const m = tok.match(/^(\d+)-(\d+)$/);
    if (m) {
      let a = +m[1];
      let b = +m[2];
      if (a > b) [a, b] = [b, a];
      for (let p = Math.max(1, a); p <= Math.min(65535, b); p++) out.add(p);
    } else {
      const n = parseInt(tok, 10);
      if (Number.isInteger(n) && n > 0 && n < 65536) out.add(n);
    }
  }
  return [...out].sort((x, y) => x - y);
}

async function startScan() {
  const target = el.target.value.trim();
  if (!target) return;
  const modeVal = el.portset.value;
  const cTcp = modeVal === 'custom' ? parsePortSpec(el.customTcp.value) : null;
  const cUdp = modeVal === 'custom' ? parsePortSpec(el.customUdp.value) : null;
  if (modeVal === 'custom' && !cTcp.length && !cUdp.length) {
    el.sbStatus.textContent = 'Custom: enter TCP and/or UDP ports first';
    return;
  }

  // Preserve keeps hosts from previous scans (new results upsert by IP);
  // otherwise wipe the list before scanning.
  if (el.preserve.checked) {
    el.progressFill.style.width = '0%';
    el.sbCount.textContent = '';
  } else {
    resetResults();
  }
  scanning = true;
  startedAt = Date.now();
  el.scanBtn.textContent = 'Stop';
  el.scanBtn.classList.add('scanning');
  el.empty.classList.add('hidden');
  startTimer();
  el.sbStatus.textContent = 'Starting…';

  await window.api.startScan({
    target,
    mode: modeVal,
    customTcp: cTcp,
    customUdp: cUdp,
    pingTimeout: Number(el.pingTimeout.value) || 1000,
    portTimeout: Number(el.portTimeout.value) || 700,
  });
}

async function cancelScan() {
  await window.api.cancelScan();
  finishScan({ cancelled: true });
}

function resetResults() {
  hostRows.clear();
  el.tbody.innerHTML = '';
  el.sbLive.textContent = '0 hosts';
  el.sbPorts.textContent = '0 ports';
  el.sbElapsed.textContent = '—';
  el.sbCount.textContent = '';
  el.progressFill.style.width = '0%';
}

function clearResults() {
  window.api.clearCache();
  resetResults();
  el.empty.classList.remove('hidden');
  el.sbStatus.textContent = 'Ready';
}

function startTimer() {
  clearInterval(timerId);
  timerId = setInterval(() => {
    el.sbElapsed.textContent = fmtElapsed(Date.now() - startedAt);
  }, 200);
}

function finishScan(info) {
  scanning = false;
  clearInterval(timerId);
  el.scanBtn.textContent = 'Start';
  el.scanBtn.classList.remove('scanning');
  // Mark any rows still flagged "scanning" as done.
  for (const { tr } of hostRows.values()) tr.classList.remove('scanning');
  if (info && info.elapsedMs != null) el.sbElapsed.textContent = fmtElapsed(info.elapsedMs);
  el.progressFill.style.width = '100%';
  const { live, ports } = stats();
  el.sbStatus.textContent = info && info.cancelled ? 'Scan stopped' : `Done — ${live} hosts, ${ports} open ports`;
  el.sbCount.textContent = '';
  if (hostRows.size === 0 && !(info && info.cancelled)) {
    el.empty.classList.remove('hidden');
    el.empty.querySelector('p').innerHTML = '<b>No active hosts found.</b> Check the range or raise the ping timeout.';
  }
}

// ---- CSV export -------------------------------------------------------------
function exportRows() {
  return [...hostRows.values()].map((v) => v.data);
}
async function exportCsv() {
  const rows = exportRows();
  if (!rows.length) return void (el.sbStatus.textContent = 'Nothing to export');
  const res = await window.api.exportCsv(rows);
  if (res && res.ok) el.sbStatus.textContent = `Exported → ${res.filePath}`;
  else if (res && res.error) el.sbStatus.textContent = `Export failed: ${res.error}`;
}
async function exportJson() {
  const rows = exportRows();
  if (!rows.length) return void (el.sbStatus.textContent = 'Nothing to export');
  const res = await window.api.exportJson(rows);
  if (res && res.ok) el.sbStatus.textContent = `Exported → ${res.filePath}`;
  else if (res && res.error) el.sbStatus.textContent = `Export failed: ${res.error}`;
}

// ---- Monitoring -------------------------------------------------------------
async function startMonitoring() {
  const hosts = [...hostRows.values()].map((v) => ({ ip: v.data.ip, ports: v.data.ports }));
  if (!hosts.length) {
    el.sbStatus.textContent = 'Nothing to monitor — run a scan first';
    return;
  }
  const res = await window.api.startMonitor(hosts);
  if (res && res.ok) {
    monitoring = true;
    el.monitorBtn.textContent = 'Stop';
    el.monitorBtn.classList.add('active');
    el.sbStatus.textContent = `Monitoring ${res.count} hosts · ICMP every 1 min · ports every 5 min`;
  }
}

async function stopMonitoring() {
  await window.api.stopMonitor();
  monitoring = false;
  el.monitorBtn.textContent = 'Monitoring';
  el.monitorBtn.classList.remove('active');
  el.sbStatus.textContent = 'Monitoring stopped';
}

// ---- IPC handlers -----------------------------------------------------------
function wireIpc() {
  window.api.onPhase((p) => {
    if (p.label) el.sbStatus.textContent = p.label + (p.cidr ? ` — ${p.cidr}` : '…');
  });
  window.api.onProgress((p) => {
    if (typeof p.overall === 'number') {
      const pct = Math.round(p.overall * 100);
      el.progressFill.style.width = `${pct}%`;
      el.sbCount.textContent = `${pct}%`;
    }
    if (p.label) el.sbStatus.textContent = p.label;
  });
  window.api.onHost((h) => upsertHost(h));
  window.api.onError((msg) => {
    el.sbStatus.textContent = `Error: ${msg}`;
    finishScan({ cancelled: true });
  });
  window.api.onDone((d) => finishScan(d));
  window.api.onWinState(() => {});

  // Monitoring updates for a known host (online/offline + periodic port re-check).
  window.api.onMonitorHost((u) => {
    const rec = hostRows.get(u.ip);
    if (!rec) return;
    const d = rec.data;
    d.available = u.online;
    if (u.online && u.rtt != null) d.rtt = u.rtt;
    if (u.portsUpdated && Array.isArray(u.ports)) {
      d.ports = u.ports;
      d.openCount = u.ports.length;
    }
    upsertHost(d);
  });
}

// ---- Rendering --------------------------------------------------------------
function ipToInt(ip) {
  const p = ip.split('.').map(Number);
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

function rowHtml(h) {
  const hostCell = h.hostname
    ? `<td class="c-host" title="${esc(h.hostname)}">${esc(h.hostname)}</td>`
    : `<td class="c-host muted">—</td>`;
  const macCell = h.mac ? `<td class="c-mac">${esc(h.mac)}</td>` : `<td class="c-mac muted">—</td>`;
  const vendorCell = h.vendor
    ? `<td class="c-vendor" title="${esc(h.vendor)}">${esc(h.vendor)}</td>`
    : `<td class="c-vendor muted">—</td>`;
  const unavail = h.available === false;
  const rttCell = unavail
    ? `<td class="c-rtt muted">offline</td>`
    : h.rtt != null
    ? `<td class="c-rtt">${h.rtt} ms</td>`
    : `<td class="c-rtt muted">—</td>`;

  let portsCell;
  if (h.ports.length) {
    portsCell = `<td class="c-ports"><span class="ports">${h.ports
      .map((p) => {
        const proto = p.proto || 'tcp';
        // Colour conveys the protocol (TCP green / UDP blue) — no per-chip label.
        const tip = `${p.port}/${proto.toUpperCase()}${p.service ? ' ' + p.service : ''}${p.banner ? ' · ' + p.banner : ''}`;
        return `<span class="port ${proto}" title="${esc(tip)}">${p.port}${
          p.service ? `<span class="svc">${esc(p.service)}</span>` : ''
        }</span>`;
      })
      .join('')}</span></td>`;
  } else if (h.scanning) {
    portsCell = `<td class="c-ports muted">scanning…</td>`;
  } else {
    portsCell = `<td class="c-ports muted">—</td>`;
  }

  const dotClass = unavail ? 'off' : h.openCount ? '' : h.scanning ? 'scan' : 'quiet';
  return `
    <td class="c-dot"><span class="dot ${dotClass}" title="${unavail ? 'Unavailable' : 'Online'}"></span></td>
    <td class="c-ip">${esc(h.ip)}</td>
    ${hostCell}${macCell}${vendorCell}${rttCell}${portsCell}
  `;
}

function upsertHost(h) {
  const existing = hostRows.get(h.ip);
  const tr = existing ? existing.tr : document.createElement('tr');
  tr.innerHTML = rowHtml(h);
  tr.classList.toggle('scanning', !!h.scanning);
  tr.classList.toggle('unavailable', h.available === false);

  tr.dataset.ip = String(ipToInt(h.ip));
  tr.dataset.ipaddr = h.ip;
  tr.dataset.host = (h.hostname || '~').toLowerCase();
  tr.dataset.mac = (h.mac || '~').toLowerCase();
  tr.dataset.vendor = (h.vendor || '~').toLowerCase();
  tr.dataset.rtt = String(h.rtt != null ? h.rtt : Number.MAX_SAFE_INTEGER);
  tr.dataset.ports = String(h.openCount);
  tr.dataset.portlist = ` ${h.ports.map((p) => p.port).join(' ')} `;
  tr.dataset.text = [
    h.ip,
    h.hostname || '',
    h.mac || '',
    h.vendor || '',
    ...h.ports.flatMap((p) => [p.port, p.service || '']),
  ].join(' ').toLowerCase();

  if (!existing) {
    tr.addEventListener('click', () => {
      el.tbody.querySelectorAll('tr.sel').forEach((r) => r.classList.remove('sel'));
      tr.classList.add('sel');
    });
    el.tbody.appendChild(tr);
    hostRows.set(h.ip, { tr, data: h });
    el.empty.classList.add('hidden');
  } else {
    existing.data = h;
  }
  applyFilterTo(tr);
  updateStats();
  scheduleSort();
}

function stats() {
  let ports = 0;
  for (const { data } of hostRows.values()) ports += data.openCount || 0;
  return { live: hostRows.size, ports };
}
function updateStats() {
  const { live, ports } = stats();
  el.sbLive.textContent = `${live} hosts`;
  el.sbPorts.textContent = `${ports} ports`;
}

const NUMERIC = new Set(['ip', 'rtt', 'ports']);
function sortRows() {
  const rows = [...el.tbody.children];
  rows.sort((a, b) => {
    const av = a.dataset[sortKey];
    const bv = b.dataset[sortKey];
    let c = NUMERIC.has(sortKey) ? Number(av) - Number(bv) : av < bv ? -1 : av > bv ? 1 : 0;
    if (c === 0) c = Number(a.dataset.ip) - Number(b.dataset.ip);
    return c * sortDir;
  });
  for (const r of rows) el.tbody.appendChild(r);
}

// Coalesce the many host events of a scan into one re-sort per animation frame.
// Without this, a host with N open ports triggers N full-table sorts as its
// ports stream in during the "all TCP" layer.
let sortScheduled = false;
function scheduleSort() {
  if (sortScheduled) return;
  sortScheduled = true;
  requestAnimationFrame(() => {
    sortScheduled = false;
    sortRows();
  });
}

function applyFilter() {
  for (const row of el.tbody.children) applyFilterTo(row);
}
function applyFilterTo(row) {
  const q = el.search.value.trim().toLowerCase();
  row.classList.toggle('hide', q && !rowMatches(row, q));
}
function rowMatches(row, q) {
  // Explicit exact-port filter: "port:8188", "p:22", ":443".
  const m = q.match(/^(?:port:|p:|:)\s*(\d+)$/);
  if (m) return row.dataset.portlist.includes(` ${m[1]} `);
  // Otherwise substring across IP / host / MAC / vendor / port numbers & services.
  return row.dataset.text.includes(q);
}

// ---- Helpers ----------------------------------------------------------------
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtElapsed(ms) {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}
function relTime(ts) {
  if (!ts) return 'earlier';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

init();

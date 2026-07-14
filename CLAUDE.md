# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

myNetwork is a cross-platform LAN & port scanner packaged as an Electron desktop app with a Windows XP (Luna) themed GUI. It discovers hosts on a subnet, resolves hostname/MAC/vendor, and reports open TCP/UDP ports. It runs on **plain Node with no native dependencies and no root** — that constraint is load-bearing, so avoid introducing native modules or privileged operations (raw sockets, etc.). Discovery uses `child_process` shellouts to platform `ping`/`arp`/`ip route`, and port probing uses ordinary `net`/`dgram` sockets.

## Commands

```bash
npm install
npm start              # electron .
npm run start:nosandbox  # if you hit a chrome-sandbox error on Linux
npm run dev            # --dev --no-sandbox, opens detached DevTools

make start             # runs in background (nohup, PID in .mynetwork.pid, logs to mynetwork.log)
make stop / restart / status
make help              # list targets

npm run dist:linux     # AppImage + deb   (electron-builder)
npm run dist:win       # NSIS
npm run dist:mac       # dmg
```

There is **no test suite and no linter**. CI (`.github/workflows/ci.yml`) only runs `node --check` on every `src/**/*.js`, so keep sources syntactically parseable by plain Node (no TypeScript, no bundler, CommonJS `require`). Releases build automatically when a `v*` tag is pushed (`release.yml`).

## Architecture

Standard Electron three-process split, all CommonJS:

- **Main** (`src/main.js`) — window creation (frameless, custom Luna title bar), all `ipcMain.handle` handlers, monitoring timers, CSV/JSON export dialogs, and the last-scan cache (`last-scan.json` in `app.getPath('userData')`).
- **Preload** (`src/preload.js`) — the entire main↔renderer contract. `contextBridge` exposes `window.api` with `contextIsolation: true` and `nodeIntegration: false`. Any new IPC channel must be added here in addition to `main.js` and the renderer; the renderer has no direct Node access.
- **Renderer** (`src/renderer/`) — `index.html`, `renderer.js`, `styles.css`. Vanilla JS/DOM, no framework. Maintains a `hostRows` Map (ip → row), handles sorting/filtering, and persists UI settings to `localStorage`.

The scanner core (`src/scanner/`) is pure Node, framework-free, and reusable independent of Electron:

- `net-utils.js` — target parsing: CIDR, comma-separated ranges, single IPs, `a.b.c.d-a.b.c.e`; interface detection.
- `discovery.js` — `ping`, `readArpTable`, `resolveHostname`, `defaultRoute` (platform shellouts).
- `ports.js` — `probePort` (TCP connect + banner), `probeUdp`, `serviceName`, and the port lists `DEFAULT_PORTS` / `COMMON_PORTS` / `UDP_PORTS` / `allTcpPorts()`.
- `oui.js` + `oui-db.txt` — offline IEEE OUI vendor lookup (`vendorForMac`); `oui-db.txt` is a large (~1.2 MB) generated data file.
- `index.js` — `Scan`, an `EventEmitter` that orchestrates everything.

### The Scan lifecycle (the part that needs multiple files to understand)

`Scan` (`src/scanner/index.js`) runs **layers** and streams results as an EventEmitter — it does not return a final list. Events: `phase`, `progress` `{overall, label}`, `host`, `error`, `done`.

Layers by mode:
- **fast** — ICMP discovery, then `DEFAULT_PORTS`.
- **full** (default) — ICMP discovery → `COMMON_PORTS` (fast feedback) → all remaining TCP 1–65535 → `UDP_PORTS`.
- **custom** — separate caller-supplied TCP and UDP port lists.

Each layer has a fixed progress **weight** (the `W` object, summing to 1) so the single progress bar advances smoothly across layers. Hosts and ports are emitted incrementally via `emitHost(ip)` as each layer discovers them; the same host is re-emitted (identified by `ip`) with more ports as later layers complete. `main.js` merges these by IP into a `collected` Map before caching.

Concurrency is bounded by the local `pool(items, concurrency, worker, onTick)` helper. Total simultaneous sockets are capped (`SOCKET_CAP = 800`): per-host port concurrency is derived from that cap divided by the number of concurrent host workers, so large port sweeps never exhaust file descriptors. Respect this cap when changing concurrency — raising it can crash the scan with FD exhaustion.

### Monitoring

Started via `monitor:start` in `main.js`, independent of `Scan`: pings known hosts every 60 s (online/offline OS notifications) and re-probes their TCP ports every 5 min, pushing `monitor:host` updates to the renderer.

## Conventions

- All source files start with `'use strict';`.
- Errors cross IPC as `{ ok: false, error }` result objects rather than thrown exceptions; cache/notification/export failures are swallowed as best-effort.
- CSV export in `main.js` guards against formula injection (`csvCell` prefixes `=+-@` cells with `'`) and writes a BOM for Excel — preserve this if editing export.

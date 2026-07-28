<!--
Thanks for contributing. The checklist below is short on purpose: it covers the
properties that make this app auditable, which reviewers cannot verify by
reading a diff quickly. `npm run audit` checks most of it mechanically.
-->

## What this changes

<!-- What problem does it solve, and how? Link the issue if there is one. -->

## How it was verified

<!-- Commands you ran, and anything you tested by hand (which OS, which network). -->

## Checklist

- [ ] `npm test`, `npm run lint` and `npm run audit` pass locally
- [ ] No new runtime `dependencies` and no native modules — the app ships with none, deliberately
- [ ] No npm lifecycle scripts (`preinstall`, `postinstall`, `prepare`, …)
- [ ] Nothing downloads or executes code at runtime, and no new outbound host is contacted
- [ ] No remote content rendered in a window, and `contextIsolation` / `nodeIntegration` are unchanged
- [ ] No encoded, minified or generated blobs; every literal is readable as written
- [ ] Any new IPC channel is added to `main.js`, `preload.js` and the renderer together
- [ ] Still runs unprivileged: no raw sockets, no root, no elevation prompts

If your change genuinely needs to cross one of these lines, say so explicitly in
the description and relax the corresponding rule in `scripts/audit-supply-chain.js`
in the same PR, so the exception is part of the review rather than a surprise.

# Security policy

## Reporting a vulnerability

Please use [private vulnerability reporting](https://github.com/ancaferro/myNetwork/security/advisories/new) rather than opening a public issue.

If you spot malicious code in an open pull request, the opposite applies — say so
publicly on that PR, since anyone running the branch needs to know. Reports of
that kind are welcome and will not be treated as noise, even if they turn out to
be a false alarm.

Include whatever you have: the file and line, what the code does, and how you
found it. A reproduction is helpful but not required.

## Supported versions

Fixes go into the latest release only. Installers are published as
[GitHub releases](https://github.com/ancaferro/myNetwork/releases) built by the
`release.yml` workflow from a tagged commit; nothing is published by hand.

## What this app deliberately does not do

myNetwork is a network scanner, so it is worth being precise about the parts that
are and are not by design. The app:

- ships **no runtime dependencies** and **no native modules** — plain Node only;
- needs **no root and no elevated privileges**, and opens **no raw sockets**;
- makes **no outbound connections of its own** — it never checks for updates,
  reports telemetry, or fetches remote content. Every packet it sends is a probe
  you asked for, to a target you supplied;
- resolves MAC vendors from a **bundled offline database** (`src/scanner/oui-db.txt`),
  not a lookup service;
- renders **local files only**, with `contextIsolation` on and `nodeIntegration`
  off; the renderer has no direct Node access.

`npm run audit` (`scripts/audit-supply-chain.js`) enforces these in CI on every
pull request, so a change that quietly removes one of them fails the build. The
guard is a tripwire rather than a proof — it catches the standard shapes, which
means anything unusual has to be argued for in review.

## Scope

Because the scanner probes hosts and ports, findings that amount to "this tool
can scan a network" are working as intended. Reports that are in scope include
anything that lets scan input reach a shell or the filesystem, escapes the
renderer sandbox, causes the app to execute code it did not ship with, or leaks
scan results off the machine.

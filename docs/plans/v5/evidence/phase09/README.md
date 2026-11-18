# Phase 09 browser evidence

Captured on 2026-11-11 with installed Google Chrome and locally cached
Playwright 1.62.1. The harness boots the real authenticated panel with a fresh
isolated data directory and no WhatsApp socket. All update and native Play
responses are fakes. External networking in the panel child is blocked by the
existing test preload. This is browser evidence, not real Play/device QA.

- `capture.mjs`: all four locales, desktop 1100×900 and phone 390×844, offline
  update result, no browser errors or horizontal overflow. Eight PNGs.
- `regressions.mjs`: 10 checks for late metadata, plain-text notes, no startup
  check, queued completion, explicit restart, shared native checks, synchronized
  consent, no review on automatic refresh, event-before-mount recovery and
  retained current-version metadata.

Run using Node 24 and an already installed Playwright module; no install or
browser download is performed by these scripts:

```sh
node docs/plans/v5/evidence/phase09/capture.mjs /path/to/playwright/index.mjs
node docs/plans/v5/evidence/phase09/regressions.mjs /path/to/playwright/index.mjs
```

Actual local module: `/tmp/levix-ui-qa/node_modules/playwright/index.mjs`,
restored and integrity-checked from the existing local pnpm content cache.
Logs: `/tmp/levix-phase09-ui.log`, `/tmp/levix-phase09-ui-regressions.log`.

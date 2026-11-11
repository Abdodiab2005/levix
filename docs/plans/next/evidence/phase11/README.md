# Phase 11A browser evidence

Run on 2026-11-11 using cached Node 24.22.2, installed Google Chrome and cached
Playwright 1.62.1. The script boots the real authenticated panel in an isolated
data directory. Every WhatsApp socket method and image fetch is a fake;
external networking is blocked. No real account, pairing or upload occurs.

19 checks pass: no profile reads on Overview; cached/lazy authenticated photo;
four locales at desktop 1100×900 and phone 390×844; RTL/LTR with no horizontal
overflow; cache reuse across locale reloads; explicit refresh; private fields;
disconnect; late old-account result; same-account reconnect; light/dark and no
browser errors. The first-run tour is marked complete only in the test browser.

Screenshots contain synthetic names, numbers and a single-pixel fixture image.
They are UI evidence, not real WhatsApp-device QA.

```sh
node docs/plans/next/evidence/phase11/browser-qa.mjs /path/to/playwright/index.mjs
```

Actual cached module used: `/tmp/levix-ui-qa/node_modules/playwright/index.mjs`.
Log: `/tmp/levix-phase11-browser.log`. The script installs/downloads nothing.

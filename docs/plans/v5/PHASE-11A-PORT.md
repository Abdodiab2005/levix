# Phase 11A — v5.0.0 port

## Owner decision and pre-edit audit (2026-11-13)

Task 05 moves the existing Connected WhatsApp Account Card into v5.0.0.
This supersedes the previous next-release-only restriction for 11A alone;
Phase 10 remains mandatory. Original PR #168 stays unchanged and open.

Fresh branch: `feat/v5-account-card`, from release HEAD
`c9b3f88` (`release/5.0.0-beta.1`). Source PR #168 head:
`2d5225b125e18b67cfd3f36f0c1971bf58db5adb`, diff from `40051f6`.
The release already contains Phase 09 and Gemini API-version/request-budget/
Undici fixes. It lacks the card. Apply only the source diff, not next-branch
history. Existing session, identity, account epoch, authenticated routes and
WhatsApp image transport match the source integration contract.

## Plan before implementation

- Port source service, route additions, two account-profile tests, card,
  ConnectionView, Avatar and its README, session type, four dashboard catalogs
  and review metadata. Regenerate translations and bundled public docs.
- Port README/PRIVACY additions and source plan/results/browser evidence as
  historical evidence under `docs/plans/next/`, explicitly superseded here.
- Update v5 SCOPE, PHASES, DECISIONS and CHANGELOG; annotate old Phase 09
  next-release restrictions as historical, superseded only for 11A.
- No dependency, migration, version, pairing or session-lifecycle change.
- Preserve RAM-only bounded profile/photo caches, auth/CSRF/no-store, verified
  phone/LID rules, socket/identity/epoch guards and four-language placeholders.
  Risks: stale cross-account responses and remote image exposure; existing
  fake service/panel tests exercise those boundaries. No live account use.
- Run account-profile and relevant session/frontend/Gemini regressions,
  frontend build, lint, i18n/docs checks. Full CI runs on the new Draft PR.
- Rollback: revert the port together; there is no persistent profile data or
  schema to undo. Desktop/headless/Android interfaces remain unchanged.

## Results

Pending validation. Source results are historical, not proof of this port.

## Port validation — 2026-11-14

| Result | Command / scope | Evidence |
| --- | --- | --- |
| PASS | `node tests/run.mjs account-profile`, Linux x64, Node 24.22.2 | 214 checks, 0 failed, 0 crashed (134 service + 80 authenticated panel) |
| PASS | `node docs/plans/next/evidence/phase11/browser-qa.mjs /home/abdo/Documents/prometric-hybrid/node_modules/playwright/index.mjs`, Linux x64 | 19 browser checks; four locales, desktop/mobile, light/dark, cache, privacy, disconnect, stale response and reconnect |
| PASS | `npm run build:frontend`, Linux x64 | TypeScript and Vite build pass; pre-existing large-chunk warning |
| PASS | `npm run lint`, Linux x64 | Exit 0; repository reports existing warnings/infos |
| PASS | `npm run i18n:check`; `npm run docs:check`, Linux x64 | Both pass |
| PASS | `node tests/run.mjs gemini session connection`, Linux x64, Node 24.22.2 | 143 Gemini checks, 0 failed; confirms Gemini media and request-budget fixes on release base |
| PASS | `git diff --check c9b3f88..HEAD` | No whitespace errors |
| PENDING | Full GitHub CI for the new Draft PR | GitHub runs after PR creation |
| NOT RUN | Dedicated real-account/device and oldest-WebView QA | No live account was used |

Port commit `3ecab26` is based directly on release HEAD `c9b3f88`. The source
implementation files are carried from PR #168; scope documentation and the
results record are the port-specific changes. The Gemini fixes remain in the
base history at `82508f8` and `73a679f`.

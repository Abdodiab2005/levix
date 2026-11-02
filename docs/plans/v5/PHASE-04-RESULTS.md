# Phase 04: React gateway and Terms consent

Status: 04a and 04b IMPLEMENTED 2026-11-02 on `main` 407bf1e, in review. Owner decisions Q-03, Q-04, Q-05 and Q-17 recorded
the same day (ADR-006, ADR-019, ADR-020). This file holds the re-audit, the plan and, later, the
results. The contract lives in `LEGAL_CONSENT_CONTRACT.md`.

## 1. Re-audit of the current tree (main 407bf1e, 2026-11-02)

| ID | Fact | Evidence | Consequence |
| --- | --- | --- | --- |
| A-01 | `WhatsAppSession.#open()` is still the only socket builder. `start()` and the retry timer both call it. | `src/core/session.js:442`, `:571`, `:1045` | The gate goes at the top of `#open()` (ADR-006). |
| A-02 | Callers that reach `#open()`: boot policy, panel Start, Reconnect, network restore, `!restart`, restore activation. | `src/bootstrap/core.js:92`, `src/routes/dashboard.api.esm.js:1773`, `:1799`, `src/core/session.js:405`, `src/commands/restart.cjs:33`, `src/backup/jobs.cjs:17` | Each gets a test that ends in `consent_required` with zero sockets. |
| A-03 | Android starts Node in panel mode through `host-boot.mjs`; there is no separate Android start path into the session. | `android/host-boot.mjs:91` (`start({ headless: false })`), `LevixHostService.kt:139` | The backend gate covers Android. Android only needs to show the new state. |
| A-04 | Docker runs panel mode (`CMD ["node", "bin/levix.js"]`). | `Dockerfile` last line | Docker operators accept in the panel or with the provisioning command through `docker compose exec`. |
| A-05 | Headless exits for the supervisor on `logged_out`, `retry_exhausted`, `disconnected` and `error`; any other state prints nothing. | `src/index.js:137` to `:156` | `consent_required` must print the commands and must not exit, or systemd would restart it in a loop. |
| A-06 | Nothing holds the event loop in headless once no socket exists. | comment at `src/core/session.js:1052` | The consent re-check timer stays ref'd while waiting, and stop and shutdown cancel it. |
| A-07 | `parseArgv` treats `--version` as the global version flag and stores no flag values except skipping `--data`. | `src/cli.js:84` to `:103`, `:184` | The provisioning flag is `--terms-version`, and `parseArgv` learns to keep flag values. |
| A-08 | Settings export reads only `setting:*` keys from the dashboard source. | `src/services/settingsTransfer.cjs` | `legal:acceptance` never travels in an export. |
| A-09 | Backups export and restore only `RESTORABLE_BOT_KEYS`; restore writes only those keys. | `src/backup/content.cjs:18`, `src/backup/create.cjs:197`, `src/backup/restore.cjs:124` | `legal:acceptance` never travels in a backup. A test pins both directions. |
| A-10 | The pre-migration copy keeps every `bot_settings` row except `auth:*`, `secret:*` and secret settings. | `src/db/copy.cjs:10` to `:13` | The record stays in the local copy (allowed: local, not secret). |
| A-11 | Unlink clears account state but not `bot_settings` keys outside the listed ones; `levix reset-password` deletes only `auth:password`. | `src/core/session.js` `clearAccountScopedState`, `src/cli.js:198` | Q-17 holds without code changes there; tests pin it. |
| A-12 | `levix-ui` serves `/terms` and `/privacy` as HTML only; its API routes are crash-reports, feedback, recovery-email and traffic. | `levix-ui` origin/main f2ca096 | No versioned legal API exists. 04c writes the contract and a mock; the real endpoint and the key wait for the owner (ADR-019). |
| A-13 | The gateway pages are four EJS views; `/` falls back to `views/dashboard.ejs` when `public/dashboard/index.html` is missing. | `app.cjs:235`, `:314` to `:331`, `:464` | 04d and 04e; unchanged in 04a and 04b. |
| A-14 | Existing gateway and auth tests: `gateway-views`, `opaque-origin-auth`, `panel`, `panel-session-store`, `password-reset`, `setup-boundary`, `setup-code`. | `tests/` | 04d reruns all of them against the React gateway. |
| A-15 | Six test files build a `WhatsAppSession` and start it: `session`, `proxy`, `backup-activation`, `auto-delete`, `security-remediations`, `sticker-library`. | `grep -l "new WhatsAppSession" tests/` | The consent check is injectable; those tests pass an allowing check. |

## 2. Plan

### 2.1 Scope

In: the consent gate and record (04a), the panel consent dialog and API with the documents in four
locales (04b), the signed remote client (04c, partly BLOCKED), the React gateway (04d) and the EJS
removal (04e). Out: emergency remote disconnects (Q-05), any consent upload or analytics, any
change to pairing credentials, any WhatsApp command for consent.

### 2.2 Slices

| PR | Content | Merge rule |
| --- | --- | --- |
| 04a | `src/legal/` (bundled English release, canonical hash, acceptance record), `consent_required` in `WhatsAppSession`, headless lines, `levix terms` (`show`, `status`, interactive accept, `accept --terms-version --sha256`, `revoke`), tests | merges with 04b |
| 04b | `GET /dashboard/api/legal/terms`, `POST /dashboard/api/legal/accept` (session and same-origin checks, immediate session re-check), React consent dialog, Connection screen and Android home, sheet and notification state, documents in `ar`, `pt-BR`, `es-419` (draft until legal and ChatGPT review), UI strings in `i18n/` | merges with 04a |
| 04c | signed remote client: fetch with timeout and byte cap, Ed25519 verify, no downgrade, cache in the data directory, contract tests with a local fake server; `levix-ui` endpoint PR in that repository | BLOCKED on the owner's key; the client stays off with an empty key list |
| 04d | React login, setup, QR and recovery screens; server routes and checks unchanged; every current auth test plus new negative tests | EJS still served as fallback |
| 04e | EJS removal, a static safe shell when the build is missing, `PRIVACY.md`, `SETUP.md`, `PACKAGING.md`, `LEGAL_COPY_REVIEW.md` for shipped behaviour, Data safety review note | last |

### 2.3 Files (04a)

New: `src/legal/document.cjs` (validation and canonical bytes), `src/legal/bundled/en.json` (the
release), `src/legal/terms.cjs` (current release per locale), `src/legal/consent.cjs` (record and
status), `src/legal/cli.cjs` (`levix terms`), `tests/legal-consent.test.mjs`,
`tests/session-consent.test.mjs`. Changed: `src/core/session.js`, `src/index.js`, `src/cli.js`,
`src/config/exit-codes.cjs`, the six test files in A-15, `tests/cli.test.mjs`,
`docs/plans/v5/LEGAL_CONSENT_CONTRACT.md`, `docs/plans/v5/LEGAL_COPY_REVIEW.md`.

### 2.4 Migrations and compatibility

No schema migration. One `bot_settings` key, `legal:acceptance`. A v4.9.x install upgrades in place:
its pairing stays, the boot policy still says `resume-paired`, and the session waits in
`consent_required` until the operator accepts. A v4 build that opens the database later ignores the
key.

### 2.5 Threats and controls

| Threat | Control | Test |
| --- | --- | --- |
| A start path skips the gate | gate at the top of `#open()` | every caller in A-02 ends in `consent_required` with zero sockets |
| A forged or changed record unlocks a start | the record must match the current version, the current content hash for its locale and the running app version | mismatch cases in `legal-consent` |
| An unattended install accepts text nobody read | no start flag, no environment variable; provisioning needs the exact version and hash | `cli` tests: missing values, wrong hash, wrong version refused |
| Interactive accept from a pipe | `levix terms` refuses when stdin or stdout is not a TTY | spawn test with piped stdin |
| The record leaves the device | not in `setting:*`, not in `RESTORABLE_BOT_KEYS`; no network call in `src/legal/` for 04a | export, backup and restore tests; a test that fails on any `fetch` during consent |
| The gate locks out an offline user | the bundled release is always acceptable offline | offline first start test |
| A changed document goes unnoticed | the hash covers every field of the locale document; a test pins the bundled hash | pinned-hash test |
| Remote text injects script or links (04c) | plain strings in a fixed schema, signature, size and count limits, links from code | 04c tests |

### 2.6 Privacy impact

The record holds the app version, the Terms version, the content hash, the locale, the time and how
it was given. No identifier. Nothing is uploaded in 04a. `PRIVACY.md` changes only in 04e, after
the panel flow ships, to describe the local record and the remote Terms fetch (04c), which sends a
request to `levix.leviro.net` with no identifier and no body.

### 2.7 Rollback

Revert 04a and 04b together. No data cleanup is needed: a build without the gate ignores
`legal:acceptance`.

### 2.8 Acceptance for 04a and 04b

- No socket is created on any path in A-02 without a valid record.
- A connected socket stays up after the record becomes invalid; the next `#open()` waits.
- Unlink, password reset and restart keep the record; a new app version or a changed document asks
  again.
- Settings export, backup and restore never carry the record.
- Headless prints the commands and starts WhatsApp within 5 seconds of a CLI acceptance.
- The panel shows the documents in all four locales and records an acceptance only for the version
  and hash it displayed.
- `npm test`, `npm run lint`, `npm run build:frontend`, `npm run i18n:check` and the Android unit
  tests pass.

## 3. Results

### 3.1 Who wrote what (04a and 04b)

| Branch | Content | Implementer |
| --- | --- | --- |
| `feat/04a-consent-gate` | first draft of `src/legal/`, the gate and `levix terms` (commit 8efc99b) | orchestrator draft, kept on the owner's instruction |
| `feat/04a-session` | gate fixes, `tests/session-consent.test.mjs`, allowing checks in existing tests | Codex |
| `feat/04a-legal` | CLI fixes, `tests/legal-consent.test.mjs`, `levix terms` and headless tests, review fixes | Grok |
| `feat/04b-panel` | panel API, React dialog, Connection card, 17 dashboard strings | Codex |
| `feat/04b-android` | home card, status sheet, tile, notification and alert, 6 strings | OpenCode (deepseek-v4.1-flash-free) |
| `feat/04b-legal-i18n` | Terms and Privacy Notice in `ar`, `pt-BR`, `es-419` | Antigravity (Claude Sonnet 5.5) |

A read-only Codex review of both branches found 0 P1, 3 P2 and 3 P3 defects. All six are fixed:
the strict record shape, the own-key locale lookup, the Android alert lifecycle, the attention colour
and two test weaknesses.

### 3.2 Gates (local, Linux x64, Node v24.22.2, 2026-11-02)

| Gate | 04a f34a2bd | 04b fe7ae34 |
| --- | --- | --- |
| `npm test` | PASS, 8665 checks, 0 failed | PASS, 8712 checks, 0 failed |
| `npm run lint` | PASS, 0 errors | PASS, 0 errors |
| `npm run i18n:check` | PASS | PASS |
| `npm run build:frontend` | not changed | PASS |
| Android `:app:testDebugUnitTest` | not changed | PASS, 75 tests |
| Android `:app:assembleDebug` | not changed | PASS, arm64 64,733,918 B, armv7 59,818,752 B |
| CI | NOT RUN | NOT RUN |
| Device QA (Android consent flow, update path) | NOT RUN | NOT RUN |
| Docker, SEA and tarball validators | NOT RUN | NOT RUN |

### 3.3 Open items

- Legal review of the English text and the three translations (`LEGAL_COPY_REVIEW.md`).
- ChatGPT review of the new `pt-BR` and `es-419` dashboard and Android strings (Q-19); both files
  are `draft` in `i18n/review.json`.
- 04c waits for the owner's signing key and the `levix-ui` endpoint; 04d and 04e follow.

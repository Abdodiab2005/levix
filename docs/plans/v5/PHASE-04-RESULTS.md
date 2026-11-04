# Phase 04: React gateway and Terms consent

Status: 04a to 04d MERGED to `main` on 2026-11-04 through #131 (merge commit `0fff4ca`), which
integrates #125 to #129 in one merge (section 3.13). 04e (#130) is open as a draft and is not merged.
Owner decisions Q-03, Q-04, Q-05 and Q-17 are recorded in ADR-006, ADR-019 and ADR-020. The contract lives in `LEGAL_CONSENT_CONTRACT.md`.

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

Evidence labels: PASS, FAIL, NOT RUN or BLOCKED, each with the command, platform, commit and date.
"Local" means Linux x64, Node v24.22.2, npm 11.19.1. CI means the `ci.yml` workflow on GitHub.

### 3.1 Pull requests (state on 2026-11-02)

| PR | Branch | Base | Head | CI on that head | Merged |
| --- | --- | --- | --- | --- | --- |
| #125 plan | `docs/v5-phase-04-plan` | `main` | 32a4b59 | PASS 7/7, run 41451742790 | no |
| #126 04a | `feat/04a-consent-gate` | #125 | 51d0051 | PASS 7/7, run 41494231560 | no |
| #127 04b | `feat/04b-consent-ui` | #126 | 5fecb1d (documents on top of 898193f) | PASS 7/7 on 5fecb1d, run 41501993838; on 898193f, run 41494234796 | no |
| #128 04c | `feat/04c-remote-terms` | #127 | 6731d23 (merge of #127 into 4267edb) | PASS 7/7, run 41502096276 | no |
| #129 04d | `feat/04d-react-gateway` | #127 | 1fb92f1 | PASS 7/7, run 41503237658; the first run failed `validate:sea` on 3 OS (fixed in 1fb92f1) | no |
| #130 04e | `feat/04e-ejs-removal` | #129 | 3c66a3a | PASS 7/7, run 41504217295; the first run failed one `tests` check (fallback credit links, fixed in 3c66a3a) | no (draft) |
| levix-ui #23 | `feat/legal-release-endpoint` | `main` | 7d52df0 | not in CI; local gates in 3.4 | no (draft) |

The earlier heads also passed CI 7/7: #126 f34a2bd (run 41451749569) and #127 65b793e (run
41451757047). The seven jobs are `tests`, `package installs and boots` (tarball), `executable
runs` on ubuntu, macos and windows (SEA), `container persists its volume` (Docker) and `android
apk builds` (unit tests, debug and release APKs, AAB).

### 3.2 Who wrote what

| Change | Commit | Implementer |
| --- | --- | --- |
| 04a first draft: `src/legal/`, the gate, `levix terms` | 8efc99b | orchestrator draft, kept on the owner's instruction |
| 04a gate fixes and session tests | `feat/04a-session` | Codex |
| 04a CLI fixes, consent, `levix terms` and headless tests | `feat/04a-legal` | Grok |
| 04b panel API, dialog, Connection card | `feat/04b-panel` | Codex |
| 04b Android home card, sheet, tile, notification | `feat/04b-android` | OpenCode (deepseek-v4.1-flash-free) |
| 04b documents in `ar`, `pt-BR`, `es-419` | `feat/04b-legal-i18n` | Antigravity (Claude Sonnet 5.5) |
| Review fix A: platform-aware release identity | 51d0051 | Grok |
| Review fix C: dialog retry, stale guards, refresh after accept | 5e120d4 | Codex |
| Review fix D: Android alert policy | 263a35c | OpenCode (deepseek-v4.1-flash-free) |
| Review fix E: factual corrections to the four documents | 1d34a86 | Antigravity (Claude Sonnet 5.5); review by Antigravity, read-only |
| Review fix B: these documents | on #127 | orchestrator |
| 04c signed remote Terms client | c167565 | Grok |
| 04d React gateway | e008ad8 | Codex |
| levix-ui release endpoint | 7d52df0 | OpenCode (glm-5.3-flash-free) |

The orchestrator wrote the briefs, ran every gate and reviewed every diff. The first review round
(before 2026-11-02 evening) was a read-only Codex review: 0 P1, 3 P2, 3 P3, all fixed in f34a2bd.

### 3.3 Owner review findings and fixes (2026-11-02)

| Finding | Problem | Fix | Proof |
| --- | --- | --- | --- |
| A, high | Consent compared `package.json` only. A Play update with a new `versionCode` and the same `package.json` kept the old acceptance. | Release identity `<version>+android.<versionCode>` from `levix-build.json`, written into the app archive by the stage script from Gradle's `versionCode`; Gradle re-stages on a bump; a broken file fails closed. npm, Docker, SEA and headless keep the plain version. | `tests/release-identity.test.mjs` 42 PASS; `tests/legal-consent.test.mjs` scenarios for bump, downgrade, desktop update, restart, unlink, reset, plain record on Android, invalid and unreadable file; `levix-app.zip` holds `{"schema":1,"platform":"android","versionCode":69}` |
| B | This file claimed "implemented on `main`" and "CI NOT RUN"; the gate table named fe7ae34 while the PR head was 65b793e. | Rewritten: PR state, CI runs, commits, and evidence labels. | this section |
| C | The dialog had no retry, a stale socket snapshot could hide a later `consent_required`, and acceptance waited for a socket push. | Retry, request ids for load and accept, a backend refresh after accept, an override that ends when the socket moves on, a labelled spinner. | `tests/legal-dialog.test.mjs` 13 PASS; headless Chrome run, 25/25 PASS (3.5) |
| D | Offline and WhatsApp-failure alerts came back every 30 s after a dismissal and stayed after the condition ended without `connected`. | `AlertPolicy`: post once per condition, cancel when it ends. | `AlertPolicyTest` 12 PASS |
| E | The documents described the app wrongly in 10 places (one BLOCKER: uninstall on non-Android). | Factual corrections in four locales, no obligation changed; open legal questions listed. | `LEGAL_COPY_REVIEW.md` sections 3 and 7 |

### 3.4 Gates

| Gate | 04a 51d0051 | 04b 898193f | 04c 4267edb | 04d 048f233 | levix-ui 7d52df0 |
| --- | --- | --- | --- | --- | --- |
| `npm test` | PASS (CI) | PASS local, 8786 checks, 0 failed | PASS local, 8911, 0 failed | PASS local, 9007, 0 failed | PASS local, 80 tests |
| `npm run lint` | PASS (CI) | PASS local, 0 errors | PASS local, 0 errors | PASS local, 0 errors | PASS local (eslint, changed files) |
| `npm run i18n:check` | PASS (CI) | PASS local | PASS local | PASS local | n/a |
| `npm run build:frontend` | n/a | PASS local | PASS local | PASS local | `npm run build` PASS local |
| Android `:app:testDebugUnitTest` | PASS local, 74 tests | PASS local, 87 tests | PASS local, 87 | PASS local, 87 | n/a |
| Android `:app:assembleDebug` | PASS local | PASS local | PASS local | PASS local | n/a |
| Tarball, SEA (3 OS), Docker, APK and AAB | PASS (CI run 41494231560) | PASS (CI run 41501993838) | PASS (CI run 41502096276) | PASS (CI run 41503237658) | n/a |
| Android device QA | NOT RUN | NOT RUN | NOT RUN | NOT RUN | n/a |
| Live endpoint smoke | n/a | n/a | n/a | n/a | NOT RUN |

Local Android builds are debug builds; their sizes are not release or Play sizes.

### 3.5 Manual and headless QA

- Consent dialog, headless Chrome (`/usr/bin/google-chrome`, Linux) against a scratch Levix built
  from 5e120d4, 2026-11-02: PASS 25/25. First install shows `terms_not_accepted`; Start leaves the
  session in `consent_required`; the dialog opens; Accept stays disabled until the box is
  checked; Escape closes it; the Connection card reopens it; the state label reads "Terms
  acceptance required"; a blocked request shows the load error and Retry loads the document; a
  tampered accept body gets 409, the changed notice and a cleared box, and the session stays
  gated; Arabic renders `rtl`; accepting in Arabic records `locale: "ar"` with the shown version,
  the session leaves `consent_required` at once, and the dialog stays closed.
- React gateway, headless Chrome against 04d, 2026-11-02: PASS 23/24. Setup, password mismatch,
  sign-in, sign-out, login, 401 on a wrong password, blur on window blur, blank print, recovery by
  WhatsApp with no session, Arabic `rtl`, the QR page signed in, and `/qr` signed out all pass.
  The failed check is the runtime "no remote resource" check: the dashboard SPA at `/` loads
  Google Fonts (`LEGAL_COPY_REVIEW.md` section 4). A static check of the built `gateway.html`
  and its gateway assets finds no remote reference.
- Incident: in the first dialog run (2026-11-02 17:28 UTC) the script set the WhatsApp proxy with
  a wrong request body, so after Accept the scratch Levix opened one unpaired socket to WhatsApp's
  servers for about 2 seconds and received a pairing QR. No number was used, nothing was paired,
  and the process was stopped. The script now seeds the proxy (`socks5://127.0.0.1:9`) in the
  database before boot and aborts before Start unless the proxy is in effect; later runs ended
  in `ECONNREFUSED 127.0.0.1:9` with no QR.
- Not a device test: none of this ran in the Android WebView.

### 3.6 Phase 04 slices after the review

| Slice | PR | Content | Review | Local gates | State |
| --- | --- | --- | --- | --- | --- |
| 04c signed remote Terms | #128 (`feat/04c-remote-terms`, 4267edb) | Ed25519 envelope check, HTTPS fetch with no redirect, 5 s timeout and size cap, atomic verified cache, no downgrade, owner script, contract section 8 | Codex, read-only: no signature bypass; 3 P1 (owner script, test cleanup), 2 P2 (short write, stale memo), 1 P3; all fixed in 4267edb | PASS on 4267edb: `npm test` 8911 checks, 0 failed (`legal-remote` 113); lint, i18n, frontend build; Android 87 tests and debug build | Implemented and shipped off (`TRUSTED_KEYS` empty). BLOCKED on the owner: key, signed envelope, levix-ui #23 deploy, `PRIVACY.md` row, new notice version |
| levix-ui endpoint | levix-ui #23 (draft, 7d52df0) | `GET /api/legal/v1/release` serves the committed envelope, 404 until one exists, 503 on a bad shape | orchestrator | PASS: `npm test` 80, `tsc`, eslint, `npm run build` | Draft; deploy is harmless (404) |
| 04d React gateway | #129 (`feat/04d-react-gateway`, 048f233) | Login, setup, QR and recovery in React with unchanged server checks; EJS fallback kept | Grok, read-only: 0 P1, 3 P2 (no recovery timeout, stale confirm state, stylesheet gate), 4 P3; all fixed in bb33c6f; root tests made free of `react` in 048f233 | PASS on 048f233: `npm test` 9007 checks, 0 failed; lint, i18n, frontend build; Android 87 tests and debug build; headless Chrome 23/24 (3.5) | Implemented; SEA validator updated in 1fb92f1 (local `validate:sea` 51 checks PASS); Android WebView QA NOT RUN |
| 04e EJS removal | #130 (`feat/04e-ejs-removal`, draft, 3c66a3a) | EJS views, legacy gateway scripts and the `ejs` dependency removed; code-owned static fallback with the credit links when the build is missing; docs | orchestrator | PASS on 3c66a3a: `npm test` 9012 checks, 0 failed; `build:sea` plus `validate:sea` 51 checks; lint 0 errors; no-build curl smoke (302 to /setup, 200 form, 400 mismatch) | Draft. Merge only after Android WebView QA of 04d (R-27) |

04e was started by Antigravity, which stopped after about three minutes with no report; OpenCode
then hit its free-tier limit at once, and Codex finished it from the partial diff.

### 3.7 Not run, blocked and open

- NOT RUN: Android device QA of the consent flow, the update path (install a build with a higher
  `versionCode` over a build that has an acceptance) and the alerts; Android WebView QA of the
  React gateway on the oldest supported WebView (R-27); a live smoke of the levix-ui endpoint.
- NOT RUN: ChatGPT language review (Q-19) of the new `pt-BR` and `es-419` strings. Dashboard keys
  `consent_required` and `legal*` (17), Android keys `status_terms`, `notif_terms_title`,
  `notif_terms_text`, `home_terms`, `home_terms_body`, `home_review_terms`, and the `pt-BR` and
  `es-419` legal documents. `i18n/review.json` keeps the four catalogs `draft`.
- NOT RUN: human legal review (`LEGAL_COPY_REVIEW.md` section 7 lists 14 questions).
- BLOCKED (owner): turning on the remote Terms client needs the owner's Ed25519 key generated
  outside both repositories, the public key in `src/legal/keys.cjs`, a signed envelope committed
  to levix-ui, the levix-ui endpoint deployed, a `PRIVACY.md` row and a new notice version.
- Owner decisions: Google Fonts in the dashboard (self-host, system fonts, or disclose); whether a
  translation must say that the English text prevails; aligning `PRIVACY.md` section 8 ("continued
  use means acceptance") with Terms 7.1.
- Compatibility: two non-Android builds with the same `package.json` version share one release
  identity, for example a source checkout at different commits. Official releases always bump it.
- Observation, not changed: the CI `tests` job comment says the suite talks to WhatsApp's servers
  up to the pairing boundary, which the v5 rule "no live side effects" does not allow. This
  predates Phase 04.

### 3.8 Follow-up after owner decisions (2026-11-02)

This section supersedes the open decisions and status in 3.6–3.7. PR #128 carries the validated
public key and an explicit disabled remote-fetch gate; a signed release, endpoint deployment and
human legal/privacy approval remain prerequisites for activation. PR #129 adds QR script error
and retry handling. PR #130 remains draft and adds locally hosted fonts, the versioned privacy
correction and the reviewed translations. The standalone `PRIVACY.md` is not read at runtime:
future policy changes must also version the bundled notice so installations are asked again.
No English-prevails clause was added. Machine language review is not legal approval or native
speaker certification.

The headless and connection tests now use fake Baileys sockets, and the suite preloads a guard
against external TCP/UDP. The updated #128 and #129 remain siblings; merging the updated #128
and #130 trees produced the same tree tested locally (integration tree `e00219c`, Linux,
2026-11-02). No production WhatsApp connection or device test was made in this follow-up.

| Gate | Result on that integration tree |
| --- | --- |
| `npm test`, Node 24.22.2 | PASS: 9,204 checks, 0 failed, 0 crashed |
| `npm run lint`, `npm run i18n:check`, `npm run build:frontend` | PASS (lint reported warnings) |
| Android `:app:testDebugUnitTest :app:assembleDebug :app:assembleRelease`, offline | PASS: 87 unit tests; both APK ABIs |
| Android `:app:bundleRelease`, offline | PASS on retry after freeing temporary disk space; local build only |
| `npm run validate:tarball` | PASS: 36 checks, using a loopback mirror of the cached FFmpeg binary and no external test traffic |
| `npm run build:sea` and `npm run validate:sea` | PASS: 51 checks, Linux x64, Node 24.22.2 |
| `npm run validate:docker` | BLOCKED locally: Docker socket permission denied. GitHub CI passed the Docker job on #128, #129 and #130. |
| Android device and WebView QA | NOT RUN: owner device and instruction required. |

Human legal/privacy review remains a release blocker. The remote client remains disabled; no legal
document has been approved or published, and the owner's private signing key was not accessed.

### 3.9 Follow-up: simultaneous startup lock (2026-11-02)

CI run 41526919711 failed `start-order.test.mjs`: both simultaneous fresh starters could report
`ELEVIXLOCKED`, leaving no winner. The race was reproduced with isolated child processes. Two
SQLite connections could both fail while promoting their locks; merely adding SQLite's busy timeout
did not eliminate it. The fix closes a busy candidate and retries a bounded number of times with a
short stagger; SQLite remains the single-instance authority, and persistent contention still fails
closed. No database migration or lock-file format changes.

On Linux, Node 24.22.2, 2026-11-02, integration commit `88e5483`: PASS `node tests/run.mjs
start-order` (136 checks), PASS `node tests/run.mjs lock` (18 checks), and PASS 100 independently
created simultaneous startup pairs (zero pairs without exactly one holder). The focused test also
injects transient and persistent SQLite-busy errors to check connection cleanup and the retry bound.
The full gates in 3.8 refer to the preceding tree. They were rerun for the lock change:

| Gate | Result on integration commit `88e5483` (Linux x64, Node 24.22.2, 2026-11-02) |
| --- | --- |
| `npm test`, external network guard preloaded | PASS: 9,212 checks, 0 failed, 0 crashed |
| `npm run lint` | PASS: 0 errors (190 warnings, 67 infos) |
| `npm run i18n:check`, `npm run build:frontend` | PASS |
| Android `:app:testDebugUnitTest :app:assembleDebug :app:assembleRelease :app:bundleRelease`, offline | PASS: 87 unit tests, 0 failures; both APK ABIs; local AAB; `levix-build.json` versionCode 69 |
| `npm run build:sea` and `npm run validate:sea` | PASS: 51 checks, 0 failed |
| `npm run validate:tarball` | PASS: 36 checks, 0 failed (loopback FFmpeg mirror, external network guard) |
| `npm run validate:docker` | BLOCKED locally (Docker socket permission). CI job PASS on #130 `2136f83` |
| GitHub CI on #128 `a9b5e88`, #129 `badb756`, #130 `2136f83` | PASS: 7/7 jobs on each |

The merge of the #128 and #130 heads differs from `88e5483` only in this file and
`LEGAL_COPY_REVIEW.md`; the code is identical.

### 3.10 Manual device QA (2026-11-03)

Owner-authorized live test. Device: Redmi 9 (`lancelot`), LineageOS, Android 14 (API 34), arm64,
system WebView `com.android.webview` 120.0.6099.230. Build: merge of #130 `594ba9f` and #128
`a9b5e88` (code identical to `88e5483`), isolated debug APK `net.leviro.levix.dev`
(`-PlevixIsolatedDebug=true`), versionCode 69, then a local-only build with versionCode 70. The
production `net.leviro.levix` 4.8.0 on the device was not touched. No WhatsApp account was paired;
the session reached WhatsApp only to fetch QR codes.

| Check | Result |
| --- | --- |
| Fresh install, first Start: dialog before any socket; no TCP socket for the app's uid; state `consent_required` | PASS |
| Dialog close keeps `consent_required`; Connection shows "Review terms"; home card and one alert notification appear | PASS |
| Accept is disabled until the box is ticked; accept records `2026-11-02.1`, locale `ar`, `4.9.2+android.69`; QR follows | PASS |
| Force-stop and relaunch: no new prompt; Start goes straight to QR | PASS |
| Unlink (unpaired) and Start again: no new prompt | PASS |
| `adb install -r` versionCode 70 over 69: data kept, consent `app_updated`, dialog on Start, alert shown; accept records `4.9.2+android.70`; alert cleared | PASS |
| `/qr` with `qrcode.min.js` blocked (CDP): error and Retry; Retry after unblocking loads both libraries and clears the error | PASS |
| Dashboard and gateway: no request leaves `127.0.0.1:3001`; fonts load from local files | PASS |
| Theme and language from the dashboard and the native home reach the gateway (dark; `es-419`, LTR; Arabic RTL) | PASS |
| Recovery: only the WhatsApp channel without a verified email; unlinked send shows the 409 message inline | PASS |
| Wrong password on `/login` | FAIL: blank page (D-1) |
| `FLAG_SECURE` on login and setup | FAIL: screens are capturable (D-2) |
| Arabic legal text direction | FAIL: paragraphs starting with a Latin word render LTR (D-3) |
| Password reset keeps consent; pairing and relinking a real account; oldest supported WebView (R-27) | NOT RUN |

Defects found:

- D-1 (P1, Android, from 04d). A failed login (401) leaves an empty page. `panel-bridge.js`
  renders a POST answer of 400 or more with `document.open`/`document.write`. The gateway entry is
  an ES module that already ran in that window, so it does not run again and `#root` stays empty.
  The EJS pages used classic scripts. The same path serves the failed `/setup` POST. Reproduced
  twice. Recovery uses `fetch` and is not affected.
- D-2 (P1, privacy, older than Phase 04). `PanelActivity.applyScreenCaptureGuard` compares the
  WebView URL path with exactly `/login` and `/setup`. The panel opens `<panelUrl>/#<hash>`, so
  first run loads `/setup/`, and `PanelHttp.exchange` follows redirects internally, so the login
  page shows at `/`. `adb exec-out screencap` captured both screens.
- D-3 (P2). Legal blocks carry `dir="auto"`, so an Arabic paragraph that starts with "Levix" takes
  LTR direction and its words reorder.
- D-4 (P3). The version and effective date in the Arabic dialog render as `02.1-11-2026`; they
  need an LTR isolate.
- D-5 (P3). The Android recovery error tells the user to run `levix reset-password` on the server.
- D-6 (P3, native home). In Spanish, the battery card's text column is squeezed by the
  `RESTRINGIDO` badge and words break mid-word.

Observation: the production app on the device logged `state=logged_out code=401` at 00:08:43 when
the phone's Wi-Fi came back. The QA build has its own data and never paired, so the test did not
cause it; the owner should check that install.

D-1 to D-4 are fixed in section 3.11. D-5 and D-6 are still open.

### 3.11 Defect fixes D-1 to D-4 (2026-11-03)

The owner approved fixing D-1 to D-4 on 2026-11-03. D-5 and D-6 stay open and tracked as
non-blocking UI issues; nothing here changes them. No PR is merged. #130 stays a draft.

| Defect | Cause | Fix | PR and commits | Implementer | Regression tests |
| --- | --- | --- | --- | --- | --- |
| D-1 (P1) | `panel-bridge.js` rendered a 4xx POST answer with `document.write`; the gateway ES module does not run again, so `#root` stayed empty | The React gateway posts login and setup itself with `fetch` and `Accept: application/json`. `POST /login` and `POST /setup` then answer JSON: 200 `{ok, redirect}`, 401, 400 or 429 `{error}` (429 keeps `Retry-After`), 409 `{redirect}`, never 3xx, `no-store`. Errors render inline; the deep link hash is kept. HTML answers, throttling, failure counting and session regeneration are unchanged. | #129 `b0bc38f`, `23b9f5e` | Codex | `gateway-react` (JSON contract, throttle, cross-origin 403), `gateway-auth-submit`, `panel-bridge` |
| D-7 (P1, privacy, new) | Found while auditing D-1. The bridge's submit listener ran in the capture phase on `document`, before React. Every `onSubmit` form without `method="post"` became a GET navigation built from its named fields: the password reset form (`code`, `password`, `confirm`) would put the new password in the URL, and the host logged that URL. Dashboard forms reloaded the page. | The listener is on `window` in the bubble phase, skips events the page already handled (`defaultPrevented`), and intercepts only POST forms. `window` listeners survive `document.open()`, so a classic-script page can submit again after a 4xx render. The host log records panel URLs without query or fragment. | #129 `b0bc38f`, `b35e173`, `23b9f5e` | Codex, Grok | `panel-bridge` (prevented event, GET form, form without method, second POST after a 4xx render) |
| D-2 (P1) | The guard compared the URL path with `/login` and `/setup`; setup shows at `/` or `/setup/`, and login at `/` because `PanelHttp` follows redirects natively | `FLAG_SECURE` is set in `onCreate` before `setContentView`. Every main-frame response, page start and main-frame error sets it again; the intercept thread waits for the flag update (bounded, 2000 ms, logged on timeout) before it returns the response. `ScreenCaptureGuard` clears it only when the document's own response carried `X-Levix-Screen-Capture: allow`, that document's `onPageStarted` committed the decision, and its `onPageFinished` follows. The server sends the header only on the signed-in dashboard (`GET /`) and the signed-in QR page, which was capturable before. Any other callback order stays secure. A fragment-only finish changes nothing. | #129 `b35e173`, `23b9f5e` | Grok, then Codex (review fix) | `ScreenCaptureGuardTest` (21), `screen-capture-header` (40 checks) |
| D-3 (P2) | `dir="auto"` on every legal block | Blocks inherit the document locale direction (`rtl` for `ar`) | #127 `6bfb019` | Grok | `legal-dialog`, `legal-bidi` |
| D-4 (P3) | Unicode bidi rule W2 turns digits after Arabic letters into Arabic numbers; the hyphen between them stays neutral | ISO dates, dotted versions, URLs and e-mail addresses in the legal text, and the version and date values in the dialog header, render in `<bdi dir="ltr">`. Plain Latin words stay with the bidi algorithm. | #127 `6bfb019` | Grok | `legal-bidi` (all paragraphs of the four bundled documents round-trip) |

Stack updates. #127 `feat/04b-consent-ui` is `6bfb019`. #128 `feat/04c-remote-terms` merges #127
(`2f02bb2`), so the sibling keeps its signed remote Terms work. #129 `feat/04d-react-gateway` is
`23b9f5e` with merges `e27e3c7` and `d163a92` and the source-check update `a25ac3d`. #130
`feat/04e-ejs-removal` merges #129 (`2097849`, `43d7c0a`, `bf34db3`) and updates its own source
checks (`5b67818`). Merge conflicts: the signed-in fallback in `GET /` keeps `sendFallback` and gains
the header; the gateway and header tests use the static fallback.

Who did what. Codex implemented D-1, the review fixes and one source check, and did the read-only
review. Grok implemented D-2, D-3 and D-4. Antigravity (Gemini 3.8 Flash) updated two source checks;
two other Antigravity runs were blocked by the local permission classifier. OpenCode
(`deepseek-v4.1-flash-free`) hit `FreeUsageLimitError` before any edit. The orchestrator wrote the
briefs, reviewed every diff, resolved the merges, and ran every gate.

Read-only Codex review on integration `76fc27f` (0 findings on throttling, failure counting, session
regeneration, the origin check, open redirects, secrets in URLs, desktop login, recovery, logout,
and the D-3/D-4 tokenizer):

| Finding | Disposition |
| --- | --- |
| P1: a pending allow matched by URL alone could be applied by a late finish of the previous document at the same URL | Fixed in `23b9f5e`: the decision needs its own `onPageStarted` |
| P1: the 300 ms wait returned the response even if the flag update had not run | Bound raised to 2000 ms with a log line. The update is queued on the main looper before the response exists, and the WebView draws the new document only in a later main-thread traversal. |
| P2: after a 4xx render on a classic-script page, the next POST was not intercepted | Fixed in `23b9f5e` (listener on `window`) |
| P2: a dashboard restored from history without a new response stays secure | Accepted: fails closed; a reload restores capture |
| P2: the 20 s `fetch` timeout cannot fire while the synchronous native request blocks JavaScript | Accepted: older than Phase 04; the native socket timeout (60 s) still ends the request |
| P3: tests did not model `document.open()` or overlapping navigations | Fixed in `23b9f5e` |

Gates on integration commit `8aacfd5` (#130 `bf34db3` merged with #128 `2f02bb2`), Linux x64, Node
24.22.2, npm 11.19.1, 2026-11-03:

| Gate | Result |
| --- | --- |
| `npm test`, external network guard preloaded | PASS: 9,477 checks, 0 failed, 0 crashed (`76fc27f` before the source-check updates: FAIL, 3 source checks) |
| `npm run lint` | PASS: 0 errors (196 warnings, 67 infos) |
| `npm run i18n:check`, `npm run build:frontend` (`tsc -b`, Vite) | PASS |
| Android `:app:testDebugUnitTest :app:assembleDebug :app:assembleRelease :app:bundleRelease`, offline | PASS: 108 unit tests, 0 failures; arm64 and armv7 APKs, debug and release; local AAB; `levix-build.json` versionCode 69 |
| `npm run build:sea` and `npm run validate:sea` | PASS: 51 checks, 0 failed |
| `npm run validate:tarball` (FFmpeg from a loopback mirror of the cached binary) | PASS: 36 checks, 0 failed |
| `npm run validate:docker` | BLOCKED locally (Docker socket permission); CI runs it |
| Headless Chrome with the Android bridge emulated (below) | PASS: 18/18 on `8aacfd5`; the same script on the pre-fix `25764aa` gives 8/16 |
| Android device retest of D-1 to D-4 | NOT RUN: waits for the owner to reconnect the Redmi 9 |

Headless check: `/usr/bin/google-chrome` (puppeteer-core) against a scratch Levix with a fresh data
directory and the WhatsApp proxy set to `socks5://127.0.0.1:9` before boot. A fake `LevixHost`
(synchronous XHR captured before `panel-bridge.js` runs) sends every local POST through the real
bridge, as on Android. Start only reached `consent_required`; Terms were never accepted, and no
WhatsApp connection was attempted.

| Check | `25764aa` (pre-fix) | `8aacfd5` |
| --- | --- | --- |
| Setup mismatch: page rendered, inline error | FAIL: `#root` empty | PASS: "The two passwords don't match.", fields cleared and focused |
| Wrong password at `/`: page rendered, inline error | FAIL: `#root` empty | PASS: "Incorrect Password", field cleared and focused |
| Setup and login success reach the dashboard with the deep link (`#connection`, `#settings/security`) | PASS | PASS |
| Settings password form submit (React `onSubmit`) | FAIL: the bridge navigated | PASS: no navigation |
| No navigation URL holds a password | PASS (that form's inputs have no `name`) | PASS |
| Arabic Terms dialog: no `dir="auto"`, paragraph starting with "Levix" | FAIL: 40 `dir="auto"`, `ltr` | PASS: 0, `rtl` |
| Arabic header: `2026` left of `.1` in `2026-11-02.1` | FAIL: 653.7 px vs 626.3 px | PASS: 608.5 px vs 675.5 px |
| Capture header on documents | absent everywhere | `allow` on the signed-in `/` only; absent on `/setup`, login at `/` |

Android retest checklist for the owner (isolated `.dev` build from these heads, Redmi 9):

1. D-1 setup: fresh data. Enter two different passwords: inline mismatch error, fields cleared, no
   blank page. A too-short password: inline error. Then a valid password: the dashboard opens.
2. D-1 login: sign out, then one wrong password at `/`: inline "Incorrect Password", field cleared
   and focused, no blank page. Then the right password: the dashboard opens.
3. D-1 deep link: open the panel signed out from the home "Review terms" or Connection entry, sign
   in, and land on that screen.
4. D-7: Settings, Security, change password with a mismatched confirmation: no reload, inline error.
   Share the host log: panel URLs carry no `?` query.
5. D-2: `adb exec-out screencap -p` (and the recents thumbnail) on first-run setup, login at `/`,
   login after a wrong password, after a reload, and after Back from the dashboard to login: all
   blocked.
6. D-2: signed-in dashboard, then switch to Settings and Connection: screencap works. The signed-in
   QR page: works (unchanged). Sign out: the login screen is blocked at once. If the dashboard stays
   blocked, the WebView reported callbacks in another order; that fails closed, and the order must
   be recorded.
7. D-3: Arabic UI, Start, Terms dialog: the paragraph starting with "Levix" is right-aligned and its
   words read right to left; WhatsApp, Android and SHA-256 read correctly.
8. D-4: the Arabic header shows `2026-11-02.1` and `2026-11-02` with digits in order; English and
   `es-419` dialogs unchanged.
9. Regression: accept in Arabic records the version and the QR follows; force-stop and relaunch gives
   no new prompt; recovery with no session shows the 409 message inline.

Still NOT RUN: password reset keeping consent on the device, pairing a real account, the oldest
supported WebView (R-27), and the human legal review.

CI on the pushed heads, 2026-11-03: PASS 7/7 on #127 `6bfb019` (run 41905762409), #128 `2f02bb2`
(run 41905767325), #129 `23b9f5e` (run 41905775090) and #130 `12f2a2a` (run 41905776405).

### 3.12 Android device retest of D-1 to D-4 (2026-11-04)

Owner-connected device: Redmi 9 (`lancelot`), LineageOS, Android 14, system WebView
`com.android.webview` 120.0.6099.230. Build: isolated debug APK `net.leviro.levix.dev` from
integration commit `8aacfd5` (`-PlevixIsolatedDebug=true`, arm64, versionCode 69). The previous
`.dev` QA install (never paired) was uninstalled first so first-run setup could be tested; the
production `net.leviro.levix` was not touched. UI language Arabic. Steps were driven over the
WebView DevTools socket and `adb`; screen capture was checked with `adb shell screencap -p`, which
exits 1 with an empty file while `FLAG_SECURE` is set. Terms were never accepted, so no WhatsApp
connection was made.

| Check | Result |
| --- | --- |
| D-2: first-run setup at `/setup/#connection`: window flags include `SECURE`; `screencap` exit 1 | PASS |
| D-1: setup with two different passwords: page stays, inline "كلمتا المرور غير متطابقتين.", password cleared and focused | PASS |
| D-1: setup with a 5-character password: inline "يجب ألا تقل كلمة المرور عن 8 خانات" | PASS |
| D-1: valid setup opens the dashboard at `/#connection` | PASS |
| D-2: signed-in dashboard capturable (`screencap` exit 0), also after a hash move to `#settings/security` | PASS |
| D-7: Settings password form submit with a mismatched confirmation: same document, URL unchanged | PASS |
| D-2: after sign-out, login at `/`: `screencap` exit 1 | PASS |
| D-1: wrong password at `/`: page stays, inline "كلمة المرور غير صحيحة", field cleared and focused; `screencap` exit 1 | PASS |
| D-2: reload of the login page: `screencap` exit 1 | PASS |
| D-1: sign-in returns to `/#settings/security` | PASS once the guided tour is done. On the first sign-in the tour (`levix_tour_v1_done` unset) moves the hash to its first step, `#connection`; that is the tour's behaviour, not the gateway's |
| D-2: signed-in `/qr` capturable; Back to the dashboard capturable | PASS |
| D-3: Arabic Terms dialog after Start: 0 `dir="auto"`; the paragraph starting with "Levix" computes `direction: rtl` and renders right-aligned in RTL word order | PASS |
| D-4: header reads `الإصدار 2026-11-02.1 · ساري المفعول من 2026-11-02`; `2026` at 249.4 px, `.1` at 319.2 px (left to right) | PASS |
| Session stays `consent_required`; the dialog closes without accepting | PASS |
| Host log: 10 panel URL lines, none with a query or fragment, no password text, no screen guard timeout | PASS |
| Recovery with no WhatsApp session: inline 409 message (it still names `levix reset-password`, D-5) | PASS |
| English and `es-419` dialogs on the device; accepting Terms and the QR after it; recents thumbnail inspected by eye | NOT RUN (accepting would contact WhatsApp) |

D-1 to D-4 and D-7 pass on the device. D-5 and D-6 stay open.

### 3.13 Merge of #125 to #129 and #130 reconciliation (2026-11-04)

The owner authorized merging #125 to #129 and keeping #130 a draft.

Integration. `integration/phase-04` was branched from `main` `0089a6a` (after dependabot #124),
merged #129 `23b9f5e` (which contains #125 `32a4b59`, #126 `51d0051` and #127 `6bfb019`), then #128
`2f02bb2`. Both merges were clean (`1b63fda`). #126 and #127 were never merged on their own: their
trees still hold the older tests that could reach WhatsApp's servers, while the integrated tree has
the fake sockets and preloads `tests/fixtures/no-external-network.cjs` into every test process
through `NODE_OPTIONS`. `levix headless` on a fresh data directory under that guard stopped at
`terms_not_accepted` and opened no socket, which covers the headless steps of `validate:tarball`,
`validate:sea` and `validate:docker`.

| Gate on `1b63fda` | Result |
| --- | --- |
| `npm test`, Linux x64, Node 24.22.2 | PASS: 9,416 checks, 0 failed, 0 crashed; no guard refusal in the log |
| `npm run lint`, `npm run i18n:check`, `npm run build:frontend` | PASS (lint 0 errors) |
| GitHub CI on #131 (7 jobs: tests, tarball, SEA on ubuntu, macos and windows, Docker, Android) | PASS 7/7 |

#131 was merged with a merge commit: `main` is `0fff4ca`. GitHub marked #125 merged. It cannot mark
a stacked PR merged when its base is another PR branch and refuses to retarget a PR with no new
commits, so #126, #127, #128 and #129 were closed with a comment naming #131, `0fff4ca` and their
own head commit. Their branches are kept.

#130 (`feat/04e-ejs-removal`) merged `main` cleanly (`c0565ed`), now based on `main`, and gained:

| Change | Commit | Implementer |
| --- | --- | --- |
| D-5: in the Android app (`window.LevixHost`), the `no_session`, `unverified` and `locked` recovery errors use Android messages (restart the assistant so a linked WhatsApp reconnects, use the recovery email, or try later) instead of `levix reset-password`; desktop keeps the CLI fallback; no server or throttle change. `pt-BR/gateway` and `es-419/gateway` go back to `draft` in `i18n/review.json` | `6ea8032` | Codex |
| D-6: the battery card badge moves under the title inside the text column; title and hint set `hyphenationFrequency="none"` and `breakStrategy="simple"` | `832e135` | Grok |
| `android/README.md` no longer lists `views/` | `90b0545` | Codex |

A read-only Codex review of `git diff 0fff4ca HEAD` found no defect: no `res.render`, `ejs` or
packaging reference to `views/` or the removed scripts, escaped values and credit links in the
static fallback, no remote font reference, OFL licences shipped, D-5 and D-6 as described, the lock
retry bounded and failing closed, nothing dropped by the merge with `main`. Its one note was the
README line above.

| Gate on #130 `ab1e364` (Linux x64, Node 24.22.2, 2026-11-04) | Result |
| --- | --- |
| `npm ci` from the merged lockfile | PASS, no `ejs` |
| `npm test` | PASS: 9,536 checks, 0 failed, 0 crashed (`recovery-ui` 198, i18n 1,802) |
| `npm run lint`, `npm run i18n:check`, `npm run build:frontend` | PASS (lint 0 errors; i18n prints the two expected draft hash notes) |
| Android `:app:testDebugUnitTest :app:assembleDebug :app:assembleRelease :app:bundleRelease`, offline | PASS: 110 unit tests (2 new in `BatteryCardLayoutTest`), 4 APKs, 1 AAB |
| `npm run build:sea`, `npm run validate:sea` | PASS: 51 checks |
| `npm run validate:tarball` (FFmpeg from a loopback mirror) | PASS: 36 checks |
| `npm run validate:docker` | BLOCKED locally (Docker socket permission); GitHub CI runs it |

Not run: D-5 and D-6 on the device (both need the Redmi 9 again), the recents thumbnail inspected by
eye, accepting Terms on the device, the oldest supported WebView (R-27), the ChatGPT review of the
three new `pt-BR` and `es-419` gateway strings, and the human legal review. Remote Terms fetching
stays disabled. Release blockers: human legal approval and the R-27 WebView test.


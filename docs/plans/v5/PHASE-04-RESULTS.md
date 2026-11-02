# Phase 04: React gateway and Terms consent

Status: IN REVIEW, NOT MERGED. Slices 04a and 04b are implemented in open PRs #126 and #127, which
were updated after the owner's review on 2026-11-02 (section 3). Slices 04c (#128) and 04d
(#129) are implemented in new open PRs; 04e (#130) is a draft. No Phase 04 PR is merged, so nothing in this phase
ships on `main` (407bf1e). Owner decisions Q-03, Q-04, Q-05 and Q-17 are recorded in ADR-006,
ADR-019 and ADR-020. The contract lives in `LEGAL_CONSENT_CONTRACT.md`.

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

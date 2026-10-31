# Levix v5.0.0 Phase 02: backup, restore and migration safety

Status: decisions APPROVED by the owner on 2026-10-31 (section 5). PRs 02a to 02h merged on
2026-10-31 (#91 to #99, `main` b14a3e6). PR 02i (restore safety, section 4) is open. Android device
QA ran on 2026-10-31 (section 7.1); desktop manual QA is NOT RUN. Every claim below cites code at
`main` 966cd2b or a command run on 2026-10-31.

## 1. Re-audit (2026-10-31)

A read-only Codex audit checked `ARCHITECTURE.md` section 6 against the code. The orchestrator
re-checked the findings that change the plan.

| ID | Finding | Evidence |
| --- | --- | --- |
| P2-01 | `db.cjs` opens the database and runs `migrate(db)` when it is imported. `index.js` imports the store, `secrets.cjs` and `db.cjs` at module load. Any import path migrates before `bootstrapCore()` takes the lock. Moving the lock call alone does not fix B-09; every eager database import must become lazy. | `src/db/db.cjs:707`, `src/index.js:18-28`, `src/bootstrap/core.js:38` |
| P2-02 | `levix reset-password` imports the store, so it opens and migrates the database without the instance lock. | `src/cli.js:127` |
| P2-03 | An install that predates the data directory keeps its memory in `PACKAGE_ROOT/memory` when that folder exists. A backup of the data directory alone misses it. | `src/utils/memory.cjs:43` |
| P2-04 | `bot_settings` accepts any key. Known families are `setting:*`, `auth:password`, `auth:recovery-email`, `secret:session`, `prefix`, `command_permissions`, `command_aliases`, `disabled_commands`. A secret filter must be an allowlist; a denylist would keep unknown or future secret keys. | `src/db/db.cjs:59`, `src/config/secrets.cjs:32`, `src/config/runtime-config.cjs:22` |
| P2-05 | Seven `setting:*` keys are sealed secrets (`gemini_api_key`, `openai_api_key`, `anthropic_api_key`, `google_search_api_key`, `google_translate_api_key`, `openweathermap_api_key`, `whatsapp_proxy_password`), plus `baileys_auth` and `auth:recovery-email`. `secret:session` is plain hex. A legacy unsealed value can survive a failed `initStore()` sealing pass. | `src/config/settings.cjs:517`, `src/db/store.cjs:36`, `:59` |
| P2-06 | With another install's `levix.key`, `vault.open()` throws. Recovery-email reads catch it and look unset; Baileys `authRead()` does not catch it. | `src/config/vault.cjs:77`, `src/config/secrets.cjs:100`, `src/db/store.cjs:1272` |
| P2-07 | Restoring account data without the pairing credentials can attach one WhatsApp account's private data (user records, LID map, AI history, schedules, moderation state, stickers, memory) to a different paired account. Unlink wipes exactly this state on purpose. | `src/core/session.js:77` |
| P2-08 | The SQLite snapshot can be consistent while sticker, schedule-media and memory files change around it. Schedule media is written before its row. | `src/routes/dashboard.api.esm.js:1420`, `src/stickers/library.cjs:223` |
| P2-09 | No in-place swap is safe: prepared statements, the vault key cache and several in-memory caches hold the old state. A restore must stop the process and restart. `stopAllScheduledJobs()` and the SIGTERM path do not stop every writer (the six-hour media cleanup, sticker jobs, in-flight deliveries). | `src/db/db.cjs:713`, `scheduler.cjs:95`, `src/index.js:291` |
| P2-10 | Android restarts Node by itself while `wanted_running` is true. A restore must coordinate with `LevixHostService` so the host does not restart Node mid-switch. | `LevixHostService.kt:51`, `:139` |
| P2-11 | Android's settings export sends the whole file through the JS bridge as base64. A backup needs the existing native streaming path over the panel socket, new narrow route allowlist entries and size caps. A Storage Access Framework save (`ACTION_CREATE_DOCUMENT`) does not exist yet. | `PanelBridge.kt:98`, `StickerHost.kt:133`, `:225`, `PanelFiles.kt:16` |
| P2-12 | The PID lock's stale-lock takeover removes and recreates the file in separate calls; the concurrency tests must cover it. | `src/config/lock.cjs:77` |
| P2-13 | A build that finds `user_version` above its own migration count runs anyway. v4.9.2 would open a v5 database without a warning. | `src/db/db.cjs:680`, `MIGRATION.md` section 1 |
| P2-14 | Desktop Node 24.22.2 exposes `node:sqlite` `backup()` and `serialize()` (SQLite 3.53.4). Both Android ABIs' `node` binaries import all five `sqlite3_backup_*` functions and `sqlite3_serialize`, and the pinned `libsqlite3` 3.54.1 exports them. Run time on a device: NOT VERIFIED. | `node -e` on v24.22.2; `readelf --dyn-syms` on the pinned Termux files |
| P2-15 | `settingsTransfer.cjs` (format `levix-settings` v1) shares non-secret settings and the command table. It stays unchanged; backup and restore get their own format and routes. | `src/services/settingsTransfer.cjs:1`, `tests/settings-transfer.test.mjs` |

## 2. What a backup holds

`BACKUP_FORMAT.md` section 7 is the authoritative list. In short:

| Group | Content | When it is applied |
| --- | --- | --- |
| Settings | Every `setting:*` key in `settings.cjs` except the six device keys; the seven API keys and the proxy password, sealed again with the target's `levix.key`; the command table (`prefix`, `command_permissions`, `command_aliases`, `disabled_commands`); `ai-persona.md` | At restore, in one transaction |
| Account | Roles, LID map, group directory and settings, warnings, todos, notes, debts, AI conversations, schedules and their media, moderation flags, auto-delete rules and copies, the sticker tables and files, AI memory | Only when the paired WhatsApp account matches the backup (Q-24) |
| Never | WhatsApp pairing (`baileys_auth`, `qr_codes`), panel password, panel session key and sessions, recovery email, unknown `bot_settings` keys, device keys (`port`, `bind_address`, `trust_proxy`, `public_domain`, `dashboard_origin`, `ffmpeg_path`), `levix.key`, `moderation_applied`, `forward_scores`, logs, crash reports, temporary files, Android preferences | |

Rules kept from the Codex plan review:

- Tables and `bot_settings` keys are allowlisted. A table the allowlist does not know makes backup
  creation fail, so a future table cannot leak.
- The database copy is a filtered copy written by `src/db/copy.cjs` in the same synchronous step as
  the file links. It creates the schema in a new file and copies only the allowed rows, so excluded
  rows, unknown keys, secret settings and unpaired account tables are never written and no second
  `VACUUM` is needed. Then `PRAGMA integrity_check`, a scan for every value that must never travel, and
  only then the archive. The API key values stay in memory until they are written inside the
  encrypted archive.
- Every archive is sensitive: it holds API keys, chats, people and notes. It is always encrypted.

## 3. Design

- Archive (`BACKUP_FORMAT.md`): magic, a cleartext header with only the format and the scrypt
  parameters, a header HMAC, then an AES-256-GCM chunk stream (64 KiB chunks, counter nonces, final
  chunk flag, header HMAC as additional data) of one gzip member that holds the manifest and the
  entry bytes. The password is always required. Node core only (`crypto.scrypt`,
  `crypto.createCipheriv`, `zlib`), no new dependency.
- Creating (PR 02d): one synchronous step, with no `await` inside, writes a filtered copy of the live
  database with `src/db/copy.cjs` into a private temporary folder `<data>/tmp/backup/<id>/` (0700),
  hard-links the sticker and schedule-media files (written once, never edited) and copies the memory
  files and persona in the same step, so rows and files match without pausing other code (P2-08).
  Rows the backup excludes and secret settings are never written. Then the secret scan, hashing, the
  manifest and the encrypted file, written to `<data>/tmp/backup/exports/` and downloadable by the
  signed-in operator for 30 minutes. Creating needs the backup password twice and the panel password.
- Restoring (PR 02e): upload, preview with the backup password, confirm with the panel password,
  then a job that stages and verifies everything, migrates the staged database copy, applies the
  settings group in one transaction (API keys sealed with the target's `levix.key`) and moves the
  account group to `<data>/restore/pending/`. Nothing replaces the live database file or
  `levix.key`, so the prepared statements and the vault key cache stay valid (P2-09); restored
  settings take effect the way a settings import does.
- Account activation (PR 02f, Q-24): at connection open, before roles are seeded and schedules
  start, Levix compares the paired account with the pending identity (LIDs when both are known,
  otherwise phone numbers) and, on a match, migrates the pending copy, moves the memory, sticker
  and schedule-media folders into place and replaces the account tables in one transaction. A
  restore onto an install already paired with the same account reconnects the session so the same
  path runs. A different account leaves the data waiting; the panel offers Discard.
- Crash safety: `<data>/restore/journal.json` is written (temporary file, `fsync`, rename) before
  each step. The start path runs recovery under the instance lock before the runtime loads, and
  finishes or undoes an interrupted restore or activation.
- Start order and migrations (PR 02b, Q-26): the start path takes the instance lock, runs restore
  recovery, opens the database without migrating, refuses a schema newer than the build (P2-13),
  writes and verifies a pre-migration copy when a migration is pending, then runs every pending
  migration in one transaction, so a failure leaves the database at its old version. The copy is a
  filtered local file in `<data>/backups/pre-migration/levix-v<from>-<stamp>.db` (file 0600, folder
  0700), never exported and never offered for download; the newest two are kept. It holds every
  table and every row except the secret material: no WhatsApp pairing (`baileys_auth`, `qr_codes`),
  no panel password hash (`auth:password`), no recovery email (`auth:recovery-email`), no session
  key (`secret:session`), and no API key or proxy password. `src/db/copy.cjs` creates the schema in a
  new file and copies only the allowed rows in one read transaction, so no secret row reaches the
  copy or a temporary file; the pairing tables exist in the copy with no rows. The copy is written as
  a `.part` file, checked with `PRAGMA integrity_check`, `user_version`, row counts and a check for
  secret rows, fsynced and renamed, and the next start deletes stale `.part` files. Recovery from a
  copy is a documented manual step with Levix stopped, because there is no CLI restore (Q-14): copy
  the chosen file over `levix.db`, delete `levix.db-wal` and `levix.db-shm`, start the previous
  build, choose a new panel password at `/setup` and pair WhatsApp by hand. `reset-password` never
  migrates without the lock (P2-02). The stale-lock takeover becomes race-free (P2-12).
- Memory (PR 02c, Q-25): `memory.cjs` reads and writes `<data>/memory` only. On the first start
  with an empty `<data>/memory` and files in the legacy `PACKAGE_ROOT/memory`, those files are
  copied into the data directory once; the legacy folder is left in place and reported in the log.
- Surfaces (PRs 02g and 02h): Settings → Backup in the React panel with progress and errors; in the
  Android app the same screen saves through `ACTION_CREATE_DOCUMENT` and opens through
  `ACTION_OPEN_DOCUMENT`, streaming bytes natively over the panel socket so no file passes through
  the JavaScript bridge (P2-11), and coordinates with `LevixHostService` (P2-10). No CLI command and
  no WhatsApp command (Q-14).

## 4. Pull requests

| PR | Content | Base |
| --- | --- | --- |
| 02a | Archive format library `src/backup/format.cjs`: writer, reader, limits, errors; tests for round trip, wrong password, tampered header and chunks, truncation, extension, reordering, KDF limits, manifest and path rules, inflation bomb | `main` |
| 02b | Start order and migration safety: lock first, race-free stale lock, lazy database open, newer-schema refusal, verified pre-migration copy with retention, all pending migrations in one transaction, `reset-password` under the same rules, restore-recovery hook; concurrency and failure tests (two starts, stale lock, newer schema, copy failure, failing migration, crash during migration) | 02a |
| 02c | Memory root under `<data>/memory` with a one-time legacy copy (Q-25) | 02b |
| 02d | Create backup: quiesce, snapshot, filter, files, manifest, encrypted file, job progress, one-time download, panel password check; tests for inclusion, exclusion and secret scanning | 02c |
| 02e | Restore: upload, preview, staging, settings apply, API key re-sealing, pending account data, discard, journal and recovery; end-to-end tests | 02d |
| 02f | Account activation (Q-24): match rule, activation at connection open before roles and schedules load, journaled folder moves, recovery; tests for same account, recycled number, different account, unlink, crash at each step | 02e |
| 02g | Panel UI: Settings → Backup (create, download, upload, preview, confirm, progress, errors, pending account notice), both languages | 02f |
| 02h | Android: Storage Access Framework save and open with native streaming, host coordination; `PRIVACY.md`, `SETUP.md` and the manual offline QA steps | 02g |
| 02i | Restore safety after device QA: a restore writes only what the backup holds (missing settings, API keys and persona keep their values); restore plan in the preview from manifest digests (`src/backup/plan.cjs`); explicit confirmation for replacements and removals, enforced again by the job from the staged rows (`CONFIRM_REQUIRED`); tests in `tests/backup-restore-merge.test.mjs` | `main` |

The PRs form one stack in this order, so each shows only its own change. 02a, 02b and 02c touch
separate files and are built in parallel, then stacked.

## 5. Owner decisions (2026-10-31)

| ID | Decision |
| --- | --- |
| Q-10 | Android preferences and other device data stay out of backups. |
| Q-14 | Backup and restore run from the React panel and the Android app only. No CLI command and no WhatsApp command. |
| Q-22 | A restore keeps the target's panel password, session key and recovery email, and never imports WhatsApp pairing. API keys come from the backup and are sealed with the target's `levix.key`. A new install goes through the normal setup first. Amended in 02i: a restore writes only what the backup holds, so an API key, a setting or the persona that the backup lacks keeps its current value, and replacements need an explicit confirmation. |
| Q-24 | Account data activates only after the paired WhatsApp account is verified to match the backup's account; until then it waits, and the operator can discard it. |
| Q-25 | AI memory lives in `<data>/memory`. |
| Q-26 | Migrations get crash-resistant rollback protection: a verified local pre-migration copy (never exported, newest two kept) and all pending migrations in one transaction. The copy holds every table and every row except the secret material (no WhatsApp pairing, panel password hash, recovery email, session key or API key), so a rollback leaves the install with no pairing and no panel password. |

The owner also decided that every exported backup is encrypted with a user-provided password
(AES-256-GCM with a secure KDF) and holds the AI and third-party API keys. This replaces the
"default backup without secrets" of the earlier plan.

## 6. Tests and gates

- End to end: backup, mutate, restore, verify (settings, command table, API keys usable after
  re-sealing, schedules, group settings, memory, persona, stickers); a corrupt or truncated backup
  is rejected and the install stays byte-identical.
- Account activation: same account (LID), recycled phone number (same phone, new LID) refused,
  different account refused, unlink keeps pending data, discard, activation before roles and
  schedules load.
- Interrupted restore and activation at every journal step; full disk during backup and restore.
- Archive fuzz: tampered header and chunk, truncation, extension, reordering, KDF parameters
  above the cap, wrong password, oversized manifest, bad paths, duplicate paths, inflation bomb.
- Newer schema refused; a v4.9.x fixture database restored and migrated.
- No pairing credential, panel secret, session key, recovery email or device key in a backup: a test
  decrypts the archive and scans the database copy and every entry for each planted value.
- Pre-migration copy (`tests/start-order.test.mjs`): planted sentinel values for each secret never
  appear in any file under `<data>/backups/pre-migration/`; the pairing tables are empty and every
  other row is present; the copy's schema equals the source's. A kill during the copy leaves no final
  file, no secret in the `.part` file and an unchanged live database. A rollback onto the previous
  schema opens with no pairing and no panel password.
- Backup creation survives a crash (`tests/backup-create.test.mjs`): a crash after the database copy
  and after the file copies leaves no secret value in any file under `<data>/tmp/`, including the
  plaintext API keys.
- Restore survives a crash (`tests/backup-restore.test.mjs`): at every crash point, no file under the
  data directory holds a plaintext API key; the recovery outcome is unchanged; extraction keeps the
  `secrets.json` entry in memory only.
- Restore writes only what the backup holds (`tests/backup-restore-merge.test.mjs`, PR 02i): an
  empty backup keeps every setting, API key, the persona, the panel password, the session key, the
  recovery record and the pairing; a partial backup replaces only its own keys, keeps the sealed
  rows of the others byte for byte, and is refused with `CONFIRM_REQUIRED` (no change, no staging,
  no journal) until confirmed; added-only and unchanged restores need no confirmation; same-account
  data replacement and a waiting restore count as destructive; a different account waits without
  touching the current account rows; wrong password and damaged files change nothing; a manifest
  without digests stays valid and its plan counts as destructive; the preview route returns names
  only (no digest, no value) and only a literal `confirmDestructive: true` confirms.
- `settings-transfer` tests unchanged.
- Core gates plus Docker, SEA and tarball in CI. Android save, open and restore on a device: see
  section 7.1.

## 7. Manual QA: offline restore

Status: desktop steps 1 to 3 **NOT RUN**. Android: run on 2026-10-31, results in section 7.1.
Use isolated installs, offline from
Levix-operated services, and a dedicated WhatsApp test account with owner
authorization. Record platform, commit, date and result for each run.

1. On desktop, create and download a password-protected backup from Settings →
   Backup. Change a setting, an API key, a conversation or memory item, a
   schedule, a sticker and a group role. Restore on the same install. Verify
   restored settings and data, retained panel password and device settings,
   and manual WhatsApp pairing when needed.
2. On a fresh desktop install, set up its own panel password and restore the
   file. Pair the same WhatsApp test account by hand. Verify account data
   activates; verify the fresh install retains its own panel password and
   device settings.
3. On another fresh desktop install, restore and pair a different test account.
   Verify account data stays in the waiting notice and is not used. Choose
   Discard and verify the notice and pending data are removed.
4. Repeat steps 1 to 3 on Android. Use the native picker to open the backup and
   Create Document to save it. Verify upload progress, the saved file, and that
   cancelling a save or download leaves no partial document.

### 7.1 Android device results (2026-10-31)

Build: `main` b14a3e6, debug arm64 APK built with `-PlevixIsolatedDebug=true` (package
`net.leviro.levix.dev`, "Levix QA", installed beside the release app, which was not touched).
Device: Realme RMX3636, Android 15, arm64. The panel ran inside the app's WebView; the steps were
driven through that WebView (Chrome DevTools protocol over adb) and the system pickers through adb
taps. Test values (panel password, backup password, API keys) were generated for the run.

Real device, no WhatsApp pairing:

| Check | Result |
| --- | --- |
| Create a backup from Settings → Backup (scrypt on the device) | PASS, 2 s |
| Save through the Android Create Document picker | PASS: the file in Download is byte-identical to the server export (sha256 `b790cd67…`, 8,026 bytes) |
| Cancel the save picker | PASS: no new and no partial file in Download |
| Open the file through the Android picker; wrong backup password | PASS: "The backup password is wrong." |
| Preview and restore with the right password | PASS: 2 items applied, panel password kept |
| Restored values | PASS: `bot_language` back to `en`; a new backup from the device, decrypted on a desktop, holds the restored API key and not the changed one |
| Plaintext secrets in the app's data folder (database, WAL, logs, `restore/`, `tmp/`) | PASS: 0 hits for the panel password, the backup password and both API keys |
| Leftover files | PASS: only `restore/last-outcome.json` and the encrypted export |

Real device, paired with the owner's dedicated WhatsApp test account (masked `+20 ••• ••• ••21`):

| Check | Result |
| --- | --- |
| Backup while paired | PASS: manifest account is the test account's LID and phone number; 2 memory files; the database copy has 0 pairing rows and 0 secret keys |
| Same account: change memory, restore | PASS: preview `match`; account data activated 3.5 s after the restore; the 3 original memory entries came back; WhatsApp stayed connected |
| Discard of waiting data | PASS: `waiting=false`, no leftover files |

Simulated mismatched account (one test number was available, so no second real account):

| Check | Result |
| --- | --- |
| A backup made on a desktop for a fake account (`+20 ••• ••• ••99`), restored on the device while it was paired with the test account | PASS: preview `different`; account data waited and was not used; memory unchanged; Discard removed it |

Finding fixed in PR 02i: the simulated backup held no settings and no API keys, and the restore
reset the device's Gemini API key, bot language and AI provider to their defaults, because a
restore then replaced every restorable row and removed the persona when the backup had none. PR
02i keeps every value a backup does not hold and asks for confirmation before replacing one. The
fixed behaviour is verified by `tests/backup-restore-merge.test.mjs`; a device re-run after PR 02i
is NOT RUN.

Not covered on the device: the recycled-number case, a crash during restore on Android, and ARMv7.

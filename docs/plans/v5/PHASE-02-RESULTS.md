# Levix v5.0.0 Phase 02: backup, restore and migration safety

Status: PLAN, waiting for the owner's decisions in section 5. Started 2026-10-31 on the owner's
instruction. No product code changes yet. Every claim below cites code at `main` 966cd2b or a
command run on 2026-10-31.

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

| Item | Default backup | Backup with secrets (encrypted) | Never |
| --- | --- | --- | --- |
| Database snapshot (`node:sqlite` `backup()`), filtered as below | yes | yes, unfiltered | |
| `bot_settings`: non-secret `setting:*` keys known to `settings.cjs`, `prefix`, `command_permissions`, `command_aliases`, `disabled_commands` | yes | yes | |
| `bot_settings`: the seven secret `setting:*` keys, `auth:*`, `secret:session`, any unknown key | no | yes | |
| `baileys_auth` (pairing credentials) and `levix.key` (vault key) | no | yes, only together (sealed rows are useless without the key) | |
| `qr_codes`, `moderation_applied`, `forward_scores` | | | yes (rebuilt or expiring) |
| The account set: every WhatsApp-derived table (`user_metadata`, `lid_mapping`, `group_directory`, `group_settings`, `warnings`, `todos`, `notes`, `debts`, `ai_history`, `schedules`, `moderation_flags`, `auto_delete_rules`, `auto_delete_log`, the four sticker tables) plus the active memory root (P2-03), `media/schedules/<id>` and the sticker files | yes, restored only under Q-24 | yes | |
| `ai-persona.md` | yes (it may hold operator text, so the archive is labelled sensitive) | yes | |
| WAL and SHM files, lock, `panel.sock`, `tmp/`, other `media/`, logs, crash reports, host log, Android preferences and caches | | | yes |

Rules from the Codex plan review:

- Tables and files are allowlisted per backup mode and schema version. A table the allowlist does
  not know makes backup creation fail until it is classified, so a future table cannot leak.
- Order for the default copy: snapshot to a private temporary file, delete the excluded rows there,
  `VACUUM INTO` a new file, archive only that file, check it with `PRAGMA integrity_check` and a scan
  for every planted secret, then delete the temporary files. WAL and SHM files are never archived.
- Every archive is labelled sensitive, even without credentials: it holds chats, people and notes.

## 3. Design (detail in `BACKUP_FORMAT.md`, PROPOSED)

- Archive: a cleartext header (format, version, encryption parameters, schema version, content
  counts; no secret and no account identity), then a gzip-compressed tar with `manifest.json`
  first. With secrets, the payload is encrypted with AES-256-GCM in length-framed records under a
  key from scrypt and a passphrase, with an authenticated final record. Node core only.
- Account identity lives inside the payload: an archive-specific random salt and an HMAC of the
  paired LID. A restore compares it after decryption, or against the target's own paired LID.
- Creating: hold a backup lock that pauses the scheduler, sticker jobs and panel writes for the
  seconds the snapshot and the file copy take, so files and rows match (P2-08).
- Restoring: upload, preview, validate, re-enter the panel password, check free space for the
  staged copy plus the moved entries, stage under `<data>/.restore/<id>/staged/`, write and `fsync`
  a journal, stop the process. At the next start, before any database import and under the
  instance lock, recovery runs. The previous process closed the database after a `TRUNCATE`
  checkpoint, so `levix.db` has no WAL left. Each top-level
  entry (`levix.db`, the memory root, `ai-persona.md`, `media/schedules`, `stickers`, and `levix.key`
  for an encrypted backup) moves into `<data>/.restore/<id>/previous/` and its staged replacement
  moves into place, one same-filesystem rename at a time, each step journalled and the directories
  `fsync`ed. The journal makes recovery idempotent: a crash, a host restart (Android, systemd,
  Docker) or a full disk at any step finishes or undoes the switch on the next start. `previous/`
  stays until the restored install passes a health check (database opens, `integrity_check`, schema
  supported, the panel starts).
- Start order (P2-01, ADR-016): open without migrating, take the lock, read `user_version`, refuse a
  newer schema (P2-13), back up and verify when a migration is pending, then migrate. Keep the last
  two pre-migration backups under `<data>/backups/`. `reset-password` takes the lock (P2-02).
- Surfaces: Settings → Backup in the panel; `levix backup` and `levix restore` for headless (Q-14);
  Android saves and opens through the native streaming path with a `ACTION_CREATE_DOCUMENT` save
  (P2-11).

## 4. Pull requests

| PR | Content | Needs |
| --- | --- | --- |
| 02a | `BACKUP_FORMAT.md` accepted; the archive reader, writer and limits (`src/backup/`), with fuzz tests for traversal, links, bombs, oversized manifests, KDF limits and wrong passphrases; a read-only "what a backup would hold" preview route | section 5 decisions |
| 02b | Start order: the CLI start path takes the lock, runs restore recovery, opens the database without migrating, refuses a newer schema, writes and verifies the pre-migration copy, migrates, then loads the runtime; `reset-password` uses the same locked opener; concurrency and failure tests (two starts, stale lock, newer schema, backup failure, full disk, crash at each migration step) | Q-26 |
| 02c | Create backup (snapshot, filter, vacuum, quiesce, files, manifest, encryption) | 02a |
| 02d | Restore (staging, journal, switch, rollback, restart, Q-22 and Q-24 rules); end-to-end tests: backup, mutate, restore, verify; corrupt backup rejected with the old install intact; interrupted restore | 02a, 02c |
| 02e | Panel UI, CLI, Android save and open; privacy, SETUP and manual offline QA steps | 02c, 02d |

02b goes first once Q-26 is decided, because every later migration in v5 depends on it. The
Codex review showed that the pre-migration copy holds pairing credentials, so its storage policy is
an owner decision, not an ADR-016 detail.

## 5. Decisions needed from the owner

| ID | Question | Recommendation |
| --- | --- | --- |
| Q-10 | Android preferences (host state, onboarding, Media Hub, theme) in a backup? | No; Node data only. Media Hub folder grants cannot move between installs anyway. |
| Q-14 | `levix backup` and `levix restore` on the command line? | Yes; headless and Docker have no panel. Both refuse while Levix runs. |
| Q-22 | What does restoring a default backup (no secrets) do to the target's secrets? | Keep the target's pairing, keys and password. The account set follows Q-24. (Codex agrees.) |
| Q-24 (new) | The account set when the target's WhatsApp account differs from the backup's, or is unknown (P2-07)? | Restore the account set only when the identity inside the payload matches the target's paired account; otherwise omit the whole set and list it in the preview. An unpaired target gets settings only; moving an account to a new device uses an encrypted backup with its pairing. (Codex's position; a "hold until the same account pairs" variant is possible but adds a quarantine state.) |
| Q-25 (new) | Legacy memory root (P2-03)? | Back up the active root; restore into `<data>/memory` and change `memory.cjs` so the data directory wins over `PACKAGE_ROOT/memory`; when both hold files, keep the data directory's and report the other. |
| Q-26 (new) | The automatic pre-migration copy holds the pairing credentials and sealed secrets. How is it stored? | A full local copy in `<data>/backups/`, mode 0600, never exported, the last two kept, beside the live database it protects (which has the same exposure); restored only by an explicit `levix restore --pre-migration` command. |

## 6. Tests and gates (from `TEST_MATRIX.md`, extended)

- End to end: backup, mutate, restore, verify (schedules, group settings, memory, persona,
  stickers, settings); corrupt or truncated backup rejected with the old install byte-identical.
- Interrupted restore at every journal step; restart during restore; full disk during backup and
  during restore.
- Archive fuzz: `..`, absolute paths, links, duplicate names, oversized manifest, entry-count and
  ratio bombs, KDF parameters above the cap, wrong passphrase, tampered chunk, truncated stream.
- Newer schema refused; v4.9.x fixture database restored and migrated.
- No secret in a default backup: a test greps the archive bytes and the database for every secret
  key and value it planted.
- `settings-transfer` tests unchanged.
- Core gates plus Docker, SEA and tarball in CI. Android device smoke for save, open and restart:
  NOT RUN until a device and a dedicated test account are available.

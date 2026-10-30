# Levix v5.0.0 architecture notes

Sections 1 to 9 describe the code as it is at commit `050d8b9` (v4.9.2). They are `SHIPPED` facts
with file and line evidence. Section 10 is the `PLANNED` target and changes only through ADRs.
`AGENTS.md` remains the authoritative description of the shipped system; this file collects the
parts that v5 changes.

## 1. Reading order

1. `SCOPE.md` for what v5 includes.
2. `DECISIONS.md` for accepted and proposed ADRs.
3. This file for the current structure and the target.
4. `PHASES.md` for the per-phase plan, `TEST_MATRIX.md` for gates, `RISKS.md` for threats.

## 2. Startup and the WhatsApp session

- Panel mode and headless share `bootstrapCore()`. Headless passes `autoStart: true`; panel mode
  passes `false` (`src/index.js:163`, `:192`).
- `sessionStartupPolicy()` returns `autostart` for headless, `resume-paired` when stored credentials
  show a finished pairing, and no start otherwise (`src/bootstrap/session-startup-policy.js:22`).
  `bootstrapCore()` acts on it (`src/bootstrap/core.js:86`).
- Android runs Node through `LevixHostService` and `NodeRuntime`, which execute
  `<nativeLibraryDir>/libnode.so <filesDir>/app/boot.mjs` with `LEVIX_DATA_DIR=<filesDir>/data`
  (`android/app/src/main/java/net/leviro/levix/NodeRuntime.kt:119`). `boot.mjs` starts panel mode
  (`android/host-boot.mjs:88`), so a paired install resumes WhatsApp after a reboot when the user had
  left the host running (`BootReceiver.kt:20`, `HostPrefs.kt:10`).
- `WhatsAppSession.#open()` is the only place a socket is built (`src/core/session.js:571`,
  `src/core/socket.js:101`). Callers: `start()` (`:418`), the retry timer (`:1033`, which calls
  `#open()` directly), and through `start()`: panel Start and Reconnect
  (`src/routes/dashboard.api.esm.js:1745`, `:1786`), network restoration (`src/core/session.js:400`)
  and `!restart` (`src/commands/restart.cjs:44`).

## 3. Message pipeline and commands

- `messages.upsert` is the only Baileys message event Levix subscribes to (`src/core/events.js:119`).
- `handleIncomingMessage()` drops non-content messages, including `reactionMessage`
  (`src/handlers/message.handler.js:26`, `:64`), then runs keyword auto-delete, the blacklist and
  anti-spam middleware, command dispatch and group moderation.
- Commands: 43 top-level modules in `src/commands/` and 26 group sub-commands in
  `src/commands/group/`, 69 files in total. Group files register twice: as `!kick` and as
  `!group kick` (`src/handlers/command.handler.js:207`).
- Parsing: the prefix must start the body exactly; the rest is split on `/\s+/`, so a newline already
  separates a command from its sub-command (`src/handlers/command.handler.js:289`). An unknown
  command returns `false` with no reply and group moderation still runs (`:291`).
- Permissions: the dispatcher calls `evaluatePermissionLevel()`
  (`src/middleware/permissions.middleware.js:78`, `src/utils/permissionLevel.cjs:15`). The group
  router bypasses the dispatcher's checks (`src/handlers/command.handler.js:321`) and runs its own
  switch (`src/commands/group.cjs:122`).
- Known inconsistencies: `blacklist` declares aliases `block` and `unblock`, which are also command
  names (`src/commands/blacklist.cjs:14`, `src/commands/block.cjs:8`). `src/config/defaults.cjs` has
  keys with no command file (`tagadmins` top-level, `group:notes`, `group:blacklist`,
  `group:remove`), and three group files have no key (`antispam`, `flagged`, `note`).
- Replies: `createStatus()` edits one message in place (`src/utils/statusMessage.cjs`, 11 production
  call sites). `sendBotMessage()` adds the human-like delay (`src/utils/sendBotMessage.esm.js:28`, 50
  call sites outside its own modules). `.sendMessage(` appears 315 times under `src/` and `scheduler.cjs`.
- Destinations other than the source chat: `!schedule` and `!autoschedule` errors go to the
  creator's private chat (`src/commands/schedule.cjs:22`); the WhatsApp password-reset code goes to
  the linked account's own chat (`src/panel/password-reset.cjs:189`); scheduled jobs send to their
  stored `targetJid` (`scheduler.cjs:222`).
- Message cache: `src/utils/recentMessageCache.esm.js` keeps only messages the bot sent, for one
  hour, at most 500, to answer Baileys retries.
- `!status` is `OWNER_ONLY` (`src/config/defaults.cjs:52`) and prints uptime, RSS, Node version,
  Baileys version, platform, `os.release()` and the FFmpeg version or path
  (`src/commands/status.cjs:41`).

## 4. Language layers

| Layer | Languages | Where |
| --- | --- | --- |
| Bot replies | `ar`, `en`; `bot_language` is `auto`, `ar` or `en` | `src/config/settings.cjs:32`, `src/utils/i18n.cjs:99` (`withLang` maps anything but `en` to `ar`), 584 matches of `tr(` in `src/` and `scheduler.cjs` |
| Command docs | `{ en, ar }` per command | `src/utils/commandDocs.cjs:11` |
| AI reply | follows `bot_language`: fixed Arabic or English, or in `auto` the user's own language, any language; no separate setting | `src/services/aiAgent.cjs:160` to `:173` |
| Dashboard | `Language = "ar" \| "en"`, 1001 keys each, stored in `localStorage.levix_lang` | `frontend/src/i18n/translations.ts:3`, `frontend/src/context/I18nContext.tsx:55` |
| Dashboard inline strings | 68 `language === "ar"` checks, 41 of them in `ConnectionView.tsx` | `frontend/src/views/` |
| Gateway pages | 89 keys each in `DICT.en` and `DICT.ar` | `public/gateway-i18n.js:20`, `public/ui-boot.js:19` |
| Android | `values/` and `values-ar/`, 246 strings each; `UiPrefs.validLanguage` is `ar` or `en`; no `android:localeConfig` | `android/app/src/main/java/net/leviro/levix/UiPrefs.kt:17` |
| Recovery mail relay | `lang` normalized to `ar` or `en` | `src/panel/recovery-email.cjs:59` |
| TTS | `synthesizeVoice(text, lang = "ar")`; `!tts` passes no language | `src/commands/tts.cjs:115`, `:182` |

## 5. AI agent

- Providers: `gemini`, `openai` (any OpenAI-compatible server) and `anthropic`, chosen by
  `ai_provider`. Function tools go to all three; Google Search grounding is Gemini only
  (`src/services/aiAgent.cjs:306`).
- 17 tools in `src/services/aiTools.cjs`: `web_search`, `search_wikipedia`, `search_news`,
  `fetch_url`, `save_memory`, `search_memory`, `forget_memory`, `grant_role`, `revoke_role`,
  `list_roles`, `get_datetime`, `calculate`, `create_reminder`, `cancel_reminder`, `speak`,
  `create_poll`, `summarize_chat`. `AGENTS.md` does not list `search_wikipedia` or `search_news`.
- Authorization: `src/services/aiToolAuth.cjs` mints a frozen caller from the real sender and checks
  each tool's `access` entry against the live command permission before `run()`.
- Media: `!generate` uses Gemini only (`gemini_image_model`). `!stt` uses Gemini or an
  OpenAI-compatible Whisper endpoint (`src/commands/stt.cjs:52`). The agent has no image-generation
  or transcription tool.
- Memory: `buildMemoryContext()` puts `memory/global.md` into every agent prompt that
  `buildSystemInstruction()` builds, in groups and in other people's private chats, next to that
  chat's own file (`src/utils/memory.cjs:370`, `src/services/aiAgent.cjs:198`).

## 6. Data at rest

### 6.1 Data directory

Resolved by `src/config/paths.cjs:43`: `--data`, then `LEVIX_DATA_DIR`, then `<repo>/data` in a
checkout, then `~/.levix`. On Android it is `<filesDir>/data`, mode 0700
(`LevixAppBundle.kt:25`).

| Path | Content | Owner |
| --- | --- | --- |
| `levix.db`, `levix.db-wal`, `levix.db-shm` | the SQLite database, WAL mode | `src/db/db.cjs:26`, `:36` |
| `levix.key` | 32-byte AES-256-GCM vault key, mode 0600, never stored in the database | `src/config/vault.cjs:24` |
| `levix.lock` | single-instance lock | `src/config/lock.cjs:23` |
| `panel.sock` | panel socket, Android only | `src/bootstrap/panel.js:18` |
| `ai-persona.md` | the operator's editable persona | `src/services/aiAgent.cjs:80` |
| `memory/global.md`, `memory/chats/<jid>.md` | long-term AI memory | `src/utils/memory.cjs:45` |
| `logs/`, `logs/debug/debug-YYYY-MM-DD.log` | logs; debug files expire after 14 days | `src/utils/logger.cjs:10`, `src/diagnostics/debugLog.cjs:30` |
| `media/`, `media/schedules/<job id>` | temporary media, scheduled-message files | `src/bootstrap/core.js:50`, `scheduler.cjs:27` |
| `stickers/<sha[0..2]>/<sha>.webp` and `.thumb.webp` | Sticker Studio files | `src/stickers/library.cjs:212` |
| `tmp/stickers/` | panel uploads, swept after one hour | `src/stickers/uploads.cjs:26` |
| `crash-reports/` | at most 20 reports, 7 days | `src/diagnostics/crashReports.cjs:21` |

### 6.2 Database

- Pragmas: `journal_mode = WAL`, `synchronous = NORMAL`, `foreign_keys = ON`, `busy_timeout = 5000`
  (`src/db/db.cjs:36` to `:42`).
- 10 migrations in `MIGRATIONS` (`src/db/db.cjs:52`), applied by `PRAGMA user_version`
  (`:678`). Append only.
- 22 tables. `group_directory` (`src/db/db.cjs:188`) is missing from the table list in `AGENTS.md`.

### 6.3 Secrets

| Item | Storage | Protection |
| --- | --- | --- |
| Vault key | `<data>/levix.key` | file mode 0600 |
| WhatsApp credentials and signal keys | `baileys_auth` rows | sealed with the vault key (`src/db/store.cjs:37`, `:1275`) |
| Secret settings (API keys, proxy password) | `bot_settings` `setting:<key>` | sealed (`src/db/store.cjs:53`) |
| Recovery email record and token | `bot_settings` `auth:recovery-email` | sealed (`src/config/secrets.cjs:127`) |
| Panel password | `bot_settings` `auth:password` | scrypt hash, 16-byte salt, 64-byte key (`src/config/secrets.cjs:61`) |
| Session signing key | `bot_settings` `secret:session` | stored as plain hex, not sealed (`src/config/secrets.cjs:51`) |
| Setup code | process memory only | printed in the terminal (`src/config/secrets.cjs:174`) |

Consequence for backups: a copy of `levix.db` without `levix.key` cannot open sealed values. A copy
that holds both files exposes every sealed secret. A copy of `levix.db` alone still exposes the
session signing key and the password hash.

### 6.4 Android state outside the data directory

- `<filesDir>/app`: the extracted `levix-app.zip`, replaced when the app version or update time
  changes (`LevixAppBundle.kt:35`).
- SharedPreferences: `levix_host` (`wanted_running`), `levix_onboarding`, `levix_crash_reports`,
  `media_hub`, `ui_prefs` (theme). The UI language is stored by AppCompat (`autoStoreLocales`).
- `android:allowBackup="false"` (`AndroidManifest.xml:26`).

### 6.5 Unlink

`clearAccountScopedState()` (`src/core/session.js:77`) clears the WhatsApp directory, AI histories,
memory files, AI context buffers, the sticker library, the group metadata cache and auto-delete
copies and counters, pauses schedules and resets the owner and admin rosters. The panel password
and the recovery email stay.

## 7. Panel and auth

- Session validity needs `loggedIn`, a stored password and a matching password epoch
  (`src/panel/session-auth.cjs:6`). Cookie `wa.sid`: 12 hours, HttpOnly, SameSite Lax, Secure on
  HTTPS (`app.cjs:33`, `:175`).
- Mutations pass an Origin check with a narrow `Origin: null` allowance for login and reset posts
  (`app.cjs:38`, `:125`). Setup without a code is allowed only for a direct loopback request with no
  proxy configuration and no forwarding headers (`src/utils/requestOrigin.cjs:93`).
- `/dashboard/api/*` requires a valid session (`src/bootstrap/panel.js:51`). socket.io checks the
  Origin and the session epoch at handshake and before each push (`app.cjs:82`, `:187`).
- `GET /` serves the React build to a valid session, falls back to `views/dashboard.ejs` when the
  build is missing, and renders the login page otherwise (`app.cjs:314`).

## 8. Packaging and runtimes

| Artifact | Node source | Notes |
| --- | --- | --- |
| npm package | user's Node; `engines` `>=24` | `package.json:75` |
| SEA binaries | the CI runner's Node (`setup-node` 24) | `scripts/build-sea.mjs:275` copies `process.execPath` |
| Docker image | `node:24-slim`, production dependencies only | `Dockerfile:6`, `:10` |
| Android APKs and AAB | Termux `nodejs-lts`, unpinned | `android/scripts/fetch-node-android.sh:34`; v4.9.1 ships `v24.22.1` |

Android build facts: `compileSdk` and `targetSdk` 36, `minSdk` 29; ABI splits `arm64-v8a` and
`armeabi-v7a`; `isMinifyEnabled = false`; `useLegacyPackaging = true`
(`android/app/build.gradle.kts:112` to `:179`). 16 KB page alignment and NDK r28 or newer are
checked when the runtime is staged (`android/scripts/fetch-node-android.sh:168`). FFmpeg 8.1.3 is
built with NDK r29 and the `libwebp` and `libwebp_anim` encoders, which Gradle verifies
(`android/app/build.gradle.kts:49`).

## 9. Outbound network

The full table with triggers and privacy-policy coverage is in `AUDIT.md` section 3. In short:
WhatsApp; the configured AI provider; Gemini Google Search grounding; DuckDuckGo, Google
Programmable Search, Wikipedia; pages opened by `fetch_url`; Google Translate (official API with a
key, or the public `translate_a/single` endpoint without one); Google TTS (`translate.google.com`);
OpenWeatherMap; AlAdhan; is.gd and v.gd; opt-in link previews and remote thumbnails; provider model
discovery; `api.ipify.org` during `levix domain`; and three Levix relays (feedback, crash reports,
recovery email) that run only on an operator action. No analytics SDK exists.

## 10. Target architecture (PLANNED)

### 10.1 Build (Phase 01)

Two trees from one lockfile: a full tree that builds the React dashboard, and a production-only tree
that becomes `levix-app.zip`. Node 24 pinned by exact Termux package version and sha256 per ABI. A CI
job prints a component size table and the delta against the previous release.

### 10.2 Backup (Phase 02)

A backup is a local archive with a manifest (format version, app version, schema version, file list
with sha256). The database is copied through the SQLite backup API from `node:sqlite`. Restore runs
preview, validation, checksum check, stop of the session and the scheduler, staging, switch, then
restart. A schema newer than the running app is refused. Three design points must be settled in the
Phase 02 ADR before the format is fixed:

1. Secrets share tables with ordinary data (`baileys_auth`, `setting:<secret key>` rows, `auth:*`
   and `secret:session` in `bot_settings`). "Secrets excluded" therefore means a filtered copy of
   the database with those rows removed, plus a defined restore rule for them (Q-22).
2. A restore replaces several files and directories (database, memory, persona, schedule media,
   stickers). One rename does not make that atomic. The switch needs a journal written before the
   first move and a recovery step at the next start that completes or undoes an interrupted switch.
3. A backup before a pending migration is impossible today, because importing the store opens and
   migrates the database before the instance lock (AUDIT B-09). Phase 02 changes the start order:
   open the database without migrating, take the lock, detect pending migrations, write the backup,
   then migrate.

### 10.3 Locale catalog (Phase 03)

One canonical catalog with stable keys for `ar`, `en`, `pt-BR`, `es-419`. Generators write the React
module, the Node catalog, the gateway dictionary and Android `strings.xml` files. Three settings: UI
language, bot reply language, AI reply language. `tr(en, ar)` stays as a wrapper until each call
site moves to a keyed call such as `msg("moderation.warn", { count })`.

### 10.4 Gateway and consent (Phase 04)

React renders login, setup, QR and recovery. All checks in section 7 stay in the server. The session
gains a `consent_required` state: `WhatsAppSession` checks the local acceptance record before
`#open()` and creates no socket without it (ADR-006). Terms come from a versioned Leviro source,
are cached with version and hash, and fall back to a bundled copy offline.

### 10.5 Message pipeline (Phase 05)

```
parse -> authorize -> execute -> render -> route -> send
```

- parse: Command Engine v2 (prefix, aliases, sub-commands, newline handling).
- authorize: `evaluatePermissionLevel()` for every command and sub-command (ADR-011).
- render: keyed message templates with category (`progress`, `result`, `error`, `security`,
  `system`) and sensitivity; the only place a watermark can be added (ADR-012).
- route: Reply Router; same chat by default; other destinations only when authorized (ADR-007).
- send: `createStatus()` editing and `sendBotMessage()` delivery keep their current behaviour.

### 10.6 AI (Phase 06)

Two small tools search and open a bundled, versioned index of approved user docs. Image, TTS and STT
tools call the existing command code paths and declare `access` entries for the commands they stand
in for.

### 10.7 Automation (Phase 07)

A reaction rules engine subscribed to Baileys reaction events, with a bounded message lookup only
for chats that have an enabled rule (ADR-008). AI Auto Reply reuses the agent with the real sender
as caller, per-chat opt-in, rate limits and a kill switch (ADR-009).

### 10.8 Plus boundary (Phase 08)

The public core exposes versioned interfaces: `entitlements`, `message-template-overrides`,
`visibility-policy`, `advanced-route-overrides`, `watermark-policy`. With no extension installed,
every interface returns the Free default.

### 10.9 Distribution UX (Phase 09)

Update checks per install channel with allowlisted HTTPS origins and a local cache. `!update`
reports status and a release link. Official links open in the system browser from the Android
WebView. Rating and star prompts are user actions with local dismiss flags only.

# Levix v5.0.0 Phase 00 audit

Audited commit: `050d8b9` (v4.9.2), 2026-10-30. Six read-only audit runs mapped the tree (startup and
auth, commands and messaging, docs and data flows, Android and build, i18n and AI, data at rest).
Every row below was then checked against the source by the orchestrator. Rows marked INFERENCE are
conclusions from the cited facts, not observed behaviour.

## 1. Fact, evidence, risk, action

### Runtime and build

| # | Fact | Evidence | Risk | Action |
| --- | --- | --- | --- | --- |
| A-01 | Android fetches Termux `nodejs-lts` by name with no version pin and no `.deb` checksum. | `android/scripts/fetch-node-android.sh:34` | Node 26 became LTS on 2026-10-28; a Termux promotion changes the shipped major with no code change. | Phase 01: pin version and sha256 per ABI; fail when the major is not 24. |
| A-02 | `engines.node` is `>=24`; the CLI rejects only majors below 24. | `package.json:75`, `src/cli.js:13` | Node 26 users get no signal. | Q-01 decides warn or refuse. |
| A-03 | Release jobs `verify-version` and `installer` run `node` with no `setup-node`. | `.github/workflows/release.yml:47`, `:381` | Those jobs use the runner's default Node. | Phase 01: add `setup-node` 24. |
| A-04 | Android staging copies the installed `node_modules/` minus five native packages; 70.0% of the v4.9.1 `levix-app.zip` is dev dependencies (25,870,866 of 36,934,593 compressed bytes). | `android/scripts/stage-levix-app.sh:65`; `BASELINE.md` section 6 | Users download an x86_64 linter binary inside an ARM app. | Phase 01: production-only staging tree (ADR-017). |
| A-05 | The `cp -a` fallback in staging skips the `.cache` and `*.map` exclusions that the `rsync` branch applies. | `android/scripts/stage-levix-app.sh:76` | Output differs by build machine. | Phase 01: one exclusion list for both branches. |
| A-06 | `levix-app.zip` is built with `zip -qr` over a directory walk: no sorted order, no fixed timestamps. | `android/scripts/stage-levix-app.sh:89` | Builds are not reproducible; identical sources give different bytes. | Phase 01: evaluate sorted entries and fixed mtimes. |
| A-07 | Two SQLite libraries ship that no library lists as `NEEDED` (1,348,861 stored bytes in v4.9.1 arm64). | `readelf -d` on the v4.9.1 APK; `BASELINE.md` section 6 | Dead weight, if nothing loads them at run time. | Phase 01: confirm no `dlopen`, then drop. |
| A-08 | `isMinifyEnabled = false`; no `isShrinkResources`; `classes.dex` is 9,709,524 bytes. | `android/app/build.gradle.kts:173` | Larger APK. | Phase 01: R8 experiment on a branch, kept only with device proof. |
| A-09 | No CI job measures APK, AAB, `levix-app.zip`, SEA or Docker size. Only the npm tarball has a size check. | `tests/package.test.mjs:115`; `.github/workflows/*.yml` | The 6 MB growth in v4.9.2 passed unnoticed. | Phase 01: size table and delta per build. |
| A-10 | Android Gradle refuses to configure without a staged Termux runtime and FFmpeg. | `android/app/build.gradle.kts:51` | Contributors cannot run Android unit tests without the full native staging. | Phase 01: document; consider a unit-test path that does not need the runtime. |
| A-11 | `npm audit`: 7 production advisories (3 high: `body-parser`, `engine.io`, `follow-redirects`), all transitive with fixes available. | `npm audit`, 2026-10-30 | Known DoS and header-handling issues in runtime dependencies. | Phase 01 supply-chain step. |

### Startup, session and auth

| # | Fact | Evidence | Risk | Action |
| --- | --- | --- | --- | --- |
| B-01 | `WhatsAppSession.#open()` is the only socket builder; the retry timer calls it directly. | `src/core/session.js:571`, `:1033` | A consent check placed in `start()` or a route misses retries. | ADR-006: check inside the session before `#open()`. |
| B-02 | A paired install resumes WhatsApp on every process start; headless always starts. | `src/bootstrap/session-startup-policy.js:22`, `src/bootstrap/core.js:86` | Restarts bypass any gate placed on manual pairing. | Phase 04 tests cover both policies. |
| B-03 | Android `BootReceiver` restarts the host when the user left it running; the service retries Node after an unexpected exit. | `BootReceiver.kt:20`, `LevixHostService.kt:139` | Android is a separate start path for the consent gate. | Phase 04 Android lifecycle test. |
| B-04 | No Terms, consent or legal acceptance code exists. | grep of `src/`, `frontend/src/`, `views/`, `public/`, `android/` | Phase 04 starts from nothing. | Phase 04 designs the record and the state. |
| B-05 | Settings export skips secret settings and every `auth:*` key. | `src/services/settingsTransfer.cjs:42`, `:61` | A consent record stored as `setting:*` would travel between installs. | ADR-006: store consent outside `setting:*`. |
| B-06 | All panel auth checks run in the server: session epoch, Origin check, setup-code rule, throttles, socket.io handshake. | `src/panel/session-auth.cjs:6`, `app.cjs:125`, `src/utils/requestOrigin.cjs:93`, `app.cjs:82` | A React migration that moves a check to the client weakens auth. | ADR-005: React renders only. |
| B-07 | `GET /` falls back to `views/dashboard.ejs` when the React build is missing. | `app.cjs:314` | Removing EJS without a replacement serves nothing useful. | Phase 04: static error shell. |
| B-08 | `levix reset-password` opens and writes the database without the single-instance lock, by design, so it works while the bot runs. | `src/cli.js:108`, `src/config/lock.cjs:14` | A restore or backup can race a concurrent CLI write. | Phase 02: quiesce or lock rule for every writer. |
| B-09 | Importing the store opens and migrates the database before `bootstrapCore()` takes the single-instance lock. | `src/bootstrap/core.js:16`, `:26`, `:42`; `src/db/db.cjs:32`, `:707` | A second process can migrate before it fails the lock check; a pre-migration backup cannot run before the import. | Phase 02 changes the start order: open, lock, detect pending migrations, back up, migrate. |

### Commands and messaging

| # | Fact | Evidence | Risk | Action |
| --- | --- | --- | --- | --- |
| C-01 | 43 top-level and 26 group command files, 69 in total. `AGENTS.md`, `ANDROID.md` and `PACKAGING.md` say 69. | `ls src/commands`; `AGENTS.md:9` | Counts drift when v5 adds `!update`. | Phase 09 updates the counts. |
| C-02 | The parser splits on `/\s+/`, so `!group\nkick @x` already dispatches like `!group kick @x`. | `src/handlers/command.handler.js:289` | v5 newline work may break current behaviour if it changes the split. | Phase 05: parser fixtures first. |
| C-03 | The group router bypasses the dispatcher's permission checks and runs its own switch. | `src/handlers/command.handler.js:321`, `src/commands/group.cjs:122` | `!kick` and `!group kick` can disagree for a bot admin. | ADR-011, Q-07. |
| C-04 | `blacklist` declares aliases `block` and `unblock`, which are also command names. | `src/commands/blacklist.cjs:14`, `src/commands/block.cjs:8` | Alias resolution depends on load order. | Phase 05 alias table check. |
| C-05 | `defaults.cjs` has permission keys with no file (`tagadmins`, `group:notes`, `group:blacklist`, `group:remove`); `antispam`, `flagged` and `note` have no key and fall back to `ADMINS_OWNER`. | `src/config/defaults.cjs:30`, `:85` to `:92`, `src/config/runtime-config.cjs:79` | `!note` is admin-only, likely by accident. | Q-08. |
| C-06 | An unknown command returns silently, and group moderation still runs on that message. | `src/handlers/command.handler.js:291`, `src/handlers/message.handler.js:142` | Typos get no help. | Phase 05 unknown-command policy. |
| C-07 | Six commands send a separate progress message before the result. | `src/commands/prayer.cjs:47`, `group/members.cjs:23`, `group/add.cjs:93`, `group/setpp.cjs:35`, `restart.cjs:35`, `stopbot.cjs:47` | Breaks the one-message rule in `AGENTS.md`. | Phase 05 message engine. |
| C-08 | Reactions are dropped: `reactionMessage` is non-content, and no `messages.reaction` listener exists. | `src/handlers/message.handler.js:26`, `src/core/events.js:119` | Phase 07 needs new event intake. | ADR-008. |
| C-09 | The only message cache holds bot-sent messages for one hour, at most 500. | `src/utils/recentMessageCache.esm.js:13` | A reaction cannot be matched to the original user message today. | ADR-008 bounded lookup. |
| C-10 | Replies go to the source chat, except `!schedule` errors (creator's private chat) and the password-reset code (linked account's own chat). | `src/handlers/command.handler.js:70`, `src/commands/schedule.cjs:22`, `src/panel/password-reset.cjs:189` | The Reply Router must keep or deliberately change these. | Phase 05 inventory. |
| C-11 | `!status` is `OWNER_ONLY` and prints Node, Baileys and kernel versions and the FFmpeg path on failure. | `src/config/defaults.cjs:52`, `src/commands/status.cjs:41` | If an operator lowers the permission, members see internals. | Phase 05 short output plus owner-only debug (Q-06). |
| C-12 | `!prayer` always requests the timings for the fixed date `06-06-2025`, with `country=EG` and the Cairo time zone, and puts the city into the URL without encoding. Unchanged since the first commit (`68be70d`). | `src/commands/prayer.cjs:44` | Every user gets wrong prayer times on every other day; a crafted city can add query parameters. | Fixed in PR #83 (Q-13). |

### Language and AI

| # | Fact | Evidence | Risk | Action |
| --- | --- | --- | --- | --- |
| D-01 | Bot strings, command docs, the dashboard, the gateway and Android support `ar` and `en` only; `withLang()` maps any value other than `en` to `ar`. The AI follows `bot_language`, and in `auto` it answers in the user's language, whatever it is. | `src/utils/i18n.cjs:99`, `src/services/aiAgent.cjs:160` to `:173`; table in `ARCHITECTURE.md` section 4 | A third locale silently becomes Arabic. | Phase 03 catalog. |
| D-02 | 584 matches of `tr(` in `src/` and `scheduler.cjs` (86 files, the definition and a few comments included); 1001 dashboard keys per language; 68 inline `language === "ar"` checks in the dashboard. | grep counts; `frontend/src/i18n/translations.ts` | Large migration surface. | Phase 03 slices by area. |
| D-03 | There is no AI reply language setting. | `src/services/aiAgent.cjs:160` | Cannot split UI, bot and AI language today. | Phase 03 adds the setting. |
| D-04 | `!tts` calls `synthesizeVoice(text)` with the default `lang = "ar"`. | `src/commands/tts.cjs:115`, `:182` | English text is spoken with the Arabic voice setting. | Phase 03 or 06 passes the reply language. |
| D-05 | Android has no `android:localeConfig`. | `android/app/src/main/AndroidManifest.xml` | Android 13+ system language settings cannot list Levix languages. | Phase 03. |
| D-06 | The agent has 17 tools, none for image generation or transcription. `AGENTS.md` omits `search_wikipedia` and `search_news`. | `src/services/aiTools.cjs` | Natural-language media requests cannot run today. | Phase 06; `AGENTS.md` fixed in this PR. |
| D-07 | `memory/global.md` enters every agent prompt built by `buildSystemInstruction()`, in groups and in other people's private chats. | `src/utils/memory.cjs:370`, `src/services/aiAgent.cjs:198` | Facts saved as global can surface in any group. | Phase 07 must not widen it; Q-09. |
| D-08 | `!generate` works with Gemini only; `!stt` supports Gemini and OpenAI-compatible Whisper, not Anthropic. | `src/commands/gemini.cjs:342`, `src/commands/stt.cjs:52` | Media tools depend on the provider. | Phase 06 capability gating. |

### Data at rest

| # | Fact | Evidence | Risk | Action |
| --- | --- | --- | --- | --- |
| E-01 | Sealed values need `<data>/levix.key`, which lives outside the database. | `src/config/vault.cjs:24` | A database-only restore cannot open API keys or the WhatsApp session. | Phase 02 restore set rules (ADR-016). |
| E-02 | `secret:session` (panel session signing key) is stored unsealed. | `src/config/secrets.cjs:51` | A copied database lets someone forge panel cookies for that install. | Phase 02 excludes or rotates it on restore. |
| E-03 | User data lives in the database plus `memory/`, `ai-persona.md`, `media/schedules/`, `stickers/`. | `ARCHITECTURE.md` section 6.1 | A database-only backup loses memory, persona, schedule media and stickers. | Phase 02 inclusion policy. |
| E-04 | Android preferences (`levix_host`, `levix_onboarding`, `levix_crash_reports`, `media_hub`, `ui_prefs`) sit outside the Node data directory; `allowBackup="false"`. | `ARCHITECTURE.md` section 6.4 | A Node-side backup does not restore Android settings. | Q-10. |
| E-05 | Settings export (`format: "levix-settings"`, `version: 1`) carries configuration only. | `src/services/settingsTransfer.cjs:32` | Operators may mistake it for a backup. | Phase 02 names the two clearly. |
| E-06 | The local branch `zcode/commands-panel-upgrades` is not merged by ref, but both of its commits are patch-identical to `main` commits `ec1d762` and `cb9d09a`. The branch does not exist on GitHub. | `git cherry main zcode/commands-panel-upgrades` (both `-`); `git patch-id` | None: `main` already has the changes. | Resolved (Q-02); the owner may delete the local branch. |

## 2. Public document drift

Only rows that are wrong or stale are listed. None of these files changes in the Phase 00 PR; the
fixes wait for owner approval (Q-11) because some of them are privacy statements.

| Document | Claim | Code | Verdict | Proposed fix |
| --- | --- | --- | --- | --- |
| `PRIVACY.md:117` | recipient table is complete | Google TTS, both Google Translate paths, Wikipedia, Gemini grounding, OpenWeatherMap, AlAdhan, is.gd and v.gd, opt-in link previews and thumbnails, model discovery and `api.ipify.org` are missing (section 3) | WRONG | add one row per destination |
| `PRIVACY.md:121` | search goes to DuckDuckGo or Google Programmable Search | `search_wikipedia` sends queries to Wikipedia and Gemini grounding sends them to Google (`src/services/aiTools.cjs:191`, `src/services/aiAgent.cjs:306`); `search_news` uses the same DuckDuckGo or Programmable Search path as `web_search` | STALE | name Wikipedia and Gemini grounding |
| `PRIVACY.md:110` | the panel binds `127.0.0.1:3001` | Android uses `<data>/panel.sock`; desktop bind address is a setting (`src/bootstrap/panel.js:90`) | STALE | describe per platform |
| `README.md:103` | `!translate` has its own editable prompt | the prompt is the constant `TRANSLATE_PROMPT` (`src/commands/translate.cjs`) | WRONG | drop the phrase |
| `README.md:103` | Google's translation engine | official API with a key, or the public `translate_a/single` endpoint without one (`src/commands/translate.cjs:23`) | STALE | name both paths |
| `ANDROID.md:12` | the panel opens in the phone browser at `127.0.0.1:3001` | Android serves the panel on a socket file (`src/bootstrap/panel.js:90`) | WRONG | WebView only, or ADB forwarding |
| `ANDROID.md:215` | `adb backup` saves Levix data | `android:allowBackup="false"` (`AndroidManifest.xml:26`) | WRONG | remove the instruction |
| `ANDROID.md:121` | reconnects within 2 seconds | no such timer (`LevixHostService.kt:263`) | UNVERIFIABLE | drop the number |
| `ANDROID.md:6` | Node.js 24 LTS runtime | unpinned `nodejs-lts` (A-01) | TRUE today, not guaranteed | keep after Phase 01 pins it |
| `PACKAGING.md:173` | fifteen ESM files use `createRequire` | 25 files do | STALE | drop the count |
| `PACKAGING.md:75` | sentence repeated | | STALE | delete the repeat |
| `SETUP.md:157` | two features need a free key | `youtube_api_key` exists with no user (`src/config/settings.cjs:326`) | STALE | remove the setting or explain it (Q-12) |
| `UI-UX-TODO.md:38` | adaptive home is in the uncommitted tree | committed | STALE | mark as landed |
| `AGENTS.md` table "Tables" | lists 21 tables | 22 exist; `group_directory` is missing (`src/db/db.cjs:188`) | STALE | fixed in this PR |
| `AGENTS.md` "Logging" | `src/utils/logger.js` | the file is `src/utils/logger.cjs` | STALE | fixed in this PR |

## 3. Outbound destinations

| Destination | Purpose | Trigger | Evidence | In `PRIVACY.md` |
| --- | --- | --- | --- | --- |
| WhatsApp servers | protocol, pairing, messages, media | while linked | `src/core/socket.js` | yes |
| AI provider (Gemini, OpenAI-compatible, Anthropic) | chat, `!generate`, `!stt`, media upload | operator key | `src/config/settings.cjs`, `src/utils/geminiMedia.cjs` | yes |
| Google Search grounding | search inside a Gemini request | default on with Gemini (`ai_google_search`) | `src/services/aiAgent.cjs:306` | no |
| `html.duckduckgo.com` | `web_search` | AI tool call | `src/services/aiTools.cjs` | yes |
| `www.googleapis.com/customsearch` | `web_search` with a key | operator key | `src/services/aiTools.cjs` | yes |
| `*.wikipedia.org` | `search_wikipedia`, summaries | AI tool call | `src/services/aiTools.cjs:167`, `:191` | no |
| any HTTPS host | `fetch_url` | AI tool call | `src/services/aiTools.cjs` | yes |
| `translation.googleapis.com` | `!translate google` with a key | user command | `src/commands/translate.cjs:23` | no |
| `translate.googleapis.com/translate_a/single` | `!translate google` without a key | user command | `src/commands/translate.cjs:24` | no |
| `translate.google.com` | Google TTS for `!tts` and `speak` | user command or AI tool | `src/commands/tts.cjs:36` | no |
| `api.openweathermap.org` | `!weather` | user command, operator key | `src/commands/weather.cjs:41` | no |
| `api.aladhan.com` | `!prayer` | user command | `src/commands/prayer.cjs:44` | no |
| `is.gd`, `v.gd` | `!shortlink` | user command | `src/commands/shortlink.cjs:26` | no |
| host of a URL the bot sends | link preview | opt-in, default off | `src/core/socket.js:52` | no |
| host of a remote media URL | thumbnail | opt-in, default off | `src/utils/thumbnail.cjs:86` | no |
| provider `/models` | model discovery | operator button | `src/services/llmDiscovery.cjs:143` | no |
| `api.ipify.org` | public IP during `levix domain` | operator command | `src/domain/system.js:111` | no |
| `levix.leviro.net/api/feedback` | feedback | operator presses Send | `src/panel/feedback.cjs:26` | yes |
| `levix.leviro.net/api/crash-reports` | one crash report | operator presses Send | `src/diagnostics/crashReports.cjs:51` | yes |
| `levix.leviro.net/api/recovery-email` | recovery email verify and reset | operator action | `src/panel/recovery-email.cjs:28` | yes |

No analytics or tracking SDK was found in `src/` or the Android sources. The Play Data safety rows in
`PRIVACY.md:360` say "Shared: No" for every data type. Whether that holds when content reaches the
operator's chosen AI provider, Google TTS or Google Translate needs a policy review before the next
store submission (Q-11).

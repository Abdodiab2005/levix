# Levix v5.0.0 architecture decisions (ADRs)

Status values:

- ACCEPTED: the project owner decided it. Reopen only for a technical or policy reason that is new.
- PROPOSED: Phase 00 recommends it. It needs owner approval before the phase that implements it.
- SUPERSEDED: replaced by a later ADR, which is named.

Every ADR lists the evidence it rests on. Line numbers refer to commit `050d8b9`.

---

## ADR-001: Node.js 24.x only

- Status: ACCEPTED (owner, locked decision 1).
- Context: Node 26 became LTS on 2026-10-28 (`v26.13.0`, "Lithium"). The latest Node 24 release is
  `v24.22.2` (2026-10-27). Termux publishes `nodejs-lts 24.22.1` and `nodejs 26.12.1` for both
  `aarch64` and `arm`. The Android build fetches `nodejs-lts` by name with no version pin and no
  checksum (`android/scripts/fetch-node-android.sh:34`), so a Termux promotion to 26.x would change
  the shipped major silently. `package.json:75` declares `"node": ">=24"`, `src/cli.js:13` rejects
  only majors below 24, and the release jobs `verify-version` and `installer` call `node` without
  `actions/setup-node` (`.github/workflows/release.yml:47`, `:381`).
- Decision: v5.0.0 builds, tests and ships on Node.js 24.x only. Phase 01 moves every runtime Levix
  builds (Android `libnode.so` for `arm64-v8a` and `armeabi-v7a`, SEA binaries, Docker image, CI) to
  the latest 24.x patch that passes the full gate on both Android ABIs at that time. No component
  moves to Node 26.
- Decision (ACCEPTED, owner, 2026-10-30, Q-01 option b): official builds use Node 24 only. A
  self-hosted user who runs Node 26 or later can still start Levix, with a clear warning that the
  version is not officially supported; support for it is best effort. Node below 24 is refused.
  `package.json` declares the supported range as `engines` `>=24 <25`, so npm warns at install time,
  and the CLI, `AGENTS.md`, `README.md`, `SETUP.md` and `PACKAGING.md` describe the same policy. The
  latest verified 24.x patch on 2026-10-30 is v24.22.2.
- Consequences: Phase 01 pins the Termux `.deb` version and sha256 per ABI and fails the fetch when
  `libnode.so` reports a major other than 24. CI and release jobs pin `node-version` to 24. Phase 01 PR
  01a changes `engines` and the CLI check (`src/cli.js:13`) together with their tests
  (`tests/package.test.mjs:128`, `tests/cli.test.mjs:226`). Until then the CLI accepts any major from
  24 up without a warning.
- Verification: a test reads the staged runtime stamp and asserts major 24; CI prints `node -v` in
  every job; Phase 10 checks every artifact's embedded version.

## ADR-002: Public core, private optional Plus

- Status: ACCEPTED (owner, locked decisions 2 and 10).
- Decision: `levix` stays public, MIT, complete, and it builds and passes its tests with no private
  code or credential. `levix-plus` is a private, proprietary, optional extension. Plus code, keys,
  source maps and build logs never enter this repository or its public artifacts (npm tarball,
  GitHub release, Docker image, Google Play AAB built from public sources).
- Consequences: the public repository defines a small versioned extension contract (Phase 08)
  and ships no stand-in Plus implementation by default. Code shipped to a device can be reverse
  engineered; repository privacy is not copy protection, and the docs say so.
- Verification: a CI job builds and tests the Free artifact with no Plus checkout and no secrets.

## ADR-003: Offline-first, no required Levix Cloud

- Status: ACCEPTED (owner, locked decision 3).
- Decision: the local Android Node backend and self-hosted servers keep working without any Leviro
  server, where the feature allows it. No remote JavaScript is downloaded and run. Two exceptions are
  allowed: subscription verification (Phase 08) and the central Terms of Service source (Phase 04).
  Both need a documented offline fallback, and neither may block Core features.
- Consequences: a Leviro outage can delay a Plus entitlement refresh or a Terms update. It cannot stop
  WhatsApp, commands or the AI for a user who already accepted the current Terms.

## ADR-004: Four locales and three separate language settings

- Status: ACCEPTED (owner, locked decision 4).
- Context: today every layer supports `ar` and `en` only. `src/config/settings.cjs:35` limits
  `bot_language` to `auto|ar|en`; `withLang()` maps any value other than `en` to `ar`
  (`src/utils/i18n.cjs:99`); `tr(en, ar)` has 584 call sites in 86 files; the dashboard has 1001 keys
  per language (`frontend/src/i18n/translations.ts`); the gateway has 89 keys per language
  (`public/gateway-i18n.js`); Android has 246 strings per language (`res/values`, `res/values-ar`).
  There is no AI reply language setting. The AI follows `bot_language`: fixed Arabic or English, or in
  `auto` the language the user writes in, whatever it is (`src/services/aiAgent.cjs:160` to `:173`).
- Decision: v5 supports `ar`, `en`, `pt-BR` and `es-419`. UI language, bot reply language and AI
  reply language are three settings. Translations live in one canonical catalog with stable keys, and
  build steps generate the React, Node, gateway and Android resources from it.
- Consequences: Phase 03 replaces the two-argument `tr()` progressively, keeps it as a wrapper during
  the migration, and adds a catalog validator to CI.

## ADR-005: React gateway replaces the EJS pages without weakening auth

- Status: ACCEPTED (owner, locked decision 5). Implementation rules PROPOSED.
- Context: `app.cjs` renders `views/setup.ejs`, `views/login.ejs` and `views/qr.ejs`, and falls back to
  `views/dashboard.ejs` when `public/dashboard/index.html` is missing (`app.cjs:314`). The auth
  checks live in the server: session validity with a password epoch (`src/panel/session-auth.cjs:6`),
  the mutation Origin check (`app.cjs:125`), setup-code rules (`src/utils/requestOrigin.cjs:93`),
  throttles (`src/panel/login-throttle.cjs`), and the socket.io handshake check (`app.cjs:82`).
- Decision (PROPOSED): React only renders the gateway screens. Every check above stays in the server
  and keeps its current tests. EJS files are removed only after the React screens pass the same
  negative-path tests, and the server still answers safely when the React build is missing.

## ADR-006: Terms consent is enforced where the WhatsApp socket is created

- Status: PROPOSED.
- Context: the only function that builds a socket is `WhatsAppSession.#open()`
  (`src/core/session.js:571`), which calls `createWhatsAppSocket()` (`src/core/socket.js:101`).
  `start()` is not the only caller: the retry timer calls `#open()` directly
  (`src/core/session.js:1033`). Paths that reach it include panel Start and Reconnect
  (`src/routes/dashboard.api.esm.js:1745`, `:1786`), `resume-paired` and headless `autostart`
  (`src/bootstrap/session-startup-policy.js:22`), network restoration (`src/core/session.js:400`),
  `!restart` (`src/commands/restart.cjs:44`) and the Android service restart
  (`android/app/src/main/java/net/leviro/levix/LevixHostService.kt:139`). No Terms or consent code
  exists today.
- Decision (PROPOSED): one consent check runs inside `WhatsAppSession` before `#open()` creates a
  socket, so every path above passes through it. A missing or outdated acceptance leaves the session
  in a new `consent_required` state and creates no socket. The acceptance record (Terms version,
  content hash, accepted-at time, locale) is stored locally outside the `setting:*` namespace, so
  settings export and import never carry it (`src/services/settingsTransfer.cjs:42`).
- Consequences: headless installs need an explicit acceptance path that does not exist yet (Q-04).
  The behaviour of an already connected socket when new Terms arrive is Q-05.

## ADR-007: Reply Router defaults to the same chat

- Status: ACCEPTED (owner, locked decision 9). Enforcement rules PROPOSED.
- Context: replies go to `msg.key.remoteJid` today (`src/handlers/command.handler.js:70`). Existing
  sends to another chat: `!schedule` and `!autoschedule` errors go to the creator's private chat
  (`src/commands/schedule.cjs:22`), and the WhatsApp password-reset code goes to the linked account's
  own chat (`src/panel/password-reset.cjs:189`).
- Decision: the default destination is the source chat. An operator can choose the owner's private
  chat or another chat that the backend has verified as authorized. Routing is decided in the
  backend; the dashboard only edits configuration. When the destination is not allowed or not
  reachable, the router fails closed with a neutral notice and never falls back to a group.
- Decision (PROPOSED, audience rule): authorizing the sender is not enough, because everyone in the
  destination reads the reply. A reply that carries content from a chat (message text, transcripts,
  quoted media, AI answers, which can include memory) may go only to a destination whose readers
  can already read that source chat. The owner's own private chat qualifies for any chat the linked
  account is in. Any other destination may receive only content classes without third-party
  content, such as progress and system notices, unless the owner adds an explicit, narrow exception.
- Consequences: the two existing exceptions stay (Q-21, decided 2026-10-30): `!schedule` errors go
  to the creator's private chat, and password-reset codes keep their private destination. Phase 05
  records them as named exceptions in the router.

## ADR-008: One generic reaction rules engine

- Status: ACCEPTED (owner, locked decision 8). Storage rule PROPOSED.
- Context: reactions are dropped today. `reactionMessage` is in `NON_CONTENT_KEYS`
  (`src/handlers/message.handler.js:26`) and `src/core/events.js` subscribes to `messages.upsert`
  only. The only message cache keeps messages the bot itself sent, for one hour, up to 500 entries
  (`src/utils/recentMessageCache.esm.js:13`).
- Decision: one engine evaluates trigger, conditions, action and destination. The voice-to-text
  example (a reaction on a voice note runs STT) is configuration, not code. Actions call existing
  capabilities through their existing permission checks.
- Decision (PROPOSED): a reaction can only act on a message the bot can still identify. Phase 07 adds
  a bounded, time-limited lookup that records only what a rule needs, only for chats that have an
  enabled rule. It does not archive message content by default (AGENTS.md gotcha 13).

## ADR-009: AI Auto Reply is opt-in, limited and part of Free

- Status: ACCEPTED (owner, locked decision 8).
- Decision: off by default. The operator enables it per contact or group, with trigger policies,
  rate limits, loop protection and a kill switch. Every tool call still runs as the real sender
  through `src/services/aiToolAuth.cjs`.

## ADR-010: Plus price lives in store configuration

- Status: ACCEPTED (owner, locked decision 10).
- Decision: USD 0.99 per month worldwide, with an Egypt price 30% lower, set through Google Play
  country pricing. The final EGP amount follows Play pricing, taxes and rounding. No code converts
  currencies or locates users by IP address.

## ADR-011: Command Engine v2 keeps the existing permission system

- Status: ACCEPTED (Phase 05 prompt; unification rule accepted by the owner on 2026-10-30).
- Context: the dispatcher checks permissions through `evaluatePermissionLevel`
  (`src/middleware/permissions.middleware.js:78`). The group router skips the dispatcher's checks
  (`src/handlers/command.handler.js:321`) and runs its own switch (`src/commands/group.cjs:122`).
  So `!kick` and `!group kick` can decide differently for a bot admin. Newline already separates a
  sub-command today, because the dispatcher splits on `/\s+/` (`src/handlers/command.handler.js:289`).
- Decision (ACCEPTED, owner, 2026-10-30): Phase 05 moves the group router onto
  `evaluatePermissionLevel`, after a before-and-after permission matrix for every registered command.
  No change may widen anyone's access without the owner's explicit approval; each widening case comes
  back as its own question. Changes that narrow access are listed in the phase report.

## ADR-012: `Powered by Levix` watermark through the message engine

- Status: ACCEPTED (owner, locked decision 10).
- Decision: eligible Free text replies end with a short localized watermark added in one place (the
  Phase 05 message engine). It is never added to raw transcripts, exact-output commands, files,
  security or legal text, API payloads, user input or AI prompts, or to a message that would exceed
  WhatsApp's length limit. An active Plus entitlement can hide it.

## ADR-013: Update checks follow the install channel and never run downloaded code

- Status: ACCEPTED (owner, locked decision 12).
- Decision: Google Play installs use Play in-app updates. GitHub, npm, Docker and self-hosted installs
  read GitHub Releases metadata over HTTPS from an allowlisted origin. Levix never downloads and runs
  JavaScript or an APK from a message, an AI answer or an unlisted host.

## ADR-014: Evidence labels in v5 documents

- Status: ACCEPTED (README of the planning package).
- Decision: features are labelled `SHIPPED`, `PLANNED` or `PENDING REVIEW`. Test results are
  labelled `PASS`, `FAIL`, `NOT RUN` or `BLOCKED`, with the command, platform, evidence and date.
  Public documents (`README.md`, `PRIVACY.md`, `SETUP.md`, `ANDROID.md`) describe shipped behaviour
  only.

## ADR-015: Phase order, PR size and release control

- Status: ACCEPTED (owner).
- Decision: phases run in the order 00 to 10, one at a time, each through reviewable pull requests.
  Nothing is pushed to `main` directly, merged automatically, tagged, released or uploaded to Google
  Play without the owner's explicit approval. The `play` job keeps its required reviewer.

## ADR-016: Local encrypted backups and safe migrations

- Status: ACCEPTED. Ordering rule accepted by the owner on 2026-10-30; backup content, encryption,
  restore and migration safety accepted on 2026-10-31 (Q-10, Q-14, Q-22, Q-24, Q-25, Q-26).
- Amended 2026-10-31 after the #91 review: the pre-migration copy and every temporary file exclude
  secret material.
- Rule: no migration runs until Levix holds the single-instance lock and has written a backup that
  passes verification. Phase 02 ships concurrency and failure tests for that rule: a second process
  starting at the same time, a crash during the backup, a crash during the migration, and a full
  disk.
- Context: Node v24.22.2 exports `backup()` from `node:sqlite` and `DatabaseSync.prototype.serialize`;
  the pinned Android `libsqlite3` exports the backup functions (run time on a device NOT VERIFIED).
  Secret material and the vault key layout are mapped in `ARCHITECTURE.md` section 6.
- Decision: backups are local files that the operator creates from the panel or the Android app.
  Every exported backup is encrypted with a password the operator types (scrypt, AES-256-GCM chunk
  stream, Node core only; `BACKUP_FORMAT.md`). It holds the settings, the command table, the API
  keys and the bot data, and never the WhatsApp pairing, the panel password, the panel session key,
  panel sessions, the recovery email, `levix.key`, device settings or Android preferences. A restore
  stages and verifies everything first, applies the settings in one transaction, seals the API keys
  with the target's `levix.key`, keeps the target's panel password, and holds the account data until
  a WhatsApp account that matches the backup is paired. A journal makes every step finish or undo
  after a crash. There is no CLI and no WhatsApp command for backups.
- Decision (restore writes only what the backup holds, amended 2026-10-31 after device QA): a
  setting, an API key, a command-table key or the persona that the backup does not hold keeps its
  current value; a restore never resets them. The preview lists what is added, replaced, unchanged
  or kept (`src/backup/plan.cjs`, from digests in the encrypted manifest). Any replacement or
  removal, including account data that would replace this install's data for the same account or
  a waiting restore, needs an explicit confirmation; the restore job rebuilds the plan from the
  staged rows and refuses with `CONFIRM_REQUIRED` without it. Device QA found the earlier rule
  (every restorable row replaced, persona removed when absent) erased the API key, language and
  AI provider of an install restored from a backup that held none.
- Decision (secret material): secret material means the WhatsApp pairing (`baileys_auth` and
  `qr_codes`), the panel password hash (`auth:password`), the recovery email record
  (`auth:recovery-email`), the panel session key (`secret:session`), and the API keys and the proxy
  password (`setting:<key>` for every secret setting). No pre-migration copy, no journal and no
  temporary or staging file holds it in plain text. Inside a backup the API keys are plain only
  within the encrypted payload (`secrets.json`).
- Decision (pre-migration copy, amended 2026-10-31 after the #91 review): before a pending migration
  the start path writes a local copy of the database to
  `<data>/backups/pre-migration/levix-v<from>-<stamp>.db` (file 0600, folder 0700, never exported,
  newest two kept) and runs all pending migrations in one transaction. The copy holds every table and
  every row except the secret material above. One module, `src/db/copy.cjs`, creates the schema in a
  new file and copies only the allowed rows from the live database in one read transaction, so no
  secret row reaches the copy, its journal or a temporary file. The pairing tables exist in the copy
  with no rows. The copy is written as a `.part` file, verified with `PRAGMA integrity_check`,
  `user_version`, row counts and a check for secret rows, fsynced and renamed. A crash leaves no file
  under a final name, and the next start deletes stale `.part` files.
- Decision (rollback without a stored WhatsApp session): with Levix stopped, the operator copies the
  chosen copy over `levix.db`, deletes `levix.db-wal` and `levix.db-shm` and starts the previous
  build. Levix then has no pairing, no panel password, no recovery email, no session key and no API
  keys. The panel opens `/setup` for a new password, and from another machine it also asks for the
  setup code printed in the terminal. A new session key is generated, the operator types the API keys
  again and pairs WhatsApp from the Connection screen. The operator pairs the same WhatsApp account;
  to start fresh for another account, Unlink is pressed after pairing. A failed migration needs none
  of this, because all pending migrations run in one transaction and the database stays at its old
  version.
- Decision (no plaintext secret in a temporary file): creating a backup holds the API key values in
  memory and writes them only inside the encrypted archive. Restoring decrypts the `secrets.json`
  entry into memory only and never writes it into the staged restore. A stop before the settings
  transaction commits discards the staged restore and the operator runs the restore again with the
  backup password. After the commit the keys are already sealed in `levix.db`.

## ADR-017: Android ships production dependencies only

- Status: PROPOSED (Phase 01).
- Context: 25,870,866 of the 36,934,593 compressed bytes in the v4.9.1 `levix-app.zip` are dev
  dependencies (`@biomejs/cli-linux-x64`, `postject`, `@biomejs/biome`), because the staging script
  copies the full `node_modules/` (`android/scripts/stage-levix-app.sh:65`). The Docker image already
  installs with `npm ci --omit=dev` (`Dockerfile:10`).
- Decision (PROPOSED): Android staging builds its `node_modules/` from the lockfile with production
  dependencies only, in a separate tree from the one that builds the React dashboard. The existing
  exclusions for native packages that cannot load on Android stay (`sharp`, `@img`, `ffmpeg-static`,
  `*.node`). The lockfile marks `sharp` as a production package because `@whiskeysockets/baileys`
  depends on it (`npm ls sharp`), so `--omit=dev` alone does not drop it.

## ADR-018: Android Node runtime from one pinned release archive

- Status: ACCEPTED (owner, 2026-10-31, Q-23, with conditions).
- Context: the Android build staged Node from 14 Termux `.deb` files pinned in
  `android/scripts/termux-packages.lock`. Termux serves only the newest build of each package, so a
  pinned file disappears when Termux updates it, and the GitHub Actions cache (11.6 GB in 44 entries
  on 2026-10-30, above the 10 GB repository limit) is evicted. A cold build would then lose its Node
  source (R-33).
- Decision: one deterministic archive, `levix-node-runtime-<version>-android.tar.xz`, holds both
  ABIs. It contains the unmodified files the staging uses (`node` and its libraries with their
  symlinks), the upstream licence texts of every component, and `MANIFEST.json` with the deb url and
  sha256 of every source package and the sha256 of every file. It is published once as the only
  asset of a dedicated GitHub prerelease and pinned by sha256 and size in
  `android/scripts/node-runtime.lock`. `fetch-node-android.sh` downloads only that asset, checks it
  and every file, and runs the existing patchelf staging. It never contacts Termux and never falls
  back to another Node. The 14 `.deb` files are not published.
- Conditions from the owner: verified upstream licence texts only (no placeholder or mislabelled
  file); verified sha256, manifest, provenance and binaries; a separate backup of the archive; a
  real cold-cache CI build from the release URL before merge; Node stays 24.
- Consequences: a new Node 24 patch needs Termux to publish it, then `--update-pins`,
  `--build-archive`, a new release asset with the owner's approval, and a lock update. If Termux
  stops shipping Node 24, building Node from source becomes the fallback (measured: the source
  tarball alone is 57,669,336 bytes, and Termux's recipe applies 32 patches).
- Verification: offline staging from the archive reproduces the CI-built libraries byte for byte on
  both ABIs, and the archive rebuilds with the same sha256 (2026-10-31, local). A cold-cache CI
  build from the release asset is required before merge; its result is recorded in the pull
  request.


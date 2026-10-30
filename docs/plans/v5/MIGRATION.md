# Levix v5.0.0 migration and compatibility plan

Status: `PLANNED`. Applies to every install that upgrades from v4.9.x to v5.0.0: npm or source
installs, SEA binaries, Docker volumes, headless servers and the Android app.

## 1. Current mechanics (v4.9.2)

- Schema: 10 migration functions in `MIGRATIONS` (`src/db/db.cjs:52`), stamped with
  `PRAGMA user_version`. Each step runs in its own `BEGIN IMMEDIATE` transaction together with the
  version stamp; a failure rolls the step back and stops the process (`src/db/db.cjs:689` to `:701`).
- Downgrade: a build that finds `user_version` at or above its own migration count returns without
  checking (`src/db/db.cjs:680`). v4.9.2 would run against a v5 database with no warning.
- Settings: `setting:*` values resolve to a saved override or the default in
  `src/config/settings.cjs`. A new setting needs no migration; a changed meaning of an old setting
  does.
- Android: the code bundle `<filesDir>/app` is replaced on every app update; the data directory
  `<filesDir>/data` is kept (`LevixAppBundle.kt:35`).

## 2. Rules for v5

1. Migrations are appended, never edited after release.
2. Phase 02 ships before the first v5 migration. From then on, no migration runs until Levix holds
   the single-instance lock and has written a backup that passes verification (owner rule, accepted
   2026-10-30), with concurrency and failure tests. Phase 02 first changes the start order (open the database without
   migrating, take the instance lock, detect pending migrations, back up, migrate), because today
   importing the store migrates at once (`src/db/db.cjs:707`, AUDIT B-09).
3. Every new migration has a test that runs it against v4.9.2 fixture databases built by the test
   itself, with no real user data.
4. v5 adds a check that refuses to open a database whose `user_version` is newer than the build
   knows, with a message that names the backup to restore. This protects v5 to v6 and later
   downgrades; it cannot change v4.9.2, which is already released.
5. Settings keep their meaning. Widening `bot_language` choices keeps `auto`, `ar` and `en` exactly
   as they behave today.
6. Pairing credentials, the panel password, the recovery email record and `levix.key` are never
   rewritten by a v5 migration.

## 3. Expected changes by phase

| Phase | Change | Kind | Backward note |
| --- | --- | --- | --- |
| 01 | none to data | build only | Android data directory unchanged |
| 02 | backup manifest format (file, not schema) | new file format | settings export format `version: 1` unchanged |
| 03 | `bot_language` gains `pt-BR` and `es-419`; new AI reply language setting | setting | default keeps today's behaviour (AI follows the bot language) |
| 03 | dashboard `localStorage.levix_lang` and Android AppCompat locale accept two more values | client storage | an unknown stored value falls back to `en` |
| 04 | local Terms acceptance record outside `setting:*` | additive key or table | v4 users accept once; credentials untouched |
| 05 | Reply Router and message settings | additive settings | defaults reproduce v4 routing |
| 05 | permission keys aligned with command files (Q-08) | runtime-config data | only with owner approval; unknown keys keep falling back |
| 07 | rules, processed-event keys, bounded message lookup | new tables | empty on upgrade; features off |
| 08 | entitlement cache, template overrides | new tables or keys | empty on upgrade; Free defaults |
| 09 | update-check cache, prompt dismissals | additive keys | none |

## 4. First start after upgrading to v5

1. The database migrates (after the Phase 02 backup hook).
2. The session reaches `consent_required` until the operator accepts the current Terms (Phase 04).
   Pairing credentials stay; after acceptance, a paired install resumes as it does today.
3. Headless installs accept through the mechanism chosen in Q-04 before WhatsApp starts.
4. Language settings keep their v4 values.

## 5. Rollback

| Situation | Action |
| --- | --- |
| A v5 release is bad before any v5 migration ran on an install | install the previous build; data is compatible |
| A v5 migration ran | restore the pre-migration backup, then install the previous build |
| Android | Google Play cannot downgrade an installed app; a fix ships as a newer version code. GitHub APK users can reinstall an older APK only after uninstalling, which deletes app data, so a Phase 02 backup must exist first |
| Terms gate blocks a user wrongly | the bundled Terms copy is always acceptable offline; a fixed release follows |

# Levix v5.0.0 phase plan and implementation matrix

Status of every phase below: `PLANNED`. Each phase starts with a short audit of the current tree,
because `main` moves between phases. File names marked "new" are proposals; the phase confirms or
replaces them in its own plan before writing code.

## 1. Order and dependencies

```
00 audit -> 01 build -> 02 backup -> 03 i18n -> 04 gateway + consent -> 05 messaging + commands
                                                                          |
                                                          06 AI docs + media tools
                                                                          |
                                                          07 reactions + auto reply
                                                                          |
                                                 08 Plus (needs 03, 05, 07) -> 09 UX -> 10 release audit
```

- Critical path: 01, 02, 03, 04, 05, 06, 07, 08, 09, 10. No phase is skipped or reordered without an
  ADR.
- 02 comes before every schema change so that real installs can be backed up and restored first.
- 06 and 07 both depend on the 05 message engine and Reply Router.
- 08 needs a private repository, a Leviro verification service and a Play Console product. Without
  them it delivers the public contract and stops (blocker, not failure).
- 09 can start its update checker after 05; watermark removal waits for 08.

## 2. Rules for every phase

1. Re-audit the touched area and list stale assumptions with evidence.
2. Write the phase plan: scope, exact files, dependencies, migrations, tests, threat notes, privacy
   impact, compatibility matrix, rollback. Acceptance criteria come before code.
3. Small PRs. Each PR passes `npm test`, `npm run lint` and `npm run build:frontend`, plus the
   phase-specific gates in `TEST_MATRIX.md`.
4. Delegated implementers do not run tests or builds. The orchestrator runs every gate and reviews
   every diff.
5. No push to `main`, no automatic merge, no tag, no GitHub release, no Play upload.
6. Public docs change only for behaviour that shipped in the phase.
7. A phase report lists changed files, ADRs, gate results with `PASS`, `FAIL`, `NOT RUN` or
   `BLOCKED`, size or performance evidence when relevant, risks, migrations, rollback and the PR
   links.

## 3. Matrix

### Phase 01: code, build and performance

| Item | Plan |
| --- | --- |
| Status | IN PROGRESS since 2026-10-30. PR 01a open; results in `PHASE-01-RESULTS.md`. |
| Goal | Smaller and reproducible Android artifacts, Node 24 pinned everywhere, runtime dependency advisories fixed, size reported in CI. No behaviour change. |
| Files | `android/scripts/stage-levix-app.sh`, `android/scripts/fetch-node-android.sh`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `package.json`, `package-lock.json`, `src/cli.js` and `deploy/install.sh` (only if Q-01 says so), `tests/android-runtime-stamp.test.mjs`, `tests/package.test.mjs`, `tests/run.mjs` (per-file timing), new size-report script, `android/app/build.gradle.kts` (R8 experiment branch only), `docs/plans/v5/PHASE-01-RESULTS.md`. |
| Migrations | None. |
| Compliance | 16 KB page alignment for `arm64-v8a`; ABI splits unchanged; JNI packaging and the exec model unchanged without device proof; license list shrinks with the removed dev dependencies. |
| Tests | `npm test`, lint, frontend build, `validate:tarball`, `validate:sea`, `validate:docker` (CI), `:app:testDebugUnitTest`, debug and release builds for both ABIs, manual device smoke (start, pair a dedicated test account with the owner's authorization, sticker WebP, TLS roots, background service), size report against `BASELINE.md`. |
| Gate | Before and after tables per ABI from artifacts; every artifact reports Node 24.x; no dev dependency in `levix-app.zip`; no regression. |
| Rollback | Revert the staging or pin commit; previous release artifacts stay valid. |
| PRs | Opened early on the owner's request (2026-10-30), counted in Phase 01 scope: the privacy and public-docs PR #82 (Q-11), the `!prayer` bug fix PR #83 (Q-13), and the `youtube_api_key` removal PR #81 (Q-12). Then: 01a Node 24 policy: Termux version and sha256 pin, major check, `setup-node` in release jobs, `engines` `>=24 <25`, CLI warning above 24 and refusal below 24, matching docs (Q-01). 01b production-only staging tree and the size report job. 01c `npm audit` fixes for runtime dependencies. 01d R8 and resource shrinking, only with device proof. 01e test runner per-file timing. |

### Phase 02: backup and restore

| Item | Plan |
| --- | --- |
| Status | Decisions APPROVED by the owner on 2026-10-31 (Q-10, Q-14, Q-22, Q-24, Q-25, Q-26); implementation in PRs 02a to 02h (`PHASE-02-RESULTS.md` section 4). `BACKUP_FORMAT.md` is ACCEPTED. |
| Inputs | The old local branch `zcode/commands-panel-upgrades` adds nothing: both commits are patch-identical to `main` commits `ec1d762` and `cb9d09a` (Q-02, checked 2026-10-30). |
| Goal | Local, always-encrypted backup and restore of the settings, API keys and bot data in `BACKUP_FORMAT.md` section 7, account data that activates only for the same WhatsApp account, a journaled restore that survives interruption, and a start order that never migrates without the instance lock and a verified pre-migration copy. |
| Files | new `src/backup/` (format, create, restore, activation, journal), `src/db/db.cjs`, `src/config/lock.cjs`, `src/bootstrap/core.js` and `src/cli.js` (start order, AUDIT B-09), `src/utils/memory.cjs` (Q-25), `src/routes/` (backup routes), `frontend/src/views/` (Settings → Backup), `android/app/src/main/java/net/leviro/levix/` (`PanelBridge.kt`, `PanelFiles.kt`, Storage Access Framework save and open), `docs/plans/v5/BACKUP_FORMAT.md`. No CLI or WhatsApp command (Q-14). |
| Migrations | No table change. The start order changes so a backup can run before pending migrations; each later phase that adds a migration relies on that hook. |
| Compliance | Local only; nothing is uploaded; every exported file is encrypted with the operator's password; the operator sees the content list before creating and before restoring. |
| Tests | backup, mutate, restore, verify; corrupt backup rejected with old data intact; interrupted restore and activation; wrong password; account mismatch never activates; newer schema refused; tampering, path, bomb and KDF-cost fuzz; schedules, group settings, memory and secure settings covered; settings export unchanged. |
| Gate | No data loss in any failure test; no pairing credential, panel secret or device key in a backup; API keys usable after restore on another install; account data never activates for a different account; content list shown before restore; no migration runs before the instance lock is held and a verified copy exists, proven by concurrency and failure tests (two processes at once, crash during backup, crash during migration, full disk). |
| Rollback | Backup routes disabled; restore never deletes current data before its replacement is verified and in place; a failed migration leaves the database at its old version. |
| PRs | Revised 2026-10-31 after the owner's decisions: 02a format library, 02b start order and migration safety, 02c memory root, 02d create, 02e restore, 02f account activation, 02g panel UI, 02h Android and docs. One stack in that order. |

### Phase 03: unified i18n

| Item | Plan |
| --- | --- |
| Goal | One catalog for `ar`, `en`, `pt-BR`, `es-419`; generated outputs for Node, React, gateway and Android; three language settings; CI validator. |
| Files | new catalog directory and generator script, `src/utils/i18n.cjs`, `src/utils/commandDocs.cjs`, `src/commands/help.cjs`, `src/commands/lang.cjs`, `src/config/settings.cjs`, `src/services/aiAgent.cjs` (AI language directive), `frontend/src/i18n/`, `frontend/src/context/I18nContext.tsx`, views with inline ternaries, `public/gateway-i18n.js`, `public/ui-boot.js`, Android `res/values-pt-rBR/`, `res/values-b+es+419/`, `UiPrefs.kt`, `MainActivity.kt`, `AndroidManifest.xml` (`localeConfig`), `src/panel/recovery-email.cjs` (Q-15). |
| Migrations | Setting choices widen; new AI reply language setting with a default that keeps today's behaviour. |
| Compliance | Store listings per locale are a Phase 10 item; draft machine translations are labelled until a human reviews them. |
| Tests | `tests/help-i18n.test.mjs` and `tests/reply-language.test.mjs` across four locales, `tests/gateway-views.test.mjs`, `UiPrefsTest.kt`, catalog validator (missing keys, placeholder parity, collisions), frontend type check and build, RTL smoke. |
| Gate | All four locales selectable and stored on Android and the dashboard; Arabic and English replies unchanged. |
| Rollback | `tr(en, ar)` stays as a wrapper; unknown locales fall back to `en`. |
| PRs | 03a catalog, generator, validator (no behaviour change). 03b backend keyed API and the AI language setting. 03c dashboard. 03d gateway and Android. 03e command docs and help. |

### Phase 04: React gateway and Terms consent

| Item | Plan |
| --- | --- |
| Goal | React login, setup, QR and recovery with unchanged server checks; Terms consent enforced before any WhatsApp socket (ADR-005, ADR-006). |
| Files | `app.cjs`, `views/*.ejs` (removed last), `frontend/src/` (gateway routes), `public/gateway-i18n.js` (retired), `src/core/session.js` (`consent_required` state), `src/bootstrap/session-startup-policy.js`, `src/bootstrap/core.js`, `src/cli.js` (headless acceptance, Q-04), new `src/legal/` (fetch, cache, verify, bundled fallback), `android/.../LevixHostService.kt` (state shown), new `LEGAL_CONSENT_CONTRACT.md` and `LEGAL_COPY_REVIEW.md`. |
| Migrations | Additive: one local acceptance record outside `setting:*`. Pairing credentials untouched. |
| Compliance | Legal text needs human legal review; no tracking identifier; acceptance not uploaded. |
| Tests | all current auth tests; new negative tests (unauthenticated QR and API, CSRF, cookie restore, throttles, reset, recovery); consent per start path (panel, resume-paired, headless, retry timer, network restore, `!restart`, Android boot); offline first start; tampered or oversized remote Terms; old WebView smoke. |
| Gate | No socket without acceptance on any path; every auth test passes in React. |
| Rollback | EJS routes stay until 04d; the consent gate reverts with its release. |
| PRs | 04a contract, bundled Terms, acceptance record, session gate, headless acceptance. 04b panel consent dialog and API. 04c React gateway with EJS still present. 04d EJS removal. |

### Phase 05: message engine, Reply Router, Command Engine v2, health

| Item | Plan |
| --- | --- |
| Goal | One `parse, authorize, execute, render, route, send` path; same-chat default; v2 parser; short `!status`; owner health check. |
| Files | `src/handlers/command.handler.js`, `src/commands/group.cjs`, `src/middleware/permissions.middleware.js`, `src/utils/statusMessage.cjs`, `src/utils/sendBotMessage.esm.js`, new `src/messaging/` (templates, router), `src/commands/status.cjs`, new health module, `src/config/defaults.cjs` (Q-08), `src/config/runtime-config.cjs`, dashboard routing settings, the six commands in AUDIT C-07. |
| Migrations | Additive routing settings. |
| Compliance | Privacy matrix for destinations; no new data leaves the device. |
| Tests | parser matrix (newline, aliases, captions, quotes, unknown command and sub-command); permission matrix before and after for all 69 commands; routing tests with a fake socket; status edit-in-place and media flows; health states without network calls. |
| Gate | Matrix identical except approved changes; no change widens anyone's access without the owner's explicit approval (accepted 2026-10-30); default replies stay in the source chat; members never see internals. |
| Rollback | Routing configuration resets to the source chat while the router and its destination guard stay in place; parser v1 kept behind a switch for one release. No rollback path may send around the router. |
| PRs | 05a permission matrix test only. 05b group router on `evaluatePermissionLevel`. 05c parser v2. 05d message engine and the six progress-message commands. 05e Reply Router. 05f `!status` and health. |

### Phase 06: documentation-aware AI and media tools

| Item | Plan |
| --- | --- |
| Goal | Answers about Levix cite bundled, versioned user docs; image, TTS and STT reachable from natural language through existing code paths. |
| Files | `src/services/aiTools.cjs`, `src/services/aiToolAuth.cjs`, `src/services/aiAgent.cjs`, new docs index generator and generated index, `src/commands/gemini.cjs`, `src/commands/tts.cjs`, `src/commands/stt.cjs` (exports reused). |
| Migrations | None. |
| Compliance | `PRIVACY.md` row for any new upload path, after it ships. |
| Tests | mocked providers; tool discovery; unsupported provider; missing key; quota; malformed binary; unauthorized caller; doc retrieval accuracy; injected doc text; four-locale queries. |
| Gate | No answer presents a `PLANNED` item as shipped; tool authorization unchanged. |
| Rollback | Remove the tool declarations. |
| PRs | 06a docs index and two doc tools. 06b media tools. |

### Phase 07: reaction automation and AI Auto Reply

| Item | Plan |
| --- | --- |
| Goal | One reaction rules engine and an opt-in prefix-free AI reply, both on the 05 router and the existing permission checks. |
| Files | `src/core/events.js`, `src/handlers/message.handler.js`, new automation modules, `src/db/db.cjs` (new migration), `src/db/store.cjs`, dashboard API and a rule builder view. |
| Migrations | New tables for rules, processed-event keys and a bounded message lookup; additive. |
| Compliance | No archive of unrelated messages; visible notices; anti-spam limits. |
| Tests | fake Baileys event streams; added, changed and removed reactions; redelivery; owner, admin and member reactors; missing media; restart; loops; rate and cost limits; four locales in the builder. |
| Gate | Auto Reply off by default; one action per event; kill switch works. |
| Rollback | Kill switches; tables stay unused. |
| PRs | 07a event intake, idempotency, lookup. 07b engine and actions. 07c dashboard builder. 07d Auto Reply. |

### Phase 08: Levix Plus

| Item | Plan |
| --- | --- |
| Goal | Public extension contract with Free defaults; Android Play Billing client; server-verified entitlements; message personalization in Plus. |
| Files (public) | new `src/extensions/` contract, message-engine hooks, Android billing client, CI scan of public artifacts. Plus code lives only in the private repository. |
| Migrations | Entitlement cache and template overrides, additive. |
| Compliance | Play billing policy; `PRIVACY.md` and Data safety rows for billing data before release. |
| Tests | Free build without Plus; forged token; wrong account; revoked and expired states; outage with Core still working; template placeholders across four locales. |
| Gate | Core fully works without Plus and offline. |
| Rollback | Plus disabled; Free defaults return. |
| Blockers | private repository access, Leviro verification service, Play Console product setup. |

### Phase 09: updates, links, rating, watermark

| Item | Plan |
| --- | --- |
| Goal | Channel-aware update checks and `!update`; safe official links; respectful rating and star prompts; watermark rules. |
| Files | new `src/commands/update.cjs`, new update-check module, `android/.../PanelActivity.kt` (external links), Android in-app update and review clients (new Play dependencies, Q-16), `frontend/src/` About, Help and Settings, message-engine watermark rules. |
| Migrations | Local cache keys only. |
| Compliance | Play in-app review frequency limits; no tracking of dismissals. |
| Tests | semver and channel matrix; offline; bad version; inaccessible URL; link scheme abuse; review prompt declined; watermark exclusions. |
| Gate | No code download; links open safely; prompts never gate features. |
| Rollback | Command disabled; prompts removed. |

### Phase 10: final audit and release candidate

| Item | Plan |
| --- | --- |
| Goal | Evidence-based Go or No-Go for v5.0.0. |
| Work | Full security, privacy and product audit; all gates in `TEST_MATRIX.md`; artifact comparison against `BASELINE.md`; docs parity; `RELEASE_READINESS.md`; release notes in four languages. |
| Gate | No open critical or high defect; owner approval before any version bump, tag or release. |

## 4. Migration failure policy

1. Every phase that adds a migration ships after Phase 02, and the app takes a local backup before
   applying it. This needs the Phase 02 start-order change, because today the import of the store
   migrates before anything else can run (AUDIT B-09).
2. A migration test runs against v4.9.2 fixture databases before merge.
3. A failing migration step already rolls back inside its own transaction and stops the process
   with a logged error (`src/db/db.cjs:689` to `:701`), so WhatsApp never starts on a half-migrated
   database. v5 keeps that behaviour and adds the pre-migration backup as the restore point.
4. An older Levix opening a newer database continues silently today (`src/db/db.cjs:680`). A v4
   build therefore must not be pointed at a v5 database; rolling back from v5 to v4 means restoring
   the pre-migration backup. v5 adds an explicit refusal for a schema newer than the running build.
5. No migration is edited after it ships (`AGENTS.md`, Schema and migrations).

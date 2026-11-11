# Levix v5.0.0 phase log

## Phase 00: audit, rules and plan (2026-10-30)

- Branch: `docs/v5-phase-00-plan`, from `main` at `050d8b9` (v4.9.2).
- PR: https://github.com/Abdodiab2005/levix/pull/80 (draft, for owner review).
- Product code changed: none. The PR adds `docs/plans/v5/` and focused `AGENTS.md` edits.
- Audit: six read-only runs (startup and auth, commands and messaging, docs and data flows, Android
  and build, i18n and AI, data at rest), each checked against the source by the orchestrator.
  Results in `AUDIT.md`. The command inventory in `COMMANDS.md` was generated from the loaded
  command modules in an isolated data directory.
- Gates (details in `BASELINE.md`):
  - `npm ci`: PASS.
  - `npm --prefix frontend ci`: PASS.
  - `npm test`: PASS, 68 files, 5039 checks.
  - `npm run lint`: PASS, 0 errors, 174 warnings.
  - `npm run build:frontend`: PASS.
  - Android `:app:testDebugUnitTest`: BLOCKED locally (no staged Termux runtime or NDK r29); PASS in
    CI run 40467429633 on the same commit.
  - `validate:tarball`, `validate:sea`, `validate:docker`: NOT RUN locally; PASS in the same CI run.
  - `tests/reply-language.test.mjs` re-run without network: PASS (41 checks, 104.8 s).
- Measured: v4.9.1 arm64 APK composition; 70.0% of its `levix-app.zip` is dev dependencies.
- Found: unpinned Termux Node while Node 26 is already LTS (R-01); `!prayer` fixed-date bug (C-12);
  privacy table gaps (AUDIT section 2).
- Review: a read-only Codex review checked the citations and debated every proposed ADR and
  recommendation. Applied: three P1 corrections (filtered backup and journaled restore, start order
  for pre-migration backups, no router bypass on rollback), the ADR-007 audience rule, risks R-31
  and R-32, and codex's positions on Q-04, Q-05, Q-09 and Q-17. Still disputed: Q-01 and Q-21.
- Decisions: ADR-001 to ADR-017 (`DECISIONS.md`); 22 open questions (`OPEN_QUESTIONS.md`).
- Owner decisions, 2026-10-30: Q-01 option (b), Q-02 review first, Q-11 separate privacy PR now,
  Q-12 remove `youtube_api_key` without deleting saved values, Q-13 separate `!prayer` fix now, Q-21
  option (a). Process rules: permission fixes in Phase 05 never widen access without approval; no
  migration before the instance lock and a verified backup. Recorded in `OPEN_QUESTIONS.md`,
  `DECISIONS.md`, `PHASES.md`, `TEST_MATRIX.md`, `MIGRATION.md` and `AGENTS.md`.
- Q-02 result: both commits on `zcode/commands-panel-upgrades` are patch-identical to `main`
  (`ec1d762`, `cb9d09a`); nothing moves to Phase 02.
- Separate PRs opened on the owner's request, counted in Phase 01 scope:
  - #81 removes `youtube_api_key` (saved values kept). Local: `npm test` PASS (5038 checks), lint
    PASS, frontend build PASS.
  - #82 updates `PRIVACY.md`, `README.md` and `ANDROID.md` with every data destination and a Data
    safety flow map. Documentation only.
  - #83 fixes `!prayer` (today's date in `bot_timezone`, encoded URL, 39 new checks). Local:
    `npm test` PASS (5078 checks), lint PASS, frontend build PASS; codex review findings handled.
- Next: owner review and merge decision for this PR. Phase 01 starts only after explicit approval.

## Phase 01: code, build and performance (started 2026-10-30)

- Started after the owner merged PRs #80, #81 and #83. PR #82 is postponed by the owner.
- Post-merge CI on `52d6949`: run 41083432588, 7 of 7 jobs `success`.
- Plan, re-audit findings and results: `PHASE-01-RESULTS.md`.
- PR 01a (branch `build/01a-node24-pin`): Node 24 pinned for every official build (`.node-version`
  24.22.2; Termux `nodejs-lts` 24.22.1 pinned with sha256 per ABI); CLI and installer warn on Node 25
  and newer; `engines` `>=24 <25`; the Android fetch stages only pinned files, which removes the two
  unused `libsqlite3_*.so` from the APKs. New: R-33, Q-23.


## Phase 03: unified i18n (started 2026-11-01)

- Started on the owner's request on 2026-11-01, `main` b6e777e.
- Four read-only audits (Codex, Grok, OpenCode, Antigravity); re-audit, design and PR plan in
  `PHASE-03-RESULTS.md`. Corrected counts: 577 `tr(` lines in 87 files, 1116 dashboard keys, 89
  gateway keys, 247 Android strings plus 8 plurals per locale.
- Owner decisions: Q-15 option (b), the recovery relay gains `pt-BR` and `es-419` and deploys
  first; Q-19, ChatGPT reviews the new translations.
- 2026-11-02: every slice implemented in open PRs (#104 to #120, levix-ui #22); see
  `PHASE-03-RESULTS.md` section 10. Full Phase 03 tree: `npm test` 7409 checks PASS after the Codex review fixes, all four
  locales complete and required. Translations are drafts until the ChatGPT review; #115 waits for
  the relay deploy; device QA NOT RUN.
- 2026-11-02: ChatGPT Q-19 review applied (#117, #118 no blocking issue; #120 autoschedule example
  fixed with a regression test). levix-ui #22 merged, deployed and probed without sending mail.
  All Phase 03 PRs merged (#103 to #122, merge commits in `PHASE-03-RESULTS.md` section 10.1).
  #121 and #122 finished the recurrence text and the last user-facing `tr()` calls. Final gates on
  `main` 8651514: `npm test` 8479 PASS, `i18n:check` PASS, lint 0 errors, frontend build PASS,
  Android unit tests and debug and release builds PASS. Phase 03 COMPLETE for automated gates;
  device QA NOT RUN; 10 translation files marked draft for keys added after the review.

## Phase 04: React gateway and Terms consent (started 2026-11-02)

- Started on the owner's request on 2026-11-02, `main` 407bf1e.
- Owner decisions: Q-03 option (a), Ed25519-signed remote Terms with a bundled offline fallback
  (ADR-019); Q-04 options (a) and (c), interactive `levix terms` and a provisioning command, no
  start flag (ADR-006); Q-05 option (a), a live connection stays up and the next start asks
  (ADR-006); Q-17 overridden, consent belongs to the installation and is asked again after a
  document change or an app update, never after unlink, relink, restart or password reset
  (ADR-020).
- Re-audit and plan in `PHASE-04-RESULTS.md`; contract in `LEGAL_CONSENT_CONTRACT.md`. Slices 04a
  to 04e; 04a and 04b merge together; 04c is BLOCKED on the owner's signing key and the `levix-ui`
  endpoint.
- 2026-11-02: 04a (consent gate, record, `levix terms`) and 04b (panel dialog, Android state, the
  documents in four locales) implemented by Codex, Grok, OpenCode and Antigravity from an
  orchestrator draft. Codex review: 0 P1, 3 P2, 3 P3, all fixed. Local gates PASS. CI PASS 7/7
  on #125 32a4b59, #126 f34a2bd and #127 65b793e. Device QA NOT RUN.
- 2026-11-02, owner review: release identity per platform (an Android `versionCode` bump asks
  again), dialog retry and fresh state, Android alerts posted once per condition, factual
  corrections to the four documents, and corrected results records. CI PASS 7/7 on #126 51d0051
  and #127 898193f. 04c (signed remote Terms, shipped off, BLOCKED on the owner's key) in #128;
  levix-ui endpoint in levix-ui #23 (draft); 04d React gateway and 04e EJS removal in their own
  PRs. Nothing in Phase 04 is merged (`PHASE-04-RESULTS.md` section 3).

## Phase 05: message engine, Reply Router, commands, health (2026-11-05)

- Started on the owner's request on 2026-11-05. Base is `main` `2682a09` (Phase 04e merged).
  Branch `feat/v5-phase-05`. Pull request: https://github.com/Abdodiab2005/levix/pull/132 (slices 05a–05f).
- Audit of the current tree is in `PHASE-05-RESULTS.md`. Permission levels for all 69 commands
  are unchanged. `!group` now uses `evaluatePermissionLevel`. A bot admin who can already run
  `!kick` can run `!group kick`. A private chat does not gain that door.
- Q-06 stays open. The short `!status` stays `OWNER_ONLY` (recommendation (a)). `!status debug`
  is hard-gated to the owner role.
- The watermark hook exists and defaults off, so existing replies do not change until the
  operator turns `message_watermark` on.

## Phase 06: bundled docs and media tools (2026-11-06)

- Preserved the owner's beta version edits in `a68696d` and pushed
  `release/5.0.0-beta.1`; Phase 06 is on `feat/v5-phase-06`, draft PR #134.
- Implementation `bb69ea6` adds offline, versioned public-doc search/open and
  backend citations across all three chat providers. No private/planning index.
- Natural-language image, speech and transcription reuse existing commands,
  with real-caller authorization, live disabled-command checks, lazy audio,
  bounded bytes/rate/concurrency/deadlines and fail-closed delivery.
- PASS: full suite 9919 checks, lint, frontend, i18n, docs freshness, installed
  tarball 36 checks and Linux SEA 51 checks. Local Node v24.19.0; official pin
  v24.22.2 unchanged. Full evidence and initial failure corrections are in
  `PHASE-06-RESULTS.md`; tool contracts in `docs/AI_TOOLS.md`.
- Final review `d602671` fixes cancellation through cooldown/thumbnail waits,
  removes unsafe raw-send retries and preserves repeated tool/result IDs across
  provider switches. 10002 checks pass; final-head gates/CI are rerun for handoff.
- Targeted ChatGPT Q-19 approval covers new Phase 06 pt-BR/es-419 strings only;
  older/unreviewed content remains draft. No migration/dependency/release.
  Device/live-provider QA remains NOT RUN. No merge or Phase 07 start.

## 2026-11-06/07 — Phase 07a intake (pending owner review)

- Verified Phase 06 merge #134 at `f04ce30`, audited and recorded the plan before code.
- Draft PR: https://github.com/Abdodiab2005/levix/pull/135. Implementation `eed2621`: all local gates PASS (10194 checks); CI run 42302901593 PASS 7/7. Final documentation-head rerun evidence is in the PR verification record.
- Owner decision: Reaction Automation/rules/builder are Free Core without tier rule limits;
  prefix-free per-chat AI Auto Reply is paid private Plus in Phase 08 (ADR-009).
- Proposed behavior-preserving stabilization Phase 07.5, not started.
- 07a adds bounded opt-in RAM lookup and hash-only replay/invalidation state, no actions or UI.
  Evidence, final PR/commit verification record and rollback: `PHASE-07-RESULTS.md`.


## 2026-11-07 — Phase 07b rules and safe actions (pending owner review)

- Verified merged #135 at `b383ed1`; dedicated `feat/v5-phase-07b` branch.
- Added Free declarative matching, deterministic single winner, existing voice
  STT/ping actions, strict reactor roles, source/linked-owner routing and final
  cancellation/authorization guards. No Rule Builder/API, Plus or refactor.
- Append-only schema 12 adds epochs/revisions, durable execution claims and
  bounded rate budgets. Global kill and rules default off; no total rule cap.
- Fixed numeric identity contamination/role-write and mapped revocation edges,
  unmatched metadata storms, pre-provider role refresh and broken credential
  lookup for linked-owner routing. Evidence/limits/rollback: `PHASE-07-RESULTS.md`.

## 2026-11-11 — Phase 09 code-ready

- #166 updates/watermark and #167 Android/UI independently reviewed and pass
  full CI; 57664 local checks pass. No merge/release/upload.
- Q-16 measured before choosing one build: no new selected Google services
  module or manifest requirement. Manual device limits remain explicit.
- Phase 11A authorized only for a separate next release; Phase 10 remains the
  mandatory v5.0.0 gate. Evidence: `PHASE-09-RESULTS.md`.

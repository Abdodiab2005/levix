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

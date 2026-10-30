# Levix v5.0.0 phase log

## Phase 00: audit, rules and plan (2026-10-30)

- Branch: `docs/v5-phase-00-plan`, from `main` at `050d8b9` (v4.9.2).
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
- Next: owner review of this PR and answers to the questions marked "Needed by 01" before Phase 01.

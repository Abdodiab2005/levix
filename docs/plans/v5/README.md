# Levix v5.0.0 planning

This folder holds the v5.0.0 plan. Nothing here is shipped behaviour. Shipped behaviour is described
by `AGENTS.md` and the public docs at the repository root. Files in this folder are not part of the
npm package, the Docker image, the SEA binaries or the Android bundle.

| File | Content |
| --- | --- |
| `SCOPE.md` | locked decisions, out-of-scope list, feature register with success and rollback per feature |
| `DECISIONS.md` | ADRs, accepted and proposed |
| `ARCHITECTURE.md` | the current structure v5 touches, with evidence, and the planned target |
| `AUDIT.md` | Phase 00 findings: fact, evidence, risk, action; public doc drift; outbound destinations |
| `COMMANDS.md` | the 69 shipped commands with aliases, chat scope and default permissions |
| `BASELINE.md` | measured gates, artifact sizes, environment, measurement plan |
| `PHASES.md` | per-phase implementation matrix and PR boundaries |
| `TEST_MATRIX.md` | gates per phase and platform |
| `MIGRATION.md` | data and settings compatibility from v4.9.x, rollback |
| `RISKS.md` | risk register and threat notes |
| `OPEN_QUESTIONS.md` | decisions the owner still has to make |
| `CHANGELOG.md` | dated log of each phase |

Labels used throughout: `SHIPPED`, `PLANNED`, `PENDING REVIEW` for features; `PASS`, `FAIL`,
`NOT RUN`, `BLOCKED` for test results; ADR status `ACCEPTED`, `PROPOSED`, `SUPERSEDED`.

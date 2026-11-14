# Pre-release integration — Tasks 06, 07 and 08

Date: 2026-11-14. Status: **IN PROGRESS**, resumed after owner merged #173.
Historical checkpoint: work stopped on the unmerged #173 prerequisite; no
implementation was performed before the integrated-release gate passed.

## Exact baseline and preflight

- Public release: `aaed3300b5578af9b03234d7bad6f0c0233430c5`; #173 MERGED.
- Integrated-release [CI 43553378310](https://github.com/Abdodiab2005/levix/actions/runs/43553378310): **PASS 7/7**; queried run metadata confirms that exact head and release branch.
- #169 merge `bb98995e6ac4833428941b97a583383fa41a36f0` and #172 merge
  `c9b3f8897d6b2756317dca698675a30b4c3f3351` remain ancestors: **PASS**.
- Public main: `18c8b6bf99830661f2a7896636fda9562e6b6a6a`.
- Public #170: `6b32bf5c6156d6b09cc5fb52ddec255f60001c7a`, OPEN/DRAFT,
  targets main; combines Gemini changes with a release.yml Play guard.
- Private main: `cc1e8e1df463616aa655db97841ac8781f285f92`.
- Private #6: `dbbf5d150e3e10d43b5422e9bc0fbfb14c0b7a2f`, OPEN/DRAFT.
- Original #168 remains unchanged. No levix-ui integration change identified yet.

## Task 06 pre-edit audit and plan

Release `release.yml` Play job is already unconditionally disabled by #169.
`play-store.yml` can still upload a public release Free AAB. Public main also
has `android-beta-aab.yml`, which signs and uploads a Free AAB after dispatch;
its release.yml Play job remains enabled. These paths have no combined-artifact
proof. Public CI builds debug-key AABs without upload; public release APK/AAB
builds and GitHub artifacts must remain available.

Plan: disable the remaining public upload jobs at their owning workflow,
add a focused policy test covering every public workflow upload job, and
correct the Play runbook. Apply only that safety slice to separate branches
from release and main; do not import #170's Gemini/API/dependency changes.
Files: `.github/workflows/play-store.yml`, `tests/play-workflow-safety.test.mjs`,
`PACKAGING.md`; main additionally `.github/workflows/release.yml` and
`.github/workflows/android-beta-aab.yml`. No migration, runtime dependency,
version bump or production build. Threat: owner can otherwise accidentally
replace combined Plus app with public Free AAB. Rollback is workflow-only;
re-enabling an unsafe upload is not a recommended rollback.

Private workflow inventory: CI runs no upload; `paid-aab.yml` uses a throwaway
key/placeholder product and private artifacts; PR #6 adds a dispatch-only,
main-only production-signed combined build with no Play upload. Signing,
package/versionCode/product and content checks will be completed in Task 07.
Metadata confirms private signing-secret names and a public-key variable exist;
secret values, keystore identity and console state are not proven by names.
Public google-play environment requires owner reviewer; admin bypass is enabled.
No environment protection or secret is changed by this work.

## Results and next checkpoints

| Task | Result | Evidence |
| --- | --- | --- |
| Preflight | PASS | Exact-head 7/7 CI and merged ancestry above |
| 06 workflow safety | PASS (proposed fixes); BLOCKED for shipping until merged | 10 release-policy checks; 12 main-policy checks; focused lint/docs checks pass |
| 07 Plus integration | NOT RUN | Follows Task 06 |
| 08 migration/backup | NOT RUN | Follows Task 07; synthetic isolated fixtures only |

Signed release build/upload, verifier deployment, resources, Play product and
Task 11 device upgrade are NOT RUN and require separate owner authorization.
Phase 10 is outside this work. Code Freeze needs integrated safety fixes,
passing integration CI, verified combined-build/owner prerequisites, and the
Task 08 proof matrix with no unresolved P0/P1 issue.

## Task 06 checkpoint

The public manual Free-AAB bypass and main beta/release upload paths are
unconditionally disabled in isolated proposed fixes. Free GitHub/CI Android
builds are retained. Main safety changes are separate from #170's Gemini
work; #170's Play guard becomes redundant after the main safety PR, while
its Gemini work remains independently reviewable. No existing PR was changed.

Focused proof on Linux x64, Node 24.22.2, 2026-11-14:
`node tests/run.mjs play-workflow-safety` PASS 10 checks on release, 12 on main;
focused Biome lint PASS; `npm run docs:check` PASS. No signed build or upload.
Private #6 existing [CI 43339763150](https://github.com/Abdodiab2005/levix-plus/actions/runs/43339763150)
PASS is reusable for its existing script/contract baseline, not signing or live
Play configuration. Workflow ownership/security checks continue in Task 07.

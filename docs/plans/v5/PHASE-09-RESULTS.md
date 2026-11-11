# Phase 09 results

Status: CODE-READY, pending owner review. Automated gates pass; manual device
and Play eligibility checks remain release gates. Owner authorization: 2026-11-11.
Release base: `94ef953`, `release/5.0.0-beta.1`. No merge or release authorized.

## Changes

09a adds the owner-default `!update`, authenticated metadata/check routes,
bounded GitHub HTTPS metadata with RAM cooldown/coalescing, strict SemVer,
release-note bounds and fixed official links. Stable checks use the dedicated
latest endpoint; beta checks also scan a bounded preview page and never call
an incomplete preview scan up to date. Play installs never query GitHub.

Watermark stays off by default and retains the existing Free switch and Phase
08 entitlement-gated host hook. Raw STT, forwarded text and short links are
excluded. Status edits now carry the same category as fresh results; errors
and secret replies remain clean. No migration or backup change.

09b adds the shared About/Help/Settings surface, safe external navigation,
installer-derived native channel, flexible Play updates with explicit start
and completion, and optional default-off review opportunities. The Rate action
opens the store listing. Review consent and request time stay local; no rating
or dismissal result is recorded. Q-16 evidence is produced by CI before any
flavor decision. No private Plus runtime is included.

## Evidence — 2026-11-11, Linux x64, local worktree based on 94ef953

The local gates use the cached Node 24.22.2 binary. Logs are under
`/tmp/levix-phase09-*`; final commit/CI evidence will be appended after PRs.

| Result | Command / scope | Evidence |
| --- | --- | --- |
| PASS | `node tests/run.mjs update-check` | 223 checks, mocked HTTP only; `/tmp/levix-phase09-update-check.log` |
| PASS | `node tests/run.mjs update-panel` | 11 authenticated/CSRF/offline checks; `/tmp/levix-phase09-update-panel.log` |
| PASS | `node tests/run.mjs watermark` | 96 helper + 18 actual dispatcher/status checks in their focused runs; `/tmp/levix-phase09-watermark*.log` |
| FAIL (corrected) | initial `npm test` | 57657 checks; 5 generated-doc index failures after command catalog additions; corrected with `npm run docs:build`; final rerun passes below |
| PASS | final `npm test` on `87ece9ca156b11065d003e54ad9f5dea77633848` | 57664 checks, 0 failed, 0 crashed, 213.0 s; `/tmp/levix-phase09-full-tests-final.log` |
| PASS | `npm run lint` | 0 errors; 232 existing warnings, 100 infos with installed Biome 2.6.4 |
| PASS | `npm run i18n:check`; `npm run docs:check` | `/tmp/levix-phase09-i18n.log`, `/tmp/levix-phase09-docs-check.log` |
| PASS | `npm run build:frontend` | `/tmp/levix-phase09-frontend.log`; existing chunk-size warning |
| PASS | `node /tmp/levix-ui-qa/capture.mjs` | Real isolated panel, fake update result; all four locales, desktop 1100×900 and phone 390×844; no page errors or horizontal overflow; screenshots in `evidence/phase09/` |
| PASS | `curl -IL` official routes | Docs, support, website, portfolio and Leviro resolve to HTTP 200; no user data; header logs `/tmp/levix-official-*-headers.txt` |
| BLOCKED | `android/gradlew -p android --offline :app:testDebugUnitTest -x stageLevixApp -x ensureDebugKeystore` | Kotlin Android Gradle plugin 2.3.21 absent from local cache; no downloads attempted; `/tmp/levix-phase09-android-offline.log` |
| PASS | CI run [43064749949](https://github.com/Abdodiab2005/levix/actions/runs/43064749949), 09a `7ad6a0c6c6e0989876490d2d9bd6c995bc3ea831` | tests, npm install/boot, Docker persistence, SEA Linux/macOS/Windows, Android unit/debug/release APKs/AAB and public artifact scans |
| PASS | 09b CI [43066047210](https://github.com/Abdodiab2005/levix/actions/runs/43066047210), `87ece9ca156b11065d003e54ad9f5dea77633848` | full matrix including Android both ABIs, release APK/AAB and artifact scans |
| PASS | final code/test/measurement CI [43067593302](https://github.com/Abdodiab2005/levix/actions/runs/43067593302), `3fb751342d693671debb628f9325deca8c77bdbb` | full matrix plus Q-16 selected-module/standard-XML comparison |
| NOT RUN | real Play update/review, non-Play device without Google services, oldest WebView | Dedicated test account/device authorization and Play eligibility required; no live pairing/purchase/upload performed |

| PASS | `npm pack --offline --ignore-scripts` then `node scripts/scan-public-artifacts.mjs /tmp/levix-phase09-artifacts/levix-bot-5.0.0-beta.1.tgz` | public tarball, 308 entries; `/tmp/levix-phase09-scan.log`; no dependency/artifact download |
| PASS | `node docs/plans/v5/evidence/phase09/regressions.mjs /tmp/levix-ui-qa/node_modules/playwright/index.mjs` | 10 actual-browser regression checks; `/tmp/levix-phase09-ui-regressions.log`; native calls are fakes |

## Independent review

Codex reviewed UI/watermark and native/backend separately. Confirmed findings
were fixed: initial metadata overwriting checks, dropped download events,
stale review consent, error/status-edit exclusions, asynchronous completion
failures, review consent revoked during preparation, update recovery across
activity recreation, stable releases hidden behind preview pages, and competing
checks from simultaneous About panels. Re-review accepted those corrections;
the last recovered-event timing case is handled by a native known-flow getter
that resumes a check on About mount only for a previously initiated update.

Implementation used agy Gemini (sandboxed code output, reviewed and hardened
by the orchestrator) and OpenCode `deepseek-v4.1-flash-free` (Android). Delegates
ran no gates. ChatGPT performed a targeted machine semantic review of the new
Portuguese/Spanish strings; this does not certify older translations or native
speaker review.

## Release boundary

Recommended order: 09a, then stacked 09b. Phase 10 remains the mandatory v5.0.0
audit/release gate. Phase 11 belongs only on a separate next-release branch
after Phase 09 is code-ready. Manual device limits stay explicit; Phase 11
starts only on `next/5.1.0` / `feat/next-account-card`, never this release branch.

## Pull requests and commits

- [09a #166](https://github.com/Abdodiab2005/levix/pull/166), `7ad6a0c6c6e0989876490d2d9bd6c995bc3ea831`, base `release/5.0.0-beta.1`.
- [09b #167](https://github.com/Abdodiab2005/levix/pull/167), `87ece9ca156b11065d003e54ad9f5dea77633848`, stacked on 09a.

No PR merged. No tag, release, deployment, Play/Cloud configuration or upload.

## Q-16 — measured decision

Choose option (a), one build with the Play libraries, with no channel flavors.
CI run 43067593302 compared 09a baseline `7ad6a0c` against proposed `3fb7513`.
The exact report is [play-impact.json](evidence/phase09/play-impact.json).

- Added selected runtime modules: `app-update:2.1.0`, `core-common:2.0.4`,
  `review:2.0.2`. No newly selected Google Play services modules.
- No added manifest permissions, required features or shared libraries.
- arm64 APK artifact bytes: 61,061,774 baseline; 61,157,852 proposed; delta
  96,078 bytes for the whole 09b change, including UI. This is not an isolated
  dependency-size estimate, a Play download size or an incremental-update size.
- Non-Play installer policy refuses before creating Play clients. Existing Free
  and offline gates pass. A physical GitHub APK smoke without installed Google
  services remains NOT RUN and belongs to Phase 10 device QA.

The selected-module report deliberately excludes requested-but-replaced Gradle
versions; XML is parsed with the standard parser, including expanded tags. The
comparison has its own synthetic parser check, PASS locally on 2026-11-11.

## Handoff

09a and 09b are code-ready for owner review. Merge #166 before #167 and retarget
#167 to the release branch once its base merges. Keep Phase 10 as the mandatory
final v5.0.0 audit/release gate. Phase 11 is separately authorized next-release
work and does not enter the v5.0 PRs. No live device, pairing, Play or Cloud
action was taken.

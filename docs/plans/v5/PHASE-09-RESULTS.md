# Phase 09 results

Status: IMPLEMENTED, verification in progress. Owner authorization: 2026-11-11.
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
| FAIL | initial `npm test` | 57657 checks; 5 generated-doc index failures after command catalog additions; corrected with `npm run docs:build`; final rerun pending |
| PASS | `npm run lint` | 0 errors; 232 existing warnings, 100 infos with installed Biome 2.6.4 |
| PASS | `npm run i18n:check`; `npm run docs:check` | `/tmp/levix-phase09-i18n.log`, `/tmp/levix-phase09-docs-check.log` |
| PASS | `npm run build:frontend` | `/tmp/levix-phase09-frontend.log`; existing chunk-size warning |
| PASS | `node /tmp/levix-ui-qa/capture.mjs` | Real isolated panel, fake update result; all four locales, desktop 1100×900 and phone 390×844; no page errors or horizontal overflow; screenshots in `evidence/phase09/` |
| PASS | `curl -IL` official Docs/support routes | `/docs` resolves to `/docs/installation`, support resolves to `/feedback`, both HTTP 200; no user data |
| BLOCKED | `android/gradlew -p android --offline :app:testDebugUnitTest -x stageLevixApp -x ensureDebugKeystore` | Kotlin Android Gradle plugin 2.3.21 absent from local cache; no downloads attempted; `/tmp/levix-phase09-android-offline.log` |
| NOT RUN | full GitHub Actions matrix and Q-16 baseline/proposed APK comparison | Requires PRs; dependency downloads authorized only on GitHub-hosted runners |
| NOT RUN | real Play update/review, non-Play device without Google services, oldest WebView | Dedicated test account/device authorization and Play eligibility required; no live pairing/purchase/upload performed |

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
after Phase 09 is code-ready. Q-16, final CI and manual device limits must not
be reported as passing before evidence exists.

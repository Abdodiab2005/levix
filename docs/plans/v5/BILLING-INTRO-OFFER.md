# Introductory subscription offer — audit and change plan

Status: IN PROGRESS, 2026-11-14. Public base `166e845`; private verifier base
`24b2e3b`. Isolated branches `fix/billing-intro-offer` in both repositories.
This is a focused Phase 08 billing correction authorized by the owner's offer
request, not approval for a release or for later phases.

## Audit and invariants

`BillingHost.monthlyOffers` explicitly excludes all introductory offers and
does not select a named base plan. The panel receives one price and describes
only recurring billing. Play prices and eligibility must remain authoritative.
The verifier already uses subscriptionsv2, signed installation-bound claims,
RTDN refetches, acknowledgement retries and signed time-limited entitlements.
An Android purchase result is never entitlement proof.

The owner's request supersedes ADR-010's old price: product `levix.plus`,
auto-renewing base plan `monthly`, regular USD 2.99/month, Play acquisition
offer `intro-3months`, USD 0.99/month for three monthly payments, then the
regular monthly price from month 4. These amounts belong in Play Console;
code must display `formattedPrice` from the eligible pricing phases. Public
builds keep an empty product ID and trusted-key set. No production setting,
credential, upload, purchase or entitlement activation is authorized here.

## Files and implementation

- `android/.../billing/PlusBilling.kt`, `BillingHost.kt`: pure validated phase
  selection plus Play adapter; prefer only the named, eligible 3-cycle offer;
  fall back to the named regular base plan; reject stale offers/prices at launch.
- `android/.../billing/PlusOfferTest.kt`: eligible/ineligible, shuffled plans,
  trials, malformed phases, local prices, stale quotes and no entitlement grant.
- `frontend/src/utils/hostBridge.ts`, `frontend/src/views/settings/PlusSettings.tsx`:
  carry both prices and duration; show introductory payments and subsequent
  auto-renewal before Subscribe; refresh instead of silently changing a quote.
- `i18n/{en,ar,pt-BR,es-419}/dashboard.json` and generated catalogs: localized
  disclosure and changed-offer error; test actual rendered purchase copy.
- This document: audit, proof, rollout and remaining manual QA evidence.
- Private `levix-plus`: lifecycle regression tests using the actual product,
  monthly plan and introductory offer; License Tester execution checklist.

## Safety, privacy, compatibility and rollback

No migration, new dependency, new endpoint, identifier, permission or Free
feature change. Purchase tokens remain transient on the client and are handled
only by the existing authenticated claim path. Test Play responses and keys
are fake; automated tests call no production endpoint. Eligibility is not
inferred from local history. Grace access requires verified unexpired Play
state; hold/revoked/pending/expired states grant none. Offline access remains
bounded by the existing signed entitlement policy. RTDN is not device push:
connected devices refresh; offline devices keep only their existing signed lease.

Rollback both UI and bridge/selector changes together to return to the regular
monthly plan. No database or purchase data rollback. Production activation is
blocked until eligible and ineligible License Tester flows and lifecycle QA
pass on the exact signed test build and verifier configuration; owner approval
is still required. Play Console access and a test device are external inputs.

## Proof

Run Android unit tests, panel disclosure/bridge tests, verifier lifecycle and
security tests, then repository gates (`npm test`, lint, frontend build,
i18n:check). Record PASS/FAIL/NOT RUN/BLOCKED with command, platform, base
commit and date. Real License Tester executions are NOT RUN until witnessed;
a written scenario is not evidence that a purchase occurred.

## Staging follow-up authorized 2026-11-14

The owner requested an isolated verifier and then confirmed no device is
currently available. ADB discovery returned an empty device list. Live QA is
BLOCKED. Existing deployment templates use production paths and permit real
purchases when test purchases are enabled, so they must not be reused as-is.

Before further code: move the two existing code-owned verifier build values
(origin and public trust keys) into `src/extensions/entitlement/target.cjs`,
referenced by `client.cjs` and `keys.cjs`. Defaults remain unchanged. The
private staging preparation script writes only that module in a disposable
Core build checkout with a staging origin and staging public key. No runtime
setting or environment variable can redirect verification, and failures never
fall back to production. Private tests exercise this actual Core client
against an isolated fake-Play service, including signature verification.

Private follow-up files: `service/src/config.cjs`, `handlers.cjs` and config
tests for test-purchases-only isolation; `scripts/configure-staging-core.mjs`
and tests; `service/deploy/staging/` templates and runbook. Signing/seal keys,
Play API and RTDN credentials are separate secret-store inputs, never created
in source. DNS, TLS, host access, secret-store access and Play configuration
are unconfirmed; no actual deployment is claimed. No database migration.

## Results — 2026-11-14

Implemented locally, not released. All evidence is Linux x86_64, Node 24.22.2,
public base `166e845` plus this uncommitted working tree; private base
`24b2e3b` plus the paired private working tree. No commit, PR, merge or upload
was created. Cached dependencies were reused; no downloads were performed.

| Result | Command / evidence |
| --- | --- |
| PASS | `npm test`: 57,342 checks, 0 failed, 0 crashed; final run 202.7 s; `/tmp/levix-intro-core-final-tests.log` |
| PASS | `node tests/plus-offer.test.mjs`: 35 disclosure/contract checks, included in the full suite |
| PASS | `python3 /tmp/levix-intro-kotlin-tests.py`: cached Kotlin 2.0.21 + JDK 17 + JUnit 4.13.2 compiled `PlusBilling.kt` and executed both billing test classes; 19 tests; this is not a full Android build |
| PASS | `npm run build:frontend`: TypeScript + Vite; existing chunk-size warnings; `/tmp/levix-intro-frontend.log` |
| PASS | `npm run lint`: 0 errors, 231 warnings and 91 infos with the installed Biome 2.6.4 (repo schema 2.5.14); `/tmp/levix-intro-final-lint.log` |
| PASS | `npm run i18n:check`: generated catalogs and review hashes consistent |
| PASS | Private `LEVIX_CORE_DIR=/tmp/levix-intro-core npm test`, external networking disabled: 261 tests, 0 failed/skipped, including actual staged Core-client / fake-verifier integration and test-only purchase guards; `/tmp/levix-intro-plus-final-tests.log` |
| PASS | `git diff --check` in both working trees |
| BLOCKED | `./gradlew :app:testDebugUnitTest -x stageLevixApp -x ensureDebugKeystore --offline --no-daemon --console=plain`: pinned Kotlin plugin 2.3.21 is missing from the cache; `/tmp/levix-intro-android.log`. The installed compiler proof above does not compile `BillingHost` against Play Billing 9.1.0. A full CI Android gate is still required. |
| BLOCKED | Real device / Play / verifier E2E: no available device; `adb devices -l` returned an empty list. Staging host, DNS/TLS, secret-store credentials, tester membership and Play catalog not confirmed. No actual Play purchase or production call. |

The private repo contains the isolated staging templates and the complete
eligible/ineligible, renewal, cancellation, grace, hold/recovery, pending,
revocation, restore and offline License Tester matrix. Staging preparation
is ready for infrastructure handoff, not deployed. The private Core pin stays
unchanged until the reviewed public change can be pinned; the new staging
build requires this paired Core version. Default public product/trust keys
remain empty. Free features and the existing entitlement lease policy stay
unchanged. Production billing has not been activated.

## PR preparation and upstream review — 2026-11-14

Preserved all prior tracked/untracked edits and fast-forwarded the isolated
Core tree to `c82fb89` (`release/5.0.0-beta.1`). This is the PR base: public
`main` does not contain the Phase 08 implementation. Resolved overlapping
catalog/ADR changes by retaining the upstream Free watermark policy, all new
translations and review history, then regenerated catalogs. The existing
public upload-disable and protected signing controls remain intact.

PASS on Linux x86_64 / Node 24.22.2, base `c82fb89` plus this change:
`node tests/plus-offer.test.mjs` (35 checks),
`node tests/play-workflow-safety.test.mjs` (12 checks),
`npm run i18n:check`, and `npm run build:frontend`.
The prior full-suite evidence above is retained as historical proof, not
represented as a run on the updated base. Full PR CI, including Kotlin 2.3.21
and Play Billing 9.1.0 Android builds, is the remaining automated gate.
No local dependency downloads, deployment, Play upload or device QA occurred.

PASS: focused `tests/entitlement-*.test.mjs` and `tests/plus-*.test.mjs`,
with `tests/fixtures/no-external-network.cjs` loaded; all checks passed
(`/tmp/levix-intro-upstream-focused.log`). PASS: `npm run lint`, zero errors
(233 warnings, 107 infos with cached Biome 2.6.4), and `git diff --check`.
These checks ran after integrating `c82fb89`, on 2026-11-14.

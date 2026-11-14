# Pre-release integration — Tasks 06, 07 and 08

2026-11-14, Linux x64, Node 24.22.2. **Offline implementation/verification
complete; Code Freeze and production Play readiness BLOCKED on owner gates.**
No Phase 10 audit, merge, production-signed AAB, deployment or upload performed.

## Baselines and prerequisite

The earlier checkpoint stopped at unmerged #173. Work resumed only after
[#173](https://github.com/Abdodiab2005/levix/pull/173) merged into release HEAD
`aaed3300b5578af9b03234d7bad6f0c0233430c5` and its exact-head
[CI 43553378310](https://github.com/Abdodiab2005/levix/actions/runs/43553378310)
was verified **7/7 PASS**. #169 merge `bb98995e6ac4833428941b97a583383fa41a36f0`
and #172 merge `c9b3f8897d6b2756317dca698675a30b4c3f3351` remain ancestors.
Original #168 is unchanged. Public main was
`18c8b6bf99830661f2a7896636fda9562e6b6a6a`; private main was
`cc1e8e1df463616aa655db97841ac8781f285f92`.

## Draft PRs and exact implementation heads

| PR / target | SHA | CI evidence |
| --- | --- | --- |
| [levix #174](https://github.com/Abdodiab2005/levix/pull/174) → release | `ff9aad72891bcf4dc2aa1544688e06a87937d168` (workflow implementation; subsequent report-only update) | [43553985651](https://github.com/Abdodiab2005/levix/actions/runs/43553985651), PASS 7/7 |
| [levix #175](https://github.com/Abdodiab2005/levix/pull/175) → #170 branch | `a7e0ef240d951307bdb62b2a87d99f077d009bec` | [43555193957](https://github.com/Abdodiab2005/levix/actions/runs/43555193957), PASS 7/7 |
| [levix-plus #7](https://github.com/Abdodiab2005/levix-plus/pull/7) → #6 branch (private) | `9d327cde465fdb7d6c7e30897bdf28fb27a5685f` | [43554532695](https://github.com/Abdodiab2005/levix-plus/actions/runs/43554532695), PASS 1/1 |
| [levix #176](https://github.com/Abdodiab2005/levix/pull/176) → release | `387106a5d58ed203b2e712f94eb06d829609729b` | [43555147842](https://github.com/Abdodiab2005/levix/actions/runs/43555147842), PASS 7/7 |

Report-only updates do not alter the implementations tested above. Check the
latest #174 head's automatic CI separately before merge.

## Task 06 — workflow safety checkpoint

Pre-edit audit found a manual `play-store.yml` Free-AAB upload bypass in both
public branches. Main also enabled stable-tag and beta Closed Testing uploads.
Plan: close each job at its owner, add a focused all-workflow policy gate and
correct PACKAGING; retain public Free builds. No dependency/version/schema
change. Rollback is workflow-only; reopening unsafe uploads is not recommended.

| Workflow | Verdict in proposed changes |
| --- | --- |
| Public release.yml | Play upload unconditionally disabled (already disabled in v5 by #169; #170 supplies main guard); Free APK/AAB/GitHub builds preserved |
| Public play-store.yml | #174/#175 disable manual uploads on every track regardless of confirmation inputs |
| Public android-beta-aab.yml | Absent in release; #175 disables main's Free build-and-upload job |
| Public ci.yml | Debug-key Free AAB validation only; no Play upload; public artifact scans retained |
| Private ci.yml | No signing secret or artifact publication; current-Core contract tests |
| Private paid-aab.yml | Throwaway test key/placeholder product; no Play upload or production artifact |
| Private internal-play-aab.yml (#6 + #7) | Owner-only main dispatch/re-run, explicit reviewed Core SHA and original upload-certificate check; private artifact only, no Play uploader |

PASS: `node tests/run.mjs play-workflow-safety` — 10 release / 12 main checks;
focused Biome lint, YAML parse, docs check and diff checks pass.
Main #175 initially exposed existing main Gemini failures (gemini-media crash,
genai v1 vs v1beta). It is now stacked on reviewed #170
`6b32bf5c6156d6b09cc5fb52ddec255f60001c7a`; final CI passes. Its diff contains
only safety/docs/tests, not #170's Gemini code. No existing PR was modified.

**Shipping safety BLOCKED until guards are merged.** The public google-play
environment requires owner review but allows admin bypass; public repository
secret `PLAY_SERVICE_ACCOUNT_JSON` still exists. Historical refs retain their
old workflow code. Owner must remove/restrict public Play publishing credentials
and verify environment/ref policies to prevent historical-ref bypass. No secret
or protection setting was changed; Play account permissions remain unverified.

## Task 07 — Plus integration checkpoint

Reviewed private #6 `dbbf5d150e3e10d43b5422e9bc0fbfb14c0b7a2f` against the
Phase 08 completion contract. Source-only Core reproduced its interop-before-
installation failure (`MODULE_NOT_FOUND pino`). #7 installs Core first, pins CI
to aaed3300, requires owner dispatch with exact current reviewed Core SHA, and
checks both keystore and output AAB certificates against the original Play
upload fingerprint. Existing exact-baseline/runtime-manifest artifact checker
remains authoritative; private runtime never enters public source/artifacts.
Scope/rollback and detailed owner runbook live in private `docs/PRE-RELEASE-06-07.md`.

| Result | Offline proof / limit |
| --- | --- |
| PASS | 195 focused private service/runtime/artifact tests against current Core, 0 skips, external network denied |
| PASS | 6 focused injection/certificate tests; malformed/wrong upload identity rejected; YAML and dependency-order checks |
| PASS | Core entitlement: 396 checks; Auto Reply: 340; Free/Auto Reply memory-policy isolation: 41425; all 0 failures/crashes |
| PASS | Signed installation binding; one server binding; ≤3 moves/rolling 30 days; acknowledgement, renewal/cancellation/expiry, refund/revocation; OIDC RTDN auth/idempotency and Play API re-verification with fakes |
| PASS | Core stays usable without Plus/verifier; Auto Reply opt-in, bounded, account scoped and entitlement gated; four-language billing catalog |
| BLOCKED | Original upload-certificate identity: signing-secret names exist, values unreadable; `LEVIX_PLAY_UPLOAD_CERT_SHA256` is absent |
| BLOCKED | Live product `levix.plus`, plan `monthly`, USD 0.99/month and approved Egypt 30% discount: Console evidence unavailable |
| BLOCKED | Live verifier/DNS/TLS, Play service-account rights, RTDN audience/email/subscription, license-test lifecycle and effective four-language legal/Data safety disclosures: not independently verified |
| NOT RUN | Production-signed combined AAB and all real Play lifecycle/device tests |

Configured entitlement public key is canonical 32-byte Ed25519, kid
`381d746e0bcfe52f`; live signer matching is unverified. Origin in code/runbooks
is `https://levix-plus.leviro.net`. Injection/signer derive the same kid. Rotate
only after apps trust old/new keys; current one-key injector does not implement
overlap rotation. Old installations with cached signed leases lose moved/revoked
access on refresh or expiry, not instantly offline. Console must expose the
approved monthly plan; Billing filters standard P1M auto-renewing offers.
No levix-ui edit is required for the tested offline integration; legal activation
and service deployment still require owner evidence/authorization.

## Task 08 — migration/backup checkpoint

Pre-edit plan: freeze independently materialized released v4.9.1/v4.9.2 schema
10 (both identical, commits `6fb29798bba4fc08a199f7a92864781767d7f513` and
`781eab56a1e6a46b7167edfe2143e2955a92173d`), seed realistic synthetic data and
sealed pairing/session rows, then exercise the real locked startup and consent.
Only `tests/fixtures/v49-schema.sql` and `tests/v49-upgrade.test.mjs` added;
no runtime/schema change. Rollback removes these tests. Existing focused tests
supply remaining crash/backup/offline proof; no entire local suite rerun.

| Result | Command / coverage | Checks |
| --- | --- | ---: |
| PASS | `node tests/run.mjs v49-upgrade`: schema 10→12; all legacy table rows, settings/permissions/roles/LIDs, schedules, moderation/auto-delete, AI history/Markdown memory, sealed pairing/signal sessions and levix.key retained; new-version consent uses fake sockets without clearing credentials | 53 |
| PASS | `node tests/run.mjs backup`: encrypted creation/restore, matching/mismatched accounts, Plus customization allowlist, purchase/entitlement/installation-secret exclusions, corrupt/password failures and recovery | 752 |
| PASS | `node tests/run.mjs migrations` | 154 |
| PASS | `node tests/run.mjs start-order`: verified copy, interruption/SIGKILL, contention, failure/rollback | 136 |
| PASS | `node tests/run.mjs db-copy`: secret-free copy and verification | 150 |
| PASS | `node tests/run.mjs lock` | 18 |
| PASS | `node tests/run.mjs session-consent` / `legal-consent` | 48 / 133 |
| PASS | `node tests/run.mjs headless`: isolated offline/Core startup | 45 |
| NOT RUN | Real Google Play in-place device upgrade — Task 11 | — |

**1,489 focused checks, zero failures/crashes**, Linux x64, Node 24.22.2,
2026-11-14, Core aaed3300 / added proof 387106a. Focused new-test lint passes.
Native extraction keeps `files/app` separate from `files/data`; device proof
is not inferred from backend fixtures. Matching backup activation and mismatched
account deferral preserve account boundaries; restore never activates Plus.

**Safety-copy rollback differs from in-place upgrade:** the pre-migration copy
excludes pairing/QR, panel auth, recovery email, session/API/proxy secrets and
Plus security material. Restoring it can require re-pairing and reconfiguration.
The normal in-place upgrade preserves credentials and the existing vault key.
Encrypted user backups may contain allowed API keys inside encrypted payloads;
purchase tokens, entitlement credentials and installation keys stay excluded.

## Remaining blockers and Code Freeze prerequisites

No new unresolved P0/P1 defect remains in the proposed, scoped offline code.
Current unmerged upload bypasses remain a material release blocker; live billing
readiness is BLOCKED, not PASS. All new PRs remain Draft/unmerged.

1. Owner reviews #174/#176 into v5, #175 into #170 then #170 into main, and
   private #7 into #6 then #6 into private main. Recheck exact resulting heads,
   Gemini ancestry and integrated CI; no automatic merge is authorized.
2. Remove/restrict public publishing credentials/historical-ref access; supply
   original upload fingerprint, confirm keystore/package and unused versionCode
   (currently 71), reviewed release SHA and private artifact-only destination.
3. Verify signer/public-key match and rotation/backup plan, service/RTDN/Play API
   configuration, monthly product/pricing/testers, effective disclosures and
   real lifecycle readiness. Missing owner-controlled evidence remains BLOCKED.
4. Separately authorize any production signing/build or Play upload. Task 11
   device upgrade QA and Phase 10 release audit remain separate, unstarted gates.

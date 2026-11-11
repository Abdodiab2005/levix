# Phase 09 — updates, official links, rating and watermark

Status: IMPLEMENTING, owner authorized 2026-11-11. Base: `94ef953` on
`release/5.0.0-beta.1` (Phase 08 and its security corrections merged).
Detailed owner brief read from
`/home/abdo/Downloads/levix-v5-phase-prompts/PHASE-09-UX-UPDATES-RATING.md`
with its README and manifest. Include portfolio, Leviro and support links,
bounded plain-text release notes and a four-language UI evidence report.

## Audit

- The command dispatcher owns authorization, routing and watermarking. There is
  no update command or update service. Existing command permissions must stay
  identical; the new metadata-only `update` command defaults to OWNER_ONLY.
- `src/messaging/message.cjs` already owns watermark eligibility and calls the
  Phase 08 extension host. `message_watermark` defaults to false. Preserve the
  default and every saved Free choice; no migration or subscription requirement
  may enable it. ADR-012's default-on wording is superseded by the owner's
  2026-11-11 instruction. Raw STT, forwarded content and legal/security output
  need explicit regression coverage.
- The authenticated dashboard router is the API boundary. The React header has
  screen help; Settings has no About/update surface. Use existing design-system
  cards, dialogs, toggles and icon buttons, with four catalog translations.
- Android's WebView and bridge are loopback-only. External navigation is blocked;
  keep that boundary and open only fixed official HTTPS links in another app.
  Detect Play installs using PackageManager installer information, never page
  input. Pass that fact to the backend as an internal boot argument, without a
  new setting/environment variable or changing the consent release identity.
- Play Billing already exists. Update/review libraries are absent from the local
  Gradle cache. Workstation checks stay offline. GitHub-hosted CI is authorized
  to resolve dependencies. Q-16 stays evidence-pending until dependency graph,
  manifest, artifact delta and non-Play unit-test results are recorded; do not
  introduce channel flavors speculatively.

## Acceptance

1. `!update` and an authenticated panel action check only bounded, timed HTTPS
   metadata from the official GitHub Releases API on non-Play installs. Stable uses the
   dedicated latest endpoint; beta also scans a bounded ten-release page and
   refuses to call an incomplete preview scan up to date. Strict
   semver (including prereleases/build metadata), invalid/missing releases,
   redirects, oversized/invalid bodies, timeouts and offline failures have tests.
   Stable users never receive a prerelease; beta users can see a newer beta or
   stable release. Concurrent checks coalesce and repeated requests use a short
   local RAM cache. No startup polling, executable download, install or restart.
2. Play installs return the official Play destination without contacting GitHub.
   Native checks use Play's availability/versionCode and flexible update flow.
   Starting and completing an update each require user action. Cancellation,
   missing Play, missing store/account eligibility and activity destruction are
   harmless. A GitHub installation never invokes Play clients.
3. About, Help and Settings expose fixed official links. Browser links isolate
   their opener; native links accept only the fixed HTTPS destinations, reject
   credentials, hostile schemes, lookalike hosts and arbitrary redirects, and
   never load external pages in the privileged WebView.
4. An explicit Rate action opens the store listing. In-App Review has separate,
   default-off local consent and a conservative local request interval, with no
   tracking of rating, dismissal or result. Google controls whether UI appears.
   No feature, discount or entitlement depends on reviews or GitHub stars.
5. Existing Free watermark opt-in and Plus host behavior are retained. Security,
   legal, errors/progress, raw STT, forwarded/user text, exact commands, files,
   captions, API payloads and AI prompts remain unchanged; long or already
   watermarked replies are not stamped again. All four languages are covered.

## Files and PR order

- 09a: update service, fixed official-link configuration, update command and
  default permission; message-engine exclusions; authenticated update routes;
  bot/command catalogs and focused regressions.
- 09b (stacked on 09a): Android installer facts, safe external opener,
  lifecycle-owned Play update/review host and bridge; React About/Help/Settings
  integration; dashboard catalogs; Android policy tests; Q-16 CI measurement.
- Each PR receives independent review. The orchestrator reviews every diff and
  runs tests/builds. Delegates edit only their named files and run no gates.

## Data, threats and rollback

No database migration, pairing change, backup-format change or private Plus
implementation. Update cache is RAM-only and contains public metadata. Rating
preference and last request time stay in Android preferences, outside backups;
no tracking endpoint. Explicit checks disclose an ordinary HTTP request to
GitHub or Google Play; document that in PRIVACY.md. Release notes/URLs are
untrusted data: never render HTML or execute them; generate official destination
URLs from validated tags. Keep authentication/CSRF and origin restrictions.
Rollback 09b before 09a; disable the new command through existing command
settings. Existing Free functionality and watermark preferences survive.

## Proof and release boundary

Run focused fake-network and fake-socket tests, all `npm test`, lint, frontend
build, i18n/docs checks, public artifact scan, Android offline unit/build checks
where cached inputs permit, then the full existing GitHub Actions CI matrix.
Record PASS/FAIL/NOT RUN/BLOCKED with command, platform, date and commit in
PHASE-09-RESULTS.md. Manual Play eligibility/update/review and old-WebView/device
QA require authorized dedicated test accounts and remain explicit release gates.
Phase 10 remains mandatory for v5.0.0. Once code-ready, Phase 11 starts on a
separate next-release branch with its own audit/plan/PR, never the v5.0 branch.

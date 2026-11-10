# Phase 08: Levix Plus — results

Status: `READY FOR OWNER MERGE REVIEW` (2026-11-10, after the final security and integration corrections).
Every slice is implemented, synchronized with `release/5.0.0-beta.1` at `1a071f3` (Q-19, #152), reviewed and
re-verified; no P1 or P2 finding is open. Nothing is merged. Live billing, the paid build pipeline, the verifier
deployment, the signing key, the Play product and RTDN are deliberately NOT executed and wait for explicit owner
approval (section 7). Plan and contracts: `PHASE-08-PLAN.md`.

This document separates three things: confirmed results with evidence (sections 3 to 5), decisions that are only
proposed (section 7), and checks that need live services, devices or accounts (section 8).

Evidence labels follow ADR-014. All local results: Linux x64, Node 24.22.2 (`~/.cache/levix-build`),
offline installs from the npm cache, 2026-11-10.

## 1. What was built

| Slice | Repository | Branch, head | Content |
| --- | --- | --- | --- |
| 08-0 | public | `feat/v5-phase-08` `c38b787` + this document | plan, inert entitlement stub, wire-contract text |
| 08a | public | `feat/08a-extension-host` `b280ad3` | extension contract v1, loader, host, ctx, Core hooks, Auto Reply intake and Core AI turn |
| 08b | public | `feat/08b-entitlement` `6d6a3d9` | installation key, token verifier, sealed rollback barrier, signed client, refresh, panel routes |
| 08c | public | `feat/08c-billing-ui` `942170f` | Android Play Billing 9.1.0 client, bridge, Settings > Levix Plus |
| 08h | public | `feat/08h-plus-ui` `5fb8ee3` (stacked on 08c) | Plus feature screens: messages, presets, visibility, Auto Reply |
| 08e | public | `feat/08e-artifact-scan` `8ccf398` | public artifact scanner and CI steps (npm, SEA, Android zip, Docker) |
| wiring | public | `integration/v5-phase-08` `9e67758` + this document | merges of all slices, route mounting, log-leak and shutdown fixes |
| 08d | private | `feat/08d-verifier` `43f64c7` | verification service: claim, refresh, RTDN, Play adapter, binding store, signer |
| 08f | private | `feat/08f-runtime` `6f75c44` | Plus runtime: templates, presets, visibility, Auto Reply policy, panel API |
| interop | private | `integration/phase-08` `4a9f31f` | cross-repository tests Core ↔ verifier and Core host ↔ runtime; CI workflow pinned to a Core commit |

Size: public 81 files, +14,650 / -62 lines against `release/5.0.0-beta.1` `1a071f3`; private 46 files, +4,926 / -2 lines.

Release synchronization: `release/5.0.0-beta.1` (`1a071f3`, Q-19 #152) was merged into `feat/v5-phase-08` and from
there into every slice and the integration branch, with merge commits only (no rebase, no force push). The only
real conflict was `i18n/review.json` in 08c and 08h; it was resolved by keeping the Q-19 provenance and appending
the Phase 08 notes, recomputing the file hashes and regenerating the generated catalogs. A check of all 14 strings
that Q-19 changed confirmed none was lost. The earlier `mergeable=false` reports were stale: every PR reported
`MERGEABLE CLEAN` against its base before the sync.

### 1.1 Free Core guarantees

- No module at `<asset root>/extensions/levix-plus/index.cjs` means host state `absent`: every hook returns the
  Free result, no timer, no network, no installation key.
- `TRUSTED_KEYS` is empty in this repository, so no entitlement token verifies and Plus cannot activate in any
  public build even with a module present.
- The entitlement client makes no request while `TRUSTED_KEYS` is empty or no purchase was ever claimed.
- Reaction Automation, commands, moderation, scheduling and media tools do not read entitlement state.
- `plus_enabled` (default on) turns the extension off without uninstalling it; Free features are unaffected.

### 1.2 Premium features (private runtime, active only with a verified entitlement)

- Message personalization by stable `bot.*` key: Auto Translate (translated once on save through the existing
  Google path, placeholders shielded) or Original Everywhere; per-locale manual overrides; restore default;
  150 overrides; allowlisted keys only (moderation, permission, security, routing and legal keys are refused in
  Core). Four locales.
- Presets Minimal, Professional, Fun; apply never overwrites a manual edit without explicit consent.
- Watermark hide and progress hide (all or selected commands). Results, errors and security text never hide.
- Prefix-free AI Auto Reply: off by default, kill switch, per-chat allowlist and trigger (all, mention, keywords),
  cooldown, per-sender, per-chat and global hourly budgets, loop guard. Core enforces on top: no forwarding for
  commands, the bot's own sends, the linked account, `botMetadata`, out-of-scope chats; composite replay keys;
  caller minted for the real sender; tools authorized through `aiToolAuth.cjs`; memory tools chat-only; global
  memory excluded; same-chat delivery under a guard that rechecks account epoch, host generation, live
  entitlement, roster freshness and current scope; backstop 2 concurrent, 1 per chat, 6 per chat per minute,
  30 per minute.

### 1.3 Not implemented (deferred or blocked)

- `advanced-route-overrides` capability: not added. Free Core already has per-command and per-category routing
  (`reply_route_overrides`); a paid copy would make a Free feature paid. Plus presets set visibility only.
- Paid artifact pipeline (private CI that stages the runtime into `levix-app.zip` and sets `levixPlusProductId`):
  not built (D-08-1).
- Verifier deployment, Play product, RTDN topic, signing key: blocked (section 7).
- `PRIVACY.md` and Play Data safety rows: drafted in section 6, not applied, because no billing flow ships yet
  (ADR-014: public docs describe shipped behaviour only).
- Watermark default and Free-build watermark rules: Phase 09.

## 2. Entitlement and billing security design (as implemented)

- Installation identity: Ed25519 key created on first purchase only, sealed with `vault.cjs` in
  `plus:installation-key`; `installationId` = base64url SHA-256 of the raw public key (43 characters), used as the
  Play `obfuscatedAccountId`.
- Client never grants: Android hands the purchase token to the local backend; only a verifier-signed token
  activates Plus. Purchase tokens never reach logs, errors, route responses or backups.
- Signed requests: Ed25519 over canonical JSON of audience, method, path, body hash, installation, nonce and
  timestamp; 5-minute window; nonces single use for 10 minutes.
- Verifier: Play `subscriptionsv2.get`; package and product allowlist; test purchases refused unless configured;
  first binding requires `obfuscatedExternalAccountId == installationId`; one active installation per purchase
  token, at most 3 moves in 30 days; server-side acknowledgement with a 10-minute retry sweep; purchase rows
  versioned so a slow request cannot overwrite a newer RTDN state; RTDN authenticated with Google OIDC.
- Token: compact JWS, `kid` pinned; `sub` must equal the local installation; `seq` strictly increasing; entitled
  `exp` = min(iat + 72 h, Play expiry + 2 h) active, min(iat + 72 h, Play expiry) canceled, min(iat + 24 h,
  Play expiry) grace; a signed `inactive` token turns Plus off at once.
- Cache: `plus:entitlement` plus a vault-sealed barrier `plus:entitlement-hw` (max seq, high-water time, server
  offset) and a per-process max seq. Restoring an older cached row is refused as `rollback`. Clock rollback below
  the high-water mark gives state `clock` until a fresh token rebases it.
- Refresh: 60 s after start, then min(iat + 12 h, exp - 6 h), or max(15 min, half the remaining time) up to 1 h
  once that lead time has passed; backoff 1 min to 6 h; single flight; stop aborts requests.
- Outage: Plus stays active only until the current token's `exp`; Core never waits on billing.

Residual risks (documented, accepted for review):
- R-08-1: an owner who restores both cache rows from an older snapshot after a restart keeps Plus until that
  token's `exp` (at most about 74 h). Local checks cannot stop an owner-controlled device.
- R-08-2: JavaScript shipped to a device can be read and patched; repository privacy is not copy protection.
- R-08-3: Auto Reply is stateless per message in v1 (no conversation history), which limits answer quality.

## 3. Confirmed results

| Gate | Result | Command, where |
| --- | --- | --- |
| Baseline before Phase 08 | PASS 14,076 checks, 0 failed | `npm test` at `05e30e8`, ffmpeg-static binary linked locally |
| Core unit and integration | PASS 15,493 checks, 0 failed (1 flaky timeout, below) | `npm test` at `9e67758` |
| `setup-code.test.mjs` | crashed once at its 10 s limit under load; PASS 3/3 reruns, 33 checks each | `node tests/run.mjs setup-code` at `9e67758`; Phase 08 does not touch setup |
| Lint | PASS (0 errors, 230 warnings; base 211) | `npm run lint` at `9e67758` |
| i18n | PASS; 14/14 Q-19 strings kept | `npm run i18n:check`, `check-q19` script at `9e67758` |
| Docs index | PASS | `npm run docs:check` at `9e67758` |
| Frontend build (tsc + vite) | PASS | `npm run build:frontend` at `9e67758` |
| npm tarball | PASS 36 checks | `npm run validate:tarball` at `9e67758` |
| SEA build and run | PASS 51 checks | `npm run build:sea && npm run validate:sea` at `9e67758` |
| Artifact scan, SEA dir and npm tarball | PASS: 6 entries, 181.0 MiB; 303 entries, 4.1 MiB | scanner at `9e67758` |
| Private verifier + runtime + Core interop | PASS 133 tests, 0 failed, 0 skipped | `LEVIX_CORE_DIR=<p08-int at 9e67758> npm test` at `4a9f31f` |
| Private CI (new) | PASS: 130 tests without Core, then 133/133 against the pinned Core | levix-plus run 42854616171 (Core `27fe378`); re-pinned to the final integration commit |
| Auto Reply memory isolation | PASS: owner DM, member DM and group turns get no global memory; global/all/aliases, missing chat id and `summarize_chat` refused; explicit `!ai` control keeps global memory | `extensions-autoreply` 113 checks, `extensions-tools` 271 checks at `b280ad3` |
| Headless panel QA (scratch build) | PASS 26/26 | at `e0602e7`; real claim → Core client → real verifier with a fake Play API; RTDN revoke; cache rollback refused; other-installation token; 360 px Arabic RTL; purchase token absent from logs |
| Android build, unit tests, APKs and AAB with Billing 9.1.0 | PASS in CI | "android apk builds" on 08c and 08h heads; Kotlin 2.3.21 required (2.0.21 failed in run 42845608084) |
| Docker validate and image scan | PASS in CI | "container persists its volume" on every head |

Mocked Billing and fake WhatsApp sockets do not validate production Google Play Billing or live accounts.

## 4. Reviews

| Round | Reviewer | Scope | Findings | State |
| --- | --- | --- | --- | --- |
| Discovery | agy Argon, agy Flash, Codex `gpt-6.1-sol` | Core hooks, Android, Play docs, threats | 4 reports | used for the plan |
| 1 | Codex `gpt-6.1-sol` | 08a, 08d, 08f | 6 P1, 8 P2 | fixed in `bc32eb9`, `dfe5b31`, `6f085ca` |
| 2 | Codex `gpt-6.1-sol` | 08b, 08c, 08h, 08e, wiring | 1 P1, 12 P2, 2 P3 | fixed in `9eeebc0`, `e41e824`, `d4a2d06`, `06f99ea`, `9f312f2` |
| 3 | Codex verification of rounds 1 and 2 | all | 1 P1 left (RTDN writes), 7 P2 (partial fixes, regressions) | fixed in `43f64c7`, `ab6fae8`, `1040d47`, `4a32dc9`, `8662c6e`, `4f0435d` |
| 4 | Codex verification | all | 2 P2 in 08a | fixed in `aaefd68` |
| 5 | Codex final check | 08a | none | all eight slices ready |
| 6 | ChatGPT inspection (owner) | Auto Reply memory | P1: owner DMs got global memory, contrary to Q-09 | fixed in `286df16` |
| 7 | Independent Codex (fresh session) and agy Flash | P1 fix | Codex: P1 via stored history and `summarize_chat`; agy: P3 missing chat id | fixed in `b280ad3`; Codex re-verification: SAFE, no new P1/P2 |

Headless QA independently found the round-2 P1 (cache rollback) before the review returned.

## 5. Pull requests and CI

Nothing is merged. CI for the final heads is listed in the PR checks; section 3 records the last local gates.

| PR | Branch | Head |
| --- | --- | --- |
| #153 umbrella (draft) | `feat/v5-phase-08` → `release/5.0.0-beta.1` | this document on `c38b787` |
| #154 08a | `feat/08a-extension-host` → `feat/v5-phase-08` | `b280ad3` |
| #155 08b | `feat/08b-entitlement` → `feat/v5-phase-08` | `6d6a3d9` |
| #156 08c | `feat/08c-billing-ui` → `feat/v5-phase-08` | `942170f` |
| #157 08h | `feat/08h-plus-ui` → `feat/08c-billing-ui` | `5fb8ee3` |
| #158 08e | `feat/08e-artifact-scan` → `feat/v5-phase-08` | `8ccf398` |
| #159 integration (draft) | `integration/v5-phase-08` → `feat/v5-phase-08` | `9e67758` + this document |
| levix-plus #1 | `feat/08d-verifier` → `main` | `43f64c7` |
| levix-plus #2 | `feat/08f-runtime` → `main` | `6f75c44` |
| levix-plus #3 (draft) | `integration/phase-08` → `main` | `4a9f31f` + Core re-pin |

## 6. Privacy and Data safety (draft, apply when billing ships)

Data that leaves the device only after the operator subscribes on Android:
- To Google Play: the purchase itself and an obfuscated account id that is a hash of the installation key.
- To the Leviro verifier: the Play purchase token, product id, package name, the installation id and its public
  key, request timestamps and nonces. No WhatsApp data, phone number, email or chat content.
- Verifier storage: installation id and public key; SHA-256 of each purchase token and the token sealed with a
  service key; product, state, expiry, acknowledgement; binding history; nonces for 10 minutes; RTDN message ids
  for 7 days; rows deleted 90 days after the subscription expires or on request. IP addresses are used only for
  in-memory rate limiting.
Play Data safety: "Purchase history" collected, not shared, required for the subscription, encrypted in transit;
"App activity" not collected for billing. Final wording needs the owner's review and the legal review that the
v5 release already requires.

## 7. Owner decisions (proposed, recorded for review) and external prerequisites

Proposed decisions recorded 2026-11-10 for owner review. "Implemented" means the code already behaves this way;
it is still the owner's decision.

| Id | Proposed decision | Code today |
| --- | --- | --- |
| D-08-10 | Levix Plus is Android-only in v5 (Q-20 (a)); desktop, npm, SEA, Docker and self-hosted stay Free | implemented: only the Play client can buy; public builds ship no runtime |
| D-08-3 | One active installation per subscription, at most 3 moves per 30 days; exception procedure: the owner (support) clears the move history of one purchase token in the verifier database after checking the Play order id the customer quotes, and records the action | implemented in the verifier; exception procedure is manual and not built |
| D-08-7 | Auto Reply memory is strictly chat-scoped for every caller, including owner DMs; memory tools refuse global scope; summarize_chat is refused in Auto Reply turns | implemented (P1 fixes `286df16` and the summarize follow-up) |
| D-08-12 | Plus subscription and installation secrets (`plus:installation-key`, `plus:entitlement`, `plus:entitlement-hw`) never enter backups, settings export or pre-migration copies | implemented |
| D-08-6 | No Plus customizations (`ext:*`) in v1 backups, with an explicit user-facing warning in Settings > Backup and in the Plus screen | exclusion implemented; warning text NOT implemented (waits for approval) |
| D-08-9 | Hide Settings > Levix Plus in public Free builds (extension absent) | NOT implemented: public builds show "Levix Plus is not included in this build" until approved |
| D-08-11 | `levix-plus` stays private, owner-only, UNLICENSED | in effect |

Not executed and waiting for explicit approval: production billing, the paid build pipeline (D-08-1), verifier
deployment and host name (D-08-2), the Play subscription product with USD 0.99 and the Egypt price (D-08-4), the
entitlement signing key (D-08-5) and RTDN (D-08-8).

## 8. Manual QA still required

- Android device: Plus screen on Android 10 and 14, purchase with a license tester, pending purchase completed
  later, cancel, restore after reinstall, manage link, activity recreation during purchase.
- Live verifier: deployed service with a real service account, acknowledgement within 3 days, RTDN delivery for
  renew, cancel, grace, hold, revoke, refund.
- Real WhatsApp on a dedicated test account: Auto Reply in a DM and in a group (mention trigger), loops with
  another bot, group admin demoted during a turn, unlink and relink, backup restore to another account.
- Translation review of new pt-BR and es-419 strings (machine drafts in `i18n/review.json`).

## 9. Merge order and rollback

Merge order, each step only after the owner's explicit instruction:
1. levix-plus #1 (`feat/08d-verifier`), then #2 (`feat/08f-runtime`), then #3 (`integration/phase-08`, CI pinned
   to the public integration commit).
2. levix #154 (08a), #155 (08b), #158 (08e), #156 (08c), then #157 (08h, retarget to `feat/v5-phase-08` after
   #156 merges), each into `feat/v5-phase-08`.
3. levix #159 (`integration/v5-phase-08`: wiring, log-leak and shutdown fixes, release synchronization).
4. levix #153 (`feat/v5-phase-08`) into `release/5.0.0-beta.1`.

Rollback: turn `plus_enabled` off, or ship without the runtime. No database migration was added in Core (all
state is `bot_settings` keys), so a downgrade needs no restore; unknown `plus:*` and `ext:*` keys are ignored by
older builds. The verifier can be stopped without affecting any Free install. The Android Billing dependency is
inert in public builds (empty product id), so reverting `feat/08c-billing-ui` removes it cleanly.

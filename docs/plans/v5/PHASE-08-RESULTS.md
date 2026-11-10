# Phase 08: Levix Plus — results

Status (2026-11-10, after the owner decisions in #160 and their implementation, section 10):

- **Code: `CODE READY FOR OWNER MERGE REVIEW`.** Every slice, including the completion slices 08i to 08l
  and levix-plus 08g and the paid pipeline, is implemented, reviewed by an independent Codex session and
  re-verified. No P1 or P2 finding is open (section 10.8). Nothing is merged.
- **Production billing and live QA: `BLOCKED`.** They need owner credentials and actions that this work may
  not perform: the verifier deployment and DNS for `levix-plus.leviro.net`, the entitlement signing key, the
  Play product, Google Cloud Pub/Sub and service accounts, the upload key, a license-tester device and a
  WhatsApp test account (section 10.9). Phase 08 is not shipped and not production ready.

Plan and contracts: `PHASE-08-PLAN.md`; completion contract: `PHASE-08-COMPLETION.md`.

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
  caller minted for the real sender; tools authorized through `aiToolAuth.cjs`; global memory only through
  the per-chat owner opt-in of section 10.2; same-chat delivery under a guard that rechecks account epoch, host generation, live
  entitlement, roster freshness and current scope; backstop 2 concurrent, 1 per chat, 6 per chat per minute,
  30 per minute.

### 1.3 Not implemented (deferred or blocked)

- `advanced-route-overrides` capability: not added. Free Core already has per-command and per-category routing
  (`reply_route_overrides`); a paid copy would make a Free feature paid. Plus presets set visibility only.
- Paid artifact pipeline: built as a non-production pipeline (section 10.5); a production run waits for the
  owner's upload key and Play product (D-08-1).
- Verifier deployment, Play product, RTDN topic, signing key: blocked (section 7).
- `PRIVACY.md`, the bundled Terms and Play Data safety rows: four-locale drafts in
  `docs/plans/v5/legal-drafts/` (section 10.6), not applied, because no billing flow ships yet (ADR-014:
  public docs describe shipped behaviour only).
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

## 7. Owner decisions and external prerequisites

The owner decided D-08-2, D-08-3, D-08-6, D-08-7, D-08-8 and D-08-12 on 2026-11-10 (#160,
`PHASE-08-OWNER-DECISIONS.md`). The other rows remain proposals; "implemented" means the code behaves this way.

| Id | Proposed decision | Code today |
| --- | --- | --- |
| D-08-10 | Levix Plus is Android-only in v5 (Q-20 (a)); desktop, npm, SEA, Docker and self-hosted stay Free | implemented: only the Play client can buy; public builds ship no runtime |
| D-08-3 | One active installation per subscription, at most 3 moves in any rolling 30 days, audited manual exceptions | **owner approved (#160)**; implemented in the verifier; exception procedure documented in levix-plus `service/README.md`; no move counter in the app |
| D-08-7 | Auto Reply memory chat-scoped by default | **superseded by owner decision 1 (#160)**: per-chat global memory read and write, both off by default, writes only for a bot owner (section 10.2) |
| D-08-12 | Plus subscription and installation secrets never enter backups, settings export or pre-migration copies | **owner approved (#160)**; implemented and tested |
| D-08-6 | No Plus customizations in v1 backups | **superseded by owner decision 3 (#160)**: nonsecret customizations are included (section 10.3) |
| D-08-9 | Hide Settings > Levix Plus in public Free builds | implemented in 08k (hidden unless the runtime is installed or the build has a Plus product id); whether a Free build should advertise Plus stays an open product decision |
| D-08-2 | Verifier host | **owner decided (#160)**: `https://levix-plus.leviro.net`; code, docs and drafts updated; no DNS or deployment |
| D-08-8 | RTDN | **owner approved (#160)**: Pub/Sub push with OIDC; code audited and deployment kit written (section 10.4); no cloud resource created |
| D-08-11 | `levix-plus` stays private, owner-only, UNLICENSED | in effect |

Not executed and waiting for explicit approval: production billing, a production run of the paid pipeline
(D-08-1; the non-production pipeline exists, section 10.5), the verifier deployment and DNS, the Play subscription
product with USD 0.99 and the Egypt price (D-08-4), the entitlement signing key (D-08-5) and the RTDN cloud
resources (D-08-8).

## 8. Manual QA still required

- Android device: Plus screen on Android 10 and 14, purchase with a license tester, pending purchase completed
  later, cancel, restore after reinstall, manage link, activity recreation during purchase.
- Live verifier: deployed service with a real service account, acknowledgement within 3 days, RTDN delivery for
  renew, cancel, grace, hold, revoke, refund.
- Real WhatsApp on a dedicated test account: Auto Reply in a DM and in a group (mention trigger), loops with
  another bot, group admin demoted during a turn, unlink and relink, backup restore to another account.
- Translation review of new pt-BR and es-419 strings (machine drafts in `i18n/review.json`).

## 9. Merge order and rollback

Merge order, each step only after the owner's explicit instruction (completion PRs from section 10 included):
1. levix-plus #1 (`feat/08d-verifier`) and #2 (`feat/08f-runtime`) into `main`.
2. levix-plus #4 (`feat/08g-completion`) into `integration/phase-08`, then #5 (`ci/paid-aab`, retarget to
   `integration/phase-08` after #4), then #3 (`integration/phase-08` into `main`).
3. levix #154 (08a), #155 (08b), #158 (08e), #156 (08c), then #157 (08h, retarget to `feat/v5-phase-08` after
   #156 merges), each into `feat/v5-phase-08`.
4. levix #160 (owner decisions), then #161 (08i), #162 (08j), #163 (08k) and #164 (08l), each into
   `integration/v5-phase-08`; retarget each to `integration/v5-phase-08` after the previous one merges.
5. levix #159 (`integration/v5-phase-08` into `feat/v5-phase-08`).
6. levix #153 (`feat/v5-phase-08`) into `release/5.0.0-beta.1`.

Rollback: turn `plus_enabled` off, or ship without the runtime. No database migration was added in Core (all
state is `bot_settings` keys), so a downgrade needs no restore; unknown `plus:*` and `ext:*` keys are ignored by
older builds. A backup that carries Plus Auto Reply rules is refused as damaged by builds before 08j; nothing is
written in that case. The global memory settings fall back to their defaults when removed; set
`ai_global_memory_read` to `everyone` and `ai_global_memory_where` to `all` to restore the v4.9 reach. The verifier can be stopped without affecting any Free install. The Android Billing dependency is
inert in public builds (empty product id), so reverting `feat/08c-billing-ui` removes it cleanly.

## 10. Completion of the owner decisions of 2026-11-10

Source: `PHASE-08-OWNER-DECISIONS.md` (#160). Contract: `PHASE-08-COMPLETION.md`. All local results: Linux x64,
Node 24.22.2, 2026-11-10.

### 10.1 What was implemented

| Slice | Repository, PR | Branch, head | Content |
| --- | --- | --- | --- |
| 08i | levix #161 | `feat/08i-memory-policy` `4f63270` | Free global memory policy, Auto Reply per-chat global memory in Core, review fixes |
| 08j | levix #162 | `feat/08j-plus-backup` `8848095` | nonsecret Plus customizations in encrypted backups |
| 08k | levix #163 | `feat/08k-plus-ui-build` `02a3c17` | panel UI, move-denial text, public-build hiding, `LEVIX_EXTENSIONS_DIR` staging hook, verifier origin |
| 08l | levix #164 | `feat/08l-legal-drafts` | four-locale Terms/Privacy drafts, Data safety draft, this section |
| 08g | levix-plus #4 | `feat/08g-completion` `2b1358b` | runtime `globalMemory`, origin, RTDN audit and fix, `service/deploy/`, Core pin `02a3c17` |
| paid | levix-plus #5 | `ci/paid-aab` `81dadb6` | non-production paid AAB pipeline and hardened AAB checker |

### 10.2 Global memory permission matrix and defaults

Free AI turns (`!ai`, `!gemini`, `!ask`), defaults `ai_global_memory_read = privileged`,
`ai_global_memory_write = off`, `ai_global_memory_where = own_chat`:

| Verified caller | Own private chat with the bot | Another private chat | Group |
| --- | --- | --- | --- |
| Bot owner (incl. the linked account in its self chat) | read yes, write no | no | no |
| Bot admin | read yes, write no | no | no |
| Group admin who is not a bot admin | no | no | no |
| Member | no | no | no |
| Unverified or stale-epoch caller | no | no | no |

- `owner`, `privileged` and `everyone` widen read; `owner` and `privileged` enable AI-initiated writes; `private`
  and `all` widen the chats. Global writes still need the bot owner or bot admin role on top of the setting.
- Enforced for the system prompt (Gemini, OpenAI-compatible, Anthropic), `search_memory` (`global`, `all`,
  `shared`, `عام`, `عالمي`), `save_memory`, `forget_memory`, `summarize_chat`, and rechecked right before each
  write. Write results echo global content only with live read access.
- A turn without read gets its stored history without memory tool calls, results, intermediate model text or
  thoughts. `summarize_chat` always summarizes only text delivered to the chat.
- `!memory`: every global path (list, search hits, file, forget, clear) needs a bot owner or bot admin;
  members keep chat memory. This narrows v4.9, where members could list global entries.

Plus Auto Reply (independent of the Free settings), per chat in the Auto Reply editor:

| Setting | Default | Who it affects |
| --- | --- | --- |
| Use global memory in this chat (`globalMemory.read`) | off | prompt and `search_memory` for every sender in that chat; enabling asks for confirmation with a privacy warning |
| Save to global memory from this chat (`globalMemory.write`) | off | only a bot owner as the real sender; external senders, bot admins and group admins never write |

Stored configs without the field load with both off. Any Auto Reply config change aborts pending and in-flight
Auto Reply turns. `summarize_chat` in Auto Reply needs read.

### 10.3 Backup inclusion and restore evidence

| Data | Backup | Restore |
| --- | --- | --- |
| Plus message overrides (customizable template keys), presets, visibility | included | with settings; never deletes a value the backup lacks |
| Plus Auto Reply rules, incl. `globalMemory` | included when an account is paired | only after the same WhatsApp account pairs; never for another account |
| `plus:installation-key`, `plus:entitlement`, `plus:entitlement-hw`, every other `plus:*` | never | refused as damaged; never written |
| Any other `ext:*` key, `auth:*`, `secret:*`, secret settings | never | refused as damaged |
| Purchase tokens, verifier keys, RTDN and Google credentials | never on the device | n/a |

A crafted value that is not a plain JSON object within 64 KiB, depth 8 and 200 names per kind, or that holds
`__proto__`/`constructor`/`prototype`, is refused. Restore never activates Plus. The preview lists Plus changes.
Evidence: `tests/backup-plus.test.mjs` 128 checks; backup-activation 57, backup-create 105, backup-format 118,
backup-restore 344, backup-restore-merge 102, db-copy 150: all 0 failed.

### 10.4 Verifier and RTDN readiness

- Origin `https://levix-plus.leviro.net` in Core and the verifier; no DNS record, TLS certificate or deployment.
- RTDN: OIDC audience and email checked before parsing; idempotent by message id; every notification refetches
  Play state; versioned writes stop stale events; revocation is terminal; 401 for bad tokens, 503 for JWKS or
  storage failures (Pub/Sub retries), 204 when processed. Fixed: a well-formed Play notification of another kind
  returned 400 and would be redelivered forever; it is now acknowledged and ignored.
- `service/deploy/`: env template, hardened systemd unit, Caddy example, `DEPLOY.md` with least-privilege Google
  Cloud, Pub/Sub OIDC push and Play Console steps. Status: READY TO DEPLOY ON OWNER ACTION; nothing created.

### 10.5 Paid AAB pipeline readiness

- levix-plus `paid-aab.yml` builds public Core at `core.lock.json`, first a public `levix-app.zip` baseline
  (scanned by the public scanner), then the paid AAB with `LEVIX_EXTENSIONS_DIR`, a placeholder product id and a
  two-day throwaway key. `check-paid-aab.mjs` requires the paid zip to equal the baseline byte for byte plus only
  the manifest's runtime files, parses ZIPs strictly (central and local records), walks nested ZIP, gzip and tar
  members, and refuses service code, private keys and misplaced canaries. No artifact upload, no secret, no Play.
- Evidence: CI run 42889902273 (Core `007c5c5`): AAB 1,032 entries, `levix-app.zip` 4,545 entries, public
  baseline 4,539 entries scanned clean, 7 runtime files verified, AAB sha256 `b8f7e66b…0342b`, throwaway
  certificate SHA-256 `43:1F:51:63…68:36`. Script tests 79/79 locally.
- Status: NON-PRODUCTION PIPELINE READY. A production AAB needs the owner's upload key, Play App Signing and the
  real product id (`docs/PAID-BUILD.md`).

### 10.6 Legal, translations and Data safety

`docs/plans/v5/legal-drafts/`: Terms section and Privacy supplement in en, ar, pt-BR, es-419 and a Data safety
delta. Drafts only: not effective, not in `src/legal/bundled/` or `PRIVACY.md`; ar, pt-BR and es-419 are machine
drafts; no human legal review. They state the one-installation, three-moves-per-rolling-30-days policy before
purchase; the app shows no move counter and the purchase card links to the Terms. New pt-BR and es-419 panel
strings are machine drafts in `i18n/review.json`; the 14 Q-19 strings are untouched.

### 10.7 Public and paid build separation

Public builds ship no runtime, have an empty product id and an empty `TRUSTED_KEYS`, so fabricated tokens cannot
activate Plus, and the Plus tab is hidden. The artifact scanner passes on the SEA build directory (6 entries,
181.2 MiB) and the npm tarball (305 entries, 4.2 MiB). Free features need no verifier, runtime, network or
subscription and keep no cap.

### 10.8 Reviews and gates

| Check | Result |
| --- | --- |
| Independent Codex review (fresh session) of 08i to 08k and 08g/paid | 1 P1, 7 P2 |
| Fixes | `fd770d0`, `4f63270` (Core), `ee6b70b` (labels), `f445965`, `d004d26`, `ad2b120`, `3520d4e` (checker) |
| Codex verification, two rounds | all 8 FIXED, no new P1/P2 |
| `npm test` on the stack head | PASS 57,304 checks, 0 failed (before `4f63270`; rerun recorded in #164) |
| lint, i18n:check, docs:check, build:frontend | PASS (lint 231 warnings, base 230) |
| build:sea, validate:sea | PASS 51 checks |
| validate:tarball | NOT RUN locally (the workstation install hung on a dependency download); PASS in CI "package installs and boots" |
| Private tests with Core `02a3c17` | PASS 244 tests (verifier, runtime, interop, scripts), 0 skipped |
| Public CI on #161, #162, #163 | 7/7 each (heads before the last review fix; final runs in the PR checks) |

### 10.9 Owner actions still required (credentials, consoles, devices)

1. DNS and TLS for `levix-plus.leviro.net`; deploy the verifier per `service/deploy/DEPLOY.md`.
2. Generate the entitlement signing key and seal key offline; add the public key id to Core `TRUSTED_KEYS`.
3. Google Cloud: Play Developer API service account, Pub/Sub topic, publisher grant, push service account with
   OIDC; Play Console RTDN topic and "Send test notification".
4. Play Console: the Levix Plus subscription product and base plan, USD 0.99 and the Egypt price; license testers.
5. Upload key in a protected GitHub environment and Play App Signing for a production paid AAB.
6. Human legal review of the four-locale drafts, an effective date, and Data safety changes at release.
7. Decide D-08-9 (advertise Plus in Free builds or keep it hidden).
8. Device QA (purchase, pending, cancel, restore after reinstall, move denial, refund/revoke via RTDN) and
   WhatsApp test-account QA (Auto Reply with and without global memory, backup restore to the same and to
   another account).

Remaining blockers: production billing and live QA are BLOCKED on items 1 to 8. No security P1/P2 is open.

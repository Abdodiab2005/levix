# Phase 08: Levix Plus — audit, architecture and implementation plan

Status: `IN PROGRESS` (started 2026-11-10). Base: `release/5.0.0-beta.1` at `c2473be`
(Phase 07c and the six Phase 07.5 stabilization PRs #143, #146–#151 merged).
Nothing in this file is shipped behaviour until the PR that implements it merges.

Evidence labels follow ADR-014: `PASS`, `FAIL`, `NOT RUN`, `BLOCKED`.

## 1. Audit summary (2026-11-10)

Discovery ran as four read-only delegated runs (agy `gemini-4-argon-high` Core hook map,
agy `gemini-3.8-flash-high` Android map and Play Billing research, Codex `gpt-6.1-sol`
security map). Every finding below was spot-checked against the tree at `c2473be`.

### 1.1 External dependencies

| Dependency | State on 2026-11-10 | Consequence |
| --- | --- | --- |
| Private `levix-plus` repository | Did not exist. Created on the owner's instruction as `Abdodiab2005/levix-plus` (private, empty). | Plus runtime and the verification service live there. |
| `leviro-licensing` (private) | Exists. Product-agnostic license-key platform (LVR1 keys, Ed25519 installations, JWS leases, Whop/manual commerce). No Google Play adapter, no Levix product. | Not used. Owner: "you will create new private levix repo". |
| `levix-ui` (levix.leviro.net) | Hosts feedback, crash reports, recovery relay, Terms. No billing or entitlement endpoint. | Not the verifier host. |
| Leviro verification service | Does not exist. No URL, no deployment, no signing key. | `BLOCKED` for live verification. Service code is built and tested in `levix-plus` against a mocked Play API. |
| Play Console subscription product | Not readable from the repository or this workstation. Product id, base plan id, Egypt price, RTDN topic and service-account access are unknown. | `BLOCKED`. No product id is invented: the Android build reads it from a Gradle property that is empty in public builds. |
| Play Billing Library | Not declared in `android/`. Not in `~/.gradle` cache. Current stable `com.android.billingclient:billing-ktx:9.1.0` (2026-06-18, release notes page verified). PBL 7 is past its final cutoff; PBL 8/9 required. | Local offline Android build with billing is `BLOCKED` by the no-download rule. CI (authorized to download) builds it. |

### 1.2 Core facts that shape the design

- Bot replies: about 712 `bot.*` keys go through `t()` (`src/utils/i18n.cjs:39-65`). Only 2 call
  sites use `renderMessage()` (`src/handlers/command.handler.js:113,390`). A template override must
  hook `createTranslator`, not `setRenderHook`.
- Watermark: `message_watermark` is a Free operator setting, default `false`
  (`src/config/settings.cjs:143`); one call site, `stampWatermark` (`src/messaging/message.cjs:115`).
  Phase 09 owns the default. Phase 08 only adds the Plus hide hook.
- Progress: `reply_hide_progress` is Free (`src/utils/statusMessage.cjs:49`). Reply routing with
  per-command and per-category overrides is Free (`reply_route_overrides`,
  `src/messaging/router.cjs:32-40`). Plus must not take either away.
- Intake: `processMessage()` runs commands, then group moderation
  (`src/handlers/message.handler.js:136-157`). `fromMe` is not filtered at the top, so the owner can
  run commands. Own sends are in `recentMessageCache` (`src/core/socket.js:148`).
- AI: `resolveCaller()` mints a frozen caller with epoch and roster version
  (`src/services/aiToolAuth.cjs:64-109`); `authorize()` rechecks live authority
  (`:128-179`); `sendBotMessage(..., { signal, deliveryGuard })` asserts the guard with no `await`
  before the wire send (`src/core/socket.js:133-140`).
- Account boundary: `accountEpoch()` advances on logout, 401, `clearAccountScopedState()` and backup
  activation `replaceTables()` (`src/db/store.cjs:242-249`, `src/core/session.js:93-127,638,1214`,
  `src/backup/activation.cjs:120`).
- Crypto: Ed25519 envelope verification and the 16-hex `keyId` pattern exist for Terms
  (`src/legal/release.cjs:117`, `src/legal/keys.cjs`). No installation identity exists today;
  `levix.key` is a symmetric vault key (`src/config/vault.cjs:34`).
- Backups restore an allowlist of `bot_settings` keys only (`src/backup/content.cjs`), so new keys
  stay out of portable backups by default. Pre-migration copies keep every non-secret key
  (`src/db/copy.cjs:10`), so entitlement and installation keys must be added to `isSecretBotKey`.
- Debug-log redaction covers `purchaseToken` by name but not `entitlement` or
  `obfuscatedAccountId` (`src/diagnostics/debugLog.cjs:45`).
- Android: PanelBridge async calls return through `window.__levixHostDone(callId, json)`
  (`android/.../PanelActivity.kt:206`); native code reaches Node over the `panel.sock` unix socket
  (`PanelHttp.kt`). No flavors; `applicationId` `net.leviro.levix`, QA `.dev` suffix. versionCode 71.

## 2. Architecture

### 2.1 Components and dependency map

```
 Google Play  <---- Play Developer API (service account) ----  Leviro verifier (private levix-plus/service)
     ^                                                              ^        |
     | Billing Library 9.1.0                                         |        | Ed25519-signed entitlement
     |                                                               |        v
 Android app (public android/) --bridge--> React panel --HTTP--> Node Core (public src/extensions/)
   BillingHost, PanelBridge              Settings > Levix Plus      entitlement client + host
                                                                     |  loads at boot, activates on entitlement
                                                                     v
                                                     Plus runtime (private levix-plus/runtime),
                                                     bundled only in the paid Android artifact
```

- Public Core (`levix`): extension contract, host, Core hooks, installation identity,
  entitlement verification and refresh client, panel routes, React Plus screen, Android billing
  client, artifact leak scan. All of it is inert without the private runtime and a trusted key.
- Private runtime (`levix-plus/runtime`): message personalization, presets, watermark policy,
  prefix-free AI Auto Reply policy and its per-chat configuration (ADR-009).
- Private verifier (`levix-plus/service`): claim, refresh and RTDN endpoints, Play adapter,
  binding store, signer.
- Dependency direction: private runtime depends on the public contract version only. Core never
  imports private code by name; it loads one fixed optional path.

### 2.2 Repository boundary

| Item | Repository |
| --- | --- |
| `src/extensions/**`, Core hooks, routes, React Plus screen, Android `billing/` | public `levix` |
| Trusted entitlement public keys (empty until the owner generates a key) | public `levix` |
| Runtime code, verifier code, Play adapter, signer, deployment config | private `levix-plus` |
| Service-account JSON, entitlement signing private key, RTDN secrets | deployment secret store only, never a repository |
| Paid Android artifact (public sources + private runtime) | private CI pipeline (not built in this phase) |

Public artifacts (npm tarball, SEA, Docker image, GitHub release, AAB from public sources) never
contain `extensions/levix-plus/`. A CI scan enforces it (§6, slice 08e). Code shipped to a device
can be reverse engineered; repository privacy is not copy protection (ADR-002).

### 2.3 Distribution

ADR-003 forbids downloading executable code. The Plus runtime therefore ships inside the app.
Proposal (owner decision D-08-1): the Play listing receives an AAB built by a private pipeline
that stages `extensions/levix-plus/index.cjs` into `levix-app.zip` and sets the Gradle property
`levixPlusProductId`. Public builds keep both empty and show "Levix Plus is not included in this
build". Desktop, npm, SEA, Docker and self-hosted installs have no Plus in v5 (Q-20 (a)).

## 3. Public extension contract v1

### 3.1 Module shape

The optional module lives at `<asset root>/extensions/levix-plus/index.cjs`. It is loaded with
`module.createRequire` from that absolute path, inside `try`. Absent file = Free. It exports:

```js
module.exports = {
  apiVersion: 1,                    // must equal host API_VERSION
  id: "levix-plus",                 // /^[a-z][a-z0-9-]{1,31}$/
  version: "1.0.0",                 // semver
  requiresEntitlement: "plus",
  capabilities: ["templates", "watermark", "progress", "autoReply", "panelApi"], // subset
  async activate(ctx) { return { templates, watermark, progress, autoReply, panelApi }; },
  async deactivate(reason) {},      // "entitlement" | "disabled" | "shutdown" | "failure"
  onAccountReset(reason) {},        // "unlink" | "logged_out" | "restore" ; optional, sync
};
```

The host rejects a module whose `apiVersion` differs, whose id or version is malformed, or whose
handlers do not match the declared capabilities. Rejection leaves Core in Free state and logs one
warning without paths.

### 3.2 Host states

`absent` → `inactive` (module valid, no entitlement) → `active` → back to `inactive` on loss.
`incompatible` (bad manifest), `disabled` (operator switch `plus_enabled` off), `failed`
(circuit breaker). Every state except `active` behaves exactly like Free.

### 3.3 Lifecycle

- Boot: `bootstrapCore` loads the host after `session.recoverPendingUnlink()` and before
  `session.start()` (`src/bootstrap/core.js:86-100`). Loading never throws into boot.
- Activation: when the entitlement turns active and `plus_enabled` is on, the host creates an
  `AbortController`, increments its generation, calls `activate(ctx)` with a 5 s deadline, and
  validates the returned handlers.
- Deactivation (entitlement lost, switch off, failure, shutdown): abort the generation's signal
  first, then call `deactivate(reason)` with a 5 s deadline. In-flight Auto Reply jobs see the
  aborted signal and the generation check in the final-send guard.
- Account reset: `clearAccountScopedState()` and backup `replaceTables()` call
  `host.accountReset(reason)`. The host aborts account jobs, wipes `ctx.accountStorage`, and calls
  `onAccountReset`. Entitlement survives unlink (it belongs to the installation).
- Shutdown: `src/index.js` shutdown calls `host.stop()` before the session shuts down.

### 3.4 Context (`ctx`) given to `activate`

Frozen, built per generation, holds only what declared capabilities need:

| Field | Capability | Purpose |
| --- | --- | --- |
| `apiVersion`, `signal`, `generation` | all | contract version, abort on deactivation |
| `log` | all | child logger; messages pass the debug-log sanitizer |
| `storage.get/set/delete(name)` | all | JSON values (≤ 64 KiB each, ≤ 200 names) under `bot_settings` `ext:<id>:cfg:<name>`; operator data, kept through unlink |
| `accountStorage.get/set/delete(name)` | `autoReply` | same under `ext:<id>:acct:<name>`, wiped on account reset |
| `i18n.locales`, `i18n.isCustomizable(key)`, `i18n.catalogTemplate(key, locale)`, `i18n.placeholders(key)`, `i18n.customizableKeys()` | `templates` | read-only catalog view |
| `translate(text, targetLocale)` | `templates` | Core's existing `!translate` Google path with placeholder shielding; resolves `{ text }` or `{ error }` |
| `ai.reply(job)` | `autoReply` | Core-owned AI turn for the real sender (§3.6) |
| `linkedAccount()` | `autoReply` | `{ lid, phone }` of the paired account or `null`, from `messaging/identity.cjs` |

No raw socket, no store module, no settings writer, no `require` of Core internals.

### 3.5 Hooks Core calls

| Hook | Call site | Contract | Fallback |
| --- | --- | --- | --- |
| `templates.resolve(key, locale)` → string or null | `createTranslator` in `src/utils/i18n.cjs`, `bot.*` keys only, non-plural values only | Sync. Core rejects a result that is not a string, exceeds 1000 chars, contains control or bidi-override characters, or uses a placeholder the catalog entry for that key does not have. Params are escaped with `escapeParam` on this path. | catalog text |
| `watermark.hide({ command, category })` → boolean | `stampWatermark` | Sync. Consulted only while active. | Free behaviour |
| `progress.hide({ command })` → boolean | `statusMessage` progress path | Sync. Only hideable progress lines; results, errors and security text never hidden. | Free behaviour |
| `autoReply.scope()` → iterable of chat JIDs | host, cached per generation, refreshed by `ctx`-side `invalidateScope()` | Core forwards a message only for a chat in scope. | no forwarding |
| `autoReply.consider(event, { signal })` → `{ reply: boolean, instructions?, quote? }` | end of `processMessage()` | Async, 2 s deadline. `instructions` ≤ 1000 chars, appended as chat instruction, never as system identity. | no reply |
| `panelApi.handle(method, path, body, { signal })` → `{ status, body }` | `/dashboard/api/plus/ext/*` | Behind panel auth and same-origin checks; JSON only, body ≤ 64 KiB, 10 s deadline; only while active. | 404 / 409 |

Customizable keys: `src/extensions/templateKeys.cjs` owns the allowlist. Areas `ai`, `core`
(`status`, `restart`, `stopbot` progress and results), `schedules`, `stickers`, `tools`, `help`,
`group` (non-moderation) are allowed. Denied always: the whole `moderation` area, `bot.core.message.*`
(watermark, routing refusals), and any key matching
`/owner(Only)?|noPermission|denied|forbidden|notAllowed|permission|security|password|reset|consent|legal|terms|privacy|route|unauthori|blocked|warn|kick|ban|flag|limit/i`.
Tests pin both lists.

### 3.6 Auto Reply intake and the Core AI capability

Core forwards a message to `autoReply.consider` only when all hold: host `active`; capability
declared; `!wasCommand`; group moderation did not act; `msg.key.fromMe === false`; not in
`recentMessageCache`; sender is not the linked account (`isSelf`); no `botMetadata`; chat is in
`scope()`; `accountEpoch()` unchanged; text or caption present (≤ 4000 chars). Status, broadcast and
newsletter chats are already dropped earlier. The event is frozen:
`{ chatJid, isGroup, sender: { primary, candidates }, text, messageId, timestamp, mentionsMe, quotesMe }`.
Nothing else from the message is passed, and Core keeps no copy.

`ctx.ai.reply({ messageId, instructions, quote })` runs only for an event Core forwarded in the
same generation (Core keeps the original message in a bounded map: 50 entries, 2 minutes). Core
then: fetches fresh group metadata, mints the caller with `resolveCaller` for the real sender,
runs `runAgent` with a signal bounded by `ai_tool_timeout_ms` (≤ 120 s) and with global memory
excluded unless the chat is the owner's own private chat (Q-09 (b), applied to Auto Reply only),
and sends the answer to the source chat only with `sendBotMessage(..., { signal, deliveryGuard })`.
The guard refreshes and asserts: same account epoch, same host generation, host still `active`,
roster not stale. Core backstop limits regardless of the extension: 2 concurrent turns globally, 1
per chat, 6 per chat per minute, 30 per minute globally. A refused or failed turn sends nothing.

### 3.7 Failure isolation

Every hook call is wrapped. Sync hooks: an exception returns the Free result. Async hooks: deadline
plus exception handling. 5 failures within 60 s move the host to `failed` and deactivate the
extension until restart or the operator toggles `plus_enabled`. The extension can never stop a
command, moderation, scheduling, media tools or reactions from running.

## 4. Entitlement and billing security design

### 4.1 Installation identity

Ed25519 keypair created on first claim (never for Free installs). Private key sealed with
`vault.cjs` in `bot_settings` `plus:installation-key`. `installationId` = base64url(SHA-256(raw
public key)), 43 characters, no personal data; it is the Play `obfuscatedAccountId`. Excluded from
settings export, portable backups, pre-migration copies (`isSecretBotKey`) and logs. A restore on a
new device creates a new installation, which then restores the purchase (§4.4).

### 4.2 Entitlement token

Compact JWS, EdDSA, header `{ alg: "EdDSA", typ: "levix-ent+jwt", kid }`. `kid` = first 16 hex of
SHA-256(raw public key), pinned in `src/extensions/entitlement/keys.cjs` (`TRUSTED_KEYS`, empty
until the owner generates the production key, so nothing verifies and Plus never activates).
Claims: `iss` `levix-plus-verifier`, `aud` `levix-core`, `sub` installationId, `ent` `["plus"]`,
`st` (`active` | `grace` | `canceled` | `inactive`), `rsn` (reason when inactive), `iat`, `exp`,
`seq` (monotonic per installation), `jti`. Size ≤ 4 KiB.

Core accepts a token only if: structure, header and `kid` exact; signature verifies; `iss`, `aud`,
`sub` equal; `seq` greater than the stored `seq` (or equal with the same `jti`); time checks pass.
An `inactive` token with a higher `seq` turns Plus off immediately (refund, revoke, rebind).

### 4.3 Time and cache

Stored record `plus:entitlement`: token, `seq`, `serverOffset` (server `iat` minus local time at
receipt), `highWater` (largest trusted time seen). Trusted now = local now + `serverOffset`.
Active only if `iat - 5 min ≤ trustedNow < exp` and `trustedNow ≥ highWater - 5 min`. A clock moved
backwards past the high-water mark turns paid features off until the next successful refresh.
The server sets `exp` to at most 72 h after `iat` and never past the Play `expiryTime`; grace-period
tokens at most 24 h. Offline beyond `exp` disables paid capabilities; Core is untouched.

### 4.4 Claim, refresh, restore, binding

- Claim: Android `PURCHASED` purchase → panel → `POST /dashboard/api/plus/claim`
  `{ purchaseToken, productId, packageName }` (panel session, same-origin, ≤ 4 KiB) → Core signs
  `POST /v1/claim` with the installation key → verifier.
- Signed request (wire contract v1, §4.7): Ed25519 over canonical JSON `{ aud:
  "levix-plus-verifier", bodySha256, installation, method, nonce (16 random bytes), path, ts }`;
  headers `x-levix-installation`, `x-levix-key` (claim only), `x-levix-nonce`,
  `x-levix-timestamp`, `x-levix-signature`. Verifier rejects `|ts - now| > 5 min` and a reused nonce
  (stored 10 min).
- Verifier: `subscriptionsv2.get`; check `packageName`, product id in the configured set,
  state, `expiryTime`, `testPurchase` (refused unless the deployment allows test purchases);
  first binding requires `obfuscatedExternalAccountId === installationId`; acknowledge server-side
  when `ACKNOWLEDGEMENT_STATE_PENDING`, after the binding is stored; return a token.
- One active installation per purchase token. A claim from another installation (restore, new
  phone) moves the binding; the old installation gets an `inactive` token (`rsn: "rebound"`) at
  its next refresh. At most 3 moves per token per 30 days (D-08-3).
- Refresh: signed `POST /v1/refresh` `{ seq }` (the installation is in the signed envelope and
  header) every 12 h with jitter, first one
  60 s after boot only if a record exists. Backoff 1 min, 5 min, 15 min, 1 h, 6 h cap; single
  flight; response ≤ 16 KiB; 10 s timeout; HTTPS fixed origin, no redirects, DNS pinned through
  `safeProviderFetch`.
- RTDN (Pub/Sub push, authenticated) updates the verifier's cached state; the client sees the
  change at the next refresh or on demand.

States: `ACTIVE` → active; `CANCELED` before `expiryTime` → active (`st: canceled`);
`IN_GRACE_PERIOD` → active (`st: grace`, short `exp`); `ON_HOLD`, `PAUSED`, `EXPIRED`, `PENDING`,
voided or revoked → `inactive`. The client never trusts a local purchase state or a boolean.

### 4.7 Wire contract v1 (Core client and verifier)

The exact contract both sides implement is kept verbatim in the private `levix-plus/service/README.md`
and in the Core client tests. Summary: origin `https://plus.leviro.net` (D-08-2); `POST /v1/claim`
body `{ purchaseToken, productId, packageName }`; `POST /v1/refresh` body `{ seq }`; every Play
outcome answers 200 `{ token }` (not entitled = `st: "inactive"`); request problems answer
`{ error: { code, retryable } }` with codes `BAD_REQUEST`, `BAD_SIGNATURE`, `STALE_TIMESTAMP`,
`REPLAY`, `UNKNOWN_INSTALLATION`, `PURCHASE_INVALID`, `TEST_PURCHASE_REFUSED`, `ACCOUNT_MISMATCH`,
`REBIND_LIMIT`, `RATE_LIMITED`, `UNAVAILABLE`. Token header `{ alg: "EdDSA", kid, typ:
"levix-ent+jwt" }`; payload `iss`, `aud`, `sub`, `ent`, `st`, `rsn`, `iat`, `exp`, `seq`, `jti`,
`pexp` (seconds). Entitled `exp` = `min(iat + TTL, pexp + allowance)`: active 72 h + 2 h renewal
allowance, canceled 72 h, grace 24 h, never past `pexp` otherwise.

### 4.5 What the verifier stores (for PRIVACY.md and Data safety, before release)

Installation id and public key; SHA-256 of each purchase token plus the token sealed with a
service key (needed to call Play); product id, state, expiry, acknowledgement; binding history
(installation ids, timestamps, move count); used nonces for 10 minutes; RTDN message ids for 7
days. No WhatsApp data, phone number, email, IP address in storage (IP only in transient rate
limiting). Retention: rows deleted 90 days after subscription expiry or on support request.

### 4.6 Threat model

| Threat | Control |
| --- | --- |
| Forged or wrong-product purchase | Server-side `subscriptionsv2.get`, package and product allowlist, state and expiry checks |
| Client says "purchased" | Core ignores client state; only a verifier-signed token activates |
| Token replay to other installations | One binding per token, `obfuscatedAccountId` on first bind, bounded moves |
| Signed request replay | Nonce store, 5-minute window, signature covers method, path, body hash, audience |
| Entitlement copied to another install | `sub` must equal the local installation id; private key never exported |
| Older active token replayed after revoke | Monotonic `seq`; signed `inactive` token |
| Clock rollback | Server offset, high-water mark, short `exp` |
| Refund or revoke during outage | `exp` ≤ 72 h, ≤ 24 h in grace; RTDN plus refresh |
| DNS rebinding, redirects | Fixed HTTPS origin, `safeProviderFetch`, `redirect: "manual"` refused |
| Log or backup leakage | `isSecretBotKey`, debug-log key regex gains `entitlement`, `obfuscated`, `installation` |
| Relink inherits Auto Reply config | Account storage wiped on reset, epoch checked before every send |
| Auto Reply privilege escalation | `resolveCaller` for the real sender, `aiToolAuth` for every tool, same-chat delivery |
| Self-reply loop | `fromMe`, `recentMessageCache`, `isSelf`, `botMetadata` checks, Core rate backstop |
| Patched Core | Not preventable on an owner-controlled device; server operations stay protected |
| Billing or verifier outage | Paid capabilities fail closed; Core never waits on billing |

## 5. Owner decisions (open)

| Id | Question | Recommendation |
| --- | --- | --- |
| D-08-1 | Paid artifact: Play AAB built by a private pipeline that adds the runtime? | Yes; public builds stay Free |
| D-08-2 | Verifier host name and deployment (VPS beside levix.leviro.net?) | `https://plus.leviro.net`, owner deploys |
| D-08-3 | Rebind policy: one active installation, 3 moves per 30 days | Accept |
| D-08-4 | Play product id and base plan id (Play Console), Egypt price | Owner creates; read from Play, not assumed |
| D-08-5 | Entitlement signing key generation and custody | Owner generates offline like the Terms key |
| D-08-6 | Plus customizations in backups (v1 excludes `ext:*`) | Exclude in v1, revisit |
| D-08-7 | Q-09: global memory in Auto Reply prompts | (b) owner's own chat only, Auto Reply path |
| D-08-8 | RTDN: Pub/Sub topic and push auth | Owner creates in Google Cloud |

## 6. Implementation stages

| Slice | Repo | Content | Implementer | Gate |
| --- | --- | --- | --- | --- |
| 08-0 | public | this plan, interface stubs, PHASES status | orchestrator | review |
| 08a | public | `src/extensions/` contract, loader, host, ctx, Core hooks (i18n, watermark, progress, intake, AI reply capability, account reset, panel mount), `plus_enabled` setting, fake-extension tests | Grok | npm test, lint |
| 08b | public | installation identity, token verifier, time and cache, signed client, refresh scheduler, `/dashboard/api/plus/{status,claim,refresh}`, redaction and copy exclusions, tests | agy Argon | npm test, lint |
| 08c | public | Android `billing/` (PBL 9.1.0), PanelBridge methods, `hostBridge.ts`, Settings > Levix Plus screen, i18n × 4 | agy Argon / Grok | Android CI, frontend build, i18n check |
| 08d | private | verifier service: claim, refresh, RTDN, Play adapter interface plus mock, binding store, signer, tests | Grok | service tests |
| 08e | public | artifact leak scan in CI (npm, SEA, zip, Docker) and canary test | agy Flash | CI |
| 08f | private | runtime: templates with Auto Translate and Original Everywhere, presets, watermark, Auto Reply policy (allowlists, triggers, debounce, budgets, loop guard, kill switch), contract tests against public host | Grok / agy Argon | runtime tests |
| 08g | public | PRIVACY.md, Data safety mapping, PHASES and results | orchestrator | review |

Codex (`gpt-6.1-sol`) reviews every slice read-only. Delegated implementers do not run tests or
builds; the orchestrator runs every gate.

## 7. Test plan

Public (deterministic, no network, fake extension and fake verifier):
Free Core with no module; module present but no entitlement; incompatible, throwing and slow
modules; circuit breaker; operator switch; entitlement missing, bad signature, unknown `kid`,
wrong `aud`, wrong `sub` (other installation), lower `seq` replay, expired, clock rollback,
`inactive` token, verifier 5xx, timeout, redirect, oversized body; concurrent refresh single flight;
unlink and restore during an Auto Reply job; entitlement revoked during a job (no send); group admin
demoted during a job (tool refused); loop guards; rate limits; template placeholders in four
locales; denied keys; backup and copy exclusion; redaction; Reaction Automation unaffected.

Private: verifier state mapping for every `subscriptionState`, test purchase refusal, wrong
package or product, obfuscated id mismatch, rebind limits, nonce replay, RTDN idempotency,
acknowledge once; runtime contract tests against the public host at a pinned commit.

Not covered by automated tests (manual QA required): real Play purchase with a license tester,
real RTDN delivery, real WhatsApp Auto Reply on a paired test account, device lifecycle.

## 8. Rollback

Turn `plus_enabled` off or ship without the runtime: Core returns to Free behaviour. No schema
migration is added (all state lives in `bot_settings` keys), so a downgrade needs no restore.
The verifier can be stopped without affecting any Free install.

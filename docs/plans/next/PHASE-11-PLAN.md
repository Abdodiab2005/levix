# Phase 11A — connected WhatsApp account card

Status: IMPLEMENTING, owner authorized 2026-11-11 after Phase 09 application
code passed CI. This work is on `feat/next-account-card`, based on
`next/5.1.0` at `40051f6` (final Phase 09 evidence; application code
unchanged from the fully tested `3fb7513`). It must never target the v5.0 release branch.
Phase 10 remains the mandatory v5.0.0 audit/release gate. No version bump.

## Current-tree audit

- The authenticated dashboard already exposes connection state and local
  `socket.user` name/id. ConnectionView shows only a bare number and connection
  controls; its direct id splitting can display a LID as a phone number.
- The session manager exclusively owns sockets. Routes receive the current
  socket through `setSession`; `getState()` reports connectivity. The store's
  `accountEpoch()` advances on account boundaries. Use these existing facts to
  discard work that finishes after disconnect, reconnect or unlink.
- `linkedIdentity()` uses verified paired credentials. Phone formatting must
  accept only phone-number JIDs, never a LID or a number typed in Settings.
- Baileys v7 rc14 `fetchStatus(...jids)` returns a USync result array whose
  matching entry contains `status.status`. `profilePictureUrl(jid,"image",8000)`
  returns an expiring URL. Both are live network queries; stats polling must not
  call either.
- The group-photo route already proxies images through `fetchWhatsAppImage`,
  which enforces WhatsApp HTTPS hosts, DNS/private-network validation and the
  current WhatsApp proxy. Reuse it. Never put a remote image URL in the browser:
  Android's privileged WebView blocks remote resources.
- The design system already has Avatar, UserText, Card, CardHeader,
  StatusPill and refresh IconButton. No new dependency or Plus gate is needed.

## Scope and acceptance

1. A Free account card on Connection shows profile picture, display name,
   verified phone number, About and current connection status. Missing/private
   fields use translated neutral placeholders. No LID is shown as a phone.
2. Opening Connection may load only the connected account's own profile.
   Cache About/photo lookup and negative results in RAM for five minutes;
   coalesce concurrent calls. An explicit refresh has a short ten-second
   cooldown. No stats/socket poll or closed screen triggers a profile query.
3. Photo bytes load lazily through an authenticated same-origin endpoint,
   using only the server-selected account's URL. Bound body size to 1 MiB,
   MIME to JPEG/PNG/WebP and the total wait to eight seconds. No SVG, arbitrary
   JID/URL input, redirect following, public avatar URL or disk cache.
4. Socket reference, normalized identity and account epoch guard every cache
   and response. Disconnect/reconnect/unlink clears the visible profile and
   prevents stale results/images from becoming the next account's data. A photo
   request carries an opaque revision, never an account identifier.
5. UI requests ignore late responses after state/identity change or unmount;
   refresh is accessible and does not disturb session controls. Four canonical
   translations, RTL/LTR and light/dark work with existing primitives.

## Files, migration and privacy

- New `src/panel/account-profile.cjs`: bounded RAM cache, own identity/status
  normalization and generation guards; test dependencies injected at creation.
- `src/routes/dashboard.api.esm.js`: authenticated GET `/account/profile`, POST
  `/account/profile/refresh`, GET `/account/photo?revision=...`; session/epoch and
  existing image fetch are wired here. No socket lifecycle changes.
- New `tests/account-profile.test.mjs`, `tests/account-profile-panel.test.mjs`:
  fakes, isolated data, auth/CSRF, no production endpoint or account.
- New `frontend/src/views/ConnectedAccountCard.tsx`; ConnectionView replaces the
  number-only block with the card. Existing session actions stay intact.
- Expose the already-existing session `since` field in the frontend type and
  use it to scope same-account reconnects. Extend Avatar's existing fallback
  to accept an absent source without issuing an empty image request.
- Four `i18n/*/dashboard.json`, generated translations, review hashes; focused
  public documentation and `PHASE-11-RESULTS.md` after implementation.

No migration, new setting, pairing modification, backup/export change, paid
feature, AI integration, chat send or disk persistence. The only recipient is
the existing WhatsApp service when loading the account's own profile. Auth/CSRF
and no-store headers remain mandatory. Core works when lookups fail or offline.

## Proof, independent review and rollback

Orchestrator runs focused fake-socket/cache/identity/cancellation/photo tests,
real authenticated route tests, full `npm test`, lint, frontend build and
i18n/docs checks; then the full existing CI matrix. Browser fixtures cover
connected, private/missing, disconnected, refresh and stale-response cases in
four locales. No live pairing or production request in automated QA.

Delegates edit only named files and run no tests/builds; the orchestrator owns
every gate and diff review. Independently review the finished card before PR.
Rollback the new UI and routes/service together; there is no stored data to
migrate back. PR targets `next/5.1.0` only. Phase 11 does not delay v5.0.0.

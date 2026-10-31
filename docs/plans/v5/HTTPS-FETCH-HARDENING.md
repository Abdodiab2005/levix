# HTTPS fetch hardening follow-up

Scope: the owner-approved transport fix after Phases 01/02; Phase 03 does not start.
Baseline: `c5040a5`. Date: 2026-11-01.

## Audit and plan (before implementation)

- `src/utils/thumbnail.cjs` uses Axios with automatic redirects and accepts HTTP.
- `src/core/socket.js` leaves opted-in text previews to Baileys. rc14's preview
  fetches pages and images internally without a transport-policy hook; its media
  `getHttpStream` also follows redirects and ignores a caller's `redirect` option.
- Current command send paths use local files/buffers, but the socket also accepts
  remote media URLs. A rejected optional thumbnail must not leave an unsafe URL
  for Baileys to download when sending the actual media.
- Add a shared HTTPS-only, DNS-pinned, bounded download helper using the existing
  `providerUrl.cjs` boundary with loopback disabled. Validate each redirect, cancel
  unused bodies, keep one timeout across the chain, cap decoded bytes.
- Route remote thumbnails and outbound media URL downloads through that helper.
  Give Baileys buffers, never unchecked remote media URLs. Keep local files,
  streams and buffers supported. Reuse existing remote size/time settings.
- Override Baileys's `getUrlInfo` per send with a Levix-owned HTTPS-only preview
  implementation. Keep previews opt-in and explicit previews/null supported.
  Fetch page metadata and optional image through the same boundary. Failure skips
  the preview, without blocking the text message or falling back to unsafe fetches.
- Files: new `src/utils/httpsFetch.cjs`, `src/utils/linkPreview.cjs`; update
  `src/core/socket.js`, `src/utils/thumbnail.cjs`; focused regression tests;
  transport documentation in `PRIVACY.md` and this report.
- No dependency, schema, auth, pairing, release, or settings-default change.
- Threats: HTTP entry URLs and downgrade redirects, SSRF/private DNS destinations,
  oversized/slow responses, preview-image URLs, implicit Baileys fallback fetches.
- Privacy impact: removes cleartext optional page/media requests; does not claim
  a complete app-wide transit audit or change the Play Console.
- Compatibility: Node 24, npm/SEA/Docker/Android use the same helpers. A remote
  media URL must be HTTPS and fit the existing configurable remote byte/time
  limits. Unsafe optional previews are omitted; unsafe actual media sends fail.
- Rollback: revert this focused PR. Existing stored data is unchanged.

## Acceptance and validation

- Mock transports only; no real WhatsApp, production endpoint or device tests.
- Cover HTTP refusal before dispatch, HTTPS success/relative redirects, HTTPS to
  HTTP/private redirects, image URLs, size limits, cancellation/timeouts, opt-in
  gates, explicit previews, final socket options and sending text after failure.
- Run focused tests, full `npm test`, lint, frontend build. Let existing PR CI
  validate packaging and Android builds. Record actual outcomes below.

## Local results

Platform: Linux x64, Node v24.22.1 (managed runtime; CI uses the repository's
pinned v24.22.2). Date: 2026-11-01. Baseline: `c5040a5`; implementation is the
commit containing this report.

| Gate | Result | Evidence |
| --- | --- | --- |
| `node tests/run.mjs https-fetch` | PASS | 83 checks, 0 failures; fake transports only |
| `node tests/run.mjs low-data` | PASS | 28 checks, 0 failures |
| `node tests/run.mjs photo-proxy` | PASS | 28 checks, 0 failures |
| `npm run lint` | PASS | Exit 0; existing warnings and Biome schema/deprecation notices remain |
| `npm run build:frontend` | PASS | TypeScript and Vite build complete; existing chunk-size warning |
| `git diff --check` | PASS | No whitespace errors |
| `npm test` | BLOCKED by this host | Android initial-state assertions fail because binding `panel.sock` returns `EPERM`; `headless` and `setup-boundary` crash because `os.networkInterfaces()` returns `ERR_SYSTEM_ERROR` / `uv_interface_addresses`. All three reproduce on the untouched baseline in a separate worktree with the same dependencies. These are not recorded as passes. |
| Packaging / Android builds | NOT RUN locally | Existing PR CI is authoritative |
| Live WhatsApp, device QA, manual desktop restore | NOT RUN | Outside this task; no account paired |
| Play Console / publishing | NOT RUN | Deferred until v5.0.0 is complete |

The HTTPS helper also bounds DNS waiting and cancels a late response after its
deadline. New tests cover this cleanup and successful public cross-host HTTPS
redirects. Metadata extraction is intentionally bounded, reads common title,
description and image tags, and does not execute page scripts.

## Remaining audit boundary

This change covers outgoing text previews, standalone remote thumbnails and
remote media supplied to `sock.sendMessage`. It does not certify all other
network clients (including WhatsApp's incoming encrypted-media client, external
service SDKs, local AI endpoints or the panel). The final release transit audit
still needs to review those paths and the Google Play answer. Existing public
provider HTTPS rules and explicitly supported local AI/panel connections remain.

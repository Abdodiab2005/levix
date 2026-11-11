# Phase 11A results — connected WhatsApp account card

Status: CODE-READY, pending owner review, 2026-11-11. All automated gates pass;
manual dedicated-device/old-WebView QA remains NOT RUN. Scope is only
item A of the owner's Phase 11 request. Base `40051f6` on `next/5.1.0`;
implementation branch `feat/next-account-card`. Never targets the v5.0 release.

## Behavior and boundaries

The Free Connection screen now shows the connected account's picture, display
name, verified phone number, About and status. Private/missing fields use
four-language placeholders. The old JID-splitting number block is removed; a
LID cannot be shown as a phone number. All existing session actions remain.

The panel service reads only server-derived self identity. It coalesces and
caches profile lookups for five minutes and limits explicit refreshes to ten
seconds. Stats polling and closed screens perform no profile query. Pictures
load lazily through an authenticated local endpoint with an opaque revision,
a 1 MiB bound, JPEG/PNG/WebP MIME restriction and an eight-second deadline.
Existing HTTPS/DNS/private-network checks and the WhatsApp proxy are reused.
No remote photo URL reaches the browser or Android WebView.

Socket, identity, epoch and generation guards prevent stale data from reaching
the next account. Superseded metadata returns empty fields; the UI scopes data
to account id plus the existing session `since`, including same-account
reconnects. No migration, setting, private Plus code, backup-format change,
disk profile cache, AI transfer, chat send, release/version bump or live pairing.

## Independent review and corrections

Separate Codex reviews covered backend and frontend. Confirmed issues were
fixed: negative photo failures bypassing cache; cleanup outliving the request
deadline; permissive PN/LID predicates; borrowed current-account fields in an
old response; same-account reconnects retaining the previous view. Backend and
frontend re-reviews report no remaining material findings. Targeted Portuguese
and Spanish semantic review found no material error (machine review only).

OpenCode `deepseek-v4.1-flash-free` produced the backend and test fixtures. The
orchestrator stopped the delegate after files were produced, reviewed/fixed the
integration, and ran every gate. No delegate ran a build or test. Phase 09 used
agy Gemini and OpenCode Free; no Grok implementation was used.

## Evidence — Linux x64, 2026-11-11

Local Node is the already cached 24.22.2 binary. These initial local results
are from the Phase 11 worktree based on `40051f6`; exact commit/CI records are
appended after the final commit. No dependency/tool/artifact download occurred.

| Result | Command / scope | Evidence |
| --- | --- | --- |
| PASS | `node tests/run.mjs account-profile` | 214 checks: 134 fake service + 80 real authenticated/CSRF panel; `/tmp/levix-phase11-profile.log` |
| PASS | `node docs/plans/next/evidence/phase11/browser-qa.mjs /tmp/levix-ui-qa/node_modules/playwright/index.mjs` | 19 browser checks, four locales, desktop/phone, light/dark; `/tmp/levix-phase11-browser.log`; screenshots in `evidence/phase11/` |
| PASS | `npm run build:frontend` | `/tmp/levix-phase11-frontend.log`; existing chunk-size warning |
| PASS | `npm run lint` | zero errors; `/tmp/levix-phase11-lint.log`; focused new-code lint also passes |
| PASS | `npm run i18n:check`; `npm run docs:check` | `/tmp/levix-phase11-i18n.log`, `/tmp/levix-phase11-docs-check.log` |
| PASS | `npm test`, Linux x64, Node 24.22.2, code commit `cb0add4e47931c26ff923d5d2bb5ffa6e8a85344`, 2026-11-11 | 57878 checks, 0 failed, 0 crashed, 204.5 s; `/tmp/levix-phase11-full-tests.log` |
| PASS | full CI [43101826791](https://github.com/Abdodiab2005/levix/actions/runs/43101826791), same code commit, 2026-11-11 | tests, lint/i18n/docs, npm install/boot, Docker persistence, SEA Linux/macOS/Windows, Android unit/debug/release both-ABI APKs/AAB and public artifact scans |
| PASS | `npm pack --offline --ignore-scripts` then public artifact scan, same code commit, Linux x64, 2026-11-11 | 309-entry tarball; `/tmp/levix-phase11-scan.log`; no download or private Plus runtime |
| NOT RUN | live dedicated-account/device and oldest-supported-WebView QA | No real WhatsApp number or pairing authorized/used; browser/socket/image fakes only |

The browser proof includes no reads on Overview, one cached photo/lookup across
locale reloads, explicit refresh, private fields, disconnect clearing, delayed
A response after B, reconnect without an intermediate state, no browser errors
and no horizontal overflow. Images/names/numbers are synthetic fixtures.

## Release and rollback

PR targets `next/5.1.0` only. Phase 09 PR #166 then #167 remain the v5 merge
order; Phase 10 remains mandatory before any v5.0.0 release. Phase 11 must not
enter or delay that branch. Reverting the card and its routes/service removes
the feature without migrating data. No merge, tag, deploy or publication.

## Pull request and merge order

[Phase 11A PR #168](https://github.com/Abdodiab2005/levix/pull/168) targets
`next/5.1.0`, not the v5.0 release branch. Code commit:
`cb0add4e47931c26ff923d5d2bb5ffa6e8a85344`. The following evidence-only commit
does not alter application behavior; its final checks are visible on the PR.

Recommended v5 order: #166, then retarget and merge #167. Independently review
#168 for the next release; never merge it into v5.0. Phase 10 remains mandatory.
No PR was merged, and nothing was tagged, deployed, published or uploaded.

Persistent local checkout:
`/home/abdo/Documents/levix-wt/p11-account-card`. The original temporary
checkout remains detached at the tested code commit; no user work was removed.

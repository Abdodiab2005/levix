# Phase 07.5: Architecture Stabilization Results

Status: **READY FOR OWNER MERGE REVIEW.** Nothing is merged, released, deployed or uploaded.
Phase 08 does not start without the owner's approval.

Two different pieces of work carry the "07.5" number:

- **Group E2EE incident remediation** (2026-11-07/08): the group "Waiting for this message" fix
  (roster refresh, retry cache, key-store errors, session fence). Implemented, tested on the
  owner's devices, merged into `release/5.0.0-beta.1` (#137 to #142). Records:
  `PHASE-07.5-GROUP-E2EE-REPORT.md`, `PHASE-07.5-E2EE-REMEDIATION-RESULTS.md`,
  `PHASE-07.5-ANDROID-DEVICE-QA-RESULTS.md`. Miguel's original group still needs its own
  confirmation. This phase does not reopen that work; it preserves it.
- **Architecture stabilization** (this document, 2026-11-09): the milestone planned in
  `PHASES.md` as "07.5 stabilization (proposed)". Behavior-preserving fixes of proven defects at
  the messaging, AI tool, automation, lifecycle and logging boundaries. No feature, no migration,
  no dependency change, no Baileys change, no change to Signal keys, credentials or
  sender-key-memory.

## 1. Baseline and method

- Baseline: `feat/v5-phase-07c` at `31ef4f9` (PR #143 head, on `release/5.0.0-beta.1` `ba7ef44`).
  `npm test` 13380 checks, 0 failed (Linux, Node v24.22.2, 2026-11-09).
- Four read-only audits, one per area, each by a different agent: A messaging (OpenAI Codex),
  B AI tools and media (Antigravity Gemini Flash), C reaction automation (OpenCode
  deepseek-v4.1-flash), D persistence and diagnostics (Grok). The orchestrator re-read every
  cited path before accepting a finding.
- One debate round: Codex challenged the merged matrix (23 rows). Accepted challenges changed
  the design of A-1, A-2, A-3/D-1, A-4, A-5, B-1, B-2, C-2, C-3, D-2, D-4 and added N-1 to N-3.
  Disagreements are listed in section 4.
- Implementation by delegated agents, one worktree each; the orchestrator ran every gate and
  reviewed every diff.

## 2. Findings matrix

Severity: P1 security or correctness defect reachable in normal use; P2 real defect in an edge
path, or a duplication that already drifted; P3 maintainability.

| ID | Sev | Location | Evidence | Impact | Fix | Regression risk | Decision |
|---|---|---|---|---|---|---|---|
| A-1 | P1 | `src/commands/listschedules.cjs`, `deleteschedule.cjs` | Listed every pending job with its text in any chat; deleted any job by id. Default `ADMINS_OWNER`. | A group admin read the owner's private reminders in a group and deleted them. | Act only on jobs whose target is the current chat; foreign id answers like unknown; `bot_timezone` for times. | Cross-chat listing outside the panel is gone (narrows). | Fixed, 07.5a |
| A-4 | P1 | `schedule.cjs`, `autoschedule.cjs`, `scheduler.cjs:scheduleNewJob` | The job kept the per-command reply proxy until the next reconnect. | Reminder routed as a command result; for the owner's command it edited the `!schedule` message instead of sending (no notification). | Delivery always through the scheduler's live raw socket, captured once per attempt. | Pre-reconnect reminders now behave like post-reconnect ones. | Fixed, 07.5a |
| A-2 | P2 | `src/services/aiToolAuth.cjs` | Role flags frozen at message time. | A role revoked while the model thinks still authorized `grant_role`, global memory, etc. | Live roster roles for the frozen identity; group admin from the cache, else the message-time snapshot, denied while the roster is marked stale; recheck before deferred effects. | Pending tool calls can be denied after a revoke (intended). | Fixed, 07.5c |
| A-3 / D-1 | P2 | `src/core/session.js`, `events.js`, message handler, moderation, auto-delete, scheduler, AI | Old socket listeners stayed attached; in-flight work wrote after unlink or restore. | Old account's history, memory, moderation or metadata could reappear after unlink (gotcha 26). | Account epoch advanced synchronously at logout, logged-out and activation; exact-listener disposer per socket; late-write guards; AI tools refuse after the epoch moves. | In-flight work during unlink is dropped (intended). | Fixed, 07.5b + 07.5c |
| A-5 | P2 | `src/utils/moderationAction.cjs:kickGroupMember`, `group/kick.cjs` | Protection used metadata captured before awaited notices. | Member promoted meanwhile was kicked; demoted requester still kicked. | Fresh roster right before the checks and the remove; fail closed; re-check manual requester. | One roster read per kick; no roster, no kick. | Fixed, 07.5a |
| A-8 | P2 | `group/removeall.cjs`, `group/add.cjs` | Both wrote to a confirmation map nobody passes or reads. | `!removeall` prompted then threw; `!add` privacy-blocked line overwritten by an error card. | `add` ends on its line; `removeall` says it is not available (4 locales), removes nobody. | `!removeall` text changes (it never worked). | Fixed, 07.5a |
| B-1 | P2 | `aiAgent.cjs`, `aiProviders.cjs` (`withTimeout` x2), `aiTools.cjs` | Tool deadline was `Promise.race` only; no signal reached tools. | A tool could send after the model was told it timed out (duplicate poll on retry). | One `runToolWithDeadline` that aborts and passes `signal`; poll, reminders, summaries, media honor it; media slot held until settle. | Tools now stop at the deadline. | Fixed, 07.5c |
| B-2 | P2 | `aiProviders.cjs:runProviderAgent`, Gemini loop | At the step budget an unanswered `functionCall` turn was saved. | OpenAI-compatible providers rejected every later turn in that chat (400) until `!del`. | `trimHistory()` drops a trailing unanswered call turn whole; kept turns byte-identical (Gemini signatures). Repairs stored histories on load. | Loses the never-executed call request. | Fixed, 07.5c |
| B-5 | P2 | `aiProviders.cjs:callApi`, error cards | Remote error text reached the chat verbatim. | A server echoing the API key would post it in the group. | `settings.redactSecrets()` on provider errors and both error-card surfaces. | None expected. | Fixed, 07.5c |
| N-1 | P2 | `aiProviders.cjs:callApi` | Timer cleared before the body was read. | A trickling body escaped the deadline. | Deadline and abort cover body consumption. | None expected. | Fixed, 07.5c |
| N-2 | P2 | `src/commands/gemini.cjs` | An older completion saved after `!del`/`!delall`. | Cleared history came back. | Per-chat and global history revisions; stale saves skipped. | None expected. | Fixed, 07.5c |
| N-3 | P2 | `src/core/events.js:contained` | Wrapper forwarded only the first argument. | Proxy 407/403 handshake reported as 500 and retried. | Forward all arguments. | None expected. | Fixed, 07.5b |
| D-2 | P2 | `session.js:setInternetOnline` | Offline during socket creation did not invalidate the attempt. | Socket adopted while PAUSED; late failure moved PAUSED to ERROR; fast offline/online started nothing. | Offline always invalidates; overtaken attempts neither adopt nor error; latest intent wins once. | None expected. | Fixed, 07.5b |
| D-4 | P2 | `logger.cjs` sinks + 12 call sites | Raw LID/PN pairs, phone numbers, JIDs in `combined.log` and stdout. | Personal identifiers in an unsanitized log the panel serves. | Identifier fields removed or moved to the sanitized debug log. | Support loses raw ids from `combined.log`. | Fixed, 07.5a + 07.5c |
| C-2 | P3 | `engine.js`, `store.cjs`, `reactions.js`, `manage.js` | Candidate limit and alias cap duplicated as literals. | Raising one silently disables the capacity check. | One `src/automation/limits.cjs`; store queries `limit + 1`. | Low. | Fixed, 07.5b |
| C-3 | P3 | `reactions.js` vs `rules.cjs` | Emoji validator copied. | Panel could save a rule intake never matches. | One `isReactionEmoji()`; intake keeps the empty-removal case. | Low. | Fixed, 07.5b |
| A-6 | P2 (Codex) / P3 | `permissions.esm.js:identityForms`, `sameUser`, `store.cjs` role reads | LID digits equal to PN digits count as the same user without a mapping. | Wrong authority only if an unrelated LID's digits equal a privileged phone number; not attacker-choosable. | Proven mappings only. | Legacy rows matched only by digits fail closed; re-grant by phone. | **Fixed, 07.5d** (owner-approved) |
| D-3 | P2 | `src/auth/use-database-auth-state.js:clearAll`, `session.js` logout | A failed `DELETE FROM baileys_auth` (disk full, busy) is swallowed; unlink reports success. | Pairing data can survive an unlink that said it succeeded. | Propagate the failure; report unlink failure. | Changes credential-lifecycle failure handling. | **Fixed, 07.5e** (owner-approved) |
| A-7 | P3 | `runtime-config.cjs:setAliases`, `group.cjs` | Dashboard accepts aliases the v2 parser rejects; `!group <alias>` ignores overrides. | Alias silently does nothing. | Shared validation. | Low. | Defer |
| B-3 | P2 | provider loops | Two tool loops. | Proven drifts (deadline, history) fixed by B-1/B-2. | Full merge. | Large. | Defer |
| B-4 | P3 | `aiMedia.cjs` | Busy slot held until a hung op settles. | Documented design; network timeouts bound it. | — | — | No change |
| B-6, B-7 | P3 | inline media, `fetch_url` | Bounded by 64 MiB cap; fetch consolidation is not a defect. | — | — | — | Defer |
| C-4, C-6 | P3 | outcome code sets, status after restore | Diagnostics only. | — | — | — | Defer |
| D-5 | P3 | rollback-failure paths | Needs ROLLBACK itself to fail. | — | — | — | Defer |

Phase 07c items found by the same audits (C-1 overlap copy, C-5 disabling an invalid rule) were
fixed on PR #143 itself; see `PHASE-07-RESULTS.md`.

## 3. Implementation

Three stacked PRs, each based on the previous branch. The base of the stack is
`feat/v5-phase-07c` (PR #143), because 07c is not merged yet; after #143 merges, the base of
07.5a becomes `release/5.0.0-beta.1` with no content change.

| PR | Branch | Commits | Implementer | Content |
|---|---|---|---|---|
| 07.5a | `arch/07.5a-messaging` | `bcda7b5` `2538576` `a69f6ce` `bb7a4ff` `71e7b42` `8ae42b0` | Antigravity (Claude Sonnet 5.5, Gemini Flash for review fixes) | A-1, A-4, A-5, A-8, D-4 (non-AI lines) |
| 07.5b | `arch/07.5b-account-boundary` | `e2e9251` `982e88d` `d6fb435` `ad63485` `f0d2fd2` | orchestrator (epoch contract), Grok | A-3/D-1, D-2, N-3, C-2, C-3 |
| 07.5c | `arch/07.5c-ai-tools` | `95b69ff` `2140aeb` `78afbb9` + docs | OpenAI Codex | A-2, account boundary in the AI path, N-2, B-1, B-2, B-5, N-1, D-4 (AI lines) |

What changed, by boundary:

- Scheduling: `!listschedules` and `!deleteschedule` see only the current chat's jobs (groups by
  normalized JID; private chats by the chat JID or the message's `remoteJidAlt`, never by digits).
  Delivery always goes through the scheduler's live raw socket captured once per attempt; the
  socket a caller passes only arms the job.
- Kicks: a fresh roster is read right before the protection check and the remove request; no
  roster means no kick. A manual requester is re-checked with the rule of the gate that admitted
  the command (direct `!kick`: bot admin or group admin; nested `!group kick`: also the owner).
  The remove request is not sent when the account changed meanwhile.
- Account boundary: `accountEpoch()` in `src/db/store.cjs`. Logout and logged-out advance it before
  their first await and again after the wipe; activation advances it before replacing account
  tables. A message keeps the epoch it arrived with: it is dropped before dispatch, before
  moderation, and again right before a command or nested `!group` sub-command executes when that
  moved; commands receive it as `ctx.accountEpoch` (nested sub-commands as
  `{ nested: true, accountEpoch }`). Late metadata, moderation,
  auto-delete, AI history and context-buffer writes are skipped once it moved; AI tools refuse.
- Socket lifetime: `setupEventListeners()` returns a disposer that removes exactly its own
  callbacks; queued callbacks for a disposed socket return. Offline invalidates an in-flight
  creation; Stop and shutdown invalidate attempts and queued resumes before they wait. Logout
  keeps adopting an in-flight socket so `sock.logout()` still unlinks it server side.
- AI tools: authority is re-derived at each check (live roster; group admin from the cache, or the
  message-time snapshot only while the group's roster version is unchanged; denied while marked
  stale) and re-checked at the final send boundary through a delivery guard. One deadline runner
  aborts a signal that reaches the tools. Trailing unanswered tool calls are dropped from saved
  history. Provider errors and error cards are redacted. `!del`/`!delall` cannot be undone by an
  older completion.
- Logs: identifiers leave `combined.log`/stdout; diagnostic copies go to the sanitized debug log.

### Review rounds

| round | reviewer | scope | findings | disposition |
|---|---|---|---|---|
| debate | OpenAI Codex | merged matrix | 13 challenges, 3 new (N-1..N-3) | accepted except A-6, D-3 (owner) and the A-2 freshness rule (section 4) |
| 07.5a | OpenCode deepseek-v4.1-flash | 07.5a | private-chat alias miss, log context loss, residual kick-path JIDs | fixed in `71e7b42` |
| 07.5b | orchestrator | 07.5b | harness never called `clearAll`; work started in the logout wait could write after the wipe | fixed (second epoch advance) |
| 07.5c | orchestrator gate | 07.5c | group admin lost when the cache had no entry | fixed (snapshot fallback) |
| final | OpenAI Codex | whole stack | 1 P1 (late epoch sampling), 6 P2 (kick epoch order, send-time authority, Stop vs resume, nested owner kick, expired-cache snapshot, short secrets) | fixed in `8ae42b0`, `d6fb435`, `2140aeb`; redaction threshold 4 characters by decision |
| orchestrator | — | Grok's first Stop fix also changed logout | restored logout's adopt-then-logout path | fixed in `d6fb435` |
| verification 1 | OpenAI Codex | re-stacked head | 3, 4, 5, 7 fixed; 1, 2, 6 partial (dispatch after a metadata await, manual kick epoch, roster marker sampled at mint) | fixed in `ad63485`, `78afbb9` |
| verification 2 | OpenAI Codex | `369ff6e` (now `78afbb9`) | 1, 2, 6 fixed; no new defect; no access widening | 07.5a, 07.5b, 07.5c ready |
| gate | orchestrator | 07.5b after rebase | one scheduling test written before the rebase passed a socket the scheduler no longer uses (3 checks) | test fixed in `f0d2fd2`, assertions unchanged |

### Evidence (local, Linux, Node v24.22.2, 2026-11-09)

| gate | 07.5a `8ae42b0` | 07.5b `f0d2fd2` | 07.5c `78afbb9` |
|---|---|---|---|
| `npm test` | PASS, 13591 checks, 0 failed | PASS, 13652, 0 failed | PASS, 13794, 0 failed |
| `npm run lint` | PASS (exit 0) | PASS | PASS |
| `npm run i18n:check` | PASS | PASS | PASS |
| `npm run docs:check` | PASS | PASS | PASS |
| `npm run build:frontend` | PASS | PASS | PASS |
| `npm run validate:tarball` | — | — | PASS, 36 checks |
| `npm run build:sea` + `validate:sea` | — | — | PASS, 51 checks |
| `validate:docker` | BLOCKED locally (no Docker socket permission) | BLOCKED | BLOCKED; CI "container persists its volume" runs it |
| GitHub CI | recorded in the PR | recorded in the PR | recorded in the PR |
| Android device, live WhatsApp, live AI provider | NOT RUN | NOT RUN | NOT RUN |

Baseline at `31ef4f9`: 13380 checks. 07c head `f5699dd`: 13444. The rest are new regression
tests: schedule scope and live-socket delivery, fresh-roster kicks and requester rules,
`!removeall`/`!add`, account epoch at dispatch/moderation/metadata/auto-delete/AI tools, listener
disposal, offline during creation, Stop versus resume, handshake arguments, reaction limits and
emoji parity, live tool authority and roster markers, deadlines and send-time guards, history
repair, `!del` races, secret redaction and provider body deadlines.

Not covered by these tests: a real WhatsApp socket (fakes only), a real provider, Android WebView,
and timing on slow devices. No test touched a real account, key or production endpoint.

## 4. Disagreements and owner decisions

- A-6, D-3 and 07c R-3 were held for the owner and then approved on 2026-11-09; see section 6.
- A-2 group admin source: Codex asked for a fresh, fail-closed roster fetch on every tool call.
  The orchestrator kept dispatcher parity (cache, kept current by participant events, denied while
  marked stale) and added the recheck before deferred effects.

## 5. Rollback

Each PR reverts on its own in reverse merge order (f, e, d, c, b, a). No migration and no schema
change. The account epoch, history revisions and listener disposers are in memory only. Two
bot_settings keys are new: `auth:unlink-pending` (07.5e) and `reaction:automation-revision` (07.5f);
older code ignores both. Revert 07.5e only when no unlink is pending (the panel shows the
"unlink did not finish" notice while one is).

## 6. Owner decisions resolved (2026-11-09)

The owner accepted the stack conditionally and approved fixing A-6, D-3 and R-3 before merge.
Three follow-up PRs stack on #148 so no published history is rewritten.

### A-6: LID/PN privilege ambiguity (07.5d, `arch/07.5d-identity`)

- Equivalence for roles, admins, kicks and AI tools comes only from: the exact normalized
  identity (device suffix stripped); the current `lid_mapping` pair, verified in both directions
  (newest `updated_at`; a stale historical LID does not inherit the phone's role; tied conflicting
  rows fail closed); the transport pair on the message (`participantAlt`, `remoteJidAlt`); a roster
  participant that carries both forms; and the paired account's own `sock.user.id`/`sock.user.lid`.
  A bare phone and a PN JID are one namespace. LID digits never become a phone.
- Role reads use strict primary-identity rows; the digit fallback in `getUserMetadata` no longer
  decides privileges. Bootstrap sets keep verified forms only. `setUserRole` no longer stores LID
  digits as a phone, and contact merging cannot move a role flag.
- The linked account (`sock.user.id`/`sock.user.lid`, set on every connection, cleared on unlink)
  is always an owner. Revoking its owner role is refused with no change (`!perm`, AI tool, panel).
- A grant stays on the identity it was given to. A revocation clears the DB grants and bootstrap
  entries of every identity the caller can prove for the target, including roster participant forms.
- `!perm`, `!memory`, `!gemini` (del/delall), `!lang` and `!status debug` use every transport
  candidate and the roster, like the dispatcher.
- No stored row is rewritten. Recovery for a legacy role that can no longer be verified: re-grant it
  by phone number from the panel Roles screen or with `!perm add`. The paired account is recorded as
  owner again on every connection (AGENTS.md gotcha 27).
- Tests: `tests/identity-strict.test.mjs` (242 checks) covers both collision directions, mapped
  and roster-proven equivalence, device suffixes, stale and tied mappings, legacy contamination,
  owner and bot-admin roles, kicks, the five local gates, `!perm remove` and the AI
  `revoke_role`; `ai-tool-authz`, `moderation` and `reaction-engine` carry A-6 sections.

### D-3: failed credential deletion (07.5e, `arch/07.5e-unlink-cleanup`)

- `clearAll` rejects (the fence stays set); `authClearAll` is one transaction, so a failed delete
  leaves the rows intact.
- The session writes `auth:unlink-pending` before deleting. A failed marker write, credential wipe
  or required account cleanup (directory and role data, AI history, schedule pausing, role roster,
  AI memory files, sticker rows/files/uploads, auto-delete copies and counters) leaves the session in
  ERROR `unlink_incomplete`. The old socket stays fenced and stopped. `start()`, the retry timer,
  network restore and the boot policy refuse to open a socket; `linked` is false; Unlink stays
  available. `sock.logout()` still runs first, including for a connecting socket.
- A later Unlink (with or without a socket) or a boot with the marker repeats the wipe and the whole
  cleanup, which are idempotent, then removes the marker and reports LOGGED_OUT.
- The Connection screen no longer reports success for an incomplete unlink: it shows an error toast,
  a notice and "Unlink again" (four locales; pt-BR and es-419 machine draft).
- Tests: `tests/session.test.mjs` (failure injection, rollback, concurrent logout, logged-out close,
  restart with the marker, successful retry, cleanup failure and repeated failure),
  `auth-keystore-contract`, `session-startup-policy`, `memory-root`, `sticker-library`,
  `connection-unlink-ui`. Disposable data directories only; no real account was touched.

### R-3: cross-tab automation switch race (07.5f, `arch/07.5f-automation-revision`)

- `reaction:automation-revision` (bot_settings, no migration; missing reads as "0"; not in backups
  or settings export). `GET /reactions` returns `automation: { enabled, revision }`;
  `PUT /reactions/automation` requires both and compares and writes in one transaction. A stale
  revision returns 409 `REACTION_AUTOMATION_CHANGED` and writes nothing. Unlink and backup
  activation rotate it when they force the switch off.
- The panel sends the last applied revision; on 409 it refetches, shows the server value and warns
  once (four locales). The engine still reads `reaction:enabled`: default-off, opt-in and the kill
  switch are unchanged.
- Tests: `reactions-api` (two clients, delayed stale request, invalid revision, unlink and
  activation rotation, default off), `reaction-ui-logic` (409 reconcile without resend),
  `reaction-ui-static`.

### Review

| round | reviewer | findings | disposition |
|---|---|---|---|
| security review | OpenAI Codex | 2 P1 (cleanup failure reported as success; revocation missed roster-proven aliases), 2 P2 (linked LID dropped from bootstrap; command-local gates ignored sender proof); R-3 ready | fixed in `67fc973`, `6bc0dd7` |
| gate | orchestrator | D-3 returned `canUnlink: false`; panel toasted success on an incomplete unlink; a test called a missing store export; `!perm` logged JIDs | fixed |
| verification 1 | OpenAI Codex | 4 findings fixed; new P2: the linked account could revoke its own owner role until reconnect | fixed in `55ce7b8` (refused; linked identities in their own set) |
| verification 2 | OpenAI Codex | P2 fixed; no new defect; nothing but the paired `sock.user.id`/`lid` can enter the linked set, and unlink clears it | `55ce7b8` and stack top ready |

### Evidence (local, Linux, Node v24.22.2)

| gate | 07.5d `55ce7b8` | 07.5e `6bc0dd7` | 07.5f code `71025fc` |
|---|---|---|---|
| `npm test` | PASS, 14102 checks, 0 failed | PASS, 14284, 0 failed | PASS, 14364, 0 failed |
| lint, `i18n:check`, `docs:check`, `build:frontend` | PASS | PASS | PASS |
| `validate:tarball` | — | — | PASS, 36 checks |
| `build:sea` + `validate:sea` | — | — | PASS, 51 checks |
| `validate:docker` | BLOCKED locally (no socket permission); CI runs it | BLOCKED | BLOCKED |
| GitHub CI | recorded in the PR | recorded in the PR | recorded in the PR |
| Android device, real WhatsApp account, live providers | NOT RUN | NOT RUN | NOT RUN |

No test unlinked or modified a real WhatsApp account; D-3 failure injection used disposable data
directories. pt-BR and es-419 strings added by 07.5a, 07.5d, 07.5e and 07.5f are a machine draft
pending the ChatGPT review (Q-19); no native speaker has verified them.

Remaining risks: live WhatsApp behavior of LID/PN mapping updates is covered only by fakes; a role
granted before this phase and reachable only by digit equality now fails closed until re-granted
(by design); Android WebView rendering of the new Connection notice is NOT RUN.

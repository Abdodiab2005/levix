# Phase 07.5: E2EE Remediation Results

Status: **IMPLEMENTED AND OFFLINE-VALIDATED, AWAITING OWNER REVIEW AND FIELD QA.** Nothing here is
confirmed on a real phone. Every test below is offline; the simulation runs the real Baileys send,
retry and Signal code with a fake transport and fake recipients.

## A. Executive summary

- Fixed in Levix (this PR, branch `fix/v5-phase-07.5-e2ee`, base `release/5.0.0-beta.1` at `b383ed1`):
  1. The group roster Baileys uses for every group send is refreshed on membership changes and never
     served stale (C-1, C-2).
  2. Retries no longer re-send an empty text; the bot's own messages are cached at the send boundary
     (C-3, C-4).
  3. Signal key-store failures reach Baileys instead of being swallowed; `null` deletes (C-6).
  4. Welcome and join-request handlers read rc14 participant objects (C-9).
  5. Review fixes: the old account's key store and retry cache are fenced on unlink and socket teardown;
     an older bulk roster cannot override a newer refresh; a stale roster no longer grants admin-only
     commands.
- Fixed in upstream Baileys, local branches only, not shipped in Levix (C-5, C-8, identity change,
  transaction race): B1, B2, B3 and B4 are all marked ready by the final Codex review (section D).
- Not shipped: the device-cache adapter (C-7, held after review: a device notification can be lost to an
  older USync answer); join-request event wiring (C-10) and the Reply Router identity read (C-11), both
  owner decisions.
- Offline result: the simulation that reproduced the reported symptom now shows the affected member
  decrypting in every scenario the Levix fixes cover (section E). Two mechanisms remain open until the
  Baileys fixes ship: a device marked as having the key after a failed encryption (C-5) and a member
  whose phone changed identity (B2). Both heal today through a retry receipt, which the Levix fixes make
  reliable again.
- Ready for owner review: yes. Field QA with Miguel's group is required before calling the customer
  problem fixed (section G).

## B. Root cause matrix

| ID | Original cause | Evidence | Owner | Fix | Validation |
| --- | --- | --- | --- | --- | --- |
| C-1 | Levix never refreshed the group cache on `group-participants.update`; Baileys trusts any cached roster | `events.js:147-151` (b383ed1); sim B-09a | Levix | L1 `951a8a0` + review fix `3210d05` | `group-roster-sync` fails on base, passes; sim B-09a base FAIL to patched decrypt |
| C-2 | Device-0 retry re-reads the same stale roster | rc14 `messages-recv.js:1075,1144-1154`; sim B-10e | Levix trigger, Baileys behavior | L1 (roster fresh, so retry uses it) | sim B-10e patched: M2 decrypts |
| C-3 | `getMessage` returned `{ conversation: "" }` on a miss | `baileys.config.js:65-71` | Levix | L2 `71f89a6` | `retry-message-cache`; sim B-10b2: no resend on a true miss |
| C-4 | Bot sends never reached Levix's retry cache (`append` guard) | `message.handler.js:46,60-61` | Levix | L2 (send-boundary cache) + fence `f642786` | sim B-10b: original text resent after Baileys' cache is cleared |
| C-5 | rc14 marks a device before encryption; failed devices stay marked | rc14 `messages-send.js:552-584` | Baileys | B1 `6bd556a` | jest `sender-key-memory` 5/5 (fails on master); sim B-13b full |
| C-6 | Key store swallowed errors; `null` stored as text | `use-database-auth-state.js:15-99` | Levix | L3 `ff395be` + fence | `auth-keystore-contract` fails on base, passes |
| C-7 | node-cache `mset` reads `val`, Baileys passes `value`; device cache inert | `node_cache.js:459`, rc14 `messages-send.js:244` | Levix | Held (review P2: coherence race) | Adapter branch kept locally; not in this PR |
| C-8 | One retry receipt counted twice; failures before resend did not count | rc14 `messages-recv.js:1143,1212` | Baileys | B3 `91b25c5`, `3cf659d`, `4a40dcd` | jest `retry-count` 15 tests; sim B-14r full: 5 resends |
| C-9 | Welcome loop called `.split()` on rc14 participant objects | `group.handler.js:62` | Levix | L4 `8e44824` | `welcome-participants` 23 checks fail on base, 27 pass |
| C-10 | `events.js` listens to `group-requests.update`; rc14 emits `group.join-request` | rc14 `process-message.js:496` | Levix | Not wired (owner decision) | Shapes fixed in L4; event not subscribed |
| C-11 | `identity.cjs` calls `storage.authRead`, which `storage.cjs` does not export; Reply Router never sees the linked account | `messaging/identity.cjs:12`; found while testing L1 | Levix | Not fixed (owner decision: enables routes that now fail closed) | Test works around it |
| B2 | Same-jid identity change leaves the device marked in every group; offline notices skipped | rc14 `identity-change-handler.js:36-48` | Baileys | B2 `a0a1151`, `0fdde32` | jest identity tests; sim B-13 full |
| B4 | Label-keyed transaction mutex lets transactions and direct writes overwrite each other | rc14 `auth-utils.js:116-340`; sim B-13c | Baileys | B4 `06e7971`, `78de4ff`, `b6ac0c8` | jest concurrency tests (7 of 8 fail on master); sim B-13c full |
| B5 | Participant-hash recovery path commented out upstream | rc14 `messages-recv.js:1500` | Baileys | None: no safe offline reproduction | Not implemented (speculative protocol work) |

## C. Levix changes

Branch `fix/v5-phase-07.5-e2ee`, 11 commits on `b383ed1` (this report is the last):

| Commit | Change |
| --- | --- |
| `0cb8a41` | docs: the Phase 07.5 investigation report |
| `8e44824` | Welcome loop and join-request handler read rc14 participant objects; `groupRequestParticipantsUpdate` |
| `ff395be` | `keys.set` is one IMMEDIATE SQLite transaction (`store.authApply`), deletes `null`, rejects on failure; `keys.get` rejects on failure; legacy `"null"` rows read as absent |
| `71f89a6` | Send-boundary cache of the exact relayed `proto.IMessage`, keyed by chat and id (LID/PN aliases for 1:1), 500 entries, 1 h, 8 MiB; `getMessage` returns `undefined` on a miss; primary-phone messages no longer cached; cleared on unlink |
| `951a8a0` | Roster events mark the entry stale before any await; one shared, generation-checked refetch per group; send hook `groupMetadataForSend` never returns a stale roster; full vs partial `groups.update`; partial merges keep their TTL |
| `f642786` | Auth-state fence: after unlink or socket teardown the old store rejects with `AUTH_STORE_FENCED` and writes nothing; retry-cache account epoch |
| `3210d05` | Bulk roster cursor; `resolveGroupMetadata(sock, jid, { fresh: true })` for authorization (command gates, group sub-commands, `!mod`, chat `!memory`, AI caller roster, `!autodelete` exemption) |
| `ae19af2` | A full roster whose request start is unknown is stored only if the group had no roster event in the last 10 minutes; otherwise it starts a refresh |
| `0c3af3c` | start, stop, shutdown and the retry timer wait for an in-flight logout; logout fences any socket installed meanwhile |
| this file | Results report |

Behavior an operator can notice:

- Bot messages in groups reach members who joined after the bot cached the group.
- A retry that cannot be served sends nothing; it no longer sends an empty bubble.
- A membership change costs one roster query per group (a burst costs at most two).
- An admin-only command needs a fresh roster. If the roster is stale and WhatsApp cannot be reached, the
  command is refused. A just-promoted admin is allowed as soon as the refresh lands (the rule is
  unchanged; the data is fresher).
- Welcome messages work again on rc14.
- Storage errors in the Signal store now surface in logs and can make a send fail after Baileys' own
  retries, where before state was silently lost.

No schema change, no migration, no new dependency, no new setting, no change to `baileys_auth` data
written before this branch.

## D. Baileys changes (local, not pushed)

Repository: `~/Documents/levix-wt/baileys-upstream` (WhiskeySockets/Baileys, master `81345be`; rc14 is
`dbede1f`). One branch per fix, integration branch `local/integration-07.5`.

| Fix | Branch and commits | Change | Overlap with upstream PRs | Review status |
| --- | --- | --- | --- | --- |
| B1 | `fix/b1-sender-key-bookkeeping` `6bd556a` | sender-key-memory marks only devices whose SKDM was encrypted | none (new) | ready |
| B2 | `fix/b2-identity-sender-key` `a0a1151`, `0fdde32` (stacked on B1) | identity-change epochs (new `'identity-change'` key type), redistribution after a change, one session refresh per device and epoch, archived sessions kept; `assertSessions` puts unmapped PN jids into the prekey IQ | replaces #2711's 10-minute in-memory bypass with persisted epochs | ready; the PN prekey change should be its own PR or documented as a wire change |
| B3 | `fix/b3-retry-count` `91b25c5`, `3cf659d`, `4a40dcd` | one count per accepted id, charged before setup; every id accepted on its own budget | none | ready |
| B4 | `fix/b4-transaction-mutex` `06e7971`, `78de4ff`, `b6ac0c8` | one mutex and context per raw store; direct writes wait; LID mappings commit outside the transaction lock (deadlock fix), ordered against staged writes, under one short commit lock for every raw `set` | builds on #2811 (closed unmerged), adds direct-write protection and the deadlock and ordering fixes | ready; decrypts can wait for a send's transaction (benchmark: up to 56 to 74 ms during a 50 ms send) |

Integration branch `local/integration-07.5` at `0580992` merges all four. Patches are archived in
`~/Documents/levix-backups/phase-07.5-e2ee/remediation/baileys-patches/`.

Contribution boundaries: four PRs to WhiskeySockets/Baileys master (B1, B3, B4 independent; B2 stacked on
B1), each with the upstream AI disclosure line. B4 changes scheduling for every Signal operation and
should go up with its measurement and an issue first. Levix keeps stock rc14 until upstream accepts the
fixes or the owner approves a pinned fork; no postinstall patching (the Android build installs with
`--ignore-scripts`).

## E. Test evidence

All runs offline (`unshare -rn`, loopback only), Node 24.22.2, Linux 7.0.0-42.

| Gate | Base | Patched | Command |
| --- | --- | --- | --- |
| Levix full suite on rc14 | `b383ed1`: 116 files, 10189 checks, 0 failed | `0c3af3c`: 120 files, 10546 checks, 0 failed (224.5 s) | `node tests/run.mjs` |
| Levix full suite on patched Baileys | n/a | `0c3af3c` + Baileys `0580992`: 10546 checks, 0 failed (178.7 s) | same, `node_modules` copy pointing at the Baileys build |
| New Levix tests on the code before each fix (must fail) | welcome 23 fail; keystore 24 fail; retry cache 55 fail; roster 44 fail, then a crash for the review fix and 4 fail for the quiet window; fence tests crash or fail (4, 8), 7 fail for the logout race | all pass | copied into a worktree at the previous commit |
| Baileys jest | master: 28 suites, 407 tests | integration `0580992`: 32 suites, 450 tests | `node --experimental-vm-modules ./node_modules/.bin/jest` |
| Baileys new tests on master (must fail) | B1 5/5 fail, B2 11/11 fail, B3 9/10 fail, B4 7/8 fail | pass | same |
| Baileys tsc, eslint, build | PASS (0 errors, 103 warnings) | PASS (0 errors, 103 warnings) | `tsc`, `eslint src`, `tsc -P tsconfig.build.json` |
| SEA build and validate | n/a | `0c3af3c`: PASS, 51 checks, 0 failed | `node scripts/build-sea.mjs && node scripts/validate-sea.mjs` |
| Tarball validate | BLOCKED: `npm install` needs `github.com` (`EAI_AGAIN`) offline | BLOCKED | `node scripts/validate-tarball.mjs` |
| Docker validate | BLOCKED: no access to `/var/run/docker.sock` | BLOCKED | `bash scripts/validate-docker.sh` |
| Android build | NOT RUN: no Android or dependency change | NOT RUN | n/a |

Simulation matrix (harness at `~/Documents/levix-backups/phase-07.5-e2ee/harness`, profiles: base =
`b383ed1` + rc14, levix = this branch + rc14, full = this branch + patched Baileys):

| Scenario | base | levix | full |
| --- | --- | --- | --- |
| S0, B-06, B-07, B-08, B-11, B-12 controls | all decrypt | all decrypt | all decrypt |
| B-09a member added, stale roster | M2 cannot decrypt | M2 decrypts | M2 decrypts |
| B-10b retry after Baileys' cache cleared | empty text resent | original text resent | original text resent |
| B-10b2 true miss | empty text resent | nothing resent | nothing resent |
| B-10d bot send reaches the retry cache | no | yes | yes |
| B-10e stale roster at retry time | M2 never decrypts | M2 decrypts | M2 decrypts |
| B-13 identity change, same device id | fails until a retry | fails until a retry | decrypts next send |
| B-13b failed encryption marked | marked, next send fails | marked, next send fails | not marked, next send decrypts |
| B-13c reset during a send | reset lost | reset lost | reset survives |
| B-14r five retry receipts | 2 resends | 2 resends | 5 resends |
| H3 key-store failure | swallowed, `null` stored as text | rejects, commit retries 3 times, `null` deletes | same as levix |

Final matrix run `matrix-2026-11-07T19-26-08-642Z-351438`: 19 scenarios on 3 profiles, 57 of 57 cells
match the profile's expectation. Two harness probes were corrected by the orchestrator during the work
(B-09b and H3 expectations), and both earlier failures are kept in the evidence folder.

Process notes: implementers (Grok, agy, OpenCode, a Sonnet subagent) wrote the code and tests and ran
nothing; the orchestrator ran every gate. Codex reviewed every change read-only, three rounds per
repository (2 P1 and 10 P2 findings in total, all resolved or, for L5, dropped); its last verdicts were
"ship" for Levix and "ready" for each Baileys fix. The orchestrator corrected four test helpers
(welcome fake socket shape, retry-cache `rawResult` check, key-store key order, fence write counter) and
one type annotation in B2; each is in the commit that contains the test.

Limits: the fake server fans out the stanza itself and models no participant hash or PN/LID rewriting;
recipients decrypt with Baileys' own functions; interleavings in B-13c are forced. A simulation cannot
show what a real WhatsApp client displays.

## F. Risk review

- Roster refresh: one live query per membership change per group; a send right after a change waits for
  it. If WhatsApp is unreachable, a group send can fail where it used to go out to a stale roster.
- Authorization on fresh rosters: admin-only commands are refused while the roster is stale and the
  refresh fails. Moderation protection keeps the last known roster.
- Key-store errors: a persistent SQLite failure now fails the operation after Baileys' 10 commit retries
  (about 27 s) instead of silently losing state. The fence keeps those retries from writing after unlink.
- Retry cache: memory only, the bot's own messages, 8 MiB at most; nothing survives a restart, so a retry
  for a message sent before a restart sends nothing.
- Reply Router (C-11) and join requests (C-10) keep today's behavior (fail closed, never fire).
- Rollback: revert the PR; no data to undo. Each commit can be reverted alone; `3210d05` depends on
  `951a8a0`, and `f642786` on `ff395be` and `71f89a6`.

## G. Real-device QA (owner-approved test group only)

1. Install the beta built from this branch on Miguel's device; keep the TEST group; no other changes.
2. One affected member sends `!ping` in TEST. Both affected members and both admins must read the reply.
3. Trigger one moderation warning with a harmless message (for example a link while anti-link is set to
   WARN). Both affected members read the warning. If a voice note is deleted by moderation, its sender
   no longer sees it.
4. Remove one tester from TEST and add them back. Send `!ping` without restarting Levix. That tester
   reads the reply.
5. Restart the app, send `!ping` again. Everyone reads it.
6. Stop on any account warning, rate limit or unexpected deletion; send screenshots of each step.

## H. Proposed PR plan

Levix (one PR opened from this branch, commits kept separate for review):

| Title | Target | Depends on |
| --- | --- | --- |
| fix(07.5): group E2EE delivery: roster sync, retry cache, key-store errors, rc14 participant objects | `release/5.0.0-beta.1` | none |

Follow-ups for owner decision (not opened):

| Title | Notes |
| --- | --- |
| fix(router): read the linked account for reply routing (C-11) | enables configured routes that now fail closed |
| fix(groups): subscribe to rc14 `group.join-request` (C-10) | activates join-request auto-approve |
| perf(baileys): device-list cache with notification coherence (C-7) | needs ordering between USync answers and device notifications |

Upstream Baileys (not opened; owner approval and a fork needed):

| Title | Target | Depends on |
| --- | --- | --- |
| fix(messages-send): record sender-key memory only for devices that received an SKDM | master | none |
| fix(identity): redistribute group sender keys after a member's identity changes | master | B1 |
| fix(messages-recv): count each retry receipt once per message and device | master | none |
| fix(auth-utils): serialize Signal key transactions per store | master | none; open an issue with the measurement first |

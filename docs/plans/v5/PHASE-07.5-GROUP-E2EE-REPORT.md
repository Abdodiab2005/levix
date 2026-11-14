# Phase 07.5: Group E2EE Delivery Investigation Report

Status of this document: investigation output for owner review. Nothing here is shipped behavior.
No production code, dependency, setting, session or credential was changed.

## 1. Executive summary

- Verdict: **Most likely cause, not confirmed in the field.** Two causes in the shipped code put a
  member outside the set of devices that receive the bot's sender key, and the retry path that should
  repair it has defects of its own. An offline simulation that runs the real Baileys 7.0.0-rc14 send,
  retry and decrypt code reproduces each step. Which cause fired in the TEST group is not known; one
  debug log plus four answers from the tester give positive clues (section 10, E-1).
- Severity: **P1.** Bot messages, including moderation warnings and revokes, silently fail to
  decrypt for some members. End-to-end encryption itself is intact: no key or plaintext leaks.
- Release recommendation: **CONDITIONAL.** Keep v5.0.0-beta.1 in closed testing. Ship fixes F1 and
  F2 (small, Levix-only, no dependency or schema change) and confirm with approved device QA before
  wider rollout. The same code ships in v4.8.0 and v4.9.2, so holding v5 alone does not protect
  current users.
- Key evidence:
  1. Levix never refreshes the group cache that Baileys reads for every group send when members
     join or leave (`src/core/events.js:110-131,147-151`). Simulation B-09a: a member missing from
     that cache gets no sender key and cannot decrypt.
  2. Baileys sends a primary-phone retry back to the whole group using the same cached roster
     (`messages-recv.js:1075,1144-1154`). Simulation B-10e: the missing member stays unable to
     decrypt the resend and every later message, until the cache changes.
  3. Baileys rc14 records a device as "has the sender key" before encrypting, and drops a device whose
     encryption fails (`messages-send.js:554-584`, `:380-421`). Simulation B-13b: that device then misses
     every later message until a retry clears the record. Upstream master still has this order.
  4. Recovery defect: Levix's `getMessage` returns `{ conversation: "" }` on a miss
     (`src/config/baileys.config.js:65-71`), and Levix's own retry cache never receives bot messages
     (`src/handlers/message.handler.js:46,60-61`). Simulation B-10b: once Baileys' internal cache has
     lost the message (512 entries, 5 minutes), a retry re-sends an empty text to the whole group under
     the original message id. That message's content is lost; later messages decrypt again.
- Scope: every Levix build with this code: v4.8.0, v4.9.2 and v5.0.0-beta.1, all on Baileys
  7.0.0-rc14, on Android, desktop, npm and Docker alike. Group chats only (1:1 send B-08 uses no
  sender key). Members whose devices lack the bot device's sender key are affected; the admin role is
  not read anywhere in the send path.

## 2. Baseline and exact environment

| Item | Value |
| --- | --- |
| Target branch | `origin/release/5.0.0-beta.1` |
| Pinned commit | `b383ed1b000da0ec6227d6195e6a03a5fd775a4f` (Merge PR #135, Phase 07a) |
| Local branch note | local `release/5.0.0-beta.1` was `a68696d`, an ancestor of origin; not used |
| Worktree used | `~/Documents/levix-wt/p075`, detached at `b383ed1`, clean before this report |
| Baileys | `@whiskeysockets/baileys` 7.0.0-rc14 (`package.json:46`; lock integrity `sha512-WK+X8ju8...`) |
| Related packages | `libsignal` 6.0.0, `whatsapp-rust-bridge` 0.5.4, `node-cache` 5.1.2 |
| Dependencies | `node_modules` of the main checkout (symlinked); `package.json` and `package-lock.json` are identical between `b383ed1` and the session branch `cc6a259` |
| Node | official v24.22.2 (`~/.cache/levix-build/node-v24.22.2-linux-x64`); system v24.19.0 not used for gates |
| OS | Linux 7.0.0-42-generic x86_64 |
| Date | 2026-11-07 (UTC) |
| Network isolation | every run inside `unshare -rn` (loopback only); `tests/run.mjs` also preloads `tests/fixtures/no-external-network.cjs`; the harness records 0 network attempts |

Versions compared:

| Build | Baileys | getMessage fallback | participants update refreshes cache | own sends reach Levix retry cache |
| --- | --- | --- | --- | --- |
| v4.8.0 (`acb364d`) | 7.0.0-rc14 | `{ conversation: "" }` | no | no (`notify` guard) |
| v4.9.2 | 7.0.0-rc14 | same | no | no |
| v5.0.0-beta.1 (`b383ed1`) | 7.0.0-rc14 | same | no | no |

Between v4.8.0 and `b383ed1`, `src/config/baileys.config.js` changed only its logger (silent in
v4.8.0, the sanitized debug log since v4.9). `src/auth/`, `recentMessageCache.esm.js` and
`groupMetadataCache.cjs` are byte-identical from v4.9.2 to `b383ed1`.

Commands executed (all read-only toward the repository):

```bash
git status --short; git branch --show-current; git rev-parse HEAD
git fetch origin --prune
git worktree add --detach ~/Documents/levix-wt/p075 origin/release/5.0.0-beta.1
npm ls @whiskeysockets/baileys --depth=0
git diff --stat v4.9.2 b383ed1 -- <send, cache and auth paths>
git diff --stat release/v4.8.0 b383ed1 -- <same paths>
# baseline suite, offline
unshare -rn sh -c 'ip link set lo up && PATH=<node 24.22.2>:$PATH node tests/run.mjs'
# disposable harness, offline, twice
cd <scratchpad>/p075/harness && unshare -rn sh -c 'ip link set lo up; <node 24.22.2> run.mjs'
```

Artifacts (outside tracked paths). A copy of everything below, without the harness's temporary
databases, plus the agent briefs and agent reports, is in `~/Documents/levix-backups/phase-07.5-e2ee/`
(1.8 MB). The session scratchpad paths may be cleaned.

- Baseline log: `/tmp/claude-1000/-home-abdo-Documents-levix/32e98177-8c30-4e1e-b1b2-24837aff48d4/scratchpad/p075/evidence/baseline-npm-test.log`
- Harness (git repo, 3 commits, head `f55b5f1`): `/tmp/claude-1000/-home-abdo-Documents-levix/32e98177-8c30-4e1e-b1b2-24837aff48d4/scratchpad/p075/harness`
- Harness evidence, final runs: `.../harness/evidence/2026-11-07T14-16-35-271Z-119752/` and
  `.../harness/evidence/2026-11-07T14-16-45-387Z-119931/` (one sanitized JSON per scenario plus
  `summary.json`). Earlier runs with harness bugs: `2026-11-07T13-59-22-100Z-113773` (12 PASS,
  2 FAIL) and `2026-11-07T14-15-31-614Z-119281` (16 PASS, 1 FAIL); both failures are explained in
  section 5.

## 3. Facts vs hypotheses

| Claim | Classification | Supporting evidence | Counter-evidence | Confidence |
| --- | --- | --- | --- | --- |
| Bot group messages show "Waiting for this message" on 2 regular members; admins read them | Reported by tester | Screenshots (O-02, O-03, O-04) | Not reproduced by the developer | High that it happened |
| The group send path reads Levix's cache and trusts any entry with a `participants` array | Confirmed in code | `src/core/socket.js:157`; `messages-send.js:501-506` | none | High |
| Nothing refreshes that cache on `group-participants.update` | Confirmed in code; consequence reproduced offline (B-09a) | `src/core/events.js:147-151`; `src/handlers/group.handler.js:24-70` | The harness emits the event but does not assert the listener ran; the claim rests on the source | High |
| Partial `groups.update` events merge into the stale entry and restart its 1 h TTL | Confirmed in code | `src/core/events.js:121-131`; `groupMetadataCache.cjs:26-31` | A `groups` dirty notification makes Baileys fetch all groups and emit `groups.update` with full participants (`lib/Socket/groups.js:52-62`), which refreshes the entry | High |
| Panel Reconnect and `!restart` keep the cache; the full sync is skipped within 6 h of the last one | Confirmed in code | `session.js:576-580` (stop then start); `connection.js:252-279`; flushes only on unlink or logged-out close (`session.js:86-111,555,1018`) and backup activation (`connection.js:29-42`) | A process restart clears it | High |
| A member missing from the cached roster cannot decrypt bot messages | Reproduced offline (B-09a, B-10e) | stale run: M2 absent from `<participants>`, decrypt fails; fresh run recovers | Simulation only; real client not tested | High (code), unverified (field) |
| A primary-phone retry re-uses the stale roster and cannot heal that member | Reproduced offline (B-10e) | `messages-recv.js:1075` (`sendToAll` for device 0), resend omits M2 in both cache variants | Simulation only | High (code) |
| Levix `getMessage` makes Baileys resend an empty text under the original id | Confirmed in code; reproduced offline (B-10b, B-10e miss) | `baileys.config.js:65-71`; `messages-recv.js:1061-1063,1142-1154` | Baileys' own cache answers first while it still holds the message (512-entry LRU, 5 min TTL; B-10a). B-10b clears that cache; it does not wait for expiry | High |
| Levix's retry cache never holds bot-sent messages | Confirmed in code; reproduced offline (B-10d) | own sends are `messages.upsert` type `append` (`messages-send.js:1135-1137`, `chats.js:917-918`); guard at `message.handler.js:46` | none | High |
| rc14 marks a device in sender-key-memory even when its encryption failed | Confirmed in code; reproduced offline (B-13b) | `messages-send.js:554-563` then `:575`, catch `:417-420`, save `:584` | Needs a per-device encryption failure to occur in the field | High (code), unknown (field) |
| Same-device reinstall leaves the device marked; only a retry heals it | Reproduced offline (B-13) | identity handler refreshes the 1:1 session only (`Utils/identity-change-handler.js:42`) | B-13 swaps keys at one JID; it does not deliver an identity-change notification. It recovers after one retry with a fresh roster | Medium |
| A retry reset can be overwritten by a concurrent send's transaction | Reproduced offline (B-13c), overwrite only | final memory 5 entries, reset lost; upstream PR #2811 describes the same | The harness forces the interleaving; every recipient still decrypts in that run, so the delivery consequence is inferred | Medium |
| The Levix key store swallows write and read errors; Baileys sees success | Confirmed in code; reproduced offline (H3) | `use-database-auth-state.js:15-38,63-99`; H3 `commitSawError: false` | No SQLite write failure is reported in the field | High (code), unknown (field) |
| `null` writes behave as deletes | Reproduced offline (H3) | row text `"null"` reads back absent | none | High |
| The 1 h device-list cache is stale for new devices | **Disproved** (B-09b) | node-cache 5.1.2 `mset` reads `val`; rc14 passes `value` (`messages-send.js:244`, `node_cache.js:459`): every entry stores `null`, each send runs one USync query | none | High |
| Quotes or mentions change the sender-key decisions | Not supported (B-07) | one quoted and mentioned text keeps the recipient and SKDM sets of a plain text; field reports `!ping` fails too | Other payload types and client behavior not tested | Medium |
| The admin role causes the split | **Disproved at code level** | `relayMessage` (`messages-send.js:428-600`) never reads `admin` | The split is real in the field; its proxy is unknown | High |
| v5 introduced the bug | Predates v5 (code level) | the same three behaviors exist in v4.8.0 and v4.9.2, on the same Baileys | Another v5 change could still contribute; no field data from v4.x under matched conditions | Medium |
| The welcome message for new members works on rc14 | **Disproved in code** (side finding, not encryption) | rc14 emits participant objects (`messages-recv.js:637-645`; `process-message.js:525`); `group.handler.js:62` calls `participant.split("@")`, which throws; the catch at `:73-75` logs it | Tests pass strings (`tests/moderation.test.mjs:525`); not field-tested | High (code) |
| A newer Baileys fixes it | **Disproved** | npm `latest` is 7.0.0-rc14 (2026-07-29); master has 3 unrelated commits since | none | High |
| The voice note deleted for others but visible to its sender (O-06) is the same mechanism | Hypothesis | the revoke is an ordinary bot group message (`moderationAction.cjs:508`) | not tested | Medium |

## 4. Technical root-cause analysis

### Send, sender-key, retry and auth flow (pinned code)

```text
messages.upsert (src/core/events.js:135-141)
  -> handleIncomingMessage (src/handlers/message.handler.js:45; returns at :46 unless type "notify")
  -> handleCommand (message.handler.js:128) / handleGroupModeration (message.handler.js:144, body :151-196)
  -> command proxy (src/handlers/command.handler.js:90-172) or moderation (src/utils/moderationAction.cjs:364-568)
  -> sock.sendMessage wrapper (src/core/socket.js:107-129): media, thumbnail, linkPreview null
  -> Baileys sendMessage -> relayMessage (lib/Socket/messages-send.js:428), inside keys.transaction
     group branch (:498-585):
       roster   = cachedGroupMetadata(jid)  (Levix cache, socket.js:157) else live groupMetadata (:501-506)
       memory   = keys.get('sender-key-memory', [jid])                    (:514)
       devices  = getUSyncDevices(roster ids)  (one USync query per send in Levix, B-09b)
       skmsg    = encryptGroupMessage under meLid (lid group) or meId     (:544-550)
       for device without memory[device]: memory[device] = true; queue SKDM (:552-563)
       assertSessions + createParticipantNodes (per-device catch drops failures) (:573-575, :380-421)
       keys.set sender-key-memory (:584); stanza sent; transaction commits after (auth-utils.js:143)
     addRecentMessage to Baileys' own cache, LRU of 512 entries, 5 min TTL (:880; message-retry-manager.js:3,33-36)
     own upsert, type "append" (:1135-1137) -> Levix guard at message.handler.js:46 drops it
  -> WhatsApp server fans the skmsg out to every member device
  -> member without the bot device's sender key cannot decrypt -> "Waiting for this message"
  -> member sends a retry receipt (fields: messages-recv.js:464-486)
  -> handleReceipt (:1161) -> sendMessagesAgain (:1040):
       msg = Baileys cache (:1051) else config.getMessage (:1061) -> Levix returns { conversation: "" }
       sender-key-memory[group] = null (:1136)
       device 0 asked: resend to the WHOLE group, same id, same cached roster (:1075, :1144-1154)
       other device:   targeted group resend to that device, pairwise-encrypted, SKDM embedded
                       (messages-send.js:670-700)
```

Inputs, state owners and observability per boundary:

| Boundary | State owner | Failure handling | Observable today |
| --- | --- | --- | --- |
| Levix group cache | Levix (`groupMetadataCache.cjs`, NodeCache 1 h) | none on membership change | panel Groups screen; not in logs |
| sender-key-memory | Baileys rows in `baileys_auth` (SQLite) | reset only by a retry receipt | not logged by Levix |
| USync devices | Baileys; Levix cache inert | throws on IQ error | debug log |
| Per-device SKDM encryption | Baileys | caught, device dropped, still marked | debug log "Failed to encrypt for recipient" (error level) |
| Retry resend | Baileys + Levix `getMessage` | empty fallback | debug log "found message via getMessage" |
| Key store | Levix `use-database-auth-state.js` | logs and swallows | `combined.log` "[Auth] Failed to write data" |

### Earliest demonstrated failure point

In every reproduced failure the first wrong decision is the SKDM recipient set in the group branch
(`messages-send.js:552-575`). The skmsg ciphertext reaches every member; the affected member never
receives the bot device's sender key. Two independent causes put a member outside that set:

1. **Stale roster (Levix, F1).** The member is missing from `cachedGroupMetadata`. Lifetime: from the
   membership change until the entry expires, 1 h after the last `set`. Partial `groups.update` merges
   restart the hour while keeping the old participants. Panel Reconnect and `!restart` do not clear it.
   It ends earlier on a full refresh: a `groups` dirty notification (full participants in
   `groups.update`), a cache miss followed by `resolveGroupMetadata`, a process restart, unlink, or
   backup activation.
2. **False memory mark (Baileys rc14, F3).** The member's device is marked in sender-key-memory but has
   no key: a failed per-device encryption (B-13b), or a reinstall with the same device id (B-13). A
   retry reset lost to a concurrent transaction (B-13c) keeps such a mark alive. Lifetime: until a retry
   receipt clears the whole group's memory. The mark survives restarts (B-11: memory persisted).

The retry receipt is the only repair path, and three defects decide whether it repairs:

- (a) the roster is still stale: device 0 retries resend to the cached roster again (B-10e);
- (b) Baileys' own cache no longer holds the message (LRU of 512, 5 min TTL, cleared on a new socket):
  Levix supplies an empty text, so the asking member gets the key but that message's content is lost
  (B-10b). This defect does not cause the first failure;
- (c) the retry budget is spent: on the normal single-message path `updateSendMessageAgainCount` runs
  twice per receipt (`messages-recv.js:1143,1212`), so the default `maxMsgRetryCount` 5 allows two
  successful resends per message and device within the counter's 1 h lifetime
  (`baileys.config.js:20-23`).

Simulation evidence is code-level. It shows what Baileys and Levix compute and send; it cannot show
what a real WhatsApp client displays.

### Why admins read while the two members do not

No code path decides by role: `relayMessage` never reads `participant.admin`, and Levix only uses the
role for moderation protection (`moderationAction.cjs:380`). The split must come from per-member state.
States consistent with the mechanisms above, none yet confirmed for TEST:

- the admins were in the roster when Levix cached it; the two members were added later (cause 1);
- the admins' devices received the key earlier; the members' devices were marked without it, for
  example after a phone change or reinstall (cause 2, upstream #2704);
- client platform: upstream #2297 reports only iPhone members stuck in a LID group (unknown for TEST).

### Manual messages from the primary phone

The primary phone is device 0 of the bot account. It has its own sender key and WhatsApp's own roster
and device state, so the Levix cache and Baileys' memory do not apply to it. O-01 is expected under
every mechanism and does not discriminate between them.

### Voice-note deletion (O-06)

Moderation revokes with `sock.sendMessage(groupId, { delete: msg.key })`
(`src/utils/moderationAction.cjs:508`), using the raw incoming key. Baileys sends that revoke as an
ordinary group message (skmsg). A member who lacks the bot device's sender key cannot decrypt the
revoke, so their copy stays visible while other members see it deleted. The sender of the voice note
is a regular member, which fits cause 1 or 2. Classification: hypothesis, same mechanism likely.
It needs its own acceptance test after the fix.

### Upstream references (read on 2026-11-07)

- README "Caching Group Metadata (Recommended)": refetch with `sock.groupMetadata(event.id)` on both
  `groups.update` and `group-participants.update` (https://raw.githubusercontent.com/WhiskeySockets/Baileys/master/README.md).
- #2704 (rc13, closed by stale bot 2026-08-20, no fix): bot group messages stuck after a member changes
  phone; sender-key memory is reset only in the retry path. https://github.com/WhiskeySockets/Baileys/issues/2704
- #2297 (open): LID group of about 14, only iPhone members stuck, human messages fine; clearing the
  group's sender-key-memory restored delivery 3 of 3 times, then it recurred.
  https://github.com/WhiskeySockets/Baileys/issues/2297
- PR #2811 (closed unmerged): transactions with different mutex keys overwrite each other.
  https://github.com/WhiskeySockets/Baileys/pull/2811
- PR #2711 (closed unmerged): resolve PN to LID before sending, track identity changes.
  https://github.com/WhiskeySockets/Baileys/pull/2711
- PR #2507 (merged, already in rc14): retry resends embed an SKDM.
- npm: `latest` is 7.0.0-rc14 (2026-07-29). master has 3 commits after rc14 (logging example,
  WIN_HYBRID platform, copyright year). No upstream fix exists to adopt.

These are context. None is used here as proof of the Levix cause.

## 5. Reproduction / test matrix

Harness: `<scratchpad>/p075/harness` (head `f55b5f1`), real Baileys rc14 send, receipt, retry and
decrypt code, real Levix auth store, config, group cache and event listeners. Fake parts: the
WebSocket transport, an IQ responder for USync and prekeys, recipient devices built from Baileys'
own key helpers and decrypt functions, and a log counter. Synthetic JIDs only. Final runs:
`2026-11-07T14-16-35-271Z-119752` and `2026-11-07T14-16-45-387Z-119931`, both 17 PASS, 0 FAIL,
0 BLOCKED, 0 network attempts. "PASS" means the observation matched the scenario's stated
expectation, including expectations that a device fails to decrypt.

Simulation limits (from two independent read-only reviews of the harness):

- The bot socket is `makeWASocket` with the real Levix auth state, config, group cache and listeners.
  It does not go through `createWhatsAppSocket` and its `sendMessage` wrapper (`src/core/socket.js:103-132`),
  so link previews, thumbnails and remote media are not exercised. All probes send text.
- The harness hands the complete outgoing stanza to every remote group device, and each recipient picks
  its own `<to>` envelope by exact JID plus the shared skmsg. That stands in for WhatsApp's fan-out. For
  targeted retries, "delivery" to unrelated devices is a harness artifact. Server-side checks
  (participant hash, PN/LID rewriting, delivery receipts) are not modeled, so the B-12 decrypt results
  carry no field weight. Recipients decrypt with Baileys' own
  `decryptMessage`, `processSenderKeyDistributionMessage` and `decryptGroupMessage`, but without
  `getDecryptionJid` mapping.
- Inbound dispatch awaits listeners; real `ws.emit` does not. B-13c relies on a forced interleaving.
- B-09a and B-10e pass participant strings in `group-participants.update`; rc14 emits objects. The
  stale-cache result does not depend on that shape (the listener never writes the cache), but F1 tests
  must use the real object shape.
- B-11 replaces the socket inside one process: Baileys' socket state resets and the harness flushes
  Levix's device and retry-count caches, but Levix's other module state survives, so it is not a full
  process restart. Some PASS predicates are weak on their own; the recorded observations (entry counts,
  recipient sets, decrypt results) carry the evidence.
- Synthetic identities and keys only; evidence files hold JIDs of fake devices, enc types, counts,
  booleans and marker texts.

| ID | Environment | Expected | Actual | Result | Evidence |
| --- | --- | --- | --- | --- | --- |
| B-01 | Field, primary app text | all read | reported: all read | NOT RUN (reported) | O-01 |
| B-02 | Field, `!ping` | admins read, 2 members fail | reported as expected | NOT RUN (reported) | O-03 |
| B-03 | Field, `!help` | same | reported | NOT RUN (reported) | O-03 |
| B-04 | Field, `!md` (exists: `src/commands/md.cjs:6-7`) | unknown | not tested | NOT RUN | none |
| B-05 | Field, moderation warning | members fail | reported | NOT RUN (reported) | O-02 |
| S0 | Sim, fresh roster, 4 remote devices | all get SKDM and decrypt | all 4 decrypt | PASS | `S0.json` |
| B-06 | Sim, plain text | same as S0 | same | PASS | `B-06.json` |
| B-07 | Sim, quote and mention | same sets as B-06 | identical recipient and SKDM sets | PASS | `B-07.json` |
| B-08 | Sim, 1:1 to M1 | pairwise only, no sender key | 0 group encryptions, M1 decrypts | PASS | `B-08.json` |
| B-09a | Sim, M2 added via real `group-participants.update` | cache stays stale, M2 fails; refresh recovers | cache lacks M2, M2 no SKDM, fails; after refresh decrypts | PASS | `B-09a.json` |
| B-09b | Sim, new device 2 for M1 | device cache inert; USync each send; device 2 gets SKDM | cache holds 0 lists, 1 USync per send, device 2 decrypts | PASS | `B-09b.json` |
| B-10a | Sim, retry while Baileys' cache holds the message, roster refreshed | original text resent; all decrypt next | original text, `getMessage` not called | PASS | `B-10a.json` |
| B-10b | Sim, retry after Baileys' cache is cleared, roster refreshed | Levix returns empty; resend is empty | `getMessage` returned `conversation: ""`; all 4 devices decrypt an empty text; next message decrypts | PASS | `B-10b.json` |
| B-10c | Sim, Levix cache primed (control) | original text | original text | PASS | `B-10c.json` |
| B-10d | Sim, own upsert | type `append`; Levix cache stays empty | `append` seen; cache absent before and after | PASS | `B-10d.json` |
| B-10e | Sim, retry with roster still stale | full-group resend omits M2; M2 stays failed; refresh recovers | M2 absent from resend in hit and miss variants; third send fails; refresh recovers | PASS | `B-10e.json` |
| B-11 | Sim, socket restart on same DB | memory persists; no SKDM repeated; all decrypt | 5 entries before and after; all decrypt | PASS | `B-11.json` |
| B-12 | Sim, LID, PN, no `addressingMode`, PN ids in LID group | record identity choices | lid modes use `meLid`; pn uses `meId`; all synthetic devices decrypt | PASS | `B-12.json` |
| B-13 | Sim, M1 reinstall with same device id | memory suppresses SKDM; M1 fails; retry heals | as expected | PASS | `B-13.json` |
| B-13b | Sim, encryption to M2 fails on send 1 | M2 dropped but marked; send 2 skips M2; retry heals | marked true, absent from participants, send 2 fails, retry and send 3 recover; control passes | PASS | `B-13b.json` |
| B-13c | Sim, retry reset during an in-flight send (forced interleaving) | record whether the reset survives | reset persisted, then overwritten by the send's commit; final 5 entries; all recipients still decrypt | PASS | `B-13c.json` |
| H3 | Sim, Levix key store contract | null reads absent; failures visible | null reads absent (row text `"null"`); write failure swallowed, `commitSawError: false`; 50 concurrent tasks consistent | PASS | `H3.json` |
| B-14 | v4.9.2 vs v5 runtime | regression or not | code-level: same behaviors and same Baileys in v4.8.0, v4.9.2, v5; runtime comparison not run | NOT RUN (runtime) | section 2 |

Existing tests (part of the full baseline, Node 24.22.2, offline, commit `b383ed1`): **116 files,
10189 checks, 0 failed, 0 crashed, 171.5 s, exit 0.** Files touching the investigated modules, all
PASS: `low-data` 28, `persistence` 15, `storage` 170, `moderation` 272, `reaction-intake` 150,
`connection` 43, `send-bot-message` 17, `https-fetch` 98, `photo-proxy` 28, `auto-delete` 140,
`security-remediations` 42, `session` 162, `backup-activation` 56, `headless` 43,
`ai-media-cancellation` 44, `reply-router` 24, `debug-log` 80. No existing test covers `keys.get` or
`keys.set` in `use-database-auth-state.js`, the `getMessage` hook, the `append` early return, the
`groups.*` cache listeners, or any Baileys retry path.

Harness development failures, kept for honesty: B-09b failed twice. First its expectation assumed a
working device cache (the observation disproved it). Then its probe tested `!== undefined` where
node-cache returns `null`; the orchestrator changed that one comparison (`f55b5f1`) and verified the
behavior with a standalone node-cache probe. B-10d failed once because the harness read the cache
before rc14's 100 ms event-buffer flush (`Utils/event-buffer.js:141-165`).

## 6. Findings and alternative explanations

### Confirmed findings

- C-1 Levix group cache is not refreshed on membership changes, and Baileys trusts it for every group
  send (sections 3, 4). Matches the README guidance gap.
- C-2 Baileys' primary-device retry path re-reads the same cache, so a stale roster also blocks recovery.
- C-3 Levix `getMessage` returns `{ conversation: "" }` instead of `undefined` (Baileys default,
  `Defaults/index.js:80`), so a cache miss resends an empty text, to the whole group for device 0.
- C-4 Levix's retry cache never receives bot messages, so C-3 applies to every bot message that has left
  Baileys' own cache (LRU of 512, 5 min) or was sent before a restart.
- C-5 rc14 marks sender-key recipients before encryption and keeps the mark for failed devices.
- C-6 The Levix key store swallows storage errors; Baileys' commit retry (10 attempts, 3 s) never runs.
- C-7 Levix's `userDevicesCache` never caches (node-cache `mset` shape mismatch). Correctness is
  unaffected; each group send costs one USync query, against the low-data goal.
- C-8 Baileys counts a retry receipt twice on the normal path; two successful resends per message and
  device within 1 h.
- C-9 (side finding, not encryption) The welcome path throws on rc14's participant objects
  (`group.handler.js:62`); welcome messages for new members fail and are logged at `:73-75`.

### Disproved or unsupported causes

Disproved: stale device-list cache (C-7), admin role (code level), Levix null-as-delete semantics (H3),
and "a newer Baileys already fixes it". Not supported: message shape for one quoted and mentioned text
(B-07). Predates v5: all three Levix behaviors exist in v4.8.0 and v4.9.2.

### Remaining unknowns and blocking data

1. When the two members joined TEST, relative to the last Levix process start and the test messages.
2. Whether "restart" in O-05 was the panel Reconnect (cache kept) or an app or process restart.
3. Phone platform of the two members and of the admins (iOS or Android), and whether either member
   changed phone or reinstalled WhatsApp after joining.
4. TEST addressing mode (LID or PN) and member count.
5. A debug log covering one bot send in TEST (section 10, E-1). Without it, mechanisms 1 and 2 cannot be
   ranked against each other for this group.
6. Whether the members' clients send retry receipts at all, and how many.

## 7. Proposed fixes (ranked)

| Rank | Fix | Evidence | Scope | Risk | Confidence |
| --- | --- | --- | --- | --- | --- |
| 1 | F1 keep the send-path roster current | C-1, C-2; B-09a, B-10e | `src/core/events.js`, `src/utils/groupMetadataCache.cjs` | Low; one router window to test | High that it removes cause 1 |
| 2 | F2 correct retry content | C-3, C-4; B-10b, B-10d, B-10e | `src/config/baileys.config.js`, `src/core/socket.js`, `src/utils/recentMessageCache.esm.js` | Low | High for the empty resend |
| 3 | F3 group recovery of sender-key distribution | C-5, C-8; B-13, B-13b, B-13c | new owner action plus an upstream report | Medium | Medium (best effort) |

### F1: keep the send-path roster current

- Root cause: C-1, C-2. Assumes the members were absent from the cached roster.
- Design (the README pattern, plus the guards a shared cache needs):
  1. Roster events mark the entry stale at once. On `group-participants.update` (every action) the
     group's roster generation goes up and the entry is flagged stale before any await. The send-path
     hook (`src/core/socket.js:157`) and `resolveGroupMetadata` treat a stale entry as a miss, so no send
     reads the old participants while the refresh runs; Baileys then fetches live
     (`messages-send.js:501-506`). Only the Reply Router may keep reading the last known entry for its
     own-membership check (`router.cjs:150-155`).
  2. One live fetch per group at a time, shared. `refreshGroupMetadata` and `resolveGroupMetadata` use
     the same in-flight promise. An event that arrives during a fetch sets a "refetch after" flag, so at
     most one more fetch runs; ten events cost two queries.
  3. A fetch stores its answer only if the roster generation it started with is still current, and
     clears the stale flag. An older fetch can no longer write back a roster from before the change
     (`groupMetadataCache.cjs:65-67` has no such check today). On failure the entry is deleted.
  4. `groups.update` with a `participants` array is full metadata (Baileys' dirty refresh,
     `lib/Socket/groups.js:52-62`): it bumps the roster generation and is stored. A partial
     `groups.update` does not touch the generation; it merges into an existing fresh entry and keeps
     that entry's remaining TTL (NodeCache `getTtl`). With no entry, or an expired one, it stores
     nothing, so a partial object never becomes a cache hit. Readers treat an entry without a
     `participants` array as a miss (today `groupMetadataCache.cjs:62` accepts any truthy entry).

```js
// src/utils/groupMetadataCache.cjs (sketch; names are illustrative)
const state = new Map(); // jid -> { gen, stale, inflight, again }
function markRosterChanged(sock, jid) {
  const s = state.get(jid) || { gen: 0, stale: false, inflight: null, again: false };
  s.gen += 1; s.stale = true; state.set(jid, s);          // synchronous: no await before this
  if (s.inflight) { s.again = true; return s.inflight; }  // coalesce
  return fetchRoster(sock, jid, s);
}
function fetchRoster(sock, jid, s) {
  const gen = s.gen;
  s.inflight = sock.groupMetadata(jid)
    .then((live) => { if (s.gen === gen && Array.isArray(live?.participants)) { cache.set(jid, live); s.stale = false; } })
    .catch(() => { if (s.gen === gen) cache.del(jid); })
    .finally(() => { s.inflight = null; if (s.again) { s.again = false; fetchRoster(sock, jid, s); } });
  return s.inflight;
}
const freshEntry = (jid) => {
  const e = cache.get(jid);
  return e && Array.isArray(e.participants) && !state.get(jid)?.stale ? e : undefined;
};
// cachedGroupMetadata hook and resolveGroupMetadata read freshEntry(); resolve shares s.inflight.
```

- Why correct under rc14: the send path trusts any cached entry with a `participants` array
  (`:501-503`). After a roster event the hook returns either the refetched roster or nothing, never the
  old roster, so the send and a device 0 retry use the live roster.
- Negative cases:
  - The Reply Router reads only the cache for an authorized group destination (`router.cjs:150-155`,
    used at `:183`). It keeps the last known entry while a refresh runs, so routing continues; after a
    failed refresh the entry is gone and a route to that group is refused (fails closed) until the next
    successful fetch. The router needs a test for both states.
  - A live query while WhatsApp is unreachable fails; the next send to that group then throws instead of
    reaching a stale roster. A visible error replaces a silent one.
  - Whether a live query right after a participants notification always returns the new roster is not
    verified; the server order is unknown. Approved device QA must cover a join followed by a bot send.
  - F1 does nothing for cause 2.
- Privacy: none; the cache holds group metadata already.
- Tests: unit tests for the generation guard (a late older fetch is discarded), single-flight, full vs
  partial `groups.update`, TTL kept on partial merges, router behavior while absent; integration test
  with a fake socket and rc14-shaped participant objects; port B-09a and B-10e.
- Session impact: none. No migration. Rollback: revert the commit.
- Operations: one roster query per membership change per group, at event time. Baileys' own send-path
  query does not fill Levix's cache, so the refetch is what keeps outbound-only groups (for example
  scheduled messages) from querying on every send.
- Approval: owner approval of the implementation PR.

### F2: correct retry content

- Root cause: C-3, C-4.
- Design:
  1. `getMessage` returns `undefined` on a miss (`baileys.config.js:65-71`). Baileys then logs
     "recv retry request, but message not available" and sends nothing (`messages-recv.js:1157`).
  2. Remember every message the bot sends at the send boundary: in the `socket.js` wrapper, after
     `original(jid, payload, wireOptions)` resolves, store `result.message` under
     `${result.key.remoteJid}\u0000${result.key.id}` (Baileys' own key shape). Look up by the same
     pair. Keep the current bounds (500 entries, 1 h, memory only).
  3. Remove the now useless `notify` caching at `message.handler.js:60-61`, or keep it; it does no harm.
- Why correct: `getMessage` is typed `Promise<proto.IMessage | undefined>` and defaults to `undefined`;
  `result.message` is the exact `proto.IMessage` that rc14 relays (`messages-send.js:1128-1140`), for
  text, media, edits, revokes, reactions and polls. The pair (chat, id) matches Baileys' own cache key
  and is enough for the bot's own outbound messages.
- Other `getMessage` callers in rc14: `messages-recv.js:1061` (retry, above) and
  `Utils/process-message.js:427` (encrypted event responses). With `undefined`, the second takes its
  "creation message not found" branch instead of decrypting against an empty message. The poll-vote
  call (`process-message.js:581`) and the bad-ack resend (`messages-recv.js:1502`) are commented out.
  Placeholder resend does not call `getMessage`.
- Negative cases: after a process restart nothing is cached, so a late retry gets no resend and that one
  message stays unreadable for that member. Persisting message bodies would fix it and needs a separate
  privacy decision; it is not proposed. A retry miss still resets the group's sender-key memory and the
  asking device's session before skipping the relay (`messages-recv.js:1133-1157`). The retry relay does
  not restore send-time attributes such as the edit or revoke marker and poll metadata
  (`messages-send.js:1097-1112` vs `messages-recv.js:1144-1154`); that is upstream behavior F2 does not
  change. F2 does not deliver keys to a member missing from the roster.
- Privacy: unchanged. Only the bot's own messages, in memory, as AGENTS.md gotcha 13 already allows.
- Tests: unit tests for hit, miss (`undefined`), wrong chat with the same id, TTL expiry, size cap;
  harness-style test that a miss produces no resend and a hit resends the original.
- Session impact: none. Rollback: revert the commit.
- Approval: owner approval of the implementation PR.

### F3: recover sender-key distribution for one group

- Root cause: C-5 (and reinstall or race cases, C-8 limits retries). This is upstream rc14 behavior.
- Design, smallest first:
  1. Owner-only action ("Repair group encryption" in the panel Groups screen, or a `!group` sub-command):
     `await sock.authState.keys.set({ "sender-key-memory": { [groupJid]: null } })`
     (`lib/Socket/socket.js:929` exposes the transaction-wrapped store). The next bot message in that
     group attempts a fresh SKDM to every eligible discovered device (hosted devices and device 99 are
     excluded, `messages-send.js:552-558`). It keeps the sender key and touches one row; sessions,
     identity keys and credentials stay. Best effort: the write is not serialized against an in-flight
     send's transaction (`Utils/auth-utils.js:193-231`), so run it with no send in flight, and
     redistribution still depends on the roster, device discovery and encryption succeeding.
  2. Upstream issue and PR: mark `senderKeyMap[deviceJid]` only for devices present in `result.nodes`
     after `createParticipantNodes`, and clear a user's marks on identity change (ideas from #2704, #2711).
  3. An automatic Levix workaround that wraps `signalRepository.encryptMessage` is possible but reaches
     into Baileys internals; not recommended without the upstream answer.
- Why correct: rc14 itself performs the same reset on every retry (`messages-recv.js:1136`).
- Negative cases: for a group of N devices the next message carries up to N pairwise envelopes (`pkmsg`
  where no session exists, `msg` otherwise), one time. A reset lost to a concurrent send (B-13c) needs the
  action repeated with no send in flight.
- Tests: unit test that the action writes only that group's row; harness B-13b flow ends readable.
- Session impact: none beyond one row. Rollback: remove the action.
- Approval: required. The phase rules forbid changing sender-key-memory without the owner's approval,
  and the action writes to the Signal key store.

### Recommended smallest safe change

F1 plus F2 in one small PR (or two), with tests, then approved device QA. They fix confirmed Levix
defects, need no dependency or schema change, and keep every session. F3 step 1 follows if E-1 or QA
shows cause 2. No Baileys upgrade exists. Patching Baileys in place is not proposed: the Android build
installs with `npm ci --ignore-scripts` (`android/scripts/stage-levix-app.sh:81`), so a postinstall patch
would reach the desktop SEA release jobs (plain `npm ci`, `.github/workflows/release.yml:168`) but not
the Android app.

Separate items, not part of this fix: propagate key-store write errors so Baileys' commit retry works
(C-6, medium risk, needs its own failure tests); give `userDevicesCache` the `{ key, value }` shape rc14
uses (C-7, cuts one USync query per group send, but turns on a 1 h device cache that depends on
Baileys' device notifications, `messages-recv.js:713-821`).

## 8. Tests required after implementation

- Offline unit and integration (fake sockets, temp data dir, `node tests/run.mjs`):
  - roster refresh on `group-participants.update` (add, remove, promote, demote) with rc14-shaped
    participant objects, full vs partial `groups.update`, the stale flag (no send reads the old
    roster during a refresh), the generation guard, and the shared fetch (ten events, at most two queries);
  - a send after the event uses a live roster that includes the new member;
  - the Reply Router while a group entry is absent or refreshing;
  - the welcome path with rc14 participant objects (C-9), if that fix is approved;
  - `getMessage` miss returns `undefined`; hit returns the stored `proto.IMessage`; chat and id must both match;
  - every outbound send is remembered, including edits and revokes; bounds hold;
  - port harness scenarios B-09a, B-10b, B-10e and B-13b as regression tests with fakes, each with its
    control, so the old broken state fails the test;
  - full suite and CI 7/7.
- Approved real-device QA (owner and tester consent, disposable group):
  - two formerly affected regular members read new bot messages: `!ping`, `!help`, one moderation warning;
  - a member added after the bot connected reads the next bot message without a restart;
  - a moderated voice note disappears for its sender and for others (O-06 acceptance);
  - admins, the primary phone and other members still read everything.
- Regression: admins, PN and LID groups, members with linked devices, 1:1 chats, media, quotes,
  mentions, edits, moderation deletes and kicks, restart, panel Reconnect, backup and restore of
  `baileys_auth`.

## 9. Operational impact, rollout and rollback

- Compatibility: no migration, no key rotation, no relink. Existing `baileys_auth` rows stay as they are.
- Data and auth safety: F1 and F2 never write the Signal store. F3 writes one memory row per use.
- Beta rollout: closed track first. Watch the debug log at `debug` for "Failed to encrypt for
  recipient", "found message via getMessage", "recv retry request" counts and "error in sending message
  again"; watch feedback for "Waiting for this message" reports.
- Failure triggers to stop rollout: any new send failure rate in groups, a rise in retry receipts, or a
  member reporting messages lost after the fix.
- Rollback: revert the PR and publish the previous beta build; no data to undo.

## 10. Decisions required from the owner

1. Approve the shortest field experiment, **E-1**, with Miguel's informed consent:
   - set Settings, Diagnostics, connection log level to `trace`, then press Reconnect (applies on the
     next session start);
   - one affected member sends `!ping` once in TEST; wait 2 minutes; no other test sends;
   - Miguel sends Feedback with "Attach device & technical diagnostics" ticked (the debug log is
     sanitized: JIDs become `<jid>`, message text is dropped);
   - read: "using cached group metadata" participant count against the real member count (a lower count
     points to cause 1); "sending new sender key" recipient count; "Failed to encrypt for recipient"
     (cause 2); "recv retry request" followed by "found message in retry cache" or "found message via
     getMessage" (the latter is the empty resend);
   - plus answers to the unknowns in section 6 (join times, restart kind, phone platforms, reinstalls).
   - Limits: the log gives positive clues only. A roster with the right count but the wrong members looks
     normal; a device already marked in memory gets no encryption attempt, so no error line; a fresh
     `!ping` normally hits Baileys' own cache, so it does not exercise the empty resend. E-1 cannot
     exclude a cause.
   - Stop on any account warning, rate limit or unintended deletion. Set the level back to `info` after.
2. Approve the next-phase PRs:
   - PR-A (F1): on membership events mark the roster stale at once and refresh it through one shared
     fetch with a generation guard; store full `groups.update` payloads; keep the TTL on partial merges. Acceptance: unit tests; ported
     B-09a and B-10e pass and fail on the old code; Reply Router test; suite and CI green.
   - PR-B (F2): `getMessage` returns `undefined`; remember outbound messages at the send boundary.
     Acceptance: unit tests for hit, miss and scope; ported B-10b; suite and CI green.
   - PR-C (F3 step 1, only on approval): owner-only "Repair group encryption" action. Acceptance: writes
     one row; ported B-13b ends readable; panel strings in all locales.
   - PR-D (side finding C-9): read `id` from rc14 participant objects in the welcome path
     (`group.handler.js:56-70`), with tests that use the real object shape. Not encryption related.
   - Then approved device QA (section 8). Without it the customer problem is not declared fixed.
3. Decide whether to file the upstream issue (C-5, C-8) with a minimal synthetic reproduction.
4. No dependency upgrade is requested; none exists.

## 11. Final status

- Investigation: **PARTIAL.** Offline work is complete: code paths mapped, 17 simulation scenarios
  reproduce each mechanism with controls. Field confirmation is blocked on owner and tester
  authorization (E-1).
- Tests: **MIXED.** Executed: baseline suite 10189 checks PASS (116 files); harness 17 of 17 PASS on
  two runs. NOT RUN: B-01 to B-05 (field rows, tester reports only), B-14 runtime comparison.
- Fix: **PROPOSED ONLY, NOT IMPLEMENTED.**
- Release recommendation: **CONDITIONAL.** Keep v5.0.0-beta.1 in closed testing; land F1 and F2 with
  tests; pass approved device QA with two formerly affected members before wider rollout. Message
  delivery accepted by WhatsApp is not the same as decryption by recipients; only device QA proves the
  second.

No production fix was implemented. No WhatsApp session or credential was reset. No deployment was
performed. No live WhatsApp traffic was produced by this investigation.

---

## ملخص للمالك (بالعربية)

**الخلاصة:** السبب الأرجح معروف على مستوى الكود، لكنه غير مؤكد على جروب TEST نفسه. يوجد سببان يمنعان
وصول مفتاح تشفير البوت إلى بعض الأعضاء، فيظهر عندهم "في انتظار هذه الرسالة". وطريق الإصلاح التلقائي
(طلب إعادة الإرسال) فيه عيوب تمنعه من الإصلاح أحيانًا.

**السببان:**

1. **قائمة أعضاء قديمة في Levix.** عند إرسال أي رسالة في جروب، Baileys يأخذ قائمة الأعضاء من كاش
   Levix. Levix لا يحدّث هذا الكاش عندما ينضم عضو أو يخرج. العضو الذي انضم بعد ملء الكاش لا يستلم مفتاح
   التشفير الخاص بالبوت، فلا يستطيع فك رسائل البوت. وحتى طلب إعادة الإرسال من هاتفه يستخدم نفس القائمة
   القديمة، فلا يُصلح شيئًا. زر Reconnect وأمر `!restart` لا يمسحان هذا الكاش.
2. **مشكلة في Baileys نفسه (rc14).** Baileys يسجّل أن جهاز العضو استلم المفتاح قبل أن يتأكد أن التشفير
   نجح. لو فشل التشفير لهذا الجهاز، يبقى مسجلًا "استلم"، فلا يُرسل له المفتاح مرة أخرى إلا بعد طلب إعادة.
   لا توجد نسخة أحدث من Baileys تصلح هذا.

**عيب في طريق الإصلاح:** عندما يطلب العضو إعادة رسالة لم تعد في ذاكرة Baileys (بعد 5 دقائق أو 512
رسالة أو إعادة تشغيل)، Levix يعطي Baileys رسالة نصية فارغة بدل "غير موجودة"، فيعاد إرسال نص فارغ لكل
الجروب بنفس رقم الرسالة. محتوى تلك الرسالة يضيع، لكن الرسائل التالية تصل. كاش Levix نفسه لا يحفظ أي
رسالة أرسلها البوت أصلًا.

**ملاحظة جانبية:** رسالة الترحيب بالأعضاء الجدد تفشل مع Baileys rc14، لأن الكود يتوقع نصًا ويستلم
كائنًا. ليست لها علاقة بالتشفير.

**الأدلة:** محاكاة بدون إنترنت تستخدم كود Baileys الحقيقي للإرسال وطلبات الإعادة والتشفير وفك التشفير:
17 سيناريو، كلها طابقت التوقع في تشغيلين متتاليين، وأغلب حالات الفشل لها مقارنة بحالة سليمة. المحاكاة
لا تثبت ما يعرضه تطبيق واتساب الحقيقي. مجموعة الاختبارات الكاملة: 10189 فحص بدون أي فشل. نفس المشاكل
موجودة في v4.8.0 و v4.9.2، أي أنها أقدم من v5. دور الأدمن لا يدخل في كود الإرسال إطلاقًا؛ الفرق بين
الأدمن والأعضاء غالبًا سببه توقيت الانضمام أو حالة جهاز العضو.

**الإصلاح المقترح (لم يُنفذ):**
- F1: جلب قائمة الأعضاء الحقيقية من واتساب عند أي تغيير في الأعضاء، مع حماية من كتابة قائمة أقدم فوقها.
  خطر منخفض، مع اختبار لمسار توجيه الردود (Reply Router) الذي يعتمد على نفس الكاش.
- F2: إرجاع "غير موجودة" بدل الرسالة الفارغة، وحفظ رسائل البوت في الذاكرة لحظة إرسالها. خطر منخفض.
- F3 (بعد موافقتك فقط): زر للمالك "إصلاح تشفير الجروب" يمسح سجل توزيع المفتاح لجروب واحد فقط، بدون
  لمس الجلسة أو بيانات الربط.

**المخاطر:** F1 قد يجعل إرسالًا يفشل برسالة خطأ واضحة إذا كان الاتصال بواتساب مقطوعًا لحظتها، بدل
إرسال صامت لا يُقرأ. F2 لا يستعيد رسالة قديمة بعد إعادة تشغيل التطبيق. لا يوجد أي تغيير في المفاتيح أو
الجلسات.

**القرارات المطلوبة منك:**
1. الموافقة على تجربة واحدة صغيرة مع Miguel (E-1): رفع مستوى السجل إلى `trace`، رسالة `!ping` واحدة من
   عضو متأثر، ثم إرسال Feedback مع التشخيص. السجل منقّى من الأرقام ونص الرسائل. هذه التجربة تعطي مؤشرات
   على السبب الذي حدث، لكنها لا تستبعد أي سبب. ومعها أربعة أسئلة لـ Miguel: متى انضم العضوان، ونوع
   إعادة التشغيل، ونوع الهواتف، وهل أعاد أحدهما تثبيت واتساب.
2. الموافقة على تنفيذ F1 و F2 في المرحلة التالية، ثم اختبار على أجهزة حقيقية مع عضوين كانا متأثرين.
3. هل تريد F3 الآن، أم بعد نتيجة التجربة؟
4. هل نفتح بلاغًا عند مطوري Baileys بالمشكلة الثالثة؟

**التوصية:** إبقاء v5.0.0-beta.1 في الاختبار المغلق حتى يدخل F1 و F2 وينجح اختبار الأجهزة.

# Phase 07 — Free Reaction Automation

## Preflight and audit (2026-11-06)

PR #134 was merged into `release/5.0.0-beta.1` at 20:29:42 UTC.
Baseline: `f04ce30094cfd320fc2465e9a0b149998789e713`; branch:
`feat/v5-phase-07a`. The working tree was clean. The owner authorized fetching
this release branch; no workstation dependency/tool/artifact downloads are
authorized. GitHub-hosted CI may download dependencies.

Read the phase plan, ADRs, test/migration matrices, Phase 05/06 reports and
the supplied Phase 07 prompt. The owner's newer product decisions supersede
that prompt's Free Auto Reply and combined-phase instructions.

- `src/core/events.js` routes upserts but does not subscribe to reactions,
  deletes or content updates. The installed Baileys rc14
  `Utils/process-message.js` emits `messages.reaction` with the original key
  in `entry.key` and the actual reactor's transport key in `reaction.key`.
  A missing/empty reaction text means removal. Changes need previous state.
- `message.handler.js` drops reaction-only envelopes before commands and
  moderation. Its existing outgoing retry cache is deliberately separate.
- Real caller resolution, live command settings and capabilities are owned by
  `permissions.middleware.js`, `aiToolAuth.cjs` and the existing commands.
  Phase 05 routing and Phase 06 final cancellation guards must be reused by
  07b; an original message's author is never the reactor's authority.
- Store queries belong in `store.cjs`; schema 10 uses append-only transactional
  migrations. Startup already locks and verifies a secret-free backup first.
  `backup/content.cjs` rejects unclassified new tables. Account unlink must
  clear replay data and disable rules; restored rules must require re-enabling.
- Dashboard management belongs behind the existing authenticated, same-origin
  APIs and four-language React primitives; no new UI/API ships in 07a.

Baseline gates run offline on Linux x64, Node 24.19.0. Logs:
`/tmp/levix-p07a/baseline-*.log`. Lint, i18n, docs freshness and frontend
build PASS. Before application changes, `npm test` PASS: 10002 checks,
0 failures/crashes, 353.4 seconds. Lint has the baseline 196 warnings/73 infos.

## Written implementation plan (before code)

1. Update ADR-008/009, Phase 07/08, scope, architecture, risk and migration
   notes. Reaction rules, actions and builder are Free Core, with no tier rule
   cap. Prefix-free Auto Reply, per-chat configuration and entitlement runtime
   belong to private Plus in Phase 08. Preserve opt-in, rate limits, loop
   protection, real-sender tool checks and kill switch. Propose Phase 07.5,
   behavior-preserving stabilization only; do not implement it.
2. Add `src/automation/reactions.js`: one synchronous intake per socket, no
   action executor and no queue. Consume Baileys' dedicated reaction event and folded `WAMessage.reactions`;
   use the same durable claims so neither path is consumed twice. Observe only live notify originals
   from enabled-rule chats. Validate exact chat/id/fromMe/author, transport
   actor and timestamps; reject malformed, cross-chat, self, hidden and unknown
   inputs. Normalize JIDs with existing helpers and trusted local LID mappings.
3. Keep a sanitized original envelope only in RAM: 30 minutes, 500 entries,
   8 MiB total and 64 KiB per entry. Never download media during intake; never
   keep quoted context, thumbnails or media bytes. Invalidate observed deletes
   and edits with bounded, durable hash-only tombstones; fail closed on saturation. Flush on
   socket disposal, disconnect and rule disablement. Historical/re-requested
   originals are not admitted. All batch work is bounded.
4. Append schema 11 in `db.cjs`: disabled-by-default rule records with explicit
   chat scope and a JSON definition, plus hashed event claims, latest
   reactor/target transition state and deletion/edit invalidation markers. Add queries in `store.cjs`. Claim in one
   immediate transaction before returning an event. Duplicate ids, tied/older
   timestamps and unchanged emoji produce no new transition. Retain replay
   keys at least as long as an event is eligible; expire by indexed time.
   Cap each replay table at 10,000 live rows; refuse new work at capacity,
   never evict live claims. This is a resource bound, not a Free rule limit.
5. Wire intake in `core/events.js`, invalidate local deletes at the existing
   `core/socket.js` outbound boundary, dispose it in `core/session.js`, and clear
   account state in the existing store unlink boundary. Classify rules as
   account-bound backup data and replay tables as excluded transient data in
   `backup/content.cjs`; restored rules start disabled in `activation.cjs`.
6. Add deterministic `tests/reaction-intake.test.mjs` and migration/restart
   coverage. Exercise add/change/remove, replay, timestamp ties, unknown,
   stale/deleted/edited and hidden originals, aliases, actor/target separation,
   disabled scopes, bounds, saturation, lifecycle and real fake-emitter wiring.
   Test actual schema 10 upgrade and old fixtures, rollback and backup safety.
   Existing Phase 05/06 permission/routing/AI gates stay required.
7. Run offline `npm test`, lint, i18n/docs checks, frontend build, tarball and
   SEA artifact validation, then commit/push and open a draft 07a PR targeting
   the release branch. Record final-head CI, including Android and Docker.
   No live WhatsApp/provider tests, merge, release, tag, deploy or next slice.

## Contracts and limits

07a admits at most one transition per transport event and monotonically newer
actor/target timestamp within the 30-minute eligibility window, across restart.
Replaying an event after retention cannot re-arm it: it is then too old.
Claims commit before handoff; a crash can lose work and is never retried
automatically. Unknown originals are skipped, with no fetch, fallback or send.
The RAM lookup intentionally starts empty on restart/reconnect.

07b must add durable event/rule and action deduplication before side effects,
live sender/command authorization, destination checks, cancellation, concurrency,
rate limits and a global kill switch. An already initiated send cannot always
be retracted. 07a does not claim to implement or test those future actions.

Threats: transport/target identity confusion, cross-chat lookup, replay after
restart, timestamp abuse, unbounded reaction storms, deleted-message revival,
private payloads in persistence/backups/logs and stale sockets. Controls are
fail-closed validation, bounded RAM, no network/sends, durable claim-first
dedupe, lifecycle disposal and backup/unlink boundaries. Logs contain neither
original payloads nor event arguments.

Rollback: disable every reaction rule; keep the new tables unused on schema 11.
Do not downgrade the binary against a newer schema. If schema rollback is
required, stop Levix and restore the verified schema-10 pre-migration copy as
described in `MIGRATION.md`; it omits credentials and requires reconfiguration
and pairing. Existing commands, Phase 05 routing and Phase 06 cancellation
guards are retained.

## Review findings and corrections

- Installed Baileys can fold reactions into buffered original-message upserts.
  Both intake paths now share event claims; real `makeEventBuffer` regression
  coverage tests either event order and duplicate delivery.
- Disabling/deleting the last rule must not suppress invalidation of a tracked
  original. Disabled configured chats and retained lookup entries still record
  deletion/edit hashes. Fresh processes cannot revive known-deleted originals.
- Learning a LID/PN mapping must not re-arm a reaction or bypass a deletion.
  Raw normalized transport identities remain intact; bounded trusted alias
  expansion matches cache entries and searches at most 64 transition keys.
  Matching numeric LID/PN digits alone is not accepted as identity proof.
- Hash-only invalidations persist independently of the payload lookup (at most
  500 markers). Saturation uses one conservative global block for the full
  remaining eligibility window, preserving the latest expiry even after a
  backwards clock change. These transient rows are excluded from backups.
- Synchronous intake listeners contain failures immediately, with no extra
  per-event microtask queue. Periodic sweep failure discards RAM content and
  logs a fixed warning and pauses intake until a fresh socket is attached.
  Event-intake errors also pause that intake; ordinary routing remains isolated.
  View-once key markers and ephemeral metadata are rejected.
- Local outbound deletes invalidate before the existing socket send path,
  including moderation/auto-delete. Failed or cancelled deletion may therefore
  cause a safe lookup miss; it never revives a message or widens permissions.

The orchestrator reviewed every diff and ran every gate. OpenCode's free model
provided a read-only database/backup audit; its incorrect claim that Baileys
has no dedicated reaction event was rejected against installed source. agy
(Gemini lane, after the quota guard rejected Claude/GPT) and Grok timed out
without final substantive audits. No clean independent reviews are claimed for
those runs; no delegate application edits or test/build results were adopted.
A read-only Codex reviewer found the integration/lifecycle issues above; the
orchestrator fixed them with regression coverage.

## Evidence and handoff

Status: **07a IMPLEMENTED, PENDING OWNER REVIEW**.
[Draft PR #135](https://github.com/Abdodiab2005/levix/pull/135) targets
`release/5.0.0-beta.1`. Verified implementation commit:
[`eed262184396b243ea54ea41cd90bb331e201d15`](https://github.com/Abdodiab2005/levix/commit/eed262184396b243ea54ea41cd90bb331e201d15).
The final documentation commit changes no runtime source or tests. Its immutable
SHA and rerun/CI results live in the PR verification record, avoiding a
self-referential commit hash or a claim about CI that has not run yet.

Environment: local Linux x64, installed Node **24.19.0**, 2026-11-06 UTC /
2026-11-07 Cairo. Official CI uses pinned Node **24.22.2**. Workstation gates
use `npm_config_offline=true`, `FFMPEG_BIN=/usr/bin/ffmpeg` and
`NODE_OPTIONS=--require=/home/abdo/Documents/levix/tests/fixtures/no-external-network.cjs`.
Only the explicitly approved release-branch Git fetch downloaded repository
commits; no workstation dependency, runtime, tool or artifact downloads occurred.

| Verification | Status |
| --- | --- |
| Baseline `npm test` on `f04ce30` | PASS: 10002 checks, 0 failures/crashes, 353.4 s |
| Focused intake regressions | PASS: 150 checks; fake Baileys sockets/event buffer, fake clock, fresh process, isolated DB |
| Focused schema-10/legacy upgrade, backup-before-migration and rollback | PASS: 25 checks (`reaction-migration.test.mjs`), including a contained metadata sweep failure |
| `npm test` on implementation `eed2621` | PASS: **10194 checks**, 0 failures/crashes, **323.6 s** |
| `npm run lint` | PASS, existing 196 warnings / 73 infos, no errors |
| `npm run i18n:check` / `npm run docs:check` | PASS; no new UI strings or locale approval claims |
| `npm run build:frontend` | PASS; existing bundle warnings |
| `npm run validate:tarball` | PASS: 36 checks, installed FFmpeg and offline npm cache |
| `npm run build:sea` / `npm run validate:sea` | PASS: 51 artifact checks; local executable embeds installed 24.19.0 |
| Implementation GitHub CI, including Android and Docker | **PASS 7/7** on `eed2621`: [run 42302901593](https://github.com/Abdodiab2005/levix/actions/runs/42302901593). Tests, npm, Linux/macOS/Windows SEA, Docker persistence/upgrade, Android units/APKs/release AAB. Build checks are not device QA. |
| Final documentation-head rerun / CI | NOT RUN at this documentation commit's preparation; immutable final head, exact local results and final CI run must be recorded in PR #135 before handoff |
| Local Docker, Windows/macOS SEA and Android builds/device QA | NOT RUN locally; applicable artifact/build coverage belongs to final-head CI |
| Live dedicated-account WhatsApp/reaction/provider QA | NOT RUN; not authorized |
| 07b roles/disabled commands/cross-chat delivery/STT/action dedupe/rates/cancel/kill switch | NOT RUN: no action executor in 07a; required in 07b |
| 07c authenticated/CSRF-protected four-language accessible Rule Builder | NOT RUN: no management API or UI in 07a; required in 07c |

All local implementation gates above were rerun on immutable `eed2621`:
`/tmp/levix-p07a-head-{tests,fast,artifacts}-results.json` and referenced logs.
The final documentation-head reruns use `/tmp/levix-p07a-final-*-results.json`;
the PR verification record names their final commit and CI run. No gate is
inferred from an earlier head. The pre-commit logs remain historical evidence.


Remaining work: **07b** implements matching/conditions, command-backed safe
actions (including verified voice-to-STT), real-sender live permissions,
event/rule and action claims, destination/final send checks, cancellation,
bounded concurrency/rates and a global kill switch; define enablement epochs and reject pre-enable/recovered originals, with immediate management invalidation. **07c** implements owner
management validation/auth/CSRF, explicit enablement, actionable statuses and
the four-language responsive accessible Rule Builder. Rule JSON is an internal
storage seam in 07a, not a supported configuration API or enabled feature.

Phase 07.5 and 08 have not started. No unresolved product choice is needed for
07a's fail-closed, disabled-by-default intake. No merge, release, tag, deploy
or Play upload was performed. Runtime permissions and existing explicit
commands/AI tools remain unchanged.


## Phase 07b audit and implementation plan (2026-11-07, before code)

PR #135 is merged into `release/5.0.0-beta.1` at
`b383ed1b000da0ec6227d6195e6a03a5fd775a4f` (11:53:14 UTC).
The clean `feat/v5-phase-07b` branch starts from that actual merge. The owner
approved this specific release-branch fetch. Installed local Node: 24.19.0,
Linux x64. Baseline full tests are running offline; results will be recorded
below before application changes. Existing behavior is intake only, with no
executor or supported management interface.

Audit: 07a supplies bounded originals, durable transitions and invalidation,
but has no enablement epoch or rule/action claims. Removal currently loses the
previous emoji. Existing STT already owns provider selection, audio validation
and transcription; reuse it, never implement another provider. Phase 05 owns
routing and Phase 06 checks signals immediately before Baileys. Reaction roles
must use exact JIDs plus trusted aliases: legacy numeric LID/PN fallback is not
adequate proof of reactor privileges. Cache-first group roles can be stale;
fetch current membership for reaction authorization. Reject recognized bot
metadata before the intake strips context.

Plan and acceptance:

1. Add a strict, bounded internal rule definition validator and engine in
   `src/automation/`. Initial allowlist: existing `stt.transcribe` for verified
   voice notes and existing `ping.execute`. Match emoji, add/change/remove,
   exact chat, original type and reactor role/allowlist. Removal matches the
   previous emoji. Lower numeric priority then lexical rule id wins; exactly
   one winning rule per event, with no fallback to a lower rule on failure.
   Destinations initially support source chat and linked-owner private chat
   through the Phase 05 router. No raw destination, URL, code, shell, arbitrary
   command arguments, subscription dependency, API or UI.
2. Append schema 12; do not edit schema 11. Add rule revision, priority and
   enablement time; disable legacy seam-only rows on upgrade. Durable bounded
   event/rule/action claims and per-reactor/chat/rule rate budgets precede side
   effects. Saturation rejects work and never evicts live claims. Originals
   must be received AND timestamped strictly after enablement, in the same
   observed revision; no restart/reconnect recovery. Edits/re-enable rotate
   revision/epoch. Internal writes notify active sockets synchronously.
3. Reuse shared backend permission evaluation with a strict identity option,
   minting callers only from intake actor keys. Fetch live group membership,
   verify actor/original author/bot access, blacklist and disabled-command
   policy before actions and again at delivery. Extend the existing final
   socket boundary with an optional internal pre-send authorization callback;
   strip it before Baileys. Preserve ordinary commands without the option.
4. Two concurrent actions globally, one per reactor, zero waiting queue;
   persistent attempt limits: 3/reactor, 10/chat, 5/rule per minute. A global
   off-by-default switch and rule disable/edit/delete abort pending operations.
   Disconnect, original invalidation and membership changes cancel work.
   Providers ignoring cancellation retain their occupied slot until settled;
   deadlines prevent late sends. Check signal and live state after every await
   and immediately before the final send. Errors are explicit internal outcome
   codes; refused sends never count as delivered or use a fallback.
5. Preserve bounded intake/storage and backup-before-migration. Classify new
   transient tables as excluded, disable restored/unlinked rules and global
   runtime, clear account data, and contain cleanup errors. Log fixed outcome
   codes only, without original content, provider output, JIDs or rule args.
6. Deterministic isolated tests cover schema 11/legacy upgrade and rollback,
   matching/priority/epochs, roles and LID/PN collisions, real voice-STT reuse,
   replay/restart claims, rates/concurrency, disable/kill/disconnect, stale or
   invalidated originals, timeout/ignored cancellation/refused send and final
   asynchronous preparation. Rerun existing Phase 05/06 regressions and full
   offline gates; use final-head GitHub CI for Android/Docker/platform builds.
7. Update phase/ADR/migration/test evidence, commit/push this feature branch,
   open a Draft PR targeting the release branch and verify final head. No live
   WhatsApp/provider/device test, merge, release, tag, deployment, 07c, 07.5 or
   Phase 08.

Privacy: only 07a bounded RAM originals; persistent execution/rate keys are
hashes and timing metadata. No transcripts/media archive or historical lookup.
At-most-once attempts may be lost after a crash or cancellation, and an already
initiated external send cannot be retracted; never promise exactly-once delivery.
Rollback: turn the global switch off and disable rules, retaining schema 12.
For binary downgrade stop Levix and restore the verified schema-11 pre-migration
copy under `MIGRATION.md`; credentials/API keys are intentionally omitted.

Baseline `npm test` on `b383ed1`: **PASS**, 10194 checks, zero failures/crashes, 181.0 s; Linux x64 / Node 24.19.0, 2026-11-07. Log: `/tmp/levix-p07b/baseline-tests.log`.


## Phase 07b implementation, review and verification

Status: **IMPLEMENTED, PENDING FINAL-HEAD VERIFICATION / OWNER REVIEW** on
`feat/v5-phase-07b`, based on merged `b383ed1`. The immutable final commit,
Draft PR URL, final-head gate results and GitHub CI run are recorded in the PR
verification record after this report is committed. The historical 07a evidence
above is not a claim about 07b.

### Architecture and observable contract

- `automation/rules.cjs` validates a strict version-1 definition: one emoji;
  add/change/remove transitions; original types; reactor role and optional exact
  sender allowlist; `ping` or `stt`; source or linked-owner-private destination.
  Unknown fields/actions/destinations, arbitrary arguments, URLs and executable
  expressions are rejected. Removal matches the previous emoji; change/add the
  new emoji. Lower priority number then binary lexical id selects one winner.
  A refused/failed/unauthorized winner never falls through to another action.
- `automation/engine.js` accepts only tokens minted by the verified intake;
  actor/original data comes from a private serialized snapshot. An original
  must be received and timestamped strictly after its rule's enablement and
  this connection, with no future original timestamp relative to receipt.
  Reconnect starts empty and old catch-up originals cannot execute.
- Appended schema **12**, preserving every schema-11 migration byte: rule
  revision, enablement timestamp and priority, `reaction_executions` and
  `reaction_budgets`. Schema-11 seam rows become disabled. New rules and the
  `reaction:enabled` global runtime default off. All edits disable the rule;
  enablement rotates revision even within one millisecond. Internal
  save/enable/delete/switch methods notify active engines synchronously.
  Rule configuration changes rotate a constant-sized global configuration
  revision and clear RAM conservatively, rather than copying every rule into
  every original. Rule/configuration state is never provided by a model.
- SQL prefilters trigger/transition/type. At most 100 matching candidates are
  processed; overload fails closed without a metadata request. This is a
  per-event work bound, not a total rule-count restriction: a regression enables
  151 rules and successfully executes the selected trigger. Original retention
  remains 30 minutes, 500 entries, 8 MiB / 64 KiB, including revision metadata.
- Reactor/chat admission budgets are written before live group metadata reads:
  **3/reactor and 10/chat attempts per fixed 60-second window**, starting on the
  first attempt. Selected rules have **5 action attempts/window**. Trusted
  aliases share budgets; learning an alias cannot reset an existing budget.
  Nonmatching reactions perform no metadata/provider work. Two global jobs
  across socket generations, one per proven reactor, **zero waiting queue**.
  A cancelled provider ignoring its signal occupies its slot until it settles.
- Before provider submission and final delivery, refresh source-group
  membership and resolve the actual reactor through primary role records and
  bounded authoritative LID mappings. Verify reactor, original author and bot
  still have source access. Apply live command permission, disabled-command,
  blacklist, sender-filter and STT capability checks. No permission default or
  command-level requirement changed; the original author supplies no authority.
- STT requires a verified PTT original. It reuses `downloadMedia`,
  `assertWhatsAppAudio`, `assertAudio` and the existing `stt.transcribe`, including
  provider selection/key checks, byte/output limits and cancellation. There is
  no historical/quoted-audio search, new provider implementation, media archive
  or temporary media file. Ping executes the existing command behind the same
  validated delivery adapter. Replies use existing four-language strings.
- Delivery uses Phase 05 `planDelivery`, with source sensitivity and only the
  two supported rule destinations. Owner identity comes from paired credentials,
  never a configured number. Cross-chat replies omit the original quote.
  `sendBotMessage` propagates a private guard to `core/socket.js`: after all
  async preparation and remote membership refresh, a synchronous live local
  rule/permission/destination guard and AbortSignal check immediately precede
  Baileys. Normal callers without the optional guard keep their behavior.
- Kill, rule edit/disable/delete, group changes, original edit/delete/eviction,
  disconnect and deadlines cancel pending work. Refused/rejected sends remain
  failures and never get a raw-send retry. Fixed outcome codes contain no
  transcript, private original, event args or provider error details.

### Confirmed findings and fixes

1. Removal dropped the previous emoji, preventing specific removal rules.
   Return it from the atomic intake transition without changing the legacy
   string-return contract used by existing claim callers.
2. Legacy digit-only identity lookup and normal contact metadata merging could
   make a coincident LID appear on an owner/admin record. Strict reaction roles
   read only primary JIDs expanded through authoritative mappings, ignoring
   mutable contact aliases. Recognized bot metadata is rejected before intake
   sanitation; self originals/reactions and generated bot output are excluded.
3. Explicit role writes (including linked-owner bootstrap) could grant a role
   to the wrong same-digit primary record. A deterministic regression failed
   four checks before the fix. Role writes now use exact/proven identities.
   Separate mapped PN/LID records also exposed incomplete revocation; explicit
   role updates now cover all proven primary aliases. Exact owners/admins keep
   their permission levels; unrelated numeric collisions are denied, and
   revocations remove every alias's grant. Ordinary no-role contact updates do
   not change permission defaults or grant new roles.
4. Cache-first group roles could remain valid after demotion. Refresh membership
   before action/provider work, after download, and after final preparation;
   group events synchronously cancel affected jobs. A final synchronous guard
   catches local policy changes after asynchronous work.
5. Unmatched reactions initially reached remote metadata without spending an
   admission budget. Data-only filtering now precedes admission/RPC, and
   unauthorized matching attempts spend persistent reactor/chat budgets first.
   Regression storms make zero unmatched RPCs and stop matching spam at budget.
6. Per-socket concurrency would free capacity on reconnect while old ignored
   cancellations still ran. Slots now span all socket generations, remaining
   occupied until actual settlement; late old work cannot send.
7. Real owner-private delivery was always refused because `identity.cjs` called
   `authRead` on a facade that does not export it. It now reads the existing
   credential API directly from the DB store. A real wrapped-socket regression
   verifies linked-account delivery and removed cross-chat quoting; missing
   credentials still refuse without fallback.

The orchestrator reviewed every diff and ran all gates. Read-only Codex review
identified the role-write/revocation and metadata-storm issues. A delegated
implementer wrote only `reaction-engine.test.mjs` and ran no tests/builds.
Installed OpenCode free `opencode/glm-5.3-flash-free` and agy Gemini supplied
read-only audit notes. Their unsupported alias/asymmetry and clock/budget design
claims were checked against source rather than adopted blindly. Grok timed out
with partial source-location notes; no completed independent Grok review is
claimed. Read-only relay changed-file warnings reflect concurrent orchestrator
edits; no delegated application changes or test/build claims were adopted.

### Evidence and environment

All workstation verification uses installed Node **24.19.0**, Linux x64,
2026-11-07 UTC/Cairo, `npm_config_offline=true`, system
`FFMPEG_BIN=/usr/bin/ffmpeg`, and the external-network guard in
`tests/fixtures/no-external-network.cjs`. Only the owner-approved Git fetch
obtained repository commits. No dependencies, tools, runtimes, models or
artifacts were downloaded to the workstation. Official CI uses the repository's
pinned Node **24.22.2**; runner dependency downloads are owner-authorized.

| Gate at report preparation | Status and evidence |
| --- | --- |
| Baseline `npm test` on merged `b383ed1` | PASS: 10194 checks, 0 failures/crashes, 181.0 s |
| Focused final working-tree reaction suites | PASS: **449 checks** = 223 engine + 51 execution/migration + 150 intake + 25 legacy migration; deterministic fake sockets/providers, real outbound guard, fake timers and fresh processes |
| Existing `ai-media-cancellation` regressions | PASS: 44 checks, before full gate rerun |
| Pre-commit full `npm test` | PASS: **10467 checks**, 0 failures/crashes, 190.0 s; final five candidate-bound assertions were subsequently added and pass in the 449-check focused run |
| Pre-commit `npm run lint` | PASS: no errors; existing 196 warnings / 73 infos |
| Pre-commit `npm run i18n:check` / `npm run docs:check` | PASS; existing strings reused, no new translation certification |
| Pre-commit `npm run build:frontend` | PASS |
| Pre-commit `npm run validate:tarball` | PASS: 36 checks; offline cache install and real artifact boot |
| Pre-commit `npm run build:sea` / `npm run validate:sea` | PASS: 51 checks; executable embeds installed local Node |
| Final immutable PR-head reruns / GitHub CI | NOT RUN at this report's preparation; must be recorded in the PR verification record before owner handoff, with commit SHA, actual results and run URL |
| Local Docker/Android/macOS/Windows artifact builds | NOT RUN locally; applicable final-head GitHub CI must cover these builds |
| Live WhatsApp/reaction/STT/provider/device delivery | NOT RUN: no separately authorized dedicated accounts/credentials; mocks/builds are not device QA |
| 07c management API / four-language Rule Builder | NOT RUN, outside this slice |

Pre-commit JSON/logs: `/tmp/levix-p07b/precommit-results.json` (its `head` is
**the base of the dirty tested tree**, not a claim that those changes existed on
that base commit). Focused logs: `reaction-final-focused.log`,
`role-write-before.log`, `role-write-after.log`, `cancellation.log`. Final immutable
reruns use `/tmp/levix-p07b/final-results.json` and referenced logs; those results,
not the preliminary counts, determine the PR handoff status.

### Limits, rollback and exact 07c prerequisites

The contract is **at most one attempt per eligible event**, including one chosen
rule/action claim, within the bounded eligibility/retention window. Claims commit
before side effects. A crash after claiming, cancellation, saturation, refusal or
provider failure can lose an action; no automatic retry or lower-rule fallback.
An already initiated send can finish after cancellation and cannot necessarily
be retracted. Remote delivery is not exactly once. Unknown/deleted/stale originals
are skipped; unrelated external bots without recognizable metadata cannot always
be identified, so rate limits also bound other-client storms. Live dedicated-account
QA remains required before release claims about device/provider delivery.

Rollback without downgrade: stop Levix, set `reaction:enabled` to JSON `false`
in local `bot_settings` and disable `reaction_rules`, then restart. Keep schema
12 intact. There is no temporary management API. For an actual binary downgrade,
stop Levix and restore the verified schema-11 pre-migration copy per
`MIGRATION.md`; do not edit schema stamps or run an older binary on schema 12.
That secret-free copy requires re-entering API keys and pairing credentials.

07c may start only after owner review/merge of this 07b Draft PR and separate
owner authorization. Audit the merged release baseline, then build authenticated,
same-origin/CSRF-protected management over these internal methods; never expose
raw SQL/config writes. Validate definitions and show actionable statuses/operational
limits; preserve explicit disabled-by-default enablement/epochs and global kill.
Provide accessible responsive ar/en/pt-BR/es-419 controls using existing primitives,
with matching backend validation and deterministic auth/CSRF/four-language tests.
Any extra action/destination requires its own validation, authorization, routing
and cancellation coverage. No additional product decision is required for 07b's
initial allowlist. Phase 07.5, Phase 08, release/deploy/Play work have not started.

## Phase 07b integration with release/5.0.0-beta.1 (2026-11-08)

### Why

PR #136 (`feat/v5-phase-07b`, head `cc6a259`) was based on `b383ed1`. The
release branch moved to `4d6d191` with the Phase 07.5 E2EE work (PR #137),
Signal session console protection (#140), debug-log name redaction (#139) and
the dashboard polling fallback (#138). GitHub reported PR #136 as conflicting.

### Merge

Local merge `39f2f7a` of `cc6a259` into `4d6d191`. One textual conflict,
`src/core/events.js` `group-participants.update`. Resolution order:
`markRosterChanged(sock, id)` first (07.5, before any await), then
`automation.cancelChat(id)` (07b), then the contained participants handler.
`src/core/socket.js` and `src/db/store.cjs` merged without conflict; the final
send path is delivery guard refresh and assert, abort check, Baileys send, then
the 07.5 recent-message cache step.

No dependency change. Release adds no migration; schema 12 stays the last
migration, appended after 11.

Preservation audit (agy, Gemini 3.8 Flash, read-only): every 07.5 hunk in 21
source files and 11 test files is present unchanged in `39f2f7a`; the only
combined hunk is the events.js conflict above.

### Review findings and fixes

Read-only Codex review of `39f2f7a` found two interaction defects. Both are
fixed with regression tests.

1. `8f6e409` fix(session): logout fenced the old auth store and then awaited
   `sock.logout()` for up to `SOCKET_CLOSE_TIMEOUT_MS` before `#detach` closed
   the socket's reaction engine. A job paused on a media download could resume
   and start a paid transcription in that window. The reaction intake is now
   disposed synchronously before the fence, like every other teardown path.
   Test: `tests/session.test.mjs`, section "logout closes reaction automation
   before it waits for the socket"; on the unfixed code the assertion "reaction
   intake closed while socket logout() is pending" fails (expected 1, got 0).
   Implemented by agy (Claude Sonnet 5.5).
2. `b555014` fix(automation): the engine read rosters with a direct
   `sock.groupMetadata()`. The live answer never reached the 07.5 shared roster
   that Baileys uses to choose sender-key recipients, did not coalesce with a
   concurrent roster refresh and skipped the generation check. New
   `readLiveGroupMetadata()` in `src/utils/groupMetadataCache.cjs` joins or
   starts the shared fetch, follows supersession, writes the accepted answer
   back and never returns a cached or stale roster. A failed or superseded read
   now ends the job as `REACTION_INACCESSIBLE` (it was `ACTION_FAILED`). Tests:
   6 new cases in `tests/group-roster-sync.test.mjs` and 2 in
   `tests/reaction-engine.test.mjs`; on the unfixed code 6 and 2 fail.
   Implemented by Codex.

Codex delta review of `b555014`: READY, no new findings. Joining an in-flight
fetch is accepted because the shared fetch only returns an answer from the
current roster generation and participant changes cancel jobs synchronously.

Other review answers, all OK: send boundary ordering, key-store errors become
`ACTION_FAILED` with no retry or fallback send and slots released in `finally`,
unlink disables rules and clears the five transient reaction tables, backup
classification and disabled restore, `identity.cjs` credential reads after the
fence, the rewritten recent-message cache, permission composition, and logging
(fixed outcome codes only).

### Owner decision carried by 07b

`src/messaging/identity.cjs` in 07b reads the linked-account credentials from
the database store directly. Before, it called `authRead` on a module that does
not export it, so the Reply Router refused every linked-owner-private
destination (Phase 07.5 finding C-11, left open for the owner). With 07b, an
ordinary command reply can reach the linked account's own chat when Settings
`reply_route` names it. This is the documented Reply Router behavior. It needs
the owner's explicit approval as part of the 07b merge.

### Verification

Linux x64, Node 24.19.0, offline: `npm_config_offline=true`,
`FFMPEG_BIN=/usr/bin/ffmpeg`,
`NODE_OPTIONS=--require=<repo>/tests/fixtures/no-external-network.cjs`.

| Gate | Status |
| --- | --- |
| `npm test` on merge `39f2f7a` | PASS: 10890 checks, 0 failed, 361.6 s |
| `npm test` on final head `b555014` | PASS: 10945 checks, 0 failed, 333.9 s |
| Focused: `session.test` / `group-roster-sync` / `reaction-engine` on `b555014` | PASS: 196 / 183 / 235 checks |
| `npm run lint` on `b555014` | PASS: 0 errors, 208 warnings (same as release `4d6d191`), 80 infos (74 on release; 6 new lone-block infos in the new roster tests) |
| `npm run i18n:check`, `npm run docs:check` | PASS |
| `npm run build:frontend` | PASS |
| `npm run validate:tarball` | PASS: 36 checks |
| `npm run build:sea`, `npm run validate:sea` | PASS: 51 checks |
| GitHub CI (Android, Docker, macOS, Windows) on the updated PR head | NOT RUN: waits for owner approval to push |
| Live WhatsApp, reaction, STT or provider QA | NOT RUN: not authorized |

### Status

Integration branch `integration/v5-phase-07b` (local only). Updating PR #136 is
a fast-forward of `feat/v5-phase-07b` (no force push), after owner approval. No
merge, release or Play upload.

Phase 07c (Rule Builder) starts only after PR #136 is merged and the owner
approves.

## Phase 07c audit and implementation plan (2026-11-08, before code)

Baseline: `release/5.0.0-beta.1` at `ba7ef44` (PR #136 merged 2026-11-08 21:21 UTC).
Branch: `feat/v5-phase-07c`. The owner authorized 07c in the session prompt of
2026-11-08 and asked for a PR against `release/5.0.0-beta.1`, with no merge.

### Google Play Closed Testing status

The latest run of "Android Beta → Closed Testing (automatic)" is
42074694325, from `main`, on 2026-11-05, conclusion `success`. No run exists for
`release/5.0.0-beta.1`. The owner's 2026-11-08 rules forbid another Google Play
publication, so 07c triggers none. Play Console state beyond the workflow result
was not checked (no console access in this session).

### Audit

| id | finding | evidence |
| --- | --- | --- |
| A-1 | Internal writes exist and notify running engines. There is no list query and no field-level validation: every defect throws one `REACTION_RULE_INVALID`. | `src/db/store.cjs:325-365`, `src/automation/rules.cjs:49-77` |
| A-2 | Every non-GET request already passes the global same-origin guard; `/dashboard/api` sits behind `requireLoginApi`; the session cookie is `SameSite=lax`. New routes inherit all three. | `app.cjs:57-78`, `app.cjs:126-138`, `app.cjs:180`, `src/bootstrap/panel.js:57-65` |
| A-3 | Action outcomes exist only in RAM, per socket (`stats()`), with no rule id. Nothing persisted can show execution status. | `src/automation/engine.js:63-72`, `:363-365` |
| A-4 | Rate limits are literals in the engine (3 per reactor, 10 per chat, 5 per rule per 60 s, 2 global jobs). Lookup limits are exported as `REACTION_LIMITS`. | `src/automation/engine.js:256`, `:319-330`, `src/automation/reactions.js:12-17` |
| A-5 | The Auto-delete screen is the closest UI pattern: hash route, sidebar entry, card list, Dialog editor, `RecipientPicker` over `GET /recipients` (groups and contacts). There is no emoji picker and no frontend unit-test runner. | `frontend/src/views/autoDelete/`, `frontend/src/components/RecipientPicker.tsx`, `src/routes/dashboard.api.esm.js:1259` |
| A-6 | Backups already classify `reaction_rules` as account data; the global switch is not restorable and activation resets rules. 07c changes nothing here. | `src/backup/content.cjs:9-23`, `src/backup/activation.cjs:126-128` |
| A-7 | More than 100 enabled rules matching one event fail closed with `REACTION_CAPACITY`. This is a per-event work bound, not a rule cap. The UI must warn about it. | `src/automation/engine.js:220`, `src/db/store.cjs:366-376` |

### Design

1. `rules.cjs` gains `definitionIssues(value)`, which returns `[{ field, code }]`.
   `validateDefinition` throws when that list is non-empty. Accepted and rejected
   inputs stay identical; a parity test pins it. This gives the UI field errors
   without a second validator.
2. `store.cjs` gains `listReactionRules()` (ordered by chat, priority, id). No other
   store change. No migration: schema stays 12.
3. New `src/automation/status.cjs`: process-local RAM record per rule id of the
   last outcome code, its time and per-code counts since start, plus one global
   record for outcomes with no selected rule. At most 1,000 rule entries; an edit,
   disable or delete clears that rule's entry. Codes only, never payloads. The
   engine records into it; nothing writes it to disk.
4. The engine exports its action limits (`REACTION_ACTION_LIMITS`) and one pure
   readiness helper for the command and STT checks it already performs, so the
   management layer reports the same conditions without copying them.
5. New `src/automation/manage.js`, the only management facade: overview, create,
   update, enable/disable, delete, global switch and draft check. It calls the
   store methods above, computes statuses, and maps store errors to typed errors
   (400, 404, 409). Optimistic concurrency: update, enable/disable and delete
   carry the rule `revision` the client read; a mismatch returns 409
   `REACTION_RULE_CHANGED`.
6. New `src/routes/reactions.api.esm.js`, mounted with the other panel routers:

   | method and path | body | result |
   | --- | --- | --- |
   | `GET /dashboard/api/reactions` | — | `{ success, automation: { enabled }, connection: { connected }, owner: { linked }, limits, rules: [RuleView] }` |
   | `POST /dashboard/api/reactions/rules/check` | `{ chatJid, priority, definition }` | `{ success, issues: [{ field, code }] }` (no write) |
   | `POST /dashboard/api/reactions/rules` | `{ chatJid, priority, definition }` | `201 { success, rule }`, always disabled |
   | `PUT /dashboard/api/reactions/rules/:id` | `{ revision, chatJid, priority, definition }` | `{ success, rule }`; an edit disables the rule (07b contract) |
   | `POST /dashboard/api/reactions/rules/:id/enabled` | `{ revision, enabled }` | `{ success, rule }` |
   | `DELETE /dashboard/api/reactions/rules/:id?revision=` | — | `{ success }` |
   | `PUT /dashboard/api/reactions/automation` | `{ enabled }` | `{ success, automation }` |

   `RuleView` is `{ id, revision, chatJid, chatName, priority, enabled, enabledAt,
   definition, valid, statuses: [code], overlaps: [ruleId], runtime: { lastCode,
   lastAt, counts } }`. Status codes: `AUTOMATION_OFF`, `RULE_OFF`,
   `RULE_INVALID`, `NOT_CONNECTED`, `ACTION_DISABLED`, `STT_DISABLED`,
   `STT_KEY_MISSING`, `OWNER_NOT_LINKED`, `CANDIDATE_LIMIT`, `READY`. Overlaps
   list rules in the same chat with the same emoji and shared transitions and
   types that run first (lower priority number, then id). Errors are
   `{ success: false, error: CODE, issues? }` with fixed codes that the UI
   translates. Unknown body keys are rejected; a client cannot set `id`,
   `enabled` on create, `enabledAt` or `revision` values.
7. React screen `#reactions` ("Reaction rules"), built only from
   `frontend/src/components/ui`: a global automation `Toggle` with the opt-in
   notice and the limits; an Add rule button; rule cards with emoji, chat,
   action, destination, sender role, priority, status pills and the last outcome;
   a per-rule `Toggle`; an `OverflowMenu` with Edit and Delete; `FilterButton` and
   `SortMenu`; pagination at 20 per page. The editor `Dialog` uses
   `RecipientPicker` for the chat and for specific senders, an emoji field with a
   short palette, checkboxes for transitions and message types, a role select, a
   segmented action control (STT locks types to voice notes), destination radios,
   a priority number and a live sentence preview. Server issues appear under their
   fields. Saving tells the user that an edited rule starts off.
8. Strings: `i18n/<locale>/dashboard.json` in `en`, `ar`, `pt-BR`, `es-419`, then
   `npm run i18n:build`. pt-BR and es-419 follow the Q-19 ChatGPT review rule.

### Tests

- `tests/reactions-api.test.mjs`: 401 without a session on every route; 403 for
  cross-origin and opaque-origin mutations; 400 with field issues; created rules
  start disabled; edits disable and rotate the revision; stale revision 409;
  enable, disable, delete, global switch; unknown and smuggled keys rejected; 150
  rules create and list (no tier cap); `OWNER_NOT_LINKED` while unpaired; running
  engines are notified on every write.
- `tests/reaction-rule-issues.test.mjs`: parity of `definitionIssues` with the
  old accept/reject results over the 07b vectors and a generated corpus.
- `tests/reaction-status.test.mjs`: bounded RAM status, cleared on edit and delete,
  codes only, never persisted.
- `tests/reaction-ui-static.test.mjs`: every `t()` key in `views/reactions/` exists
  in all four catalogs; no physical-direction classes, raw hex colours or one-off
  palettes; imports come from the UI barrel.
- Existing i18n catalog, dashboard locale, headless and backup tests stay green.
- Manual headless browser run of the screen in all four languages, desktop and
  360 px width, light and dark (puppeteer-core, scratch data directory, no
  WhatsApp pairing).

### Threats and privacy

- CSRF and auth: inherited guards, proven per route by tests.
- Mass assignment: strict key allowlists in the facade and the 07b validator.
- Stored XSS: React escaping; chat and sender names through `UserText`.
- Lost updates: revision check, 409.
- Information exposure: status codes and counts only; no message text, transcript
  or provider detail.
- Privacy impact: no new persistence. Outcome counts live in RAM and reset on
  restart. Chat names come from the same directory the panel already shows.

### Compatibility, rollback and acceptance

- No migration; schema 12. Headless never imports the route. The SEA bundle,
  tarball, Docker and Android WebView carry the new route and view like the
  other panel routes.
- Rollback: revert the PR. Rules and the switch stay in the database; turn the
  global switch off before downgrading. No data conversion is needed.
- Acceptance: owner can create, edit, delete, enable and disable rules and flip the
  global switch from the panel in four languages; every mutation is authenticated
  and same-origin; validation errors name the field; statuses explain why a rule
  will not run; no rule-count cap; 07b engine, limits, kill switch and opt-in
  unchanged; no Plus code and no AI Auto Reply.

### Delegation

07c-1 backend (rules issues, list query, status, facade, routes, tests) and 07c-2
UI (view, editor, client, types, navigation, en and ar strings) run in parallel
in separate worktrees against the contract above. 07c-3 adds pt-BR and es-419
strings. Agents do not run gates; the orchestrator runs every test, build and
review, then commits.

## Phase 07c implementation, review and verification (2026-11-09)

Status: **IMPLEMENTED, PENDING OWNER REVIEW** on `feat/v5-phase-07c`, based on
`ba7ef44`. No merge, release, tag, deployment or Google Play upload.

### What shipped

- `src/automation/rules.cjs`: `definitionIssues()` returns field issues;
  `validateDefinition()` throws when the list is non-empty. A parity test runs a
  frozen copy of the 07b validator over its vectors and 768 mutated definitions.
- `src/db/store.cjs`: `listReactionRules()`. `clearReactionAccountState()` now
  emits `{ type: "policy", account: true }`; existing listeners still see a
  `policy` event.
- `src/automation/engine.js`: exports `REACTION_ACTION_LIMITS` (3 per reactor,
  10 per chat, 5 per rule per 60 s, 2 global jobs, 100 candidates per event) and
  `reactionActionReadiness()`, which the engine itself uses for the disabled
  command, `ai_stt_enabled` and STT key checks. Outcomes are recorded against a
  rule only while the rule still has the revision the job selected.
- `src/automation/status.cjs`: RAM-only outcome record per rule (last code, time,
  per-code counts), at most 1,000 rules, fixed code allowlist, cleared on any
  change to that rule and fully reset with an epoch on account clearing.
- `src/automation/manage.js` and `src/routes/reactions.api.esm.js`: the seven
  routes of the plan, strict body allowlists, revision checks (409), fixed error
  and issue codes, statuses, alias-aware overlaps and per-event candidate count.
- React screen `#reactions` with the global switch, rule cards, statuses, last
  outcome, filter, sort, pagination, delete confirmation and the rule editor.
  The shared `Field` primitive now gives its message an id
  (`${htmlFor}-message`); `RadioGroup` accepts `id` and `aria-describedby`.
- 164 strings in each of `en`, `ar`, `pt-BR`, `es-419`. pt-BR and es-419 are a
  machine draft pending ChatGPT review (Q-19), recorded in `i18n/review.json`.

### Reviews and fixes

Codex (read-only) reviewed four rounds.

| round | findings | fixed |
| --- | --- | --- |
| 1 | 2 P1 (editor could save one rule's draft onto another; polling refreshed the revision under an open draft), 8 P2 (issue fields, untrusted stored rows, toggle race, stale status after edit, status kept across unlink, candidate count semantics, two misleading strings), 1 P3 (preview wrapping) | all |
| 2 | 2 P2 (conflict reload overwrote newer state; every keyless policy event wiped status) | all |
| 3 | 2 P2 (discarded reload still rolled back; unnamed radio and checkbox groups) | all |
| 4 | 1 P2 (action group unnamed) | fixed in `af647d0` |

The orchestrator's own QA found one more: error text was not linked to its
control (`aria-describedby`); fixed in the shared `Field` primitive.

### Evidence (local, Linux, Node v24.22.2)

| gate | commit | result |
| --- | --- | --- |
| `npm test` | `88f5ed2` | PASS, 13380 checks, 0 failed |
| `node tests/run.mjs reaction-ui-static` | `af647d0` | PASS, 174 checks |
| `npm run lint` | `af647d0` | PASS (exit 0) |
| `npm run i18n:check` | `af647d0` | PASS |
| `npm run build:frontend` | `af647d0` | PASS |
| `npm run docs:check` | `88f5ed2` | PASS |
| `npm run validate:tarball` | `88f5ed2` | PASS, 36 checks |
| `npm run build:sea` + `validate:sea` | `af647d0` | PASS, 51 checks |
| headless Chrome QA, 4 languages x (1280 px light, 360 px dark) | `88f5ed2` build | PASS, 46/46: lang and dir, no horizontal overflow, no raw keys or codes, editor focus |
| headless edit flow: field issue, 409 on concurrent change, saved edit returns off | `88f5ed2` build | PASS, 9/9 |
| `validate:docker` | — | NOT RUN locally (Docker socket permission, as in Phase 04); CI runs it |
| GitHub CI | final head | recorded in the PR |
| Android WebView on a device | — | NOT RUN |
| live WhatsApp reaction with a paired test account | — | NOT RUN (no live side effects; the 07b engine is unchanged) |

`af647d0` differs from `88f5ed2` only by one `aria-label` in the editor.

### Limits and rollback

- Outcome counts live in RAM and reset on restart, unlink and account activation.
  More than 1,000 rules keep status only for the 1,000 most recently recorded.
- The overview returns every rule in one response; there is no server paging.
- Rollback: revert the PR. No migration was added (schema 12). Rules and the
  switch stay in the database; turn the switch off before reverting.

### Final review round (2026-11-09, before owner review)

An owner-requested pass on head `31ef4f9` confirmed two findings and three audit
items in 07c scope. All were fixed on `feat/v5-phase-07c`; nothing was merged.

| id | finding | fix | commit |
| --- | --- | --- | --- |
| A | Global switch race: a second PUT could be sent while the first was in flight. An older ON committing after a newer OFF left the server ON while the panel showed OFF, which defeats the kill switch. Ignoring the older response in the UI did not stop the older server write. Polls overlapping the write could also flip the switch to a stale value. | One automation write at a time; further clicks are ignored until it settles (the switch reports `aria-busy`). The write counter is bumped at start and settle, so overlapping polls and an overlapping initial load are discarded or followed by a reconcile. A failed write shows the previous value and reconciles with the server. `createAutomationWriter` is React-free; `tests/reaction-ui-logic.test.mjs` drives it with deferred and out-of-order requests. | `e4e1d12` |
| B | "Newest" sorted by last run, else last enable time. Rules have no creation timestamp. | The option is "Recent activity" (`reactionSortRecent`) in all four locales; ties stay ordered by id. No migration. | `e4e1d12` |
| C-5 | A stored rule that no longer validates could not be turned off (400); only delete worked. | The stored definition is validated only when enabling, in `manage.js` and the store. Enabling an invalid rule is still refused. | `62fb948` |
| C-1 | The overlap note said earlier rules "take precedence"; the engine runs the first enabled rule whose sender filter matches. | Copy now says that, in four locales. | `62fb948` |
| T-1 | Machine terminology pass over all 164 pt-BR and es-419 reaction strings (OpenCode deepseek-v4.1-flash). | 5 es-419 strings aligned on activada/desactivada and "dispararla"; pt-BR had none. Still a machine draft pending the ChatGPT review (Q-19); no native speaker has verified it. | `2bafc41` |
| R-1 | Independent read-only review of the fixes (OpenCode deepseek-v4.1-flash): a natively disabled switch drops keyboard focus when a write starts. | The switch announces `aria-busy` and the writer's guard ignores clicks; focus stays. | `f3f6ef9` |
| R-2 | Same review: `i18n/review.json` hashed the pre-fix pt-BR and es-419 catalogs, so `i18n:check` warned. | Hashes refreshed; review status text unchanged. | `f3f6ef9` |

Concurrent browser tabs remain a residual risk (R-3, not fixed). Each tab
serializes its own writes, but the server applies requests from different tabs
in arrival order. If tab A's ON stalls, tab B's later OFF commits first, and A's
ON then lands, the server ends ON while tab B shows OFF until its next poll
(30 s, or on focus; a hidden tab does not poll). The fix is an optimistic
revision on `PUT /reactions/automation` with 409 on a stale write, like rules
already have. That changes the API body, so it is left for the owner to decide.

Phase 07.5 (architecture stabilization) runs on a stack based on this branch;
see `PHASE-07.5-ARCHITECTURE-RESULTS.md`.

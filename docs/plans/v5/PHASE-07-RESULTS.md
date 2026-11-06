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
| Pre-commit full suite | PASS: 10192 checks, 0 failures/crashes, 327.5 s; the last metadata-sweep guard is additionally covered by the 25-check focused migration run. Final-head rerun belongs to the PR record. |
| Lint | PASS, existing 196 warnings / 73 infos, no errors |
| i18n validation and docs freshness | PASS; no new UI strings or locale approval claims |
| Frontend TypeScript/Vite build | PASS; existing bundle warnings |
| Tarball installation and boot | PASS: 36 checks, installed FFmpeg and offline npm cache |
| SEA build / artifact validation | PASS: 51 artifact checks; local executable embeds installed 24.19.0 |
| Final-head GitHub CI, Android and Docker | NOT RUN at this report's preparation; final head, run URL and job conclusions must be recorded in the PR before handoff |
| Local Docker, Windows/macOS SEA and Android builds/device QA | NOT RUN locally; applicable artifact/build coverage belongs to final-head CI |
| Live dedicated-account WhatsApp/reaction/provider QA | NOT RUN; not authorized |
| 07b roles/disabled commands/cross-chat delivery/STT/action dedupe/rates/cancel/kill switch | NOT RUN: no action executor in 07a; required in 07b |
| 07c authenticated/CSRF-protected four-language accessible Rule Builder | NOT RUN: no management API or UI in 07a; required in 07c |

Local pre-commit evidence is `/tmp/levix-p07a-reviewed-*-results.json` and its
referenced logs. Those runs name the baseline HEAD plus the reviewed working
changes, not an immutable implementation commit. After committing, rerun the
gates on the immutable final head and put that SHA, exact results and CI run
in the PR verification record. This avoids embedding a commit's own hash or
claiming future CI results in a committed file.

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

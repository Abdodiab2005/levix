# Levix 5.0.1 corrective release plan

Status: plan, 2026-11-20. Nothing in this file is shipped behaviour yet.
Owner brief: "LEVIX v5.0.1 — strict UI/UX, reaction commands and AI auto-mode
remediation". This plan adds to `AGENTS.md` and the v5 ADRs; it removes none of
their rules.

## 1. Baseline

| Repository | Branch | Commit | State |
| --- | --- | --- | --- |
| `Abdodiab2005/levix` | `main` | `34f7644` | clean, version 5.0.0, Android versionCode 78 |
| `Abdodiab2005/levix-plus` | `main` | `038d6bf` | clean, `core.lock.json` pins Core `81cfeac` |
| `Abdodiab2005/levix-ui` | `main` | `f2ca096` | clean, not expected to change |

Play has used versionCodes up to 79 (79 = 5.0.0 production, uploaded by the
private repository). 78 was never uploaded.

Baseline gates: recorded in section 9 when first run on `release/5.0.1`.
Physical-device screenshots were not attached to the brief, so the UX evidence
in this plan comes from source, not from the device.

## 2. Audit sources

Read-only audits, 2026-11-20, on the commits above:

- AUD-1 (Codex): reaction engine, command dispatcher, catalog eligibility.
- AUD-2 (Grok): Plus Auto Reply, Core extension host, AI decisions.
- AUD-3 (Antigravity, Gemini Flash): panel UI and design system.
- AUD-4 (orchestrator): versioning, migrations, CI gates.

## 3. Confirmed defects

Each item was proven by reading the code. "Suspected" items need runtime
evidence and are listed in section 4.

| ID | Defect | Evidence |
| --- | --- | --- |
| R-1 | Every reaction from the linked owner's phone is rejected. Intake requires `fromMe === false` on the reaction key and on the original key, and rejects self identities. The editor defaults new rules to sender role `owner`. A default rule can therefore never fire for the person who set it up. | `src/automation/reactions.js:73-90`, `:338-357`; `frontend/src/utils/reactionRules.ts:104` |
| R-2 | The rc14 `lid-mapping.update` payload is one `{ lid, pn }` object. Levix iterates `Object.entries`, so it stores the literal strings `lid` and `pn` as a mapping. Alias reads can then return `pn`. | `src/core/events.js:115-125` |
| R-3 | Reaction rules support only `ping` and `stt`. Both bypass the protected text dispatcher: ping calls `execute` with the original message as `msg`, STT is a separate flow. | `src/automation/rules.cjs:82`, `src/automation/engine.js:300-330` |
| R-4 | An in-flight add can outlive a later remove or change. The token is not compared with the latest `reaction_state` emoji. | `src/automation/reactions.js:374`, `:438` |
| R-5 | Reaction jobs check the status epoch, not `store.accountEpoch()`. | `src/automation/engine.js:132`, `:369` |
| R-6 | The global reaction switch defaults off, new rules default off, an edit disables the rule, and the original must arrive after enablement. Nothing in the panel says why a rule does not fire. | `src/db/db.cjs:718`, `src/db/store.cjs:447-487`, `src/automation/engine.js:121`, `:259` |
| A-1 | Auto Reply scope is an allowlist only. The host copies `scope()` into a `Set` of JIDs, so "all" and "all except" cannot be expressed. | `src/extensions/host.cjs:193-206`, `src/extensions/autoReply.cjs:178-183` |
| A-2 | Core continues only when `decision.reply === true`. There is no react or silent outcome. | `src/extensions/autoReply.cjs:496-510` |
| A-3 | A command that throws falls through to Auto Reply. | `src/handlers/message.handler.js:144-148` |
| A-4 | A plain disconnect does not cancel in-flight Auto Reply turns. | `src/core/session.js:1195-1222` |
| A-5 | Auto Reply runs the model with tools on. A tool can send into the chat before the turn ends. | `src/extensions/autoReply.cjs:340-360`, `src/services/aiTools.cjs:1512-1519` |
| U-1 | The login page renders a two-column marketing hero (headline, lede, trust copy). | `frontend/src/gateway/main.tsx:152-167`, `frontend/src/gateway/style.css:1-8` |
| U-2 | `loginError.message` and `setupError.message` reach the page. The raw-error guard regex misses them. | `frontend/src/gateway/login.tsx:288-293`, `frontend/src/gateway/main.tsx:209-214`, `tests/ui-no-raw-keys.test.mjs:133` |
| U-3 | The account card reads the name only from `sock.user.name` and the phone only from a phone-number `user.id`. A QR-linked session often has no `user.name`. | `src/panel/account-profile.cjs:91-124` |
| U-4 | Connection page puts Stop and Unlink as large danger buttons in a "danger zone" card. Unlink is not in an overflow menu. | `frontend/src/views/ConnectionView.tsx:479-509` |
| U-5 | Overview has no Needs Attention, Quick Actions or Recent Activity. Its quick cards repeat the sidebar. It has English fallbacks. | `frontend/src/views/OverviewView.tsx:102`, `:116`, `:164-200` |
| U-6 | Plus Auto Reply shows raw JIDs and asks the operator to type them, although `RecipientPicker` already exists. | `frontend/src/views/plus/AutoReplyTab.tsx:314`, `AutoReplyChatEditor.tsx:154-171`, `frontend/src/components/RecipientPicker.tsx` |
| U-7 | Plus Messages and Presets show raw placeholders (`{quotedText}`, `{count}`) in list items. | `frontend/src/views/plus/TemplateEditor.tsx:47-57`, `MessagesTab.tsx:215` |
| U-8 | Design guards cover four files. Nothing scans every view for raw colours, physical CSS, raw JIDs, untranslated fallbacks or wrapped raw errors. | `tests/account-card-state.test.mjs`, `tests/reaction-ui-static.test.mjs` |

## 4. Suspected runtime failures

| ID | Suspicion | What decides it |
| --- | --- | --- |
| S-1 | Group reactions fail when the original is cached under a phone JID and the reactor key carries a LID (or the reverse). | rc14 device capture of `participantAlt` / `remoteJidAlt` |
| S-2 | Originals delivered as `append` (offline, reconnect) never enter the lookup. | device test after reconnect |
| S-3 | A private-chat echo of the bot's own reaction arrives with `fromMe: false`. | device capture |
| S-4 | The account card shows no name because app-state sync never delivers `pushNameSetting` with history sync off. | device: name before and after the first own message |

## 5. Owner contracts for 5.0.1

- C-R1 Reaction execution never edits or deletes the original message.
  Reaction dispatch passes `editInPlace: false` explicitly, and its socket
  wrapper refuses any `edit` or `delete` whose key is the original key.
  Permissions, target resolution and normal delivery (same chat, quoted under
  the original) are unchanged.
- C-R2 One command engine. A reaction resolves to a canonical command and
  validated args, and runs through the same executor as a typed command. The
  reaction engine keeps rule admission (emoji, transition, original type,
  sender filter, rate limits) and nothing else.
- C-R3 The reactor is the requester. The original author is only a quote or a
  target. A rule never supplies `fromMe`, a requester, a role, a destination JID
  or mentions.
- C-R4 Access never widens. A reaction runs only when the rule's sender filter
  AND the command's live permission, chat scope, `userAdminRequired` and
  `botAdminRequired` all pass.
- C-A1 Migration never widens Auto Reply. A stored config keeps its exact chat
  list (`scopeMode: "only"`). Only a new install defaults to all private chats,
  groups off, master switch off.
- C-A2 A react decision is a WhatsApp reaction on the incoming message. React
  and silent leave no progress message and send no typing presence.

## 6. Design decisions

Ordinary decisions taken by the orchestrator under the brief. Codex reviews them
before merge; disputed points go back to the owner.

### 6.1 Emoji Commands (PR-2)

1. `executeCommandInvocation(sock, invocation)` in
   `src/handlers/command.handler.js` becomes the one protected executor.
   `handleCommand` is the text adapter. The reaction adapter builds an
   invocation with: canonical command, validated args, a command-shaped message
   whose key is the reactor's transport key in the source chat, the original as
   `contextInfo.quotedMessage` with its verified author as `participant`, a
   reply anchor (the original), `editInPlace: false`, the protected original
   key, and the entry account epoch.
   The command-shaped message is exactly what WhatsApp would deliver if the
   reactor had replied to the original with the command text. Existing sender
   derivation therefore behaves as it does for a typed command.
2. Rule definition version 2: `command: { name, args }`. Version 1 `action:
   "ping" | "stt"` reads as `{ name: "ping" | "stt", args: [] }`. No SQL
   migration; a rule is rewritten as version 2 on its next save.
3. `src/automation/commandEligibility.cjs` classifies every loaded command:
   `none` (no args), `quote` (uses the original), `args` (fixed plain-text args
   with a per-command schema), or `unsupported` with a reason code. A command
   missing from the table is unsupported. A test enumerates the live catalog
   and fails on any unclassified command.
4. Supported in 5.0.1: commands that only read or reply, and quote-target
   moderation (`group:kick`, `group:promote`, `group:demote`,
   `group:clearwarns`). Unsupported in 5.0.1: account-wide or session actions
   (`block`, `unblock`, `restart`, `stopbot`), settings and role changes
   through fixed args (`setprefix <x>`, `perm add`, `setname`, `setrules`,
   `setwarn`, `autodelete add`, `approveall on`), durable jobs (`schedule`,
   `autoschedule`, `deleteschedule`), the `group` wrapper, and commands with a
   known defect (`notes`, `score`, `group:setpp`, `group:warn`, `group:warns`,
   `debt`). The editor shows these as unavailable with the reason.
5. Destructive commands (`kick`, `promote`, `demote`, `clearwarns`) accept the
   add transition only, and claim one operation per account, chat, original,
   verified target and command. A re-add or another reactor cannot repeat it.
6. A denied or ineligible reaction sends nothing to the chat. Its outcome is
   recorded in the rule status. A typed command keeps its denial replies.
7. Intake accepts the linked owner's reactions. A reaction or original that
   Levix itself sent (recent sent-message cache) is rejected, which also stops
   AI reactions from triggering rules. Originals the owner typed on the phone
   are eligible.
8. New rules default to the add transition. Existing transitions are kept.

### 6.2 Auto Reply scope (PR-3, Core + Plus)

1. Plus document gains `schemaVersion: 1`, `scopeMode` (`all` | `except` |
   `only`), `groupsEnabled`, `excludedChats` (JIDs), and a root `policy` for
   chats without a row. `chats` keeps per-chat rows used by `only`.
2. A stored document without `schemaVersion` that passes the old validator
   becomes `scopeMode: "only"`, `groupsEnabled: true` (listed groups stay
   eligible, unlisted groups stay out), `chats` unchanged. No stored document
   means `scopeMode: "all"`, `groupsEnabled: false`, `enabled: false`. A stored
   document that fails validation stays ignored and the fallback is
   `enabled: false`, `scopeMode: "only"`, no chats.
3. `scope()` may return a descriptor `{ mode, groupsEnabled, chats, excluded }`.
   A plain string array from an older runtime still means `only`. Core's
   prefilter and Plus `consider` apply the same predicate, with
   `normalizeJid` on both sides.
4. Unlisted groups in `all` and `except` use the root policy group trigger
   (default `mention`); private chats default to `all`.

### 6.3 Auto Reply decisions (PR-4, Core + Plus)

1. Deterministic: a whole message that is only thanks or laughter (normalized,
   four languages, emoji included) gets a reaction, with no model call.
2. Otherwise one classification call with no tools, no search and a forced
   decision tool on all three providers: `reply { text }`, `react { emoji }`,
   `silent`, or `task`. `task` runs the existing agent with tools and
   `status: null`. Invalid output is `silent`.
3. A reaction is `{ react: { text, key } }` with the pending entry's key, sent to
   the source chat through `sendBotMessage` with the delivery guard. It never
   goes through `routeSend`.
4. Typing presence starts only after the decision is `reply` or `task`.
5. A command that throws no longer falls through to Auto Reply. A disconnect
   aborts in-flight turns.

### 6.4 Panel UI (PR-1, PR-5, PR-6)

1. The design contract extends `frontend/src/components/ui/README.md`. A new
   static guard scans every file in `frontend/src/views` and
   `frontend/src/gateway`. It rejects: raw hex and palette classes, physical
   layout classes, `<button>` without an accessible name, raw JID rendering,
   `.message` of any error object in JSX, English `||` fallbacks after `t()`,
   and hand-rolled primitives listed in the README. Existing exceptions (the
   sticker colour pickers) are an explicit allowlist with a reason per line.
2. A scratchpad browser script checks horizontal overflow and captures
   screenshots at 360, 393, 412, 768 and 1280 px, light and dark, four locales.
   It is QA tooling and adds no repository dependency.
3. Login keeps every auth contract (form `action`/`method`, async submit,
   screen guard, Android bridge, reset v2) and drops the hero.
4. One account card component with `compact` and `expanded` variants. Name
   fallbacks: `sock.user.name`, `verifiedName`, `creds.me.name`, then the
   linked account's last own `pushName`. Never a LID shown as a phone number.
5. Connection: Reconnect and Stop as `IconButton`s, Start/Resume primary when
   stopped, Unlink in `OverflowMenu` with the existing confirmation, Restart
   only where supported.
6. Overview: account card, stats, Needs Attention from real state only, Quick
   Actions to operations, Recent Activity only when data exists. No new
   expensive scans per refresh.
7. Plus: subscription summary, Auto Reply with master switch + scope + groups
   toggle + `RecipientPicker`, Messages as a searchable list with readable
   previews (placeholders only in the editor), Presets with collapsed examples.

## 7. Implementation matrix

| PR | Branch | Repos | Main files | Implementer | Depends on | Migration |
| --- | --- | --- | --- | --- | --- | --- |
| PR-0 | `release/5.0.1` | levix | this plan | orchestrator | — | none |
| PR-1 | `feat/v501-design-contract` | levix | `frontend/src/components/ui/*`, `tests/ui-design-contract.test.mjs` | Antigravity | PR-0 | none |
| PR-2 | `fix/v501-reaction-commands` | levix | `src/automation/*`, `src/handlers/command.handler.js`, `src/core/events.js`, `src/db/store.cjs`, reaction routes, `tests/reaction-*` | Grok | PR-0 | rule JSON v1 read as v2, no SQL |
| PR-2b | `feat/v501-reaction-editor` | levix | `frontend/src/views/reactions/*`, `frontend/src/utils/reactionRules.ts`, i18n | Antigravity | PR-1, PR-2 | none |
| PR-3 | `feat/v501-autoreply-scope` | levix + levix-plus | `src/extensions/*`, `runtime/src/autoReply.cjs`, `runtime/src/validation.cjs` | Antigravity | PR-0 | Plus doc v0 to v1, never wider |
| PR-4 | `feat/v501-autoreply-decisions` | levix + levix-plus | `src/extensions/autoReply.cjs`, `src/services/aiAgent.cjs`, `src/services/aiProviders.cjs`, `src/handlers/message.handler.js`, `src/core/session.js` | Antigravity or Grok | PR-3 | none |
| PR-5 | `feat/v501-core-screens` | levix | `frontend/src/gateway/*`, `ConnectedAccountCard.tsx`, `ConnectionView.tsx`, `OverviewView.tsx`, `src/panel/account-profile.cjs` | Grok or Antigravity | PR-1 | none |
| PR-6 | `feat/v501-plus-ui` | levix | `frontend/src/views/plus/*` | Antigravity | PR-1, PR-3 | none |
| PR-7 | `release/v501-prep` | levix (+ levix-plus `core.lock.json`) | version files, CHANGELOG, docs index | orchestrator | all | none |

Codex reviews every PR read-only. Implementers do not run tests or builds; the
orchestrator runs every gate. OpenCode free models returned
`FreeUsageLimitError` on 2026-11-20 and are skipped until they recover.

## 8. Risks

- PR-2 changes the path every reaction takes. Mitigation: keep the engine's
  admission, rate limits and claims; add parity tests (text vs reaction) for
  ping, stt and kick; negative tests for every gate.
- Accepting the owner's own reactions opens a loop risk with Levix's own
  reactions. Mitigation: the sent-message cache check, plus a test where an AI
  reaction reaches intake.
- PR-3 needs Core and Plus released together. A new Plus runtime on an old Core
  returns a descriptor the old host reduces to an empty set (no replies, not
  wider). An old Plus runtime on a new Core returns an array, read as `only`.
- i18n keys from five PRs collide in generated files. Rebuild with
  `npm run i18n:build` after each rebase. pt-BR and es-419 strings are machine
  drafts until the approved ChatGPT review (Q-19).

## 9. Gates and evidence

Results are recorded per PR as PASS, FAIL, NOT RUN or BLOCKED with command,
platform, commit and date. Device QA uses only an owner-authorized test account
and is NOT RUN until the owner says otherwise.

## 10. Rollback

Each PR reverts on its own except PR-3 and PR-4, which revert together with the
matching Plus release. Rule JSON v2 is readable only by 5.0.1; a downgrade to
5.0.0 leaves those rules rejected by the old validator and therefore inactive.
The Plus document v1 is rejected by a 5.0.0 Plus runtime, which then falls back
to its defaults (Auto Reply off).

## 11. Review and owner decisions (2026-11-20)

Codex reviewed sections 5 and 6 read-only and objected to six decisions at
P1. The plan changes as follows. Each change is in the matching implementer
brief.

| Item | Change |
| --- | --- |
| 6.1.1 requester | The invocation carries a verified `ctx.requester` separate from source and target. The DM quote carries the original author. Commands that read the requester from `msg.key` (`todo`, `packs`, `stickers`) are unsupported in 5.0.1. |
| 6.1.7 provenance | The send wrapper assigns and records every outbound message id before Baileys sends. A linked-account reaction or original counts only when it arrives as an inbound server event, is not a recorded outbound id, and is newer than the socket open time. |
| 6.1.4 eligibility | `gemini` takes a plain prompt only and rejects its management verbs. `sticker`, bare `group:antilink`/`group:media`/`group:welcome` (they write settings), `group:promote`, `group:demote` and `group:clearwarns` are unsupported in 5.0.1. `group:note` is supported with one `#keyword`. |
| 6.1.5 destructive | `group:kick` is the only destructive command. Its claim happens at the mutation boundary after authorization, and rechecks epoch, rule revision, transition version and live membership. |
| 6.1.6 denials | Dispatcher denials and router refusals are silent for reactions. Messages a command sends after authorization passed stay. |
| STT | Reaction STT keeps its switch, provider key, voice-only, byte and re-authorization checks inside execution. |
| Delivery | The rule's destination overrides global route overrides for reactions. Destructive announcements stay in the source chat. |
| 6.2 aliases | Scope matching uses verified PN/LID aliases in Core and Plus. A private chat in `except` mode that cannot be matched against an exclusion of the other address form is treated as excluded. |
| 6.2 stale save | A v0 save over a stored v1 document keeps the v1 scope, group switch, exclusions and policy. |
| 6.3 decisions | Classification is one request with one schema-only forced tool and no execution loop. Deterministic acknowledgements run after admission. One deadline covers classification and the task turn. |
| Release | Core 5.0.1 with versionCode 80. Plus repins Core and uses a fresh code of at least 81, above the Play high-water mark; its upload and promotion pins still name build 79 and must move. |

Owner decision on reaction rule permissions (answer to the migration question):

- O-1 Each rule chooses who may trigger it: Everyone, Owner and group admins,
  Owner only, Group admins only, or Selected participants. This extends the
  existing `senders { role, ids }` with one new role, `owner_group_admin`.
  Stored `bot_admin` and `member` roles keep their meaning.
- O-2 The rule filter is extra. The command's own authorization must also pass.
- O-3 A per-rule setting decides whether other participants may react to
  messages the linked account wrote. It defaults to off.
- O-4 Migration keeps every sender role and id list, accepts the linked
  account's own reactions, and keeps O-3 off for existing rules.
- O-5 All of it is configurable in the rule editor.
- O-6 Reaction commands use the command's own authorization and never edit or
  delete the reacted-to message.

# Phase 08 completion: owner decisions of 2026-11-10

Status: **IMPLEMENTATION CONTRACT**. This file turns the owner decisions in
`PHASE-08-OWNER-DECISIONS.md` (PR #160) into the exact behaviour, names and
tests the follow-up slices implement. Where it conflicts with an earlier
proposal in `PHASE-08-PLAN.md` or `PHASE-08-RESULTS.md`, this file wins.
Nothing here merges, deploys, creates a billing product or changes a legal
release.

## Slices

| Slice | Repository, branch | Content |
| --- | --- | --- |
| 08i | levix `feat/08i-memory-policy` | Free global memory policy, Auto Reply global memory in Core, this contract |
| 08j | levix `feat/08j-plus-backup` | Nonsecret Plus customizations in encrypted backups |
| 08k | levix `feat/08k-plus-ui-build` | Panel UI for 08i/08j, verifier host name, move-denial text, public-build hiding, Android extension staging hook |
| 08l | levix `feat/08l-legal-drafts` | Four-locale Terms/Privacy drafts, Data safety draft, results update |
| 08g | levix-plus `feat/08g-completion` | Runtime global memory fields, verifier host name, RTDN deployment kit |
| paid | levix-plus `ci/paid-aab` | Paid AAB pipeline with a throwaway CI keystore |

Each public slice merges the previous one (08i, 08j, 08k, 08l), so the PRs
stack without a force push.

## 1. Free Core global memory policy (08i)

Three settings in `src/config/settings.cjs`, group `ai`, read at call time:

| Key | Type | Choices | Default | Meaning |
| --- | --- | --- | --- | --- |
| `ai_global_memory_read` | string | `off`, `owner`, `privileged`, `everyone` | `privileged` | Which verified callers get `global.md` in an AI turn |
| `ai_global_memory_write` | string | `off`, `owner`, `privileged` | `off` | Which verified callers may let the AI save, delete or summarize into `global.md` |
| `ai_global_memory_where` | string | `own_chat`, `private`, `all` | `own_chat` | Chats where read or write may happen |

- `owner` is a bot owner (`caller.isOwner`). `privileged` is a bot owner or a
  bot admin (`caller.isOwner || caller.isBotAdmin`). `everyone` is any
  verified caller (the v4.9 behaviour).
- `own_chat` is a private chat whose other party is the caller, or the linked
  account's chat with itself: `!caller.isGroup` and the chat id names the
  caller (`sameUserSync(chatId, senderId)` over the caller's candidates).
  `private` is any private chat. `all` adds groups.
- An unverified caller (not minted by `aiToolAuth.resolveCaller()`) gets
  neither read nor write.
- Write never exceeds the existing tool roles: a global `save_memory`,
  `forget_memory` or `summarize_chat` still needs `botPrivileged`, and the
  policy is checked in addition.

`src/services/memoryPolicy.cjs` owns the decision:

```js
// Returns a frozen { read, write } for one AI turn context, read live.
globalMemoryAccess(context)
// Removes memory-tool calls and responses from a stored history.
stripMemoryToolParts(history)
```

Enforcement points, all recheck the policy when they run:

1. `aiAgent.buildSystemInstruction()` includes `global.md` only when
   `globalMemoryAccess(context).read`. `includeGlobalMemory` is removed.
2. `search_memory` with scope `global` or `all` (and every alias of
   `memory.normalizeScope`) is refused without read.
3. `save_memory` and `forget_memory` with a global scope are refused without
   write. `summarize_chat` with a global scope is refused without write.
4. `runTool` passes `globalMemory: () => globalMemoryAccess(ctx)` to `run()`;
   tools call it at run time and again inside `deliveryGuard.assert()` before
   a write, so a setting change mid-turn applies.
5. A Free turn without read loads its chat history through
   `stripMemoryToolParts()`: `search_memory`, `save_memory`,
   `forget_memory` and `summarize_chat` calls and responses are removed and an
   emptied entry is dropped. Model text already sent to that chat stays.
6. `!memory search` shows global hits only to a bot owner or bot admin, like
   `!memory file global`. Explicit owner commands are unchanged.
7. All three providers use the same system instruction and tool table, so no
   provider-specific path exists.

## 2. Plus Auto Reply global memory (08i Core, 08g runtime, 08k UI)

- The runtime's per-chat Auto Reply config gains
  `globalMemory: { read: boolean }`, default `false`. A stored config without
  the field means `false`; nothing re-enables global memory for an existing or
  a new chat.
- `consider()` returns `globalMemory: { read: true }` only for a chat whose
  `read` is `true`.
- Core `autoReply.cjs` accepts only a literal boolean and builds a frozen
  `autoReplyGlobal = { read }` for the turn context, with
  `memoryScope: "chat"`.
- In an Auto Reply turn, read is `autoReplyGlobal.read` and write is always
  `false`. Auto Reply skips messages from the linked account (`fromMe` and every
  sender candidate that names it), so the owner is never the sender of an Auto
  Reply turn and an owner-only write grant could never apply. Owner review on
  2026-11-10 removed the write option from the UI, the runtime config and Core.
  A forged or stored `write` value is ignored. Global memory writes stay
  available through Free AI turns, under the Free settings above. The Free
  settings do not apply to Auto Reply, and Auto Reply settings do not apply to
  Free turns.
- `summarize_chat` in an Auto Reply turn stays refused unless read is on.
- `host.invalidateScope()` aborts every pending and in-flight Auto Reply job,
  because a config change can narrow a chat's memory access mid-turn.
- Enabling read for a chat in the panel needs a confirmation that names the
  risk: facts saved in global memory can influence or appear in automated
  replies in that chat.

## 3. Plus customizations in backups (08j)

Exported, all inside the existing encrypted backup v1:

| Key | Kind | Restored |
| --- | --- | --- |
| `ext:levix-plus:cfg:<template key>` (`templateKeys.isCustomizable`) | message overrides with locale values | with settings |
| `ext:levix-plus:cfg:presets` | active preset | with settings |
| `ext:levix-plus:cfg:visibility` | visibility preferences | with settings |
| `ext:levix-plus:acct:autoReply` | Auto Reply rules, including `globalMemory` | with account data, only after the same WhatsApp account is paired |

Never exported and refused on restore: every `plus:*` key (installation key,
entitlement token, rollback barrier, purchase state), every other
`ext:*` key, `auth:*`, `secret:*`, secret settings. Purchase tokens, verifier
keys, RTDN and Google credentials never exist on the device.

Rules:

- `src/backup/extensions.cjs` holds the allowlist and a structural check:
  valid JSON, a plain object, at most 64 KiB, depth at most 8, no
  `__proto__`, `constructor` or `prototype` key, at most 200 names per kind.
  The runtime's own validator runs again when it loads a value and ignores an
  invalid one.
- A backup that carries a non-allowlisted `ext:` or `plus:` key is refused
  (`EXCLUDED_DATA`), the same as other secret keys.
- Restore writes only keys present in the backup; an older backup without
  Plus keys leaves the current values.
- The restore preview lists Plus customizations (message overrides, presets,
  visibility, Auto Reply) as added, replaced or unchanged.
- Restore and activation never write `plus:*`, so Plus stays inactive until
  the entitlement is verified again. A running extension reloads its stored
  config after a restore or an activation.

## 4. Verifier host

Production origin: `https://levix-plus.leviro.net`. It replaces
`https://plus.leviro.net` in Core, the private service, docs and drafts. No
DNS change and no deployment.

## 5. Device moves

Policy: one active installation per subscription, at most three moves in any
rolling 30 days, audited manual exceptions. The app never shows a count, a
remaining allowance or a "moves left" notice. `REBIND_LIMIT` shows: "This
subscription can't be moved to this installation right now. If you replaced
your device, contact Leviro Support from Settings > Feedback." The purchase
card carries one line with the policy and a link to the Terms.

## 6. Public and paid builds (08k, paid)

- The Settings Plus tab is shown only when the Plus extension is installed
  (status `extension.state` is not `absent`) or the Android build has a Plus
  product id (`LevixHost.plusConfigured()`). Public builds have neither.
  Whether a Free build should advertise Plus is an open owner decision
  (D-08-9); the default is hidden.
- `android/scripts/stage-levix-app.sh` copies
  `$LEVIX_EXTENSIONS_DIR/levix-plus` to `extensions/levix-plus` in
  `levix-app.zip` only when that variable is set. Public CI never sets it, and
  the public artifact scan fails if the path appears.
- The paid pipeline (levix-plus `ci/paid-aab`) checks out Core at
  `core.lock.json`, stages only `runtime/`, builds with a throwaway keystore and
  a placeholder product id, validates the AAB, and uploads and publishes
  nothing.

## 7. Legal (08l)

Terms and Privacy drafts in four locales and a Data safety draft live under
`docs/plans/v5/legal-drafts/`. They are not effective, not in
`src/legal/bundled/`, and pt-BR, es-419 and Arabic are machine drafts without
human legal review.

## Tests required

- Policy matrix: owner, bot admin, member, group admin; own chat, other
  private chat, group; each setting value; `global`, `all`, `shared`, `عام`,
  `عالمي` scopes; `save_memory`, `search_memory`, `forget_memory`,
  `summarize_chat`; system prompt for all three providers; setting changed
  mid-turn; account epoch change; injected text asking for global facts.
- Auto Reply: default off, read on, a forged write grant ignored for every
  role, malformed decision values, config change aborting an in-flight turn.
- Backup: export contains only allowlisted Plus keys, never `plus:*`;
  restore of a tampered key refused; `acct` key waits for the matching
  account; mismatched account never gets it; older backup keeps current
  values; Plus stays inactive after restore.

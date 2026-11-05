# Phase 05 results

Date: 2026-11-05. Base: `main` `2682a09` (Phase 04e). Branch: `feat/v5-phase-05`.
Status: `IMPLEMENTED`, not merged. One pull request covers the planned slices 05a–05f.

## 1. Audit of the current tree

| Fact | Evidence | What this phase did |
| --- | --- | --- |
| The dispatcher splits on whitespace, so `!group\nkick` already worked. | `src/handlers/command.handler.js` before this phase | Parser v2 keeps that and rejects a URL or a fenced block that is not a command name. |
| `!group` had its own permission switch and skipped the dispatcher's check. | `src/commands/group.cjs` | The switch now calls `evaluatePermissionLevel`. |
| `blacklist` aliases `block` and `unblock`, which are also command names. Load order decided the winner. | `src/commands/blacklist.cjs` | After every command is loaded, names are registered first and the conflicting alias is dropped. `!block` stays the block command. |
| `group:antispam`, `group:flagged`, and `group:note` have no key and fall back to the group default `ADMINS_OWNER`. | `src/config/runtime-config.cjs` `defaultPermission` | Left as they are. Writing a lower level would widen access. |
| An unknown command was silent, and group moderation still ran. | dispatcher returned false | A real command-shaped typo now gets one reply with an example. A token that is not a command name still falls through to moderation. |
| Six commands sent a progress line and then a second result. | `prayer`, `members`, `add`, `setpp`, `restart`, `stopbot` | They use `createStatus` and edit one message. |
| Replies go to the source chat, except schedule errors and the password-reset code. | ADR-007, Q-21 | Those two exceptions are named in the router. Everything else stays in the source chat unless Settings says otherwise. |
| `!status` was `OWNER_ONLY` and printed Node, Baileys, the kernel, and the ffmpeg path. | `src/commands/status.cjs` before this phase | The short line has none of those. `!status debug` is owner-only even if the command permission is lowered. |

No schema migration. New values are ordinary settings, so a v4 database keeps working and the new keys follow their defaults.

## 2. Decisions

Q-06 is still open. This phase follows recommendation (a): `!status` stays `OWNER_ONLY`. `!status debug` is a second gate on the owner role, not on the command's panel level and not on the reply language. Option (b), letting members see the short line, would widen access and was not applied.

ADR-012 puts the watermark in this engine. The call site is `stampWatermark` in `src/messaging/message.cjs`. The setting `message_watermark` defaults to off so current replies stay the same until the operator turns it on. Security text, errors, files, and exact-output commands (`calc`, `rand`, `translate`, `md`, `digit`, `qr`, `loop`, `poll`, `ping`) never get it.

The one access change is the ADR-011 alignment: a bot admin who can already run `!kick` can run `!group kick` in that group. A bot admin in a private chat still cannot. The direct `!kick` path still requires `userAdminRequired` (a WhatsApp admin or a bot admin). `!group kick` still also allows the bot owner who is not a WhatsApp admin. Closing that remaining gap would widen direct `!kick` for that owner, so it was left as a question:

> Should `!kick` allow the bot owner who is not a WhatsApp group admin, matching `!group kick`?

No default permission level changed. The before-and-after matrix is the `LEVELS` table in `tests/command-engine.test.mjs`.

## 3. What shipped

`parse → authorize → execute → render → route → send`.

- `src/messaging/parser.cjs` — v2, and v1 behind `command_parser`.
- `src/messaging/message.cjs` — frozen envelope (`messageKey`, category, parameters, context, sensitivity, delivery policy). Parameters are escaped once. A render hook may change text. It cannot change the destination.
- `src/messaging/router.cjs` — default `same_chat`. `owner_private` uses `creds.me` only. `authorized_chat` must be a WhatsApp id, not a link. Source content may go to the linked account's own chat. Another person or another group may receive operational text only, and a group only when the cache already shows the linked account is a member. No network lookup. Refusal does not fall back to a group.
- `src/messaging/health.cjs` — pure `ok` / `degraded` / `down` / `unknown`. No socket and no fetch.
- Settings, all additive: `reply_route`, `reply_route_chat`, `reply_route_overrides`, `reply_hide_progress`, `message_watermark`, `command_parser`. The General tab edits them. Toggles apply immediately. The other fields save explicitly.
- Password-reset codes call `assertSelfDelivery` before they are sent.

Categories: progress may be hidden. Result, error, and security notices are not. A status line is routed as source content, so a progress line cannot open a third-party chat that the result would then be edited into.

## 4. Tests

Platform: Linux, Node from the workspace (v24). Date: 2026-11-05.

| Command | Result |
| --- | --- |
| `node tests/command-engine.test.mjs` | PASS, 106 checks |
| `node tests/reply-router.test.mjs` | PASS, 23 checks |
| `node tests/message-health.test.mjs` | PASS, 39 checks |
| `node tests/prayer.test.mjs` | PASS, 40 checks |
| `node tests/password-reset.test.mjs` | PASS |
| `npm run lint` | PASS, 0 errors. Warnings are the existing set (195 warnings). |
| `npm run i18n:check` | PASS. Phase 05 catalog files are marked draft in `i18n/review.json`. |
| `npm test` | PASS, 9705 checks, 0 failed, 290.1 s, Linux, 2026-11-05 |
| `npm run build:frontend` | PASS (`tsc -b` and Vite), Linux, 2026-11-05 |

Android device QA: NOT RUN. Headless is covered because none of this imports the panel. The settings card was not clicked in a browser in this session: no browser tool was available. The frontend build is the check that the new card typechecks.

## 5. Privacy and rollback

Nothing new leaves the device. Routing reads local credentials and the group cache. Health probes are local (database, disk, memory, ffmpeg presence, scheduler rows) and only `!status debug` runs them. Debug text drops anything that is not an `N MB` detail, and it never prints a path or `os.release()`.

Rollback: set `reply_route` back to `same_chat` and `command_parser` to `v1`. The router stays on the send path either way. There is no migration to undo.

## 6. Left for the owner

- Q-06, if members should see the short `!status`.
- Whether direct `!kick` should match `!group kick` for an owner who is not a WhatsApp admin.
- Whether `message_watermark` should default on (ADR-012) once the operator wants the footer on eligible results.
- ChatGPT review of the new `pt-BR` and `es-419` strings (marked draft).

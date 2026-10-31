# Levix command inventory at v4.9.2

Status: `SHIPPED` (commit `050d8b9`). Generated on 2026-10-30 by loading every module in
`src/commands/` and `src/commands/group/` with an empty, isolated data directory and reading its
exported `name`, `aliases`, `chat`, `userAdminRequired` and `botAdminRequired`. Default permissions
come from `src/config/defaults.cjs` (`command_permissions`). Operators can change permissions,
aliases and on/off state in the panel (`src/config/runtime-config.cjs`); this table shows the
shipped defaults only.

- 43 top-level commands and 26 group sub-commands: 69 files.
- Every group sub-command also runs directly as `!<name>`; the dispatcher registers group files
  twice (`src/handlers/command.handler.js:207`).
- "no key" means `defaults.cjs` has no `group:<name>` entry, so the permission falls back to the
  group default `ADMINS_OWNER` (`src/config/runtime-config.cjs:79`). See AUDIT C-05 and Q-08.
- `!help` reads `description` and `usage` (`{ en, ar }`) from the same modules
  (`src/utils/commandDocs.cjs`); `tests/help-i18n.test.mjs` fails a command that ships one language.
- "WA admin needed" is `userAdminRequired`; "Bot must be admin" is `botAdminRequired`.

## Top-level commands

| Command | Aliases | Chat | Default permission | WA admin needed | Bot must be admin | File |
| --- | --- | --- | --- | --- | --- | --- |
| `!autodelete` | ad, حذف_تلقائي | all | OWNER_ONLY |  |  | `src/commands/autodelete.cjs` |
| `!autoschedule` |  | all | OWNER_ONLY |  |  | `src/commands/autoschedule.cjs` |
| `!blacklist` | unblacklist, block, unblock | group | ADMINS_OWNER | yes |  | `src/commands/blacklist.cjs` |
| `!block` |  | all | OWNER_ONLY |  |  | `src/commands/block.cjs` |
| `!calc` | calculate, حساب, احسب, = | all | MEMBERS |  |  | `src/commands/calc.cjs` |
| `!debt` | دين, owes | private | MEMBERS |  |  | `src/commands/debt.cjs` |
| `!deleteschedule` |  | all | ADMINS_OWNER | yes |  | `src/commands/deleteschedule.cjs` |
| `!digit` | digits, num, numbers, numeral, ارقام, رقم | all | MEMBERS |  |  | `src/commands/digit.cjs` |
| `!gemini` | ask, ai, resetai, del, delall, generate | all | MEMBERS |  |  | `src/commands/gemini.cjs` |
| `!group` |  | group | ADMINS_OWNER |  |  | `src/commands/group.cjs` |
| `!help` | menu, commands, h, مساعدة, الاوامر, اوامر | all | MEMBERS |  |  | `src/commands/help.cjs` |
| `!lang` | language, لغة | all | MEMBERS |  |  | `src/commands/lang.cjs` |
| `!listschedules` |  | all | ADMINS_OWNER | yes |  | `src/commands/listschedules.cjs` |
| `!loop` | repeat, كرر, تكرار | all | MEMBERS |  |  | `src/commands/loop.cjs` |
| `!md` | markdown | all | MEMBERS |  |  | `src/commands/md.cjs` |
| `!memory` | mem, ذاكرة, remember | all | MEMBERS |  |  | `src/commands/memory.cjs` |
| `!mod` | moderation, settings | group | ADMINS_OWNER |  |  | `src/commands/mod.cjs` |
| `!notes` |  | all | MEMBERS |  |  | `src/commands/notes.cjs` |
| `!pack` | حزمة | all | MEMBERS |  |  | `src/commands/pack.cjs` |
| `!packs` | حزم | all | MEMBERS |  |  | `src/commands/packs.cjs` |
| `!perm` | perms, owner, admin, role, roles, صلاحيات | all | OWNER_ONLY |  |  | `src/commands/perm.cjs` |
| `!ping` |  | all | MEMBERS |  |  | `src/commands/ping.cjs` |
| `!poll` | vote, استفتاء, تصويت | all | MEMBERS |  |  | `src/commands/poll.cjs` |
| `!prayer` |  | all | MEMBERS |  |  | `src/commands/prayer.cjs` |
| `!qr` |  | all | MEMBERS |  |  | `src/commands/qr.cjs` |
| `!rand` | random, roll, عشوائي, قرعة | all | MEMBERS |  |  | `src/commands/rand.cjs` |
| `!restart` |  | all | OWNER_ONLY |  |  | `src/commands/restart.cjs` |
| `!schedule` |  | all | ADMINS_OWNER |  |  | `src/commands/schedule.cjs` |
| `!score` | نقاط, احصائية | all | MEMBERS |  |  | `src/commands/score.cjs` |
| `!send` |  | all | MEMBERS |  |  | `src/commands/send.cjs` |
| `!setprefix` | prefix | all | OWNER_ONLY |  |  | `src/commands/setprefix.cjs` |
| `!shortlink` |  | all | MEMBERS |  |  | `src/commands/shortlink.cjs` |
| `!status` |  | all | OWNER_ONLY |  |  | `src/commands/status.cjs` |
| `!sticker` | s, ملصق, tosticker | all | MEMBERS |  |  | `src/commands/sticker.cjs` |
| `!stickers` | ملصقاتي | all | MEMBERS |  |  | `src/commands/stickers.cjs` |
| `!stopbot` | stop, pause | all | OWNER_ONLY |  |  | `src/commands/stopbot.cjs` |
| `!stt` | totext, transcribe | all | MEMBERS |  |  | `src/commands/stt.cjs` |
| `!todo` |  | all | MEMBERS |  |  | `src/commands/todo.cjs` |
| `!toimage` | toimg, صورة | all | MEMBERS |  |  | `src/commands/toimage.cjs` |
| `!translate` | tr, ترجم, ترجمة | all | MEMBERS |  |  | `src/commands/translate.cjs` |
| `!tts` | tovoice, speak | all | MEMBERS |  |  | `src/commands/tts.cjs` |
| `!unblock` |  | all | OWNER_ONLY |  |  | `src/commands/unblock.cjs` |
| `!weather` |  | all | MEMBERS |  |  | `src/commands/weather.cjs` |

## Group sub-commands (`!group <name>` or `!<name>`)

| Sub-command | Chat | Default permission (`group:<name>`) | WA admin needed | Bot must be admin | File |
| --- | --- | --- | --- | --- | --- |
| `add` | group | ADMINS_OWNER | yes | yes | `src/commands/group/add.cjs` |
| `all` | group | MEMBERS |  |  | `src/commands/group/all.cjs` |
| `antilink` | group | ADMINS_ONLY | yes |  | `src/commands/group/antilink.cjs` |
| `antispam` | group | ADMINS_OWNER (no key) | yes |  | `src/commands/group/antispam.cjs` |
| `approveall` | group | ADMINS_OWNER | yes | yes | `src/commands/group/approveall.cjs` |
| `clearwarns` | group | ADMINS_ONLY | yes |  | `src/commands/group/clearwarns.cjs` |
| `deletenote` | all | ADMINS_OWNER | yes |  | `src/commands/group/deletenote.cjs` |
| `demote` | group | ADMINS_OWNER | yes | yes | `src/commands/group/demote.cjs` |
| `flagged` | group | ADMINS_OWNER (no key) | yes |  | `src/commands/group/flagged.cjs` |
| `kick` | group | ADMINS_OWNER | yes | yes | `src/commands/group/kick.cjs` |
| `media` | group | ADMINS_ONLY | yes |  | `src/commands/group/media.cjs` |
| `members` | group | MEMBERS |  |  | `src/commands/group/members.cjs` |
| `note` | all | ADMINS_OWNER (no key) |  |  | `src/commands/group/note.cjs` |
| `policy` | group | ADMINS_ONLY | yes |  | `src/commands/group/policy.cjs` |
| `promote` | group | ADMINS_OWNER | yes | yes | `src/commands/group/promote.cjs` |
| `removeall` | group | OWNER_ONLY | yes | yes | `src/commands/group/removeall.cjs` |
| `rules` | group | MEMBERS |  |  | `src/commands/group/rules.cjs` |
| `save` | group | ADMINS_OWNER | yes |  | `src/commands/group/save.cjs` |
| `setname` | group | ADMINS_OWNER | yes | yes | `src/commands/group/setname.cjs` |
| `setpp` | group | ADMINS_OWNER | yes | yes | `src/commands/group/setpp.cjs` |
| `setrules` | group | ADMINS_ONLY | yes |  | `src/commands/group/setrules.cjs` |
| `setwarn` | group | ADMINS_ONLY | yes |  | `src/commands/group/setwarn.cjs` |
| `tagadmins` | group | MEMBERS |  |  | `src/commands/group/tagadmins.cjs` |
| `warn` | group | ADMINS_ONLY | yes |  | `src/commands/group/warn.cjs` |
| `warns` | group | ADMINS_OWNER | yes |  | `src/commands/group/warns.cjs` |
| `welcome` | group | ADMINS_OWNER | yes |  | `src/commands/group/welcome.cjs` |

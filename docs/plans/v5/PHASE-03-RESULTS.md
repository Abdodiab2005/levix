# Levix v5.0.0 Phase 03: unified i18n

Status: COMPLETE on 2026-11-02 for every automated gate. All Phase 03 pull requests are merged
(section 10.1); `main` 8651514 passes the final gates in section 10.6. The owner started Phase 03 on
2026-11-01 and decided Q-15 and Q-19 (section 2, amended 2026-11-02). Android device QA is NOT RUN
(section 10.7). Sections 1 to 9 are the plan; section 10 records what was built, merged and
measured. Every claim cites code or a command run on 2026-11-01 or 2026-11-02.

## 1. Re-audit (2026-11-01)

Four read-only audits ran in parallel: Codex (Node backend and bot), Grok (dashboard), OpenCode
(Android) and Antigravity (gateway, build and packaging). The orchestrator re-checked every finding
that changes the plan. Two audit counts were wrong and are corrected here (P3-02, P3-03).

| ID | Finding | Evidence |
| --- | --- | --- |
| P3-01 | `tr(` appears on 577 lines in 87 files (`grep -rcE '\btr\('` over `src/` and `scheduler.cjs`). ADR-004 said 584 call sites in 86 files. | `src/utils/i18n.cjs:109` |
| P3-02 | The dashboard has 1116 keys per locale, the same set in `ar` and `en`, parsed with the TypeScript compiler. ADR-004 said 1001; the 115 `backup*` keys from Phase 02 account for the rest. 44 keys hold `{name}` placeholders; none holds a plural. | `frontend/src/i18n/translations.ts:3`, `:5` |
| P3-03 | The gateway has 89 keys per locale, as ADR-004 said. Seven keys are rendered as HTML through `data-i18n-html`. | `public/gateway-i18n.js:22`, `:268` |
| P3-04 | Android has 247 `<string>` and 8 `<plurals>` per locale (ADR-004: 246 strings). Key and placeholder parity between `values` and `values-ar` is exact. The files hold 11 XML comments. | `android/app/src/main/res/values/strings.xml` |
| P3-05 | `bot_language` accepts `auto`, `ar`, `en`. `withLang()` maps every value except `en` to `ar`, and `tr()` has two outputs. | `src/config/settings.cjs:32`, `src/utils/i18n.cjs:99`, `:109` |
| P3-06 | There is no AI reply language setting. `botLangDirective()` follows `bot_language`: fixed Arabic, fixed English, or in `auto` the language the user writes in. | `src/services/aiAgent.cjs:160` |
| P3-07 | All 69 command modules carry `description` and `usage` as `{ en, ar }`. The dashboard command API returns those maps, and the command filter searches `.en` and `.ar` only. | `src/handlers/command.handler.js:172`, `frontend/src/views/commands/filters.ts:46` |
| P3-08 | The dashboard boot accepts `ar` or `en` from the Android host, `localStorage.levix_lang` and `navigator.language`; anything else is `en`. `I18nContext`, the header and Settings pickers, and the `levix-ui-prefs` handler accept the same two. | `public/ui-boot.js:19`, `frontend/src/context/I18nContext.tsx:19`, `:30` |
| P3-09 | Four dashboard paths map every non-English value to Arabic: the group moderation summary and preview, and the diagnostics language default. A Portuguese or Spanish UI would show Arabic there. | `frontend/src/views/GroupsView.tsx:692`, `:703`, `frontend/src/utils/diagnostics.ts:8` |
| P3-10 | 71 inline `language === "ar"` or `"en"` checks in 9 dashboard files hold copy outside the catalog; `ConnectionView.tsx` has 41. Dates use `ar-EG` and `en-GB` on two screens and `ar` or `en` elsewhere. | `frontend/src/views/ConnectionView.tsx`, `frontend/src/views/SchedulesView.tsx:1570` |
| P3-11 | The gateway applies only `ar` or `en`, binds RTL to `ar`, and `login.ejs` sends `lang: "en"` for any non-Arabic page when it asks for a reset code. | `public/gateway-i18n.js:245`, `:289`, `views/login.ejs:237`, `:324` |
| P3-12 | Android `UiPrefs` accepts `ar` or `en`, maps any other device locale to `en`, and reads only the language subtag, so `pt-BR` and `es-419` would collapse to `pt` and `es`. `PanelBridge.setUiPrefs` drops a rejected value without telling the page. The header control is a two-way flip. Notifications build their own locale from `UiPrefs.language()`. | `UiPrefs.kt:17`, `:20`, `:25`, `PanelBridge.kt:37`, `MainActivity.kt:126`, `LevixHostService.kt:84` |
| P3-13 | There is no `locales_config.xml` and no `android:localeConfig`, so Android 13 and later list no app languages. The app has no `bundle { language { } }` block, so Play installs only the device's language splits; a language picked in the app later has no strings on the device until Play downloads them. | `android/app/build.gradle.kts:173`, `AndroidManifest.xml:56` |
| P3-14 | The recovery relay rejects any `lang` other than `en` or `ar` with `invalid`. Levix sends `ar` or `en` today, so nothing fails now; sending `pt-BR` to the current relay would break recovery mail. | levix-ui `src/lib/recovery-email.ts:187`; `src/panel/recovery-email.cjs:59`, `src/panel/password-reset.cjs:138` |
| P3-15 | Feedback and crash diagnostics allow `language` `ar` or `en` on both sides and drop any other value without failing. | `src/diagnostics/device.cjs:26`, levix-ui `src/lib/feedback.ts:64` |
| P3-16 | No build path runs a generator today: `npm pack` and the SEA build run `build:frontend`, the Android staging copies `src/`, `views/` and `public/` as they are, Docker copies them from the checkout, and CI runs `npm test` from the checkout. Generated files therefore have to be committed. SEA bundles statically required `.cjs` modules; a runtime read of a JSON file under `src/` would need a new asset rule. | `scripts/build-sea.mjs:131`, `:266`, `android/scripts/stage-levix-app.sh:55`, `Dockerfile:34`, `.github/workflows/ci.yml:29` |
| P3-17 | CI runs no `npm run lint` step; lint is a local gate only. | `.github/workflows/ci.yml` |
| P3-18 | Bot dates and recurrence text exist in Arabic and English only, and the dashboard schedules API returns `when` and `whenAr`. The AI context and two AI tools format dates with `ar-EG` whatever the language. | `src/utils/recurrence.cjs:209`, `src/routes/dashboard.api.esm.js:1235`, `src/services/aiAgent.cjs:150` |
| P3-19 | `public/dashboard.js` (the fallback page shown only when the React build is missing) has a two-way language toggle. Phase 04 removes it with the EJS pages. | `public/dashboard.js:291` |

## 2. Owner decisions (2026-11-01)

| ID | Decision |
| --- | --- |
| Q-15 | Update the recovery relay now. The relay in `levix-ui` gains `pt-BR` and `es-419` mail. It must be deployed before the Levix change that sends those values merges (P3-14). |
| Q-19 | ChatGPT reviews the `pt-BR` and `es-419` translations. The catalog records this as a machine review by ChatGPT, not a native-speaker review. Amended 2026-11-02: ChatGPT is the approved Phase 03 reviewer and native-speaker review is not required to merge. |

## 3. Design

### 3.1 Locale registry

`i18n/locales.json` lists the four locales. Each entry has the code, the native name, the text
direction (`rtl` only for `ar`), the Android resource folder, and whether the locale is required.

| code | native name | dir | Android folder |
| --- | --- | --- | --- |
| `en` | English | ltr | `values` (default) |
| `ar` | العربية | rtl | `values-ar` |
| `pt-BR` | Português (Brasil) | ltr | `values-pt-rBR` |
| `es-419` | Español (Latinoamérica) | ltr | `values-b+es+419` |

Normalization is one rule on every platform: `ar*` is `ar`, `pt*` is `pt-BR`, `es*` is `es-419`,
`en*` is `en`, anything else is `en`. Matching ignores case and accepts `_` or `-`. `es-419` cannot
be written as a `-r` qualifier on Android because the region is numeric; `minSdk` 29 resolves
`b+` qualifiers.

### 3.2 Catalog

```
i18n/
  locales.json
  review.json                      review status per locale file (3.9)
  en/  dashboard.json  gateway.json  android.json  commands.json  bot/<area>.json
  ar/  (same files)
  pt-BR/ (same files)
  es-419/ (same files)
```

- A file holds flat keys. A value is a string, or a plural object whose keys are CLDR categories
  and must include `other`. Allowed categories per locale come from `Intl.PluralRules`.
- Keys are stable and never reused for a different meaning. `dashboard`, `gateway` and `android`
  keep today's key names, so no call site changes when the catalog takes over. Node keys are
  `<file>.<key>` with `/` read as `.`: key `warned` in `bot/moderation.json` is
  `bot.moderation.warned`; `ping.description` in `commands.json` is `commands.ping.description`.
- Placeholders: `{name}` in every file except `android.json`, which keeps Android's positional
  `%1$s` and `%1$d`, so no Kotlin call changes. Values are text: nothing evaluates them.
- English is the source. A key missing in a required locale is an error. A locale that is not yet
  required falls back to English at run time; `pt-BR` and `es-419` start not required and become
  required when their translations land.
- `i18n/` stays outside the npm `files` list, so the catalog source ships nowhere; the generated
  files do.

### 3.3 Generator and validator

`scripts/i18n.mjs` uses only the Node standard library.

- `npm run i18n:build` writes the generated files. `npm run i18n:check` validates the catalog and
  fails if any generated file differs from what the catalog produces. `tests/i18n-catalog.test.mjs`
  runs the check, so `npm test` and CI enforce it with no workflow change.
- Generated files are committed (P3-16) and start with a do-not-edit header:

| Output | Consumer |
| --- | --- |
| `src/i18n/catalog.generated.cjs` | Node, statically required, so SEA bundles it and every other path copies it with `src/` |
| `frontend/src/i18n/translations.ts` | the dashboard; same path and exports as today, `Language` widened to four |
| `public/gateway-i18n.js`, between generated markers | the gateway dictionary; the hand-written logic around it stays |
| `android/app/src/main/res/values*/strings.xml` | Android, one file per locale |
| `android/app/src/main/res/xml/locales_config.xml` | Android 13 app language list |

- Validation rules: valid registry; JSON parsed with a duplicate-key check; every required locale
  has exactly the English keys; no empty value; plural categories valid for the locale and `other`
  present; the same placeholder set per key in every locale (for `android.json`, the same
  positional tokens and types); the same count of WhatsApp markers `*` and backticks per key in
  `bot/` and `commands.json`; no `<tag>` in any value except the gateway keys used with
  `data-i18n-html`, which may hold only the tags they hold today.
- Android output escapes `'`, `"`, a leading `@` or `?`, newlines, `&`, `<` and `>`, keeps
  positional tokens verbatim and writes a literal `%` as `%%`. Regenerating from the seeded catalog
  must reproduce the values of today's files exactly (comments are not kept).

### 3.4 Node and the bot

- `src/utils/i18n.cjs` adds `t(key, params)`: the current locale's value, else English, else the
  key and one warning log. Plural values select with `Intl.PluralRules` on `params.count`.
  Parameters are inserted as plain strings.
- `tr(en, ar)` stays as the migration wrapper: Arabic in `ar`, English in `en`, `pt-BR` and
  `es-419`. Arabic and English replies do not change.
- `withLang()` keeps the four codes; any other value stays Arabic as today, because `auto` with no
  usable words and messages outside a chat already mean Arabic (`AGENTS.md`).
- `bot_language` choices become `auto`, `ar`, `en`, `pt-BR`, `es-419`. Saved values keep their
  meaning. `!lang` accepts the new codes and `pt`, `es`.
- `auto` detection stays as it is: Arabic letters mean Arabic, English words mean English,
  otherwise Arabic. Portuguese and Spanish replies come from an explicit choice. Short WhatsApp
  messages do not identify Portuguese or Spanish reliably, and a wrong guess changes the reply
  language of an Arabic or English user.
- New setting `ai_reply_language`: `follow_bot` (default), `auto`, `ar`, `en`, `pt-BR`, `es-419`.
  `follow_bot` produces exactly today's directive for today's `bot_language` values, and the new
  Portuguese or Spanish directive when `bot_language` is one of them. `auto` follows the language
  the user writes in. The directive is built per request, so a change applies on the next message.
- Dates: a call site keeps its current tag for `ar` and `en` (`ar-EG`, `en-US` and so on) and uses
  `pt-BR` or `es-419` for the new locales.

### 3.5 Dashboard

`I18nContext`, `ui-boot.js`, the header and Settings pickers, and the `levix-ui-prefs` handler take
the four codes through the shared normalization. RTL stays `ar` only. The four non-English to
Arabic paths (P3-09) fall back to English. Inline copy moves into catalog keys, `ConnectionView`
first. Dates and numbers go through one helper that maps the UI language to an Intl tag. Command
descriptions, usages, schedule `when` text and the moderation summary become per-locale maps with
an English fallback, and the command search covers every language in the map. Settings gains the
AI reply language next to the bot language. Each value is saved with `SaveField`, per the design
rules.

### 3.6 Gateway

The generated dictionary holds four locales. `gateway-i18n.js` and `login.ejs` accept the four
codes, set `dir="rtl"` only for Arabic, and send the UI language to the reset route. Server error
codes stay stable and exist in every locale. The pages stay EJS; Phase 04 replaces them.

### 3.7 Android

- `UiPrefs` keeps the full tag (`pt-BR`, `es-419`), validates against the four codes, and maps the
  device locale with the shared normalization. `setUiPrefs` returns whether it saved, so the panel
  can show a refusal.
- The header control opens a four-item list. The two strings that say "Arabic and English" change.
- The foreground service and its notification channel use the full tag and are rebuilt on a locale
  change.
- `locales_config.xml` and `android:localeConfig` list the four locales.
- `bundle { language { enableSplit = false } }` keeps every app language in the base APK, so a
  language picked in the app works offline. `androidResources.localeFilters` keeps only the four
  locales, which drops the other languages that AndroidX libraries ship. The size change is
  measured with `bundletool` in the PR and recorded; nothing is claimed about Play download size.

### 3.8 Command documentation and help

`description` and `usage` move from the 69 command modules into `commands.json`. The command loader
attaches them from the catalog, so every consumer keeps reading the same fields. `!help`, `!help
<command>` and the language argument (`ar`, `en`, `pt`, `es`) work in all four locales. Aliases and
literal sub-commands stay as they are; placeholders are translated.

### 3.9 Translations and review

The orchestrator has the `pt-BR` and `es-419` drafts written by an agent from the English source,
with the Arabic for context, and a glossary of product and security terms that stay fixed
(`Levix`, command names, `QR`, `WhatsApp`). Translation PRs change only `i18n/` and generated
files, so ChatGPT can review them in the PR before the owner merges (Q-19). `i18n/review.json`
records, per locale file, `draft` or `reviewed`, the reviewer (`ChatGPT`), the date and the sha256
of the reviewed file. `i18n:check` lists files whose content no longer matches their review hash;
it does not fail on them. The Phase 10 release gate lists any file still `draft`. Native review
stays NOT RUN unless the owner arranges it.

### 3.10 Recovery mail and diagnostics

A `levix-ui` PR adds `pt-BR` and `es-419` to the recovery mail copy and to the feedback and crash
`language` enums. The relay contract stays v2: the change only accepts two more `lang` values.
After the owner deploys it, the Levix PR sends the UI language for recovery codes and allows the
four codes in the diagnostics enum. `PRIVACY.md` already says the language is sent; its wording
changes from "Arabic or English" to the four languages.

## 4. Pull requests

| PR | Content | Base |
| --- | --- | --- |
| 03a | Registry, catalog seeded from today's `en` and `ar` (dashboard, gateway, Android), generator, validator, `tests/i18n-catalog.test.mjs`. Generated files reproduce today's values. No behaviour change. | `main` |
| 03b | Node: `t()`, the `tr()` wrapper, four `bot_language` values, `ai_reply_language` with its dashboard field, `!lang`, `withLang`, date tags; `tests/reply-language.test.mjs` and `tests/ai-prompt.test.mjs` across four locales. | 03a |
| 03c | Web: `ui-boot.js`, `I18nContext`, pickers, Intl helper, the non-English to Arabic fixes, inline copy into keys, gateway runtime and `login.ejs`; `tests/gateway-views.test.mjs` and new boot and locale tests. | 03b |
| 03d | Android: `UiPrefs`, `PanelBridge`, picker, service locale, `localeConfig`, language split and locale filters; `UiPrefsTest.kt` and resource tests. | 03a |
| 03e | Command docs and help from `commands.json`; dashboard command maps; `tests/help-i18n.test.mjs` across four locales. | 03b |
| 03f1 to 03f5 | Bot replies from `tr()` to `t()`, one area per PR with its own `bot/<area>.json`: AI, moderation and groups, stickers, utilities, scheduler and dates. English and Arabic output unchanged. | 03b |
| 03g | `pt-BR` and `es-419` translations per surface, the two locales marked required, `review.json`. Data only; reviewed by ChatGPT before merge. | after the code PRs of each surface |
| 03h | `levix-ui`: four-language recovery mail and diagnostics enums. Levix: recovery `lang` and diagnostics enum. The Levix PR merges after the relay deploy. | `main` of each repository |
| 03i | `docs/TRANSLATING.md` (contributor guide, glossary, review process), `AGENTS.md`, `README.md`, `PRIVACY.md` wording, results. | last |

03b and 03d build in parallel on 03a; 03c, 03e and the 03f PRs build in parallel on 03b. Each
`bot/<area>.json` belongs to one PR, so the 03f PRs do not conflict.

## 5. Acceptance criteria

1. All four languages can be chosen and are kept after restart on Android and in the dashboard,
   including after an Android app update and with no network.
2. The bot answers in the chosen language, or in English where a key has no translation yet.
   Arabic and English replies are unchanged, proven by the existing reply tests passing unchanged
   before the catalog switch and after.
3. UI language, bot reply language and AI reply language are three separate settings; the AI
   default reproduces today's directive.
4. Android notifications, app screens and command docs follow a language switch.
5. `i18n:check` reports no missing key, placeholder mismatch, marker mismatch or stale generated
   file.
6. Recovery mail and the relay contract keep working for every language, and the security limits
   on codes, attempts and tokens are unchanged.
7. `npm test`, `npm run lint`, `npm run build:frontend`, `:app:testDebugUnitTest` and the debug
   and release builds for both ABIs pass, or are reported as NOT RUN with the reason.

## 6. Tests and gates

| Gate | Where |
| --- | --- |
| Catalog validity, generated files in sync | `tests/i18n-catalog.test.mjs` |
| Replies in four locales, fallback, `auto` unchanged, scopes across `await` | `tests/reply-language.test.mjs` |
| Help and command docs in four locales | `tests/help-i18n.test.mjs` |
| AI directive per `ai_reply_language` and `bot_language` | `tests/ai-prompt.test.mjs` |
| Gateway dictionary, error codes, reset `lang` | `tests/gateway-views.test.mjs` |
| Boot normalization, `dir`, unknown values | new `tests/ui-boot-i18n.test.mjs` |
| Android resources: parity, plurals, escaping, `localeConfig`, language split guard | new `tests/android-strings.test.mjs` |
| `UiPrefs` tags, normalization, round trip | `UiPrefsTest.kt` |
| Recovery `lang` per locale against a fake relay | `tests/recovery-email.test.mjs`, `tests/password-reset.test.mjs` |
| RTL and LTR smoke, dashboard in four locales | headless browser run, local |
| Android locale switch offline, notifications | device QA with the owner's authorization |

## 7. Threats and privacy

- A translated value with markup could inject HTML in the gateway. The validator allows tags only
  in the `data-i18n-html` keys, and only the tags they hold today; the dashboard renders every value
  as React text.
- A placeholder missing in one locale shows `{name}` to users or, on Android, throws in the
  foreground service. The validator compares placeholder sets per key.
- A wrong language guess would change replies for current users; `auto` keeps today's rule.
- The locale stays on the device except where it is sent today: the recovery mail request and the
  opt-in diagnostics. The set of values widens from two to four. No new field and no new
  destination.

## 8. Compatibility, migration and rollback

- No database migration. `bot_language` keeps its saved values; `ai_reply_language` is a new
  setting whose absent value means `follow_bot`. Settings import accepts the new values.
- A stored dashboard or Android language that is not one of the four resolves to English.
- v4.9.x clients keep sending `ar` or `en` to the relay; the relay change only adds values.
- Rollback: revert the PR. `tr()` keeps working throughout, generated files are regenerated from
  the previous catalog, and a downgraded app reads `pt-BR` or `es-419` as English.

## 9. Not in scope

React login, setup and QR screens (Phase 04); Plus custom message editing (Phase 08); store listings
and release notes in four languages (Phase 10); `public/dashboard.js` (removed in Phase 04);
translating on every send.

## 10. Results (2026-11-02)

### 10.1 Pull requests

All merged on 2026-11-01 and 2026-11-02, each after the 7-job CI workflow (tests, package install,
three SEA runs, Docker volume, Android APK builds) passed on its final head. Merge commits: #103
d36586c, #104 a71b12b, #105 d4eaaad, #106 1e7a1f0, #113 8ec0d9e, #107 1972767, #110 5efd98b, #116
af5fc91, #108 91c5637, #114 9f1da8e, #112 ac30f94, #111 3ead510, #109 c0f0c6b, #119 5201c53, #117
70e5661, #118 e66cfcd, #115 99e64f3, #120 95fc7ad, #121 ceac6ca, #122 8651514; levix-ui #22
f2ca096. The local evidence column is from the day each PR opened.

| PR | Slice | Base | Implemented by | Local evidence |
| --- | --- | --- | --- | --- |
| #103 | plan (this file) | `main` | orchestrator | docs only |
| levix-ui #22 | relay accepts `pt-BR`, `es-419` mail and diagnostics | levix-ui `main` | Antigravity (Gemini) | `node --test` 68 PASS, eslint and `tsc --noEmit` PASS |
| #104 | 03a catalog, generator, validator | `main` | Grok | generated values identical to `main` (1116 dashboard, 89 gateway, 255 Android per locale); `npm test` 6618 PASS |
| #105 | 03b `t()`, four bot languages, `ai_reply_language`, `!lang` | #104 | Codex | `npm test` 6681 PASS |
| #106 | 03d Android locales, picker, `localeConfig`, split off, locale filters | #104 | OpenCode | `npm test` 6655 PASS; Gradle unit tests (74) and `assembleDebug` PASS; debug APK -524,276 bytes (arm64) |
| #107 | 03e command docs and `!help` from the catalog | #105 | Codex | 138 of 138 extracted strings equal the modules; `npm test` 7260 PASS |
| #113 | 03c dashboard and gateway, four UI languages | #105 | Grok | `npm test` 6753 PASS; frontend build PASS; headless browser smoke in four locales PASS |
| #116 | 03f1 AI replies (99 calls) | #105 | Antigravity (Claude Sonnet), Grok | `npm test` 6681 PASS |
| #110 | 03f2 moderation replies (158 calls) | #105 | Codex | `npm test` 6681 PASS |
| #111 | 03f3 group replies (all calls) | #105 | Antigravity (Claude Sonnet) | `npm test` 6681 PASS |
| #108 | 03f4 sticker replies (47 calls) | #105 | OpenCode | `npm test` 6681 PASS |
| #114 | 03f5 tool command replies | #105 | OpenCode, Grok | `npm test` 6681 PASS |
| #109 | 03f6 core and system replies | #105 | Antigravity (Claude Sonnet) | `npm test` 6681 PASS |
| #112 | 03f7 schedule replies | #105 | Antigravity (Claude Sonnet) | `npm test` 6681 PASS |
| #117 | 03g1 pt-BR, es-419 dashboard and gateway text (draft) | #113 | Antigravity (Gemini), Grok | `i18n:check` PASS; `npm test` 6751 PASS |
| #118 | 03g2 pt-BR, es-419 Android text (draft) | #106 | Antigravity (Gemini), Grok | `npm test` 6655 PASS; Gradle PASS; strings present in the APK for both locales |
| #120 | 03g3 pt-BR, es-419 bot replies and command docs; both locales required | `main` (opened on `integration/phase-03`) | Grok | full Phase 03 tree with the review fixes: `npm test` 7409 PASS, `i18n:check` PASS |
| #115 | 03h recovery mail language (draft) | #113 | Codex | `npm test` 6787 PASS; merge only after levix-ui #22 is deployed |
| #119 | 03i `docs/TRANSLATING.md`, `AGENTS.md` | #105 | Grok | docs only |
| #121 | 03j1 recurrence text, schedule dates, weather language | `main` | Grok | `npm test` 7656 PASS; English and Arabic recurrence output equal to the old code (reference test) |
| #122 | 03j2 the last user-facing `tr()` calls | `main` | Grok | `npm test` 8479 PASS; Arabic number words equal to the old code for n = 0 to 120 and edge values |

`integration/phase-03` merges every PR above (before #120) with the generated files rebuilt. It
exists so CI and reviewers can test the whole phase; it is not for merge. Local result on it:
`npm test` 7400 PASS, frontend build PASS.

### 10.2 Codex review (2026-11-02)

A read-only Codex review of the full tree found four issues; each fix is a separate commit on the
PR it belongs to.

| Severity | Finding | Fix |
| --- | --- | --- |
| P1 | A translated gateway HTML value could add an attribute such as `onmouseover`; the validator checked tag names only, and `gateway-i18n.js` inserts these values with `innerHTML`. | #104: every tag must match an English tag exactly, attributes included; four new test cases. |
| P2 | The Android language hook ran the channel reset, which deletes a channel the user made louder and can throw while the foreground notification is posted. | #106: the language path only renames channels in place; the reset runs from `onCreate` and `onConfigurationChanged` as before. |
| P2 | A language or theme change in another browser tab updated `<html>` but not React. | #113: `ui-boot.js` dispatches `levix-ui-prefs` after a storage event; new test case. |
| P3 | `!lang` said the AI always follows the bot language, which is wrong once `ai_reply_language` is set. | #105 (en, ar) and #120 (pt-BR, es-419): the text says the AI follows unless an AI reply language is set in the panel. |

### 10.3 Merge order and how it ran

1. #103, then #104, then #105 and #106.
2. #113, #107, the 03f PRs (#108 to #112, #114, #116) and #119, in any order after #105. Two
   import lines conflict when the second of a pair lands: `src/commands/group.cjs` (#107 with
   #111) and `src/handlers/command.handler.js` (#107 with #109); the resolution keeps both imports
   (`attachCommandDocs` and `t`). `src/i18n/catalog.generated.cjs` and `translations.ts` conflict
   on almost every pair; the resolution is `npm run i18n:build`.
3. #117 after #113, #118 after #106, then #120 retargeted to `main`.
4. #115 only after levix-ui #22 is merged and deployed.
5. ChatGPT review (Q-19) before #117, #118 and #120 merge; each review updates `i18n/review.json`.

What happened: #103 to #107, #110 and #113 merged cleanly in that order. The other 03f PRs then
conflicted on the generated catalog and the two import lines. Each was updated by merging the
previous branch into it (a linear chain #116, #108, #114, #112, #111, #109, #119, #117, #118; no
force push), with `npm run i18n:build` resolving the generated files, then merged in chain order
as CI passed. #115 merged after the relay check (section 10.5), then #120, #121 and #122.

### 10.4 Numbers

- `tr(` calls outside `src/utils/i18n.cjs`: 575 lines in 86 files on `main` b6e777e; 2 on `main`
  8651514. Both send text to the AI model (`src/services/aiAgent.cjs:281`,
  `src/services/aiProviders.cjs:645`) and carry `// i18n-exception: sent to the model`.
- Catalog per locale on `main` 8651514: dashboard 1196, gateway 89, Android 260, commands 138, bot
  677 keys. All four locales are complete and required.
- `i18n/review.json`: 16 files `reviewed` (ChatGPT targeted review; the bot and command files by a
  sampled review), 10 files `draft` (the `pt-BR` and `es-419` versions of `bot/core`,
  `bot/moderation`, `bot/schedules`, `bot/stickers`, `bot/tools`, which gained keys in #121 and
  #122 after the review).
- Recurrence text, schedule dates and the `!weather` language follow all four locales (#121).

### 10.5 ChatGPT review and relay check (2026-11-02)

- #117 and #118: targeted review of key parity, placeholders and security-sensitive text; no
  blocking discrepancy. Recorded as `reviewed` with that reviewer.
- #120: sampled review; one finding. The `pt-BR` and `es-419` `!autoschedule weekly` hint showed a
  translated day word the parser refuses. Fixed (the hint uses `monday`), with a regression test
  in `tests/scheduling.test.mjs` that parses every locale's example.
- Automated cross-locale audit of every `pt-BR` and `es-419` file: no Arabic left in a Latin
  locale, no lost product name, command and sub-command tokens equal to English except marked
  placeholders.
- No file is described as native-speaker reviewed.
- Relay: levix-ui #22 merged and deployed (run 41360221956, check and deploy jobs success). A
  probe that cannot send mail (`kind: reset`, an example.com address, a well-formed unknown token)
  answered `400 invalid` for `lang: pt-BR` before the deploy, and `403 unverified` for `pt-BR`,
  `es-419` and `en` after it (`fr` stays `400 invalid`). #115 merged only after that.

### 10.6 Final gates on `main` 8651514 (2026-11-02, Linux x64, Node v24.22.2, local)

| Gate | Result |
| --- | --- |
| `npm test` | PASS, 8479 checks, 0 failed |
| `npm run i18n:check` | PASS, four required locales |
| `npm run lint` | PASS, 0 errors (181 warnings, 6 more than `main` b6e777e) |
| `npm run build:frontend` | PASS |
| `./gradlew :app:testDebugUnitTest :app:assembleDebug :app:assembleRelease :app:bundleRelease` | PASS |
| Release APK size | arm64 58,986,914 bytes; armv7 54,559,340 bytes |
| Release AAB size | 86,598,073 bytes |
| Debug APK size (clean package) | arm64 64,704,170 bytes, 406,928 less than `main` b6e777e; armv7 59,789,004 bytes |
| APK locales (`aapt2 dump badging`) | ar, es, es-419, pt, pt-BR plus default |
| CI on each merged PR head | PASS, 7 of 7 jobs |

One `main` push run (c0f0c6b) failed in `tests/start-order.test.mjs` ("one simultaneous starter
wins", a Phase 02 two-process race test); the same tree passed on its PR, and the rerun of the
failed job passed. Recorded as a flaky test.

### 10.7 Not done or not run

- AI review of the 10 `draft` files' new keys (section 10.4): NOT RUN. Native-speaker review: not
  required (Q-19) and NOT RUN.
- Android device QA (picker, offline language switch, notification language on API 29 to 32 and
  33+): NOT RUN. Google Play download sizes: NOT RUN (only Play Console or `bundletool` may
  report them).
- `validate:sea`, `validate:tarball`, `validate:docker` locally: NOT RUN; CI runs them on every PR
  and on `main`.
- Two `tr()` calls stay by design (section 10.4).
- `tests/start-order.test.mjs` failed once on CI (section 10.6); not investigated in Phase 03.


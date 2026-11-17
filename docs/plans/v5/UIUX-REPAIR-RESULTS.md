# Levix v5 UI/UX repair: results (2026-11-17)

Branch `fix/v5-ui-ux`, from `release/5.0.0-beta.1` at `0bc2a88`. Not pushed, not merged.
Orchestrator: Claude Code (Opus 5.5). Implementers: Codex (gpt-6.1-sol), Grok, agy
(gemini-4-argon-high, claude-sonnet-5-5-high, gemini-3.8-flash-high), OpenCode
(deepseek-v4.1-flash-free). Reviewers: Grok (read-only) and Codex (read-only).

Evidence came from an isolated scratch install (`--data` in the session scratchpad, WhatsApp
never started, outbound WhatsApp proxy pinned to `socks5 127.0.0.1:9`, fake groups and
contacts seeded into SQLite) driven by headless Chrome (puppeteer-core 24.43.1). No real
WhatsApp number, purchase or production endpoint was used.

## A. Root causes

| Issue | Original behaviour | Root cause | Fix | Regression tests |
| --- | --- | --- | --- | --- |
| Reaction rules "not saving" | A rule on an old group was rejected with "This rule is not valid". | `exactJid()` (`src/automation/rules.cjs`), the intake pattern (`src/automation/reactions.js`) and `canonicalJid()` (`src/messaging/router.cjs`) accepted only `<digits>@g.us`. Legacy groups are `<digits>-<digits>@g.us`, and the chat picker offers them. | All three accept the legacy group form for the chat. Sender ids still reject any group id. A different group destination still needs membership (ADR-007). | `reaction-rule-issues`, `reactions-api` (create, reload, edit, enable, delete on a legacy id), `reaction-engine`, `reaction-routing` |
| Reaction checkboxes did nothing | All 7 message-type checkboxes were disabled on a new rule. | `emptyReactionDraft()` defaulted to action `stt` with `["voice"]`; the editor disabled the type checkboxes whenever the action was `stt`. | New rules start with no action and all 7 types. Transcribe shows a voice-only note in place of disabled boxes, and Ping restores the earlier selection. | `reaction-editor-logic`, `reaction-ui-static`, browser test (label tap toggles) |
| Rules looked voice-only | Same default. | Same. | Types are independent of voice for Ping; the summary says "all supported messages" when all 7 are chosen. | same |
| Emoji "👍h" | Muted hint text, then a generic error after a server round trip. | The client check was a hint only. | Live validation with the backend rule, danger styling, `aria-invalid`, Save blocked before any request. | `reaction-editor-logic` (5 valid, 4 invalid samples), browser test (no POST sent) |
| Duplicate "Send the result to" | Label printed twice. | `RadioGroup` got a visible `label` inside a `Field` with the same label. | One visible label; the group keeps an accessible name. | `reaction-ui-static` |
| Internal keys in message templates | `bot.ai.gemini.reference` and similar under each message; raw areas like `bot.ai` in the filter. | `MessagesTab.tsx` printed `item.key`; the text fell back to the key; `t()` fell back to the key. | Keys never render; translated area names; placeholders explained; counter reads "Characters used: N of M". `t()` returns fallback, English, then empty. | `ui-no-raw-keys` |
| Raw error text | Toasts showed `err.message` ("Error fetching recipients", "Failed to fetch models", API codes). | About 40 call sites passed `err.message` to the UI. | `userErrorMessage(t, err, fallbackKey)`: known code, then HTTP status class, then network failure, then an action-specific fallback. | `user-error`, `ui-no-raw-keys` (fails on `toast(err.message` and similar) |
| "help!" in Arabic | Prefix preview, command lists and 5 catalog sentences rendered `help!`, `lang ar!`. | A neutral `!` at the start of a Latin token inside an RTL paragraph moves to the end. | `CodeText` primitive (`<bdi dir="ltr">`); U+2066/U+2069 around commands in 5 Arabic strings. | `bidi-command-text` (proven to fail on the old catalog) |
| Two recipients both named "Contact" | Two different `@lid` contacts were identical in the picker. | `describePeer()` (`src/db/store.cjs`) fell back to the English literal "Contact". | `nameSource` field (old fields kept); `recipientLabel.ts` builds a translated title, a phone or member-count subtitle with Arabic plurals, and an "ID …1234" tail for unknown ids. | `recipient-labels`, `panel` |
| No account card on Home | Home showed only a status heading. | Card existed only on Connection. | Compact `ConnectedAccountCard` on Home: number masked until revealed (kept from the old Home), one status line per session state, Manage session, Start for a stopped linked session. | `account-card-state`, `account-profile-panel` |
| Levix Plus hidden in Settings | Plus was a Settings tab. | Navigation design. | Sidebar entry with a vector crown, `#plus` page, `#settings/plus` redirect, crown on the brand mark when active, two in-context rows (AI: auto-reply; Commands: replies). State only from `usePlusStatus()` + `accessFromStatus()`. | `plus-access`, `plus-nav-static` |
| Status colours unreadable in light theme | warn 2.15:1, ok 2.54:1, danger 3.76:1, info 3.68:1 on white. | One fixed hex per status for both themes. | Per-theme tokens; `danger-fill` keeps white button text at 4.5:1 or more. | `ui-contrast` |
| Moderation preview showed `*asterisks*` | Raw WhatsApp markdown. | Rendered as one string. | Segment parser renders bold, italic, strike, monospace. Presets explain what they set, with Undo after replacing manual edits; warning explanation; unsaved-changes hint; Arabic member plurals. | `moderation-ui` |
| Quick prefix row cut off | The last prefix button was clipped at 360px behind a hidden scrollbar. | `overflow-x-auto no-scrollbar`. | Buttons wrap. | screenshot |

## B. Implementation summary

- Reactions: `frontend/src/views/reactions/*`, `frontend/src/utils/reactionRules.ts`, `Dialog`
  `mobileFullscreen` variant (sticky footer, safe-area padding), `src/automation/*`,
  `src/messaging/router.cjs`.
- Recipients and schedules: `src/db/store.cjs` (`describePeer`), `src/routes/dashboard.api.esm.js`,
  `frontend/src/utils/recipientLabel.ts`, `RecipientPicker.tsx`, `SchedulesView.tsx` (disabled-reason
  hint, summary with the panel timezone).
- Text and direction: `CodeText`, `I18nContext` `t()`, `templateLabels.ts`, `timezoneLabel.ts`,
  `MessagesTab.tsx`, `TemplateEditor.tsx`, command views, Settings prefix card.
- Errors: `frontend/src/utils/userError.ts` and its call sites.
- Home and Connection: `OverviewView.tsx`, `ConnectedAccountCard.tsx`, `accountCardState.ts`,
  Connection danger zone (Stop, Unlink) with the existing confirmations.
- Levix Plus: `usePlusStatus.ts`, `plusAccess.ts`, `components/ui/plus.tsx`, `Sidebar.tsx`, `App.tsx`,
  `PlusSettings.tsx`, `PlusFeaturesView.tsx`.
- Groups: `GroupsView.tsx`, `moderationText.ts`.
- Tokens: `frontend/src/index.css`, `button.tsx`.
- Docs: `AGENTS.md` (screens and three enforced UI rules), `i18n/review.json` (pt-BR and es-419
  marked as an unreviewed machine draft for the new strings).

## C. Verification

Local checks ran on Linux, Node 24, branch `fix/v5-ui-ux`, 2026-11-17. CI ran on GitHub
Actions for PR #182.

| Check | Command | Result |
| --- | --- | --- |
| Typecheck | `cd frontend && npx tsc -b` | PASS (exit 0) at `9d5e277` |
| Lint | `npm run lint` | PASS at `bd545cb`: exit 0, 0 errors, 238 warnings (233 at `0bc2a88`) |
| i18n | `npm run i18n:build && npm run i18n:check` | PASS |
| Unit and integration tests | `npm test` | PASS at `bd545cb`: 65,948 checks, 0 failed, 0 crashed |
| Production build | `npm run build:frontend` | PASS at `9d5e277` |
| Browser E2E, reaction rules | headless Chrome 360x740, `rx2.mjs`, en and ar | PASS 10/10 each: no disabled checkbox, label tap toggles, legacy group saves (201) and lists after reload, "👍h" blocked with no request |
| Visual sweep | `shots.mjs`: 9 screens x (ar, en) x (360, 1280) plus Plus locked and active | PASS: 70 captures, 0 horizontal overflow, 0 raw keys, 0 duplicate "Contact"; Plus states MOCKED by request interception |
| Recipient picker | headless Chrome, ar | PASS: distinct unknown contacts, Arabic plurals, LTR phone numbers |
| Independent review | Grok read-only | 3 P2 findings (Plus status cleared on failure, switch race, tab hash), all fixed in `9d5e277` with static checks |
| Independent review | Codex read-only at `9d5e277` | "Ship as is" |
| CI | GitHub Actions run `44168499582` at `8846706` | PASS, 7/7 jobs (table below) |
| Android device | WebView, keyboard, back button, safe area | NOT RUN (no device session) |
| Live WhatsApp | reaction execution, real profile on the card, schedule send, E2EE | NOT RUN (no test account in this session) |
| Google Play Billing / Levix Plus | real purchase, renewal, grace, expiry, restore | NOT RUN; Plus states were simulated by request interception only |

### CI run `44168499582` (PR #182, head `8846706`, 2026-11-17): PASS 7/7

| Job | What it ran | Result |
| --- | --- | --- |
| tests | `npm ci`, `npm test`, `npm run lint`, `npm run i18n:check`, `npm run docs:check`, shell script checks (Ubuntu) | PASS |
| android apk builds | Android unit tests; debug APKs; release APKs and AAB signed with the debug key; `levix-app.zip` scan; Phase 09 Play dependency and size reports (API 36 SDK, NDK, arm64 and armv7 Node runtimes and FFmpeg) | PASS |
| package installs and boots | `npm run validate:tarball`: packs the npm tarball, installs it into a clean prefix and boots it (Linux, Node); tarball scan | PASS |
| container persists its volume | `npm run validate:docker`: builds the image, starts it, claims the panel, restarts, upgrades the volume; image scan | PASS |
| executable runs (ubuntu-latest) | `npm run build:sea`, executable scan, `npm run validate:sea` | PASS |
| executable runs (macos-latest) | same | PASS |
| executable runs (windows-latest) | same | PASS |

The Android job builds and unit-tests the app. It does not install or launch the APK on an
emulator or a phone, so no Android boot, WebView rendering or touch check ran in CI. "package
installs and boots" boots the npm package on Linux, not on Android. Real-device QA stays NOT RUN.

## D. Remaining issues

Release blockers for this branch (manual QA, owner-run):

- PENDING: physical Android device UI/UX QA (the checklist in section F).
- PENDING: live WhatsApp integration with a dedicated test account, including E2EE delivery of
  reaction-rule results.
- PENDING: real Google Play Billing and Levix Plus entitlement scenarios; only simulated states
  were tested.

Known limitations:

- The schedule form needs a connected session, so it was checked by static tests and the shared
  picker only; its layout was not seen in a browser.
- The full-screen reaction dialog on Android: keyboard overlap, the back button and safe-area
  insets are untested on a device. No Android back-button handling was added for it.
- `frontend/src/gateway/login.tsx:287` and `frontend/src/gateway/main.tsx:231` still have raw
  error fallbacks (gateway pages were outside every task).
- Timezone labels use CLDR names ("Eastern European Time (UTC+02:00)"); Intl has no city label.
- Touch targets follow the project minimum of 40px (AGENTS.md); the 44-48px target in the brief
  was not applied globally.
- No automated visual-regression suite exists; screenshots were reviewed by hand.
- Unused catalog keys were left in place: `plusMessagesEdited`, `plusRestoreDefault`,
  `reactionOutcomeUnknown`, `thMembers`, `policyActionDefault`, `actionDelete`, `actionDeleteWarn`,
  `actionDeleteKick`, `actionWarn`, `actionKick`, `kickFlagged`.
- In moderation, fields of a feature that is switched off stay editable and look the same.
- pt-BR and es-419 strings added here are an unreviewed machine draft (Q-19 review pending).
- The API still returns the English "Contact"/"Group" `label` for older clients; the panel no
  longer shows it.

## E. Acceptance checklist

| Requirement | Status | Evidence |
| --- | --- | --- |
| Reaction rules configure, save, reload, edit, delete | PASS | `reactions-api`, browser test |
| Reaction controls work | PASS | browser test, `reaction-ui-static` |
| Reactions not limited to voice | PASS | `reaction-editor-logic`, browser test |
| Message types match platform support | PASS | the 7 types `originalType()` classifies |
| No internal identifiers in normal UI | PASS for the panel; gateway has 2 raw fallbacks | `ui-no-raw-keys`, `user-error`, visual sweep |
| RTL/LTR mixed text | PASS in headless Chrome | `bidi-command-text`, screenshots |
| Home account card | PASS with an unlinked install; PENDING with a real linked profile | `account-card-state`, screenshots |
| Schedule recipients distinguishable | PASS | `recipient-labels`, picker capture |
| Group settings readable | PASS | `moderation-ui`, screenshot |
| Mobile form layouts | PASS in headless Chrome at 360px; PENDING on a physical Android device | screenshots |
| Levix Plus in sidebar with crown | PASS with simulated status; PENDING with real Play Billing | `plus-nav-static`, screenshots |
| Subscriber state shown correctly | PASS with simulated status; PENDING with real Play Billing | `plus-access` |
| Premium settings discoverable with locks | PASS with simulated status; PENDING with real Play Billing | `plus-nav-static`, screenshots |
| Free features remain free | PASS: no free control gated | `plus-nav-static`, review |
| Automated checks pass | PASS locally and in CI run `44168499582` (7/7) | section C |
| Physical Android device QA | NOT RUN / PENDING | section F |
| Live WhatsApp integration and E2EE | NOT RUN / PENDING | section F |
| Real Play Billing / Plus entitlement | NOT RUN / PENDING | section F |

## F. Remaining manual QA (owner-run)

Use the dedicated test account and the `.dev` build, not a personal number.

Physical Android device (Arabic and English, light and dark):
1. Reaction rule editor opens full screen; the keyboard never covers the emoji field or Save.
2. Android back closes the editor without losing a saved rule and without leaving the panel.
3. Every checkbox and its label toggle by touch; "All supported messages" selects all 7 types.
4. Safe-area insets: the sticky Save/Cancel footer clears the gesture bar.
5. Home account card: photo, name, masked number, reveal, Manage session, Start after Stop.
6. Commands, Settings prefix preview and Arabic descriptions read `!help` in order.
7. Schedule form: recipient picker rows, disabled-reason hint, summary with the timezone.
8. Group settings: preset notice and Undo, unsaved-changes confirm, formatted preview.
9. No horizontal scroll on any screen in portrait; landscape where the app allows it.

Live WhatsApp (test account and test groups only):
10. A Ping rule on a modern group and on a legacy `<digits>-<digits>@g.us` group runs once.
11. A Transcribe rule on a voice note replies in the source chat; nothing reaches another chat.
12. Rule results arrive end-to-end encrypted on recipient phones (E2EE, Phase 07.5 method).
13. The account card shows the real profile after pairing and the right state through a reconnect.

Google Play Billing / Levix Plus (license-test account):
14. Not subscribed: sidebar entry, locked in-context rows, Learn more opens `#plus`.
15. Purchase: crown on the brand mark and "Active" badge; rows open the right feature tab.
16. Renewal, cancel, grace and expiry move the UI the same way the Plus page does.
17. Verifier unreachable: the last state stays; nothing unlocks.

## G. Google Play Internal Testing build 76

Core `f3710631fba359e83e9d9ffa4d62c721659e27b8` (this branch, draft PR #182, not merged). Core CI run `44172154983` PASS 7/7.

Private levix-plus PR #19 (merged as `eea66cc`) moved `core.lock.json` to that Core. levix-plus CI passed. Cross-repository tests against this Core: 340/340 locally.

Build and upload: levix-plus run `44181528853` (`internal-play-aab.yml`, `UPLOAD_INTERNAL`). Both jobs success, 2026-11-17.

| Field | Value |
| --- | --- |
| versionCode | 76 |
| versionName | `5.0.0-beta.1-staging` |
| Release name | 5.0.0-beta.1-staging (76) STAGING |
| Track | internal |
| Status | completed |
| Play edit | `09057127212900976971` committed |
| Package | `net.leviro.levix` |
| AAB SHA-256 | `686740c011574a5616c272e8fafad3908a6e972b193875f03b30029396ed81cc` |
| Artifact | `levix-internal-free-plus` ID `14373038215` |
| Digest | `sha256:80a9ebc6699aec002db046db77f00a1ecb7a28d9c8fa0e35ba7ffa23ecdf8e67` |
| Expires | 2026-11-24T21:49:55Z |
| Signer | `jar verified.` |
| Upload certificate SHA-256 | `637dd885fd20efe78e59e340889556b9a8c31e34a52ac1af70f0bc10cf54905d` |

Classification: `verify-staging` passed. Staging verifier and its public key only (key id `5f6fba9447f1e681`). No private key in the AAB. This is a STAGING artifact and must never be promoted.

Verifier health before upload: production (`127.0.0.1:18787`) and staging (`127.0.0.1:8788`) `/healthz` 200. Both systemd units active.

Update compatibility: no database migration and no schema change in `0bc2a88..f3710631`. Pairing credentials and `levix.key` untouched. A new versionCode asks for Terms consent again (ADR-020). A closed tester whose Plus token came from the production verifier sees Plus unverified on this staging build until the staging verifier issues a token.

Closed testing: owner chose a separate production-verifier build of the same Core (`closed-play-aab.yml`, versionCode 77) after the Android smoke test passes on build 76. Not started.

Section F's 17 scenarios stay PENDING. They did not block Internal Testing.

### Android smoke test of build 76 (2026-11-18, Redmi 9, Arabic)

Device `fcc3e4fb0404` (Redmi 9, LineageOS), linked to the dedicated test account. Updated from build 74 through the Play Store internal listing. Panel checks ran over the WebView DevTools socket (`device-smoke.mjs`, read-only: nothing saved, no message sent).

| Check | Result |
| --- | --- |
| Play update 74 to 76 | PASS: `versionCode=76`, `versionName=5.0.0-beta.1-staging` |
| App launch | PASS: MainActivity, no entry in the crash buffer |
| Terms consent after update (ADR-020) | PASS: engine ready, WhatsApp held until consent; the owner accepted on the phone |
| WhatsApp session kept through the update | PASS: "متصل بالواتساب" (connected) with no re-pairing |
| Panel session kept | PASS: no login asked |
| Home account card | PASS: number masked, Manage session, connected state |
| Prefix preview in Arabic | PASS: `!help`, `!lang ar`, `!sticker` LTR-isolated, prefix first |
| Command names in Arabic | PASS: `!add`, `!all`, `!antilink`, `!antispam` LTR-isolated |
| Reaction editor | PASS: full screen (393 of 393 px), 11 checkboxes and 0 disabled, the Image label toggles and back, Cancel closes it |
| Levix Plus sidebar entry and page | PASS: entry shown, no raw keys |
| Raw keys on Home and Plus | PASS: none |

Not covered by this smoke test: touch input (clicks went through DevTools), the keyboard over the emoji field, the Android back button, number reveal, Start after Stop, schedules, groups, any rule execution, E2EE, Play Billing. Section F stays PENDING for those.

Found: on the Connection screen's full account card, the avatar shows "ح" (the first letter of "حساب واتساب") when WhatsApp gives no profile name. The compact Home card uses a phone icon instead. Cosmetic; not fixed in build 76.

# UI/UX fixes — recovered OpenCode context

Recovered on 2026-10-17 from OpenCode session
`ses_eb7dd06f9ffeAXzoJL3hgIN2k3` ("Greeting to DeepSeek") in this repository.
The export contains 123 conversation events, including 12 user messages and
13 screenshot attachments. The final outcome was interrupted, not completed.

Full source export: `/tmp/levix-opencode-session.json`.
Readable user/assistant/tool transcript and extracted screenshots:
`/tmp/levix-opencode-context/`.
Those temporary files retain the original detail; this document preserves the
decisions, implementation state, and remaining work for future sessions.
Do not commit the raw conversation or screenshots: they include account details.

## Current status — 2026-10-18

This document retains the recovered session history below. The adaptive Home
implementation supersedes the older circle/ring, status-pill, and header-layout
decisions. See [android/ADAPTIVE_HOME_QA.md](android/ADAPTIVE_HOME_QA.md) for the
current implementation and actual physical-device checks. Native Media Hub
selection/TalkBack and the full notification/log-export matrix remain outside
that completed Home-device pass.

## Existing work to preserve

The first request was the native Android home-screen cleanup. The user explicitly
selected these four options in OpenCode:

1. Logs: save to `Downloads/Levix`, then open in a viewer; keep the saved file
   even when no viewer exists. Sharing is the second action.
2. Battery: a prominent warning banner directly under the header while
   restricted; a quieter protected card once unrestricted.
3. Actions: one state-dependent Start/Stop primary button, with Open Control
   Panel as the secondary action below it.
4. Header: brand and status in the first row; language and appearance in the
   second row.

Implementation is present in the uncommitted working tree:

- [x] Remove duplicate language/appearance cards; retain the header controls.
- [x] Move the status pill beside the brand.
- [x] Promote Battery Guard and make its appearance follow restriction state.
- [x] Replace separate Start/Stop buttons with one state-dependent primary action.
- [x] Make Diagnostics clickable, opening Save & open / Share logs actions.
- [x] Give Media Hub its own icon and update the Android documentation.

Owners: `MainActivity.kt`, `activity_main.xml`, `LogsActionsSheet.kt`,
`sheet_logs_actions.xml`, `HostLogShare.kt`, Android strings/colors/drawables,
and `ANDROID.md`.

Verification recorded in the original OpenCode session: Android Kotlin compilation and
unit tests returned exit 0; `npm test` reported 3805 checks, 0 failed, 0 crashed
files. These were the baseline checks before the implementation below. The earlier
agent had no attached device/emulator, so visual and interaction QA remains open.
No commit or publication was made by this recovery task.

## Implemented fixes and verification

### 1. Correct the Overview group total

- [x] Make the total agree with the groups the panel can actually list, including
  groups with no saved moderation settings.
- [x] Reuse the group-list sources and existing synchronization; do not fetch
  every group from WhatsApp on each stats poll.
- [x] Verify two known groups with zero `group_settings` rows produce total 2,
  and that groups present in multiple sources are counted once.

Confirmed cause: `/stats` uses `countGroups()`, which counts only
`group_settings`; `/groups` unions settings, `groupMetadataCache`, and
`group_directory`. Owners: `src/routes/dashboard.api.esm.js`,
`src/db/store.cjs`; inspect existing synchronization in `src/core/connection.js`.
Original reference: screenshot 1.

### 2. Replace technical identities with names people recognize

- [x] Show saved contact name, then push name / available username or name,
  then a formatted real phone number as fallback. Show group subjects for groups.
- [x] Apply this to the AI conversation inspector and audit other visible
  contact/chat labels. Keep raw identifiers as internal keys.
- [x] Resolve LIDs through existing identity/mapping facilities; never format
  LID digits as if they were a phone number. Use a translated unknown-contact
  fallback when no real name or phone can be resolved.
- [x] Preserve RTL isolation and safe rendering of user-provided names.

The user explicitly asked to remember this as a general display rule.
The inspector currently renders `row.chatId` directly, and its list endpoint
returns only chat ID, turns, and timestamp. Existing contact presentation in
`SchedulesView.tsx` and recipient APIs already carries saved/push names and
phone data: reuse or consolidate the fitting behavior.
Owners: `frontend/src/views/AIAssistantView.tsx`, corresponding API types,
`src/routes/dashboard.api.esm.js`, and existing contact-resolution helpers.
Original reference: screenshot 9.

### 3. Make the logs trash action clear stored logs

- [x] Replace the current state-only reset with actual clearing of the selected
  log source, followed by refreshing the view.
- [x] For Android host logs, clear both the private file and its external mirror
  through `HostLog`, using its existing write lock so one copy cannot restore
  the other and concurrent writes remain safe.
- [x] Trace bot log storage and live delivery before adding the corresponding
  authenticated clear operation. The client currently requests a logs endpoint
  that was returning 404 in the screenshot; resolve the read/clear contract.
- [x] Report failure and retain fresh log entries written after the clear.
- [x] Verify old entries stay gone after polling, changing source, reopening
  the page, and restarting. Keep deletion scoped to the selected operational
  logs, not unrelated data or separately exported Downloads copies.

Confirmed cause: `LogsView.tsx` only calls `setLogs([])` / `setHostLines([])`;
the host poll reloads the file every three seconds. `HostLog.kt` has two file
copies and can copy the private log back to external storage.
Owners: `frontend/src/views/LogsView.tsx`, API client/routes/logging owner,
`PanelBridge.kt`, and `HostLog.kt`. Original reference: screenshot 10.

### 4. Finish Arabic status and notification translations

- [x] Display `متصل` for connected in the WhatsApp status sheet's detail row;
  translate the other displayed lifecycle states consistently.
- [x] Translate the running notification title/status and Open Panel action.
- [x] Ensure an already running notification follows an app-language change.
- [x] Verify Arabic and English without changing internal state identifiers.

Confirmed causes: `WhatsAppStatusSheet.render()` puts `snapshot.whatsAppState`
straight into the detail row. `LevixHostService.kt` hardcodes `Connected` and
`Open Panel`, although Arabic resources already exist for related labels.
Owners: those Kotlin files and `res/values*/strings.xml`.
Original references: screenshots 11 and 12.

### 5. Fix shared toggle proportions and thumb spacing

- [x] Consult established accessible-switch guidance before implementing.
- [x] Make the visible switch smaller and give the thumb equal inset at both
  ends. Current geometry leaves only 2px at the ends of its 52px track.
- [x] Fix the shared `Toggle` once so all screens benefit.
- [x] Retain an adequate touch target, keyboard operation, visible focus,
  switch name/state, disabled behavior, and RTL movement.
- [x] Check on/off in both themes and both directions.

Owner: `frontend/src/components/ui/field.tsx` and its catalogue entry if the
primitive contract changes. Original references: screenshots 2, 3, 4, and 8;
the request explicitly applies to all pages.

### 6. Rework the Overview connection card

- [x] Remove the visible ONLINE word and retain a status dot at the card's
  top-right corner, with an accessible status name.
- [x] Keep the connection heading first and the phone number below it, with
  an eye action to hide or reveal it. Anchor the dot inside the top-right
  corner in both languages.
- [x] Keep status/actions readable on narrow screens, in Arabic RTL and English.

Owner: `frontend/src/views/OverviewView.tsx`, using shared UI primitives.
Original reference: screenshot 1. The number's default visibility was not
specified; choose a sensible reversible UI default without adding a database
setting just for this.

### 7. Put AI providers and prefix presets in horizontal strips

- [x] Replace the wrapping Active Provider grid with a single horizontally
  scrollable choice strip; preserve selected state and existing save behavior.
- [x] Give Common Quick Presets for command prefixes the same single-row
  scrolling treatment rather than wrapping onto a second row.
- [x] Keep labels readable and choices operable by keyboard/touch in both
  directions. Reuse the existing tabs/segmented-control family where it fits.

Owners: `frontend/src/views/AIAssistantView.tsx`,
`frontend/src/views/SettingsView.tsx`, `frontend/src/components/ui/tabs.tsx`.
Original references: screenshots 2 and 7.

### 8. Improve the three AI utility actions

- [x] Give Edit System Prompt, Manage Memory Files, and Open Inspector a
  consistent layout; use full-width actions on mobile as the user suggested.
- [x] Preserve their existing dialogs, dirty-state handling, and behavior.

Owner: `frontend/src/views/AIAssistantView.tsx`. Original reference: screenshot 3.

### 9. Redesign group cards and expose useful moderation details

- [x] Remove the raw group ID from normal presentation (the user called it LID;
  the screenshot actually shows a numeric group identifier).
- [x] Use compact summary cards that expand with animation to reveal details
  and controls; respect reduced-motion preferences and accessible expanded state.
- [x] Load actual group pictures when available, with a reliable fallback for
  missing, failed, expired, or inaccessible images.
- [x] Expose relevant existing settings and information: anti-link, anti-spam,
  media rules, welcome behavior, warning limit/action, group rules, and available
  moderation/command information, including kick behavior where supported.
- [x] Wire visible controls to real authorized behavior. Preserve admin and
  owner checks; do not invent kick histories or counters that are not recorded.
- [x] Preserve search/filter behavior and the existing 20-item pagination;
  verify pagination remains usable after the redesign.

Owners: `frontend/src/views/GroupsView.tsx`, `groupView()` and group APIs in
`src/routes/dashboard.api.esm.js`, frontend group types, and existing moderation
owners. The backend already exposes more settings than the mobile card shows.
Original reference: screenshot 4.

### 10. Remove duplicate empty-state actions

- [x] Show one create/schedule action when Scheduled Messages is empty, choosing
  the empty-state action for that state and retaining the header action once
  records exist.
- [x] Audit other pages for the same duplicate header + empty-state CTA pattern.
- [x] Keep error/retry and filtered-no-results states distinct from truly empty
  data; do not remove necessary recovery actions.

Start with `frontend/src/views/SchedulesView.tsx`; use existing `PageHeader` and
`EmptyState` primitives. Original reference: screenshot 5.

### 11. Redesign the sticker detail action layout

- [x] Put download and share in small icon controls over a top corner of the
  sticker preview, with readable contrast and accessible labels.
- [x] Keep Send via WhatsApp and favorite/star beside each other below it.
- [x] Keep secondary actions in the adjacent overflow menu and prevent actions
  from wrapping into isolated rows on narrow screens.
- [x] Preserve rename, pack membership, sending, download, and share behavior.

Owner: `frontend/src/views/stickers/StickerDetail.tsx`.
Original reference: screenshot 6.

### 12. Improve command detail fields and spacing

- [x] Give the Required Role value/field a comfortable height and padding; it
  currently looks like a thin badge stretched across the card.
- [x] Improve the hierarchy and spacing of aliases, role, scope, status, and
  usage, with readable wrapping for long bilingual text.
- [x] Preserve locked WhatsApp-admin permissions and the existing alias,
  enable/disable, and copy actions.

Owners: `frontend/src/views/commands/CommandDetails.tsx` and the mobile command
list; extend shared primitives if an actual shared field change is needed.
Original reference: screenshot 8.

### 13. Redesign native Media Hub controls and selection

- [x] Replace oversized header text buttons with clear icons and filter
  controls fitting within one or two rows. Refine the header actions as needed.
- [x] Ensure selected styling/border encloses the whole media card, including
  its image, rather than only the text portion. Inspect both grid and list
  holders: `MediaAdapter` already sets a selected background on its root.
- [x] Use clear icons for essential bottom selection actions; put less common
  actions in the three-dot menu.
- [x] Preserve search, filtering, multi-select, save/share, sticker handoff,
  and the existing restriction that only Levix-saved copies can be deleted.
- [ ] Verify native selection visibility, hit targets, disabled actions, TalkBack,
  RTL, and light/dark themes.

Owners: `android/app/src/main/res/layout/activity_media_hub.xml`,
`media/MediaHubActivity.kt`, `media/MediaAdapter.kt`, associated drawables and
strings. The original message labels its final Media Hub request "Image 12",
but attachments 12 and 13 are duplicate notification screenshots. The textual
Media Hub requirements above are preserved; no missing screenshot is needed
to begin the code investigation.

## Completion gates

- [x] Read `frontend/src/components/ui/README.md` before screen changes. Build
  from the shared primitives and tokens; simple actions use `IconButton`,
  filters use `FilterButton`, sorting uses `SortMenu`, and secondary actions
  use `OverflowMenu` when at least two belong there.
- [x] Use English and Arabic translations throughout. Preserve app/panel locale
  and theme synchronization without a WebView reload.
- [x] Add focused behavioral proof for group counting, stored-log clearing,
  identity fallbacks, and locale mapping where these change. Do not add tests
  that merely mirror styling or constant filenames.
- [x] Run the frontend build and relevant lint/tests for affected files. After
  Android changes, run Kotlin compilation and Android unit tests; run the full
  Node suite when completing the backend changes.
- [ ] Finish native visual and interaction QA on a device in both
  themes/languages, including native media selection, status notifications,
  and log export/clearing. Dashboard QA is complete at 360px in both themes
  and languages, plus desktop at 1280px. A successful Android build does not
  close native visual/TalkBack checks.
- [ ] Verify the first home-screen redesign on a device/emulator as part of
  the same QA pass; it remains unverified visually.
- [x] Update user-facing documentation if behavior changes. If a commit or PR
  is subsequently requested, include the repository-required bilingual
  `## Google Play` release notes. Publishing is outside this fix-list task.

## Implementation report — 2026-10-17

All 13 fix areas above have been implemented. The unchecked items are native
on-device verification; `adb devices` reports no attached device and no emulator
is installed here. No production WhatsApp session or account was used for tests.

- Frontend TypeScript/Vite production build passes.
- `npm run lint` completes with 0 errors (137 warnings and 56 informational
  diagnostics remain across the repository; unrelated lint cleanup was not added).
- Android Kotlin compilation and all 39 Android unit tests pass.
- `:app:assembleDebug` passes with the production dashboard staged into the app;
  both ARM64 and ARMv7 APKs are in `android/app/build/outputs/apk/debug/`.
- Browser QA uses an isolated temporary database and synthetic group/contact data.
  Arabic/English, dark/light, narrow 360px and desktop 1280px layouts were checked.
  No horizontal page overflow or browser exceptions occurred. Confirmed phone
  hide/reveal, 27-group pagination, group save and preservation of multiline
  welcome messages, provider keyboard navigation, human inspector names, one
  schedule creation action in the empty state, and persisted log deletion.
  Sticker preview actions were inspected with a harmless local brand-image fixture.
- Screenshots and browser transcripts are under `/tmp/levix-ui-qa/` and
  `/tmp/levix-ui-browser.log`, `/tmp/levix-ui-matrix.log`.
- Focused review findings were fixed: unique internal inspector keys, disabled
  form editing while saves are pending, account-bound phone reveal, safe native
  log export cleanup and background copying, and live-socket proxy ownership for
  group-photo downloads.

Operational log files now use synchronous Pino destinations so deleting old logs
has a precise boundary and queued writes cannot restore deleted entries. Console
formatting keeps its existing worker behavior. This trades buffered file writes
for a small amount of filesystem work on the bot's thread.

New tests cover real authenticated group/log/identity APIs, log persistence and
restart, photo destination/MIME/size limits, and proxy transport ownership. The
final Node suite passes **3990 checks, 0 failed, 0 crashed files**.

No commit, release, upload, or Play deployment was made.

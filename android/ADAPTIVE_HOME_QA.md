# Adaptive Home implementation and verification

Date: 2026-10-18. Branch: `main`, base commit `b980e43`.
Existing unrelated working-tree changes were retained. No commit, push, version
change, release, storage clear, uninstall, account unlink, or credential copy was performed.

## Implementation

- `HomePresentation.kt` is the pure snapshot-to-presentation mapping. A ready
  assistant requires a live node, engine readiness, a panel URL, and the actual
  WhatsApp `connected` state. Starting a service alone never completes setup.
- The stopped screen keeps the full circular power button. Pending starts are
  disabled immediately, survive activity recreation, and keep the existing
  notification permission flow. Startup and linking have a two-minute UI
  deadline with an actionable diagnostic/connection fallback; it does not kill
  or unlink anything.
- The circle disappears after startup. The adaptive card makes Connection the
  next action while unpaired, describes automatic reconnect/offline pause,
  directs terminal session failures to Connection, and uses diagnostics for
  engine errors. The ready presentation opens the panel. Stop is always a
  separate, subordinate action.
- Home rendering uses the existing state listener and a one-shot timeout rather
  than unconditional one-second polling. Rendering re-reads the current snapshot
  on the main thread. Node stop/error/restart invalidates readiness and stale
  WhatsApp details; late events while stopped are ignored.
- The Android boot bridge now sends the actual initial session snapshot. A
  fresh idle session previously emitted no transition, leaving Android without
  the state it needed to offer pairing. Authentication remains in the existing
  secure panel, reached through `/#connection`.
- Contextual steps advance from evidence and disappear when ready. Existing
  onboarding completion preferences, privacy/crash consent, Media Hub,
  diagnostics, foreground service, and battery exemption controls remain.
- Arabic uses bundled unmodified IBM Plex Sans Arabic Regular/Bold, with its
  OFL license in assets. Localized dimensions improve Arabic readability while
  preserving system font scaling. Main header positions stay physically fixed:
  brand left, language/theme right. The brand/subtitle gap is tighter, and
  **Levix** remains Latin in Arabic strings. Arabic password gateways have
  smaller headings/text and more line spacing. Both semantic color themes remain.
- `-PlevixIsolatedDebug=true` produces `net.leviro.levix.dev` for safe physical
  testing with separate storage. Normal builds retain `net.leviro.levix`.

### Task-owned files

- Android: `app/build.gradle.kts`, `host-boot.mjs`, `README.md`, this report.
- Kotlin: `HomePresentation.kt` (new), `HostState.kt`, `MainActivity.kt`,
  `OnboardingActivity.kt`, `WhatsAppStatusSheet.kt`.
- Layouts: `activity_main.xml`, `activity_onboarding.xml`, `sheet_logs_actions.xml`.
- Resources: English/Arabic strings; shared styles, themes and dimensions;
  Arabic themes/dimensions; `font/levix_arabic.xml` and its two font files;
  `assets/IBM-Plex-OFL.txt`; `bg_btn_start_circle.xml`, `bg_home_primary.xml`,
  `ic_power.xml`, and `color/home_primary_text.xml`.
- Tests: `HomePresentationTest.kt`, `tests/android-home-status.test.mjs`.
- Password gateway: `public/dashboard.css`.

Some of these files already contained user changes before this task; the final
Git diff also includes unrelated pre-existing work.

## Automated verification

| Verification | Actual result |
| --- | --- |
| Android `:app:testDebugUnitTest` | 56 tests, 0 failures/errors; 17 focused home-model tests |
| Home-model coverage | stopped, pending/duplicate start, timeout, process-not-ready, pairing, connected, reconnecting, paused, terminal errors, logged out, startup error, unknown, linking timeout, stale status after stop, recovery sequence, dead-engine invalidation |
| Full `npm test` run | 4,057 checks passed before the new bridge test was added |
| New real Android boot bridge regression | 3 checks passed independently; isolated fresh database/socket, no WhatsApp pairing |
| Panel regressions after password CSS change | 211 checks passed |
| `npm run lint` | Exit 0; 133 existing warnings and 56 informational diagnostics, no fixes applied |
| Focused Biome check of new Node test | Passed |
| `npm run build:frontend` | Passed; existing bundle-size/classic-script warnings |
| ARM64 isolated debug build | Passed, including runtime-stamp verification |
| ARM64 normal debug build | Passed, including runtime-stamp verification |
| String resources | 243 entries in each language; no duplicate names or missing Arabic keys |
| `git diff --check` | Passed |

Runtime staging was already current. No runtime check was bypassed and no
unnecessary second ABI was downloaded or built.

### APKs

- Normal: `app/build/outputs/apk/debug/levix-android-arm64.apk`
  (`net.leviro.levix`, version 4.7.0 / code 65).
- Isolated: `app/build/outputs/apk/qa/levix-qa-arm64.apk`
  (`net.leviro.levix.dev`, same version).

The normal APK was **not** installed over the running installation. Installed
and built debug certificates were checked and matched; isolation was chosen to
avoid interrupting the existing foreground service anyway.

## Physical device verification

ADB detected exactly one authorized physical realme RMX3636: Android 15,
`arm64-v8a`, 1080 × 2400, density 480. The isolated QA package installed and
launched successfully. The original application remained PID 484 during the main device checks.
A final read-only exit-history check later found that Android killed it at
10:47:56 device time: reason 13, OTHER KILLS BY SYSTEM, description `o-kill(2)`.
There was no installed-app update or force-stop by this task. Its credentials
and storage were not modified, and it was not automatically restarted.
The final QA installation is stopped with no host foreground service running.

Actually exercised:

- Launcher onboarding: all five steps, including privacy and diagnostics, and
  completion to home.
- Stopped circle, full touch surface, progress feedback, notification denial
  and subsequent grant, engine startup, and Stop/restart in QA.
- Rapid start taps: the reviewed QA process log contained one user start
  request and one node startup, with no startup failure or unexpected exit.
- Fresh engine state advancing to pairing guidance after the bridge fix.
- Connection deep link through both first-time password setup and later login.
- Pairing-code and QR option tabs. No number was entered, code requested, QR
  generated, or WhatsApp account paired.
- Background/foreground and recreation from language/theme changes, with
  state refreshed from the service.
- English and Arabic; Light/Dark home layouts; Arabic password page in both
  themes; Arabic status sheet in Light; Android system bars and Back/app-return.
- Arabic 160% system text size, readable circle, wrapping and scrolling; the
  original 100% system setting was restored.
- Battery Guard opening Android's exemption prompt for QA and returning to a
  compact healthy card after granting the QA exemption.
- Private QA-process log review: no fatal exception, fatal signal, or ANR
  markers. Only a count summary is exported; raw logs are not shared.

### Visual evidence

Reviewed screenshots and the log-count summary are local build artifacts under
`build/reports/adaptive-home/` (ignored by Git):

- [Arabic header and stopped state](build/reports/adaptive-home/final-header-ar-dark.png)
- [Arabic pairing guidance, Light](build/reports/adaptive-home/final-home-ar-light.png)
- [Arabic pairing guidance, Dark](build/reports/adaptive-home/final-pairing-ar-dark.png)
- [Arabic password page, Dark](build/reports/adaptive-home/final-password-ar-dark.png)
- [Arabic password page, Light](build/reports/adaptive-home/final-password-ar-light.png)
- [Connection destination](build/reports/adaptive-home/final-connection-ar-light.png)
- [QR option without generating a QR](build/reports/adaptive-home/final-qr-options-ar-light.png)
- [Read-only status sheet](build/reports/adaptive-home/final-status-sheet-ar-light.png)
- [Arabic 160% text](build/reports/adaptive-home/large-text-ar-dark.png)
- [Arabic 160% scrolling](build/reports/adaptive-home/large-text-ar-dark-scroll.png)

Screenshots contain QA screens without phone numbers, tokens, codes, or private
messages. Some state/large-text captures precede the last header-spacing and
shortened-step-label adjustment; the header and password captures show those
final changes.

## Limits and completion

The implementation, automated gates, both APK builds, and safe physical-device
checks are complete. To resume the original installation after the Android
system kill, open the original Levix app and start its assistant. No account
reset or re-pairing was performed or is requested by this task. Connected/reconnecting/paused/expired/terminal-error
presentations were verified by state tests, not by forcing a live account into
those conditions. The isolated installation cannot reuse the existing account,
and no credentials were copied for testing. No new instrumentation runner was
introduced; physical checks used ADB/UIAutomator and screenshot review.

A late repeat of English large-text screenshots was skipped when UIAutomator
returned another application's accessibility hierarchy. The automation refused
to tap or capture that surface. Earlier English home/theme checks succeeded;
Arabic 160% checks were completed. Final tests do not claim a physical connected
session, destructive recovery, or a complete device/OS matrix.

## Follow-up: compact status-card headers

WhatsApp and engine icons now sit alongside their titles in the same row.
The WhatsApp pill uses short localized state labels (including Pairing /
يلزم ربط and Unknown / غير معروف), with explanations below the pill.
Badges remain one line, with a bounded width for large-font layouts.
The isolated app update was installed without clearing data; the session was
idle before the update. Android unit tests remained 56/56 passing, and both
ARM64 APK builds passed. The Arabic status cards were reviewed on the phone;
see `build/reports/adaptive-home/status-cards-ar.png`.

# Levix Android Host — Implementation Plan & Project Instructions

> Goal: run the **Levix core itself** on an Android ARM64 phone, with the phone acting as the server.
>
> Initial target: **Android ARM64, Android 10+**, distributed as an APK from GitHub Releases.
>
> The first successful milestone is not “a polished Android app”. It is:
>
> **Levix boots inside an Android Foreground Service, persists its data locally, connects to WhatsApp, answers `!ping`, and stays alive with the screen locked.**

---

# 1. Product Goal

Build an Android version of Levix where:

- The Android phone is the host/server.
- No VPS is required.
- No Termux is required.
- No npm commands are required by the end user.
- Levix core remains the same Node.js application as much as possible.
- The existing Levix Web Panel is reused inside an Android WebView.
- WhatsApp connection, SQLite data, schedules, AI, memory, commands, and settings run locally on the phone.
- The Android app keeps Levix alive using Android-supported background execution primitives.
- APK releases are produced from the same Levix repository and shipped through GitHub Releases.

Target user experience:

```text
Install Levix.apk
        ↓
Open app
        ↓
Start Levix
        ↓
Allow notifications/background execution
        ↓
Link WhatsApp
        ↓
Levix stays running in background
        ↓
Open app anytime to manage it
```

---

# 2. Non-Goals for the First Version

Do **not** attempt these during the initial proof-of-concept:

- Google Play Store publishing (later; not in the first versions).
- iOS support.
- Android x86/x86_64 support.
- 32-bit ARM support.
- Rebuilding the Levix dashboard natively.
- Full media/FFmpeg support.
- Perfect support for every aggressive OEM battery manager.
- A complete Android-native settings UI.
- Multi-instance Levix hosting.
- Background operation without a visible foreground notification.
- Bypassing Android restrictions.

The first target is **reliable Android ARM64 hosting**, not polish.

---

# 3. High-Level Architecture

```text
Levix Android APK
│
├── Android Native Shell — Kotlin
│   ├── MainActivity
│   ├── Foreground Service
│   ├── Boot Receiver
│   ├── Notification
│   ├── Battery optimization onboarding
│   ├── Native runtime launcher
│   └── WebView
│
├── Embedded Node.js 24 ARM64 runtime
│
├── Levix Core
│   ├── Baileys
│   ├── SQLite
│   ├── Scheduler
│   ├── AI
│   ├── Commands
│   ├── Memory
│   ├── Moderation
│   └── Web Panel
│
└── Android private app storage
    ├── database
    ├── WhatsApp auth/session
    ├── memory
    ├── logs
    └── runtime state
```

Levix should bind its local Web Panel to:

```text
127.0.0.1:<port>
```

The Android WebView loads that local panel.

---

# 4. Core Engineering Principles

## 4.1 Preserve the Levix core

Avoid forking or rewriting core behavior for Android.

Prefer:

```text
platform adapter
```

over:

```text
Android-specific copy of Levix
```

The same core should continue working on:

- npm
- Docker
- Linux/systemd
- standalone binaries
- Android

## 4.2 Android-specific behavior stays isolated

Android code should live under a clearly isolated area such as:

```text
android/
```

Potential structure:

```text
android/
├── app/
├── native/
├── scripts/
├── README.md
└── build.gradle.kts
```

Platform-specific JS helpers may live under something like:

```text
src/platform/
├── node.cjs
└── android.cjs
```

Do not spread `if (android)` checks throughout unrelated modules.

## 4.3 No secrets outside private app storage

All runtime data must stay inside Android private storage.

Never write WhatsApp credentials or Levix secrets to:

- Downloads
- shared storage
- SD card
- public logs

## 4.4 Do not weaken desktop/server behavior

Any Android work must preserve existing behavior for normal Levix installations.

---

# 5. Phase 0 — Repository & Architecture Preparation

## Objective

Prepare the repository for Android work without changing runtime behavior.

## Tasks

- [ ] Create `android/` directory.
- [ ] Add Android project skeleton using Kotlin.
- [ ] Target ARM64 only initially.
- [ ] Minimum Android version: Android 10 / API 29.
- [ ] Choose a modern compile/target SDK supported by current Android tooling.
- [ ] Add `android/README.md`.
- [ ] Document build prerequisites.
- [ ] Define Android package name, e.g.:
  - `net.leviro.levix`
- [ ] Define Android-specific app data directory mapping.
- [ ] Define native ↔ Node runtime startup boundary.
- [ ] Decide whether embedded Node is:
  - launched as an embedded native runtime, or
  - hosted through JNI/native bridge.
- [ ] Add Android artifacts to `.gitignore`.
- [ ] Keep Android build isolated from normal `npm test`.

## Acceptance Criteria

- Android project opens and builds.
- APK launches.
- Existing Levix CI/tests remain green.
- No Levix core functionality is changed yet.

---

# 6. Phase 1 — Android Foreground Host Shell

## Objective

Prove Android can host a long-running Levix process correctly.

## Tasks

### Main Activity

- [ ] Build minimal `MainActivity`.
- [ ] Show:
  - Levix status
  - Start button
  - Stop button
  - Open Panel button
- [ ] No design polish required.

### Foreground Service

- [ ] Implement a dedicated foreground service.
- [ ] Use an appropriate Android foreground-service type for the use case.
- [ ] Show a permanent notification while Levix is running.
- [ ] Notification text example:

```text
Levix is running
WhatsApp: disconnected
```

- [ ] Add notification actions if useful:
  - Open
  - Stop
- [ ] Use Android-supported restart behavior.
- [ ] Ensure service shutdown is clean.

### Lifecycle

- [ ] Service must survive Activity closing.
- [ ] Test app swiping from Recents.
- [ ] Distinguish:
  - user explicitly stopping Levix
  - Android reclaiming the process
  - app crash

### Logging

- [ ] Add local Android host logs.
- [ ] Do not log secrets.
- [ ] Add clear startup/shutdown events.

## Acceptance Criteria

With the screen locked and Activity closed:

- foreground notification remains
- service remains alive
- simple internal heartbeat continues for at least 1 hour

No Node runtime yet required.

---

# 7. Phase 2 — Embedded Node.js 24 Runtime

## Objective

Run Node.js 24 inside the APK on Android ARM64.

## Strategy

Do not depend on Termux at runtime.

Use Android-compatible Node.js ARM64 builds/patches as reference where needed, but package the runtime inside Levix Android.

## Tasks

- [ ] Build or integrate Node.js 24 for Android ARM64/Bionic.
- [ ] Package runtime inside the APK.
- [ ] Ensure executable/native code is packaged in Android-supported locations.
- [ ] Create JNI/native bridge if required.
- [ ] Launch a tiny JS file from Foreground Service.
- [ ] Capture stdout/stderr safely.
- [ ] Pass:
  - data directory
  - app files directory
  - runtime flags
  - Android environment markers
- [ ] Add clean runtime shutdown.
- [ ] Prevent starting two Node runtimes simultaneously.
- [ ] Detect crash and expose state to UI.

Test JS:

```js
console.log(process.version);
console.log(process.platform);
console.log(process.arch);
setInterval(() => console.log("heartbeat"), 30_000);
```

## Acceptance Criteria

The APK:

- starts embedded Node 24
- reports ARM64 correctly
- runs continuously with screen locked
- can be stopped cleanly
- can be started again without restarting the phone

---

# 8. Phase 3 — Boot Minimal Levix Core

## Objective

Boot Levix itself without WhatsApp or media being the focus yet.

## Android Platform Adapter

Create a minimal abstraction for platform-specific behavior.

Potential Android requirements:

- data directory
- no desktop browser auto-open
- local panel bind
- unsupported CLI features
- ffmpeg behavior
- paths
- process lifecycle

## Tasks

### Data Directory

- [ ] Force Levix data into Android private app storage.
- [ ] Ensure all mutable files remain there.
- [ ] Confirm:
  - SQLite DB
  - logs
  - memory
  - WhatsApp auth
  - settings
  - lock/state files

### CLI / Server Assumptions

Disable or adapt Android-incompatible flows:

- [ ] systemd installer logic
- [ ] domain auto-configuration
- [ ] nginx/caddy setup
- [ ] browser auto-open
- [ ] desktop-specific paths

### SQLite

- [ ] Verify Node 24 `node:sqlite` works correctly on Android build.
- [ ] Create database.
- [ ] Run migrations.
- [ ] Restart app.
- [ ] Confirm persistence.

### Core Startup

- [ ] Load Levix core.
- [ ] Load commands.
- [ ] Start scheduler.
- [ ] Start panel on localhost.
- [ ] Handle shutdown gracefully.

## Acceptance Criteria

Levix boots inside Android and reports:

```text
Levix ready
Database ready
Commands loaded
Panel listening
```

Restarting the app preserves data.

---

# 9. Phase 4 — WhatsApp / Baileys Integration

## Objective

Connect Levix to WhatsApp from Android.

## Tasks

- [ ] Verify Baileys dependency installs/packages correctly into Android bundle.
- [ ] Verify WebSocket connectivity.
- [ ] Verify DNS/TLS networking.
- [ ] Verify auth state persistence.
- [ ] Support initial pairing.
- [ ] Connect successfully.
- [ ] Send `!ping`.
- [ ] Receive correct response.
- [ ] Restart Levix.
- [ ] Verify saved session reconnects automatically.
- [ ] Test network disconnect/reconnect.
- [ ] Test Wi‑Fi → mobile data transition.
- [ ] Test airplane mode on/off.
- [ ] Ensure no duplicate sockets after reconnect.

## Acceptance Criteria

Core test:

```text
Android APK
↓
Levix starts
↓
WhatsApp pairs
↓
!ping works
↓
screen locks
↓
!ping still works
↓
app/service restarts
↓
WhatsApp reconnects automatically
```

---

# 10. Phase 5 — Pairing UX

## Objective

Make WhatsApp pairing practical on the same device.

QR-only pairing is poor UX when WhatsApp and Levix are on the same phone.

## Tasks

- [ ] Investigate Baileys pairing-code flow.
- [ ] Add phone-number pairing where supported.
- [ ] Expose pairing flow through Android UI or local Web Panel.
- [ ] Clearly display pairing state:
  - idle
  - requesting code
  - waiting
  - connected
  - failed
- [ ] Keep QR as fallback if useful.
- [ ] Never log pairing secrets.
- [ ] Handle expired pairing attempts.
- [ ] Prevent multiple concurrent pairing attempts.

## Target Flow

```text
Open Levix
↓
Start
↓
Enter WhatsApp phone number
↓
Receive pairing code
↓
WhatsApp → Linked Devices
↓
Link with phone number
↓
Connected
```

## Acceptance Criteria

A normal Android user can pair Levix without needing another device.

---

# 11. Phase 6 — Reuse Existing Levix Panel via WebView

## Objective

Reuse the current Web Panel instead of rebuilding UI natively.

## Tasks

### Local Panel

- [ ] Bind panel to `127.0.0.1`.
- [ ] Use a deterministic/local port.
- [ ] Detect port conflicts.
- [ ] Do not expose the panel to LAN by default.

### WebView

- [ ] Add WebView screen.
- [ ] Open local panel.
- [ ] Handle loading/error states.
- [ ] Enable required JavaScript features.
- [ ] Disable unnecessary risky WebView capabilities.
- [ ] Avoid exposing arbitrary file access.
- [ ] Support back navigation cleanly.

### Android Native Status

Minimal native screen may show:

- Levix running/stopped
- WhatsApp connected/disconnected
- Open Panel
- Restart Core
- Stop Levix

Everything else should remain in the panel initially.

## Acceptance Criteria

User can manage normal Levix settings from inside APK with no separate browser.

---

# 12. Phase 7 — Reliable Background Operation

## Objective

Make Android a practical 24/7 Levix host.

## Tasks

### Foreground Execution

- [ ] Keep foreground service active.
- [ ] Use persistent notification.
- [ ] Verify service lifecycle on current Android versions.

### Battery

- [ ] Add onboarding explaining battery restrictions.
- [ ] Provide shortcut to battery optimization settings where appropriate.
- [ ] Detect whether optimization is still enabled where possible.
- [ ] Explain OEM-specific restrictions without attempting unsafe bypasses.

### Reboot

- [ ] Add `BOOT_COMPLETED` receiver.
- [ ] Restart Levix after reboot if user previously enabled auto-start.
- [ ] Never auto-start if user explicitly stopped Levix.

### Network Recovery

- [ ] Detect network restoration.
- [ ] Let existing Levix reconnect logic handle WhatsApp recovery.
- [ ] Avoid reconnect storms.

### Process Death

- [ ] Detect unexpected Node runtime exit.
- [ ] Restart with bounded backoff.
- [ ] Prevent infinite rapid crash loops.
- [ ] Surface persistent failure to user.

### Device State Tests

Test:

- [ ] screen off
- [ ] phone locked
- [ ] app removed from Recents
- [ ] battery saver
- [ ] Wi‑Fi disconnect
- [ ] mobile data switch
- [ ] airplane mode
- [ ] reboot
- [ ] charger unplugged
- [ ] long idle period

## Acceptance Criteria

Pass progressively:

- 1 hour
- 8 hours
- 24 hours
- 72 hours

Success means:

- service alive or properly recovered
- WhatsApp connection recoverable
- schedules still execute
- no runaway CPU
- no runaway memory
- no reconnect loop
- no corrupted SQLite/auth state

---

# 13. Phase 8 — Android Observability

## Objective

Make failures diagnosable without ADB.

## Tasks

- [ ] Add Android host status screen.
- [ ] Show:
  - Node runtime status
  - Levix core status
  - WhatsApp status
  - uptime
  - last restart
  - last error
- [ ] Export sanitized logs.
- [ ] Never export:
  - WhatsApp auth
  - API keys
  - session secrets
  - setup tokens
- [ ] Add optional diagnostics bundle.
- [ ] Show version/build info.

## Acceptance Criteria

A user can report a useful Android bug without giving sensitive data.

---

# 14. Phase 9 — Media / FFmpeg Support

## Objective

Restore Android media functionality after core hosting is stable.

## Initial Policy

Until Android-compatible FFmpeg is shipped:

- disable only features that require FFmpeg
- do not fail Levix startup
- clearly explain unavailable media operations

## Tasks

- [ ] Identify every Levix feature requiring `ffmpeg-static`.
- [ ] Create media capability detection.
- [ ] Avoid importing/executing incompatible FFmpeg binaries on Android.
- [ ] Find/build Android ARM64 compatible FFmpeg.
- [ ] Review FFmpeg build/license implications.
- [ ] Package it correctly in APK/native libs.
- [ ] Add runtime path resolution.
- [ ] Test:
  - TTS conversion
  - voice-note conversion
  - video thumbnails
  - media metadata
- [ ] Verify temp-file cleanup.

## Acceptance Criteria

Android media behavior matches normal Levix behavior where technically supported.

---

# 15. Phase 10 — Security Review

## Objective

Treat Android as a new deployment environment, not merely another package.

## Review Areas

### Local Panel

- [ ] bind localhost only
- [ ] WebView origin restrictions
- [ ] no remote panel exposure by default
- [ ] no insecure JS bridge

### Secrets

- [ ] private app storage only
- [ ] no secrets in Android logs
- [ ] no auth/session files in exported backups by accident
- [ ] no clipboard leakage

### Intents / Components

- [ ] mark components exported only when required
- [ ] protect sensitive Activities/Services
- [ ] validate external intents

### Native Boundary

- [ ] validate paths passed to Node
- [ ] prevent arbitrary script execution
- [ ] prevent arbitrary runtime arguments from external apps

### Updates

- [ ] signed APK
- [ ] release hashes
- [ ] no silent unsigned updates

## Acceptance Criteria

A security-focused review finds no obvious way for another Android app or remote client to control Levix or read its secrets.

---

# 16. Phase 11 — Performance & Battery

## Objective

Make the app reasonable for old Android phones.

## Measurements

Record:

- idle RAM
- connected RAM
- CPU idle
- CPU during command
- battery usage over 8h/24h
- network usage
- DB growth
- logs growth

## Tasks

- [ ] avoid unnecessary wake locks
- [ ] avoid busy loops
- [ ] tune reconnect timers
- [ ] rotate/limit logs
- [ ] ensure scheduler does not poll aggressively
- [ ] avoid keeping WebView active when UI is closed
- [ ] unload Activity resources while Foreground Service continues

## Acceptance Criteria

Levix can run on a modest ARM64 Android phone without excessive heat, battery drain, or memory pressure.

---

# 17. Phase 12 — Android Build Automation

## Objective

Produce repeatable APK builds in CI.

## Tasks

- [ ] Add Android GitHub Actions workflow.
- [ ] Cache Android/Gradle dependencies.
- [ ] Cache/build Node Android runtime safely.
- [ ] Build ARM64 APK.
- [ ] Run Android-specific tests where possible.
- [ ] Generate checksums.
- [ ] Sign release APK.
- [ ] Store signing secrets in GitHub environment/secrets.
- [ ] Do not expose signing key in logs or artifacts.

## Release Artifact

Example:

```text
levix-android-arm64.apk
```

Existing release assets remain unchanged.

## Acceptance Criteria

A tagged release can automatically produce a signed Android APK.

---

# 18. Phase 13 — Beta Release

## Objective

Ship the first public Android build through GitHub Releases.

## Beta Requirements

Must have:

- Levix starts reliably
- WhatsApp pairing works
- session persistence works
- Web Panel works
- 24h test passes
- reboot recovery works
- network reconnect works
- no known data-loss bug
- no secret leakage
- clear battery instructions
- clear warning that WhatsApp automation uses an unofficial client

## Documentation

Add:

```text
ANDROID.md
```

Include:

- supported Android versions
- ARM64 requirement
- installation
- battery settings
- pairing
- background behavior
- update process
- backup location/process
- troubleshooting
- limitations

## Acceptance Criteria

A non-developer can install the APK and get Levix connected without Termux or ADB.

---

# 19. Phase 14 — Post-Beta Hardening

After real users test it:

- [ ] Samsung background behavior
- [ ] Xiaomi/HyperOS behavior
- [ ] Oppo/Realme behavior
- [ ] Pixel/AOSP behavior
- [ ] Android 10/11/12/13/14/15+
- [ ] crash reports from user-provided diagnostics
- [ ] memory leaks
- [ ] reconnect issues
- [ ] long-term schedule accuracy
- [ ] app update without losing data

Do not promise perfect support for OEMs that intentionally kill background applications.

---

# 20. Future Phase — Native Android UX

Only after the host is stable.

Potential later work:

- native connection screen
- native pairing screen
- native notification controls
- native status dashboard
- command shortcuts
- Android widgets
- notification for failed schedules
- native backup/restore flow
- automatic update checker

The Web Panel remains the source of truth until replacing parts of it provides clear value.

---

# 21. Testing Matrix

## Core

- [ ] DB create
- [ ] DB migration
- [ ] DB persistence
- [ ] command load
- [ ] `!ping`
- [ ] AI request
- [ ] schedule
- [ ] moderation
- [ ] memory

## WhatsApp

- [ ] first pair
- [ ] reconnect
- [ ] restart
- [ ] logout
- [ ] re-pair
- [ ] network loss
- [ ] network recovery
- [ ] Wi‑Fi/mobile transition

## Android

- [ ] screen lock
- [ ] Recents swipe
- [ ] battery saver
- [ ] reboot
- [ ] process death
- [ ] low-memory condition
- [ ] update APK
- [ ] permissions denied
- [ ] notifications denied

## Persistence

- [ ] app restart
- [ ] device restart
- [ ] APK update
- [ ] Android process kill
- [ ] Levix core crash

---

# 22. Recommended PR / Milestone Order

Keep changes small and reviewable.

## PR 1
Android project skeleton + Foreground Service.

## PR 2
Embedded Node 24 prints heartbeat.

## PR 3
Android platform adapter + SQLite + Levix core boot.

## PR 4
Baileys connection + `!ping`.

## PR 5
Pairing code flow.

## PR 6
WebView + current Levix panel.

## PR 7
Boot receiver + battery/restart reliability.

## PR 8
24h soak-test fixes + diagnostics.

## PR 9
Android FFmpeg/media support.

## PR 10
CI signing + GitHub Release APK.

Do not merge one giant Android PR.

---

# 23. Definition of MVP

Android MVP is complete when:

```text
Install APK
↓
Open app
↓
Start Levix
↓
Pair WhatsApp
↓
Send !ping successfully
↓
Close UI / lock phone
↓
Levix keeps working
↓
Restart phone
↓
Levix resumes automatically if enabled
↓
Open Web Panel from APK
↓
Settings and schedules persist
```

Minimum reliability:

- successful 24h continuous test
- successful reboot recovery
- successful network reconnect
- no database/session corruption

---

# 24. Definition of Beta

Beta requires everything in MVP plus:

- signed release APK
- Android documentation
- diagnostics/exportable logs
- battery onboarding
- 72h soak test on at least one device
- testing on at least 3 Android OEM/device families if possible
- known limitations documented
- upgrade path verified

---

# 25. Major Risks

## Risk 1 — Node Android Runtime

The biggest technical risk.

Mitigation:

- solve this before UI/media work
- ARM64 only
- use existing Android/Termux Node build knowledge as reference
- maintain reproducible build scripts

## Risk 2 — Android Background Killing

Mitigation:

- foreground service
- correct service type
- persistent notification
- restart/backoff
- battery onboarding
- boot receiver
- OEM guidance

Do not attempt unsupported hacks.

## Risk 3 — FFmpeg

Mitigation:

- media optional initially
- capability detection
- Android-native FFmpeg later

## Risk 4 — Baileys / WhatsApp Compatibility

Mitigation:

- preserve exact tested Baileys version
- regression tests
- reconnect testing
- clear unofficial-client warning

## Risk 5 — APK Size

Embedded Node + Levix + optional FFmpeg may be large.

Mitigation:

- ARM64 only
- exclude unnecessary build files
- consider optional media package later if size becomes excessive

---

# 26. Decisions Already Made

Unless new evidence proves otherwise:

1. Android phone hosts the **actual Levix core**.
2. No Termux requirement for users.
3. Kotlin native shell.
4. Embedded Node.js 24.
5. ARM64 first.
6. Android 10+ first target.
7. Existing Web Panel reused through WebView.
8. Foreground Service keeps Levix alive.
9. Local panel bound to localhost.
10. Pairing code preferred over same-device QR.
11. FFmpeg/media postponed until core stability.
12. Same GitHub repository; Android work lives under `android/`.
13. GitHub Releases first; Play Store is a later goal, not a never goal.
14. Existing desktop/server Levix behavior must not regress.

---

# 27. Instructions for AI / Coding Agents Working on This Project

Use the following as project-level operating instructions.

## Role

You are working on **Levix Android Host**, an Android packaging/runtime project for the existing Levix codebase.

Your job is to make the existing Levix Node.js core run reliably on Android ARM64 without forcing users to install Termux, Node, npm, Docker, or a VPS.

## Primary Principle

**Preserve Levix core behavior.**

Do not rewrite existing working systems unless Android compatibility genuinely requires it.

Prefer a small platform abstraction over duplicate implementations.

## Before Editing

Always:

1. inspect the current repository state
2. inspect relevant architecture/docs/tests
3. identify the smallest viable change
4. state what is Android-specific and what is shared
5. avoid assumptions about Android/Node behavior that can be tested

## Scope Discipline

Do not:

- redesign unrelated Levix features
- refactor unrelated code
- change desktop/server behavior unnecessarily
- add Flutter/React Native
- rebuild the entire UI natively
- solve FFmpeg before core hosting works
- weaken security controls for convenience
- introduce Termux as a runtime dependency

## Phase Discipline

Work strictly in the current phase.

Do not jump ahead.

Example:

If working on embedded Node startup, do **not** also implement:

- pairing UI
- FFmpeg
- WebView redesign
- Play Store packaging (far goal)

## Testing Requirement

Every meaningful change must include appropriate automated or reproducible validation.

Never claim Android behavior was tested if it was only inferred from code.

Clearly distinguish:

- TESTED
- REVIEWED
- NOT TESTED

For physical-device-only behavior, provide exact reproduction steps.

## Failure Handling

If a blocker is discovered:

1. reproduce it
2. identify root cause
3. document evidence
4. propose the smallest fix
5. do not hide unsupported behavior behind silent fallbacks

## Security

Never:

- expose WhatsApp auth files
- log API keys
- log pairing secrets
- expose local panel to LAN by default
- create insecure WebView JavaScript bridges
- accept arbitrary external intents without validation
- write secrets to shared Android storage

## Android Reliability

Respect Android lifecycle rules.

Use supported APIs.

Do not attempt to “fight” Android using undocumented process tricks.

Explicit user Stop must be respected.

## Git Workflow

Prefer:

- focused branch
- focused commits
- regression tests
- small PR
- clear PR description

Do not mix Android work with unrelated dependency upgrades or formatting.

## Completion Report

At the end of each task report:

```text
Status:
Files changed:
What works:
What was tested:
What was NOT tested:
Known limitations:
Next recommended task:
```

Never imply physical Android testing occurred unless it actually occurred.

---

# 28. Suggested First Task

Start with **Phase 1 only**.

Task:

> Create a minimal Android ARM64 Kotlin app under `android/` with a Foreground Service that can be started/stopped from MainActivity, shows a persistent notification, survives Activity closure, logs a heartbeat every 30 seconds, and contains no Node or Levix integration yet.

Acceptance criteria:

- APK builds
- app opens
- service starts
- notification appears
- Activity can be closed
- service continues
- service stops cleanly
- no existing Levix test/regression is introduced

Only after this passes should Phase 2 begin.

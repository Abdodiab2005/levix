# Phase 07.5: Android Device QA and E2EE Validation Results

Status: **PHASE 07.5 FIXES MERGED; MERGED-BUILD SMOKE TEST ON THE PHONE PASSED (section J).** The four
PRs are on `release/5.0.0-beta.1` at `65c85ab`; the rows marked BLOCKED below were closed by section J.

PR under test: #137 (`fix/v5-phase-07.5-e2ee` into `release/5.0.0-beta.1`), head
`9fb43db8d2308cdc9140e86ffa8a003ab522aefe`. Date: 2026-11-07 (UTC), from 21:38 to 22:45.

**What was tested:** a locally built, debug-signed, isolated QA package, `net.leviro.levix.dev`
("Levix QA"). It is **not** the Google Play build. The Play package `net.leviro.levix` (4.8.0) on the
same phone was not updated, opened or read, and no result here applies to it.

Summary by table row in section C, after the final smoke test: 33 PASS, 2 FAIL on the original
build (A-06 and A-12, both pre-existing, fixed in PRs #138 to #140 and passing in section J), 1 NOT RUN
(E7: no failure occurred), 0 BLOCKED.

Result labels: **PASS (device)** was observed on the Android phone by Claude through ADB, logs and
the panel; **PASS (recipient)** was confirmed by the owner on the recipient phones; **PASS (offline)**
is an automated test on Linux; **FAIL**, **BLOCKED** and **NOT RUN** mean what they say.

## A. Environment

| Item | Value |
| --- | --- |
| Phone | Xiaomi Redmi 9 (`lancelot`), LineageOS 21.0 UNOFFICIAL 2024-02-10, userdebug, Android 14 (SDK 34), security patch 2024-01-05 |
| ABIs | arm64-v8a, armeabi-v7a, armeabi |
| WebView | com.android.webview 120.0.6099.230 |
| ADB serial | `fcc3…0404` (one device attached, used explicitly in every command) |
| Free storage | 25 GB of 48 GB |
| Package tested | `net.leviro.levix.dev` ("Levix QA", the isolated debug build in `android/README.md`) |
| Package not touched | `net.leviro.levix` 4.8.0, versionCode 66, installed from Google Play, Play-signed. Its `lastUpdateTime` stayed 2026-10-26. A local build cannot update it without the Play signing key, so it was out of scope by design. |
| Levix | 5.0.0-beta.1, versionCode 71 |
| Node on the phone | v24.22.1 (pinned Termux runtime), OpenSSL 3.6.5, sqlite ok, CA list 252 |
| Baileys | `@whiskeysockets/baileys` 7.0.0-rc14 (read from the APK's `levix-app.zip`) |
| Build host | Linux 7.0.0-42, official Node 24.22.2 for every gate, JDK 17.0.21, Gradle 8.11.1 `--offline`, `npm_config_offline=true` |
| APK | `levix-android-arm64.apk`, 65,057,734 bytes, SHA-256 `47d321f7c51c257343160717889915e8931eeacdb1509dc5f9335606a2bc01aa`, built locally from `9fb43db` (not a CI artifact) |
| Signing | Debug certificate SHA-256 `4c97624691b3c8ed492ee1377f05ce305a670b78d9165f94a79e0a9610353476`, identical to the installed `.dev` package |
| WhatsApp account | A dedicated test number (`+20 ••• ••• ••21`), paired by the owner during this run |

## B. Installation

1. Build: `LEVIX_ANDROID_ABIS=arm64-v8a ./gradlew --offline :app:testDebugUnitTest :app:assembleDebug -PlevixIsolatedDebug=true`
   in `~/Documents/levix-wt/p075-int/android`. BUILD SUCCESSFUL in 1 m 20 s. Android unit tests: 110,
   0 failures. The Node runtime stamps matched the PR's scripts, so nothing was fetched.
2. APK checks: `aapt2` reports `net.leviro.levix.dev`, versionCode 71, versionName 5.0.0-beta.1,
   native code arm64-v8a only, 11 native libraries including `libnode.so`. `levix-build.json` in the
   app archive says versionCode 71. Six files changed by the PR (`groupMetadataCache.cjs`,
   `baileys.config.js`, `socket.js`, `use-database-auth-state.js`, `group.handler.js`, `session.js`)
   are byte-identical to `9fb43db`.
3. Install: `adb -s <serial> install -r` (update in place, no downgrade or test flag) over
   `net.leviro.levix.dev` 4.9.2 (versionCode 69). `firstInstallTime` stayed 2026-11-04 22:30:13 local.
4. Data kept: fingerprints of the panel password hash, the session secret and `ai-persona.md` were the
   same before install, after install and after the first start. The database moved from schema 10 to
   11 after Levix wrote `backups/pre-migration/levix-v10-20261107T214815Z.db` (278,528 bytes).
5. The QA package had no WhatsApp pairing before this run (0 `baileys_auth` rows), so session
   preservation across the install could not be tested; it was tested across a restart (E5).
6. The QA panel password from Phase 04 was not known. On the owner's instruction it was cleared with
   `levix reset-password` inside the QA package and set again through the local `/setup` page.

## C. Test matrix

### Android smoke tests

| ID | Test | Result | Evidence |
| --- | --- | --- | --- |
| A-01 | App launch | PASS (device) | Cold start 2.3 s, no crash |
| A-02 | Dashboard and gateway | PASS (device) | Gateway login page loads; after sign-in 11 dashboard API endpoints answer 200 |
| A-03 | Existing settings kept | PASS (device) | Fingerprints identical before and after (section B.4) |
| A-04 | Existing WhatsApp session kept across install | PASS (device), section J | Not possible on 2026-11-07 (no pairing before install); passed on the merged build |
| A-05 | Node runtime startup | PASS (device) | Bundle unpacked in 13 s, `Database ready`, 69 commands, panel on the unix socket |
| A-06 | Connection status | FAIL (device), pre-existing | Home screen and API correct. The panel's Connection screen stayed on "waiting for QR" after pairing until a reload: QA-D1 |
| A-07 | Reconnect keeps credentials | PASS (device) | 515 restart during pairing, network drop (F-02) and engine restart (E5) all reconnected without a new pairing |
| A-08 | Stop and start | PASS (device) | Stop: Node exited with code 0 in 0.7 s. Start: connected 8 s later from saved credentials |
| A-09 | Android permissions | PASS (device) | Same grants as before install (notifications granted, media denied); battery optimization still "Restricted" for the QA package |
| A-10 | Background and foreground | PASS (device) | 45 s in background: same process, foreground service active, session not reconnected |
| A-11 | UI navigation | PASS (device) | 9 screens (overview, connection, commands, AI, groups, schedules, stickers, settings, diagnostics) render, no error boundary |
| A-12 | Diagnostics and redaction | FAIL (device), pre-existing | Logs work; `error.log` empty; JIDs and numbers redacted. Usernames and a display name survive in the debug log (QA-D2); Signal session keys reached the host log (QA-D3) |

### Phase 07.5 functional tests

| ID | Test | Result | Evidence |
| --- | --- | --- | --- |
| D1 | Roster freshness after membership changes | PASS (device) | Group "Testing" was cached at creation with 1 participant; 2 members were added at 22:02:35 and 22:02:42; the first bot send at 22:03:12 used a roster of 3 and sent the sender key to 9 devices. Every one of 24 group sends used the current roster of 3 |
| D1 | Roster code paths, coalescing, generation guard | PASS (offline) | `group-roster-sync` in the full suite |
| D2 | Retry cache and `getMessage` | PASS (offline) | `retry-message-cache` in the full suite |
| D2 | Retry behavior on the phone | PASS (device), indirect | 0 `recv retry request` records from recipients across 25 bot sends at trace level: every recipient decrypted on first delivery, so no retry was needed. A forced retry was not attempted (it would need key manipulation) |
| D3 | Key store | PASS (device) | 822 auth rows after pairing; no `Failed to write data`, no `AUTH_STORE_FENCED`; restart and network drop resumed without a new pairing |
| D3 | Key store failure semantics | PASS (offline) | `auth-keystore-contract` in the full suite (disposable databases only) |
| D4 | Welcome with rc14 participant objects | PASS (device), PASS (recipient) | Welcome enabled on "Testing" only; re-add at 22:20:54, welcome sent at 22:20:55 with the mention; the owner saw it on every phone. Welcome was off before the test and was set back afterwards |

### Live WhatsApp tests (owner-controlled groups "Dhdn" and "Testing")

Recipients: the test number (hosting account, admin), one other admin and two ordinary members, each
on a separate phone (owner's confirmation).

| ID | Test | Result | Evidence |
| --- | --- | --- | --- |
| E1 | `!ping`, `!help` | PASS (recipient) | Handled at 22:00:31, 22:03:25, 22:21:37, 22:21:51, 22:31:36, 22:31:44; readable on all four phones |
| E2 | Moderation warning | PASS (recipient) | 4 warnings (Dhdn 22:01:09 and 22:01:23, Testing 22:03:12 and 22:20:59), one outcome row per message, `kicked=0`, `notified=1`; readable on all phones |
| E3 | Moderation delete | PASS (recipient) | The offending message disappeared for everyone, its sender included (the reported O-06 symptom did not occur) |
| E4a | Members added after the bot cached the group (the reported cause) | PASS (recipient) | See D1: new group, 2 adds, then bot messages readable on all phones |
| E4b | Remove and re-add without restart | PASS (recipient) | Remove 22:20:12, add 22:20:54, welcome, `!ping`, `!help`: all readable on all phones, including the re-added member's |
| E5 | Restart regression | PASS (recipient) | Engine stop 22:27:34, start 22:29:30, connected 22:29:38; `!ping` and `!help` readable on all phones |
| E6 | Admin versus ordinary member | PASS (recipient) | Both admins and both ordinary members read every bot message. The owner also reported that a bot on the owner's own number, still on the old build, kept showing the old issue during the same tests while Levix QA did not |
| E7 | Failure diagnostics | NOT RUN | No outbound failure occurred. One inbound decrypt failure (the bot could not decrypt the re-added member's message at 22:21:37, "No session found to decrypt message") was healed by a retry receipt; the next message was handled at 22:21:51 |

### Reliability

| ID | Test | Result | Evidence |
| --- | --- | --- | --- |
| F-01 | Background, foreground, panel reopen | PASS (device) | Same process, session unchanged |
| F-02 | Network drop | PASS (device), PASS (recipient) | Wi-Fi off 22:38:32 to 22:39:32: paused at once (428, no retry storm); one 20 s handshake timeout (408), then the 5 s retry connected at 22:40:00; `!ping` readable on all phones |
| F-03 | Crashes and errors | PASS (device) | 0 FATAL, ANR, EPIPE, SIGSEGV or unhandled rejection in logcat and Levix logs since install; `error.log` 0 bytes; no disconnect code 500 |
| F-04 | Memory | PASS (device) | App process total PSS 330 MB with the WebView; Node process RSS 81 MB |
| F-05 | Baileys app-state sync | PASS (device), note | Two app-state warnings right after pairing (`failed to find key ... to decode mutation`, a RangeError), attempt 2, no disconnect |

### Blocked on the phone (closed on 2026-11-08)

The phone was disconnected at about 23:05 UTC on 2026-11-07. The merged-build install in section J
closed all four rows and A-04.

| ID | Test | Result | What closes it |
| --- | --- | --- | --- |
| X-01 | PR #138: Connection screen updates live | PASS (device), section J | Panel Reconnect shows each state without a reload; socket.io polling requests appear |
| X-02 | PR #139: names redacted in the debug log | PASS (device), section J | One remove and re-add in "Testing"; the debug log shows `[redacted]` for `username` and `notify` |
| X-03 | PR #140: no Signal keys in any log | PASS (device), section J; live session close not observed | The hook installs in the Android bundle; host log, its mirror and logcat hold no new key dump |
| X-04 | Cleanup and exposure checks (section I) | PASS (device), section J | Helper files removed; `Download/Levix/` and logcat checked |

## D. Actual WhatsApp results

All bot-generated messages in both groups (commands, moderation warnings, deletes, the welcome) were
readable on the four recipient phones: the hosting test number, a second admin and two ordinary
members. Nobody saw "Waiting for this message." The reported failure mode (members added after the
bot cached the group, E4a) and the remove and re-add case (E4b) both passed without a restart. The
phone log agrees: across 25 bot sends no recipient device sent a retry request.

Not covered: Miguel's own TEST group and phones, iPhone recipients (platforms were not recorded), a
member who changes phone or reinstalls WhatsApp (B2, upstream), and a failed per-device encryption
(B1, upstream).

## E. Defects

None of these is caused by PR #137; each exists on `release/5.0.0-beta.1` without it.

| ID | Severity | Defect | Fix |
| --- | --- | --- | --- |
| QA-D1 | P2, functional | Android panel never receives live updates. The dashboard socket.io client (`frontend/src/hooks/useSocket.ts`, since 580a6b5) tries only the WebSocket, which cannot reach the unix-socket panel (`ERR_CONNECTION_REFUSED`, 8 attempts in 35 s, 0 polling requests); engine.io-client 6.6 falls back only with `tryAllTransports`. The Connection screen stays on "waiting for QR" after pairing | PR #138 |
| QA-D2 | P2, privacy | The sanitized debug log keeps `update.participants[].username` (Levix), `key.participantUsername`, `recv.attrs.participant_username` and `recv.attrs.notify` (a display name) from Baileys. The log can be attached to feedback and crash reports | PR #139 |
| QA-D3 | P1, security | libsignal prints whole `SessionEntry` objects (ratchet `privKey`, `rootKey`) with `console.info` when a session closes; Node ignores libsignal's legacy `inspect()` since v11. On Android the Node stdout goes to `files/host.log`, its external mirror `Android/data/<package>/files/logs/host.log`, the panel Logs tab and the host-log share; on desktop to the terminal, journald and docker logs. Seen once at 22:21:52 ("Closing open session in favor of incoming prekey bundle"). Both QA host-log copies were cleared on the owner's instruction; 2 lines remain in the logcat ring buffer (ADB access only) | PR #140 |
| OBS-1 | P3, reliability | After an app update the engine stays stopped until someone taps Start, although `wanted_running=true`: `BootReceiver` handles only `BOOT_COMPLETED` and `QUICKBOOT_POWERON` | Not fixed |
| OBS-2 | P3, diagnostics | The debug log reduces every Baileys message text to `[N chars]`, so the E-1 field plan cannot search for lines such as "sending new sender key". Structured fields survive (`participants`, `senderKeyJids`, `msgId`) and were enough here | Not fixed |
| OBS-3 | P3 | The first reconnect after the network returns starts before the link is usable and times out after 20 s; the 5 s retry then connects | Not fixed |

Fix verification on the phone: BLOCKED. The phone was disconnected at about 23:05 UTC, before a
combined local build (PR #137 `9fb43db` plus #138, #139 and #140, APK SHA-256
`8980d68a6cd1ba25b542fc95d9413bc5afbf0b91062f695ac4cbb284505dd84f`, built offline, not installed)
could show the live Connection screen, the redacted debug log and the libsignal hook on the device.
The same install would also close A-04 (a paired session kept across an update). The fixes are covered
by offline tests and CI (see each PR).

Left on the phone for cleanup at the next connection: query and helper scripts in `/data/local/tmp`
(`q1.sql` to `q8.sql`, `fp.sh`, `verify.sh`, `reset.sh`, `logscan.sh`, `hostscan.sh`, `ui.xml`). None
holds a password, key or message; the one file that held the QA password (`cand`) was deleted right
after use.

## F. Regression results

| Check | Result | Command / platform | Commit | Date |
| --- | --- | --- | --- | --- |
| Full Levix suite | PASS, 10546 checks, 0 failed, 185.9 s | `node tests/run.mjs`, Linux, Node 24.22.2, offline (`unshare -rn`) | `9fb43db` | 2026-11-07 |
| GitHub CI | PASS, 7 of 7 (tests, package install, executables on Ubuntu, macOS and Windows, container volume, Android APK build) | run 42406515936 | `9fb43db` | 2026-11-07 |
| Android unit tests | PASS, 110, 0 failed | `./gradlew :app:testDebugUnitTest`, offline | `9fb43db` | 2026-11-07 |
| PR #138 full suite and CI | PASS, 10201 checks; CI 7 of 7 | `node tests/run.mjs`, offline | `815e151` | 2026-11-07 |
| PR #139 full suite and CI | PASS, 10216 checks; CI 7 of 7 | `node tests/run.mjs`, offline | `f63f365` | 2026-11-07 |
| PR #140 full suite and SEA | PASS, 10211 checks; SEA 51 checks; one shared `require_libsignal` in the bundle | `node tests/run.mjs`, `build-sea.mjs`, `validate-sea.mjs`, offline | `8a22a15` | 2026-11-08 |
| Combined tree (#137 + #138 + #139 + #140, local `1e23da2`) | PASS, 10607 checks, 0 failed | `node tests/run.mjs`, offline (`unshare -rn`) | `1e23da2` | 2026-11-08 |

## G. Release recommendation

**READY FOR OWNER REVIEW.** The PR #137 build ran on a physical Android phone without a crash, kept
the existing data, and every bot message reached four independent recipient phones, including the
reported scenario of members added after the bot cached the group. The three defects found are
pre-existing and have their own PRs; QA-D3 should ship in the same beta as PR #137.

## H. Next actions

1. Owner merge decision. Proposed order into `release/5.0.0-beta.1`: #140 (security), #137, #139,
   #138. The four apply cleanly together: a local tree of `9fb43db` plus the three fixes (`1e23da2`) builds
   and passes the full suite (10607 checks, 0 failed). `ci.yml` runs on pull requests and on pushes to `main` only, so CI on the
   merged release branch needs a pull request from it (for example to `main`).
2. At the next phone connection: install the combined build, run the four BLOCKED rows and A-04, and
   finish the exposure checks in section I.
3. Optional field confirmation in Miguel's TEST group with a beta built after the merges.
4. Decide on the upstream Baileys fixes B1 to B4 (still local only), and on reporting the SessionEntry
   logging to libsignal-node.

Evidence (sanitized: timelines, screenshots, summaries; no raw logs or keys) is in
`~/Documents/levix-backups/phase-07.5-e2ee/device-qa/`.

## I. Security review of the logged Signal key material (QA-D3)

No session, key or pairing was reset or rotated; that is the owner's decision.

What was written: one libsignal `SessionEntry` dump at 22:21:52 UTC, printed as libsignal closed the
open session with one contact device "in favor of incoming prekey bundle". Six buffer fields were
printed: the ratchet `privKey` and `pubKey`, `rootKey`, `baseKey`, `lastRemoteEphemeralKey` and
`remoteIdentityKey`. Chain and message keys sit deeper than Node's default inspect depth and were not
printed. No identity private key, prekey, noise key or pairing credential was printed. Values were
never displayed or copied off the phone during this review; only key names and line counts were read.

Impact: with that session's root key and ratchet private key, a holder of the log who also captured
the encrypted traffic could derive message keys for that one closed session with that one contact
device. The account's identity key and every other session are unaffected, and the values do not
allow taking over the account.

| Copy or exit path | Finding | Status |
| --- | --- | --- |
| `files/host.log` (app-private) | 6 key lines | Cleared by the app's own clear function; 0 lines after |
| External mirror `Android/data/net.leviro.levix.dev/files/logs/host.log` | 6 key lines; on Android 14 other apps cannot read it, ADB and the owner can | Cleared; 0 lines after |
| Logcat ring buffer (tag `LevixHost`) | 2 lines | Left in place; ADB-only on Android 14; drops out as the buffer rotates |
| Panel Logs tab | Shows the last 500 host-log lines in memory only | Nothing stored |
| Host-log share sheet and "Save to Downloads" (`Download/Levix/`) | Operator-started only; Claude did not use them; owner use unknown | BLOCKED: check `Download/Levix/` and any share at reconnect |
| Feedback and crash report uploads | Attach the Pino debug log only, never `host.log`. The device debug log pulled at 22:31 held no key dump | Not an exit path |
| Android cloud backup and device transfer | `allowBackup="false"`; backup and data-extraction rules exclude every domain | Not an exit path |
| Claude's workstation (scratchpad, task outputs, agent relay folders, this evidence folder) | No device key material. Three Baileys jest logs in `remediation/evidence/baileys/` hold dumps of synthetic test keys from the offline Baileys suite, not device keys | Clean of device keys |

Not guaranteed: truncating a file does not erase the flash blocks that held it, and any copy made
before the clear (a share, a saved file, an ADB pull outside this session) is outside this review. The
Play package's external host-log mirror showed 0 key lines; its private log was not read.

Owner options, none applied: (a) treat the closed session as exposed and accept the narrow impact
above; (b) unlink and re-pair the QA test number, which replaces every session and key for that
account; (c) clear logcat (`adb logcat -c`, device-wide) at the next connection.

## J. Final smoke test on the merged build (2026-11-08)

Build: `65c85ab0b7a7c374e2469822e38bf4b236d045a9` (`release/5.0.0-beta.1` after #140, #137, #139 and #138),
built offline with `-PlevixIsolatedDebug=true`, arm64. APK SHA-256
`52747086c6597981fafcca85e9cd9450e00037a5694ec16e021d334909cbb1d6` (65,058,654 bytes),
`net.leviro.levix.dev`, versionCode 71, the same debug certificate (`4c976246…353476`). Android unit
tests 110, 0 failed. `levix-app.zip` holds the merged `signalSessionInspect.cjs`, `debugLog.cjs`,
`index.js` and `groupMetadataCache.cjs` byte for byte, and the dashboard bundle contains
`tryAllTransports`. Same phone, Wi-Fi on. Again **not** the Google Play build.

| ID | Check | Result | Evidence |
| --- | --- | --- | --- |
| J-01 | Exposure before install | PASS (device) | `Download/Levix/` holds one settings export from 2026-10-10 (424 bytes) and no saved host log. Logcat 0 key lines (the 2 old lines rotated out). Host log and its mirror 0 key lines |
| J-02 | Update in place | PASS (device) | `install -r`; `firstInstallTime` unchanged; schema 11, 852 auth rows and the password, session-secret and persona fingerprints identical before and after |
| J-03 | A-04: paired session kept across the update | PASS (device) | Before the update the old build sat in `retry_exhausted` since 11:04 (408 handshake timeouts while the phone was away). After Start: bundle unpacked, `connected` at 12:34:22 from saved credentials, no re-pair |
| J-04 | #140 hook in the Android bundle | PASS (device) | The app's own Node and the unpacked bundle: `installSignalSessionInspect()` returned true; real libsignal `closeSession`/`openSession` with random keys printed the placeholder, no `<Buffer`, neither key as hex |
| J-05 | #140 live logs | PASS (device), partial | After the live events: host log, its mirror and logcat 0 key or `<Buffer` lines. No libsignal session open or close was printed in this run, so the live close path was not exercised; J-04 covers it |
| J-06 | #139 names in the debug log | PASS (device) | Remove and re-add in "Testing" by the owner: both participant records carry only `group`, `action`, `count`. Records after the update: 3 name fields, all `[redacted]`, 0 raw; 0 raw JIDs; 0 key material. The 10-digit numbers left are WhatsApp's `appVersion.tertiary`, not phone numbers |
| J-07 | #138 transport | PASS (device) | Page reload with tracing: 1 refused WebSocket attempt, then polling (3 requests in 25 s). Before the fix: 8 refused attempts, 0 polling |
| J-08 | #138 live Connection screen and Reconnect | PASS (device) | Panel Reconnect in the same document (no reload): connected, then "saved session, resuming / connecting", then connected again within 2.8 s |
| J-09 | Recipients after the update | PASS (recipient) | `!ping` after the re-add and the member's message: readable on every phone (owner) |
| J-10 | Cleanup | PASS (device) | The 15 QA helper files from this QA run removed from `/data/local/tmp`; 2 older files from 2026-09-10 (`listen-probe*.mjs`) were not created by this QA and were left |

Not re-run: the QR to connected transition itself. It needs a new pairing, which means unlinking the
test account; J-08 shows the same push path delivering every state change.

Still on the phone, outside QA temp files: the debug logs written by the previous build keep raw
WhatsApp names (3 fields on 2026-11-08 before 12:31 UTC, more in `debug-2026-11-07.log`). They expire
after 14 days; Settings, Logs, Clear removes them now. That is the owner's call; nothing was deleted.

Phase 07.5 is closed for the Levix fixes. The upstream Baileys fixes B1 to B4 stay on their own track.
Draft PR #141 (release into main) exists for CI only and is not to be merged.

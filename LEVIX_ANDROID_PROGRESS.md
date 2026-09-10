# Levix Android host — progress

Last updated: 2026-09-10

Pick this up next: **Phase 3 — boot the Levix core on the embedded Node runtime.**

Full plan: [`LEVIX_ANDROID_HOST_PLAN.md`](LEVIX_ANDROID_HOST_PLAN.md)

---

## Where we are

| Item | Status |
| --- | --- |
| Phase 0 — `android/` skeleton | Done |
| Phase 1 — foreground host shell | Done |
| Phase 2 — embedded Node.js 24 ARM64 | Done |
| Phase 3 — boot Levix core | **Next** |
| Version | `3.0.0-alpha` |
| PR | [#34](https://github.com/Abdodiab2005/levix/pull/34) merged |
| Tag / GitHub prerelease | [v3.0.0-alpha](https://github.com/Abdodiab2005/levix/releases/tag/v3.0.0-alpha) |
| npm | `levix-bot@3.0.0-alpha` on dist-tag `alpha` (not `latest`) |

Release line: **alpha → beta → rc → 3.0.0**.

---

## Device proof (Redmi 9, Lineage, ARM64)

APK `net.leviro.levix` `3.0.0-alpha`:

- Start keeps a foreground notification with the screen locked and Recents swipe.
- Embedded Node reports `v24.18.0` / `android` / `arm64`.
- 30s heartbeat from `heartbeat.js`.
- Stop kills Node without killing the app process.
- Start again works without rebooting the phone.

---

## What is in the repo

```text
android/                         Kotlin host (ARM64, min SDK 29, target 35)
android/app/.../LevixHostService.kt
android/app/.../NodeRuntime.kt   exec libnode.so from nativeLibraryDir
android/app/src/main/assets/heartbeat.js
android/scripts/fetch-node-android.sh
android/README.md
```

Node is **not** committed. Fetch once per machine:

```bash
android/scripts/fetch-node-android.sh
cd android && ./gradlew :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Runtime cache: `~/.cache/levix-android/` (JDK 17, SDK 35, patched Node 24 libs).

The Node binary is a Bionic ARM64 build taken from Termux aarch64 debs, then `patchelf`'d to `$ORIGIN`. **Termux is not used on the phone.** Versioned libs (`libcrypto.so.3`, ICU, …) are zip-injected into the APK because AGP only packages `*.so`.

Android 10 W^X: the executable lives as `libnode.so` under `nativeLibraryDir`. JS is copied into `filesDir` (data, not executed).

Env passed into Node today:

- `LEVIX_ANDROID=1`
- `LEVIX_DATA_DIR` = app `filesDir`
- `HOME` / `TMPDIR`

---

## Explicitly not done

- Levix core boot (`bin/levix.js` / `src/`)
- `node:sqlite` on this Android Node
- WhatsApp / Baileys
- WebView panel
- Boot receiver / OEM battery work
- FFmpeg
- CI APK job

---

## Tomorrow — Phase 3

Goal from the plan: Levix boots on the phone and reports ready, with data in private app storage.

1. Replace `heartbeat.js` with a real Levix entry (or a thin Android bootstrap that loads the same core).
2. Force data dir to `filesDir` (`LEVIX_DATA_DIR` is already set).
3. Skip desktop-only paths: browser auto-open, `levix domain`, systemd installer.
4. Confirm `node:sqlite` works; DB + migrations survive an app restart.
5. Load commands, start scheduler, bind the panel on localhost.
6. Shutdown must stop Node cleanly (already true for the heartbeat process).

Acceptance:

```text
Levix ready
Database ready
Commands loaded
Panel listening
```

Restarting the app keeps the database.

---

## Rebuild notes

- Package: `net.leviro.levix`
- ABI: `arm64-v8a` only
- `extractNativeLibs` / `useLegacyPackaging = true` so `libnode.so` is a real file we can exec
- Do not log WhatsApp auth, API keys, or the panel password
- `android/` stays out of the npm tarball

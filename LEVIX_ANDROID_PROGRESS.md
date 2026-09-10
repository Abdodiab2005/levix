# Levix Android host — progress

Last updated: 2026-09-10 (WhatsApp linked on Redmi 9 via pairing code)

Pick this up next: confirm `!ping` with the screen locked, then restart the host and check the session comes back. After that: boot receiver / battery, FFmpeg, CI APK.

Full plan: [`LEVIX_ANDROID_HOST_PLAN.md`](LEVIX_ANDROID_HOST_PLAN.md)

---

## Where we are

| Item | Status |
| --- | --- |
| Phase 0 — `android/` skeleton | Done |
| Phase 1 — foreground host shell | Done |
| Phase 2 — embedded Node.js 24 ARM64 | Done |
| Phase 3 — boot Levix core | **Done** (Redmi 9) |
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

## Phase 3 (this session)

- `android/host-boot.mjs` probes `node:sqlite`, then starts `levix --no-open`.
- JS + production `node_modules` (no ffmpeg-static) packed as `assets/levix-app.zip`.
- Unpacked to `filesDir/app`; data in `filesDir/data`.
- `LEVIX_ANDROID=1` → in-process pino logs, panel bind `127.0.0.1`.
- Debug APK: `android/app/build/outputs/apk/debug/app-debug.apk` (~84 MB).

Verified on Redmi 9 (Lineage, ARM64):

- Unpack once (~10s), then `v24.18.0` `android` `arm64`
- `sqlite ok` → `Database ready` → `Commands loaded 55` → `Panel listening http://localhost:3001/setup` → `Levix ready`
- `files/data/levix.db` (+ WAL, logs, media, lock)
- Stop kills Node, database remains; Start again skips unpack and reaches `Levix ready` again

ffmpeg-static is omitted on purpose (`!tts` falls back). Open Panel is still disabled (WebView is later).

## Explicitly not done

- WhatsApp / Baileys (Phase 4)
- WebView panel (Phase 6)
- Boot receiver / OEM battery work
- FFmpeg
- CI APK job
- Phase 4 WhatsApp pairing from the phone

---

## Rebuild notes

- Package: `net.leviro.levix`
- ABI: `arm64-v8a` only
- `extractNativeLibs` / `useLegacyPackaging = true` so `libnode.so` is a real file we can exec
- Do not log WhatsApp auth, API keys, or the panel password
- `android/` stays out of the npm tarball

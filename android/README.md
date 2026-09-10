# Levix Android host

The Android shell that will host Levix on a phone.

Phase 2 embeds **Node.js 24 ARM64** (Bionic) and runs a heartbeat script
from the foreground service. Levix core and WhatsApp are not in this
build yet.

## Requirements

- JDK 17
- Android SDK 35 (compile / target)
- `curl`, `python3`, `dpkg-deb`
- An **ARM64** device or emulator (Android 10 / API 29+)
- Android Studio, or `ANDROID_HOME` pointing at the SDK

x86, x86_64, and 32-bit ARM are not built.

## Fetch the Node runtime

The Node 24 binary is not committed. Fetch it once (about 100 MB in
`~/.cache/levix-android/node-runtime/`):

```bash
android/scripts/fetch-node-android.sh
```

That script downloads Termux aarch64 debs, extracts the ELF files, and
rewrites `RPATH` to `$ORIGIN`. Termux is **not** used on the phone.

## Build

```bash
cd android
./gradlew :app:assembleDebug
```

APK:

```text
app/build/outputs/apk/debug/app-debug.apk
```

Install:

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

## What this build does

1. Open the app.
2. Allow notifications when asked.
3. Press **Start**. A persistent notification appears.
4. The UI should show `Node: v24.x.x android/arm64` (or `linux/arm64`).
5. Close the UI, swipe the app from Recents, lock the phone.
6. Heartbeat should keep advancing.
7. **Stop** from the notification or the app. Start again without rebooting.

**Open Panel** is visible and disabled.

Host events are written to Android logcat (`LevixHost`) and to
`filesDir/host.log` inside private app storage. That file must never
contain WhatsApp auth, API keys, or the panel password.

## Package

`net.leviro.levix`

Node receives `LEVIX_DATA_DIR` pointing at the app's private `filesDir`.
Nothing is written to Downloads or shared storage.

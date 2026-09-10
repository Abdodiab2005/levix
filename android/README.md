# Levix Android host

The Android shell that hosts Levix on a phone.

Phase 3 boots **Levix core** (commands, SQLite, localhost panel) on
embedded Node.js 24 ARM64. WhatsApp linking is still a later phase.

## Requirements

- JDK 17
- Android SDK 35 (compile / target)
- `curl`, `python3`, `dpkg-deb`, `zip`, `rsync`
- `npm ci` already run in the repo (the APK packs `node_modules`)
- An **ARM64** device or emulator (Android 10 / API 29+)
- Android Studio, or `ANDROID_HOME` pointing at the SDK

x86, x86_64, and 32-bit ARM are not built.

## Fetch the Node runtime

The Node 24 binary is not committed. Fetch it once:

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

`preBuild` packs Levix (`src/`, `views/`, `public/`, production
`node_modules` minus ffmpeg-static/esbuild/sharp) into
`app/src/main/assets/levix-app.zip` (gitignored).

APK:

```text
app/build/outputs/apk/debug/app-debug.apk
```

Install:

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

## What this build does

1. Open the app. Allow notifications.
2. Press **Start**. First launch unpacks the JS bundle (a few seconds).
3. The UI should show Node `v24.x android/arm64`, `sqlite ok`,
   `Database ready`, `Commands loaded`, `Panel listening`, `Levix ready`.
4. Data lives in `filesDir/data` (`levix.db`, logs). Code lives in
   `filesDir/app`.
5. Stop kills Node cleanly. Start again must keep the database.

**Open Panel** is still disabled. The panel is on `127.0.0.1` only
until the WebView phase.

Host events: logcat tag `LevixHost`, and `filesDir/host.log`. Never log
WhatsApp auth, API keys, or the panel password.

## Package

`net.leviro.levix`

Node env:

- `LEVIX_ANDROID=1`
- `LEVIX_DATA_DIR` = `filesDir/data`
- `LEVIX_OPEN_BROWSER=0`

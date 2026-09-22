# Levix Android Host

The native Android companion app that runs Levix autonomously on an Android phone.

## Overview

The Android host embeds **Node.js 24 LTS (ARM64 + ARMv7)**, **SQLite**, **Baileys v7**, **native FFmpeg**, and the complete **React + Vite Control Panel**, enabling a 24/7 self-hosted WhatsApp automation server on your mobile device without needing Termux or a cloud server.

Features:
- **Autonomous Node.js Runtime**: Runs the full Levix bot locally inside private app storage.
- **Embedded Web Control Panel**: Accessible via the built-in WebView (`Open Panel`) or local browser at `http://127.0.0.1:3001`.
- **WhatsApp Pairing**: Direct 8-character Pairing Code flow (optimal for mobile single-screen setups) or QR code scan.
- **Embedded FFmpeg**: Native transcoding (ARM64 and ARMv7) for WhatsApp voice notes (`!tts`) and local preview thumbnail generation.
- **Foreground Service**: Ongoing notification displaying real-time WhatsApp status (`Connected`, `Reconnecting`, `Paused`).
- **Offline Pause & Auto-Reconnect**: Pauses retries during airplane mode / no signal and reconnects automatically within 2 seconds when network returns.

## Requirements

- **JDK 17**
- **Android SDK 36** (`compileSdk = 36`, `targetSdk = 36`, `minSdk = 29`)
- `curl`, `python3`, `dpkg-deb`, `zip`, `rsync`
- An **ARM64** or **ARMv7 (32-bit)** device (Android 10+ / API 29+)
- `npm ci` run in the project root and `frontend/`

## Fetch the Node Runtimes

The Node 24 Bionic binaries are not tracked in git. Fetch them once (both ABIs by default):

```bash
android/scripts/fetch-node-android.sh
```

This script retrieves the verified Termux packages (aarch64 + arm) and the per-ABI static FFmpeg, extracts the ELF binaries, configures `$ORIGIN` dynamic linking, and verifies that every 64-bit ELF is 16 KB page aligned (a Google Play requirement for apps targeting API 35+).

## Building the APKs

```bash
cd android
./gradlew :app:assembleDebug
```

The Gradle `stageLevixApp` task will:
1. Automatically compile the React frontend (`frontend/`) into `public/dashboard`.
2. Package server code (`src/`, `views/`, `public/`, and production `node_modules` minus build tooling) into `app/src/main/assets/levix-app.zip`.
3. Assemble one APK per ABI in `app/build/outputs/apk/debug/`:
   - `levix-android-arm64.apk` (arm64-v8a)
   - `levix-android-armv7.apk` (armeabi-v7a)

To install onto a connected device via ADB:
```bash
adb install -r app/build/outputs/apk/debug/levix-android-arm64.apk
```

## Building the Google Play bundle (AAB)

Google Play requires an AAB rather than an APK:

```bash
cd android
./gradlew :app:stageLevixBundle
# -> app/build/outputs/bundle/release/levix-android.aab (both ABIs, signed)
```

Set `LEVIX_KEYSTORE_FILE` / `LEVIX_KEYSTORE_PASSWORD` / `LEVIX_KEY_ALIAS` /
`LEVIX_KEY_PASSWORD` to sign with your Play upload keystore (CI wires the same
variables from repository secrets). Fill the Data safety form from the
repo's `PRIVACY.md` before submitting.

Build a single ABI locally with `LEVIX_ANDROID_ABIS=arm64-v8a ./gradlew ...`.

## Runtime Environment

- Package ID: `net.leviro.levix`
- Environment Variables:
  - `LEVIX_ANDROID=1`
  - `LEVIX_DATA_DIR` = `/data/data/net.leviro.levix/files/data`
  - `LEVIX_OPEN_BROWSER=0`
  - `PORT=3001`
- Host logs: Logcat tag `LevixHost`, and `/data/data/net.leviro.levix/files/host.log`.

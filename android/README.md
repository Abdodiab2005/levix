# Levix Android Host

The native Android companion app that runs Levix autonomously on an Android phone.

## Overview

The Android host embeds **Node.js 24 LTS (ARM64)**, **SQLite**, **Baileys v7**, **native FFmpeg**, and the complete **React + Vite Control Panel**, enabling a 24/7 self-hosted WhatsApp automation server on your mobile device without needing Termux or a cloud server.

Features:
- **Autonomous Node.js Runtime**: Runs the full Levix bot locally inside private app storage.
- **Embedded Web Control Panel**: Accessible via the built-in WebView (`Open Panel`) or local browser at `http://127.0.0.1:3001`.
- **WhatsApp Pairing**: Direct 8-character Pairing Code flow (optimal for mobile single-screen setups) or QR code scan.
- **Embedded FFmpeg**: Native ARM64 transcoding for WhatsApp voice notes (`!tts`) and local preview thumbnail generation.
- **Foreground Service**: Ongoing notification displaying real-time WhatsApp status (`Connected`, `Reconnecting`, `Paused`).
- **Offline Pause & Auto-Reconnect**: Pauses retries during airplane mode / no signal and reconnects automatically within 2 seconds when network returns.

## Requirements

- **JDK 17**
- **Android SDK 35** (`compileSdk = 35`, `targetSdk = 35`, `minSdk = 29`)
- `curl`, `python3`, `dpkg-deb`, `zip`, `rsync`
- An **ARM64** device (Android 10+ / API 29+)
- `npm ci` run in the project root and `frontend/`

## Fetch the Node Runtime

The Node 24 ARM64 binary is not tracked in git. Fetch it once:

```bash
android/scripts/fetch-node-android.sh
```

This script retrieves the verified aarch64 deb packages, extracts the ELF binaries, and configures `$ORIGIN` dynamic linking.

## Building the APK

```bash
cd android
./gradlew :app:assembleDebug
```

The Gradle `stageLevixApp` task will:
1. Automatically compile the React frontend (`frontend/`) into `public/dashboard`.
2. Package server code (`src/`, `views/`, `public/`, and production `node_modules` minus build tooling) into `app/src/main/assets/levix-app.zip`.
3. Assemble the debug APK at `app/build/outputs/apk/debug/app-debug.apk`.

To install onto a connected device via ADB:
```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

## Runtime Environment

- Package ID: `net.leviro.levix`
- Environment Variables:
  - `LEVIX_ANDROID=1`
  - `LEVIX_DATA_DIR` = `/data/data/net.leviro.levix/files/data`
  - `LEVIX_OPEN_BROWSER=0`
  - `PORT=3001`
- Host logs: Logcat tag `LevixHost`, and `/data/data/net.leviro.levix/files/host.log`.

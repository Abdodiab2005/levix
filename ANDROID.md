# Levix for Android

Run **Levix** directly on your Android phone as an autonomous background companion — **no VPS, no Termux at runtime, no cloud server, and no subscription fees**.

Levix for Android packages the complete Levix stack into a standalone Android APK:
- **Node.js 24 LTS** compiled for Android Bionic (ARM64)
- **SQLite** datastore powered by Node's built-in `node:sqlite`
- **Baileys v7** WhatsApp protocol engine with local LID mapping
- **AI Agent** with multi-provider support (Gemini, OpenAI, Anthropic)
- **All 55+ Commands** & group moderation tools
- **Embedded FFmpeg** for native WhatsApp voice notes (`!tts`) and video/image preview thumbnails
- **Local Web Control Panel** accessible directly from the app's built-in WebView or your mobile browser (`http://127.0.0.1:3001`)

---

## Requirements

| Requirement | Specification |
| --- | --- |
| **Architecture** | **ARM64** (`arm64-v8a` / `aarch64`) only. Almost all Android phones made since 2016 are 64-bit. |
| **Android Version** | **Android 10** or newer (API level 29+). |
| **Free Storage** | ~150 MB (APK size ~35 MB + unpacked app bundle + SQLite database). |
| **WhatsApp Account** | An active WhatsApp account to link with via pairing code or QR. |

---

## Installation

1. Go to the [Levix Releases](https://github.com/Abdodiab2005/levix/releases) page on GitHub.
2. Download the latest **`levix-android-arm64.apk`**.
3. Open the downloaded APK on your device and tap **Install**.
   - If prompted by Android, enable **"Install unknown apps"** for your browser or file manager.
4. Open the **Levix Host** app from your home screen or app drawer.

---

## First-Time Setup & WhatsApp Pairing

### Step 1: Grant Permissions & Start the Host
1. Launch **Levix Host**.
2. Tap **Start Host**.
3. When prompted, grant **Notification** permissions so the host can maintain an ongoing foreground service and keep the bot running while the screen is off.
4. When prompted, tap **Allow** to disable battery optimization for Levix.

The status will change from `Host: Stopped` to `Node: running (PID ...)`, and the ongoing notification will appear in your notification shade.

### Step 2: Set Admin Password
1. Tap **Open Panel** in the app (or open `http://127.0.0.1:3001` in Google Chrome).
2. The initial setup screen will appear (`/setup`). Choose a secure master password for your web control panel and submit.

### Step 3: Link WhatsApp via Pairing Code (Recommended)
Because you are running the bot on a phone, scanning a QR code on the same screen is difficult. Levix provides a direct **Pairing Code** option:
1. In the Web Control Panel, navigate to **Connection**.
2. Select **Pairing Code** (selected by default on Android).
3. Enter your WhatsApp phone number with international country code (e.g. `201012345678` — do **not** include `+`, `-`, or leading `0`).
4. Tap **Request Pairing Code**.
5. An 8-character code will be generated (e.g., `ABCD-1234`).
6. On your phone, open **WhatsApp**:
   - Tap **Settings** (or the three dots menu `⋮`).
   - Tap **Linked Devices**.
   - Tap **Link a Device**.
   - Tap **Link with phone number instead** at the bottom of the screen.
   - Enter the 8-character code displayed in your Levix panel.
7. WhatsApp will complete the handshake. Within a few seconds, the connection status will turn green: **Connected**.

---

## Keeping Levix Running in the Background

Android manufacturers apply aggressive battery-saving algorithms that kill background processes. To keep Levix connected 24/7 with the screen locked:

### Xiaomi / Redmi / POCO (HyperOS / MIUI)
1. Open **Settings** → **Apps** → **Manage apps** → **Levix**.
2. Enable **Autostart** (or **Background autostart**).
3. Tap **Battery saver** → select **No restrictions**.
4. Open the Android **Recents** screen (app switcher), press and hold the **Levix** card, and tap the **Lock icon** to lock it in memory.

### Samsung Galaxy (One UI)
1. Open **Settings** → **Apps** → **Levix**.
2. Tap **Battery** → select **Unrestricted**.
3. Open **Settings** → **Battery** → **Background usage limits** → **Never sleeping apps** → tap `+` and add **Levix**.

### OnePlus / OPPO / Realme (OxygenOS / ColorOS)
1. Open **Settings** → **Apps** → **App management** → **Levix**.
2. Tap **Battery usage** → enable:
   - **Allow foreground activity**
   - **Allow background activity**
   - **Allow auto-launch**

### Google Pixel / Motorola / LineageOS / Stock Android
1. Open **Settings** → **Apps** → **Levix**.
2. Tap **App battery usage** (or **Battery**) → select **Unrestricted**.

---

## Real-Time Notifications & Offline Handling

Levix includes intelligent network and connection lifecycle handling:

- **Ongoing Foreground Notification**:
  The notification drawer displays the live state of both the host service and WhatsApp:
  - `WhatsApp: Connected`
  - `WhatsApp: ⏳ Reconnecting (code: reason)`
  - `WhatsApp: ⏸️ Paused (No Internet)`
- **Offline Alerts (`levix-alerts`)**:
  If your phone loses Wi-Fi and mobile data or WhatsApp disconnects, Levix posts a high-priority alert. When internet returns, the alert automatically dismisses.
- **Smart Pause & Auto-Reconnect**:
  When you enter airplane mode or lose connectivity, Levix immediately pauses retries instead of burning your 5 retry attempts. As soon as connectivity is restored, Levix resets the retry counter and automatically reconnects within 2 seconds.

---

## Media & Native Audio Transcoding (FFmpeg)

Levix bundles a native ARM64 build of **FFmpeg** (`libffmpeg.so`) inside the APK.
- **Voice Notes (`!tts`)**: The Text-to-Speech command automatically transcodes Google TTS MP3 audio into true WhatsApp PTT voice notes (`audio/ogg; codecs=opus`).
- **Media Previews**: Video and picture thumbnails (`jpegThumbnail`) are generated locally on the phone before sending, ensuring crisp previews in chat bubbles and quotes.
- No external packages or Termux setup are required.

---

## Data Management & Backups

All state is stored in your device's private app storage:
```text
/data/data/net.leviro.levix/files/data/
├── levix.db           # SQLite database (settings, auth creds, notes, schedules)
├── logs/              # Bot activity logs
└── memory/            # AI long-term memory markdown files
```

### Backing Up Your Data
To back up your configuration and WhatsApp session:
- **Via ADB (No Root Required)**:
  ```bash
  adb backup -f levix-backup.ab net.leviro.levix
  ```
- **Via Root / File Manager**:
  Copy `/data/data/net.leviro.levix/files/data/levix.db` to your SD card or cloud storage.

---

## Upgrading

To update Levix to a newer version:
1. Download the new `levix-android-arm64.apk` from [Releases](https://github.com/Abdodiab2005/levix/releases).
2. Install it directly over the existing app.
3. Your database, WhatsApp pairing, settings, and passwords will remain completely intact.
4. On first launch after updating, Levix automatically detects the version upgrade and refreshes the application bundle in the background.

---

## Troubleshooting & FAQ

#### Why did WhatsApp show "Couldn't link device" when using a pairing code?
Make sure you enter your phone number with the international country code and without leading zeroes or symbols (e.g. `2010XXXXXXXX` for Egypt, `1XXXXXXXXXX` for USA). Do **not** enter `010...` or `+20...`.

#### Why does the Web Control Panel say "Connection Refused"?
Make sure the host service is running. Open the Levix Host app and verify the state shows `Node: running`. If it is stopped, tap **Start Host**.

#### Can I access the Web Control Panel from my PC on the same Wi-Fi?
By default, the web panel is bound strictly to `127.0.0.1` (localhost) for mobile security. To access it from a computer on the same network, use ADB port forwarding:
```bash
adb forward tcp:3001 tcp:3001
```
Then navigate to `http://localhost:3001` in your computer's browser.

#### Does Levix work on 32-bit (armv7l) phones?
No. Modern Node.js and Baileys v7 require 64-bit ARM architecture (`arm64-v8a`).

#### Will Levix drain my battery?
Levix is optimized to idle at negligible CPU usage (~0.1% - 0.5% CPU when no messages are being processed). RAM usage typically hovers around 90–140 MB.

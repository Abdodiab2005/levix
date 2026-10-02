# Levix for Android

Run **Levix** directly on your Android phone as an autonomous background companion — **no VPS, no Termux at runtime, no cloud server, and no subscription fees**.

Levix for Android packages the complete Levix stack into a standalone Android APK:
- **Node.js 24 LTS** compiled for Android Bionic (ARM64 **and** ARMv7)
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
| **Architecture** | **ARM64** (`levix-android-arm64.apk` — almost all phones since 2016) or **ARMv7 32-bit** (`levix-android-armv7.apk` — remaining 32-bit-only devices). |
| **Android Version** | **Android 10** or newer (API level 29+; the app targets API 36). |
| **Free Storage** | ~400 MB (APK ~100–110 MB per ABI + unpacked app bundle + SQLite database). |
| **WhatsApp Account** | An active WhatsApp account to link with via pairing code or QR. |

---

## Installation

1. Go to the [Levix Releases](https://github.com/Abdodiab2005/levix/releases) page on GitHub.
2. Download the APK that matches your device:
   - **`levix-android-arm64.apk`** — 64-bit devices (almost all phones since 2016).
   - **`levix-android-armv7.apk`** — 32-bit-only devices.
   - Not sure? Install the [AIDA64](https://play.google.com/store/apps/details?id=com.finalwire.aida64) app or check your phone's specs; if it says `arm64-v8a` / `aarch64` / "64-bit", use the arm64 build.
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

### Media Hub

Open **Media Hub** from the native host screen to browse WhatsApp and WhatsApp Business statuses, photos, videos, voice notes, audio, documents, and stickers. Search, filter, favorite, share, and save copies to user-visible Levix folders. Storage Insights shows local totals and large files. Only copies saved by Levix can be deleted in the hub.

The hub asks for media permission when you open it, after an explanation. Android 14's selected-media permission shows only the items you selected; you can select more or allow full access in system settings. Hidden `.Statuses` folders and some documents may not appear in MediaStore. In that case, use **Enable status access** to grant read-only access to the WhatsApp Media folder through Android's folder picker. Levix remembers the grant and asks again only if access is removed. Media Hub never uploads files, names, thumbnails, or folder details.

Levix bundles a native build of **FFmpeg** (`libffmpeg.so` — ARM64 or ARMv7, matching the APK) inside the APK, compiled from source with NDK r29 so it is safe on 16 KB-page devices.
- **Voice Notes (`!tts`)**: The Text-to-Speech command automatically transcodes Google TTS MP3 audio into true WhatsApp PTT voice notes (`audio/ogg; codecs=opus`).
- **Media Previews**: Video and picture thumbnails (`jpegThumbnail`) are generated locally on the phone before sending, ensuring crisp previews in chat bubbles and quotes.
- **Stickers**: The WebP encode, animation and muxing that Sticker Studio needs (see below).
- No external packages or Termux setup are required.

---

## Sticker Studio

Sticker Studio is the panel's sticker screen. It is reached from the native side rather than opened by hand, because the panel runs in a WebView with no file picker of its own and no way to reach a `content://` URI belonging to the Media Hub.

### The two actions in the Media Hub

Any single item in **Media Hub** can be turned into a sticker, in two places:

- the **viewer**, on the action row under the picture — hidden for items with no sticker form;
- the **selection bar**, on **Make sticker** — visible only when exactly one stickerable file is selected, since Sticker Studio takes one file at a time.

The label follows the file:

| Label | When | What the panel does |
| --- | --- | --- |
| **Make sticker** | an image, GIF or video | opens the converter: trim, frame, and re-encode to WebP |
| **Add to stickers** | a WhatsApp sticker (`.webp`) | keeps the file as it is and only adds it to your library |

Voice notes, audio and documents get no action at all — they have no sticker form, so nothing is shown rather than something that would always refuse.

Tapping either one opens the panel on its Sticker Studio screen. Nothing is read on the phone at that moment: the app records the URI it already has permission to read, and the panel picks it up from there. If the file is over the cap, or Android never reported its size, you get a message instead of a screen.

### Why the cap is 16 MB

16 MB is Sticker Studio's own upload ceiling, and it is written down twice — `PendingStickers.MAX_BYTES` and `PanelFiles.MAX_BRIDGE_BYTES` — with a unit test asserting the two agree. The number exists because of how the file travels:

> The bytes cross into the page as **one base64 string on a single synchronous JavaScript bridge call**, and the page waits for it.

A 16 MB file is already ~21 MB of base64 plus a decoded copy in the same heap. Checking the size before the read — rather than after — is what keeps an oversized file from being held in memory at all. The size is checked against MediaStore's own metadata, so an item whose size was never reported is refused instead of being discovered to be 200 MB later.

### The three bridge methods

The panel talks to the app through `window.LevixHost` (`PanelBridge`). Three methods carry files:

| Method | Direction | What it does |
| --- | --- | --- |
| `takePendingSticker()` | panel → app | takes the file the Media Hub parked, and returns its bytes as base64 with `{"ok":true,"intent","name","mime","data"}` |
| `shareFile(fileName, mime, base64)` | panel → app | hands an exported sticker to the system share sheet |
| `saveDownload(fileName, mime, base64)` | panel → app | writes a file into `Downloads/Levix` |

`takePendingSticker()` is **one-shot**: the holder is cleared even when the read goes on to fail, so a failed pick can never be retried by a later page load and converted twice. Nothing about a user's photo outlives the process — the handover is in-memory by design.

Both outbound methods enforce the same rules, in `PanelFiles`:

- **an allowlisted MIME type** — `application/zip`, `image/gif`, `image/png`, `image/webp`, `video/mp4`. A share sheet that accepted `application/octet-stream` would be a file dropper in disguise;
- **a safe name** — separators, control characters and the punctuation Windows and FAT reject become underscores, a leading dot can never hide the file, and the length is capped;
- **the 16 MB cap**, checked on the encoded length *before* decoding.

Anything refused comes back as `{"ok":false,"error"}` and is logged to the app's log screen.

Share copies are written to the FileProvider's cache folder (`cache/shared/`) and swept once they are more than a day old, so a host service that lives for weeks does not keep every sticker it ever shared.

### The FFmpeg components this needs

`android/scripts/build-ffmpeg-android.sh` builds **libwebp 1.6.0** (with a pinned SHA-256) and adds these components:

| Kind | Components | Why |
| --- | --- | --- |
| libraries | `libwebp` + `libwebpmux` + `libsharpyuv` | WebP encode/decode, animation, and muxing; libwebp's own sharp/colour-space helpers |
| encoders | `libwebp`, `libwebp_anim`, `rawvideo` | still stickers, animated stickers, and raw frames |
| demuxers | `rawvideo`, `image_gif_pipe` | reading GIF frames to animate them |
| muxers | `webp`, `rawvideo` | writing a `.webp` container |

Static and PIC, `CC`/`AR`/`RANLIB` supplied by the cross toolchain, so the result stays position-independent and safe on 16 KB-page devices. The ARM64 binary grows by roughly 5% against the build without it.

The filters FFmpeg already enables at defaults are what the studio's own pipeline needs — `pad`, `fps`, `scale`, `crop`, `trim`, `transpose`, `split`, `colorkey`, `overlay`, `palettegen`, `paletteuse` — so nothing was added or removed there.

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
1. Download the new APK from [Releases](https://github.com/Abdodiab2005/levix/releases) — `levix-android-arm64.apk` or `levix-android-armv7.apk`, whichever you installed before.
2. Install it directly over the existing app.
3. Your database, WhatsApp pairing, settings, and passwords will remain completely intact.
4. On first launch after updating, Levix automatically detects the version upgrade and refreshes the application bundle in the background.

---

## Building the APK from Source

If you prefer to compile Levix Host from source:

### 1. Prerequisites
- **JDK 17** & **Android SDK 36** (`$ANDROID_HOME` configured)
- **Node.js 24+** on your development machine
- Tools: `zip`, `unzip`, `rsync`, `curl`, `python3`, `dpkg-deb` (for extracting the runtime packages), `make` and `pkg-config` (for building FFmpeg)

### 2. Fetch the Embedded Node.js Runtimes (ARM64 + ARMv7)
Download and unpack the Node.js 24 binaries for Android and build FFmpeg for each ABI (the first run downloads NDK r29 unless `$ANDROID_HOME/ndk/29.0.14206865` exists):
```bash
android/scripts/fetch-node-android.sh                 # both ABIs
android/scripts/fetch-node-android.sh arm64-v8a       # one ABI only
```
The script verifies every 64-bit ELF is safe on 16 KB-page devices — 16 KB aligned, RELRO not sharing a page with writable data, built with NDK r28+ — as Google Play requires for apps targeting API 35+, and fails the build otherwise.

### 3. Build the APKs
Run Gradle to assemble one APK per ABI:
```bash
cd android
./gradlew :app:assembleDebug
```
> The Gradle `stageLevixApp` task automatically runs `npm run build:frontend` to compile the React dashboard into `public/dashboard`, stages the production server bundle into `levix-app.zip`, and embeds it inside the APK assets. Staging fails rather than packaging an APK whose panel would render unstyled: it checks that `public/dashboard/index.html` exists, links a stylesheet, and that every asset it references is present both on disk and inside `levix-app.zip`.

> The panel's CSS is built for the system WebView, which on the 32-bit (`armeabi-v7a`) devices the APK supports is far behind current desktop browsers. `frontend/vite.config.ts` flattens Tailwind's `@layer` blocks — a WebView without cascade layers (pre-Chrome 99) drops them wholesale and renders the panel with no styling at all — and downlevels `oklch()` through Lightning CSS.

> It also re-states Tailwind's `translate`/`rotate`/`scale` utilities as `transform` behind `@supports not (translate: 0px)`. Those standalone properties need Chrome 104, and a WebView that drops them leaves the mobile sidebar parked over the page (its `-translate-x-full` never moves it off-screen), the settings toggles stuck showing "off", and the RTL icon flips dead. The build fails rather than emit a transform it cannot downlevel, so a Tailwind upgrade that uses a new shape is caught here instead of on someone's phone.

Outputs land in `android/app/build/outputs/apk/<buildType>/` as `levix-android-arm64.apk` and `levix-android-armv7.apk`.

### 4. Install onto Device
```bash
adb install -r app/build/outputs/apk/debug/levix-android-arm64.apk
```

### 5. Build the Google Play bundle (AAB)
Google Play requires an **AAB**, not an APK:
```bash
cd android
./gradlew :app:stageLevixBundle
# -> app/build/outputs/bundle/release/levix-android.aab
```
The AAB contains both ABIs; Play generates the right per-device APK from it. Sign with your upload keystore via `LEVIX_KEYSTORE_FILE` / `LEVIX_KEYSTORE_PASSWORD` / `LEVIX_KEY_ALIAS` / `LEVIX_KEY_PASSWORD` (`stageLevixBundle` refuses to run without them — Play rejects debug-signed bundles; release APKs from `assembleRelease` still fall back to the debug keystore for local testing). Before submitting, fill the Play Console **Data safety** form from [`PRIVACY.md`](PRIVACY.md) and host that policy at a public URL.

---

## Sending Feedback & Reaching the Developer

Levix has no support desk, and nothing about your installation is reported
automatically. When something is wrong — or right — the panel is where you say so:

1. Tap **Open Control Panel** in the app.
2. Go to **Settings → Feedback**.
3. Pick what it is about (a bug, an idea, a question, or how it is going), write
   the message, and press **Send**.

The message goes to the developer directly. What travels with it: your text, the
topic, an optional 1–5 rating, an optional way to reach you, and the Levix
version and platform so a bug report says which build it came from. Nothing from
WhatsApp is attached — no message, chat, contact, credential or key — and nothing
is sent until you press Send. The same form is on the web at
[levix.leviro.net/feedback](https://levix.leviro.net/feedback) if the host will
not start at all.

Leave the contact field empty and nothing you send names you; fill it in if you
want an answer. For a bug you would rather see tracked in public with logs
attached, open a [GitHub issue](https://github.com/Abdodiab2005/levix/issues)
and use **Share Logs** in the app to attach the host log.

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

#### Does Levix work on 32-bit (armv7) phones?
Yes — install **`levix-android-armv7.apk`**. (Most phones from 2016 onward are 64-bit and should use `levix-android-arm64.apk` instead; the 64-bit build is the one Google Play serves by default.)

#### How do I report a bug or ask for a feature?
**Settings → Feedback** in the control panel — see "Sending Feedback & Reaching
the Developer" above. It reaches the developer directly, and the app version and
platform travel with it so nothing has to be guessed.

#### Will Levix drain my battery?
Levix is optimized to idle at negligible CPU usage (~0.1% - 0.5% CPU when no messages are being processed). RAM usage typically hovers around 90–140 MB.

# Levix Android host — where we are

Last updated: **2026-09-10** (`3.0.0-beta`)

**Status:** Levix is a live WhatsApp companion on a Redmi 9 (Lineage, ARM64). No VPS. No Termux at runtime.

**On main:** [#34](https://github.com/Abdodiab2005/levix/pull/34), [#35](https://github.com/Abdodiab2005/levix/pull/35)  
**Tags:** [`v3.0.0-alpha`](https://github.com/Abdodiab2005/levix/releases/tag/v3.0.0-alpha) → **`v3.0.0-beta`**

Full original plan: [`LEVIX_ANDROID_HOST_PLAN.md`](LEVIX_ANDROID_HOST_PLAN.md)

Release line: **alpha → beta → rc → 3.0.0**.

---

## Snapshot

| Phase | What | Status |
| --- | --- | --- |
| 0 | `android/` Gradle skeleton | Done |
| 1 | Foreground service + Start/Stop | Done on device |
| 2 | Embedded Node.js 24 ARM64 heartbeat | Done on device |
| 3 | Boot Levix core (SQLite, 55 commands, localhost panel) | Done on device |
| 4 | WhatsApp pairing (code or QR) | **Done on device** (pairing code) |
| 5 | Pairing UX polish | Mostly done (chooser + Chrome companion) |
| 6 | WebView panel | Done (loopback only) |
| 7 | Boot receiver / OEM battery / Node crash retry | **Coded** (needs reboot + overnight soak) |
| 8 | FFmpeg | Not started (`!tts` falls back) |
| 9 | CI APK job | Not started |

**Package:** `net.leviro.levix`  
**APK versionName:** `3.0.0-beta` (versionCode **8**)  
**Node on device:** `v24.18.0` / `android` / `arm64`

**Next checks (not blockers):**

1. `!ping` with the screen locked.
2. Stop/Start the host and confirm WhatsApp reconnects without pairing again.
3. Then: FFmpeg, CI APK, `v3.0.0-rc.1`.

---

## How the host is shaped

```text
APK
 ├─ lib/arm64-v8a/libnode.so     Node 24 Bionic executable (W^X-safe)
 ├─ lib/arm64-v8a/*.so[.N]       libc++, OpenSSL, ICU, sqlite, cares, zlib
 └─ assets/levix-app.zip         Levix JS + production node_modules
        ↓ unpack once
 filesDir/app/                   code (boot.mjs, src/, views/, public/, node_modules)
 filesDir/data/                  LEVIX_DATA_DIR (levix.db, logs, memory, auth)
```

Kotlin `LevixHostService` keeps a foreground notification. It execs `libnode.so` against `filesDir/app/boot.mjs`.

Node env:

| Variable | Value |
| --- | --- |
| `LEVIX_ANDROID` | `1` |
| `LEVIX_DATA_DIR` | `filesDir/data` |
| `LEVIX_OPEN_BROWSER` | `0` |
| `HOME` | `filesDir/data` |
| `TMPDIR` | app cache dir |
| `LD_LIBRARY_PATH` | `nativeLibraryDir` |

On Android, pino logs in-process (no worker threads). The panel binds **`127.0.0.1`**. Open Panel is a WebView that only loads loopback HTTP.

---

## Step-by-step: what we built

### Phase 0–1 — Foreground host (PR #34)

**Goal:** prove Android can keep a Levix-shaped process alive with the screen locked.

- New `android/` Kotlin app, min SDK 29, target 35, **ARM64 only**.
- `LevixHostService`: `specialUse` FGS, `START_STICKY`, ongoing notification, Start/Stop.
- Recents swipe and screen lock do not kill the service.
- `HostLog` → logcat + `filesDir/host.log` (no secrets).
- Partial wake lock while the host is running.
- Backups disabled (`allowBackup=false` + extraction rules).

**Device:** Start → notification stays → Stop → Start again without reboot.

### Phase 2 — Embedded Node 24 (PR #34)

**Goal:** run real Node 24 on Bionic, not Termux.

- No official Node 24 Android binary. We **vendor Termux aarch64 debs** (nodejs-lts 24.18) and `patchelf` `RPATH` to `$ORIGIN`.
- The `node` ELF is shipped as `libnode.so` so Android 10 W^X still allows exec from `nativeLibraryDir`.
- Versioned libs (`libcrypto.so.3`, `libssl.so.3`, ICU `.so.78`, `libz.so.1`) are zip-injected into the APK because AGP only packs `*.so`.
- First JS was `heartbeat.js`: `process.version` / `platform` / `arch` + 30s heartbeat.

**Script:** `android/scripts/fetch-node-android.sh`  
**Cache:** `~/.cache/levix-android/` (JDK 17, SDK 35, Node runtime). Not committed.

**Device:** `v24.18.0` `android` `arm64`; Stop kills Node; app process stays.

### Phase 3 — Boot Levix core (PR #35)

**Goal:** SQLite + commands + panel on the phone.

- `android/scripts/stage-levix-app.sh` packs `src/`, `views/`, `public/`, `bin/`, `app.cjs`, `scheduler.cjs`, production `node_modules` (no ffmpeg-static / esbuild / sharp) into `assets/levix-app.zip` (gitignored).
- First launch unpacks to `filesDir/app`. Stamp is `versionName-versionCode` so APK upgrades re-unpack.
- `android/host-boot.mjs`: probe `node:sqlite` → `levix --no-open`.
- `LEVIX_ANDROID=1`: in-process pino; panel `127.0.0.1`.
- Ready lines parsed by Kotlin: `sqlite ok`, `Database ready`, `Commands loaded N`, `Panel listening …`, `Levix ready`.
- `host.log` skips setup codes, passwords, and pino INFO/WARN spam.

**Device:**

```text
sqlite ok
Database ready
Commands loaded 55
Panel listening http://localhost:3001/setup
Levix ready
```

`files/data/levix.db` survives Stop. Second Start skips unpack.

### Phase 4–6 — Panel + WhatsApp pairing (PR #35)

**Goal:** link WhatsApp on the same phone (QR is awkward).

1. **TLS probe** at boot: `HEAD https://web.whatsapp.com/` → `tls ok 200`.
2. **Open Panel** → `PanelActivity` WebView, loopback only (`network_security_config` allows cleartext to `127.0.0.1` / `localhost` only).
3. **Connection screen** asks **before** the socket is created:
   - QR code (desktop default)
   - Pairing code (Android/mobile default) + number with country code
4. First pairing codes failed: Baileys was `Browsers.windows("Desktop")` (UWP). WhatsApp rejected the code (“Couldn’t link device”).
5. **Fix:** pairing-code starts use `Browsers.macOS("Chrome")`. QR keeps Windows Desktop.
6. `requestPairingCode` writes `creds.me.id` *before* the phone accepts. `isPaired` now requires `registered !== false`.
7. Numbers starting with `0` are rejected (`2010…` not `010…`). Arabic-Indic digits accepted.
8. Pairing codes are **never logged**. Shown in the panel as `XXXX-XXXX`, with `For WhatsApp +20…`.

**Device:** pairing code entered in WhatsApp → Linked devices → Link with phone number → **linked successfully**.

---

## PRs and tags

| Ref | What |
| --- | --- |
| [#34](https://github.com/Abdodiab2005/levix/pull/34) | Merged. Phases 0–2. `v3.0.0-alpha`. |
| `v3.0.0-alpha` | GitHub **prerelease**. npm dist-tag `alpha` (not `latest`). `/install.sh` unchanged. |
| [#35](https://github.com/Abdodiab2005/levix/pull/35) | Merged. Core boot, WebView, pairing chooser, Chrome pairing fix. |
| `v3.0.0-beta` | GitHub **prerelease**. npm dist-tag `beta`. |

Prerelease tags (`3.0.0-alpha` / `-beta` / `-rc.N`) publish to the matching npm dist-tag and are marked prerelease on GitHub.

---

## Rebuild / install

Needs: JDK 17, Android SDK 35, `zip`, `rsync`, `npm ci` in the repo, ARM64 phone (API 29+).

```bash
android/scripts/fetch-node-android.sh   # once per machine
cd android
./gradlew :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

`preBuild` regenerates `levix-app.zip`. First launch after a versionCode bump unpacks again (~10s).

Debug extras (same exported activity):

```bash
adb shell am start -n net.leviro.levix/.MainActivity --ez autostart true
adb shell am start -n net.leviro.levix/.MainActivity --ez autostop true
adb shell am start -n net.leviro.levix/.MainActivity --ez openPanel true
```

---

## Hard rules that still apply

- Nothing writes next to the code; mutable state is `filesDir/data`.
- Do not log WhatsApp auth, API keys, panel password, setup codes, or pairing codes.
- `android/` is not in the npm tarball.
- Termux is a **build** source for the Node ELF only. It is not installed on the phone.
- Don’t add a second installer; don’t add env vars besides `LEVIX_DATA_DIR` (Android uses that same variable).
- `levix domain` / systemd / browser auto-open stay desktop-only.

---

## Explicitly not done

- FFmpeg in the APK (`!tts` warns and falls back)
- GitHub Actions APK job
- Confirmed `!ping` under screen lock / after host restart
- Confirmed reboot autostart and overnight soak
- Play Store (far goal — GitHub Releases first, then Play)

---

## Key files

| Path | Role |
| --- | --- |
| `android/app/.../LevixHostService.kt` | Foreground host |
| `android/app/.../NodeRuntime.kt` | Exec Node, parse ready lines |
| `android/app/.../LevixAppBundle.kt` | Unzip JS bundle |
| `android/app/.../PanelActivity.kt` | Loopback WebView |
| `android/host-boot.mjs` | sqlite + TLS probe + `levix --no-open` |
| `android/scripts/fetch-node-android.sh` | Node 24 ARM64 runtime |
| `android/scripts/stage-levix-app.sh` | Pack Levix into the APK |
| `src/core/session.js` | QR vs pairing code, before socket |
| `src/config/baileys.config.js` | Chrome browser for pairing codes |
| `src/bootstrap/panel.js` | `127.0.0.1` when `LEVIX_ANDROID=1` |
| `src/utils/logger.cjs` | In-process logs on Android |

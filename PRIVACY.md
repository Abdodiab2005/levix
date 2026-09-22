# Levix Privacy Policy & Google Play Data Safety

> **Effective date:** 2026-09-22
> **Applies to:** the Levix Android app (`net.leviro.levix`) and the Levix
> self-hosted server distributed from this repository.
> **Product:** Levix, built by Abdelrhman Diab, Leviro.

---

## Plain-language summary

Levix is a **self-hosted** personal WhatsApp bot. The Android app runs the
entire bot **on your device** — there is no Levix cloud, no Levix account, and
no Levix server. The developer does **not** receive any data from your
installation: no analytics, no telemetry, no crash reports, no ads.

Data only leaves your device as a direct result of features you use:

1. **WhatsApp** — Levix is a WhatsApp client; your messages, pairing data and
   WhatsApp account credentials necessarily travel to WhatsApp (Meta) so the
   product can function.
2. **Your chosen AI provider** — when you use an AI feature, the text (and
   media, on the Gemini path) of that conversation is sent to the AI provider
   you configured, with **your own API key** (Google Gemini, any
   OpenAI-compatible server, or Anthropic).
3. **Search engines** — when an AI answer uses the web-search tool, the search
   query goes to DuckDuckGo (or Google Programmable Search, if you configured
   it).

Everything else — the database, your settings, API keys, memory files, the
control panel — stays in the app's private storage on the device.

---

## 1. Data stored on your device (never leaves it)

| Data | Where it lives | Purpose |
| --- | --- | --- |
| WhatsApp pairing credentials | App-private SQLite DB + files | Linking to your WhatsApp account |
| Control-panel password | scrypt hash in the local DB | Logging into the local panel |
| AI provider API keys & endpoints | Local DB, sealed with AES-256-GCM | Calling the provider you chose |
| Bot configuration (prefix, permissions, group settings) | Local DB | Running the bot |
| AI conversation history | Local DB (`ai_history`) | Conversational context; wiped with `!del` / `!delall` |
| Long-term AI memory | `memory/*.md` files in app storage | Facts you asked the bot to remember |
| Todos, notes, debts, schedules, warnings, user roles | Local DB | The bot's own features |
| Forward counters and sender last-seen metadata | Local DB (auto-expiring) | The anti-forward feature |
| Logs | App-private `logs/` + Android Logcat | Debugging |

Notes:

- The bot does **not** archive other people's messages. Nothing incoming is
  stored beyond the metadata rows listed above; deleted/edited messages are
  not captured.
- Android backup of app data is **disabled** (`allowBackup="false"`), so none
  of this is copied to Google's device backup.
- The embedded control panel binds to the loopback interface
  (`127.0.0.1:3001`) only. Cleartext traffic is permitted only to
  `localhost`/`127.0.0.1` (the built-in panel); all external endpoints are
  required to use HTTPS.

## 2. Data that leaves the device, and to whom

| Recipient | What is sent | When | Why |
| --- | --- | --- | --- |
| **WhatsApp (Meta)** | Your messages, media you send through the bot, your phone number / pairing credentials, group metadata | Continuously while the bot is linked | Levix is a WhatsApp client; this is the product's core function |
| **Your configured AI provider** (Google, OpenAI-compatible server, or Anthropic — chosen by you, using your own API key) | The text/media of AI conversations you take part in | Only when you invoke an AI feature (`!gemini`, `!ask`, `!ai`, `!generate`, `!stt`, …) | To generate the answer you asked for |
| **DuckDuckGo** or **Google Programmable Search** (if you configured it) | The search query | Only when an AI answer uses the web-search tool | Web-grounded answers |
| **Web pages the AI opens** | Standard HTTP requests to the page's server | Only when an AI answer uses the fetch-page tool | Reading a page you asked about |
| **Your configured outbound proxy** (optional, off by default) | WhatsApp traffic only | While linked, if you set a proxy | Routing |

The developer of Levix is **not** a recipient of any of the above. The AI
provider's use of the content you send it is governed by that provider's own
privacy policy.

## 3. Permissions the Android app requests

| Permission | Why |
| --- | --- |
| `INTERNET`, `ACCESS_NETWORK_STATE` | WhatsApp connection and the local panel |
| `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_SPECIAL_USE` | Keep the bot host running so the bot stays connected (special-use subtype: persistent personal WhatsApp bot host) |
| `POST_NOTIFICATIONS` | The ongoing connection-status notification |
| `WAKE_LOCK` | Keep the CPU awake while processing in the background |
| `RECEIVE_BOOT_COMPLETED` | Resume the host after device reboot |
| `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` | Offer (never silently apply) a battery-optimization exemption so Android doesn't kill the host |

No location, camera, microphone, contacts, SMS, or storage permissions are
requested. The in-app WebView loads only the local control panel
(`http://127.0.0.1:3001`); it does not load third-party web content.

## 4. Data retention and deletion

- **AI conversation history** — delete per chat with `!del` (or all chats with
  `!delall`, owner only), or from the panel.
- **Long-term memory** — `!memory forget` / `!memory clear`, or from the panel.
- **Unlink WhatsApp** (Connection → Unlink) — clears the WhatsApp credentials,
  roles, AI history, long-term memory and buffered context, and pauses the old
  account's schedules.
- **Uninstall the app** — removes everything; there is no server-side copy of
  any of your data to survive deletion.

## 5. Security

- API keys and auth blobs are sealed at rest with AES-256-GCM under an
  install-local key; the panel only ever reports whether a key is configured,
  never its value.
- The panel password is stored as a scrypt hash; login is throttled.
- Provider base URLs are validated on save and on use: public endpoints must
  be HTTPS, and private/reserved/metadata addresses are rejected (explicit
  loopback is allowed for local Ollama/LM Studio servers).
- Levix-owned fetch clients pin the validated DNS answer to the socket and
  follow redirects manually, so credentials cannot silently cross hosts.

## 6. Children

Levix is not directed at children. The Levix Android app is intended for users
aged **16 and over**. In Google Play Console, the target audience should be
declared as **16–17** and **18 and over**; age groups under 16 should not be
selected. Users must also meet WhatsApp's minimum-age requirements applicable
in their country or region.

## 7. Google Play Data Safety form — answer map

Fill the Play Console **App content → Data safety** form as follows. This
mapping reflects the behavior described above: only data that is actually
transmitted off the device is declared "collected"; on-device-only storage is
excluded per Google's definition.

**Q: Does your app collect or share any of the required user data types?**
→ **Yes** (data leaves the device to WhatsApp and to the user-configured AI
provider as core app functionality).

| Data type | Collected? | Shared? | Purpose | Details to enter |
| --- | --- | --- | --- | --- |
| Personal info → **Phone number** | Yes | No (not for the developer's or third parties' own purposes) | App functionality | Required (cannot use a core feature without it); encrypted in transit: **yes**; deletion: app unlink / uninstall |
| Messages → **Other user messages** (content the bot relays / you send to your AI provider) | Yes | No | App functionality | Required for core feature; encrypted in transit: **yes** (WhatsApp TLS / provider HTTPS); deletion: app unlink / uninstall |

**Q: Is all of the data collected encrypted in transit?** → **Yes**

**Q: Do you provide a way for users to request that their data is deleted?**
→ **Yes** (unlink in-app + uninstall; no server-side copy exists — see
section 4).

Everything else — device IDs, app interactions, diagnostics, location,
financial info — select **No / not collected**: the app contains no analytics,
advertising, or crash-reporting SDKs and sends nothing to the developer.

### Other Play Console declarations (checked, as of this version)

- **Privacy policy URL** — host this file (e.g. a GitHub-rendered
  `PRIVACY.md` link or a page on your site) and paste the URL; Play requires
  it for every app.
- **App access** — the app is gated by a user-chosen password (all
  functionality restricted).
- **Ads** — contains no ads. **No** declarations needed.
- **News app / government app / COVID-19 app** — No.
- **Financial features** — the `!debt` command is a personal note-taking
  ledger stored locally only; no financial services are offered.
- **AI-generated content** — the app can generate content via user-configured
  AI providers; comply with Play's "AI-Generated Content" policy (report/block
  mechanism is the panel + the bot owner, since the operator hosts it
  themselves).
- **Foreground service (special use)** — declared as
  `specialUse` with subtype "Persistent personal WhatsApp bot host"; provide
  the same justification text when Play asks.
- **16 KB page size** — all shipped 64-bit native libraries are ≥ 16 KB
  aligned; the build script verifies it.
- **64-bit** — the AAB includes `arm64-v8a` (plus `armeabi-v7a`).

## 8. Changes to this policy

Material changes will be published in this repository with a new effective
date. Continued use after a change means acceptance.

## 9. Contact

- Issues & security reports: [github.com/Abdodiab2005/levix](https://github.com/Abdodiab2005/levix)
- Product: Levix, built by Abdelrhman Diab, Leviro.

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
installation on its own: no analytics, no telemetry, no crash reports, no ads.
The only thing that ever reaches the developer is a message **you** write in
**Settings → Feedback** and press Send on.

Data only leaves your device as a direct result of features you use:

1. **WhatsApp** — Levix is a WhatsApp client; your messages, pairing data and
   WhatsApp account credentials necessarily travel to WhatsApp (Meta) so the
   product can function.
2. **Your chosen AI provider** — when you use an AI feature, the prompt and
   relevant context are sent to the provider you configured with **your own API
   key** (Google Gemini, any OpenAI-compatible server, or Anthropic). Depending
   on the feature and provider, that context can include your display name,
   WhatsApp user/phone identifiers, group name, message text, quoted or
   mentioned participant identifiers, AI history or long-term memory, and
   media or files you ask the AI to process. Supported images can be sent to
   OpenAI-compatible or Anthropic providers; Gemini can additionally receive
   supported video, audio and documents. Speech-to-text can send audio to
   Gemini or an OpenAI-compatible provider.
3. **Search engines** — when an AI answer uses the web-search tool, the search
   query goes to DuckDuckGo (or Google Programmable Search, if you configured
   it).
4. **The developer, if you send feedback** — the panel's **Settings → Feedback**
   form sends what you typed (your message, the topic, an optional 1–5 rating,
   an optional contact) plus the Levix version and the platform it runs on. It
   travels through `levix.leviro.net/api/feedback` and is delivered to the
   developer as a Telegram message. Nothing is attached from WhatsApp — no
   message, chat, contact, credential or key — and nothing is sent unless you
   press Send.

Everything else — the database, your settings, API keys, memory files, the
control panel — stays in the app's private storage on the device.

---

## 1. Data stored locally

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
- Some data stored locally — especially AI conversation history, long-term
  memory, names and WhatsApp identifiers — can be included as context in a
  later AI request when you choose to use an AI feature. Local storage does
  not mean that this context can never leave the device.
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
| **Your configured AI provider** (Google, OpenAI-compatible server, or Anthropic — chosen by you, using your own API key) | The AI prompt and relevant context, which can include display name, WhatsApp user/phone identifiers, group name, messages, quoted/mentioned participant identifiers, AI history or memory, and supported media/files | Only when you invoke an AI feature (`!gemini`, `!ask`, `!ai`, `!generate`, `!stt`, …) | To generate or process the result you asked for |
| **DuckDuckGo** or **Google Programmable Search** (if you configured it) | The search query | Only when an AI answer uses the web-search tool | Web-grounded answers |
| **Web pages the AI opens** | HTTPS requests to the page's server | Only when an AI answer uses the fetch-page tool | Reading a page you asked about |
| **Your configured outbound proxy** (optional, off by default) | WhatsApp traffic only | While linked, if you set a proxy | Routing |
| **The developer** (via `levix.leviro.net/api/feedback`, delivered as a Telegram message) | Only the feedback form's own fields — your message, the topic, an optional rating, an optional contact — plus the Levix version, the platform, and the sending app's user-agent | Only when you press Send in **Settings → Feedback** | Support: so a bug you report or a request you make reaches the person who can act on it |

Apart from feedback you deliberately send, the developer of Levix is **not** a
recipient of any of the above. The AI provider's use of the content you send it
is governed by that provider's own privacy policy.

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
- **Feedback you chose to send** — it is a message in the developer's inbox, not
  a record in a database, and the app has no copy of it. Ask the developer to
  delete it (section 9) and it will be deleted.

## 5. Security

- API keys and auth blobs are sealed at rest with AES-256-GCM under an
  install-local key; the panel only ever reports whether a key is configured,
  never its value.
- The panel password is stored as a scrypt hash; login is throttled.
- Provider base URLs are validated on save and on use: public endpoints must
  be HTTPS, and private/reserved/metadata addresses are rejected (explicit
  loopback is allowed for local Ollama/LM Studio servers).
- Levix-owned fetch clients pin the validated DNS answer to the socket and
  follow redirects manually. The AI `fetch_url` tool accepts HTTPS only, and
  redirects are re-validated so a page cannot downgrade the request to HTTP.

## 6. Children

Levix is not directed at children. The Levix Android app is intended for users
aged **16 and over**. In Google Play Console, the target audience should be
declared as **16–17** and **18 and over**; age groups under 16 should not be
selected. Users must also meet WhatsApp's minimum-age requirements applicable
in their country or region.

## 7. Google Play Data Safety form — answer map

Fill the Play Console **App content → Data safety** form as follows. This
mapping reflects the Android app's current behavior and the categories used by
Google Play.

**Q: Does your app collect or share any of the required user data types?**
→ **Yes**

**Q: Is all of the data collected encrypted in transit?**
→ **Yes**

**Account creation**
→ **My app does not allow users to create an account**

**Can users log in with accounts created outside of the app?**
→ **No**

**Q: Do you provide a way for users to request that their data is deleted?**
→ **No**. Levix has no developer-operated account or cloud copy to delete.
Users can still delete locally stored data with the in-app controls described
in section 4, unlink WhatsApp, or uninstall the app. Feedback a user chose to
send is the one thing the developer holds; it is deleted on request through the
contact in section 9.

Declare these data types:

| Data type | Collected? | Shared? | Required? | Purpose |
| --- | --- | --- | --- | --- |
| Personal info → **Name** | Yes | No | Optional | App functionality |
| Personal info → **User IDs / personal identifiers** | Yes | No | Required | App functionality |
| Personal info → **Phone number** | Yes | No | Required | App functionality |
| Messages → **Other in-app messages** | Yes | No | Optional | App functionality, Customer support |
| Personal info → **Email address** | Yes | No | Optional | Customer support |
| Photos and videos → **Photos** | Yes | No | Optional | App functionality |
| Photos and videos → **Videos** | Yes | No | Optional | App functionality |
| Audio files → **Voice or sound recordings** | Yes | No | Optional | App functionality |
| Audio files → **Other audio files** | Yes | No | Optional | App functionality |
| Files and docs → **Files and docs** | Yes | No | Optional | App functionality |
| Contacts → **Contacts** | Yes | No | Optional | App functionality |
| App activity → **In-app search history** | Yes | No | Optional | App functionality |
| App activity → **Other user-generated content** | Yes | No | Optional | App functionality |
| Web browsing → **Web browsing history** | Yes | No | Optional | App functionality |

For every data type above:

- **Processed ephemerally:** No.
- **Collection purpose:** App functionality, plus **Customer support** for the
  two rows the feedback form touches — the message text (Messages → Other
  in-app messages) and the contact you may optionally leave (Personal info →
  Email address). Both are optional: the form works without a contact, and
  nothing is sent until you press Send.
- **Sharing purpose:** none, because the form is declared as collected rather
  than shared under Google Play's applicable user-initiated/service-provider
  handling rules.

The **Email address** declaration covers only the optional contact field in the
feedback form — it is never read from the device, and the field can be left
empty.

The **Contacts** declaration does not mean Levix requests Android's Contacts
permission. It covers WhatsApp participant identifiers (for example mentioned
or quoted participants) that can be included in an AI request.

Do **not** declare location, financial info, health/fitness, calendar, app
performance/diagnostics, installed apps, or device/other identifiers. Levix
contains no analytics, advertising, or crash-reporting SDK.

### Other Play Console declarations

- **Privacy policy URL** — use the public Levix privacy page.
- **App access** — the local control panel is gated by a user-chosen password.
- **Ads** — no ads.
- **News app / government app / COVID-19 app** — No.
- **Financial features** — the `!debt` command is a personal note-taking
  ledger stored locally only; no financial services are offered.
- **AI-generated content** — Levix can generate content through user-configured
  AI providers.
- **Foreground service (special use)** — declared as `specialUse` with
  subtype "Persistent personal WhatsApp bot host".
- **16 KB page size** — all shipped 64-bit native libraries are expected to be
  ≥ 16 KB aligned; the Android build/release checks should remain enabled.
- **64-bit** — the AAB includes `arm64-v8a` plus `armeabi-v7a`.

## 8. Changes to this policy

Material changes will be published in this repository with a new effective
date. Continued use after a change means acceptance.

## 9. Contact

- In the app: **Settings → Feedback** in the control panel — it reaches the
  developer directly, and is the fastest route for a bug or a request.
- On the web: [levix.leviro.net/feedback](https://levix.leviro.net/feedback)
- Issues & security reports: [github.com/Abdodiab2005/levix](https://github.com/Abdodiab2005/levix)
- Product: Levix, built by Abdelrhman Diab, Leviro.

# Levix Privacy Policy & Google Play Data Safety

> **Effective date:** 2026-10-24
> **Applies to:** the Levix Android app (`net.leviro.levix`) and the Levix
> self-hosted server distributed from this repository.
> **Product:** Levix, built by Abdelrhman Diab, Leviro.

---

## Plain-language summary

Levix is a **self-hosted** personal WhatsApp bot. The Android app runs the
entire bot **on your device** — there is no Levix cloud, no Levix account, and
no Levix server. The developer does **not** receive any data from your
installation on its own: no analytics, no telemetry, no ads, and no automatic
crash reporting. The only things that ever reach the developer are the ones
**you** choose to send: a message in **Settings → Feedback** (and the optional
diagnostics block you can tick on that form), and a crash report you press Send
on in the panel. Nothing is transmitted until you do. A Levix-operated mail
relay delivers a recovery code only when you ask for one; it does not keep the
address beyond rate limiting, and it does not send that address to the
developer.

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
   an optional contact), one optional file you pick yourself (a screenshot or a
   log, up to 20 MB), plus the Levix version and the platform it runs on. If —
   and only if — you also tick **Attach device & technical diagnostics**, it
   additionally sends the diagnostics listed in section 2a. It travels through
   `levix.leviro.net/api/feedback` and is delivered to the developer as a
   Telegram message, or as a Telegram document when a file is attached. Nothing
   is attached from WhatsApp — no message, chat, contact, credential or key —
   and nothing is sent unless you press Send.
5. **The developer, if you send a crash report** — a crash or a web error is
   written to a report file inside the app's own data directory, where it stays
   until **you** open the panel and press Send on that one report. Nothing is
   sent automatically and nothing is retried on its own. A report holds the
   error type, a sanitized message and stack, an optional screen id, the app and
   device fields listed in section 2a, and a few navigation breadcrumbs. It goes
   to the developer through `levix.leviro.net/api/crash-reports`.
6. **The Levix mail relay, if you set a recovery email** — verifying the address
   in **Settings**, or choosing **Email** on **Forgot password**, posts the
   address, the one-time code, and the UI language (`en` or `ar`) to
   `levix.leviro.net/api/recovery-email`. The relay sends a fixed message that
   contains only the code. It does not store the address beyond rate limiting,
   and it does not deliver the address to the developer.
7. **Your own Levix instance, for a sticker** — when you tap **Make sticker** or
   **Add to stickers** on a file in Media Hub, that one file is uploaded to the
   Levix server running on this phone, because that is what does the conversion.
   It goes nowhere else. Browsing Media Hub uploads nothing.

Everything else — the database, your settings, API keys, memory files, the
control panel — stays in the app's private storage on the device.

---

## 1. Data stored locally

| Data | Where it lives | Purpose |
| --- | --- | --- |
| WhatsApp pairing credentials | App-private SQLite DB + files | Linking to your WhatsApp account |
| Control-panel password | scrypt hash in the local DB | Logging into the local panel |
| Recovery email | Sealed with AES-256-GCM in the local DB (`auth:recovery-email`) | A verified address for the panel's forgot-password email code. The panel shows a mask. Settings export does not include it. Unlink does not remove it |
| AI provider API keys & endpoints | Local DB, sealed with AES-256-GCM | Calling the provider you chose |
| Bot configuration (prefix, permissions, group settings) | Local DB | Running the bot |
| AI conversation history | Local DB (`ai_history`) | Conversational context; wiped with `!del` / `!delall` |
| Long-term AI memory | `memory/*.md` files in app storage | Facts you asked the bot to remember |
| Todos, notes, debts, schedules, warnings, user roles | Local DB | The bot's own features |
| Auto-delete rules | Local DB (`auto_delete_rules`) | Keyword auto-delete configuration |
| Opt-in copies of auto-deleted messages (text/caption only) | Local DB (`auto_delete_log`, auto-expiring) | Only when a rule with keep-copy on actually deletes a message |
| Forward counters and sender last-seen metadata | Local DB (auto-expiring) | The anti-forward feature |
| Crash reports (not yet sent) | App-private `crash-reports/*.json` (auto-expiring) | Optional diagnostics you can review and send; nothing leaves until you press Send |
| Logs (including the 14-day technical debug log) | App-private `logs/` + Android Logcat | Debugging |

Notes:

- The bot does **not** archive other people's messages by default. Nothing
  incoming is stored beyond the metadata rows listed above; deleted/edited
  messages are not captured. The one exception is an auto-delete rule with
  keep-copy turned on: it stores the text or caption (never media bytes) of
  messages that rule actually deleted, and those rows expire.
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
| **The developer** (via `levix.leviro.net/api/feedback`, delivered as a Telegram message) | Only the feedback form's own fields — your message, the topic, an optional rating, an optional contact, an optional file you attach yourself — plus the Levix version, the platform, and the sending app's user-agent. If you tick the diagnostics box, the section 2a diagnostics object and the sanitized technical debug log in section 2b as well | Only when you press Send in **Settings → Feedback** | Support: so a bug you report or a request you make reaches the person who can act on it |
| **The developer** (via `levix.leviro.net/api/crash-reports`) | One crash report: category, sanitized error type/message/stack, an optional screen id, the app + section 2a device fields, the sanitized technical debug log in section 2b, and a few navigation breadcrumbs. Never a phone number, JID, chat/message body or media file | Only when **you** open the panel and press Send on one report; never automatically | Support: so a crash can be grouped and fixed |
| **Levix mail relay** (`levix.leviro.net/api/recovery-email`) | The recovery email address, the one-time code, and the UI language (`en` or `ar`). No other text | When you verify an address in **Settings**, or when you choose **Email** on **Forgot password** | To deliver the code. The relay does not store the address beyond rate limiting, and it does not pass the address to the developer |
| **Your own Levix server** (the instance running on this phone, reached at `http://127.0.0.1:3001` — never the developer, never an AI provider) | The one image, GIF or video you picked in Sticker Studio or the Media Hub, as a single upload | Only when you choose it in Sticker Studio or tap **Make sticker** / **Add to stickers** | Sticker Studio works server-side, so it has to receive the file you chose |

Apart from feedback and crash reports you deliberately send, the developer of
Levix is **not** a recipient of any of the above. The recovery-email relay
receives only the address, the code, and the language, and it does not store
the address beyond rate limiting. The AI provider's use of the content you send
it is governed by that provider's own privacy policy.

### 2a. Optional feedback diagnostics and crash reports

Neither of these carries an identifier that follows your device. Report ids are
random, generated per report, and mean nothing outside that one report.

**Feedback diagnostics** — optional, with its own checkbox on the feedback
form. When you tick **Attach device & technical diagnostics**, the panel sends
exactly the object below, after the server has validated and trimmed it, plus
the technical debug log in section 2b. The panel shows this same list — field
and value — and the log under **See exactly what is sent** before you press
Send, so what you see is what is sent.

| Field | Example | Source |
| --- | --- | --- |
| `schema` | `1` | the server, always |
| `levix` | `4.8.0` | the server, always |
| `node` | `v24.19.0` | the server, always |
| `platform` | `android` / `docker` / `node-linux` / `sea-linux` | the server, always |
| `nativeApp` | `4.8.0 (66)` | the Android app |
| `android` | `15 (API 35)` | the Android app |
| `device` | `samsung SM-A556E` | the Android app |
| `abi` | `arm64-v8a` | the Android app |
| `webview` | `131.0.6778.135` | the Android app |
| `screen` | `412x915@2.63` | the panel page |
| `language` | `ar` / `en` | the panel page |
| `theme` | `light` / `dark` | the panel page |
| `connectivity` | `wifi` / `cellular` / `ethernet` / `vpn` / `none` / `unknown` | the Android app |
| `memory` | `ok` / `low` / `unknown` | the Android app |
| `storage` | `ok` / `low` / `unknown` | the Android app |

Unknown values are the string `unknown`. A standalone browser has no Android
fields at all; they are simply not sent. Unticking the box means the request
carries no diagnostics key. It never contains your phone number, IMEI, Android
ID, advertising ID, IP address, location, Wi-Fi SSID, contacts, chat or message
text, JIDs, API keys, tokens or passwords. The one extra thing that accompanies
a ticked box is the sanitized technical debug log described in section 2b.

**Crash reports** — optional, one Send per report. A crash report is written
locally when the Node server dies on a fatal error, when the Android app
crashes, or when the panel hits a web error, and it holds:

- the schema version, a random per-report id, and a fingerprint used only to
  group reports that share a cause (not to identify a device);
- the timestamp and category (`node-uncaught`, `node-rejection`,
  `android-crash`, `android-anr`, `android-native`, `web-error`,
  `web-rejection`, `react-render`);
- the error type, a sanitized message, and up to 20 sanitized stack frames;
- an optional screen id — a route name only, never a URL or a query;
- the app fields (`levix`, `node`, `platform`, and `nativeApp` when known) and
  the same device fields as the diagnostics table above;
- up to 20 navigation breadcrumbs, each a kind, a time and an identifier.

A report's message, every stack frame and every breadcrumb name is scrubbed the
same way when the report is written and again before it is sent: WhatsApp JIDs
become `<jid>`, e-mail addresses `<email>`, runs of 7 or more digits `<number>`,
a URL keeps only its scheme and host, a 24+ character key-like run becomes
`<secret>`, and absolute paths under the data directory or your home become
`<data>` / `~`.
No phone number, IMEI, Android ID, advertising ID, IP address, location,
Wi-Fi SSID, contacts, chat or message bodies, JIDs, screenshots, API keys,
tokens or passwords are ever included. A Send also carries the sanitized
technical debug log described in section 2b, and the report's preview shows
that exact upload — log included — before you press Send.

### 2b. Technical debug log

Levix keeps an internal, detailed debug log on the device to make a problem
diagnosable. It is one JSON-lines file per day in the app's private storage
(`logs/debug/`). Both previews in the panel show it under its own collapsed
heading before anything is sent.

**What it records:** the application's own operational events — connection and
session transitions, scheduled work, HTTP route activity, errors and stack
frames, with timestamps and levels. **What it never records:** message content,
media, WhatsApp JIDs, phone numbers, e-mail addresses, API keys, tokens,
passwords, cookies, session values or paths that name your install or home
directory. Every record is rebuilt before it is written: a secret-shaped field
name keeps only `[redacted]`, a message-content field keeps only its length (for
example `[redacted 42 chars]`), and every other string is scrubbed with the same
rules as a crash report (`<jid>`, `<email>`, `<number>`, `<secret>`, `<data>`,
`~`) and capped at 2000 characters. A day's file stops at 5 MB.

**Retention and deletion:** the device keeps 14 days, then the file is deleted
automatically. **Clear logs** in the panel deletes the debug log together with
the normal logs.

**When it leaves the device:** only in the two situations you start — feedback
sent with **Attach device & technical diagnostics** ticked, or a crash report
you press Send on. It is never sent on its own, and each preview shows the
exact string that goes with the send.

## 3. Permissions the Android app requests

| Permission | Why |
| --- | --- |
| `INTERNET`, `ACCESS_NETWORK_STATE` | WhatsApp connection and the local panel |
| `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_SPECIAL_USE` | Keep the bot host running so the bot stays connected (special-use subtype: persistent personal WhatsApp bot host) |
| `POST_NOTIFICATIONS` | The ongoing connection-status notification |
| `WAKE_LOCK` | Keep the CPU awake while processing in the background |
| `RECEIVE_BOOT_COMPLETED` | Resume the host after device reboot |
| `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` | Offer (never silently apply) a battery-optimization exemption so Android doesn't kill the host |
| `READ_MEDIA_IMAGES`, `READ_MEDIA_VIDEO`, `READ_MEDIA_AUDIO` (Android 13+) | Discover and display WhatsApp media in the native Media Hub, only after you choose to grant access there |
| `READ_MEDIA_VISUAL_USER_SELECTED` (Android 14+) | Allow the Media Hub to show only photos and videos you select |
| `READ_EXTERNAL_STORAGE` (Android 12 and earlier) | Discover WhatsApp media in the native Media Hub on older Android versions |

The Media Hub can also request read-only access to a WhatsApp Media folder through Android's folder picker when hidden statuses or documents are unavailable through MediaStore. It retains that local grant until you revoke it. Browsing, search, thumbnails, favorites, Storage Insights, saving copies, and deleting Levix-saved copies are all local to the device. The Media Hub makes no network requests and does not send media, file names, or folder structure to Levix or to an AI provider. Sharing a file happens only when you explicitly choose an app in Android's share sheet.

### Sticker Studio

**A file you pick stays on the device.** Browsing Media Hub, and having an item
offered as a sticker, are entirely local: nothing is uploaded just because you
scrolled past a photo or long-pressed it.

A file is handed over when you choose it in Sticker Studio or tap **Make sticker** or
**Add to stickers** for that one file. It then goes to **your own Levix server**
(the instance running on this phone), and nowhere else: not to the developer, not
to an AI provider, not to any third-party service. Sticker Studio needs the file
server-side to convert and to send, and your instance is the server. From there
the sticker goes to WhatsApp only if you send it, which is the same as any
message you send through Levix.

Two smaller points about the file while it is being handled:

- The handover is **one-shot and in memory**. The app records only a reference to
  the file it already has permission to read; it is not copied or cached, and it
  is streamed to the local server only when you upload it. A preview reads it
  through a short-lived local URL. Nothing about your photo is written to an
  app staging area, and the reference disappears when the app process ends.
- Files you **share out** of Sticker Studio are temporary copies in the app's
  private cache, and only of the formats Sticker Studio produces (WebP, PNG,
  GIF, MP4, or a pack ZIP). They are deleted automatically after a day. Choosing
  where a shared file goes is the share sheet's job — the app grants a read
  permission to the app *you* pick and nothing more.

No location, camera, microphone, contacts, SMS, or unrestricted storage permissions are
requested. The in-app WebView loads only the local control panel
(`http://127.0.0.1:3001`); it does not load third-party web content.

## 4. Data retention and deletion

- **AI conversation history** — delete per chat with `!del` (or all chats with
  `!delall`, owner only), or from the panel.
- **Long-term memory** — `!memory forget` / `!memory clear`, or from the panel.
- **Unlink WhatsApp** (Connection → Unlink) — clears the WhatsApp credentials,
  roles, AI history, long-term memory and buffered context, and pauses the old
  account's schedules. The panel password and the recovery email are panel
  security, not WhatsApp data, and stay in place.
- **Recovery email** — removed from the device with **Remove** in **Settings**.
  It is sealed locally. The mail relay does not keep the address beyond rate
  limiting. `levix reset-password` does not remove it either.
- **Uninstall the app** — removes everything; there is no server-side copy of
  any of your data to survive deletion.
- **Feedback you chose to send** — it is a message in the developer's inbox, not
  a record in a database, and the app has no copy of it. Ask the developer to
  delete it (section 9) and it will be deleted.
- **Crash reports** — an unsent report stays on your device and is deleted
  automatically seven days after it is created (at most the 20 newest are kept);
  you can also delete any report, or all of them, from the panel at any time.
  A report you send is kept on the developer's server for at most 30 days and
  then deleted; ask the developer to delete a sent one by its report id
  (section 9) and it will be deleted.
- **A file picked for a sticker** — the handover is in-memory and one-shot, so
  nothing to delete: once the panel reads it, the app has no copy left. It lives
  on afterwards only inside your own Levix server's data directory, alongside
  your other Levix data, and goes when you unlink WhatsApp or uninstall.
- **A sticker you shared out** — a temporary copy in the app's private cache,
  swept automatically once it is more than a day old.

## 5. Security

- API keys and auth blobs are sealed at rest with AES-256-GCM under an
  install-local key; the panel only ever reports whether a key is configured,
  never its value.
- The panel password is stored as a scrypt hash; login is throttled.
- The recovery email is sealed at rest with the same install key. The panel
  and the login page show only a mask, never the address.
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
in section 4, unlink WhatsApp, or uninstall the app. Remove in Settings deletes
the recovery email from the device; the relay does not keep the address beyond
rate limiting. Feedback a user chose to
send is the one thing the developer holds; crash reports a user chose to send
are held for at most 30 days and then deleted. Both are deleted on request
through the contact in section 9.

Declare these data types:

| Data type | Collected? | Shared? | Required? | Purpose |
| --- | --- | --- | --- | --- |
| Personal info → **Name** | Yes | No | Optional | App functionality |
| Personal info → **User IDs / personal identifiers** | Yes | No | Required | App functionality |
| Personal info → **Phone number** | Yes | No | Required | App functionality |
| Messages → **Other in-app messages** | Yes | No | Optional | App functionality, Customer support |
| Personal info → **Email address** | Yes | No | Optional | App functionality, Customer support |
| Photos and videos → **Photos** | Yes | No | Optional | App functionality, Customer support |
| Photos and videos → **Videos** | Yes | No | Optional | App functionality, Customer support |
| Audio files → **Voice or sound recordings** | Yes | No | Optional | App functionality |
| Audio files → **Other audio files** | Yes | No | Optional | App functionality, Customer support |
| Files and docs → **Files and docs** | Yes | No | Optional | App functionality, Customer support |
| Contacts → **Contacts** | Yes | No | Optional | App functionality |
| App activity → **In-app search history** | Yes | No | Optional | App functionality |
| App activity → **Other user-generated content** | Yes | No | Optional | App functionality |
| Web browsing → **Web browsing history** | Yes | No | Optional | App functionality |
| App info and performance → **Crash logs** | Yes | No | Optional | App functionality, Analytics |
| App info and performance → **Diagnostics** | Yes | No | Optional | App functionality, Analytics |

For every data type above:

- **Processed ephemerally:** No.
- **Collection purpose:** App functionality, plus **Customer support** for the
  rows the feedback form touches — the message text (Messages → Other in-app
  messages), the contact you may optionally leave (Personal info → Email
  address), and the one file you may optionally attach (Photos, Videos, Other
  audio files, Files and docs). The contact and the file are optional, and
  nothing is sent until you press Send. The same Email address row also covers
  the recovery address, which is **App functionality**: it leaves the device
  only when you verify it or request a reset code. The **Crash logs** and **Diagnostics**
  rows are likewise optional and user-initiated: a crash report leaves only when
  you press Send on it, and the feedback diagnostics leave only when you tick
  their checkbox. Their purpose is **Analytics** in Google Play's sense —
  grouping and fixing crashes and faults.
- **Sharing purpose:** none, because the form, the crash report, and the
  recovery-email relay are declared as collected rather than shared under
  Google Play's applicable user-initiated/service-provider handling rules.

The **Email address** declaration covers the optional contact field in the
feedback form and, when you choose it, the recovery address you type in
Settings for panel-password reset. Neither is read from the device. The
feedback contact can be left empty. The recovery address is stored sealed on
the device and is sent to the Levix mail relay only when you verify it or
request a reset code. The relay does not store it beyond rate limiting. Under
Google Play's user-initiated handling this stays **collected**, not shared.

The **Contacts** declaration does not mean Levix requests Android's Contacts
permission. It covers WhatsApp participant identifiers (for example mentioned
or quoted participants) that can be included in an AI request.

Do **not** declare location, financial info, health/fitness, calendar, installed
apps, or device/other identifiers. Levix contains no analytics, advertising, or
crash-reporting SDK: the **Crash logs** and **Diagnostics** rows above are the
user-initiated reports described in sections 2a and 4, which the app writes
locally and sends only when the user presses Send. There is no device-following
identifier anywhere in them.

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
  ≥ 16 KB aligned and built with NDK r28+; the Android build/release checks
  (`verify_elfs` in `android/scripts/fetch-node-android.sh`) should remain
  enabled.
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

# Levix Privacy Policy & Google Play Data Safety

> **Effective date:** 2026-10-31
> **Applies to:** the Levix Android app (`net.leviro.levix`) and the Levix
> self-hosted server distributed from this repository.
> **Product:** Levix, built by Abdelrhman Diab, Leviro.

---

## Plain-language summary

Levix is a **self-hosted** personal WhatsApp bot. The Android app runs the
entire bot **on your device** — there is no Levix cloud, no Levix account, and
no Levix server. The developer does **not** receive any data from your
installation on its own: no analytics, no telemetry, no ads, and no automatic
crash reporting. The only things that ever reach **Leviro Support** (the
developer's support channel) are the ones **you** choose to send: a message in
**Settings → Feedback** (and the optional diagnostics block you can tick on that
form), and a crash report you press Send on in the panel. Nothing is transmitted until you do. A Levix-operated mail
relay delivers a recovery code only when you ask for one. It keeps keyed hashes
for verification, authorization and rate limiting, never the readable address,
code or token, and it does not send the address to the developer.

Data leaves your device while WhatsApp is linked, when a command or AI feature
runs, or when you enable an optional setting or take a panel action. Gemini's
Google Search grounding is enabled by default for Gemini AI requests; Gemini
decides whether to search for each answer.

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
3. **Search and web pages:** Gemini can run Google Search grounding inside
   its request when it decides current information is needed. The AI's
   `web_search` and `search_news` tools send queries to `html.duckduckgo.com`,
   or Google Programmable Search when configured. `search_wikipedia` sends a
   query and matching page titles to `ar.wikipedia.org` or `en.wikipedia.org`.
   `fetch_url` requests the HTTPS page the AI opens from that page's host.
4. **Leviro Support, if you send feedback** — the panel's **Settings → Feedback**
   form sends what you typed (your message, the topic, an optional 1–5 rating,
   an optional contact), one optional file you pick yourself (a screenshot or a
   log, up to 20 MB), plus the Levix version and the platform it runs on. If —
   and only if — you also tick **Attach device & technical diagnostics**, it
   additionally sends the diagnostics listed in section 2a. It travels through
   `levix.leviro.net/api/feedback`. Leviro Support currently receives it through
   Telegram, as a Telegram message, or as a Telegram document when a file is
   attached, so Telegram carries and stores that message. A private Leviro
   Support dashboard is planned to replace the Telegram delivery; this policy
   will change with a new effective date when it does. Nothing
   is attached from WhatsApp — no message, chat, contact, credential or key —
   and nothing is sent unless you press Send.
5. **Leviro Support, if you send a crash report** — a crash or a web error is
   written to a report file inside the app's own data directory, where it stays
   until **you** open the panel and press Send on that one report. Nothing is
   sent automatically and nothing is retried on its own. A report holds the
   error type, a sanitized message and stack, an optional screen id, the app and
   device fields listed in section 2a, and a few navigation breadcrumbs. It goes
   to Leviro Support through `levix.leviro.net/api/crash-reports`, a
   Levix-operated server; it is not forwarded to Telegram or any other service.
6. **The Levix mail relay, if you set a recovery email** — verifying the address
   in **Settings**, or choosing **Email** on **Forgot password**, posts the
   address and UI language (one of `en`, `ar`, `pt-BR`, `es-419`) to
   `levix.leviro.net/api/recovery-email`.
   The relay generates the verification code; confirming it sends the verification
   ID and your code and returns an address-bound recovery token. Password-reset
   requests send the address, locally generated code, token and language. The relay
   sends fixed code messages. It stores only keyed hashes and authorization state,
   never readable addresses, codes or tokens, and does not forward the address to
   the developer. Authorization expires after 365 days without an accepted reset;
   re-verifying the address revokes its previous authorization.
7. **Your own Levix instance, for a sticker** — when you tap **Make sticker** or
   **Add to stickers** on a file in Media Hub, that one file is uploaded to the
   Levix server running on this phone, because that is what does the conversion.
   It goes nowhere else. Browsing Media Hub uploads nothing.
8. **Translation and speech:** `!translate google` sends the text to
   `translation.googleapis.com` with your Google Translation API key, or to
   Google's public `translate.googleapis.com/translate_a/single` endpoint
   without a key. `!tts` and the AI `speak` tool send text to
   `translate.google.com` for speech generation.
9. **Weather, prayer times and short links:** `!weather` sends the city name
   you type to `api.openweathermap.org` when you configured its API key.
   `!prayer` sends the city name you type to `api.aladhan.com`. Levix never
   reads the device's location and requests no location permission; the only
   place information is the city name you type into these two commands. `!shortlink` sends the URL to
   `is.gd`, then to `v.gd` if the first service fails.
10. **Optional page and media fetches:** enabling link previews lets Levix
    request the host of a URL in an outgoing message to build a preview.
    Enabling remote thumbnails lets Levix download a remote media URL from its
    host to build a thumbnail. Both settings are off by default. These requests
    accept public HTTPS URLs only; every redirect is validated, and HTTP,
    credentials in URLs and private/loopback destinations are refused. A refused
    preview does not prevent sending the text message. Actual remote media sends
    use the same validation and the configured remote media size/time limits;
    the downloaded bytes are reused for the send and thumbnail.
11. **Model discovery and domain setup:** when you request live model
    discovery in the panel, the chosen provider's models endpoint receives
    your API key. On a desktop or server, `levix domain` requests
    `api.ipify.org` to check the server's public IP; this command is not part
    of the Android app.

The database, settings, API keys, memory files and control panel are stored in
the app's private storage on Android. An API key also goes to its configured
provider when you use that provider or request live model discovery.

**Backups** (Settings → Backup) are local files created only when you ask. Every
exported backup is encrypted with a password you choose (scrypt and
AES-256-GCM); Levix cannot recover that password.
Levix never uploads a backup to the developer or a cloud service. A backup can
contain bot settings, command setup, API keys, AI persona, conversations,
memory, schedules and their media, group data, roles and stickers. It never
contains WhatsApp pairing credentials, the panel password or session key,
recovery email, the install encryption key, device settings, logs, crash
reports or Android preferences. You control where the exported file is saved;
on Android it goes through the system's save and open pickers. A restore first
shows what it changes and asks you to confirm before it overwrites anything.
It writes only what the backup holds: settings, API keys or a persona the
backup lacks keep their current values, and it never changes the panel
password, the recovery email or the WhatsApp pairing. Conversations, memory and
other account data wait until the same WhatsApp account is linked.

---

## 1. Data stored locally

| Data | Where it lives | Purpose |
| --- | --- | --- |
| WhatsApp pairing credentials | App-private SQLite DB + files | Linking to your WhatsApp account |
| Control-panel password | scrypt hash in the local DB | Logging into the local panel |
| Recovery email and authorization token | Sealed with AES-256-GCM in the local DB (`auth:recovery-email`) | A verified address for the panel's forgot-password email code. The panel shows a mask. Settings export does not include it. Unlink does not remove it |
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
- On Android, the embedded panel listens on a private socket file in app
  storage; only the app's WebView reaches it through the Android host. It does
  not open a TCP port. On desktop, server and Docker installs, the panel
  listens on every interface (`0.0.0.0`) by default unless `bind_address` is
  set. `levix domain` sets that address to `127.0.0.1` behind its reverse
  proxy. Android permits cleartext traffic only for the built-in panel origin;
  external endpoints use HTTPS.

## 2. Data that leaves the device, and to whom

| Recipient | What is sent | When | Why |
| --- | --- | --- | --- |
| **WhatsApp (Meta)** | Your messages, media you send through the bot, your phone number / pairing credentials, group metadata | Continuously while the bot is linked | Levix is a WhatsApp client; this is the product's core function |
| **Your configured AI provider** (Google, OpenAI-compatible server, or Anthropic — chosen by you, using your own API key) | The AI prompt and relevant context, which can include display name, WhatsApp user/phone identifiers, group name, messages, quoted/mentioned participant identifiers, AI history or memory, and supported media/files | Only when you invoke an AI feature (`!gemini`, `!ask`, `!ai`, `!generate`, `!stt`, …) | To generate or process the result you asked for |
| **Google Search grounding within Gemini** | A search Gemini chooses from the prompt already sent to Gemini | When Gemini decides to search during an AI request; `ai_google_search` is on by default for Gemini and can be turned off | Grounding an answer in current information |
| **DuckDuckGo** (`html.duckduckgo.com`) or **Google Programmable Search** (if you configured it) | The search query | When an AI answer uses `web_search` or `search_news`; the latter uses the same search path | Web-grounded answers and news |
| **Wikipedia** (`ar.wikipedia.org` or `en.wikipedia.org`) | The search query and matching page titles requested for summaries | When an AI answer uses `search_wikipedia` | Finding and reading articles |
| **Web pages the AI opens** | HTTPS request for the page to its host | When an AI answer uses `fetch_url` | Reading a page you asked about |
| **Google Cloud Translation** (`translation.googleapis.com`) | Text to translate and the configured Google Translation API key | When you use `!translate google` with a key | Translating text through the official API |
| **Google's public Translate endpoint** (`translate.googleapis.com/translate_a/single`) | Text to translate | When you use `!translate google` without a key | Translating text without an API key |
| **Google TTS** (`translate.google.com`) | Text to speak | When you use `!tts` or the AI uses `speak` | Generating speech |
| **OpenWeatherMap** (`api.openweathermap.org`) | The city name and configured API key | When you use `!weather` with `openweathermap_api_key` set | Getting weather for the named city |
| **Aladhan** (`api.aladhan.com`) | The city name | When you use `!prayer` | Getting prayer times for the named city |
| **URL shorteners** (`is.gd`, then `v.gd` on fallback) | The URL to shorten | When you use `!shortlink` | Creating a short link |
| **Host of a URL in an outgoing message** | Request for the linked page | When `link_previews_enabled` is on and an outgoing message contains a previewable link; off by default | Building a link preview |
| **Host of a remote media URL** | Request to download the media | When `thumbnail_remote` is on and remote media is sent; off by default | Building a thumbnail |
| **Configured AI provider's models endpoint** | The operator's API key | When the operator requests live model discovery in the panel | Listing available models |
| **IP lookup service** (`api.ipify.org`) | An IP lookup request, exposing the server's source IP | When the operator runs `levix domain` on a desktop or server; not an Android flow | Checking the server's public IP |
| **Your configured outbound proxy** (optional, off by default) | WhatsApp traffic only | While linked, if you set a proxy | Routing |
| **Leviro Support** (via `levix.leviro.net/api/feedback`; currently delivered to Leviro Support through **Telegram**, which carries and stores the message) | Only the feedback form's own fields — your message, the topic, an optional rating, an optional contact, an optional file you attach yourself — plus the Levix version, the platform, and the sending app's user-agent. If you tick the diagnostics box, the section 2a diagnostics object and the sanitized technical debug log in section 2b as well | Only when you press Send in **Settings → Feedback** | Support: so a bug you report or a request you make reaches the person who can act on it |
| **Leviro Support** (via `levix.leviro.net/api/crash-reports`, a Levix-operated server) | One crash report: category, sanitized error type/message/stack, an optional screen id, the app + section 2a device fields, the sanitized technical debug log in section 2b, and a few navigation breadcrumbs. Never a phone number, JID, chat/message body or media file | Only when **you** open the panel and press Send on one report; never automatically | Support: so a crash can be grouped and fixed |
| **Levix mail relay** (`levix.leviro.net/api/recovery-email`) | The recovery address and UI language; verification ID and entered verification code on confirmation; address, reset code, recovery token and language on reset. No free text | When you verify an address in **Settings**, or when you choose **Email** on **Forgot password** | To verify address ownership and authorize delivery. Only keyed hashes and authorization state persist, never readable addresses, codes or tokens; the address is not forwarded to the developer |
| **Your own Levix instance** (on Android, reached inside the app through a private socket; never the developer or an AI provider) | The one image, GIF or video you picked in Sticker Studio or the Media Hub, as a single upload | Only when you choose it in Sticker Studio or tap **Make sticker** / **Add to stickers** | Sticker Studio works in the local host, so it has to receive the file you chose |

Apart from feedback and crash reports you deliberately send to Leviro Support,
the developer of Levix is **not** a recipient of any of the above. The recovery-email relay
receives the fixed verification and reset fields described above. It stores only
keyed hashes and authorization state, never readable addresses, codes or tokens. The AI provider's use of the content you send
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
| `levix` | `4.9.0` | the server, always |
| `node` | `v24.19.0` | the server, always |
| `platform` | `android` / `docker` / `node-linux` / `sea-linux` | the server, always |
| `nativeApp` | `4.9.0 (67)` | the Android app |
| `android` | `15 (API 35)` | the Android app |
| `device` | `samsung SM-A556E` | the Android app |
| `abi` | `arm64-v8a` | the Android app |
| `webview` | `131.0.6778.135` | the Android app |
| `screen` | `412x915@2.63` | the panel page |
| `language` | `ar` / `en` / `pt-BR` / `es-419` | the panel page |
| `theme` | `light` / `dark` | the panel page |
| `connectivity` | `wifi` / `cellular` / `ethernet` / `vpn` / `none` / `unknown` | the Android app |
| `memory` | `ok` / `low` / `unknown` | the Android app |
| `storage` | `ok` / `low` / `unknown` | the Android app |

Unknown values are the string `unknown`. A standalone browser has no Android
fields at all; they are simply not sent. Unticking the box means the request
carries no diagnostics key. It never contains your phone number, IMEI, Android
ID, advertising ID, IP address, location, Wi-Fi SSID, contacts, chat or message
text, JIDs, API keys, tokens or passwords. The one extra thing that accompanies
a ticked box is the sanitized technical debug log described in section 2b,
when the preview that froze it is still valid.

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
tokens or passwords are ever included. A Send carries the sanitized
technical debug log the preview froze (section 2b). The report's preview shows
that exact upload — log included — before you press Send. A missing or expired
preview sends the report with no debug log.

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
you press Send on. It is never sent on its own. The preview freezes the exact
string for 15 minutes. Send attaches that frozen copy. A missing or expired
preview attaches no debug log, never a newer one written after the preview.

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
requested. Levix never collects the device's location. The in-app WebView loads only the local control panel
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
- **Feedback you chose to send** — it is a message in Leviro Support's Telegram
  chat, not a record in a Levix database, and the app has no copy of it. Ask
  Leviro Support to delete it (section 9) and it will be deleted from that chat.
- **Crash reports** — an unsent report stays on your device and is deleted
  automatically seven days after it is created (at most the 20 newest are kept);
  you can also delete any report, or all of them, from the panel at any time.
  A report you send is kept on the Levix crash-report server for at most 30 days
  and then deleted; ask Leviro Support to delete a sent one by its report id
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
- The recovery email and its authorization token are sealed together with the
  same install key. The panel and login page show only a mask, never the address
  or token. Settings exports exclude both.
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
This file is the answer map; it does not change the Play Console, and the owner
updates the Console after review.

**Q: Does your app collect or share any of the required user data types?**
→ **Yes**

**Q: Is all of the user data collected by your app encrypted in transit?**
→ **Keep the existing No answer pending the final v5.0.0 transit audit.** The
previous HTTP paths in link previews and remote thumbnails are now blocked,
including redirects from HTTPS to HTTP. Outbound remote media URLs use the same
HTTPS-only boundary. These fixes alone do not establish an app-wide Yes: the
release audit must still examine other clients, redirects and supported local
provider/panel connections. This PR does not change the Play Console answer;
the owner reviews it before publishing v5.0.0.

**Account creation**
→ **My app does not allow users to create an account**

**Can users log in with accounts created outside of the app?**
→ **No**

**Q: Do you provide a way for users to request that their data is deleted?**
→ **No**. Levix has no developer-operated account or cloud copy to delete.
Users can still delete locally stored data with the in-app controls described
in section 4, unlink WhatsApp, or uninstall the app. Remove in Settings deletes
the recovery email and token from the device. The relay retains only keyed
hashes and authorization state subject to expiry, never the readable address.
Feedback a user chose to send is held in Leviro Support's Telegram chat; crash
reports a user chose to send are held for at most 30 days and then deleted. Both
are deleted on request through the contact in section 9.

Declare these data types:

| Data type | Collected? | Shared? | Required? | Purpose |
| --- | --- | --- | --- | --- |
| Personal info → **Name** | Yes | No | Optional | App functionality |
| Personal info → **User IDs / personal identifiers** | Yes | No | Required | App functionality |
| Personal info → **Phone number** | Yes | No | Required | App functionality |
| Personal info → **Email address** | Yes | No | Optional | App functionality, Customer support |
| Location → **Approximate location** | Yes | No | Optional | App functionality |
| Messages → **Other in-app messages** | Yes | No | Optional | App functionality, Customer support |
| Photos and videos → **Photos** | Yes | No | Optional | App functionality, Customer support |
| Photos and videos → **Videos** | Yes | No | Optional | App functionality, Customer support |
| Audio files → **Voice or sound recordings** | Yes | No | Optional | App functionality |
| Audio files → **Other audio files** | Yes | No | Optional | App functionality, Customer support |
| Files and docs → **Files and docs** | Yes | No | Optional | App functionality, Customer support |
| Contacts → **Contacts** | Yes | No | Optional | App functionality |
| App activity → **In-app search history** | Yes | **Yes** | Optional | App functionality |
| App activity → **Other user-generated content** | Yes | **Yes** | Optional | App functionality |
| Web browsing → **Web browsing history** | Yes | **Yes** | Optional | App functionality |
| App info and performance → **Crash logs** | Yes | No | Optional | App functionality, Analytics |
| App info and performance → **Diagnostics** | Yes | No | Optional | App functionality, Analytics |

### How each outbound flow maps to the Data safety definitions

Google Play calls transmission off the device **collection**, including by a
library or SDK and regardless of who receives it. Its end-to-end encryption
exclusion applies only to content unreadable by anyone except sender and
recipient, not to metadata. Processing is **ephemeral** only if the recipient
keeps the data in memory no longer than the real-time request; Levix cannot
show that for any recipient, so no row claims it. **Sharing** means a transfer
of collected user data to a third party. It is not sharing when the transfer is
to a service provider that processes the data on the developer's behalf, when a
user action in the app initiates the transfer and the user reasonably expects
it (the user-initiated exception), when the law requires it, or when the data
is fully anonymized. See [Google Play's definitions](https://support.google.com/googleplay/android-developer/answer/10787469).

The rule applied below: a transfer whose destination the user chose with the
command or setting they used is **user-initiated**. A transfer whose destination
the AI agent or an optional setting chose without the user naming it is
**shared**, so it is declared.

| Flow | Collected? | Shared? | Rule applied |
| --- | --- | --- | --- |
| WhatsApp message and media content | No | No | End-to-end encrypted between WhatsApp users; Levix is the user's own client |
| WhatsApp pairing, phone number, user IDs, names and group metadata | Yes | No | User-initiated: the user links their own WhatsApp account, and Levix works only as that account's client |
| Configured AI provider: prompts, context, supported media | Yes | No | User-initiated: the operator picks the provider and its API key, then invokes an AI command |
| Gemini Google Search grounding | Yes, as part of the Gemini request | No | Same recipient as the Gemini request (Google, the configured provider); on by default and can be turned off with `ai_google_search` |
| AI `web_search` and `search_news` (DuckDuckGo, or Google Programmable Search when configured) | Yes | **Yes** | The AI chooses the search and the query; declared as **In-app search history** shared |
| AI `search_wikipedia` (Arabic or English Wikipedia) | Yes | **Yes** | The AI chooses the lookup; declared as **In-app search history** shared |
| AI `fetch_url` to a page host | Yes | **Yes** | The AI chooses the page; declared as **Web browsing history** shared |
| AI `speak` through Google TTS | Yes | **Yes** | The AI chooses to answer as speech; the spoken text is declared as **Other user-generated content** shared |
| `!tts` through Google TTS | Yes | No | User-initiated: the user asks for speech of the text they gave |
| `!translate google`, with or without a Google key | Yes | No | User-initiated: the command names Google translation; the key is the operator's own credential |
| `!weather` to OpenWeatherMap, `!prayer` to Aladhan | Yes, the typed city | No | User-initiated: the user types a city name for that lookup. Declared as **Approximate location** because a city can describe where the user is; Levix never reads device location |
| `!shortlink` to `is.gd`, then `v.gd` on failure | Yes, the URL | No | User-initiated: the user asks for a short link; both services are named in the command help |
| Optional outgoing link preview | Yes, the linked URL | **Yes** | The page host is chosen by a link, not by the user's request for a preview; declared as **Web browsing history** shared |
| Optional remote thumbnail | Yes, the media URL | **Yes** | The media host receives a download request the user did not name; declared as **Other user-generated content** shared |
| Live model discovery | Yes, the operator's API key | No | User-initiated: the operator asks the configured provider for its models |
| Optional WhatsApp outbound proxy | Yes, WhatsApp traffic | No | User-initiated: the operator sets their own proxy; WhatsApp content stays end-to-end encrypted |
| Feedback to Leviro Support, delivered through Telegram | Yes | No | Service provider: Telegram delivers and stores the message for Leviro Support. Disclosed by name in sections 2 and 4 |
| Crash report to Leviro Support | Yes | No | The developer's own server is the only recipient |
| Recovery email relay | Yes | No | The developer's own relay is the only recipient; it keeps keyed hashes and authorization state only |
| Sticker upload to the Android host | No | No | The WebView reaches the app's private socket on the device; nothing leaves the device |
| Encrypted backup file | No | No | Created and saved on the device where the user chooses; Levix never transmits it |
| `levix domain` IP lookup | Outside the Play form | Outside the Play form | A desktop or server command, not part of the Android app |

For every data type in the declaration table above:

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
- **Sharing purpose:** **App functionality** for the three shared rows (In-app
  search history, Other user-generated content, Web browsing history): the AI
  agent's searches, page reads and spoken answers, and the optional link
  previews and remote thumbnails. Every other row is collected, not shared,
  under the rule above.

The **Email address** declaration covers the optional contact field in the
feedback form and, when you choose it, the recovery address you type in
Settings for panel-password reset. Neither is read from the device. The
feedback contact can be left empty. The recovery address is stored sealed on
the device and is sent to the Levix mail relay only when you verify it or
request a reset code. The relay does not store it beyond rate limiting.

The **Contacts** declaration does not mean Levix requests Android's Contacts
permission. It covers WhatsApp participant identifiers (for example mentioned
or quoted participants) that can be included in an AI request.

The **Approximate location** declaration covers only a city name the user types
into `!weather` or `!prayer`. Levix does not request a location permission and
never reads the device's location, so **Precise location** is not declared.

Do **not** declare precise location, financial info, health/fitness, calendar,
installed apps, or device/other identifiers. Levix contains no analytics,
advertising, or crash-reporting SDK: the **Crash logs** and **Diagnostics** rows
above are the user-initiated reports described in sections 2a and 4, which the
app writes locally and sends only when the user presses Send. There is no
device-following identifier anywhere in them.

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

- In the app: **Settings → Feedback** in the control panel — it reaches Leviro
  Support, and is the fastest route for a bug or a request.
- On the web: [levix.leviro.net/feedback](https://levix.leviro.net/feedback)
- Issues & security reports: [github.com/Abdodiab2005/levix](https://github.com/Abdodiab2005/levix)
- Product: Levix, built by Abdelrhman Diab, Leviro.

# Legal consent contract (Phase 04)

Status: sections 1 to 6 are implemented in PR #126 (04a) and section 7 in PR #127 (04b). Both PRs
are open and not merged, so nothing here ships yet. Section 8 is 04c: client implemented and off,
BLOCKED on the owner's signing key and the `levix-ui` endpoint. Decisions: ADR-006, ADR-019, ADR-020.

## 1. Legal document

One release holds one document per locale (`ar`, `en`, `pt-BR`, `es-419`). Every locale document of
a release has the same `version`. English is the reference text; the others are translations.

```json
{
  "schema": 1,
  "version": "2026-11-02",
  "locale": "en",
  "effective": "2026-11-02",
  "terms":   { "title": "...", "sections": [{ "heading": "...", "paragraphs": ["..."] }] },
  "privacy": { "title": "...", "sections": [{ "heading": "...", "paragraphs": ["..."] }] }
}
```

| Field | Rule |
| --- | --- |
| `schema` | integer `1` |
| `version` | `YYYY-MM-DD` with an optional `.N` (N from 1 to 999); ordered by date, then N |
| `locale` | one of `ar`, `en`, `pt-BR`, `es-419` |
| `effective` | `YYYY-MM-DD` |
| `title`, `heading` | 1 to 160 characters |
| `paragraphs` | 1 to 20 per section, each 1 to 2000 characters |
| `sections` | 1 to 30 per part |
| whole document | at most 65536 bytes as canonical JSON |
| every string | NFC; no control character (U+0000 to U+001F, U+007F to U+009F); no bidi embedding or override (U+202A to U+202E, U+2066 to U+2069); no `://` and no `www.` |
| keys | exactly the keys above; an unknown key fails validation |

Clients render every string as text. A document carries no HTML, no Markdown, no link and no
instruction that the app follows. Links shown next to the documents (the full privacy policy, the
website, the source) come from code (`src/config/brand.cjs` and `src/legal/terms.cjs`).

## 2. Canonical bytes and content hash

Canonical JSON: object keys sorted by JavaScript's default string order, no whitespace, strings and
numbers as `JSON.stringify` writes them, arrays in order. The content hash is the lowercase hex
sha256 of the UTF-8 canonical JSON of one locale document. A change to any field, including the
title of one section in one locale, changes that locale's hash.

## 3. Acceptance record

Stored in `bot_settings` under `legal:acceptance`:

```json
{
  "schema": 1,
  "appVersion": "5.0.0",
  "termsVersion": "2026-11-02",
  "sha256": "<64 lowercase hex>",
  "locale": "en",
  "acceptedAt": "2026-11-02T12:00:00.000Z",
  "via": "panel"
}
```

`appVersion` is the release identity of the build that wrote the record. On npm, Docker, the
single executable and headless it is the `package.json` version (`5.0.0`). On an Android build it
is that version plus the APK `versionCode` (`4.9.2+android.69`), read from `levix-build.json` in
the app archive. The field is still at most 64 characters. It is not a device, account or commit.

`via` is `panel`, `cli` or `provision`. The record has no device, account, user or network
identifier. It is never uploaded. Settings export, backup and restore never carry it. Unlink,
password reset and restarts keep it.

## 4. Consent status

`consentStatus()` returns `{ ok, reason, current, accepted }`. Rules, in order:

| Condition | `ok` | `reason` |
| --- | --- | --- |
| the record or the release identity cannot be read | false | `consent_unreadable` |
| no record, or a record that fails validation | false | `terms_not_accepted` |
| `termsVersion` differs from the current release, the record's locale is no longer in it, or `sha256` differs from the current document for the record's locale | false | `terms_changed` |
| `appVersion` differs from the running release identity | false | `app_updated` |
| otherwise | true | `null` |

The running release identity is the `package.json` version. An Android build appends
`+android.<versionCode>` from `levix-build.json` (`schema` 1, `platform` `"android"`, `versionCode`
the integer the stage script wrote from Gradle's `versionCode`). `app_updated` compares that string with the record. A Play
update that changes only `versionCode` asks again. A build file that is present but cannot be read
or parsed makes `consentStatus()` return `consent_unreadable`, and `recordAcceptance()` throws
without writing.

Two builds with the same `package.json` version and no `versionCode` share one identity, for
example a source checkout at different commits or a rebuilt Docker image. Official releases always bump
`package.json`; `.github/workflows/release.yml` refuses a tag that differs from it or from Android
`versionName`.

The current release is the bundled release in 04a and 04b. From 04c it is the newest of the bundled
release and a verified cached remote release.

## 5. Session states

```
idle/disconnected/... --start or retry--> #open()
                                           |
                    consent ok? -- no --> consent_required --(record becomes valid)--> #open()
                        |                      |
                       yes                  stop / logout / shutdown --> idle / logged_out
                        |
                  existing socket path (starting, waiting_for_qr, ...)
```

- `consent_required` is entered only from `#open()`, before the offline check and before any socket.
  The QR row is cleared; pairing credentials are not touched.
- `getState()` reports `state: "consent_required"`, `reason` from section 4, `consentRequired: true`,
  `canStart: true`.
- While in `consent_required`, the session re-reads the record every 5 seconds and calls
  `start({ reason: "consent_accepted" })` when it is valid. `recheckConsent()` does the same check
  at once. `stop()`, `logout()`, `shutdown()` and leaving the state cancel the timer.
- A connected socket is never closed because consent became invalid (Q-05). The next `#open()`
  checks again.

## 6. Command line

| Command | Behaviour | Exit |
| --- | --- | --- |
| `levix terms` | prints both documents, the version, the hash and the links, then asks the operator to type `accept`; records `via: "cli"`. Refuses when stdin or stdout is not a terminal. | 0 accepted; 1 cancelled or refused |
| `levix terms show [--lang <locale>]` | prints both documents, the version, the hash and the links. Writes nothing. | 0; 1 unknown locale |
| `levix terms status` | prints whether this installation has a valid acceptance and why not. | 0 valid; 2 required |
| `levix terms accept --terms-version <v> --sha256 <hash> [--lang <locale>]` | records `via: "provision"` only when both values equal the current document for the locale (default `en`). | 0 recorded; 1 mismatch or missing value |
| `levix terms revoke` | deletes the record. A live connection stays up; the next start asks again. | 0 |

All of them use the same lock and schema rule as `levix reset-password`: with Levix running they
write only when the database already has this build's schema. A running Levix picks up an
acceptance within 5 seconds. No start flag and no environment variable can accept.

## 7. Panel API (04b, PR #127)

- `GET /dashboard/api/legal/terms?locale=<locale>`: panel session required. Returns the current
  document for the locale (falling back to `en`), its `version`, `sha256`, the code-owned links and
  the consent status.
- `POST /dashboard/api/legal/accept` with `{ version, sha256, locale }`: panel session and the
  existing same-origin check required. Records `via: "panel"` only when the values equal the
  current document; otherwise `409 TERMS_CHANGED` with the current document. Then calls
  `session.recheckConsent()`.

## 8. Remote release (PLANNED, 04c, BLOCKED)

- Endpoint: `GET https://levix.leviro.net/api/legal/v1/<locale>` (to be created in `levix-ui`).
- Response: `200`, `content-type: application/json`, at most 131072 bytes:
  `{ "keyId": "<id>", "payload": "<base64 canonical document bytes>", "signature": "<base64 Ed25519 signature of the payload bytes>" }`.
- Client rules: HTTPS only, no redirects, 5 second timeout, no cookie, no query string, no
  identifier in headers. Verify the signature with the bundled public key named by `keyId`; decode
  the payload; require it to be canonical, valid under section 1 and for the requested locale;
  ignore a version older than the bundled or cached one. Cache verified releases in the data
  directory. A failure keeps the previous release and never blocks a start.
- The fetch never runs on the start path. It runs in the background after boot and once a day.
- The private key stays with the owner, outside every repository and artifact.

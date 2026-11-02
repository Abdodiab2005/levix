# Legal consent contract (Phase 04)

Status: sections 1 to 6 are the 04a contract (PENDING REVIEW until 04a merges). Section 7 is
`PLANNED` for 04b. Section 8 is implemented and off, BLOCKED on the owner's signing key and the
`levix-ui` endpoint. Decisions: ADR-006, ADR-019, ADR-020.

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

`via` is `panel`, `cli` or `provision`. The record has no device, account, user or network
identifier. It is never uploaded. Settings export, backup and restore never carry it. Unlink,
password reset and restarts keep it.

## 4. Consent status

`consentStatus()` returns `{ ok, reason, current, accepted }`. Rules, in order:

| Condition | `ok` | `reason` |
| --- | --- | --- |
| the record cannot be read (database error) | false | `consent_unreadable` |
| no record, or a record that fails validation | false | `terms_not_accepted` |
| `termsVersion` differs from the current release, the record's locale is no longer in it, or `sha256` differs from the current document for the record's locale | false | `terms_changed` |
| `appVersion` differs from the running `package.json` version | false | `app_updated` |
| otherwise | true | `null` |

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

## 7. Panel API (PLANNED, 04b)

- `GET /dashboard/api/legal/terms?locale=<locale>`: panel session required. Returns the current
  document for the locale (falling back to `en`), its `version`, `sha256`, the code-owned links and
  the consent status.
- `POST /dashboard/api/legal/accept` with `{ version, sha256, locale }`: panel session and the
  existing same-origin check required. Records `via: "panel"` only when the values equal the
  current document; otherwise `409 TERMS_CHANGED` with the current document. Then calls
  `session.recheckConsent()`.

## 8. Remote release (implemented, off, BLOCKED)

The client in `src/legal/remote.cjs` is implemented and shipped off. `TRUSTED_KEYS` in
`src/legal/keys.cjs` is empty, so the schedule does nothing and no request is made. BLOCKED on the
owner's signing key and on the `levix-ui` endpoint below. The private key never enters this
repository, CI logs, the npm tarball, Docker images or app bundles.

One release is signed as one unit, so every locale carries the same version. This replaces the
per-locale URL from the earlier draft of this section.

### Endpoint

`GET https://levix.leviro.net/api/legal/v1/release`

No query string. The client sends one header, `accept: application/json`. No cookie, no body, no
account or device identifier.

### Release

```json
{ "schema": 1, "version": "2026-11-02", "documents": { "en": { } } }
```

Keys exactly `schema`, `version`, `documents`. Every value in `documents` passes section 1. Its
`locale` equals its key, its `version` equals the release `version`, `en` is present, and every
key is one of `ar`, `en`, `pt-BR`, `es-419`.

### Envelope

The HTTP body and the cache file are the envelope. Keys exactly `keyId`, `payload`, `signature`:

```json
{
  "keyId": "<first 16 hex chars of sha256 of the raw 32-byte public key>",
  "payload": "<base64 of the UTF-8 canonical JSON of the release>",
  "signature": "<base64 Ed25519 signature over those payload bytes>"
}
```

Base64 is strict: alphabet `A-Za-z0-9+/` with padding, and decoding then re-encoding equals the
input. The public key stored in the app is the base64 raw 32-byte key. The `KeyObject` is the SPKI
DER prefix `302a300506032b6570032100` plus those 32 bytes.

### Verification order

Any failure is a typed error (`LegalReleaseError` or `LegalKeyError`). Nothing is cached.

1. Envelope shape: an object with exactly `keyId`, `payload` and `signature`. `keyId` is 16
   lowercase hex characters. `payload` and `signature` are strings.
2. `keyId` is in the trusted list, once. The entry is `{ keyId, publicKey }`, and `keyId` equals
   the id derived from that public key.
3. `payload` and `signature` decode as strict base64.
4. `crypto.verify(null, payloadBytes, publicKey, signatureBytes)` is true.
5. The payload is valid UTF-8 JSON.
6. `canonicalJson` of that value, encoded as UTF-8, byte-equals the payload.
7. The release validates (the rules above, and section 1 for every document).

A release older than the bundled one, or older than the newest verified cached one, is ignored.
Equal versions keep the bundled release.

### Cache

`dataPath("legal", "remote-release.json")` stores the envelope bytes as received. The write is a
temp file in that directory, an fsync, then a rename. On load the cache is verified again with the
keys the process is using. A cache that fails verification is ignored and left on disk. It is never
trusted. A cache read error falls back to the bundled release. A broken bundle still fails closed.

`currentRelease()` returns the newer of the bundled release and that verified cache.
`documentFor().source` is `bundled` or `remote`. `invalidate()` drops the memo. A refresh that
stores a newer release calls it.

### Schedule

`startRemoteTermsSchedule()` runs from `src/bootstrap/core.js` after the session is built.
`stop()` runs from process shutdown in `src/index.js`, next to the session timer shutdown. When
`TRUSTED_KEYS` is empty the schedule is a no-op and its stop function does nothing.

Otherwise the first refresh is 60 seconds after boot and then every 24 hours. The timers are
`unref()`ed. Boot does not await the refresh. The refresh is not on the session start path and
does not run inside `consentStatus()` or `recordAcceptance()`. `refreshRemoteRelease()` never
throws. It returns `{ updated, version, error }` and logs through `src/utils/logger.cjs` without
the payload or the document text.

### Limits

HTTPS only. A non-`https:` URL, a URL with a query, a hash or credentials is refused before any
request. `redirect: "manual"`, and any 3xx or opaque redirect is a failure. Timeout 5 seconds
(`AbortSignal.timeout(5000)`, forwarded onto the request so a too-large body can abort it too).
That signal does not keep the event loop alive, so the same deadline also arms a ref'd timer that
is cleared when the request ends. The 60s and 24h schedule timers stay `unref()`ed. Status must be
200. `content-type` must start with `application/json`. The body is read as a stream and aborted
once it exceeds 393216 bytes. The request has no cookie, no query string and no body.

A Leviro outage never blocks an acceptance or a start. With no verified cache, the bundled release
stays current and acceptable.

### Turning the client on

The owner does all of this. Until then the client stays off.

1. Generate the key outside this repository:
   `node scripts/legal-release.mjs keygen --out <path>`. The command refuses a path inside the git
   work tree and refuses to overwrite a file. It writes a PKCS#8 PEM with mode `0600` and prints
   `keyId` and the base64 public key. The private key stays with the owner.
2. Add `{ keyId, publicKey }` to `TRUSTED_KEYS` in `src/legal/keys.cjs` and ship that build. A bad
   entry throws when the module loads.
3. Sign and publish:
   `node scripts/legal-release.mjs sign --key <path> --out <envelope.json>` (default document
   directory `src/legal/bundled`). The command verifies the envelope with the derived public key
   before writing. Publish that JSON as the body of
   `GET https://levix.leviro.net/api/legal/v1/release` on `levix-ui`.
4. Update `PRIVACY.md`: add a row for this fetch (host `levix.leviro.net`, path
   `/api/legal/v1/release`, HTTPS, no cookie, no account or device identifier, signed Terms and
   Privacy text only) and publish a new Privacy Notice version that names the fetch. That notice
   change is a new Terms release.

`node scripts/legal-release.mjs public-key --key <path>` prints the id and the public key again.
The script is an owner tool. CI does not run it.

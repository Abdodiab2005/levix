# Levix backup format, version 1

Status: ACCEPTED on 2026-10-31 with the owner's decisions Q-10, Q-14, Q-22, Q-24, Q-25 and Q-26
(`OPEN_QUESTIONS.md`, ADR-016). PR 02a implements the file format, PR 02d writes backups, PR 02e
restores them and PR 02f activates restored account data. Nothing reads or writes this format before PR 02a merges.

## 1. Rules

- Every exported backup is encrypted with a password that the operator types when creating it.
  Levix has no unencrypted export and no key escrow. A lost password makes the file unreadable.
- A backup holds the bot settings, the command table, the AI and third-party API keys, the AI
  persona, AI memory, AI conversations, schedules, stickers and the other bot data in section 7.
- A backup never holds the WhatsApp pairing credentials, the panel password hash, the panel session
  key, panel sessions, the recovery email, `levix.key`, Android preferences or other device data.
- Backup and restore run from the control panel and the Android app only. There is no CLI command
  and no WhatsApp command (Q-14).
- The file leaves the device only when the operator downloads it (panel) or saves it (Android).

## 2. File layout

File name: `levix-backup-<UTC yyyymmdd-hhmmss>.levixbak`.

```
magic    8 bytes      "LEVIXBAK"
hlen     4 bytes      header length, unsigned big endian, 1 to 4,096
header   hlen bytes   UTF-8 JSON, cleartext
hmac     32 bytes     HMAC-SHA256(mac key, magic || hlen || header)
chunks   rest         AES-256-GCM chunk stream of the payload (section 5)
```

## 3. Header

```json
{
  "format": "levix-backup",
  "version": 1,
  "cipher": "aes-256-gcm",
  "chunk": 65536,
  "kdf": { "name": "scrypt", "N": 131072, "r": 8, "p": 1, "salt": "<base64 of 32 random bytes>" }
}
```

The header holds no date, app version, count or account. Those sit in the encrypted manifest, so a
file without its password shows only that it is a Levix backup.

A reader checks the header before it derives anything. It refuses an unknown field, `version`
other than 1, `chunk` other than 65,536, `r` other than 8, `p` other than 1, a salt that is not 32
bytes, and an `N` that is not a power of two from 2^15 to 2^18. scrypt needs `128 * N * r` bytes:
128 MiB at the default `N` of 2^17 and 256 MiB at the cap. Levix passes that value plus 1 MiB as
`maxmem`, because Node's default `maxmem` is 32 MiB. One key derivation runs at a time per process.
Memory and time on an ARMv7 device: NOT VERIFIED until the Android smoke test in PR 02h.

## 4. Keys and password

`k = scrypt(password, salt, 64 bytes, N, r, p)`. `k[0..32]` is the AES-256-GCM key and `k[32..64]`
is the HMAC-SHA256 key.

The password is the operator's text normalized to Unicode NFC, 12 to 1,024 code points, at most
4,096 UTF-8 bytes. Levix does not trim it.

A reader compares the header HMAC in constant time before it opens any chunk. A mismatch means a
wrong password or a changed header, and the reader reports `WRONG_PASSWORD` without writing
anything.

## 5. Chunk stream

The payload is cut into chunks of 65,536 plaintext bytes. The last chunk holds 1 to 65,536 bytes.
Each chunk is written as its ciphertext followed by the 16-byte GCM tag.

- Key: `k[0..32]`.
- Nonce (12 bytes): the chunk index as 11 bytes big endian, starting at 0, then 1 byte that is 1
  for the last chunk and 0 for every other chunk.
- Additional data: the 32-byte header HMAC.

A reader treats a chunk as the last one only when the file ends right after it, and opens it with
the final byte set to 1. A file truncated at a chunk boundary, a dropped, repeated or reordered
chunk, any byte after the last chunk, and a changed header therefore all fail authentication with
`DAMAGED`. A file is at most 16 GiB.

## 6. Payload

The payload is one gzip member of:

```
magic      8 bytes    "LEVIXPL1"
mlen       4 bytes    manifest length, unsigned big endian, at most 8 MiB
manifest   mlen bytes UTF-8 JSON
data       the bytes of every manifest entry, in manifest order, back to back
end        8 bytes    "LEVIXEND"
```

Nothing may follow `end`. A reader stops inflating as soon as the output passes
`20 + mlen + (sum of entry sizes)` bytes, which bounds a decompression bomb.

### 6.1 Manifest

```json
{
  "format": "levix-backup-manifest",
  "version": 1,
  "created": "2026-10-31T12:00:00.000Z",
  "app": "5.0.0",
  "schema": 1,
  "platform": "android-arm64",
  "account": { "lid": "123456789012345@lid", "pn": "201000000000@s.whatsapp.net" },
  "apiKeys": ["gemini_api_key", "openai_api_key", "whatsapp_proxy_password"],
  "counts": { "settings": 41, "apiKeys": 3, "schedules": 2, "groups": 3, "roles": 2,
              "conversations": 12, "memoryFiles": 4, "stickers": 120, "packs": 5 },
  "digests": { "settings": { "setting:bot_language": "<hex>", "prefix": "<hex>" },
               "apiKeys": { "gemini_api_key": "<hex>" } },
  "entries": [
    { "path": "db/levix.db", "kind": "db", "size": 1048576, "sha256": "<hex>" },
    { "path": "secrets.json", "kind": "secrets", "size": 312, "sha256": "<hex>" },
    { "path": "persona.md", "kind": "persona", "size": 2048, "sha256": "<hex>" },
    { "path": "memory/global.md", "kind": "memory", "size": 900, "sha256": "<hex>" },
    { "path": "stickers/ab/ab12...ef.webp", "kind": "sticker", "size": 40213, "sha256": "<hex>" },
    { "path": "media/schedules/<id>", "kind": "schedule-media", "size": 81234, "sha256": "<hex>" }
  ]
}
```

`apiKeys` lists the names (never the values) of the secret settings in `secrets.json`, so the
preview can show them; each name is a key of `SECRET_SETTING_KEYS`.

`digests` (optional) holds the sha256 of every restorable `bot_settings` row value as stored
(`setting:<key>` and the command-table keys) and of every plain API key value in `secrets.json`.
The restore preview compares them with this install's values to list what is added, replaced,
unchanged or kept. The keys of `digests.apiKeys` must equal `apiKeys`. The digests sit inside the
encrypted payload and never leave the server: the preview returns names only. A file without
`digests` (made by a build before the field existed) is still valid; its preview cannot list the
setting changes and is treated as destructive.

`account` names the WhatsApp account that was paired when the backup was made: its LID and its
phone-number JID, either of which may be null. It is null when the install was not paired, and then
the backup holds no account data (section 7).

Entry rules a reader enforces:

- Exactly one `db` entry. At most one `secrets` entry and one `persona` entry.
- Paths are relative and `/`-separated. Each segment matches `[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}`.
  No `..`, no empty segment, at most 4 segments, unique when compared ignoring case.
- `kind` fixes the allowed path: `db/levix.db`, `secrets.json`, `persona.md`, `memory/...`,
  `stickers/<2 hex>/<64 hex>.webp` or `.thumb.webp`, `media/schedules/<id>`.
- At most 200,000 entries. The `db` entry is at most 4 GiB and any other entry at most 64 MiB.
  The sum of sizes is at most 16 GiB.
- Each entry's bytes match its `size` and `sha256`.

### 6.2 `secrets.json`

```json
{ "settings": { "gemini_api_key": "<plain value>", "whatsapp_proxy_password": "<plain value>" } }
```

It holds only the keys in `SECRET_SETTING_KEYS` (`src/config/settings.cjs`) that have a value. The
values are plain text inside the encrypted payload. A restore seals them again with the target
install's `levix.key`, so the source key never leaves its device.

## 7. Content

| Item | Restore group | Notes |
| --- | --- | --- |
| `bot_settings` rows `setting:<key>` for every key in `SETTING_KEYS` except the seven secret keys and the six device keys | settings | The seven secret keys travel in `secrets.json`. |
| `bot_settings` rows `prefix`, `command_permissions`, `command_aliases`, `disabled_commands` | settings | The command table: prefix, permissions, aliases, disabled commands. |
| `ai-persona.md` | settings | The operator's persona. |
| `user_metadata`, `lid_mapping`, `group_directory`, `group_settings`, `warnings`, `todos`, `notes`, `debts`, `ai_history`, `schedules`, `moderation_flags`, `auto_delete_rules`, `auto_delete_log`, `sticker_owners`, `stickers`, `sticker_packs`, `sticker_pack_items` | account | Roles, conversations, schedules, group configuration, moderation state and stickers of one WhatsApp account. |
| `memory/` (from the active memory root), `stickers/`, `media/schedules/` | account | Restored into `<data>/memory` (Q-25), `<data>/stickers` and `<data>/media/schedules`. |
| Device keys `port`, `bind_address`, `trust_proxy`, `public_domain`, `dashboard_origin`, `ffmpeg_path` | never | They bind the panel and FFmpeg to one machine. The target keeps its own. |
| `auth:password`, `auth:recovery-email`, `secret:session`, any `bot_settings` key not listed above | never | Panel authentication stays with the install (Q-22). Unknown keys are dropped, so a future secret cannot leak. |
| `baileys_auth`, `qr_codes` | never | WhatsApp pairing. The operator pairs manually after a restore. |
| `moderation_applied`, `forward_scores` | never | Short-lived; rebuilt or expired. |
| `levix.key`, lock and socket files, `tmp/`, other `media/`, logs, debug logs, crash reports, Android preferences | never | Device data (Q-10). |

Tables are an allowlist. Backup creation fails on a table that this list does not classify, so a
table added later cannot leak until someone classifies it.

The database copy is made in this order: `src/db/copy.cjs` writes a filtered copy of the live
database into a private temporary folder `<data>/tmp/backup/<id>/` (mode 0700) in one synchronous
step, while the referenced files are hard-linked or copied, so rows and files match. It creates the
schema in the new file and copies only the allowed rows from the live database. Rows this section
excludes, unknown `bot_settings` keys, secret settings, and the account tables when no account is
paired are never written, so no second `VACUUM` is needed. Then `PRAGMA integrity_check`, a scan for
every value that must never travel (the sealed secret-setting rows, the panel password hash, the
recovery email record, the session key and the pairing credentials), and only then the archive. The
API key values are held in memory and written only inside the encrypted archive (`secrets.json`), so
they are not in the temporary folder at all. The temporary folder is deleted, and a folder left by a
crash holds no secret material and is swept when the panel starts.

### 7.1 Pre-migration copy

Before a pending migration, the start path writes a second kind of copy. It is not a backup: it never
leaves `<data>/backups/pre-migration/`, the panel never offers it for download, and the operator
cannot restore it from the UI.

- File: `<data>/backups/pre-migration/levix-v<from>-<stamp>.db`, file mode 0600, folder mode 0700.
  The newest two files are kept.
- Content: every table and every row except the secret material. That means no WhatsApp pairing
  (`baileys_auth`, `qr_codes`), no panel password hash (`auth:password`), no recovery email record
  (`auth:recovery-email`), no panel session key (`secret:session`), and no API key or proxy password
  (`setting:<key>` for every secret setting). The pairing tables exist in the copy with no rows.
- Writer: `src/db/copy.cjs` creates the schema in a new file and copies only the allowed rows from the
  live database in one read transaction. No secret row reaches the copy, its journal or a temporary
  file.
- Write order: a `.part` file, then verification (`PRAGMA integrity_check`, `user_version`, row
  counts, no secret rows), then `fsync`, then rename. A crash leaves no file under a final name, and
  the next start deletes stale `.part` files.
- Rollback: with Levix stopped, copy the chosen file over `levix.db`, delete `levix.db-wal` and
  `levix.db-shm`, then start the previous build. The install then has no pairing and no panel
  password, so `/setup` asks for a new one, and the operator pairs WhatsApp by hand. The steps are in
  `MIGRATION.md` section 5. A failed migration needs no rollback, because all pending migrations run
  in one transaction.

## 8. Restore

1. The operator signs in to the panel. A new install first goes through the normal setup and
   chooses its own panel password; a restore never changes the panel password.
2. The file is uploaded into `<data>/tmp/restore/` (16 GiB cap, free space checked first).
3. Preview needs the backup password. Levix opens the header and the manifest only and shows the
   creation date, app version, schema, platform, counts, the names (never the values) of the API
   keys, the account as a masked phone number, and whether the paired account matches. It also
   shows the restore plan (`src/backup/plan.cjs`): which settings, command-table keys and API keys
   are added, replaced, unchanged, or kept because the backup does not hold them; whether the
   persona is added, replaced, unchanged or kept; whether the account data would replace this
   install's current data for the same account; and whether it would remove account data still
   waiting from an earlier restore. A plan with any replacement or removal is destructive.
4. Levix refuses a file with `version` other than 1, a `schema` newer than the running build, a
   wrong password or any damage.
5. Confirming needs the panel password, and a destructive plan also needs the operator to tick
   the confirmation (`confirmDestructive: true`). A background job decrypts and checks every chunk and entry
   into `<data>/restore/<id>/staged/`, runs `PRAGMA integrity_check` on the database copy and
   migrates the copy to the running schema with the normal migrations. The `secrets.json` entry is
   decrypted into memory only, at most 1 MiB, and is never written into the staged folder. Live data
   is untouched until all of this passes. The job then builds the plan again from the staged rows
   and the decrypted keys, so a manifest cannot hide a change, and stops with `CONFIRM_REQUIRED`
   before changing anything when that plan is destructive and the request did not confirm it.
6. The settings group is applied in one SQLite transaction on the live database. Only what the
   backup holds is written: each restorable `bot_settings` row in the backup is added or replaces
   the current one, and each API key in `secrets.json` replaces the current key. A setting or API
   key the backup does not hold keeps its current value. A command-table key in the backup
   (`prefix`, `command_permissions`, `command_aliases`, `disabled_commands`) replaces that whole
   entry; one the backup lacks stays. The target keeps its device keys, panel authentication rows,
   session key and pairing. The API keys are sealed with the target's `levix.key` inside that
   transaction. `ai-persona.md` is replaced atomically only when the backup holds a persona; a
   backup without one leaves the current persona as it is. The new values take effect like a settings import. If
   Levix stops before that transaction commits, recovery discards the staged restore and the
   operator runs the restore again with the backup password. After the commit the keys are already
   sealed in `levix.db`. No file in the data directory holds a plaintext secret at any moment.
7. The account group moves to `<data>/restore/pending/` with the account identity. It activates
   only when the paired WhatsApp account matches the backup's account (Q-24):
   - Match rule: when both sides know a LID, the LIDs must be equal. The phone-number JIDs decide
     only when the backup has no LID. A recycled phone number has a new LID, so it never matches.
   - When the install is already paired with that account, the session reconnects after the restore
     and the data activates on that connection. Otherwise it activates on the first connection of a
     matching account after the operator pairs WhatsApp manually.
   - Activation migrates the pending copy to the running schema, moves the memory, sticker and
     schedule-media folders into place and replaces the account tables in one SQLite transaction,
     before the connection seeds roles or starts schedules.
   - A different account never activates the data. The panel shows it as waiting for the masked
     account, with a Discard action. Unlink does not delete it. A later restore replaces it.
8. Every step writes `<data>/restore/journal.json` (temporary file, `fsync`, rename) before it
   changes anything. At the next start, under the instance lock and before the runtime loads,
   recovery finishes or undoes an interrupted step. Replaced live folders wait in
   `<data>/restore/<id>/previous/` until their step completes.

## 9. Errors

| Code | Meaning |
| --- | --- |
| `NOT_A_BACKUP` | The magic bytes are missing. |
| `UNSUPPORTED_VERSION` | `version` or the manifest version is not 1. |
| `BAD_HEADER` | The header breaks a rule in section 3. |
| `KDF_LIMIT` | The scrypt parameters are outside the allowed range. |
| `WRONG_PASSWORD` | The header HMAC does not match. |
| `DAMAGED` | A chunk fails authentication, the file is truncated, or bytes follow the last chunk or `end`. |
| `BAD_MANIFEST` | The manifest breaks a rule in section 6.1. |
| `LIMIT` | A size, count or inflation limit is exceeded. |
| `SCHEMA_NEWER` | The backup's schema is newer than the running build. |
| `NO_SPACE` | Free disk space is below what staging needs. |
| `BUSY` | Another backup, restore or key derivation is running. |

No error message or log line contains a password, an API key or a manifest account identity.

## 10. Not supported

- Moving a WhatsApp session between devices. The operator pairs manually after a restore.
- Android preferences (host state, onboarding, Media Hub choices, theme) (Q-10).
- A CLI or WhatsApp command for backup or restore (Q-14). A headless install without a panel
  cannot create or restore a backup in v5.

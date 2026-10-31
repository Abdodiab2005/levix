# Levix backup format, version 1 (PROPOSED)

Status: PROPOSED in Phase 02. It becomes ACCEPTED with PR 02a after the owner decides Q-10, Q-14,
Q-22, Q-24 and Q-25 (`PHASE-02-RESULTS.md` section 5). Until then nothing writes or reads it.

## 1. File

One file, `levix-backup-<UTC yyyymmdd-hhmmss>.levixbak`, written by Levix itself. Layout:

```
magic        8 bytes   "LEVIXBAK"
header_len   4 bytes   unsigned, big endian, at most 65,536
header       JSON      UTF-8, header_len bytes, cleartext, never a secret
payload      bytes     gzip(tar), or the encrypted chunk stream of gzip(tar)
```

## 2. Header (cleartext)

```json
{
  "format": "levix-backup",
  "version": 1,
  "created": "2026-10-31T00:00:00Z",
  "app": "levix-bot 5.0.0",
  "schema": 10,
  "platform": "linux-x64 | android-arm64 | ...",
  "secrets": false,
  "encryption": null,
  "counts": { "settings": 41, "groups": 3, "schedules": 2, "stickers": 120, "memoryFiles": 4 },
  "payloadBytes": 123456
}
```

The header never names the account. Account identity sits in `manifest.json`: a random 32-byte
salt and `HMAC-SHA256(salt, paired LID)`, compared after decryption or against the target's own
paired LID (Q-24).

With `"secrets": true`, `encryption` is:

```json
{ "cipher": "aes-256-gcm", "chunk": 65536,
  "kdf": "scrypt", "N": 131072, "r": 8, "p": 1, "salt": "<base64, 16 bytes>",
  "nonce": "<base64, 8-byte prefix>" }
```

A reader computes the scrypt memory (`128 * N * r` bytes) and work (`N * r * p`) before it
allocates anything and refuses more than 256 MiB of memory or more than 2^21 of work, a chunk size
other than 65,536, and any unknown field value. scrypt runs with an explicit `maxmem` equal to the
computed memory plus a margin (Node's default `maxmem` of 32 MiB is too small for the default
`N`). Memory and time for the default on an ARMv7 device: NOT VERIFIED; Phase 02 measures them
before this section is ACCEPTED.

## 3. Encrypted payload

The gzip stream is cut into records of at most 65,536 plaintext bytes. Record `i` is written as

```
length   4 bytes, big endian: plaintext length (0 to 65,536)
final    1 byte: 1 for the last record, 0 otherwise
cipher   length bytes
tag      16 bytes
```

sealed with AES-256-GCM under the scrypt key, nonce `prefix (8 bytes) || i (4 bytes, big endian)`,
and additional data `"LEVIXBAK v1" || sha256(header bytes) || i (8 bytes) || final || length`.
Indices start at 0 and increase by one. Exactly one record has `final = 1`, it is the last one,
and it may be empty. A reader rejects a missing final record, any byte after it, a record longer
than 65,536, and any failed tag, so truncation, reordering, a dropped or extra record, a changed
frame or a changed header all fail. A wrong passphrase fails on record 0, before anything is
written. The 16 GiB cap keeps `i` far below 2^32.

## 4. Payload

A POSIX tar, gzip-compressed, entries in this order:

1. `manifest.json`: every entry's path, size, mode and sha256; the database's `user_version`,
   page count and `integrity_check` result; the inclusion choices; the list of excluded categories.
2. `db/levix.db`: the snapshot, filtered for a default backup (`PHASE-02-RESULTS.md` section 2).
3. `files/ai-persona.md`, `files/memory/...`, `files/media/schedules/<id>`,
   `files/stickers/<xx>/<sha>.webp` (and `.thumb.webp`).
4. `secrets/levix.key`, only in an encrypted backup.

Only regular files and directories. No links, no device files, no absolute paths, no `..`, no
duplicate names. Limits a reader enforces: manifest at most 8 MiB; at most 500,000 entries; each
entry's size equal to the manifest; total uncompressed bytes at most the manifest total, and at most
16 GiB; gzip expansion stops at the manifest total plus the tar overhead.

## 5. Restore rules

- `version` above 1 or `schema` above the running build's migration count: refused.
- An older `schema` restores and then migrates through the normal start order, which first writes a
  verified pre-migration backup (ADR-016).
- A default backup keeps the target's secrets (Q-22). The account set (every WhatsApp-derived
  table, the memory root, schedule media and sticker files) restores only when the account identity
  in the manifest matches the target's paired account (Q-24); otherwise the whole set is left out
  and the preview lists it.
- WhatsApp pairing moves to another device only from an encrypted backup with `levix.key`, and the
  preview says that WhatsApp may still require a new pairing; cross-device session migration is not
  claimed as supported.

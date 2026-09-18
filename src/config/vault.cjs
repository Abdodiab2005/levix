// Data-at-rest encryption for high-value secrets.
//
// The WhatsApp session (baileys_auth) and operator API keys must not sit in
// levix.db as plaintext. A 32-byte AES-256-GCM key is generated on first use
// and stored as `levix.key` in the data directory (mode 0600), never in the
// database — a leaked .db backup is not enough to recover the session or keys.
//
// On Android that directory is already the app-private files dir
// (`/data/data/net.leviro.levix/files/data`). On a desktop install it is the
// same folder as the database. Root on the device can still read both files;
// this stops a copied database, a partial backup, or a casual file dump.
//
// Format: enc:v1:<iv_hex>.<tag_hex>.<ciphertext_hex>
// Unsealed legacy values pass through `open()` so upgrades re-encrypt on write.

const crypto = require("node:crypto");
const fs = require("node:fs");

const logger = require("../utils/logger.cjs");

const PREFIX = "enc:v1:";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const KEY_FILE = "levix.key";

let cachedKey = null;

function keyPath() {
  const { dataPath, ensureDataDir } = require("./paths.cjs");
  ensureDataDir();
  return dataPath(KEY_FILE);
}

function loadMasterKey() {
  if (cachedKey) return cachedKey;
  const file = keyPath();
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file);
    if (raw.length === KEY_BYTES) {
      cachedKey = raw;
      return cachedKey;
    }
    const hex = raw.toString("utf8").trim();
    if (/^[0-9a-f]{64}$/i.test(hex)) {
      cachedKey = Buffer.from(hex, "hex");
      return cachedKey;
    }
    throw new Error("levix.key is not a valid 32-byte encryption key");
  }

  const key = crypto.randomBytes(KEY_BYTES);
  fs.writeFileSync(file, key, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows has no POSIX modes; the data directory still holds the file.
  }
  logger.info("[vault] Generated a new data-at-rest encryption key");
  cachedKey = key;
  return cachedKey;
}

function isSealed(value) {
  return typeof value === "string" && value.startsWith(PREFIX);
}

function seal(plaintext) {
  const text = plaintext == null ? "" : String(plaintext);
  const key = loadMasterKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("hex")}.${tag.toString("hex")}.${encrypted.toString("hex")}`;
}

function open(value) {
  if (value == null) return value;
  if (!isSealed(value)) return value;
  const body = value.slice(PREFIX.length);
  const parts = body.split(".");
  if (parts.length !== 3) throw new Error("Malformed sealed secret");
  const [ivHex, tagHex, dataHex] = parts;
  const key = loadMasterKey();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataHex, "hex")),
    decipher.final(),
  ]).toString("utf8");
}

/** Reset the in-process key cache. Tests that switch data dirs need this. */
function resetVaultCache() {
  cachedKey = null;
}

module.exports = {
  PREFIX,
  KEY_FILE,
  isSealed,
  seal,
  open,
  loadMasterKey,
  keyPath,
  resetVaultCache,
};

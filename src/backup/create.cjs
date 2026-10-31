const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { db } = require("../db/db.cjs");
const { writeSecretFreeCopy, verifySecretFreeCopy } = require("../db/copy.cjs");
const settings = require("../config/settings.cjs");
const { dataPath, ensureDataDir } = require("../config/paths.cjs");
const memory = require("../utils/memory.cjs");
const library = require("../stickers/library.cjs");
const { scheduleMediaPath } = require("../../scheduler.cjs");
const { BackupError, writeBackup, validatePassword } = require("./format.cjs");
const logger = require("../utils/logger.cjs");
const { readPairedAccount, maskAccount } = require("./account.cjs");
const { ACCOUNT_TABLES, EXCLUDED_TABLES, RESTORABLE_BOT_KEYS, classifyTables } = require("./content.cjs");

const EXCLUDED_CATEGORIES = Object.freeze([
  "WhatsApp credentials", "panel password and sessions", "recovery email", "device settings",
  "temporary moderation and forwarding data", "device files and logs",
]);
const shaRe = /^[0-9a-f]{64}$/;
const mediaIdRe = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/;
let captureHookForTest;

function setCaptureHookForTest(fn) { captureHookForTest = fn; }

function countsOf(database, paired, memoryFiles, apiKeys) {
  const count = (sql) => Number(database.prepare(sql).get().n);
  const keys = RESTORABLE_BOT_KEYS;
  const settingsCount = Number(database.prepare(
    `SELECT count(*) AS n FROM bot_settings WHERE key IN (${keys.map(() => "?").join(",")})`,
  ).get(...keys).n);
  return {
    settings: settingsCount, apiKeys,
    schedules: paired ? count("SELECT count(*) AS n FROM schedules") : 0,
    groups: paired ? count("SELECT count(*) AS n FROM group_settings") : 0,
    roles: paired ? count("SELECT count(*) AS n FROM user_metadata WHERE is_owner OR is_admin") : 0,
    conversations: paired ? count("SELECT count(DISTINCT chat_id) AS n FROM ai_history") : 0,
    memoryFiles: paired ? memoryFiles : 0,
    stickers: paired ? count("SELECT count(*) AS n FROM stickers") : 0,
    packs: paired ? count("SELECT count(*) AS n FROM sticker_packs") : 0,
  };
}

function secretValues() {
  const result = {};
  for (const key of settings.SECRET_SETTING_KEYS) {
    if (settings.sourceOf(key) === "dashboard") {
      const value = settings.get(key);
      if (value) result[key] = value;
    }
  }
  return result;
}

function copyPrivate(source, destination, stable) {
  const stat = fs.lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new BackupError("IO", "Invalid backup source file");
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  // The private staging directory protects linked files. Never chmod a link.
  if (stable) {
    try { fs.linkSync(source, destination); return stat.size; }
    catch { /* Cross-device and restricted filesystems use a private copy. */ }
  }
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(destination, 0o600);
  return stat.size;
}

function memorySources() {
  const root = memory.ROOT;
  const result = [];
  const global = path.join(root, "global.md");
  if (fs.existsSync(global)) result.push([global, "memory/global.md"]);
  const chats = path.join(root, "chats");
  if (fs.existsSync(chats)) {
    for (const name of fs.readdirSync(chats).sort()) {
      if (name.startsWith(".") || !name.endsWith(".md")) continue;
      if (!mediaIdRe.test(name)) throw new BackupError("IO", "Invalid memory file name");
      result.push([path.join(chats, name), `memory/chats/${name}`]);
    }
  }
  return result;
}

function referencedFiles(database, paired) {
  if (!paired) return [];
  const files = memorySources().map(([source, entry]) => ({ source, entry, kind: "memory", stable: false }));
  const shas = database.prepare("SELECT DISTINCT sha256 FROM stickers ORDER BY sha256").all();
  for (const { sha256: sha } of shas) {
    if (!shaRe.test(sha)) throw new BackupError("IO", "Invalid sticker reference");
    const webp = library.webpPath(sha);
    if (fs.existsSync(webp)) files.push({ source: webp,
      entry: `stickers/${sha.slice(0, 2)}/${sha}.webp`, kind: "sticker", stable: true });
    const thumb = library.thumbPath(sha);
    if (fs.existsSync(thumb)) files.push({ source: thumb,
      entry: `stickers/${sha.slice(0, 2)}/${sha}.thumb.webp`, kind: "sticker", stable: true });
  }
  for (const { id } of database.prepare("SELECT id FROM schedules WHERE media IS NOT NULL AND media != '' ORDER BY id").all()) {
    if (!mediaIdRe.test(id)) throw new BackupError("IO", "Invalid schedule media reference");
    const media = scheduleMediaPath(id);
    if (fs.existsSync(media)) files.push({ source: media,
      entry: `media/schedules/${id}`, kind: "schedule-media", stable: true });
  }
  return files;
}

function rawForbiddenValues() {
  const keys = ["auth:password", "auth:recovery-email", "secret:session",
    ...settings.SECRET_SETTING_KEYS.map((key) => `setting:${key}`)];
  const found = [];
  const query = db.prepare("SELECT value FROM bot_settings WHERE key = ?");
  for (const key of keys) {
    const value = query.get(key)?.value;
    if (value !== null && value !== undefined && String(value).length)
      found.push({ category: key.startsWith("setting:") ? "secret setting" : key, bytes: Buffer.from(String(value)) });
  }
  const creds = db.prepare("SELECT value FROM baileys_auth WHERE key = 'creds'").get()?.value;
  if (creds) found.push({ category: "pairing credentials", bytes: Buffer.from(String(creds)) });
  return found;
}

function rejectForbidden(bytes, forbidden) {
  for (const item of forbidden) {
    if (bytes.includes(item.bytes)) {
      logger.warn({ category: item.category }, "[Backup] excluded value found in backup content");
      throw new BackupError("SECRET_FOUND", `Backup contains ${item.category}`);
    }
  }
}

async function scanTextFile(file, forbidden) {
  if (!forbidden.length) return;
  const overlap = Math.max(...forbidden.map((item) => item.bytes.length)) - 1;
  let tail = Buffer.alloc(0);
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 65536 })) {
    const bytes = Buffer.concat([tail, chunk]);
    rejectForbidden(bytes, forbidden);
    tail = bytes.subarray(Math.max(0, bytes.length - overlap));
  }
}

async function scanSecrets(filtered, files, stage, forbidden) {
  if (!forbidden.length) return;
  const database = new DatabaseSync(filtered, { readOnly: true });
  try {
    let rows = 0;
    for (const table of classifyTables(database)) {
      // classifyTables restricts names to code-owned table names.
      for (const row of database.prepare(`SELECT * FROM "${table}"`).iterate()) {
        for (const value of Object.values(row)) {
          if (typeof value === "string") rejectForbidden(Buffer.from(value), forbidden);
          else if (value instanceof Uint8Array) rejectForbidden(Buffer.from(value), forbidden);
        }
        if (++rows % 128 === 0) await new Promise((resolve) => setImmediate(resolve));
      }
    }
  } finally { database.close(); }
  for (const file of files) {
    if (file.kind === "persona" || file.kind === "memory")
      await scanTextFile(path.join(stage, file.entry), forbidden);
  }
}

async function entryFor(source, entry, kind) {
  const hash = crypto.createHash("sha256");
  if (Buffer.isBuffer(source)) return { path: entry, kind, size: source.length,
    sha256: hash.update(source).digest("hex"), source };
  let size = 0;
  for await (const chunk of fs.createReadStream(source, { highWaterMark: 65536 })) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { path: entry, kind, size, sha256: hash.digest("hex"), source };
}

// No await: the DB snapshot and every source file are captured in one event-loop turn.
function capture(stage, statfs = fs.statfsSync) {
  const paired = readPairedAccount();
  classifyTables(db);
  const files = referencedFiles(db, Boolean(paired));
  const persona = dataPath("ai-persona.md");
  if (fs.existsSync(persona)) files.unshift({ source: persona, entry: "persona.md", kind: "persona", stable: false });
  const sourceBytes = files.reduce((sum, item) => sum + fs.statSync(item.source).size, 0);
  const secrets = secretValues();
  const secretsBytes = Object.keys(secrets).length ? Buffer.byteLength(JSON.stringify({ settings: secrets })) : 0;
  const databaseBytes = fs.statSync(dataPath("levix.db")).size +
    (fs.statSync(dataPath("levix.db-wal"), { throwIfNoEntry: false })?.size || 0);
  const space = statfs(dataPath());
  const outputBytes = Math.ceil((databaseBytes + sourceBytes + secretsBytes) * 1.01);
  const needed = databaseBytes + sourceBytes + outputBytes + 64 * 1024 * 1024;
  if (Number(space.bavail) * Number(space.bsize) < needed) throw new BackupError("NO_SPACE", "Not enough space for backup");
  fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
  const filtered = path.join(stage, "filtered.db");
  const omitTables = [...EXCLUDED_TABLES, ...(paired ? [] : ACCOUNT_TABLES)];
  const keepBotKey = (key) => RESTORABLE_BOT_KEYS.includes(key);
  try {
    writeSecretFreeCopy(dataPath("levix.db"), filtered, { omitTables, keepBotKey });
    captureHookForTest?.("after-db-copy", stage);
    const source = new DatabaseSync(dataPath("levix.db"), { readOnly: true });
    try {
      verifySecretFreeCopy(filtered, source, {
        expectedVersion: source.prepare("PRAGMA user_version").get().user_version,
        omitTables, keepBotKey,
      });
    } finally { source.close(); }
  }
  catch (error) {
    const busy = /busy|locked|transaction/i.test(String(error.message));
    throw new BackupError(busy ? "BUSY" : "IO", "Backup snapshot unavailable");
  }
  for (const file of files) copyPrivate(file.source, path.join(stage, file.entry), file.stable);
  captureHookForTest?.("after-files", stage);
  const database = new DatabaseSync(filtered, { readOnly: true });
  try {
    return { paired, files, forbidden: rawForbiddenValues(), secrets, filtered,
      schema: database.prepare("PRAGMA user_version").get().user_version,
      counts: countsOf(database, Boolean(paired), files.filter((f) => f.kind === "memory").length,
        Object.keys(secrets).length) };
  } finally { database.close(); }
}

function describeBackupContents() {
  classifyTables(db);
  const account = readPairedAccount();
  const apiKeys = Object.keys(secretValues()).sort();
  const files = referencedFiles(db, Boolean(account));
  return { counts: countsOf(db, Boolean(account), files.filter((f) => f.kind === "memory").length, apiKeys.length),
    apiKeys, paired: Boolean(account), maskedAccount: maskAccount(account), excluded: EXCLUDED_CATEGORIES };
}

// kdf and statfs are internal test hooks; panel jobs always use production defaults.
async function createBackup({ password, onProgress, kdf, statfs } = {}) {
  validatePassword(password);
  const id = crypto.randomBytes(16).toString("hex");
  const token = crypto.randomBytes(32).toString("hex");
  const base = ensureDataDir("tmp", "backup");
  const stage = path.join(base, id);
  const out = path.join(ensureDataDir("tmp", "backup", "exports"), `${token}.levixbak`);
  try {
    onProgress?.({ phase: "capture", bytes: 0, totalBytes: 0 });
    let snapshot;
    for (let attempt = 0; attempt < 5; attempt++) {
      try { snapshot = capture(stage, statfs); break; }
      catch (error) {
        if (error?.code !== "BUSY") throw error;
        fs.rmSync(stage, { recursive: true, force: true });
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    onProgress?.({ phase: "filter", bytes: 0, totalBytes: 0 });
    await scanSecrets(snapshot.filtered, snapshot.files, stage, snapshot.forbidden);
    const apiKeys = Object.keys(snapshot.secrets).sort();
    const sources = [await entryFor(snapshot.filtered, "db/levix.db", "db")];
    if (apiKeys.length) sources.push(await entryFor(Buffer.from(JSON.stringify({ settings: snapshot.secrets })), "secrets.json", "secrets"));
    for (const file of snapshot.files) sources.push(await entryFor(path.join(stage, file.entry), file.entry, file.kind));
    const now = new Date();
    const fileName = `levix-backup-${now.toISOString().replace(/[-:]/g, "").slice(0, 15).replace("T", "-")}.levixbak`;
    const manifest = { format: "levix-backup-manifest", version: 1, created: now.toISOString(),
      app: require("../../package.json").version, schema: snapshot.schema,
      platform: `${process.platform}-${process.arch}`, account: snapshot.paired,
      apiKeys, counts: snapshot.counts };
    const written = await writeBackup({ outPath: out, password, manifest, entries: sources, kdf, onProgress });
    return { token, fileName, path: out, size: written.size };
  } catch (error) {
    fs.rmSync(out, { force: true });
    throw error instanceof BackupError ? error : new BackupError("IO", "Backup creation failed");
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}

module.exports = { createBackup, describeBackupContents, setCaptureHookForTest };

// Real panel startup from the frozen released v4.9.1/v4.9.2 schema (user_version 10).
// Those releases stored no legal:acceptance row.
// bootstrapCore takes the lock, copies, migrates, and resumes a paired install.
// The Baileys constructor is the offline fake. Identities, keys and content are synthetic.
import { registerHooks } from "node:module";
import "./fixtures/no-external-network.cjs";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { equal, finish, ok, require, section, useTempDataDir } from "./harness.mjs";

const dir = useTempDataDir("levix-v49-upgrade");
globalThis.__levixV49SocketCreates = 0;
globalThis.__levixV49SocketHooked = false;
const socketUrl = new URL("../src/core/socket.js", import.meta.url).href;
const fakeUrl = new URL("./fixtures/fake-whatsapp.mjs", import.meta.url).href;
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url !== socketUrl) return result;
    const sourceText = String(result.source);
    const original = 'import { makeWASocket } from "@whiskeysockets/baileys";';
    if (!sourceText.includes(original)) throw new Error("WhatsApp test interception failed");
    return {
      ...result,
      source: sourceText.replace(
        original,
        `import { makeWASocket as __levixFakeMakeWASocket } from ${JSON.stringify(fakeUrl)};
globalThis.__levixV49SocketHooked = true;
function makeWASocket(...args) {
  globalThis.__levixV49SocketCreates += 1;
  return __levixFakeMakeWASocket(...args);
}`,
      ),
    };
  },
});

function quoteIdent(name) {
  return `"${String(name).replaceAll('"', '""')}"`;
}

/** SQLite header user_version. Used while prepareDatabase still holds the live file. */
function fileUserVersion(file) {
  return readFileSync(file).readUInt32BE(60);
}

function sortedRows(database, table) {
  const columns = database.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all();
  const pk = columns
    .filter((column) => column.pk > 0)
    .sort((left, right) => left.pk - right.pk)
    .map((column) => column.name);
  const rows = database.prepare(`SELECT * FROM ${quoteIdent(table)}`).all();
  const identity = (row) =>
    pk.length === 0 ? JSON.stringify(row) : JSON.stringify(pk.map((name) => row[name]));
  rows.sort((left, right) => {
    const a = identity(left);
    const b = identity(right);
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  });
  return rows;
}

function rowsJson(database, table) {
  return JSON.stringify(sortedRows(database, table));
}

function dropSetting(serialized, key) {
  return JSON.stringify(JSON.parse(serialized).filter((row) => row.key !== key));
}

function authValue(database, key) {
  return database.prepare("SELECT value FROM baileys_auth WHERE key = ?").get(key).value;
}

const masterKey = randomBytes(32);
writeFileSync(join(dir, "levix.key"), masterKey, { mode: 0o600 });
const keyHex = masterKey.toString("hex");
const vault = require("./src/config/vault.cjs");
const terms = require("./src/legal/terms.cjs");
const consent = require("./src/legal/consent.cjs");
const { SECRET_SETTING_KEYS } = require("./src/config/settings.cjs");
const document = terms.documentFor("en");
ok("bundled Terms document is available", !!document?.version && !!document?.sha256);
for (const key of [
  "gemini_api_key",
  "openai_api_key",
  "anthropic_api_key",
  "google_search_api_key",
  "google_translate_api_key",
  "openweathermap_api_key",
  "whatsapp_proxy_password",
]) {
  ok(`${key} is a secret setting`, SECRET_SETTING_KEYS.includes(key));
}

const lid = "900000000000001@lid";
const pn = "15550000001@s.whatsapp.net";
const group = "120363000000001@g.us";
const now = Date.now();
const keptUntil = now + 400 * 24 * 60 * 60 * 1000;
const hiddenFromCopy = [];
function track(value) {
  hiddenFromCopy.push(String(value));
  return value;
}
const credentials = JSON.stringify({
  registered: false,
  me: { id: "15550000001:7@s.whatsapp.net", lid: "900000000000001:7@lid", name: "Synthetic Owner" },
  account: { key: track("CREDS-SENTINEL-v49") },
});
const signalSession = JSON.stringify({
  _sessions: { synthetic: { registrationId: 1234, sentinel: track("SIGNAL-SENTINEL-v49") } },
});
const preKey = JSON.stringify({ sentinel: track("PREKEY-SENTINEL-v49") });
const encryptedCreds = track(vault.seal(credentials));
const encryptedSignal = track(vault.seal(signalSession));
const encryptedPreKey = track(vault.seal(preKey));

const source = new DatabaseSync(join(dir, "levix.db"));
source.exec(readFileSync(new URL("./fixtures/v49-schema.sql", import.meta.url), "utf8"));
function insert(table, row) {
  const columns = Object.keys(row);
  source
    .prepare(
      `INSERT INTO ${quoteIdent(table)} (${columns.map(quoteIdent).join(",")}) VALUES (${columns
        .map(() => "?")
        .join(",")})`,
    )
    .run(...Object.values(row));
}
const secretKeys = new Set([
  "auth:password",
  "auth:recovery-email",
  "secret:session",
  ...SECRET_SETTING_KEYS.map((key) => `setting:${key}`),
]);
const settings = {
  prefix: "!",
  command_permissions: { ping: "OWNER_ONLY", kick: "OWNER_ONLY" },
  disabled_commands: ["tts"],
  command_aliases: { ping: ["health"] },
  "setting:bot_language": "en",
  "setting:ai_provider": "gemini",
  "setting:whatsapp_proxy_host": "proxy.example.test",
  "auth:password": track("PASSWORD-SENTINEL-v49"),
  "auth:recovery-email": track("RECOVERY-SENTINEL-v49"),
  "secret:session": track("SESSION-KEY-SENTINEL-v49"),
};
for (const key of SECRET_SETTING_KEYS) {
  const plaintext = `SECRET-${key}-SENTINEL-v49`;
  hiddenFromCopy.push(plaintext);
  settings[`setting:${key}`] = track(vault.seal(plaintext));
}
for (const [key, value] of Object.entries(settings)) {
  insert("bot_settings", { key, value: JSON.stringify(value) });
}
insert("baileys_auth", { key: "creds", value: encryptedCreds });
insert("baileys_auth", { key: "session-synthetic", value: encryptedSignal });
insert("baileys_auth", { key: "pre-key-7", value: encryptedPreKey });
insert("qr_codes", { id: 1, qr_string: track("QR-SENTINEL-v49") });
insert("lid_mapping", { lid, pn, device_index: 7, updated_at: 1700000000000 });
insert("user_metadata", {
  user_jid: lid,
  user_lid: lid,
  phone_number: "15550000001",
  is_owner: 1,
  is_admin: 0,
  first_seen: 1700000000000,
  last_seen: 1700000001000,
  display_name: "Synthetic Owner",
  saved_name: "Owner",
});
insert("user_metadata", {
  user_jid: "900000000000002@lid",
  is_owner: 0,
  is_admin: 1,
  first_seen: 1700000000000,
  last_seen: 1700000001000,
});
insert("group_settings", {
  group_id: group,
  settings: JSON.stringify({ antilink: true, forbiddenWords: ["spam"], media: { images: false } }),
});
insert("group_directory", {
  group_id: group,
  subject: "Synthetic group",
  participant_count: 2,
  updated_at: 1700000000000,
});
insert("warnings", {
  group_id: group,
  user_id: lid,
  warnings: JSON.stringify([{ reason: "synthetic moderation", timestamp: 1700000000000 }]),
});
insert("todos", {
  user_id: lid,
  tasks: JSON.stringify([{ id: 1, text: "Synthetic task", done: false }]),
});
insert("notes", {
  group_id: group,
  keyword: "meeting",
  note_text: "اجتماع تجريبي • NONSECRET-NOTE-v49",
});
insert("debts", {
  id: 7,
  group_id: group,
  debtor_id: lid,
  creditor_id: pn,
  amount: 12.5,
  currency: "USD",
  description: "synthetic debt",
  created_at: 1700000000000,
  settled: 0,
  settled_at: null,
});
insert("forward_scores", {
  message_id: "synthetic-forward-1",
  group_id: group,
  original_sender: lid,
  forward_count: 2,
  first_forwarded_at: 1700000000000,
  last_forwarded_at: 1700000001000,
  expires_at: keptUntil,
});
insert("ai_history", {
  chat_id: group,
  history: JSON.stringify([
    { role: "user", parts: [{ text: "Synthetic question" }] },
    { role: "model", parts: [{ text: "Synthetic answer" }] },
  ]),
  updated_at: 1700000000000,
});
insert("schedules", {
  id: "one",
  type: "once",
  target_jid: group,
  message: "Scheduled synthetic message",
  cron_string: null,
  date: "2099-01-01T09:00:00Z",
  status: "pending",
  creator_jid: lid,
  created_at: 1700000000000,
  last_run_at: null,
  last_delivery_status: null,
  last_error: null,
  media: null,
});
insert("schedules", {
  id: "recurring",
  type: "recurring",
  target_jid: group,
  message: "رسالة دورية تجريبية",
  cron_string: "0 9 * * *",
  date: null,
  status: "pending",
  creator_jid: lid,
  created_at: 1700000000000,
  last_run_at: null,
  last_delivery_status: null,
  last_error: null,
  media: JSON.stringify({ kind: "image", mimeType: "image/png", fileName: "synthetic.png" }),
});
insert("sticker_owners", {
  id: "aaaaaaaaaaaaaaaa",
  kind: "self",
  account: lid,
  legacy_key: null,
  created_at: 1700000000000,
});
insert("stickers", {
  id: "bbbbbbbbbbbbbbbb",
  owner: "aaaaaaaaaaaaaaaa",
  sha256: "ab".repeat(32),
  name: "synthetic sticker",
  animated: 0,
  width: 512,
  height: 512,
  duration_ms: null,
  file_size: 128,
  source: "BOT_COMMAND",
  source_mime: "image/png",
  is_favorite: 1,
  created_at: 1700000000000,
  updated_at: 1700000000000,
  last_used_at: null,
});
insert("sticker_packs", {
  id: "cccccccccccccccc",
  owner: "aaaaaaaaaaaaaaaa",
  name: "Synthetic pack",
  name_key: "synthetic pack",
  created_at: 1700000000000,
  updated_at: 1700000000000,
});
insert("sticker_pack_items", {
  pack_id: "cccccccccccccccc",
  sticker_id: "bbbbbbbbbbbbbbbb",
  position: 0,
  added_at: 1700000000000,
});
insert("auto_delete_rules", {
  id: 1,
  name: "synthetic rule",
  enabled: 1,
  keywords: JSON.stringify(["synthetic spam"]),
  match_mode: "contains",
  chat_scope: "all",
  senders_mode: "everyone",
  senders_list: "[]",
  include_own: 0,
  for_everyone: 1,
  keep_copy: 1,
  deleted_count: 1,
  last_deleted_at: 1700000000000,
  created_at: 1700000000000,
  updated_at: 1700000000000,
});
insert("auto_delete_log", {
  id: 1,
  rule_id: 1,
  chat_jid: group,
  sender: lid,
  text: "synthetic kept caption",
  media_type: null,
  mode: "delete",
  created_at: now,
});
insert("moderation_flags", {
  group_id: group,
  user_id: lid,
  warn_count: 3,
  last_rule: "forbiddenWords",
  flagged_at: 1700000000000,
  reasons: JSON.stringify(["synthetic moderation"]),
  last_notified_at: 1700000000000,
  repeat_points: 1,
});
insert("moderation_applied", {
  group_id: group,
  message_id: "synthetic-message-1",
  outcome: "warn",
  kicked: 0,
  notified: 1,
  applied_at: now,
});

const tables = source
  .prepare(
    `SELECT name FROM sqlite_master
     WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
     ORDER BY name`,
  )
  .all()
  .map((row) => row.name);
for (const name of tables) {
  ok(
    `seeded ${name}`,
    source.prepare(`SELECT count(*) AS n FROM ${quoteIdent(name)}`).get().n > 0,
  );
}
const snapshots = new Map(tables.map((name) => [name, rowsJson(source, name)]));
const nonSecretSettings = JSON.stringify(
  sortedRows(source, "bot_settings").filter((row) => !secretKeys.has(row.key)),
);
source.close();

const files = new Map([
  ["memory/global.md", "# Global memory\n- Synthetic shared fact\n"],
  ["memory/chats/synthetic.md", "# Chat memory\n- Synthetic private fact\n"],
  ["ai-persona.md", "Synthetic operator persona"],
]);
for (const [name, content] of files) {
  mkdirSync(join(dir, name, ".."), { recursive: true });
  writeFileSync(join(dir, name), content);
}

const database = require("./src/db/db.cjs");
const lock = require("./src/config/lock.cjs");
const { isSecretBotKey } = require("./src/db/copy.cjs");
const copyTrace = {
  ran: false,
  lockHeld: false,
  liveVersion: null,
  partVersion: null,
  partIntegrity: null,
  partAuth: null,
  partQr: null,
};
database.setCopyHookForTest((phase) => {
  if (phase !== "before-rename") return;
  copyTrace.ran = true;
  copyTrace.lockHeld = lock.isLockHeld();
  copyTrace.liveVersion = fileUserVersion(join(dir, "levix.db"));
  const folder = join(dir, "backups", "pre-migration");
  const parts = readdirSync(folder).filter((name) => name.endsWith(".db.part"));
  if (parts.length !== 1) return;
  const partPath = join(folder, parts[0]);
  copyTrace.partVersion = fileUserVersion(partPath);
  const part = new DatabaseSync(partPath, { readOnly: true });
  try {
    copyTrace.partIntegrity = part.prepare("PRAGMA integrity_check").get().integrity_check;
    copyTrace.partAuth = part.prepare("SELECT count(*) AS n FROM baileys_auth").get().n;
    copyTrace.partQr = part.prepare("SELECT count(*) AS n FROM qr_codes").get().n;
  } finally {
    part.close();
  }
});

const { WhatsAppSession } = await import("../src/core/session.js");
const originalStart = WhatsAppSession.prototype.start;
const startReasons = [];
WhatsAppSession.prototype.start = async function start(options) {
  startReasons.push(options?.reason ?? null);
  return originalStart.call(this, options);
};

let core = null;
try {
  equal(
    "importing the session did not migrate the seed",
    fileUserVersion(join(dir, "levix.db")),
    10,
  );
  ok("Baileys constructor is the offline fake", globalThis.__levixV49SocketHooked === true);
  equal("no socket exists before startup", globalThis.__levixV49SocketCreates, 0);

  const { bootstrapCore } = await import("../src/bootstrap/core.js");
  core = await bootstrapCore({ autoStart: false });
  const store = require("./src/db/store.cjs");
  const { db } = database;

  section("bootstrapCore locks, copies, then migrates schema 10");
  ok("bootstrap verified the copy before migration", copyTrace.ran);
  equal("the instance lock was held while the copy was verified", copyTrace.lockHeld, true);
  equal("the live schema was still 10 when the copy was verified", copyTrace.liveVersion, 10);
  equal("the verified part is schema 10", copyTrace.partVersion, 10);
  equal("the verified part is intact", copyTrace.partIntegrity, "ok");
  equal("the verified part has no pairing rows", copyTrace.partAuth, 0);
  equal("the verified part has no QR rows", copyTrace.partQr, 0);
  equal("bootstrap keeps the instance lock", lock.isLockHeld(), true);
  equal(
    "bootstrap reaches the current schema",
    db.prepare("PRAGMA user_version").get().user_version,
    database.MIGRATIONS.length,
  );
  ok("the current schema is newer than 10", database.MIGRATIONS.length > 10);
  equal(
    "the upgraded database is intact",
    db.prepare("PRAGMA integrity_check").get().integrity_check,
    "ok",
  );
  // deleteQrCode() in bootstrapCore drops a QR left by the previous process.
  equal("startup drops the stale QR", rowsJson(db, "qr_codes"), "[]");
  ok("the stale QR was seeded", snapshots.get("qr_codes") !== "[]");
  for (const [table, before] of snapshots) {
    if (table === "qr_codes") continue;
    equal(`legacy ${table} rows preserved by primary key`, rowsJson(db, table), before);
  }
  equal("pairing ciphertext is unchanged after startup", authValue(db, "creds"), encryptedCreds);
  equal(
    "signal ciphertext is unchanged after startup",
    authValue(db, "session-synthetic"),
    encryptedSignal,
  );
  equal(
    "pre-key ciphertext is unchanged after startup",
    authValue(db, "pre-key-7"),
    encryptedPreKey,
  );
  equal(
    "install vault key is unchanged after startup",
    readFileSync(join(dir, "levix.key")).toString("hex"),
    keyHex,
  );
  equal(
    "QR-linked registered:false credentials still decrypt",
    store.authRead("creds"),
    credentials,
  );
  equal("signal session still decrypts", store.authRead("session-synthetic"), signalSession);
  equal("pre-key still decrypts", store.authRead("pre-key-7"), preKey);
  for (const [name, content] of files) {
    equal(`${name} preserved`, readFileSync(join(dir, name), "utf8"), content);
  }
  equal(
    "new automation has no enabled rules",
    db.prepare("SELECT count(*) AS n FROM reaction_rules WHERE enabled = 1").get().n,
    0,
  );
  equal(
    "upgrade adds no reaction rules",
    db.prepare("SELECT count(*) AS n FROM reaction_rules").get().n,
    0,
  );

  const backupDir = join(dir, "backups", "pre-migration");
  const copyNames = readdirSync(backupDir).filter((name) => name.endsWith(".db"));
  equal("bootstrap left one safety copy", copyNames.length, 1);
  ok("the safety copy is named for schema 10", /^levix-v10-\d{8}T\d{6}Z\.db$/.test(copyNames[0]));
  equal(
    "no partial copy remains",
    readdirSync(backupDir).filter((name) => name.includes(".part")).length,
    0,
  );
  database.setCopyHookForTest(null);
  const again = await database.prepareDatabase();
  equal("a later prepare does not migrate again", again.from, again.to);
  equal("a later prepare does not write another copy", again.copyPath, null);
  equal(
    "a later prepare leaves the one safety copy",
    readdirSync(backupDir).filter((name) => name.endsWith(".db")).length,
    1,
  );

  section("the safety copy omits every secret and keeps every other row");
  const copy = new DatabaseSync(join(backupDir, copyNames[0]), { readOnly: true });
  try {
    equal("copy retains schema 10", copy.prepare("PRAGMA user_version").get().user_version, 10);
    equal("copy is intact", copy.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    const copyBytes = readFileSync(join(backupDir, copyNames[0]));
    ok("copy contains the non-secret note", copyBytes.includes(Buffer.from("NONSECRET-NOTE-v49")));
    for (const needle of hiddenFromCopy) {
      ok(`copy bytes omit ${needle.slice(0, 48)}`, !copyBytes.includes(Buffer.from(needle)));
    }
    for (const [table, before] of snapshots) {
      if (table === "baileys_auth" || table === "qr_codes") {
        equal(`copy ${table} is empty`, rowsJson(copy, table), "[]");
        ok(`source ${table} had rows`, before !== "[]");
        continue;
      }
      if (table === "bot_settings") {
        equal("copy keeps every non-secret setting", rowsJson(copy, table), nonSecretSettings);
        continue;
      }
      equal(`copy keeps ${table}`, rowsJson(copy, table), before);
    }
    for (const row of sortedRows(copy, "bot_settings")) {
      ok(`copy key ${row.key} is not a secret`, isSecretBotKey(row.key) === false);
    }
    for (const key of secretKeys) {
      equal(
        `copy excludes ${key}`,
        copy.prepare("SELECT count(*) AS n FROM bot_settings WHERE key = ?").get(key).n,
        0,
      );
    }
    equal(
      "the pre-migration copy has no legal:acceptance row",
      copy
        .prepare("SELECT count(*) AS n FROM bot_settings WHERE key = 'legal:acceptance'")
        .get().n,
      0,
    );
  } finally {
    copy.close();
  }

  section("paired resume waits for Terms consent for this version");
  equal(
    "the live database has no legal:acceptance before consent",
    db.prepare("SELECT count(*) AS n FROM bot_settings WHERE key = 'legal:acceptance'").get().n,
    0,
  );
  equal("bootstrap recognized the paired install", core.wasPaired, true);
  equal("sessionStartupPolicy resumed the paired install", startReasons.join(","), "resume-paired");
  equal("resume is held in consent_required", core.session.state, "consent_required");
  equal(
    "the gate reason is missing Terms consent",
    core.session.getState().reason,
    "terms_not_accepted",
  );
  equal("the gate reports the install as linked", core.session.getState().linked, true);
  equal("the gate created no socket", globalThis.__levixV49SocketCreates, 0);
  equal("the gate holds no socket", core.session.socket, null);
  equal("the gate keeps the pairing ciphertext", authValue(db, "creds"), encryptedCreds);

  consent.recordAcceptance({
    version: document.version,
    sha256: document.sha256,
    locale: "en",
    via: "panel",
  });
  await core.session.recheckConsent();
  // The shared fake emits one QR on a setImmediate after the constructor returns.
  await new Promise((resolve) => setImmediate(resolve));
  equal(
    "acceptance is the second start",
    startReasons.join(","),
    "resume-paired,consent_accepted",
  );
  equal("acceptance creates one fake socket", globalThis.__levixV49SocketCreates, 1);
  ok("the fake socket is installed", core.session.socket !== null);
  ok(
    "acceptance leaves the Terms gate",
    core.session.state === "starting" || core.session.state === "waiting_for_qr",
    core.session.state,
  );
  equal("pairing ciphertext is unchanged after resume", authValue(db, "creds"), encryptedCreds);
  equal(
    "signal ciphertext is unchanged after resume",
    authValue(db, "session-synthetic"),
    encryptedSignal,
  );
  equal(
    "pre-key ciphertext is unchanged after resume",
    authValue(db, "pre-key-7"),
    encryptedPreKey,
  );
  equal(
    "install vault key is unchanged after resume",
    readFileSync(join(dir, "levix.key")).toString("hex"),
    keyHex,
  );
  equal("credentials still decrypt after resume", store.authRead("creds"), credentials);

  section("shutdown releases the lock and leaves pairing and levix.key");
  try {
    core.stopRemoteTerms();
  } catch {
    // The remote Terms schedule is off in this build.
  }
  await core.stopExtensions();
  await core.session.shutdown();
  await store.flushStore();
  equal("shutdown leaves the pairing ciphertext", authValue(db, "creds"), encryptedCreds);
  database.close();
  lock.release();
  equal("shutdown releases the instance lock", lock.isLockHeld(), false);
  equal("shutdown removes the lock hint", existsSync(lock.LOCK_FILE), false);

  const reopened = new DatabaseSync(join(dir, "levix.db"), { readOnly: true });
  try {
    equal(
      "reopened database is intact",
      reopened.prepare("PRAGMA integrity_check").get().integrity_check,
      "ok",
    );
    equal(
      "reopened schema is current",
      reopened.prepare("PRAGMA user_version").get().user_version,
      database.MIGRATIONS.length,
    );
    equal("stale QR stays gone after shutdown", rowsJson(reopened, "qr_codes"), "[]");
    for (const [table, before] of snapshots) {
      if (table === "qr_codes") continue;
      if (table === "bot_settings") {
        equal(
          "settings other than the new acceptance are unchanged",
          dropSetting(rowsJson(reopened, table), "legal:acceptance"),
          dropSetting(before, "legal:acceptance"),
        );
        continue;
      }
      equal(`legacy ${table} rows preserved after shutdown`, rowsJson(reopened, table), before);
    }
    const acceptance = JSON.parse(
      reopened.prepare("SELECT value FROM bot_settings WHERE key = 'legal:acceptance'").get().value,
    );
    equal("shutdown keeps acceptance for this build", acceptance.appVersion, consent.appVersion());
    equal(
      "pairing ciphertext is unchanged after shutdown",
      authValue(reopened, "creds"),
      encryptedCreds,
    );
    equal(
      "signal ciphertext is unchanged after shutdown",
      authValue(reopened, "session-synthetic"),
      encryptedSignal,
    );
    equal(
      "pre-key ciphertext is unchanged after shutdown",
      authValue(reopened, "pre-key-7"),
      encryptedPreKey,
    );
  } finally {
    reopened.close();
  }

  // close() clears the connection. The next store read configures the file, so it needs the lock.
  lock.acquireSingleInstanceLock();
  equal("the post-shutdown checks hold the instance lock", lock.isLockHeld(), true);
  equal(
    "install vault key is unchanged after shutdown",
    readFileSync(join(dir, "levix.key")).toString("hex"),
    keyHex,
  );
  equal("credentials still decrypt after shutdown", store.authRead("creds"), credentials);
  equal(
    "signal session still decrypts after shutdown",
    store.authRead("session-synthetic"),
    signalSession,
  );
  database.close();
  lock.release();
  equal("the post-shutdown checks release the instance lock", lock.isLockHeld(), false);

  lock.acquireSingleInstanceLock();
  equal("the data directory can be claimed again", lock.isLockHeld(), true);
  lock.release();
  equal("the second claim releases", lock.isLockHeld(), false);
  core = null;
} finally {
  WhatsAppSession.prototype.start = originalStart;
  database.setCopyHookForTest(null);
  if (core) {
    try {
      core.stopRemoteTerms();
    } catch {
      // Already stopped, or the schedule never armed.
    }
    try {
      await core.stopExtensions();
    } catch {
      // Extension shutdown is best-effort on a failed boot.
    }
    try {
      await core.session.shutdown();
    } catch {
      // The session may not have finished opening.
    }
  }
  try {
    database.close();
  } catch {
    // The database may already be closed.
  }
  try {
    lock.release();
  } catch {
    // The lock may already be released.
  }
}
finish();

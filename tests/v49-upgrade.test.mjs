// Real startup migration from the frozen released v4.9.1/v4.9.2 schema.
// All identities, keys and content are synthetic; no WhatsApp socket is opened.
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { equal, finish, ok, require, section, useTempDataDir } from "./harness.mjs";

const dir = useTempDataDir("levix-v49-upgrade");
const masterKey = randomBytes(32);
writeFileSync(join(dir, "levix.key"), masterKey, { mode: 0o600 });
const vault = require("./src/config/vault.cjs"); // Byte-identical to released v4.9.2.
const lid = "900000000000001@lid";
const pn = "15550000001@s.whatsapp.net";
const group = "120363000000001@g.us";
const credentials = JSON.stringify({
  registered: false,
  me: { id: "15550000001:7@s.whatsapp.net", lid: "900000000000001:7@lid", name: "Synthetic Owner" },
  account: { key: "synthetic-account-identity" },
});
const signalSession = JSON.stringify({ _sessions: { synthetic: { registrationId: 1234 } } });
const encryptedCreds = vault.seal(credentials);
const encryptedSignal = vault.seal(signalSession);
const source = new DatabaseSync(join(dir, "levix.db"));
source.exec(readFileSync(new URL("./fixtures/v49-schema.sql", import.meta.url), "utf8"));
function insert(table, row) {
  const columns = Object.keys(row);
  source
    .prepare(
      `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
    )
    .run(...Object.values(row));
}
for (const [key, value] of Object.entries({
  prefix: "!",
  command_permissions: { ping: "OWNER_ONLY", kick: "OWNER_ONLY" },
  disabled_commands: ["tts"],
  command_aliases: { ping: ["health"] },
  "setting:bot_language": "en",
  "setting:ai_provider": "gemini",
  "setting:gemini_api_key": vault.seal("synthetic-api-secret"),
  "auth:password": "synthetic-scrypt-hash",
  "auth:recovery-email": "synthetic-sealed-recovery",
  "secret:session": "synthetic-panel-session-key",
}))
  insert("bot_settings", { key, value: JSON.stringify(value) });
insert("baileys_auth", { key: "creds", value: encryptedCreds });
insert("baileys_auth", { key: "session-synthetic", value: encryptedSignal });
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
  note_text: "اجتماع تجريبي • synthetic meeting",
});
insert("debts", {
  group_id: group,
  debtor_id: lid,
  creditor_id: pn,
  amount: 12.5,
  currency: "USD",
  created_at: 1700000000000,
});
insert("ai_history", {
  chat_id: group,
  history: JSON.stringify([
    { role: "user", parts: [{ text: "Synthetic question" }] },
    { role: "model", parts: [{ text: "Synthetic answer" }] },
  ]),
  updated_at: 1700000000000,
});
for (const [id, type, text] of [
  ["one", "once", "Scheduled synthetic message"],
  ["recurring", "recurring", "رسالة دورية تجريبية"],
]) {
  insert("schedules", {
    id,
    type,
    target_jid: group,
    message: text,
    cron_string: type === "recurring" ? "0 9 * * *" : null,
    date: type === "once" ? "2099-01-01T09:00:00Z" : null,
    creator_jid: lid,
    status: "pending",
    created_at: 1700000000000,
  });
}
insert("auto_delete_rules", {
  keywords: JSON.stringify(["synthetic spam"]),
  match_mode: "contains",
  chat_scope: "all",
  senders_mode: "everyone",
  enabled: 1,
  created_at: 1700000000000,
  updated_at: 1700000000000,
});
const files = new Map([
  ["memory/global.md", "# Global memory\n- Synthetic shared fact\n"],
  ["memory/chats/synthetic.md", "# Chat memory\n- Synthetic private fact\n"],
  ["ai-persona.md", "Synthetic operator persona"],
]);
for (const [name, content] of files) {
  mkdirSync(join(dir, name, ".."), { recursive: true });
  writeFileSync(join(dir, name), content);
}
const tables = source
  .prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  )
  .all()
  .map((row) => row.name);
const snapshots = new Map(
  tables.map((name) => [
    name,
    JSON.stringify(source.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()),
  ]),
);
source.close();

const database = require("./src/db/db.cjs");
const lock = require("./src/config/lock.cjs");
database.guardStartup();
lock.acquireSingleInstanceLock();
try {
  section("locked startup verifies a secret-free copy and upgrades released schema 10");
  const report = await database.prepareDatabase();
  equal("source is actual v4.9 schema", report.from, 10);
  equal("target is current schema", report.to, database.MIGRATIONS.length);
  ok("startup created the verified safety copy", typeof report.copyPath === "string");
  const { db } = database;
  equal(
    "upgraded database is intact",
    db.prepare("PRAGMA integrity_check").get().integrity_check,
    "ok",
  );
  for (const [table, before] of snapshots) {
    equal(
      `legacy ${table} rows preserved exactly`,
      JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()),
      before,
    );
  }
  equal(
    "pairing ciphertext is unchanged",
    db.prepare("SELECT value FROM baileys_auth WHERE key='creds'").get().value,
    encryptedCreds,
  );
  equal(
    "install vault key is unchanged",
    readFileSync(join(dir, "levix.key")).toString("hex"),
    masterKey.toString("hex"),
  );
  const store = require("./src/db/store.cjs");
  equal(
    "QR-linked registered:false credentials still decrypt",
    store.authRead("creds"),
    credentials,
  );
  equal("signal session still decrypts", store.authRead("session-synthetic"), signalSession);
  for (const [name, content] of files)
    equal(`${name} preserved`, readFileSync(join(dir, name), "utf8"), content);
  equal(
    "new automation has no enabled rules",
    db.prepare("SELECT count(*) AS n FROM reaction_rules WHERE enabled=1").get().n,
    0,
  );
  const again = await database.prepareDatabase();
  equal("retry has no further migration", again.from, again.to);
  equal("retry creates no extra safety copy", again.copyPath, null);
  equal(
    "only one safety copy exists",
    readdirSync(join(dir, "backups/pre-migration")).filter((name) => name.endsWith(".db")).length,
    1,
  );

  section("new-version consent retains pairing and uses only a fake socket after acceptance");
  const consent = require("./src/legal/consent.cjs");
  const terms = require("./src/legal/terms.cjs");
  equal("v4 install requires first consent", consent.consentStatus().ok, false);
  const document = terms.documentFor("en");
  const acceptance = () =>
    consent.recordAcceptance({
      version: document.version,
      sha256: document.sha256,
      locale: "en",
      via: "panel",
    });
  acceptance();
  store.saveBotSetting(consent.KEY, { ...store.getBotSetting(consent.KEY), appVersion: "4.9.2" });
  equal("old app acceptance requires consent again", consent.consentStatus().reason, "app_updated");
  const { WhatsAppSession } = await import("../src/core/session.js");
  let sockets = 0;
  let clears = 0;
  const session = new WhatsAppSession({
    createSocket: async () => {
      sockets += 1;
      return {
        sock: { ev: new EventEmitter(), async end() {} },
        saveCreds: async () => {},
        clearAll: async () => {},
        isPaired: true,
      };
    },
    attachListeners: () => {},
    clearCredentials: async () => {
      clears += 1;
    },
    clearDirectory: () => {},
    isLinked: () => true,
    loadProxy: () => null,
    buildProxyAgents: () => null,
    consentPollMs: 60000,
    log: { info() {}, warn() {}, error() {}, debug() {} },
  });
  try {
    await session.start();
    equal("new-version gate creates no socket", sockets, 0);
    equal("gate keeps credentials", store.authRead("creds"), credentials);
    acceptance();
    await session.recheckConsent();
    equal("acceptance permits one fake socket", sockets, 1);
    equal("no credentials were cleared", clears, 0);
  } finally {
    await session.stop();
  }
  equal(
    "stop leaves pairing ciphertext intact",
    db.prepare("SELECT value FROM baileys_auth WHERE key='creds'").get().value,
    encryptedCreds,
  );

  section("the safety copy is not a pairing backup");
  const copy = new DatabaseSync(report.copyPath, { readOnly: true });
  try {
    equal(
      "copy retains old schema for rollback",
      copy.prepare("PRAGMA user_version").get().user_version,
      10,
    );
    equal("copy is intact", copy.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    equal(
      "copy contains no pairing/session credentials",
      copy.prepare("SELECT count(*) AS n FROM baileys_auth").get().n,
      0,
    );
    for (const key of [
      "auth:password",
      "auth:recovery-email",
      "secret:session",
      "setting:gemini_api_key",
    ]) {
      equal(
        `copy excludes ${key}`,
        copy.prepare("SELECT count(*) AS n FROM bot_settings WHERE key=?").get(key).n,
        0,
      );
    }
    equal(
      "nonsecret permissions remain available after rollback",
      copy.prepare("SELECT value FROM bot_settings WHERE key='command_permissions'").get().value,
      JSON.stringify({ ping: "OWNER_ONLY", kick: "OWNER_ONLY" }),
    );
    equal(
      "rollback copy retains schedules",
      copy.prepare("SELECT count(*) AS n FROM schedules").get().n,
      2,
    );
  } finally {
    copy.close();
  }
} finally {
  database.close();
  lock.release();
}
finish();

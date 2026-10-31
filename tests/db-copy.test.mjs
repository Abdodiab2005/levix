// Secret-free copies: schema, sequences, and ordinary rows survive; authentication
// material must not land in the target file or its journal or WAL.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { equal, finish, ok, require, section, throws, useTempDataDir } from "./harness.mjs";

const dir = useTempDataDir("levix-db-copy");
const { migrate, MIGRATIONS } = require("./src/db/db.cjs");
const { isSecretBotKey, writeSecretFreeCopy, verifySecretFreeCopy } = require("./src/db/copy.cjs");
const { SECRET_SETTING_KEYS } = require("./src/config/settings.cjs");

const SENTINEL = "SENTINEL-db-copy-7c1e";
const WAL_MARKER = "wal-frame-marker-9b2";
const SECRET_TABLE_NAMES = ["baileys_auth", "qr_codes"];
const sourcePath = join(dir, "source.db");
const fullPath = join(dir, "full.db");

const secretSettingKey = (key) => `setting:${key}`;
const bannedKeys = [
  "auth:password",
  "auth:recovery-email",
  "secret:session",
  ...SECRET_SETTING_KEYS.map(secretSettingKey),
];

function quote(name) {
  return `"${String(name).replaceAll('"', '""')}"`;
}

// Parentheses inside quotes or comments do not count. A stored statement that
// survived exec() still has to parse, so an unbalanced copy is a failed copy.
function parensBalanced(sql) {
  let depth = 0;
  let quoting = "";
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (quoting) {
      if (ch === quoting) {
        if (next === quoting) {
          i += 1;
          continue;
        }
        quoting = "";
      }
      continue;
    }
    if (ch === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) return false;
      i = end + 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quoting = ch;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0 && quoting === "";
}

function filesAt(targetPath) {
  return readdirSync(dirname(targetPath))
    .map((name) => join(dirname(targetPath), name))
    .filter((full) => full.startsWith(targetPath));
}

function containsSentinel(targetPath) {
  const needle = Buffer.from(SENTINEL);
  return filesAt(targetPath).some((full) => readFileSync(full).includes(needle));
}

function assertNoSentinel(targetPath) {
  const files = filesAt(targetPath);
  ok(`${basename(targetPath)} is on disk`, files.includes(targetPath));
  for (const full of files) {
    ok(`${basename(full)} has no sentinel`, !readFileSync(full).includes(Buffer.from(SENTINEL)));
  }
}

function userTables(database) {
  return database
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    )
    .all()
    .map((row) => row.name);
}

function tableRows(database, name) {
  return database.prepare(`SELECT * FROM ${quote(name)} ORDER BY rowid`).all();
}

function countOf(database, name) {
  return database.prepare(`SELECT count(*) AS n FROM ${quote(name)}`).get().n;
}

function versionOf(database) {
  return database.prepare("PRAGMA user_version").get().user_version;
}

function sequenceRows(database, names) {
  const present = database
    .prepare("SELECT 1 AS n FROM sqlite_master WHERE name = 'sqlite_sequence'")
    .get();
  if (!present) return [];
  const allowed = new Set(names);
  return database
    .prepare("SELECT name, seq FROM sqlite_sequence ORDER BY name")
    .all()
    .filter((row) => allowed.has(row.name));
}

function masterRows(database) {
  return database
    .prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_master
       ORDER BY type, name, tbl_name, sql`,
    )
    .all();
}

function settingKeys(database) {
  return tableRows(database, "bot_settings").map((row) => row.key);
}

function readDb(path, fn) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return fn(database);
  } finally {
    database.close();
  }
}

const echoSql = `CREATE TABLE todo_echo (
  user_id TEXT NOT NULL,
  tasks TEXT NOT NULL
)`;
const triggerSql = `CREATE TRIGGER todos_after_insert
AFTER INSERT ON todos
BEGIN
  INSERT INTO todo_echo (user_id, tasks) VALUES (NEW.user_id, NEW.tasks);
END;`;
const viewSql = "CREATE VIEW open_todos AS SELECT user_id, tasks FROM todos";

section("current schema, secrets, and one wal frame");

ok("secret setting keys exist", SECRET_SETTING_KEYS.length > 0);
equal(
  "fixture statements balance",
  [echoSql, triggerSql, viewSql].filter((sql) => !parensBalanced(sql)).length,
  0,
);

const source = new DatabaseSync(sourcePath);
source.exec("PRAGMA journal_mode = WAL");
equal("journal mode", source.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
// Closing the last connection checkpoints the WAL. This handle stays open, and
// autocheckpoint stays 0, so the last commit remains a frame the copy reads.
equal(
  "autocheckpoint is off",
  source.prepare("PRAGMA wal_autocheckpoint = 0").get().wal_autocheckpoint,
  0,
);
migrate(source, MIGRATIONS);
source.exec("PRAGMA foreign_keys = ON");
source.exec(echoSql);
source.exec(triggerSql);
source.exec(viewSql);

{
  const put = source.prepare("INSERT INTO bot_settings (key, value) VALUES (?, ?)");
  const rows = [
    ["auth:password", `${SENTINEL}:password`],
    ["auth:recovery-email", `${SENTINEL}:recovery-email`],
    ["secret:session", `${SENTINEL}:session`],
    ...SECRET_SETTING_KEYS.map((key) => [secretSettingKey(key), `${SENTINEL}:${key}`]),
    ["prefix", "!"],
    ["setting:bot_language", "en"],
    ["test:row", "kept"],
  ].sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  for (const [key, value] of rows) put.run(key, value);

  const putAuth = source.prepare("INSERT INTO baileys_auth (key, value) VALUES (?, ?)");
  putAuth.run("creds", `${SENTINEL}:creds`);
  putAuth.run("pre-key-1", `${SENTINEL}:pre-key`);
  source.prepare("INSERT INTO qr_codes (id, qr_string) VALUES (1, ?)").run(`${SENTINEL}:qr`);

  source
    .prepare("INSERT INTO group_settings (group_id, settings) VALUES (?, ?)")
    .run("120363@g.us", "{\"welcome\":true}");
  source
    .prepare("INSERT INTO warnings (group_id, user_id, warnings) VALUES (?, ?, ?)")
    .run("120363@g.us", "2010@s.whatsapp.net", "[1]");
  source
    .prepare("INSERT INTO notes (group_id, keyword, note_text) VALUES (?, ?, ?)")
    .run("120363@g.us", "wifi", "ordinary note");
  source
    .prepare(
      "INSERT INTO lid_mapping (lid, pn, device_index, updated_at) VALUES (?, ?, ?, ?)",
    )
    .run("555@lid", "2010@s.whatsapp.net", 0, 5);
  source
    .prepare(
      `INSERT INTO user_metadata (
         user_jid, phone_number, is_owner, is_admin, first_seen, last_seen, display_name
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("2010@s.whatsapp.net", "2010", 0, 0, 1, 2, "Ada");
  source
    .prepare(
      `INSERT INTO forward_scores (
         message_id, group_id, original_sender, forward_count,
         first_forwarded_at, last_forwarded_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("m1", "120363@g.us", "2010@s.whatsapp.net", 2, 1, 2, 99);
  source
    .prepare("INSERT INTO ai_history (chat_id, history, updated_at) VALUES (?, ?, ?)")
    .run("2010@s.whatsapp.net", "[]", 3);
  source
    .prepare(
      `INSERT INTO schedules (id, type, target_jid, message, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run("job-1", "once", "120363@g.us", "ping", "pending", 4);
  source
    .prepare(
      `INSERT INTO group_directory (group_id, subject, participant_count, updated_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run("120363@g.us", "Room", 3, 5);
  source
    .prepare(
      `INSERT INTO moderation_flags (
         group_id, user_id, warn_count, last_rule, flagged_at, reasons
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run("120363@g.us", "2010@s.whatsapp.net", 1, "link", 8, "[]");
  source
    .prepare(
      "INSERT INTO moderation_applied (group_id, message_id, outcome, applied_at) VALUES (?, ?, ?, ?)",
    )
    .run("120363@g.us", "m-applied", "flag", 9);

  const insertDebt = source.prepare(
    `INSERT INTO debts (group_id, debtor_id, creditor_id, amount, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  insertDebt.run("120363@g.us", "2011@s.whatsapp.net", "2010@s.whatsapp.net", 12.5, 10);
  insertDebt.run("120363@g.us", "2012@s.whatsapp.net", "2010@s.whatsapp.net", 4, 11);
  source.prepare("DELETE FROM debts WHERE id = ?").run(2);

  source
    .prepare(
      `INSERT INTO auto_delete_rules (
         keywords, match_mode, chat_scope, senders_mode, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run('["spam"]', "contains", "groups", "everyone", 6, 6);
  source
    .prepare(
      `INSERT INTO auto_delete_log (rule_id, chat_jid, sender, text, mode, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(1, "120363@g.us", "2010@s.whatsapp.net", "spam", "contains", 7);

  const insertTodo = source.prepare("INSERT INTO todos (user_id, tasks) VALUES (?, ?)");
  insertTodo.run("201111111111@s.whatsapp.net", '["buy milk"]');
  insertTodo.run("201222222222@s.whatsapp.net", '["pay rent"]');

  // Last commit. Autocheckpoint is off and the handle is still open, so this
  // row stays in the WAL and the main file does not receive it.
  source
    .prepare("INSERT INTO notes (group_id, keyword, note_text) VALUES (?, ?, ?)")
    .run("wal@g.us", "pending", WAL_MARKER);
}

{
  const sourceKeys = new Set(settingKeys(source));
  for (const key of bannedKeys) ok(`source has ${key}`, sourceKeys.has(key));
  equal("source version", versionOf(source), MIGRATIONS.length);
  equal("source debts left", countOf(source, "debts"), 1);
  equal(
    "source debts sequence",
    source.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'debts'").get().seq,
    2,
  );
  equal("source debts max id", source.prepare("SELECT MAX(id) AS id FROM debts").get().id, 1);
  equal(
    "source rules sequence",
    source.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'auto_delete_rules'").get().seq,
    1,
  );
  equal(
    "source log sequence",
    source.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'auto_delete_log'").get().seq,
    1,
  );
  equal("source echo rows", countOf(source, "todo_echo"), countOf(source, "todos"));
  ok("trigger is stored", !!source.prepare(
    "SELECT 1 AS n FROM sqlite_master WHERE type = 'trigger' AND name = 'todos_after_insert'",
  ).get());
  ok("view is stored", !!source.prepare(
    "SELECT 1 AS n FROM sqlite_master WHERE type = 'view' AND name = 'open_todos'",
  ).get());
  ok("wal file exists", existsSync(`${sourcePath}-wal`));
  ok("wal holds the marker", readFileSync(`${sourcePath}-wal`).includes(Buffer.from(WAL_MARKER)));
  ok("main file lacks the marker", !readFileSync(sourcePath).includes(Buffer.from(WAL_MARKER)));
  ok("source bytes contain the sentinel", containsSentinel(sourcePath));
}

const copiedTables = userTables(source).filter((name) => !SECRET_TABLE_NAMES.includes(name));

section("secret-free copy");

writeSecretFreeCopy(sourcePath, fullPath);
readDb(fullPath, (copy) => {
  equal("sqlite_master", JSON.stringify(masterRows(copy)), JSON.stringify(masterRows(source)));
  ok(
    "trigger is in the copy",
    masterRows(copy).some((row) => row.type === "trigger" && row.name === "todos_after_insert"),
  );
  ok(
    "view is in the copy",
    masterRows(copy).some((row) => row.type === "view" && row.name === "open_todos"),
  );
  const unbalanced = masterRows(copy)
    .filter((row) => row.sql != null && !parensBalanced(row.sql))
    .map((row) => row.name);
  equal("stored statements balance", unbalanced.join(","), "");
  equal(
    "sqlite_sequence",
    JSON.stringify(sequenceRows(copy, copiedTables)),
    JSON.stringify(sequenceRows(source, copiedTables)),
  );
  ok(
    "copied debts sequence stays ahead of max id",
    copy.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'debts'").get().seq >
      copy.prepare("SELECT MAX(id) AS id FROM debts").get().id,
  );
  equal("user_version", versionOf(copy), versionOf(source));
  equal("integrity_check", copy.prepare("PRAGMA integrity_check").get().integrity_check, "ok");

  for (const name of userTables(source)) {
    if (SECRET_TABLE_NAMES.includes(name)) {
      equal(`${name} row count`, countOf(copy, name), 0);
      continue;
    }
    // bot_settings is copied key by key so secret keys never reach the target.
    const expected = name === "bot_settings"
      ? tableRows(source, name).filter((row) => !isSecretBotKey(row.key))
      : tableRows(source, name);
    const actual = tableRows(copy, name);
    equal(`${name} row count`, actual.length, expected.length);
    equal(`${name} rows`, JSON.stringify(actual), JSON.stringify(expected));
  }

  const copiedKeys = settingKeys(copy);
  ok("no secret bot_settings key", copiedKeys.every((key) => !isSecretBotKey(key)));
  for (const key of bannedKeys) ok(`copy omits ${key}`, !copiedKeys.includes(key));
  equal(
    "uncheckpointed note is copied",
    copy.prepare("SELECT note_text FROM notes WHERE keyword = 'pending'").get().note_text,
    WAL_MARKER,
  );
  equal("trigger wrote no extra echo rows", countOf(copy, "todo_echo"), countOf(source, "todo_echo"));
  equal("echo rows are the source todos only", countOf(copy, "todo_echo"), countOf(source, "todos"));
  equal(
    "open_todos matches",
    JSON.stringify(copy.prepare("SELECT user_id, tasks FROM open_todos ORDER BY user_id").all()),
    JSON.stringify(source.prepare("SELECT user_id, tasks FROM open_todos ORDER BY user_id").all()),
  );
});
assertNoSentinel(fullPath);

section("verification");

{
  let verificationError = null;
  try {
    verifySecretFreeCopy(fullPath, source, { expectedVersion: MIGRATIONS.length });
  } catch (error) {
    verificationError = error;
  }
  ok("verifySecretFreeCopy accepts the copy", verificationError === null, verificationError?.message);

  const added = new DatabaseSync(fullPath);
  added
    .prepare("INSERT INTO notes (group_id, keyword, note_text) VALUES (?, ?, ?)")
    .run("extra@g.us", "extra", "one more");
  added.close();
  const rejected = throws("an extra row is rejected", () => {
    verifySecretFreeCopy(fullPath, source, { expectedVersion: MIGRATIONS.length });
  });
  ok("rejection names the row count", /row count differs/.test(rejected?.message || ""));
}

section("options only remove data");

{
  const omitPath = join(dir, "omit-todos.db");
  writeSecretFreeCopy(sourcePath, omitPath, {
    omitTables: ["todos"],
    keepBotKey: (key) => key === "prefix",
  });
  readDb(omitPath, (copy) => {
    equal("omitted todos count", countOf(copy, "todos"), 0);
    equal("filtered bot_settings keys", settingKeys(copy).join(","), "prefix");
    equal(
      "filtered prefix value",
      copy.prepare("SELECT value FROM bot_settings WHERE key = 'prefix'").get().value,
      "!",
    );
    equal(
      "omit keeps debts",
      JSON.stringify(tableRows(copy, "debts")),
      JSON.stringify(tableRows(source, "debts")),
    );
    equal("omit still clears baileys_auth", countOf(copy, "baileys_auth"), 0);
  });
  assertNoSentinel(omitPath);

  const keepPath = join(dir, "keep-all.db");
  writeSecretFreeCopy(sourcePath, keepPath, { keepBotKey: () => true });
  readDb(keepPath, (copy) => {
    const keys = settingKeys(copy);
    ok("keep-all yields no secret key", keys.every((key) => !isSecretBotKey(key)));
    for (const key of bannedKeys) ok(`keep-all omits ${key}`, !keys.includes(key));
    ok("keep-all keeps prefix", keys.includes("prefix"));
    equal(
      "keep-all ordinary settings",
      JSON.stringify(tableRows(copy, "bot_settings")),
      JSON.stringify(tableRows(source, "bot_settings").filter((row) => !isSecretBotKey(row.key))),
    );
  });
  assertNoSentinel(keepPath);

  const emptyOmitPath = join(dir, "omit-empty.db");
  writeSecretFreeCopy(sourcePath, emptyOmitPath, { omitTables: [] });
  readDb(emptyOmitPath, (copy) => {
    equal("empty omit list clears baileys_auth", countOf(copy, "baileys_auth"), 0);
    equal("empty omit list clears qr_codes", countOf(copy, "qr_codes"), 0);
    equal(
      "empty omit list keeps debts",
      JSON.stringify(tableRows(copy, "debts")),
      JSON.stringify(tableRows(source, "debts")),
    );
  });
  assertNoSentinel(emptyOmitPath);
}

section("existing target and failed copy");

{
  const existingPath = join(dir, "existing.db");
  const payload = Buffer.from("untouched-existing-target");
  writeFileSync(existingPath, payload);
  const refused = throws("existing target is refused", () => writeSecretFreeCopy(sourcePath, existingPath));
  equal("existing target error", refused?.code, "EEXIST");
  ok("existing bytes stay", readFileSync(existingPath).equals(payload));
  ok("existing target gains no journal", !existsSync(`${existingPath}-journal`));

  const failedPath = join(dir, "failed.db");
  const failure = throws("onAfterRows aborts the copy", () => {
    writeSecretFreeCopy(sourcePath, failedPath, {
      onAfterRows() {
        throw new Error("stop after rows");
      },
    });
  });
  equal("hook error is kept", failure?.message, "stop after rows");
  ok("failed target is removed", !existsSync(failedPath));
  ok("failed journal is removed", !existsSync(`${failedPath}-journal`));
  equal("failed target leaves no companion file", filesAt(failedPath).length, 0);
}

source.close();
finish();

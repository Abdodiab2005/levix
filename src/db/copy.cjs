// Copy a database without ever writing authentication material to the target.
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const { SECRET_SETTING_KEYS } = require("../config/settings.cjs");

const SECRET_TABLES = Object.freeze(["baileys_auth", "qr_codes"]);
const secretSettings = new Set(SECRET_SETTING_KEYS);
const quote = (name) => `"${name.replaceAll('"', '""')}"`;

function isSecretBotKey(key) {
  if (typeof key !== "string") return true;
  if (key.startsWith("auth:") || key.startsWith("secret:")) return true;
  return key.startsWith("setting:") && secretSettings.has(key.slice("setting:".length));
}

function tables(database, schema) {
  return database.prepare(`SELECT name, sql FROM ${schema}.sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid`).all();
}

function writeSecretFreeCopy(sourcePath, targetPath, {
  omitTables = [], keepBotKey = () => true, onAfterRows,
} = {}) {
  const omitted = new Set([...SECRET_TABLES, ...omitTables]);
  let target;
  let created = false;
  try {
    const handle = fs.openSync(targetPath, "wx", 0o600);
    created = true;
    fs.closeSync(handle);
    target = new DatabaseSync(targetPath);
    target.exec("PRAGMA temp_store = MEMORY");
    target.exec("PRAGMA busy_timeout = 5000");
    target.prepare("ATTACH DATABASE ? AS src").run(sourcePath);
    // The first source read inside this transaction fixes one SQLite snapshot.
    target.exec("BEGIN");
    try {
      const sourceTables = tables(target, "src");
      for (const table of sourceTables) target.exec(table.sql);
      for (const table of sourceTables) {
        if (omitted.has(table.name)) continue;
        const name = quote(table.name);
        if (table.name === "bot_settings") {
          const insert = target.prepare(`INSERT INTO main.${name} SELECT * FROM src.${name} WHERE key = ?`);
          for (const { key } of target.prepare(`SELECT key FROM src.${name}`).all()) {
            if (!isSecretBotKey(key) && keepBotKey(key)) insert.run(key);
          }
        } else {
          target.exec(`INSERT INTO main.${name} SELECT * FROM src.${name}`);
        }
      }
      if (target.prepare("SELECT 1 FROM src.sqlite_master WHERE name = 'sqlite_sequence'").get()) {
        const copied = sourceTables.filter(({ name }) => !omitted.has(name)).map(({ name }) => name);
        const insert = target.prepare("INSERT INTO main.sqlite_sequence (name, seq) SELECT name, seq FROM src.sqlite_sequence WHERE name = ?");
        // INSERTs may already have advanced the target sequence.
        target.exec("DELETE FROM main.sqlite_sequence");
        for (const name of copied) insert.run(name);
      }
      onAfterRows?.();
      const objects = target.prepare(`SELECT sql FROM src.sqlite_master
        WHERE type IN ('index', 'trigger', 'view') AND sql IS NOT NULL ORDER BY rowid`).all();
      for (const { sql } of objects) target.exec(sql);
      const version = target.prepare("PRAGMA src.user_version").get().user_version;
      target.exec(`PRAGMA user_version = ${version}`);
      target.exec("COMMIT");
    } catch (error) {
      try { target.exec("ROLLBACK"); } catch {}
      throw error;
    }
    target.exec("DETACH DATABASE src");
    target.close();
    target = null;
    const file = fs.openSync(targetPath, "r");
    try { fs.fsyncSync(file); } finally { fs.closeSync(file); }
  } catch (error) {
    try { target?.close(); } catch {}
    if (created) {
      for (const suffix of ["", "-journal", "-wal", "-shm"]) {
        try { fs.rmSync(targetPath + suffix, { force: true }); } catch {}
      }
    }
    throw error;
  }
}

function verifySecretFreeCopy(targetPath, sourceDatabase, {
  expectedVersion, omitTables = [], keepBotKey = () => true,
} = {}) {
  const omitted = new Set([...SECRET_TABLES, ...omitTables]);
  const copy = new DatabaseSync(targetPath, { readOnly: true });
  try {
    if (copy.prepare("PRAGMA integrity_check").get().integrity_check !== "ok") {
      throw new Error("copy integrity check failed");
    }
    if (copy.prepare("PRAGMA user_version").get().user_version !== expectedVersion) {
      throw new Error("copy schema version differs from source");
    }
    const sourceTables = tables(sourceDatabase, "main").map(({ name }) => name);
    const copiedTables = tables(copy, "main").map(({ name }) => name);
    if (JSON.stringify(sourceTables) !== JSON.stringify(copiedTables)) {
      throw new Error("copy table schema differs from source");
    }
    for (const name of sourceTables) {
      const identifier = quote(name);
      const actual = copy.prepare(`SELECT count(*) AS n FROM ${identifier}`).get().n;
      let expected = 0;
      if (!omitted.has(name)) {
        if (name === "bot_settings") {
          expected = sourceDatabase.prepare(`SELECT key FROM ${identifier}`).all()
            .filter(({ key }) => !isSecretBotKey(key) && keepBotKey(key)).length;
        } else {
          expected = sourceDatabase.prepare(`SELECT count(*) AS n FROM ${identifier}`).get().n;
        }
      }
      if (actual !== expected) throw new Error(`copy row count differs for ${name}`);
    }
    if (sourceTables.includes("bot_settings") &&
        copy.prepare("SELECT key FROM bot_settings").all().some(({ key }) => isSecretBotKey(key))) {
      throw new Error("copy contains a secret bot setting");
    }
  } finally {
    copy.close();
  }
}

module.exports = { SECRET_TABLES, isSecretBotKey, writeSecretFreeCopy, verifySecretFreeCopy };

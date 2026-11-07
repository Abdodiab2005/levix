import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { equal, finish, ok, require, section, throws, useTempDataDir } from "./harness.mjs";

const dir = useTempDataDir("levix-reaction-migration");
const database = require("./src/db/db.cjs");
const lock = require("./src/config/lock.cjs");
const file = join(dir, "levix.db");

section("real schema-10 upgrade uses verified pre-migration backup");
const old = new DatabaseSync(file);
database.migrate(old, database.MIGRATIONS.slice(0, 10));
old.prepare("INSERT INTO bot_settings (key,value) VALUES ('prefix', ?)").run('"?"');
old.prepare("INSERT INTO baileys_auth (key,value) VALUES ('creds','pairing-sentinel')").run();
old.close();
const keyPath = join(dir, "levix.key");
writeFileSync(keyPath, "unchanged-install-key");
database.guardStartup();
lock.acquireSingleInstanceLock();
const report = await database.prepareDatabase();
equal("migration starts at schema 10", report.from, 10);
equal("migration reaches schema 11", report.to, 11);
ok("verified backup exists", existsSync(report.copyPath));
const copy = new DatabaseSync(report.copyPath, { readOnly: true });
equal("backup retains source schema", database.schemaVersion(copy), 10);
equal("backup verified", copy.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
equal("backup contains no pairing", copy.prepare("SELECT COUNT(*) AS n FROM baileys_auth").get().n, 0);
equal("pre-migration copy has no new table", copy.prepare("SELECT name FROM sqlite_master WHERE name='reaction_rules'").get(), undefined);
copy.close();
equal("prefix preserved", database.db.prepare("SELECT value FROM bot_settings WHERE key='prefix'").get().value, '"?"');
equal("pairing untouched", database.db.prepare("SELECT value FROM baileys_auth WHERE key='creds'").get().value, "pairing-sentinel");
equal("install key untouched", readFileSync(keyPath, "utf8"), "unchanged-install-key");
equal("rules empty on upgrade", database.db.prepare("SELECT COUNT(*) AS n FROM reaction_rules").get().n, 0);
const prepare = DatabaseSync.prototype.prepare;
let sweepFailures = 0;
DatabaseSync.prototype.prepare = function (sql) {
  if (sql.startsWith("DELETE FROM reaction_events")) {
    sweepFailures++;
    throw new Error("injected metadata sweep failure");
  }
  return prepare.call(this, sql);
};
try { database.sweepExpired(); ok("metadata sweep failure contained", true); }
catch { ok("metadata sweep failure contained", false); }
finally { DatabaseSync.prototype.prepare = prepare; }
equal("metadata failure was actually injected", sweepFailures, 1);
database.close(); lock.release();

section("legacy fixture upgrades and migration rollback");
for (const from of [1, 8, 10]) {
  const scratch = new DatabaseSync(":memory:");
  database.migrate(scratch, database.MIGRATIONS.slice(0, from));
  scratch.prepare("INSERT INTO bot_settings (key,value) VALUES ('fixture','kept')").run();
  database.migrate(scratch);
  equal(`schema ${from} reaches 11`, database.schemaVersion(scratch), 11);
  equal(`schema ${from} preserves data`, scratch.prepare("SELECT value FROM bot_settings WHERE key='fixture'").get().value, "kept");
  database.migrate(scratch);
  equal(`schema ${from} repeat safe`, scratch.prepare("SELECT COUNT(*) AS n FROM reaction_rules").get().n, 0);
  scratch.close();
}
const failure = new DatabaseSync(":memory:");
database.migrate(failure, database.MIGRATIONS.slice(0, 10));
throws("failure after v11 rolls back entire transaction", () => database.migrate(failure,
  [...database.MIGRATIONS, () => { throw new Error("injected after reaction migration"); }]));
equal("failed migration keeps schema 10", database.schemaVersion(failure), 10);
equal("failed migration leaves no partial table", failure.prepare("SELECT name FROM sqlite_master WHERE name='reaction_events'").get(), undefined);
failure.close();
finish();

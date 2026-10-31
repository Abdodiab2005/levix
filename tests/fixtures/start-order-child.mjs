import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);
const mode = process.argv[2];
const dir = process.env.LEVIX_DATA_DIR;
const file = join(dir, "levix.db");
const result = (value) => process.stdout.write(`RESULT ${JSON.stringify(value)}\n`);

if (mode === "imports") {
  require("../../src/db/store.cjs");
  require("../../src/config/secrets.cjs");
  require("../../src/config/settings.cjs");
  require("../../src/utils/logger.cjs");
  await import("../../src/index.js");
  result({ exists: existsSync(file) });
} else {
  const db = require("../../src/db/db.cjs");
  const lock = require("../../src/config/lock.cjs");
  const version = (database) => db.schemaVersion(database);
  const seed = (count) => {
    const database = new DatabaseSync(file);
    db.migrate(database, db.MIGRATIONS.slice(0, count));
    database.prepare("INSERT INTO bot_settings (key, value) VALUES (?, ?)").run("test:row", "kept");
    database.close();
  };
  const hash = () => createHash("sha256").update(readFileSync(file)).digest("hex");
  const marker = (database) => database.prepare("SELECT value FROM bot_settings WHERE key = 'test:row'").get()?.value;

  if (mode === "guard") {
    db.guardStartup();
    let error;
    try { db.q("PRAGMA user_version").get(); } catch (cause) { error = cause; }
    result({ code: error?.code, message: error?.message, exists: existsSync(file) });
  } else if (mode === "hold") {
    try {
      lock.acquireSingleInstanceLock();
      process.stdout.write("HELD\n");
      setInterval(() => {}, 1000);
    } catch (error) {
      result({ code: error.code });
    }
  } else if (mode === "claim") {
    try { lock.acquireSingleInstanceLock(); result({ acquired: true }); }
    catch (error) { result({ code: error.code }); }
  } else if (mode === "fresh") {
    lock.acquireSingleInstanceLock();
    const report = await db.prepareDatabase();
    result({ report, version: version(db.openWithoutMigration()), copyExists: existsSync(join(dir, "backups")) });
  } else if (mode === "old") {
    seed(1);
    lock.acquireSingleInstanceLock();
    const report = await db.prepareDatabase();
    const copy = new DatabaseSync(report.copyPath, { readOnly: true });
    const payload = {
      report, folderMode: statSync(join(dir, "backups", "pre-migration")).mode & 0o777,
      fileMode: statSync(report.copyPath).mode & 0o777,
      copyVersion: version(copy), copyIntegrity: copy.prepare("PRAGMA integrity_check").get().integrity_check,
      copyRow: marker(copy), liveVersion: version(db.openWithoutMigration()), liveRow: marker(db.openWithoutMigration()),
      copyCount: readdirSync(join(dir, "backups", "pre-migration")).filter((name) => name.endsWith(".db")).length,
    };
    copy.close();
    result(payload);
  } else if (mode === "newer") {
    const database = new DatabaseSync(file);
    database.exec(`PRAGMA user_version = ${db.MIGRATIONS.length + 1}`);
    database.close();
    const before = hash();
    lock.acquireSingleInstanceLock();
    let error;
    try { await db.prepareDatabase(); } catch (cause) { error = cause; }
    result({ code: error?.code, before, after: hash(), copied: existsSync(join(dir, "backups")) });
  } else if (mode === "copyfail") {
    seed(1);
    writeFileSync(join(dir, "backups"), "not a folder");
    const before = hash();
    lock.acquireSingleInstanceLock();
    let error;
    try { await db.prepareDatabase(); } catch (cause) { error = cause; }
    result({ code: error?.code, before, after: hash(), version: version(db.openWithoutMigration()) });
  } else if (mode === "failure") {
    seed(1);
    lock.acquireSingleInstanceLock();
    let error;
    try {
      await db.prepareDatabase([...db.MIGRATIONS.slice(0, 1),
        (database) => database.exec("CREATE TABLE intermediate (id INTEGER)"),
        () => { const failure = new Error("injected migration failure"); failure.code = "ERR_SQLITE_ERROR"; throw failure; }]);
    } catch (cause) { error = cause; }
    const database = db.openWithoutMigration();
    result({ code: error?.code, message: error?.message, version: version(database), row: marker(database),
      intermediate: database.prepare("SELECT name FROM sqlite_master WHERE name='intermediate'").get() });
  } else if (mode === "crash") {
    seed(1);
    lock.acquireSingleInstanceLock();
    await db.prepareDatabase([db.MIGRATIONS[0], () => {
      process.stdout.write("IN_TRANSACTION\n");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
    }]);
  } else if (mode === "recover") {
    const before = new DatabaseSync(file);
    const prior = { version: version(before), row: marker(before) };
    before.close();
    lock.acquireSingleInstanceLock();
    const report = await db.prepareDatabase();
    result({ prior, report, row: marker(db.openWithoutMigration()) });
  } else if (mode === "retention") {
    seed(1);
    lock.acquireSingleInstanceLock();
    const copyPaths = [];
    for (let count = 2; count <= 4; count += 1) {
      const report = await db.prepareDatabase([
        db.MIGRATIONS[0], ...Array.from({ length: count - 1 }, () => () => {}),
      ]);
      copyPaths.push(report.copyPath);
    }
    result({ copyPaths, remaining: copyPaths.map((copy) => existsSync(copy)) });
  } else if (mode === "reset-full" || mode === "reset-old") {
    seed(mode === "reset-full" ? db.MIGRATIONS.length : 1);
    const database = new DatabaseSync(file);
    database.prepare("INSERT INTO bot_settings (key, value) VALUES (?, ?)").run("auth:password", "saved");
    database.close();
    result({ version: mode === "reset-full" ? db.MIGRATIONS.length : 1 });
  } else if (mode === "password") {
    const database = new DatabaseSync(file, { readOnly: true });
    result({ version: version(database), password: database.prepare("SELECT value FROM bot_settings WHERE key='auth:password'").get()?.value ?? null, sha256: hash() });
    database.close();
  } else if (mode === "domain-cli-held" || mode === "domain-free") {
    const before = hash();
    const cli = await import("../../src/cli.js");
    let entered = false;
    let schemaAtEntry = null;
    const code = mode === "domain-cli-held"
      ? await cli.main(["node", "levix", "domain", "invalid"])
      : await cli.withCliDatabase(async () => {
        entered = true;
        schemaAtEntry = version(db.openWithoutMigration());
        const { runDomainCommand } = await import("../../src/domain/command.js");
        // A hosting panel is detected, so this path only persists the domain.
        // No DNS lookup, proxy edit, service reload or network request runs.
        const system = {
          exists: (path) => path === "/usr/local/psa",
          which: () => false,
          listeners: () => [],
        };
        return runDomainCommand({ domain: "bot.example.com", assumeYes: true, system });
      });
    const after = hash();
    const database = new DatabaseSync(file, { readOnly: true });
    const raw = database.prepare("SELECT value FROM bot_settings WHERE key='setting:public_domain'").get()?.value;
    result({ code, entered, schemaAtEntry, version: version(database),
      domain: raw ? JSON.parse(raw) : null, before, after,
      copied: existsSync(join(dir, "backups", "pre-migration")) });
    database.close();
  }
}

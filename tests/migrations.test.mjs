// Schema migrations: safe from empty, safe to repeat, safe to interrupt.
//
// Upgrading Levix means running new code against a database somebody's bot has
// been using for months. Every guarantee below is one an upgrade depends on.

import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useTempDataDir, require, section, ok, equal, throws, finish } from "./harness.mjs";

useTempDataDir("levix-migrations");

const { db, migrate, MIGRATIONS } = require("./src/db/db.cjs");

const EXPECTED_TABLES = [
  "ai_history",
  "baileys_auth",
  "bot_settings",
  "debts",
  "forward_scores",
  "group_settings",
  "lid_mapping",
  "notes",
  "qr_codes",
  "schedules",
  "todos",
  "user_metadata",
  "warnings",
];

const tablesOf = (database) =>
  database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((row) => row.name);

const versionOf = (database) => database.prepare("PRAGMA user_version").get().user_version;

function scratchDatabase() {
  const file = join(mkdtempSync(join(tmpdir(), "levix-mig-")), "test.db");
  const database = new DatabaseSync(file);
  database.exec("PRAGMA journal_mode = WAL");
  return database;
}

// --- from empty -----------------------------------------------------------

section("an empty database migrates to the current schema");

equal("the live database is at the latest version", versionOf(db), MIGRATIONS.length);
for (const table of EXPECTED_TABLES) {
  ok(`table ${table} exists`, tablesOf(db).includes(table));
}

{
  const fresh = scratchDatabase();
  equal("a brand new file starts at version 0", versionOf(fresh), 0);
  migrate(fresh);
  equal("…and ends at the latest version", versionOf(fresh), MIGRATIONS.length);
  const tables = tablesOf(fresh);
  ok("…with every table", EXPECTED_TABLES.every((t) => tables.includes(t)));
  fresh.close();
}

// --- idempotence ----------------------------------------------------------

section("running it again changes nothing");

{
  const database = scratchDatabase();
  migrate(database);
  const firstTables = tablesOf(database).join(",");

  // Three more times, the way three restarts would.
  migrate(database);
  migrate(database);
  migrate(database);

  equal("the version is unchanged", versionOf(database), MIGRATIONS.length);
  equal("the tables are unchanged", tablesOf(database).join(","), firstTables);

  // And data placed before the re-runs is still there afterwards.
  database.prepare("INSERT INTO bot_settings (key, value) VALUES (?, ?)").run("k", '"v"');
  migrate(database);
  equal(
    "existing rows survive a re-run",
    database.prepare("SELECT value FROM bot_settings WHERE key = 'k'").get().value,
    '"v"'
  );
  database.close();
}

// --- a version from the future -------------------------------------------

section("a database written by a newer Levix is left alone");

{
  const database = scratchDatabase();
  migrate(database);
  database.exec(`PRAGMA user_version = ${MIGRATIONS.length + 5}`);
  migrate(database);
  equal("the version is not rewound", versionOf(database), MIGRATIONS.length + 5);
  database.close();
}

// --- interruption ---------------------------------------------------------

section("a migration that fails leaves no half-applied schema");

{
  const database = scratchDatabase();

  const failing = [
    ...MIGRATIONS,
    (target) => {
      target.exec("CREATE TABLE half_applied (id INTEGER PRIMARY KEY)");
      // Whatever goes wrong — a bad statement, a crash, a full disk — has to
      // take the CREATE above with it.
      throw new Error("boom, halfway through");
    },
  ];

  throws("the failure propagates rather than being swallowed", () =>
    migrate(database, failing)
  );

  equal(
    "the version still says the last good migration",
    versionOf(database),
    MIGRATIONS.length
  );
  ok(
    "the table the failed step created is gone",
    !tablesOf(database).includes("half_applied")
  );

  // The decisive part: the next start must be able to finish the job.
  const fixed = [
    ...MIGRATIONS,
    (target) => target.exec("CREATE TABLE half_applied (id INTEGER PRIMARY KEY)"),
  ];
  migrate(database, fixed);
  equal("a retry completes", versionOf(database), fixed.length);
  ok("…and creates the table", tablesOf(database).includes("half_applied"));

  database.close();
}

// --- a second reader ------------------------------------------------------

section("a second connection sees committed data");

{
  const dir = mkdtempSync(join(tmpdir(), "levix-mig-shared-"));
  const file = join(dir, "shared.db");

  const first = new DatabaseSync(file);
  first.exec("PRAGMA journal_mode = WAL");
  migrate(first);
  first.prepare("INSERT INTO bot_settings (key, value) VALUES (?, ?)").run("shared", '"yes"');

  const second = new DatabaseSync(file);
  equal("the second connection reads the same version", versionOf(second), MIGRATIONS.length);
  equal(
    "…and the committed row",
    second.prepare("SELECT value FROM bot_settings WHERE key = 'shared'").get().value,
    '"yes"'
  );
  // Opening a database that is already at the latest version must be a no-op,
  // not a second attempt to create everything.
  migrate(second);
  equal("…and migrating from it is a no-op", versionOf(second), MIGRATIONS.length);

  first.close();
  second.close();
}

finish();

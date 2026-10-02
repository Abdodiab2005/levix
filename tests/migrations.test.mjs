// Schema migrations: safe from empty, safe to repeat, safe to interrupt.
//
// Upgrading Levix means running new code against a database somebody's bot has
// been using for months. Every guarantee below is one an upgrade depends on.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { equal, finish, ok, require, section, throws, useTempDataDir } from "./harness.mjs";

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
  "stickers",
  "sticker_packs",
  "sticker_pack_items",
];

const tablesOf = (database) =>
  database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((row) => row.name);

const versionOf = (database) => database.prepare("PRAGMA user_version").get().user_version;
const columnsOf = (database, table) =>
  database
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((column) => column.name);

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
  ok(
    "…with every table",
    EXPECTED_TABLES.every((t) => tables.includes(t)),
  );
  const scheduleColumns = columnsOf(fresh, "schedules");
  for (const column of ["last_run_at", "last_delivery_status", "last_error"]) {
    ok(`…with schedule column ${column}`, scheduleColumns.includes(column));
  }
  ok("…with user_metadata.saved_name", columnsOf(fresh, "user_metadata").includes("saved_name"));
  fresh.close();
}

section("an existing database gains saved_name without losing users");

{
  const database = scratchDatabase();
  // v1–v3. Pinned, not "everything but the last": appending v5 must not make
  // this migration include v4, or saved_name would already be there.
  migrate(database, MIGRATIONS.slice(0, 3));
  ok("saved_name is not there yet", !columnsOf(database, "user_metadata").includes("saved_name"));
  database
    .prepare(
      `INSERT INTO user_metadata (user_jid, phone_number, is_owner, is_admin, first_seen, last_seen, display_name)
       VALUES (?, ?, 0, 0, ?, ?, ?)`,
    )
    .run("201012345678@s.whatsapp.net", "201012345678", 1, 1, "Ali");

  migrate(database);
  equal("the upgrade reaches the latest version", versionOf(database), MIGRATIONS.length);
  ok(
    "saved_name exists after upgrade",
    columnsOf(database, "user_metadata").includes("saved_name"),
  );
  const row = database
    .prepare("SELECT * FROM user_metadata WHERE user_jid = ?")
    .get("201012345678@s.whatsapp.net");
  equal("the display name survives", row.display_name, "Ali");
  equal("saved_name starts empty", row.saved_name, null);
  database.close();
}

section("an existing v4 database gains the sticker tables without losing users");

{
  const database = scratchDatabase();
  migrate(database, MIGRATIONS.slice(0, 4));
  ok("stickers are not there yet", !tablesOf(database).includes("stickers"));
  ok("saved_name is already there", columnsOf(database, "user_metadata").includes("saved_name"));
  database
    .prepare(
      `INSERT INTO user_metadata (user_jid, phone_number, is_owner, is_admin, first_seen, last_seen, display_name)
       VALUES (?, ?, 0, 0, ?, ?, ?)`,
    )
    .run("201098765432@s.whatsapp.net", "201098765432", 2, 2, "Nour");

  migrate(database);
  equal("the upgrade reaches the latest version", versionOf(database), MIGRATIONS.length);
  for (const table of ["stickers", "sticker_packs", "sticker_pack_items"]) {
    ok(`table ${table} exists after upgrade`, tablesOf(database).includes(table));
  }
  const indexes = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
    .all()
    .map((row) => row.name);
  ok("owner/created index exists", indexes.includes("idx_stickers_owner_created"));
  ok("items-by-sticker index exists", indexes.includes("idx_sticker_pack_items_sticker"));
  const fks = database.prepare("PRAGMA foreign_key_list(sticker_pack_items)").all();
  ok(
    "pack items cascade from the pack",
    fks.some((fk) => fk.table === "sticker_packs" && fk.on_delete === "CASCADE"),
  );
  ok(
    "pack items cascade from the sticker",
    fks.some((fk) => fk.table === "stickers" && fk.on_delete === "CASCADE"),
  );
  const row = database
    .prepare("SELECT display_name FROM user_metadata WHERE user_jid = ?")
    .get("201098765432@s.whatsapp.net");
  equal("the user survives the sticker migration", row.display_name, "Nour");
  database.close();
}

section("an existing v1 schedule survives the v2 upgrade");

{
  const database = scratchDatabase();
  migrate(database, [MIGRATIONS[0]]);
  database
    .prepare(
      `INSERT INTO schedules
        (id, type, target_jid, message, cron_string, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("old-weekly", "recurring", "1@g.us", "hello", "0 9 * * 1", "active", 1);

  migrate(database);
  equal("the upgrade reaches the latest version", versionOf(database), MIGRATIONS.length);
  const row = database.prepare("SELECT * FROM schedules WHERE id = ?").get("old-weekly");
  equal("the old message survives", row.message, "hello");
  equal("new delivery state starts empty", row.last_delivery_status, null);
  database.close();
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
    '"v"',
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

  throws("the failure propagates rather than being swallowed", () => migrate(database, failing));

  equal("the version still says the last good migration", versionOf(database), MIGRATIONS.length);
  ok("the table the failed step created is gone", !tablesOf(database).includes("half_applied"));

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
    '"yes"',
  );
  // Opening a database that is already at the latest version must be a no-op,
  // not a second attempt to create everything.
  migrate(second);
  equal("…and migrating from it is a no-op", versionOf(second), MIGRATIONS.length);

  first.close();
  second.close();
}

finish();

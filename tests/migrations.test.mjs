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
  "sticker_owners",
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
  for (const table of ["stickers", "sticker_owners", "sticker_packs", "sticker_pack_items"]) {
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

section("v5 sticker owners become sticker_owners ids");

{
  const phoneOne = "201111111111@s.whatsapp.net";
  const phoneZero = "201000000000@s.whatsapp.net";
  const phoneTwo = "201222222222@s.whatsapp.net";
  const phoneMerge = "201333333333@s.whatsapp.net";
  const lidOne = "555555555555@lid";
  const lidDirect = "444444444444@lid";
  const lidMerge = "333333333333@lid";
  const lidKept = "666666666666@lid";
  const lidOther = "777777777777@lid";
  const lidDevice = "888888888888@lid";
  const idSelf = "a000000000000001";
  const idDirect = "a000000000000002";
  const idOne = "a000000000000003";
  const idZero = "a000000000000004";
  const idTwo = "a000000000000005";
  const idKept = "a000000000000006";
  const idJunk = "a000000000000007";
  const idDevice = "a000000000000008";
  const idDup = "a00000000000000a";
  const idDrop = "a00000000000000b";
  const idC = "a00000000000000c";
  const idD = "a00000000000000d";
  const packZero = "b000000000000001";
  const packCats = "b000000000000002";
  const packCatsLater = "b000000000000003";
  const packDogs = "b000000000000004";

  const database = scratchDatabase();
  database.exec("PRAGMA foreign_keys = ON");
  migrate(database, MIGRATIONS.slice(0, 5));
  equal("the fixture starts at v5", versionOf(database), 5);

  const insertSticker = database.prepare(
    `INSERT INTO stickers (
       id, owner, sha256, name, animated, file_size, source,
       is_favorite, created_at, updated_at, last_used_at
     ) VALUES (?, ?, ?, ?, 0, 8, 'PANEL_UPLOAD', ?, ?, ?, ?)`,
  );
  const insertPack = database.prepare(
    `INSERT INTO sticker_packs (id, owner, name, name_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertItem = database.prepare(
    `INSERT INTO sticker_pack_items (pack_id, sticker_id, position, added_at)
     VALUES (?, ?, ?, ?)`,
  );
  const insertLid = database.prepare(
    `INSERT INTO lid_mapping (lid, pn, device_index, updated_at) VALUES (?, ?, 0, 1)`,
  );
  const sticker = (id, owner, sha, name, created, favorite = 0, lastUsed = null) => {
    insertSticker.run(id, owner, sha, name, favorite, created, created, lastUsed);
  };

  sticker(idSelf, "self", "sha-self", "Self", 1);
  sticker(idDirect, lidDirect, "sha-direct", "Direct", 2);
  sticker(idOne, "201111111111:8@s.whatsapp.net", "sha-one", "One", 3);
  sticker(idZero, phoneZero, "sha-zero", "Orphan", 4, 1, 9);
  insertPack.run(packZero, phoneZero, "Orphans", "orphans", 4, 4);
  insertItem.run(packZero, idZero, 0, 4);
  sticker(idTwo, phoneTwo, "sha-two", "Ambiguous", 5);
  sticker(idKept, lidKept, "sha-kept", "Kept", 6);
  sticker(idJunk, "not-a-jid", "sha-junk", "Junk", 7);
  sticker(idDevice, "888888888888:9@lid", "sha-device", "Device", 8);
  sticker(idDup, lidMerge, "sha-dup", "", 1000, 0, 1500);
  sticker(idC, lidMerge, "sha-c", "C", 1100);
  sticker(idDrop, phoneMerge, "sha-dup", "Merged", 2000, 1, 5000);
  sticker(idD, phoneMerge, "sha-d", "D", 2100);
  insertPack.run(packCats, lidMerge, "Cats", "cats", 1000, 1000);
  insertItem.run(packCats, idDup, 0, 1000);
  insertItem.run(packCats, idC, 1, 1001);
  insertPack.run(packCatsLater, phoneMerge, "Cats", "cats", 2000, 2000);
  insertItem.run(packCatsLater, idDrop, 0, 2000);
  insertItem.run(packCatsLater, idD, 1, 2001);
  insertPack.run(packDogs, phoneMerge, "Dogs", "dogs", 2500, 2500);
  insertItem.run(packDogs, idD, 0, 2500);
  // Two raw rows, one normalized LID: the phone library belongs to that person.
  insertLid.run("555555555555:2@lid", phoneOne);
  insertLid.run(lidOne, "201111111111:4@s.whatsapp.net");
  insertLid.run(lidKept, phoneTwo);
  insertLid.run(lidOther, "201222222222:1@s.whatsapp.net");
  insertLid.run(lidMerge, phoneMerge);

  migrate(database);
  equal("v6 is the current version", versionOf(database), MIGRATIONS.length);

  const owners = database.prepare("SELECT * FROM sticker_owners").all();
  ok(
    "every owner id is 16 hex characters",
    owners.length > 0 && owners.every((row) => /^[0-9a-f]{16}$/.test(row.id)),
  );
  equal(
    "one self row",
    database.prepare("SELECT COUNT(*) AS n FROM sticker_owners WHERE kind = 'self'").get().n,
    1,
  );
  const byAccount = (account) =>
    database.prepare("SELECT * FROM sticker_owners WHERE account = ?").get(account) || null;
  const byLegacy = (legacy) =>
    database.prepare("SELECT * FROM sticker_owners WHERE legacy_key = ?").all(legacy);
  const stickersOf = (ownerId) =>
    database.prepare("SELECT * FROM stickers WHERE owner = ? ORDER BY id").all(ownerId);
  const itemIds = (packId) =>
    database
      .prepare("SELECT sticker_id FROM sticker_pack_items WHERE pack_id = ? ORDER BY position ASC")
      .all(packId)
      .map((row) => row.sticker_id);
  const positions = (packId) =>
    database
      .prepare("SELECT position FROM sticker_pack_items WHERE pack_id = ? ORDER BY position ASC")
      .all(packId)
      .map((row) => row.position);

  const self = database.prepare("SELECT * FROM sticker_owners WHERE kind = 'self'").get();
  equal("legacy self stays unbound", self.account, null);
  equal("legacy self remembers its key", self.legacy_key, "self");
  equal("the self sticker moved", stickersOf(self.id).length, 1);
  equal("the word self is no longer an owner", stickersOf("self").length, 0);

  const direct = byAccount(lidDirect);
  equal("a LID key becomes that account", direct?.kind, "user");
  equal("a LID key remembers the LID", direct?.legacy_key, lidDirect);
  equal("the LID sticker moved", stickersOf(direct.id)[0].id, idDirect);

  const one = byAccount(lidOne);
  equal("one mapped LID claims the phone library", one?.kind, "user");
  equal("that row remembers the normalized phone", one?.legacy_key, phoneOne);
  equal("the device-suffixed phone sticker moved", stickersOf(one.id)[0].id, idOne);
  equal(
    "the raw phone string is no longer an owner",
    stickersOf("201111111111:8@s.whatsapp.net").length,
    0,
  );

  const orphanRows = byLegacy(phoneZero);
  equal("a phone with no LID is one row", orphanRows.length, 1);
  equal("a phone with no LID stays unbound", orphanRows[0].account, null);
  equal("a phone with no LID is not self", orphanRows[0].kind, "user");
  equal("the orphan sticker is kept", stickersOf(orphanRows[0].id)[0].name, "Orphan");
  equal("the orphan favorite is kept", stickersOf(orphanRows[0].id)[0].is_favorite, 1);
  equal("the phone is not an account anyone can open", byAccount(phoneZero), null);
  const orphanPack = database.prepare("SELECT * FROM sticker_packs WHERE id = ?").get(packZero);
  equal("the orphan pack moved with the library", orphanPack.owner, orphanRows[0].id);
  equal("the orphan pack still holds its sticker", itemIds(packZero).join(","), idZero);

  const ambiguous = byLegacy(phoneTwo);
  equal("two LIDs leave the phone library unbound", ambiguous[0].account, null);
  equal("the ambiguous library is kept", stickersOf(ambiguous[0].id)[0].id, idTwo);
  const kept = byAccount(lidKept);
  equal("the LID that also had its own library stays that LID", kept.legacy_key, lidKept);
  equal(
    "the ambiguous phone sticker did not join it",
    stickersOf(kept.id)
      .map((row) => row.id)
      .join(","),
    idKept,
  );
  equal("the second LID did not gain a library", byAccount(lidOther), null);

  const device = byAccount(lidDevice);
  equal("a device-suffixed LID normalizes", device.account, lidDevice);
  equal("its legacy key is the normalized LID", device.legacy_key, lidDevice);
  equal("the raw device LID is no longer an owner", stickersOf("888888888888:9@lid").length, 0);

  const junk = byLegacy("not-a-jid");
  equal("anything else stays unbound", junk[0].account, null);
  equal("anything else keeps its legacy key", junk[0].legacy_key, "not-a-jid");
  equal("the junk sticker is kept", stickersOf(junk[0].id)[0].id, idJunk);

  const merged = byAccount(lidMerge);
  equal("a LID and its phone merge into one user", merged.kind, "user");
  equal("the merged legacy key is the LID", merged.legacy_key, lidMerge);
  equal("the duplicate sha left three stickers", stickersOf(merged.id).length, 3);
  const keptDup = database.prepare("SELECT * FROM stickers WHERE id = ?").get(idDup);
  equal("the earlier sticker is the one kept", keptDup.owner, merged.id);
  equal("a non-empty name is carried over", keptDup.name, "Merged");
  equal("favorite is the OR of the two rows", keptDup.is_favorite, 1);
  equal("last use is the latest", keptDup.last_used_at, 5000);
  equal("created time is the earliest", keptDup.created_at, 1000);
  equal(
    "the later duplicate row is gone",
    database.prepare("SELECT id FROM stickers WHERE id = ?").get(idDrop) || null,
    null,
  );
  const cats = database.prepare("SELECT * FROM sticker_packs WHERE id = ?").get(packCats);
  equal("the earlier pack is kept", cats.owner, merged.id);
  equal(
    "same-named pack items append in order",
    itemIds(packCats).join(","),
    [idDup, idC, idD].join(","),
  );
  equal("pack positions are renumbered", positions(packCats).join(","), "0,1,2");
  equal(
    "the later pack is gone",
    database.prepare("SELECT id FROM sticker_packs WHERE id = ?").get(packCatsLater) || null,
    null,
  );
  const dogs = database.prepare("SELECT * FROM sticker_packs WHERE id = ?").get(packDogs);
  equal("a pack with its own name survives", dogs.owner, merged.id);
  equal("the surviving pack keeps its item", itemIds(packDogs).join(","), idD);
  equal("the surviving pack positions start at 0", positions(packDogs).join(","), "0");

  equal(
    "no sticker still uses a v5 owner",
    database
      .prepare(
        `SELECT COUNT(*) AS n FROM stickers
         WHERE owner NOT IN (SELECT id FROM sticker_owners)`,
      )
      .get().n,
    0,
  );
  equal(
    "no pack still uses a v5 owner",
    database
      .prepare(
        `SELECT COUNT(*) AS n FROM sticker_packs
         WHERE owner NOT IN (SELECT id FROM sticker_owners)`,
      )
      .get().n,
    0,
  );
  equal(
    "no pack item dangles",
    database
      .prepare(
        `SELECT COUNT(*) AS n FROM sticker_pack_items i
         WHERE NOT EXISTS (SELECT 1 FROM stickers s WHERE s.id = i.sticker_id)
            OR NOT EXISTS (SELECT 1 FROM sticker_packs p WHERE p.id = i.pack_id)`,
      )
      .get().n,
    0,
  );
  equal(
    "eleven stickers remain",
    database.prepare("SELECT COUNT(*) AS n FROM stickers").get().n,
    11,
  );
  equal(
    "three packs remain",
    database.prepare("SELECT COUNT(*) AS n FROM sticker_packs").get().n,
    3,
  );

  const indexes = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
    .all()
    .map((row) => row.name);
  ok("the single-self index exists", indexes.includes("idx_sticker_owners_self"));
  const rejected = throws("a second self row is rejected", () => {
    database
      .prepare(
        `INSERT INTO sticker_owners (id, kind, account, legacy_key, created_at)
         VALUES ('ffffffffffffffff', 'self', NULL, NULL, 1)`,
      )
      .run();
  });
  ok("the partial unique index rejects it", /UNIQUE/i.test(rejected?.message || ""));

  const ownerCount = database.prepare("SELECT COUNT(*) AS n FROM sticker_owners").get().n;
  const stickerCount = database.prepare("SELECT COUNT(*) AS n FROM stickers").get().n;
  migrate(database);
  equal(
    "running v6 again keeps the owner rows",
    database.prepare("SELECT COUNT(*) AS n FROM sticker_owners").get().n,
    ownerCount,
  );
  equal(
    "running v6 again keeps the stickers",
    database.prepare("SELECT COUNT(*) AS n FROM stickers").get().n,
    stickerCount,
  );
  database.close();

  const empty = scratchDatabase();
  migrate(empty, MIGRATIONS.slice(0, 5));
  migrate(empty);
  equal("an empty v5 library still reaches v6", versionOf(empty), MIGRATIONS.length);
  equal(
    "an empty v5 library creates no owners",
    empty.prepare("SELECT COUNT(*) AS n FROM sticker_owners").get().n,
    0,
  );
  empty.close();
}

finish();

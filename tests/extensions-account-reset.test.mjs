import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { equal, finish, ok, require, section, useTempDataDir } from "./harness.mjs";

const dir = useTempDataDir("levix-extensions-account-reset");
const store = require("./src/db/store.cjs");
const { db, migrate } = require("./src/db/db.cjs");
const { activatePendingIfMatching, readLastActivation } = require("./src/backup/activation.cjs");
const { readJournal } = require("./src/backup/journal.cjs");
const { WhatsAppSession } = await import("../src/core/session.js");
const silent = { info() {}, warn() {}, error() {}, debug() {} };

function seedStorage() {
  store.setExtStorage("levix-plus", "acct", "first", ["old chat"]);
  store.setExtStorage("levix-plus", "acct", "second", ["another old chat"]);
}

function failWipe() {
  db.exec(`CREATE TEMP TRIGGER fail_ext_wipe BEFORE DELETE ON bot_settings
    WHEN OLD.key = 'ext:levix-plus:acct:second'
    BEGIN SELECT RAISE(ABORT, 'required extension wipe failed'); END`);
}

section("failed required extension cleanup keeps unlink pending and blocks pairing");
{
  seedStorage();
  failWipe();
  let sockets = 0;
  const session = new WhatsAppSession({
    log: silent,
    createSocket: async () => {
      sockets += 1;
      throw new Error("must not pair");
    },
  });
  try {
    const failed = await session.logout();
    equal("unlink reports required cleanup failure", failed.reason, "unlink_incomplete");
    equal("unlink marker survives", store.isUnlinkPending(), true);
    ok("failed row still on disk", store.getExtStorage("levix-plus", "acct", "second"));
    equal("pairing stays blocked", (await session.start()).reason, "unlink_incomplete");
    equal("no socket opened", sockets, 0);
    db.exec("DROP TRIGGER fail_ext_wipe");
    equal("retry completes unlink", (await session.logout()).state, "logged_out");
    equal("retry removes pending marker", store.isUnlinkPending(), false);
    equal("retry removes old account scope", store.listExtStorage("levix-plus", "acct").length, 0);
  } finally {
    db.exec("DROP TRIGGER IF EXISTS fail_ext_wipe");
    await session.shutdown();
  }
}

section("restore rolls back tables and extension rows when required cleanup fails");
{
  const pn = "201000000012@s.whatsapp.net";
  const id = "a".repeat(32);
  const pending = join(dir, "restore", "pending");
  store.authWrite("creds", JSON.stringify({ me: { id: pn }, registered: true }));
  store.saveChatHistory("live", [{ role: "user", parts: [{ text: "live" }] }]);
  seedStorage();
  mkdirSync(pending, { recursive: true });
  const copy = new DatabaseSync(join(pending, "levix.db"));
  try {
    migrate(copy);
    copy
      .prepare("INSERT INTO ai_history (chat_id, history, updated_at) VALUES ('backup', '[]', 1)")
      .run();
  } finally {
    copy.close();
  }
  for (const name of ["memory", "stickers", "media/schedules"]) {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, "probe"), "live");
    mkdirSync(join(pending, "files", name), { recursive: true });
    writeFileSync(join(pending, "files", name, "probe"), "backup");
  }
  writeFileSync(join(pending, "pending.json"), JSON.stringify({ id, account: { lid: null, pn } }));
  failWipe();
  try {
    equal("restore refuses failed cleanup", activatePendingIfMatching(), false);
    equal(
      "old account tables preserved",
      db.prepare("SELECT chat_id FROM ai_history").get()?.chat_id,
      "live",
    );
    equal(
      "earlier extension deletion rolled back",
      store.getExtStorage("levix-plus", "acct", "first")?.[0],
      "old chat",
    );
    equal(
      "failing extension row preserved",
      store.getExtStorage("levix-plus", "acct", "second")?.[0],
      "another old chat",
    );
    equal("old files restored", readFileSync(join(dir, "memory", "probe"), "utf8"), "live");
    equal("no activation marker committed", store.getBotSetting("restore:activated"), null);
    equal("failure recorded", readLastActivation().status, "failed");
    ok("pending restore retained", existsSync(join(pending, "pending.json")));
    equal("rollback clears journal", readJournal(), null);
    db.exec("DROP TRIGGER fail_ext_wipe");
    equal("retry activates after cleanup recovers", activatePendingIfMatching(), true);
    equal(
      "restored rows committed",
      db.prepare("SELECT chat_id FROM ai_history").get()?.chat_id,
      "backup",
    );
    equal("old extension scope wiped", store.listExtStorage("levix-plus", "acct").length, 0);
  } finally {
    db.exec("DROP TRIGGER IF EXISTS fail_ext_wipe");
  }
}

finish();

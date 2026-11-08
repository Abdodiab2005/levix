import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { equal, finish, ok, require, section, throws, useTempDataDir, ROOT } from "./harness.mjs";

const dir = useTempDataDir("levix-reaction-execution-migration");
const database = require("./src/db/db.cjs");
const lock = require("./src/config/lock.cjs");
const file = join(dir, "levix.db");
const old = new DatabaseSync(file);
database.migrate(old, database.MIGRATIONS.slice(0, 11));
old.exec("INSERT INTO reaction_rules(id,chat_jid,enabled) VALUES('legacy','100@g.us',1)");
old.exec("INSERT INTO bot_settings(key,value) VALUES('prefix','\"?\"')");
old.exec("INSERT INTO baileys_auth(key,value) VALUES('creds','pairing-sentinel')");
old.close();
writeFileSync(join(dir, "levix.key"), "key-sentinel");
section("schema 11 upgrade, verified backup and preserved account data");
database.guardStartup();
lock.acquireSingleInstanceLock();
const result = await database.prepareDatabase();
equal("upgrade starts at 11", result.from, 11);
equal("upgrade finishes at 12", result.to, 12);
ok("verified pre-migration backup exists", existsSync(result.copyPath));
const backup = new DatabaseSync(result.copyPath, { readOnly: true });
equal("backup schema is 11", database.schemaVersion(backup), 11);
equal("backup integrity", backup.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
equal(
  "backup excludes pairing",
  backup.prepare("SELECT COUNT(*) AS n FROM baileys_auth").get().n,
  0,
);
equal(
  "backup retains original seam configuration",
  backup.prepare("SELECT enabled FROM reaction_rules").get().enabled,
  1,
);
backup.close();
const { db } = database;
equal(
  "legacy seam requires fresh opt-in",
  db.prepare("SELECT enabled FROM reaction_rules").get().enabled,
  0,
);
equal(
  "legacy epoch absent",
  db.prepare("SELECT enabled_at FROM reaction_rules").get().enabled_at,
  null,
);
equal(
  "prefix preserved",
  db.prepare("SELECT value FROM bot_settings WHERE key='prefix'").get().value,
  '"?"',
);
equal(
  "pairing preserved",
  db.prepare("SELECT value FROM baileys_auth WHERE key='creds'").get().value,
  "pairing-sentinel",
);
equal("key untouched", readFileSync(join(dir, "levix.key"), "utf8"), "key-sentinel");
const content = require("./src/backup/content.cjs");
content.classifyTables(db);
ok(
  "execution claims excluded from backups",
  content.EXCLUDED_TABLES.includes("reaction_executions"),
);
ok("rate budgets excluded from backups", content.EXCLUDED_TABLES.includes("reaction_budgets"));

section("internal configuration is disabled by default and revisioned");
const store = require("./src/db/store.cjs");
const definition = {
  version: 1,
  emoji: "👍",
  transitions: ["add"],
  originalTypes: ["text"],
  senders: { role: "any", ids: [] },
  action: "ping",
  destination: { mode: "same_chat" },
};
const rule = store.saveReactionRule({ id: "test", chatJid: "100@g.us", definition });
equal("new rule off", rule.enabled, 0);
equal("new rule epoch null", rule.enabled_at, null);
equal("global switch off by default", store.getBotSetting("reaction:enabled", false), false);
const enabled = store.setReactionRuleEnabled("test", true, 1000);
equal("enable records epoch", enabled.enabled_at, 1000);
const twice = store.setReactionRuleEnabled("test", true, 1000);
ok("same millisecond enable rotates revision", twice.revision !== enabled.revision);
const edited = store.saveReactionRule({ id: "test", chatJid: "100@g.us", definition });
equal("edit disables rule", edited.enabled, 0);
ok("edit rotates revision", edited.revision !== twice.revision);
throws("invalid switch rejected", () => store.setReactionAutomationEnabled("true"));
throws("invalid rule cannot be enabled", () => store.setReactionRuleEnabled("legacy", true, 1000));

section("explicit role writes cannot confuse LID and phone digits");
for (const [number, throughSetter] of [["800000123", true], ["800000124", false]]) {
  const lid = `${number}@lid`;
  const pn = `${number}@s.whatsapp.net`;
  store.saveUserMetadata({ jid: lid, displayName: "unrelated LID" });
  if (throughSetter) store.setUserRole(pn, "owner", true);
  else store.saveUserMetadata({ jid: pn, phone: number, isOwner: true });
  equal(`role write preserves unrelated LID ${number}`, db.prepare("SELECT is_owner FROM user_metadata WHERE user_jid=?").get(lid)?.is_owner, 0);
  equal(`role goes to exact phone ${number}`, db.prepare("SELECT is_owner FROM user_metadata WHERE user_jid=?").get(pn)?.is_owner, 1);
}

const pnRole = "800000125@s.whatsapp.net";
const lidRole = "900000125@lid";
store.saveUserMetadata({ jid: pnRole });
store.saveUserMetadata({ jid: lidRole });
store.storeLidPnMapping(lidRole, pnRole);
store.setUserRole(pnRole, "admin", true);
ok("mapped aliases grant same identity", store.verifiedUserRoles([pnRole, lidRole]).isBotAdmin);
store.setUserRole(lidRole, "admin", false);
equal("mapped alias revocation removes every primary grant", store.verifiedUserRoles([pnRole, lidRole]).isBotAdmin, false);
store.setUserRole(lidRole, "owner", true);
store.saveUserMetadata({ jid: pnRole, isOwner: false });
equal("direct role revocation covers mapped primary aliases", store.verifiedUserRoles([pnRole, lidRole]).isOwner, false);

section("durable event/rule/action claims and bounded budgets");
const time = 10000;
let n = 0;
function claim(extra = {}) {
  const eventKey = `event-${n++}`;
  db.prepare("INSERT INTO reaction_events VALUES(?,?)").run(eventKey, time + 100000);
  return store.claimReactionExecution(
    {
      eventKey,
      ruleKey: `rule-${eventKey}`,
      actionKey: `action-${eventKey}`,
      expiresAt: time + 100000,
      budgets: [{ key: "actor-hash", limit: 3 }],
      ...extra,
    },
    time,
  );
}
equal("first claimed", claim(), "CLAIMED");
equal("event duplicate rejected", claim({ eventKey: "event-0" }), "DUPLICATE");
equal("action duplicate rejected", claim({ actionKey: "action-event-0" }), "DUPLICATE");
equal("rule duplicate rejected", claim({ ruleKey: "rule-event-0" }), "DUPLICATE");
equal("second claimed", claim(), "CLAIMED");
equal("third claimed", claim(), "CLAIMED");
equal("fourth refused", claim(), "RATE_LIMIT");
equal(
  "refusal has no partial claim",
  db.prepare("SELECT COUNT(*) AS n FROM reaction_executions").get().n,
  3,
);
equal(
  "no unclaimed event accepted",
  store.claimReactionExecution(
    { eventKey: "missing", ruleKey: "r", actionKey: "a", expiresAt: time + 10, budgets: [] },
    time,
  ),
  "EVENT_MISSING",
);
const persisted = spawnSync(
  process.execPath,
  [
    "--input-type=module",
    "-e",
    `
  import {createRequire} from 'node:module';
  const require=createRequire(${JSON.stringify(join(ROOT, "package.json"))});
  const store=require('./src/db/store.cjs');
  const result=store.claimReactionExecution({eventKey:'event-0',ruleKey:'restart-rule',actionKey:'restart-action',expiresAt:110000,budgets:[]},10000);
  console.log('RESTART:'+result);
`,
  ],
  { cwd: ROOT, env: { ...process.env, LEVIX_DATA_DIR: dir }, encoding: "utf8" },
);
equal("fresh process healthy", persisted.status, 0);
ok("fresh process cannot replay", persisted.stdout.includes("RESTART:DUPLICATE"));

// Resource saturation must preserve every live claim.
db.exec("DELETE FROM reaction_executions; DELETE FROM reaction_budgets");
const insert = db.prepare("INSERT INTO reaction_executions VALUES(?,?,?,?)");
store.withImmediateTransaction(() => {
  for (let i = 0; i < 10000; i++) insert.run(`e${i}`, `r${i}`, `a${i}`, time + 100000);
});
equal("claim cap refuses new work", claim(), "CAPACITY");
equal(
  "claim cap preserves live entries",
  db.prepare("SELECT COUNT(*) AS n FROM reaction_executions").get().n,
  10000,
);
db.exec("DELETE FROM reaction_executions");
const insertBudget = db.prepare("INSERT INTO reaction_budgets VALUES(?,1,?)");
store.withImmediateTransaction(() => {
  for (let i = 0; i < 10000; i++) insertBudget.run(`b${i}`, time + 100000);
});
equal("budget cap refuses new keys", claim(), "CAPACITY");
equal(
  "capacity failure has no partial claim",
  db.prepare("SELECT COUNT(*) AS n FROM reaction_executions").get().n,
  0,
);
store.setReactionAutomationEnabled(true);
store.clearReactionAccountState();
equal("unlink kills global runtime", store.getBotSetting("reaction:enabled"), false);
equal("unlink clears budgets", db.prepare("SELECT COUNT(*) AS n FROM reaction_budgets").get().n, 0);

section("migration rollback preserves shipped schema 11");
const broken = new DatabaseSync(":memory:");
database.migrate(broken, database.MIGRATIONS.slice(0, 11));
throws("failure rolls all pending migrations back", () =>
  database.migrate(broken, [
    ...database.MIGRATIONS,
    () => {
      throw new Error("injected failure");
    },
  ]),
);
equal("schema 11 remains", database.schemaVersion(broken), 11);
equal(
  "no partial execution table",
  broken.prepare("SELECT name FROM sqlite_master WHERE name='reaction_executions'").get(),
  undefined,
);
equal(
  "no partial epoch column",
  broken
    .prepare("PRAGMA table_info(reaction_rules)")
    .all()
    .some((row) => row.name === "enabled_at"),
  false,
);
broken.close();
database.close();
lock.release();
finish();

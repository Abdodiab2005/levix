import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { equal, finish, ok, require, section, useTempDataDir } from "./harness.mjs";

const dir = useTempDataDir("levix-backup-activation");
const { db, migrate } = require("./src/db/db.cjs");
const store = require("./src/db/store.cjs");
const { readJournal } = require("./src/backup/journal.cjs");
const { runRestoreRecovery } = require("./src/backup/recovery.cjs");
const { activatePendingIfMatching, setFaultHookForTest, readLastActivation } =
  require("./src/backup/activation.cjs");
const { ensureDurableDirectory } = require("./src/backup/activation.cjs");
const { handleConnectionOpen } = await import("../src/core/connection.js");
const { WhatsAppSession } = await import("../src/core/session.js");
const jobs = require("./src/backup/jobs.cjs");
const scheduler = require("./scheduler.cjs");

const lid = "123456789@lid";
const pn = "201000000012@s.whatsapp.net";
const id = "a".repeat(32);
const pendingRoot = join(dir, "restore", "pending");
const livePaths = ["memory", "stickers", "media/schedules"];
const backupAccount = { lid, pn };
const sock = { user: { id: pn, lid }, async groupFetchAllParticipating() { return {}; } };

function pair(account = backupAccount) {
  store.authWrite("creds", JSON.stringify({ me: { id: account.pn, lid: account.lid }, account: { key: 1 }, registered: false }));
  sock.user.id = account.pn;
  sock.user.lid = account.lid;
}
function fixture(account = backupAccount) {
  rmSync(pendingRoot, { recursive: true, force: true });
  for (const name of livePaths) rmSync(join(dir, name), { recursive: true, force: true });
  db.exec("DELETE FROM ai_history; DELETE FROM schedules; DELETE FROM sticker_pack_items; DELETE FROM stickers; DELETE FROM sticker_packs; DELETE FROM sticker_owners; DELETE FROM user_metadata");
  db.prepare("DELETE FROM bot_settings WHERE key = 'restore:activated'").run();
  db.prepare("INSERT INTO ai_history (chat_id, history, updated_at) VALUES ('live', '[]', 1)").run();
  db.prepare("INSERT INTO schedules (id,type,target_jid,message,status,created_at) VALUES ('live', 'once', 'chat@g.us', 'live', 'pending', 1)").run();
  db.prepare("INSERT INTO sticker_owners (id, kind, account, created_at) VALUES (?, 'self', ?, 1)")
    .run("1".repeat(16), lid);
  db.prepare("INSERT INTO stickers (id, owner, sha256, file_size, source, created_at, updated_at) VALUES (?,?,?,?,?,1,1)")
    .run("2".repeat(16), "1".repeat(16), "c".repeat(64), 4, "upload");
  for (const name of livePaths) {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, "item"), "live");
  }
  mkdirSync(join(pendingRoot, "files"), { recursive: true });
  const copy = new DatabaseSync(join(pendingRoot, "levix.db"));
  try {
    migrate(copy);
    copy.prepare("INSERT INTO ai_history (chat_id, history, updated_at) VALUES ('backup', '[]', 1)").run();
    copy.prepare("INSERT INTO schedules (id,type,target_jid,message,status,created_at) VALUES ('backup', 'once', 'chat@g.us', 'backup', 'pending', 1)").run();
    copy.prepare("INSERT INTO user_metadata (user_jid, is_owner, is_admin, first_seen, last_seen) VALUES (?, 1, 0, 1, 1)").run(lid);
    copy.prepare("INSERT INTO user_metadata (user_jid, is_owner, is_admin, first_seen, last_seen) VALUES (?, 0, 1, 1, 1)")
      .run("201000000088@s.whatsapp.net");
    copy.prepare("INSERT INTO sticker_owners (id, kind, account, created_at) VALUES (?, 'self', ?, 1)")
      .run("3".repeat(16), lid);
    copy.prepare("INSERT INTO stickers (id, owner, sha256, file_size, source, created_at, updated_at) VALUES (?,?,?,?,?,1,1)")
      .run("4".repeat(16), "3".repeat(16), "d".repeat(64), 6, "upload");
  } finally { copy.close(); }
  for (const name of livePaths) {
    mkdirSync(join(pendingRoot, "files", name), { recursive: true });
    writeFileSync(join(pendingRoot, "files", name, "item"), "backup");
  }
  writeFileSync(join(pendingRoot, "pending.json"), JSON.stringify({ id, account }));
}
function currentRows() { return db.prepare("SELECT chat_id FROM ai_history").all().map((row) => row.chat_id).join(","); }
function filesAre(word) { return livePaths.every((name) => readFileSync(join(dir, name, "item"), "utf8") === word); }
function pendingExists() { return existsSync(pendingRoot); }

section("matching LID activates before rosters and schedules");
pair(); fixture();
let scheduledRows = null;
await handleConnectionOpen(sock, () => { scheduledRows = currentRows(); });
equal("account tables replaced", currentRows(), "backup");
equal("scheduler sees backup rows", scheduledRows, "backup");
equal("schedule replaced", db.prepare("SELECT id FROM schedules").get().id, "backup");
equal("sticker rows replaced", db.prepare("SELECT id FROM stickers").get().id, "4".repeat(16));
ok("admin roster seeded from backup", require("./src/utils/permissions.cjs")
  .isBotAdminUserSync("201000000088@s.whatsapp.net"));
ok("files replaced", filesAre("backup"));
ok("legacy memory blocked", existsSync(join(dir, "memory", ".legacy-copied")));
ok("pending and journal removed", !pendingExists() && !readJournal());
equal("activation recorded", readLastActivation().status, "activated");

section("activation commit uses durable synchronous mode");
fixture(); pair();
setFaultHookForTest((step) => {
  if (step === "db-before-commit")
    equal("activation transaction uses synchronous FULL", db.prepare("PRAGMA synchronous").get().synchronous, 2);
});
await handleConnectionOpen(sock, () => {});
setFaultHookForTest(null);
equal("connection returns to synchronous NORMAL", db.prepare("PRAGMA synchronous").get().synchronous, 1);
equal("durable activation committed", currentRows(), "backup");

section("pending schema changed after staging is refused");
fixture(); pair();
const altered = new DatabaseSync(join(pendingRoot, "levix.db"));
try { altered.exec("CREATE TRIGGER extra_trigger AFTER INSERT ON bot_settings BEGIN SELECT 1; END"); }
finally { altered.close(); }
await handleConnectionOpen(sock, () => {});
const schemaFailure = JSON.parse(readFileSync(join(dir, "restore", "last-activation.json"), "utf8"));
equal("extra trigger reports schema mismatch", schemaFailure.code, "SCHEMA_MISMATCH");
ok("extra trigger keeps live data", currentRows() === "live" && filesAre("live") && pendingExists());
ok("extra trigger clears journal", !readJournal());

section("account mismatch waits");
for (const account of [
  { lid: "987654321@lid", pn },
  { lid: "987654321@lid", pn: "201000000099@s.whatsapp.net" },
]) {
  fixture(); pair(account);
  await handleConnectionOpen(sock, () => {});
  ok("mismatch preserved live state", currentRows() === "live" && filesAre("live") && pendingExists());
  equal("mismatch status", readLastActivation().status, "waiting");
}

section("phone-only fallback and missing paired LID");
fixture({ lid: null, pn }); pair();
await handleConnectionOpen(sock, () => {});
equal("phone-only activated", currentRows(), "backup");
fixture(); pair({ lid: null, pn });
await handleConnectionOpen(sock, () => {});
ok("backup LID waits for paired LID", currentRows() === "live" && pendingExists());

section("transaction failure preserves live account");
fixture(); pair();
setFaultHookForTest((step) => { if (step === "db-before-commit") throw new Error("injected"); }, { crash: false });
let openContinued = false;
await handleConnectionOpen(sock, () => { openContinued = true; });
setFaultHookForTest(null);
ok("open continued", openContinued);
ok("failure kept old state", currentRows() === "live" && filesAre("live") && pendingExists());
equal("failure status", readLastActivation().status, "failed");
ok("failure cleared journal", !readJournal());

section("new rollback directories are synced before moving live files");
{
  const target = join(dir, "restore", "b".repeat(32), "previous", "media");
  const known = new Set([dir, join(dir, "restore")]);
  const operations = [];
  const fakeFs = {
    existsSync: (name) => known.has(name),
    mkdirSync(name) { known.add(name); operations.push(`mkdir:${name}`); },
    openSync: (name) => name,
    fsyncSync(name) { operations.push(`fsync:${name}`); },
    closeSync() {},
  };
  ensureDurableDirectory(target, fakeFs);
  equal("each new ancestor is followed by parent fsync", operations.join("|"), [
    `mkdir:${join(dir, "restore", "b".repeat(32))}`,
    `fsync:${join(dir, "restore")}`,
    `mkdir:${join(dir, "restore", "b".repeat(32), "previous")}`,
    `fsync:${join(dir, "restore", "b".repeat(32))}`,
    `mkdir:${target}`,
    `fsync:${join(dir, "restore", "b".repeat(32), "previous")}`,
  ].join("|"));
}

section("failed undo stops the session before owner and schedule setup");
fixture(); pair();
setFaultHookForTest((step) => {
  if (step === "db-before-commit" || step === "undo-rename") throw new Error("injected rename failure");
}, { crash: false });
let openUpdate;
let ended = 0;
let schedulesStarted = 0;
const sessionErrors = [];
const fakeSocket = { ...sock, async end() { ended += 1; } };
const session = new WhatsAppSession({
  createSocket: async () => ({ sock: fakeSocket, saveCreds: async () => {}, clearAll: async () => {}, isPaired: true }),
  attachListeners: (_socket, { onConnectionUpdate }) => { openUpdate = onConnectionUpdate; },
  onOpen: handleConnectionOpen,
  initializeScheduledJobs: () => { schedulesStarted += 1; },
  stopScheduledJobs: () => {},
  isLinked: () => true,
  loadProxy: () => null,
  buildProxyAgents: () => null,
  log: { info() {}, warn() {}, debug() {}, error(message) { sessionErrors.push(message); } },
});
await session.start();
await openUpdate({ connection: "open" });
equal("unsafe activation stops session", session.state, "error");
ok("unsafe socket closed", ended === 1 && session.socket === null);
equal("schedules did not start", schedulesStarted, 0);
equal("owner was not saved", db.prepare("SELECT count(*) AS n FROM user_metadata").get().n, 0);
ok("journal remains for recovery", !!readJournal());
equal("rollback failure recorded", JSON.parse(readFileSync(join(dir, "restore", "last-activation.json"), "utf8")).code,
  "ROLLBACK_FAILED");
equal("session logged one clear error", sessionErrors.length, 1);

let recoveryCode = null;
try { runRestoreRecovery(); } catch (error) { recoveryCode = error.code; }
equal("startup refuses failed undo", recoveryCode, "ACTIVATION_RECOVERY_FAILED");
equal("failed recovery is terminal", require("./src/config/exit-codes.cjs")
  .exitCodeFor({ code: recoveryCode }), 78);
ok("failed recovery keeps journal", !!readJournal());
setFaultHookForTest(null);
runRestoreRecovery();
ok("later recovery restores old files", currentRows() === "live" && filesAre("live") && pendingExists());

section("in-flight delivery cannot alter restored schedule or media");
fixture(); pair();
db.prepare("UPDATE schedules SET id = 'backup', status = 'failed' WHERE id = 'live'").run();
writeFileSync(join(dir, "media", "schedules", "backup"), "old media");
writeFileSync(join(pendingRoot, "files", "media", "schedules", "backup"), "restored media");
let releaseSend;
let signalSend;
const sendStarted = new Promise((resolve) => { signalSend = resolve; });
const delivery = scheduler.retryScheduledJob({
  sendMessage() {
    signalSend();
    return new Promise((resolve) => { releaseSend = resolve; });
  },
}, "backup");
await sendStarted;
ok("matching activation succeeds while send waits", activatePendingIfMatching());
releaseSend();
equal("old delivery is stale", (await delivery).reason, "stale");
equal("restored schedule remains pending", db.prepare("SELECT status FROM schedules WHERE id = 'backup'").get().status,
  "pending");
equal("restored media remains", readFileSync(join(dir, "media", "schedules", "backup"), "utf8"),
  "restored media");

section("unlink keeps pending for a later matching pairing");
fixture(); pair({ lid: "987654321@lid", pn });
store.authClearAll();
ok("unlink kept pending", pendingExists());
pair();
await handleConnectionOpen(sock, () => {});
equal("matching pairing activated", currentRows(), "backup");

section("completed restore reconnects only a running matching session");
let reconnects = 0;
const fakeSession = { state: "connected", async reconnect() { reconnects += 1; } };
jobs.setSession(fakeSession);
await jobs.reconnectForMatchingResult({ accountMatchesPaired: true });
equal("running session reconnect count", reconnects, 1);
fakeSession.state = "idle";
await jobs.reconnectForMatchingResult({ accountMatchesPaired: true });
equal("idle session does not reconnect", reconnects, 1);
jobs.setSession(null);

section("crash boundaries recover to one complete state");
for (const boundary of ["migrate", "files:memory:previous", "files", "db-committed"]) {
  fixture(); pair();
  setFaultHookForTest((step) => { if (step === boundary) throw new Error("crash"); });
  activatePendingIfMatching();
  setFaultHookForTest(null);
  runRestoreRecovery();
  const committed = boundary === "db-committed";
  ok(`${boundary} recovered`, committed ?
    currentRows() === "backup" && filesAre("backup") && !pendingExists() :
    currentRows() === "live" && filesAre("live") && pendingExists());
  ok(`${boundary} journal cleared`, !readJournal());
}

section("account identity is absent from logs and status");
fixture(); pair({ lid: "987654321@lid", pn });
await handleConnectionOpen(sock, () => {});
const status = JSON.stringify({ ...require("./src/backup/restore.cjs").pendingStatus(),
  lastActivation: readLastActivation() });
const logs = JSON.stringify(require("./src/utils/logger.cjs").readLogs());
const rawAccounts = [lid, "987654321@lid", pn];
ok("status masks identifiers", rawAccounts.every((value) => !status.includes(value)));
ok("logs mask identifiers", rawAccounts.every((value) => !logs.includes(value)));

finish();

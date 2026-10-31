import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { request as httpRequest } from "node:http";
import express from "express";
import { equal, finish, ok, require, ROOT, section, useTempDataDir } from "./harness.mjs";

const data = useTempDataDir("levix-backup-restore");
const { db } = require("./src/db/db.cjs");
const store = require("./src/db/store.cjs");
const settings = require("./src/config/settings.cjs");
const runtime = require("./src/config/runtime-config.cjs");
const secrets = require("./src/config/secrets.cjs");
const { createBackup } = require("./src/backup/create.cjs");
const restore = require("./src/backup/restore.cjs");
const uploads = require("./src/backup/uploads.cjs");
const { runRestoreRecovery } = require("./src/backup/recovery.cjs");
const { readJournal, readOutcome, writeJournal, clearJournal } = require("./src/backup/journal.cjs");
const jobs = require("./src/backup/jobs.cjs");
const { accountsMatch } = require("./src/backup/account.cjs");
const { writeBackup } = require("./src/backup/format.cjs");
const { MIGRATIONS, migrate } = require("./src/db/db.cjs");
const { checkpoint } = require("./src/db/db.cjs");

const password = "restore-test-backup-password";
const kdf = { N: 32768, r: 8, p: 1 };
const lid = "123456789@lid";
const pn = "201000000012@s.whatsapp.net";
const uploadDir = join(data, "tmp", "restore");
mkdirSync(uploadDir, { recursive: true });
let nextId = 0;
function upload(file) {
  const id = (++nextId).toString(16).padStart(32, "0");
  copyFileSync(file, join(uploadDir, `${id}.levixbak`));
  return id;
}
async function rejects(label, action, code) {
  try { await action(); ok(label, false); }
  catch (error) { equal(label, error.code, code); }
}

section("account matching");
ok("equal LIDs match", accountsMatch({ lid, pn }, { lid, pn: "other@s.whatsapp.net" }));
ok("different LIDs do not match", !accountsMatch({ lid, pn }, { lid: "987@lid", pn }));
ok("a backup LID never falls back to phone", !accountsMatch({ lid, pn }, { lid: null, pn }));
ok("a phone-only backup matches by phone", accountsMatch({ lid: null, pn }, { lid, pn }));
ok("null account does not match", !accountsMatch(null, { lid, pn }));

section("verify, stage, apply, pending");
settings.set("bot_language", "en");
settings.set("gemini_api_key", "gemini-restore-key");
settings.set("openai_api_key", "openai-restore-key");
settings.set("port", 3005);
runtime.setPrefix(">");
runtime.setPermission("ping", "ADMINS_ONLY");
runtime.setAliases("ping", ["pong"]);
runtime.setEnabled("qr", false);
secrets.setDashboardPassword("source-panel-password");
store.saveBotSetting("auth:recovery-email", "source-recovery-record");
store.saveBotSetting("secret:session", "source-session-key");
store.authWrite("creds", JSON.stringify({ me: { id: pn, lid }, account: { key: 1 }, registered: false }));
db.prepare("INSERT INTO ai_history (chat_id, history, updated_at) VALUES ('before', '[]', 1)").run();
db.prepare("INSERT INTO user_metadata (user_jid, is_owner, is_admin, first_seen, last_seen) VALUES (?,1,0,1,1)").run(lid);
db.prepare("INSERT INTO schedules (id,type,target_jid,message,status,created_at,media) VALUES (?, 'once', ?, 'hi', 'pending',1,?)")
  .run("restore-schedule", "chat@g.us", JSON.stringify({ kind: "image", mimeType: "image/png" }));
const stickerSha = "ab" + "1".repeat(62);
db.prepare("INSERT INTO sticker_owners (id, kind, account, created_at) VALUES (?, 'self', ?, 1)")
  .run("a".repeat(16), lid);
db.prepare("INSERT INTO stickers (id, owner, sha256, file_size, source, created_at, updated_at) VALUES (?,?,?,?,?,1,1)")
  .run("b".repeat(16), "a".repeat(16), stickerSha, 7, "upload");
mkdirSync(join(data, "stickers", "ab"), { recursive: true });
writeFileSync(join(data, "stickers", "ab", `${stickerSha}.webp`), "sticker");
mkdirSync(join(data, "media", "schedules"), { recursive: true });
writeFileSync(join(data, "media", "schedules", "restore-schedule"), "media bytes");
mkdirSync(join(data, "memory"), { recursive: true });
writeFileSync(join(data, "memory", "global.md"), "original memory");
writeFileSync(join(data, "ai-persona.md"), "original persona");
const archive = await createBackup({ password, kdf });

section("restore into a second install");
const targetDir = join(data, "target-install");
mkdirSync(targetDir);
const child = spawnSync(process.execPath,
  [join(ROOT, "tests", "fixtures", "backup-restore-target.mjs"), archive.path, password],
  { env: { ...process.env, LEVIX_DATA_DIR: targetDir }, encoding: "utf8", timeout: 30000 });
const childResult = /^RESULT (.*)$/m.exec(child.stdout);
ok("second install exits", child.status === 0 && !!childResult);
ok("second install logs contain no secrets or account identity",
  ![password, "gemini-restore-key", lid, pn].some((value) => `${child.stdout}\n${child.stderr}`.includes(value)));
if (childResult) {
  const outcome = JSON.parse(childResult[1]);
  ok("source API key resealed and usable", outcome.keyUsable && outcome.storedSealed);
  ok("target password and pairing kept", outcome.passwordKept && outcome.pairingKept);
  ok("different account still waits", !outcome.matchesPaired);
}

settings.set("bot_language", "ar");
settings.set("gemini_api_key", "mutated-gemini-key");
settings.set("openai_api_key", "mutated-openai-key");
settings.set("port", 3100);
runtime.setPrefix("!");
runtime.setPermission("ping", null);
runtime.setAliases("ping", null);
runtime.setEnabled("qr", true);
secrets.setDashboardPassword("target-panel-password");
store.saveBotSetting("auth:recovery-email", "target-recovery-record");
store.saveBotSetting("secret:session", "target-session-key");
store.authWrite("creds", JSON.stringify({ me: { id: pn, lid }, account: { key: 2 }, registered: false }));
db.prepare("DELETE FROM ai_history").run();
db.prepare("INSERT INTO ai_history (chat_id, history, updated_at) VALUES ('after', '[]', 2)").run();
db.prepare("UPDATE user_metadata SET is_owner = 0 WHERE user_jid = ?").run(lid);
db.prepare("DELETE FROM schedules WHERE id = 'restore-schedule'").run();
db.prepare("DELETE FROM stickers WHERE sha256 = ?").run(stickerSha);
writeFileSync(join(data, "memory", "global.md"), "mutated memory");
writeFileSync(join(data, "stickers", "ab", `${stickerSha}.webp`), "changed");
writeFileSync(join(data, "media", "schedules", "restore-schedule"), "changed");
writeFileSync(join(data, "ai-persona.md"), "mutated persona");

const id = upload(archive.path);
restore.setCrashHookForTest((step) => {
  if (step === "stage") {
    utimesSync(join(uploadDir, `${id}.levixbak`), new Date(0), new Date(0));
    uploads.sweepUploads();
    ok("expired upload stays pinned during restore", existsSync(join(uploadDir, `${id}.levixbak`)));
  }
  if (step === "inside-apply")
    equal("settings transaction uses synchronous FULL", db.prepare("PRAGMA synchronous").get().synchronous, 2);
});
const result = await restore.restoreUpload(id, password);
restore.setCrashHookForTest(null);
equal("settings connection returns to synchronous NORMAL", db.prepare("PRAGMA synchronous").get().synchronous, 1);
equal("language restored", settings.get("bot_language"), "en");
equal("first key restored", settings.get("gemini_api_key"), "gemini-restore-key");
equal("second key restored", settings.get("openai_api_key"), "openai-restore-key");
ok("stored key is sealed", !db.prepare("SELECT value FROM bot_settings WHERE key = 'setting:gemini_api_key'").get().value.includes("gemini-restore-key"));
equal("prefix restored", runtime.getPrefix(), ">");
equal("permission restored", runtime.getPermission("ping"), "ADMINS_ONLY");
equal("alias restored", runtime.getAliases("ping", []).join(","), "pong");
ok("disabled command restored", runtime.isDisabled("qr"));
equal("persona restored", readFileSync(join(data, "ai-persona.md"), "utf8"), "original persona");
equal("device setting kept", settings.get("port"), 3100);
ok("panel password kept", secrets.verifyDashboardPassword("target-panel-password"));
equal("recovery email kept", store.getBotSetting("auth:recovery-email"), "target-recovery-record");
equal("session key kept", store.getBotSetting("secret:session"), "target-session-key");
ok("pairing kept", store.authRead("creds").includes('"key":2'));
equal("live account data kept", db.prepare("SELECT chat_id FROM ai_history").get().chat_id, "after");
equal("live role kept", db.prepare("SELECT is_owner FROM user_metadata WHERE user_jid = ?").get(lid).is_owner, 0);
equal("live schedule kept deleted", db.prepare("SELECT count(*) AS n FROM schedules").get().n, 0);
equal("live sticker kept deleted", db.prepare("SELECT count(*) AS n FROM stickers").get().n, 0);
equal("live memory kept", readFileSync(join(data, "memory", "global.md"), "utf8"), "mutated memory");
equal("live sticker file kept", readFileSync(join(data, "stickers", "ab", `${stickerSha}.webp`), "utf8"), "changed");
ok("pending database exists", existsSync(join(data, "restore", "pending", "levix.db")));
const pendingDb = new DatabaseSync(join(data, "restore", "pending", "levix.db"), { readOnly: true });
equal("pending role restored", pendingDb.prepare("SELECT is_owner FROM user_metadata WHERE user_jid = ?").get(lid).is_owner, 1);
equal("pending schedule restored", pendingDb.prepare("SELECT count(*) AS n FROM schedules").get().n, 1);
equal("pending sticker restored", pendingDb.prepare("SELECT count(*) AS n FROM stickers").get().n, 1);
pendingDb.close();
equal("pending memory copied", readFileSync(join(data, "restore", "pending", "files", "memory", "global.md"), "utf8"), "original memory");
equal("pending sticker file copied", readFileSync(join(data, "restore", "pending", "files", "stickers", "ab", `${stickerSha}.webp`), "utf8"), "sticker");
equal("pending schedule media copied", readFileSync(join(data, "restore", "pending", "files", "media", "schedules", "restore-schedule"), "utf8"), "media bytes");
equal("pending account LID", JSON.parse(readFileSync(join(data, "restore", "pending", "pending.json"), "utf8")).account.lid, lid);
equal("result waits for activation", result.accountData, "waits");
ok("paired account matches", result.accountMatchesPaired);
ok("journal cleared", readJournal() === null);
ok("upload consumed", !uploads.getUpload(id));

section("wrong password and damaged archive leave live settings");
checkpoint();
const databaseBeforeDamage = createHash("sha256").update(readFileSync(join(data, "levix.db"))).digest("hex");
const badPasswordId = upload(archive.path);
await rejects("wrong password", () => restore.restoreUpload(badPasswordId, "wrong-password-long-enough"), "WRONG_PASSWORD");
equal("wrong password leaves language", settings.get("bot_language"), "en");
for (let attempt = 1; attempt <= 5; attempt += 1)
  equal(`wrong attempt ${attempt}`, uploads.wrongPassword(badPasswordId), false);
ok("five failures remove upload", !uploads.getUpload(badPasswordId));
ok("sixth attempt is locked out", uploads.lockedOut(badPasswordId));
const bytes = readFileSync(archive.path);
bytes[bytes.length - 20] ^= 1;
const damaged = join(data, "damaged.levixbak");
writeFileSync(damaged, bytes);
await rejects("corrupted backup", () => restore.restoreUpload(upload(damaged), password), "DAMAGED");
const truncated = join(data, "truncated.levixbak");
writeFileSync(truncated, readFileSync(archive.path).subarray(0, -30));
await rejects("truncated backup", () => restore.restoreUpload(upload(truncated), password), "DAMAGED");
equal("corruption leaves persona", readFileSync(join(data, "ai-persona.md"), "utf8"), "original persona");
checkpoint();
equal("corruption leaves database byte-identical", createHash("sha256")
  .update(readFileSync(join(data, "levix.db"))).digest("hex"), databaseBeforeDamage);
ok("corruption clears journal", readJournal() === null);

section("recovery after a committed settings transaction");
settings.set("bot_language", "ar");
const crashId = upload(archive.path);
restore.setCrashHookForTest((step) => { if (step === "after-commit") throw new Error("test crash"); });
try { await restore.restoreUpload(crashId, password); }
catch (error) { equal("committed crash reports incomplete", error.code, "RESTORE_INCOMPLETE"); }
restore.setCrashHookForTest(null);
equal("journal records apply", readJournal()?.step, "apply");
ok("plaintext secrets removed before post-commit crash",
  !existsSync(join(data, "restore", readJournal().id, "staged", "secrets.json")));
runRestoreRecovery();
equal("recovery finishes persona", readFileSync(join(data, "ai-persona.md"), "utf8"), "original persona");
equal("recovery outcome", readOutcome()?.outcome, "completed-after-restart");
ok("recovery clears journal", readJournal() === null);

section("post-apply recovery requires the durable marker");
writeFileSync(join(data, "ai-persona.md"), "persona before unmarked recovery");
restore.setCrashHookForTest((step) => { if (step === "persona") throw new Error("test crash"); });
await rejects("unmarked restore starts incomplete", () => restore.restoreUpload(upload(archive.path), password), "RESTORE_INCOMPLETE");
restore.setCrashHookForTest(null);
equal("unmarked recovery starts at persona", readJournal()?.step, "persona");
store.deleteBotSetting("restore:applied");
runRestoreRecovery();
equal("unmarked persona recovery is unchanged", readFileSync(join(data, "ai-persona.md"), "utf8"),
  "persona before unmarked recovery");
equal("unmarked post-apply outcome", readOutcome()?.outcome, "interrupted-unchanged");
ok("unmarked journal cleared", readJournal() === null);

section("missing staged persona fails closed");
writeFileSync(join(data, "ai-persona.md"), "persona before damaged recovery");
restore.setCrashHookForTest((step) => { if (step === "after-commit") throw new Error("test crash"); });
await rejects("damaged restore starts incomplete", () => restore.restoreUpload(upload(archive.path), password), "RESTORE_INCOMPLETE");
restore.setCrashHookForTest(null);
const damagedStage = join(data, "restore", readJournal().id, "staged");
rmSync(join(damagedStage, "persona.md"));
runRestoreRecovery();
equal("missing persona records recovery failure", readOutcome()?.outcome, "recovery-failed");
equal("missing persona keeps live persona", readFileSync(join(data, "ai-persona.md"), "utf8"),
  "persona before damaged recovery");
ok("missing persona keeps journal", readJournal() !== null);
writeFileSync(join(damagedStage, "persona.md"), "original persona");
runRestoreRecovery();
ok("repaired staged persona finishes recovery", readJournal() === null);

section("missing staged account item keeps live persona");
writeFileSync(join(data, "ai-persona.md"), "persona before missing account item");
restore.setCrashHookForTest((step) => { if (step === "after-commit") throw new Error("test crash"); });
await rejects("account item restore starts incomplete", () => restore.restoreUpload(upload(archive.path), password), "RESTORE_INCOMPLETE");
restore.setCrashHookForTest(null);
const accountStage = join(data, "restore", readJournal().id, "staged");
rmSync(join(accountStage, "memory"), { recursive: true });
runRestoreRecovery();
equal("missing account item records recovery failure", readOutcome()?.outcome, "recovery-failed");
equal("missing account item keeps live persona", readFileSync(join(data, "ai-persona.md"), "utf8"),
  "persona before missing account item");
mkdirSync(join(accountStage, "memory"), { recursive: true });
writeFileSync(join(accountStage, "memory", "global.md"), "original memory");
runRestoreRecovery();
ok("repaired account item finishes recovery", readJournal() === null);

section("persona failure reports an incomplete restore job");
restore.setCrashHookForTest((step) => { if (step === "persona") throw new Error("test persona failure"); });
const personaJobId = jobs.startRestore(upload(archive.path), password);
let personaJob;
for (let attempt = 0; attempt < 100; attempt += 1) {
  personaJob = jobs.getJob(personaJobId);
  if (personaJob?.done) break;
  await new Promise((resolve) => setTimeout(resolve, 20));
}
restore.setCrashHookForTest(null);
equal("persona job error", personaJob?.error?.code, "RESTORE_INCOMPLETE");
equal("persona failure leaves journal", readJournal()?.step, "persona");
runRestoreRecovery();
ok("persona failure recovers", readJournal() === null);

section("recovery at every restore boundary");
for (const [point, expected] of [
  ["stage", "interrupted-unchanged"],
  ["inside-apply", "interrupted-unchanged"],
  ["after-persona", "completed-after-restart"],
  ["during-pending-items", "completed-after-restart"],
  ["during-pending-renames", "completed-after-restart"],
]) {
  settings.set("bot_language", "ar");
  writeFileSync(join(data, "ai-persona.md"), "mutated persona");
  const attempt = upload(archive.path);
  restore.setCrashHookForTest((step) => { if (step === point) throw new Error("test crash"); });
  try { await restore.restoreUpload(attempt, password); }
  catch (error) { equal(`${point} hook`, error.code || error.message,
    expected === "interrupted-unchanged" ? "test crash" : "RESTORE_INCOMPLETE"); }
  restore.setCrashHookForTest(null);
  const movedDb = point.startsWith("during-pending-") ?
    statSync(join(data, "restore", "pending.next", "levix.db")).ino : null;
  const movedMemory = point === "during-pending-renames" ?
    statSync(join(data, "restore", "pending.next", "files", "memory", "global.md")).ino : null;
  runRestoreRecovery();
  equal(`${point} outcome`, readOutcome()?.outcome, expected);
  ok(`${point} clears journal`, readJournal() === null);
  equal(`${point} final language`, settings.get("bot_language"),
    expected === "interrupted-unchanged" ? "ar" : "en");
  equal(`${point} final persona`, readFileSync(join(data, "ai-persona.md"), "utf8"),
    expected === "interrupted-unchanged" ? "mutated persona" : "original persona");
  if (movedDb !== null) equal(`${point} database renamed`,
    statSync(join(data, "restore", "pending", "levix.db")).ino, movedDb);
  if (movedMemory !== null) equal(`${point} memory renamed`,
    statSync(join(data, "restore", "pending", "files", "memory", "global.md")).ino, movedMemory);
}

section("pending discard");
ok("pending visible before discard", restore.pendingStatus().waiting);
const pendingBeforeReplace = JSON.parse(readFileSync(join(data, "restore", "pending", "pending.json"), "utf8")).id;
await restore.restoreUpload(upload(archive.path), password);
const pendingAfterReplace = JSON.parse(readFileSync(join(data, "restore", "pending", "pending.json"), "utf8")).id;
ok("second restore replaces pending", pendingBeforeReplace !== pendingAfterReplace);
restore.discardPending();
ok("pending gone", !restore.pendingStatus().waiting);
await restore.restoreUpload(upload(archive.path), password);
ok("later restore creates new pending data", restore.pendingStatus().waiting);

section("older schema migrates in staging");
const oldDbFile = join(data, "old-backup.db");
const oldDb = new DatabaseSync(oldDbFile);
migrate(oldDb, MIGRATIONS.slice(0, 1));
oldDb.prepare("INSERT INTO bot_settings (key, value) VALUES ('setting:bot_language', ?)").run(JSON.stringify("ar"));
oldDb.close();
const oldBytes = readFileSync(oldDbFile);
const oldArchive = join(data, "old-schema.levixbak");
await writeBackup({ outPath: oldArchive, password, kdf,
  manifest: { format: "levix-backup-manifest", version: 1, created: new Date().toISOString(),
    app: "test", schema: 1, platform: "test", account: null, counts: {}, apiKeys: [] },
  entries: [{ path: "db/levix.db", kind: "db", size: oldBytes.length,
    sha256: createHash("sha256").update(oldBytes).digest("hex"), source: oldBytes }] });
await restore.restoreUpload(upload(oldArchive), password);
equal("old schema setting applied", settings.get("bot_language"), "ar");

section("crafted staged schemas fail before migration");
async function backupDatabaseFile(file, label) {
  const content = readFileSync(file);
  const out = join(data, `${label}.levixbak`);
  await writeBackup({ outPath: out, password, kdf,
    manifest: { format: "levix-backup-manifest", version: 1, created: new Date().toISOString(),
      app: "test", schema: 1, platform: "test", account: null, counts: {}, apiKeys: [] },
    entries: [{ path: "db/levix.db", kind: "db", size: content.length,
      sha256: createHash("sha256").update(content).digest("hex"), source: content }] });
  return out;
}
checkpoint();
const schemaBefore = createHash("sha256").update(readFileSync(join(data, "levix.db"))).digest("hex");
// The previous section restored a backup without a persona, which removes the live copy.
writeFileSync(join(data, "ai-persona.md"), "persona before crafted schemas\n");
const personaBeforeSchema = readFileSync(join(data, "ai-persona.md"), "utf8");
for (const [label, sql] of [
  ["extra-trigger", "CREATE TRIGGER extra_trigger AFTER INSERT ON bot_settings BEGIN SELECT 1; END"],
  ["extra-view", "CREATE VIEW extra_view AS SELECT key FROM bot_settings"],
  ["altered-columns", "ALTER TABLE bot_settings ADD COLUMN injected TEXT"],
]) {
  const file = join(data, `${label}.db`);
  const crafted = new DatabaseSync(file);
  migrate(crafted, MIGRATIONS.slice(0, 1));
  crafted.exec(sql);
  crafted.close();
  const archiveFile = await backupDatabaseFile(file, label);
  const badId = upload(archiveFile);
  await rejects(`${label} schema rejected`, () => restore.restoreUpload(badId, password), "SCHEMA_MISMATCH");
  uploads.removeUpload(badId);
  ok(`${label} leaves journal clear`, readJournal() === null);
}
checkpoint();
equal("crafted schemas leave live database unchanged", createHash("sha256")
  .update(readFileSync(join(data, "levix.db"))).digest("hex"), schemaBefore);
equal("crafted schemas leave persona unchanged", readFileSync(join(data, "ai-persona.md"), "utf8"), personaBeforeSchema);

section("large junk settings table stays bounded");
const manyFile = join(data, "many-settings.db");
const many = new DatabaseSync(manyFile);
migrate(many, MIGRATIONS.slice(0, 1));
many.exec("BEGIN");
const insert = many.prepare("INSERT INTO bot_settings (key, value) VALUES (?, ?)");
insert.run("setting:bot_language", JSON.stringify("en"));
for (let index = 0; index < 200000; index += 1)
  insert.run(`junk:${index}`, JSON.stringify(index));
many.exec("COMMIT");
many.close();
const manyArchive = await backupDatabaseFile(manyFile, "many-settings");
const manyResult = await restore.restoreUpload(upload(manyArchive), password);
equal("allowlisted setting restored amid junk", settings.get("bot_language"), "en");
equal("junk settings are not loaded or reported", manyResult.skipped.length, 0);

equal("newer schema refused", (() => { try { restore.schemaCheck({ schema: MIGRATIONS.length + 1 }); return null; }
  catch (error) { return error.code; } })(), "SCHEMA_NEWER");
const newerArchive = join(data, "newer-schema.levixbak");
await writeBackup({ outPath: newerArchive, password, kdf,
  manifest: { format: "levix-backup-manifest", version: 1, created: new Date().toISOString(),
    app: "test", schema: MIGRATIONS.length + 1, platform: "test", account: null, counts: {}, apiKeys: [] },
  entries: [{ path: "db/levix.db", kind: "db", size: oldBytes.length,
    sha256: createHash("sha256").update(oldBytes).digest("hex"), source: oldBytes }] });
const newerDirectId = upload(newerArchive);
await rejects("newer schema restore refused", () => restore.restoreUpload(newerDirectId, password), "SCHEMA_NEWER");
uploads.removeUpload(newerDirectId);

section("upload limits and expiry");
function incoming(bytes, headers) { return Object.assign(Readable.from([bytes]), { headers }); }
await rejects("content length required", () => uploads.receiveUpload(incoming(Buffer.from("x"), {})), "LENGTH_REQUIRED");
await rejects("oversized upload refused", () => uploads.receiveUpload(incoming(Buffer.alloc(0),
  { "content-length": String(16 * 1024 ** 3 + 1) })), "LIMIT");
await rejects("length mismatch refused", () => uploads.receiveUpload(incoming(Buffer.from("abc"),
  { "content-length": "4" })), "BAD_LENGTH");
const firstUpload = await uploads.receiveUpload(incoming(Buffer.from("a"), { "content-length": "1" }));
const secondUpload = await uploads.receiveUpload(incoming(Buffer.from("b"), { "content-length": "1" }));
await rejects("third upload busy", () => uploads.receiveUpload(incoming(Buffer.from("c"),
  { "content-length": "1" })), "BUSY");
utimesSync(join(uploadDir, `${firstUpload.uploadId}.levixbak`), new Date(0), new Date(0));
uploads.sweepUploads();
ok("expired upload removed", !uploads.getUpload(firstUpload.uploadId));
uploads.removeUpload(secondUpload.uploadId);

section("pending API requires the target panel password");
const { default: backupRouter, jsonUnlessBackupUpload } = await import("../src/routes/backup.api.esm.js");
const app = express();
app.use(jsonUnlessBackupUpload(express.json()), backupRouter);
const server = await new Promise((resolve) => {
  const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
});
const base = `http://127.0.0.1:${server.address().port}`;
try {
  const chunkedStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(`${base}/backup/restore/uploads`, { method: "POST",
      headers: { "content-type": "application/octet-stream", "transfer-encoding": "chunked" } },
    (response) => { response.resume(); response.on("end", () => resolve(response.statusCode)); });
    request.on("error", reject);
    request.write("raw");
    request.end();
  });
  equal("raw upload without content length", chunkedStatus, 411);
  const rawAccepted = await fetch(`${base}/backup/restore/uploads`, { method: "POST",
    headers: { "content-type": "application/octet-stream" }, body: Buffer.from("raw") });
  equal("raw upload accepted", rawAccepted.status, 200);
  const rawResult = await rawAccepted.json();
  equal("raw upload reports bytes", rawResult.size, 3);
  uploads.removeUpload(rawResult.uploadId);
  const tooLargeStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(`${base}/backup/restore/uploads`, { method: "POST",
      headers: { "content-type": "application/octet-stream",
        "content-length": String(16 * 1024 ** 3 + 1) } },
    (response) => { response.resume(); response.on("end", () => resolve(response.statusCode)); });
    request.on("error", reject);
    request.end();
  });
  equal("oversized raw upload route", tooLargeStatus, 413);
  const attemptsId = upload(archive.path);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(`${base}/backup/restore/uploads/${attemptsId}/preview`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "wrong-password-long-enough" }) });
    equal(`preview password attempt ${attempt + 1}`, (await response.json()).code, "WRONG_PASSWORD");
  }
  const locked = await fetch(`${base}/backup/restore/uploads/${attemptsId}/preview`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "wrong-password-long-enough" }) });
  equal("sixth preview attempt", (await locked.json()).code, "too_many_attempts");
  ok("locked upload removed", !uploads.getUpload(attemptsId));
  const newerId = upload(newerArchive);
  const preview = await fetch(`${base}/backup/restore/uploads/${newerId}/preview`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
  equal("newer schema preview refused", (await preview.json()).code, "SCHEMA_NEWER");
  const started = await fetch(`${base}/backup/restore/uploads/${newerId}/restore`, { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password, current: "target-panel-password" }) }).then((response) => response.json());
  let job;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    job = await fetch(`${base}/backup/jobs/${started.jobId}`).then((response) => response.json());
    if (job.done) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  equal("newer schema restore job refused", job?.error?.code, "SCHEMA_NEWER");
  uploads.removeUpload(newerId);
  const status = await fetch(`${base}/backup/pending`).then((response) => response.json());
  ok("pending API masks account", status.waiting && !JSON.stringify(status).includes(lid) &&
    !JSON.stringify(status).includes(pn));
  const denied = await fetch(`${base}/backup/pending`, { method: "DELETE",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ current: "wrong" }) });
  equal("wrong panel password denied", denied.status, 403);
  ok("denied discard keeps pending", restore.pendingStatus().waiting);
  const accepted = await fetch(`${base}/backup/pending`, { method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ current: "target-panel-password" }) });
  equal("panel password permits discard", accepted.status, 200);
  ok("discard removes pending", !restore.pendingStatus().waiting);
} finally { await new Promise((resolve) => server.close(resolve)); }

section("invalid and failed recovery never block startup");
const journalFile = join(data, "restore", "journal.json");
for (const badJournal of ["{broken", JSON.stringify({ op: "other", id: "f".repeat(32), step: "stage" }),
  JSON.stringify({ op: "restore", id: "bad", step: "stage" }),
  JSON.stringify({ op: "restore", id: "f".repeat(32), step: "unknown" })]) {
  const before = readdirSync(join(data, "restore")).filter((name) => name.startsWith("journal.invalid-")).length;
  writeFileSync(journalFile, badJournal);
  runRestoreRecovery();
  ok("invalid journal moved aside", !existsSync(journalFile));
  equal("invalid journal retained for inspection", readdirSync(join(data, "restore"))
    .filter((name) => name.startsWith("journal.invalid-")).length, before + 1);
  equal("invalid journal outcome", readOutcome()?.outcome, "journal-invalid");
}
const unmarkedId = "f".repeat(32);
store.deleteBotSetting("restore:applied");
writeJournal({ op: "restore", id: unmarkedId, step: "pending" });
runRestoreRecovery();
equal("unmarked recovery outcome", readOutcome()?.outcome, "interrupted-unchanged");
ok("unmarked recovery clears journal", readJournal() === null);

const failedId = "e".repeat(32);
const failedStage = join(data, "restore", failedId);
mkdirSync(join(failedStage, "staged"), { recursive: true });
writeFileSync(join(failedStage, "metadata.json"), JSON.stringify({ account: { lid, pn },
  persona: false, items: { memory: true, stickers: false, scheduleMedia: false } }));
store.saveBotSetting("restore:applied", JSON.stringify({ id: failedId }));
writeJournal({ op: "restore", id: failedId, step: "pending" });
runRestoreRecovery();
equal("failed recovery outcome", readOutcome()?.outcome, "recovery-failed");
equal("failed recovery keeps journal", readJournal()?.id, failedId);
clearJournal();
store.deleteBotSetting("restore:applied");
rmSync(join(data, "restore", "pending.next"), { recursive: true, force: true });
rmSync(failedStage, { recursive: true });

finish();

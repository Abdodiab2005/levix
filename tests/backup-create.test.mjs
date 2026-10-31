import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, chmodSync,
  existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import express from "express";
import { equal, finish, ok, require, section, useTempDataDir } from "./harness.mjs";

const data = useTempDataDir("levix-backup-create");
const { db } = require("./src/db/db.cjs");
const store = require("./src/db/store.cjs");
const settings = require("./src/config/settings.cjs");
const secrets = require("./src/config/secrets.cjs");
const { createBackup, describeBackupContents } = require("./src/backup/create.cjs");
const { maskAccount } = require("./src/backup/account.cjs");
const { openBackup } = require("./src/backup/format.cjs");
const { scheduleMediaPath } = require("./scheduler.cjs");
const { webpPath, thumbPath } = require("./src/stickers/library.cjs");
const { ROOT: memoryRoot } = require("./src/utils/memory.cjs");
const kdf = { N: 32768, r: 8, p: 1 };
const password = "backup-create-password-123";
const panelPassword = "panel-password-123";
const shaA = "ab" + "1".repeat(62);
const shaB = "cd" + "2".repeat(62);
const owner = "a".repeat(16);
const pack = "b".repeat(16);

function exportFiles() {
  const dir = join(data, "tmp", "backup", "exports");
  return existsSync(dir) ? readdirSync(dir) : [];
}
async function unpack(file) {
  const opened = await openBackup({ path: file.path, password });
  const dest = mkdtempSync(join(data, "extract-"));
  chmodSync(dest, 0o700);
  await opened.extract({ dest });
  return { manifest: opened.manifest, dest, copy: new DatabaseSync(join(dest, "db", "levix.db"), { readOnly: true }) };
}
async function rejects(action, code) {
  try { await action(); ok(`rejects ${code}`, false); }
  catch (error) { equal(`rejects ${code}`, error.code, code); }
}

section("seeded paired export");
settings.set("bot_language", "en");
settings.set("port", 3005);
settings.set("gemini_api_key", "gemini-plain-test-key");
settings.set("openai_api_key", "openai-plain-test-key");
store.saveBotSetting("prefix", ">");
store.saveBotSetting("command_permissions", { ping: "OWNER_ONLY" });
store.saveBotSetting("command_aliases", { ping: ["p"] });
store.saveBotSetting("disabled_commands", ["qr"]);
secrets.setDashboardPassword(panelPassword);
store.saveBotSetting("auth:recovery-email", "sealed-recovery-marker");
store.saveBotSetting("secret:session", "session-secret-marker-123");
store.authWrite("creds", JSON.stringify({ me: { id: "201000000012:4@s.whatsapp.net", lid: "123456789:4@lid" }, account: { key: 1 }, registered: false }));
db.prepare("INSERT INTO user_metadata (user_jid, is_owner, is_admin, first_seen, last_seen) VALUES (?,1,0,1,1)").run("123456789@lid");
db.prepare("INSERT INTO group_settings (group_id, settings) VALUES (?, '{}')").run("group@g.us");
db.prepare("INSERT INTO ai_history (chat_id, history, updated_at) VALUES (?, '[]', 1)").run("chat@g.us");
db.prepare("INSERT INTO sticker_owners (id, kind, account, created_at) VALUES (?, 'self', ?, 1)").run(owner, "123456789@lid");
for (const [id, sha] of [["c".repeat(16), shaA], ["d".repeat(16), shaB]]) {
  db.prepare("INSERT INTO stickers (id, owner, sha256, file_size, source, created_at, updated_at) VALUES (?,?,?,?,?,1,1)")
    .run(id, owner, sha, 7, "upload");
  mkdirSync(join(data, "stickers", sha.slice(0, 2)), { recursive: true });
  writeFileSync(webpPath(sha), `webp-${sha.slice(0, 2)}`, { mode: 0o600 });
  writeFileSync(thumbPath(sha), `thumb-${sha.slice(0, 2)}`, { mode: 0o600 });
}
db.prepare("INSERT INTO sticker_packs (id, owner, name, name_key, created_at, updated_at) VALUES (?,?, 'Pack', 'pack',1,1)").run(pack, owner);
db.prepare("INSERT INTO schedules (id,type,target_jid,message,status,created_at,media) VALUES (?, 'once', ?, 'hi', 'pending',1,?)")
  .run("schedule-one", "chat@g.us", JSON.stringify({ kind: "image", mimeType: "image/png" }));
mkdirSync(join(data, "media", "schedules"), { recursive: true });
writeFileSync(scheduleMediaPath("schedule-one"), "schedule-bytes", { mode: 0o600 });
db.prepare("INSERT INTO auto_delete_rules (keywords,match_mode,chat_scope,senders_mode,created_at,updated_at) VALUES ('[]','contains','all','everyone',1,1)").run();
mkdirSync(join(memoryRoot, "chats"), { recursive: true });
writeFileSync(join(memoryRoot, "global.md"), "global memory");
writeFileSync(join(memoryRoot, "chats", "chat.md"), "chat memory");
writeFileSync(join(data, "ai-persona.md"), "persona text");
db.prepare("INSERT INTO qr_codes (id, qr_string) VALUES (1,'qr')").run();
db.prepare("INSERT INTO forward_scores (message_id, group_id, original_sender, first_forwarded_at, last_forwarded_at, expires_at) VALUES ('m','g','u',1,1,9999999999999)").run();
db.prepare("INSERT INTO moderation_applied (group_id, message_id, outcome, applied_at) VALUES ('g','m','warned',1)").run();
const preview = describeBackupContents();
equal("preview keys", preview.apiKeys.join(","), "gemini_api_key,openai_api_key");
equal("preview account mask", preview.maskedAccount, "+20 ••• ••• ••12");
equal("other country mask", maskAccount({ lid: null, pn: "15555555599@s.whatsapp.net" }), "+15 ••• ••• ••99");
equal("LID-only mask", maskAccount({ lid: "123@lid", pn: null }), "WhatsApp account");
equal("unpaired mask", maskAccount(null), null);
const file = await createBackup({ password, kdf });
const first = await unpack(file);
equal("account LID", first.manifest.account.lid, "123456789@lid");
equal("account phone", first.manifest.account.pn, "201000000012@s.whatsapp.net");
equal("manifest keys", first.manifest.apiKeys.join(","), "gemini_api_key,openai_api_key");
for (const [key, expected] of Object.entries({ settings: 5, apiKeys: 2, schedules: 1,
  groups: 1, roles: 1, conversations: 1, memoryFiles: 2, stickers: 2, packs: 1 }))
  equal(`count ${key}`, first.manifest.counts[key], expected);
const keys = first.copy.prepare("SELECT key FROM bot_settings ORDER BY key").all().map((row) => row.key);
equal("settings allowlist", keys.join(","),
  "command_aliases,command_permissions,disabled_commands,prefix,setting:bot_language");
for (const table of ["baileys_auth", "qr_codes", "moderation_applied", "forward_scores"])
  equal(`${table} empty`, first.copy.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
equal("account rows remain", first.copy.prepare("SELECT count(*) AS n FROM stickers").get().n, 2);
equal("secrets plaintext", JSON.stringify(JSON.parse(readFileSync(join(first.dest, "secrets.json"), "utf8")).settings),
  JSON.stringify({ gemini_api_key: "gemini-plain-test-key", openai_api_key: "openai-plain-test-key" }));
for (const entry of ["persona.md", "memory/global.md", "memory/chats/chat.md",
  `stickers/ab/${shaA}.webp`, `stickers/cd/${shaB}.thumb.webp`, "media/schedules/schedule-one"])
  ok(`${entry} copied`, readFileSync(join(first.dest, entry)).equals(readFileSync(join(data,
    entry === "persona.md" ? "ai-persona.md" : entry))));
first.copy.close();

section("secret scan and space");
const rawSession = db.prepare("SELECT value FROM bot_settings WHERE key = 'secret:session'").get().value;
db.prepare("INSERT INTO notes (group_id, keyword, note_text) VALUES ('g','secret',?)").run(rawSession);
await rejects(() => createBackup({ password, kdf }), "SECRET_FOUND");
equal("failed scan leaves no new export", exportFiles().length, 1);
ok("failed scan removes staging", readdirSync(join(data, "tmp", "backup")).every((name) => name === "exports"));
db.prepare("DELETE FROM notes WHERE keyword = 'secret'").run();
const largeForbidden = `overflow-${"X".repeat(12000)}`;
db.prepare("UPDATE bot_settings SET value = ? WHERE key = 'secret:session'").run(largeForbidden);
db.prepare("INSERT INTO notes (group_id, keyword, note_text) VALUES ('g','overflow',?)").run(largeForbidden);
await rejects(() => createBackup({ password, kdf }), "SECRET_FOUND");
db.prepare("DELETE FROM notes WHERE keyword = 'overflow'").run();
db.prepare("UPDATE bot_settings SET value = ? WHERE key = 'secret:session'").run(rawSession);
db.prepare("INSERT INTO notes (group_id, keyword, note_text) VALUES ('g','blob',?)").run(Buffer.from(rawSession));
await rejects(() => createBackup({ password, kdf }), "SECRET_FOUND");
db.prepare("DELETE FROM notes WHERE keyword = 'blob'").run();
writeFileSync(join(data, "ai-persona.md"), `persona text ${rawSession}`);
await rejects(() => createBackup({ password, kdf }), "SECRET_FOUND");
writeFileSync(join(data, "ai-persona.md"), "persona text");
writeFileSync(join(memoryRoot, "chats", "chat.md"), `chat memory ${rawSession}`);
await rejects(() => createBackup({ password, kdf }), "SECRET_FOUND");
writeFileSync(join(memoryRoot, "chats", "chat.md"), "chat memory");
db.prepare("INSERT INTO notes (group_id, keyword, note_text) VALUES ('g','api',?)").run("gemini-plain-test-key");
const withApiNote = await createBackup({ password, kdf });
ok("plain API key note permitted", existsSync(withApiNote.path));
const sourceFiles = [join(data, "ai-persona.md"), join(memoryRoot, "global.md"),
  join(memoryRoot, "chats", "chat.md"), webpPath(shaA), thumbPath(shaA),
  webpPath(shaB), thumbPath(shaB), scheduleMediaPath("schedule-one")];
const sourceBytes = sourceFiles.reduce((sum, filePath) => sum + statSync(filePath).size, 0);
const databaseBytes = statSync(join(data, "levix.db")).size +
  (existsSync(join(data, "levix.db-wal")) ? statSync(join(data, "levix.db-wal")).size : 0);
const secretsBytes = Buffer.byteLength(JSON.stringify({ settings: {
  gemini_api_key: "gemini-plain-test-key", openai_api_key: "openai-plain-test-key",
} }));
const required = databaseBytes * 2 + sourceBytes +
  Math.ceil((databaseBytes + sourceBytes + secretsBytes) * 1.01) + 64 * 1024 * 1024;
await rejects(() => createBackup({ password, kdf, statfs: () => ({ bavail: required - 1, bsize: 1 }) }), "NO_SPACE");
ok("exact free-space estimate accepted", existsSync((await createBackup({ password, kdf,
  statfs: () => ({ bavail: required, bsize: 1 }) })).path));
await rejects(() => createBackup({ password, kdf, statfs: () => ({ bavail: 0, bsize: 4096 }) }), "NO_SPACE");
ok("no-space leaves no stage", readdirSync(join(data, "tmp", "backup")).every((name) => name === "exports"));
db.exec("CREATE TABLE future_private_data (value TEXT)");
const beforeUnknown = exportFiles().length;
await rejects(() => createBackup({ password, kdf }), "UNCLASSIFIED_TABLE");
equal("unknown table leaves no export", exportFiles().length, beforeUnknown);
ok("unknown table leaves no stage", readdirSync(join(data, "tmp", "backup")).every((name) => name === "exports"));
db.exec("DROP TABLE future_private_data");

section("sent one-off without media file");
db.prepare("UPDATE schedules SET status = 'sent' WHERE id = 'schedule-one'").run();
unlinkSync(scheduleMediaPath("schedule-one"));
const delivered = await unpack(await createBackup({ password, kdf }));
equal("sent schedule row retained", delivered.copy.prepare("SELECT count(*) AS n FROM schedules WHERE id = 'schedule-one'").get().n, 1);
ok("missing schedule file omitted", delivered.manifest.entries.every((entry) => entry.path !== "media/schedules/schedule-one"));
delivered.copy.close();

section("one-turn capture");
const pending = createBackup({ password, kdf });
db.prepare("DELETE FROM stickers WHERE sha256 = ?").run(shaA);
const captured = await unpack(await pending);
equal("row captured before deletion", captured.copy.prepare("SELECT count(*) AS n FROM stickers WHERE sha256 = ?").get(shaA).n, 1);
ok("file captured before deletion", existsSync(join(captured.dest, `stickers/ab/${shaA}.webp`)));
captured.copy.close();

section("busy capture retry");
db.exec("BEGIN IMMEDIATE");
const releaseTransaction = setTimeout(() => db.exec("COMMIT"), 20);
try {
  const retried = await createBackup({ password, kdf });
  ok("capture succeeds after transaction releases", existsSync(retried.path));
  ok("retry leaves no stage", readdirSync(join(data, "tmp", "backup")).every((name) => name === "exports"));
} finally { clearTimeout(releaseTransaction); }

section("unpaired export");
store.authRemove("creds");
const unpaired = await unpack(await createBackup({ password, kdf }));
equal("account null", unpaired.manifest.account, null);
equal("account count zero", unpaired.manifest.counts.stickers, 0);
equal("account table empty", unpaired.copy.prepare("SELECT count(*) AS n FROM stickers").get().n, 0);
ok("no account files", unpaired.manifest.entries.every((entry) => !["memory", "sticker", "schedule-media"].includes(entry.kind)));
ok("settings remain", unpaired.copy.prepare("SELECT count(*) AS n FROM bot_settings").get().n > 0);
unpaired.copy.close();

section("routes");
secrets.setDashboardPassword(panelPassword);
const stale = join(data, "tmp", "backup", "stale");
mkdirSync(stale);
writeFileSync(join(stale, "capture.db"), "old");
writeFileSync(join(data, "tmp", "backup", "exports", "old.levixbak"), "old");
const { default: router } = await import("../src/routes/backup.api.esm.js");
ok("router import leaves prior stage", existsSync(stale));
require("./src/backup/jobs.cjs").sweepBackupTemp();
ok("startup removes stale stage", !existsSync(stale));
ok("startup removes stale export", !existsSync(join(data, "tmp", "backup", "exports", "old.levixbak")));
const app = express();
app.use(express.json(), (req, _res, next) => { req.session = { authenticated: true }; next(); }, router);
const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
async function post(body) {
  const response = await fetch(`${base}/backup/exports`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { response, body: await response.json() };
}
try {
  equal("mismatch rejected", (await post({ password, confirm: "other", current: panelPassword })).response.status, 400);
  equal("short password rejected", (await post({ password: "short", confirm: "short", current: panelPassword })).body.code, "BAD_PASSWORD");
  equal("wrong panel password", (await post({ password, confirm: password, current: "wrong" })).response.status, 403);
  const started = await post({ password, confirm: password, current: panelPassword });
  ok("job id returned", /^[0-9a-f]{32}$/.test(started.body.jobId));
  equal("second job busy", (await post({ password, confirm: password, current: panelPassword })).response.status, 409);
  let job;
  for (let i = 0; i < 200; i++) {
    job = await (await fetch(`${base}/backup/jobs/${started.body.jobId}`)).json();
    if (job.done) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  ok("job finished", job.done && !job.error);
  if (job.result) {
    const download = await fetch(`${base}/backup/exports/${job.result.token}`);
    equal("download content type", download.headers.get("content-type"), "application/octet-stream");
    equal("download length", Number(download.headers.get("content-length")), job.result.size);
    equal("download bytes", (await download.arrayBuffer()).byteLength, job.result.size);
    const record = require("./src/backup/jobs.cjs").getExport(job.result.token);
    const originalPath = record.path;
    record.path = join(data, "missing-export.levixbak");
    const missingDownload = await fetch(`${base}/backup/exports/${job.result.token}`);
    equal("missing file returns 404", missingDownload.status, 404);
    equal("missing file has no attachment header", missingDownload.headers.get("content-disposition"), null);
    ok("missing file has JSON length", Number(missingDownload.headers.get("content-length")) !== job.result.size);
    equal("missing file is JSON", (await missingDownload.json()).code, "NOT_FOUND");
    record.path = originalPath;
    await fetch(`${base}/backup/exports/${job.result.token}`, { method: "DELETE" });
    equal("deleted export is missing", (await fetch(`${base}/backup/exports/${job.result.token}`)).status, 404);
  }
  equal("bad token missing", (await fetch(`${base}/backup/exports/bad`)).status, 404);
  const later = await post({ password, confirm: password, current: panelPassword });
  let laterJob;
  for (let i = 0; i < 200; i++) {
    laterJob = await (await fetch(`${base}/backup/jobs/${later.body.jobId}`)).json();
    if (laterJob.done) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (laterJob.result) {
    const jobs = require("./src/backup/jobs.cjs");
    jobs.getExport(laterJob.result.token).expiresAt = new Date(0).toISOString();
    equal("expired export missing", (await fetch(`${base}/backup/exports/${laterJob.result.token}`)).status, 404);
  } else ok("later export completed", false);
  for (let i = 0; i < 5; i++)
    equal(`wrong password attempt ${i + 1}`, (await post({ password, confirm: password, current: "wrong" })).response.status, 403);
  equal("wrong password throttled", (await post({ password, confirm: password, current: panelPassword })).response.status, 429);
} finally { server.close(); }

finish();

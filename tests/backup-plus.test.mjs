// Levix Plus data in a backup: an allowlist of message overrides, presets,
// visibility and Auto Reply account data. Nothing from plus:* and no other ext:* key.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import express from "express";
import { equal, finish, ok, require, section, useTempDataDir } from "./harness.mjs";

const data = useTempDataDir("levix-backup-plus");
const { db, migrate, MIGRATIONS } = require("./src/db/db.cjs");
const store = require("./src/db/store.cjs");
const { createBackup } = require("./src/backup/create.cjs");
const restore = require("./src/backup/restore.cjs");
const { activatePendingIfMatching } = require("./src/backup/activation.cjs");
const { openBackup, writeBackup, validateManifest } = require("./src/backup/format.cjs");
const { buildPlan, publicPlan } = require("./src/backup/plan.cjs");
const { readJournal } = require("./src/backup/journal.cjs");
const extensions = require("./src/backup/extensions.cjs");
const { customizableKeys } = require("./src/extensions/templateKeys.cjs");
const { createExtensionHost, reloadExtensions } = require("./src/extensions/host.cjs");

const password = "plus-backup-test-password";
const kdf = { N: 32768, r: 8, p: 1 };
const CONFIRM = { confirmDestructive: true };
const uploadDir = join(data, "tmp", "restore");
mkdirSync(uploadDir, { recursive: true });
const accountA = { lid: "111111111111111@lid", pn: "201000000011@s.whatsapp.net" };
const accountB = { lid: "222222222222222@lid", pn: "201000000022@s.whatsapp.net" };
const NAME_OK = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const templates = customizableKeys().filter((key) => NAME_OK.test(key));
const [K1, K2, K3] = templates;
const cfg = (name) => `ext:levix-plus:cfg:${name}`;
const ACCT = "ext:levix-plus:acct:autoReply";
const json = (value) => JSON.stringify(value);

let nextId = 0x700;
function upload(file) {
  const id = (++nextId).toString(16).padStart(32, "0");
  copyFileSync(file, join(uploadDir, `${id}.levixbak`));
  return id;
}
async function outcome(action) {
  try { await action(); return "ok"; }
  catch (error) { return error.code || error.message; }
}
function pair(account) {
  store.authWrite("creds", JSON.stringify({
    me: { id: account.pn.replace("@", ":1@"), lid: account.lid.replace("@", ":1@") },
    account: { key: 1 }, registered: false,
  }));
}
function rawRow(key) { return db.prepare("SELECT value FROM bot_settings WHERE key = ?").get(key)?.value ?? null; }
function plusRows() {
  return json(db.prepare("SELECT key, value FROM bot_settings WHERE key LIKE 'ext:%' OR key LIKE 'plus:%' ORDER BY key").all());
}
async function inspect(file) {
  const opened = await openBackup({ path: file, password });
  const dest = mkdtempSync(join(data, "inspect-"));
  await opened.extract({ dest });
  const copy = new DatabaseSync(join(dest, "db", "levix.db"), { readOnly: true });
  try {
    return { manifest: opened.manifest, keys: copy.prepare(
      "SELECT key FROM bot_settings WHERE key LIKE 'ext:%' OR key LIKE 'plus:%' ORDER BY key").all().map((row) => row.key) };
  } finally { copy.close(); }
}
async function planOf(file) {
  const { manifest: m } = await openBackup({ path: file, password });
  return publicPlan(buildPlan({ digests: m.digests ?? null, apiKeyNames: m.apiKeys, account: m.account,
    personaSha: m.entries.find((entry) => entry.kind === "persona")?.sha256 ?? null }));
}
async function craftedArchive(label, fill) {
  const file = join(data, `${label}.db`);
  const crafted = new DatabaseSync(file);
  migrate(crafted, MIGRATIONS.slice(0, 1));
  fill((key, raw) => crafted.prepare("INSERT INTO bot_settings (key, value) VALUES (?, ?)").run(key, raw));
  crafted.close();
  const content = readFileSync(file);
  const out = join(data, `${label}.levixbak`);
  await writeBackup({ outPath: out, password, kdf,
    manifest: { format: "levix-backup-manifest", version: 1, created: new Date().toISOString(),
      app: "test", schema: 1, platform: "test", account: null, counts: {}, apiKeys: [] },
    entries: [{ path: "db/levix.db", kind: "db", size: content.length,
      sha256: createHash("sha256").update(content).digest("hex"), source: content }] });
  return out;
}

ok("three customizable template keys exist", templates.length >= 3);

section("allowlist and value validation");
equal("template key is cfg", extensions.kindOf(cfg(K1)), "cfg");
equal("presets is cfg", extensions.kindOf(cfg("presets")), "cfg");
equal("visibility is cfg", extensions.kindOf(cfg("visibility")), "cfg");
equal("autoReply is acct", extensions.kindOf(ACCT), "acct");
for (const key of [cfg("junk"), "ext:levix-plus:acct:other", "ext:other:cfg:presets", "ext:other:acct:autoReply",
  "plus:installation-key", "plus:entitlement-hw", "auth:password", "secret:session", "setting:gemini_api_key", "prefix", null])
  equal(`not allowlisted: ${key}`, extensions.kindOf(key), null);
ok("isRestorableExtKey agrees", extensions.isRestorableExtKey(ACCT) && !extensions.isRestorableExtKey(cfg("junk")));
const nest = (levels) => '{"a":'.repeat(levels - 1) + "{}" + "}".repeat(levels - 1);
equal("plain object accepted", json(extensions.validateExtValue('{"en":"hi","n":[1,{"k":2}]}')), '{"en":"hi","n":[1,{"k":2}]}');
equal("depth 8 accepted", typeof extensions.validateExtValue(nest(8)), "object");
for (const [label, raw] of [["depth 9", nest(9)], ["oversized", json({ a: "x".repeat(70000) })],
  ["__proto__", '{"__proto__":{"polluted":true}}'], ["nested constructor", '{"a":{"constructor":{"b":1}}}'],
  ["prototype", '{"prototype":1}'], ["array", "[1]"], ["string", '"x"'], ["null", "null"], ["not json", "{"]]) {
  let code = null;
  try { extensions.validateExtValue(raw); } catch (error) { code = error.code; }
  equal(`${label} refused`, code, "DAMAGED");
}
ok("nothing polluted", ({}).polluted === undefined);

section("export holds exactly the allowlisted Plus keys");
pair(accountA);
db.prepare("INSERT INTO user_metadata (user_jid, is_owner, is_admin, first_seen, last_seen) VALUES (?,1,0,1,1)").run(accountA.lid);
// A backup from before any Plus data exists: an older backup.
const older = await createBackup({ password, kdf });
store.saveBotSetting(cfg(K1), { en: "backup one" });
store.saveBotSetting(cfg(K2), { en: "backup two" });
store.saveBotSetting(cfg("presets"), { list: [{ name: "preset" }] });
store.saveBotSetting(cfg("visibility"), { hidden: ["a"] });
store.saveBotSetting(ACCT, { chats: ["backup@g.us"] });
store.saveBotSetting(cfg("junk"), { v: 1 });
store.saveBotSetting("ext:levix-plus:acct:other", { v: 1 });
store.saveBotSetting("ext:other:cfg:x", { v: 1 });
store.saveBotSetting("plus:installation-key", "plus-installation-secret");
store.saveBotSetting("plus:entitlement-hw", "plus-entitlement-secret");
const full = await createBackup({ password, kdf });
{
  const { manifest, keys } = await inspect(full.path);
  equal("paired export holds the allowlisted keys only", json(keys),
    json([ACCT, cfg(K1), cfg(K2), cfg("presets"), cfg("visibility")].sort()));
  ok("no plus:* key", !keys.some((key) => key.startsWith("plus:")));
  equal("digests cover the same names", json(Object.keys(manifest.digests.plus).sort()),
    json(["acct:autoReply", `cfg:${K1}`, `cfg:${K2}`, "cfg:presets", "cfg:visibility"].sort()));
  validateManifest(manifest);
  ok("manifest with plus digests is valid", true);
  ok("no plus secret in the manifest", !JSON.stringify(manifest).includes("plus-installation-secret"));
}
store.authRemove("creds");
const unpaired = await createBackup({ password, kdf });
pair(accountA);
{
  const { keys } = await inspect(unpaired.path);
  equal("unpaired export keeps config and drops account data", json(keys),
    json([cfg(K1), cfg(K2), cfg("presets"), cfg("visibility")].sort()));
}
{
  const { manifest } = await inspect(older.path);
  ok("older backup has no plus digests", !manifest.digests || manifest.digests.plus === undefined);
}

section("preview lists Plus counts");
store.saveBotSetting(cfg(K1), { en: "live one" });
store.deleteBotSetting(cfg(K2));
store.saveBotSetting(cfg(K3), { en: "live three" });
store.deleteBotSetting(cfg("presets"));
store.saveBotSetting(cfg("visibility"), { hidden: ["a"] });
store.saveBotSetting(ACCT, { chats: ["live@g.us"] });
{
  const plan = await planOf(full.path);
  equal("messages counted", json(plan.plus.messages), json({ total: 2, added: 1, replaced: 1, unchanged: 0 }));
  equal("presets added", plan.plus.presets, "added");
  equal("visibility unchanged", plan.plus.visibility, "unchanged");
  equal("autoReply replaced", plan.plus.autoReply, "replaced");
  equal("autoReply waits for activation", plan.plus.autoReplyWaits, true);
  equal("replacing an override is destructive", plan.destructive, true);
  ok("plan holds no digest", !/[0-9a-f]{64}/.test(json(plan.plus)));
  const old = await planOf(older.path);
  equal("older backup plan: none", json([old.plus.presets, old.plus.visibility, old.plus.autoReply]), json(["none", "none", "none"]));
  equal("older backup plan: no messages", old.plus.messages.total, 0);
}

section("route returns the plus field");
{
  const { default: router } = await import("../src/routes/backup.api.esm.js");
  const app = express();
  app.use(express.json(), (req, _res, next) => { req.session = { authenticated: true }; next(); }, router);
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/backup/restore/uploads/${upload(full.path)}/preview`,
      { method: "POST", headers: { "content-type": "application/json" }, body: json({ password }) });
    const text = await response.text();
    const body = JSON.parse(text);
    equal("preview ok", response.status, 200);
    equal("preview plus messages", json(body.plus?.messages), json({ total: 2, added: 1, replaced: 1, unchanged: 0 }));
    equal("preview plus matches the plan", json(body.plus), json(body.plan.plus));
    ok("preview holds no digest", !/[0-9a-f]{64}/.test(text));
  } finally { await new Promise((resolve) => server.close(resolve)); }
}

section("restore: config applies now, account data waits, plus:* untouched");
{
  const secretBefore = [rawRow("plus:installation-key"), rawRow("plus:entitlement-hw")];
  const rowsBefore = plusRows();
  equal("unconfirmed restore refused", await outcome(() => restore.restoreUpload(upload(full.path), password)), "CONFIRM_REQUIRED");
  equal("refusal changes no Plus row", plusRows(), rowsBefore);

  const result = await restore.restoreUpload(upload(full.path), password, undefined, CONFIRM);
  equal("override replaced", json(store.getBotSetting(cfg(K1))), json({ en: "backup one" }));
  equal("override added", json(store.getBotSetting(cfg(K2))), json({ en: "backup two" }));
  equal("override the backup lacks is kept", json(store.getBotSetting(cfg(K3))), json({ en: "live three" }));
  equal("presets added", json(store.getBotSetting(cfg("presets"))), json({ list: [{ name: "preset" }] }));
  equal("visibility restored", json(store.getBotSetting(cfg("visibility"))), json({ hidden: ["a"] }));
  equal("junk row the backup lacks is kept", json(store.getBotSetting(cfg("junk"))), json({ v: 1 }));
  ok("result lists the applied Plus names", result.applied.includes("cfg:presets") && result.applied.includes(`cfg:${K1}`));
  equal("result plan carries plus", result.plan.plus.presets, "added");
  equal("autoReply not applied before activation", json(store.getBotSetting(ACCT)), json({ chats: ["live@g.us"] }));
  equal("account data waits", restore.pendingStatus().waiting, true);
  equal("plus:* untouched by restore", json([rawRow("plus:installation-key"), rawRow("plus:entitlement-hw")]), json(secretBefore));

  equal("matching account activates", activatePendingIfMatching(), true);
  equal("autoReply applied after activation", json(store.getBotSetting(ACCT)), json({ chats: ["backup@g.us"] }));
  equal("plus:* untouched by activation", json([rawRow("plus:installation-key"), rawRow("plus:entitlement-hw")]), json(secretBefore));
  equal("config untouched by activation", json(store.getBotSetting(cfg(K3))), json({ en: "live three" }));
  equal("other acct row is not written", rawRow("ext:levix-plus:acct:other"), null);
}

section("a different account never gets the Auto Reply data");
{
  store.saveBotSetting(ACCT, { chats: ["live@g.us"] });
  pair(accountB);
  equal("restore under another account runs", await outcome(() => restore.restoreUpload(upload(full.path), password, undefined, CONFIRM)), "ok");
  equal("data waits", restore.pendingStatus().waiting, true);
  equal("data does not match", restore.pendingStatus().matchesPaired, false);
  equal("mismatched account does not activate", activatePendingIfMatching(), false);
  equal("mismatched account keeps its autoReply", json(store.getBotSetting(ACCT)), json({ chats: ["live@g.us"] }));
  pair(accountA);
  equal("matching account activates later", activatePendingIfMatching(), true);
  equal("matching account gets the autoReply", json(store.getBotSetting(ACCT)), json({ chats: ["backup@g.us"] }));
}

section("an older backup keeps current values");
{
  store.saveBotSetting(cfg(K1), { en: "current one" });
  store.saveBotSetting(cfg("presets"), { list: [] });
  store.saveBotSetting(ACCT, { chats: ["current@g.us"] });
  const before = plusRows();
  equal("older backup restores", await outcome(() => restore.restoreUpload(upload(older.path), password, undefined, CONFIRM)), "ok");
  equal("older backup leaves every Plus row", plusRows(), before);
  equal("older backup account data activates", activatePendingIfMatching(), true);
  equal("activation keeps the autoReply the backup lacks", json(store.getBotSetting(ACCT)), json({ chats: ["current@g.us"] }));
  equal("activation keeps config", json(store.getBotSetting(cfg(K1))), json({ en: "current one" }));
}

section("a crafted backup with other Plus or ext keys is refused");
{
  const before = plusRows();
  const cases = [
    ["plus-key", "plus:installation-key", '"x"'],
    ["plus-hw", "plus:entitlement-hw", '"x"'],
    ["other-ext", "ext:other:cfg:x", '{"v":1}'],
    ["other-ext-acct", "ext:other:acct:x", '{"v":1}'],
    ["plus-junk", cfg("junk"), '{"v":1}'],
    ["plus-acct-other", "ext:levix-plus:acct:other", '{"v":1}'],
    ["oversized", cfg("presets"), json({ a: "x".repeat(70000) })],
    ["deep", cfg("presets"), nest(9)],
    ["proto", cfg("presets"), '{"__proto__":{"polluted":true}}'],
    ["constructor", cfg("presets"), '{"a":{"constructor":{"b":1}}}'],
    ["prototype", ACCT, '{"prototype":1}'],
    ["array", cfg("visibility"), "[1]"],
    ["not-json", cfg("visibility"), "{"],
  ];
  for (const [label, key, raw] of cases) {
    const archive = await craftedArchive(`plus-${label}`, (put) => put(key, raw));
    equal(`${label} refused`, await outcome(() => restore.restoreUpload(upload(archive), password, undefined, CONFIRM)), "DAMAGED");
    equal(`${label} leaves no journal`, readJournal(), null);
    equal(`${label} changes no Plus row`, plusRows(), before);
  }
  ok("no prototype pollution", ({}).polluted === undefined && Object.prototype.polluted === undefined);
  if (templates.length >= 199) {
    const archive = await craftedArchive("plus-too-many", (put) => {
      for (const name of ["presets", "visibility", ...templates.slice(0, 199)]) put(cfg(name), '{"v":1}');
    });
    equal("more than 200 names refused", await outcome(() => restore.restoreUpload(upload(archive), password, undefined, CONFIRM)), "DAMAGED");
    equal("too many names change no row", plusRows(), before);
  }
  const good = await craftedArchive("plus-allowed", (put) => put(cfg("presets"), '{"a":1}'));
  equal("an allowlisted key in a crafted backup is accepted", await outcome(() => restore.restoreUpload(upload(good), password, undefined, CONFIRM)), "ok");
  equal("accepted key applied", json(store.getBotSetting(cfg("presets"))), json({ a: 1 }));
}

section("reload after restore");
{
  equal("reload does nothing when the host is not running", await reloadExtensions(), false);
  let activations = 0;
  let deactivations = 0;
  const silent = { child() { return silent; }, info() {}, warn() {}, error() {}, debug() {} };
  const host = createExtensionHost({ log: silent, pollMs: 60000, settingsGet: () => true,
    entitlement: { isActive: () => true, subscribe: () => () => {} },
    loadModule: () => ({ apiVersion: 1, id: "levix-plus", version: "1.0.0", requiresEntitlement: "plus",
      capabilities: ["templates"],
      async activate() { activations += 1; return { templates: { resolve: () => null } }; },
      async deactivate() { deactivations += 1; } }) });
  await host.start();
  equal("host active", json([host.status().state, activations]), json(["active", 1]));
  equal("reload restarts the running host", await host.reload(), true);
  equal("reload activated again", json([host.status().state, activations, deactivations]), json(["active", 2, 1]));
  await host.stop();
  equal("stopped host is not restarted by reload", await host.reload(), false);
}

finish();

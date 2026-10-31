// A restore adds and replaces what the backup holds and keeps everything else.
// Destructive changes need confirmDestructive; failed restores change nothing.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import express from "express";
import { equal, finish, ok, require, section, useTempDataDir } from "./harness.mjs";

const data = useTempDataDir("levix-backup-restore-merge");
const { db } = require("./src/db/db.cjs");
const store = require("./src/db/store.cjs");
const settings = require("./src/config/settings.cjs");
const runtime = require("./src/config/runtime-config.cjs");
const secrets = require("./src/config/secrets.cjs");
const { createBackup } = require("./src/backup/create.cjs");
const restore = require("./src/backup/restore.cjs");
const { openBackup, writeBackup, validateManifest } = require("./src/backup/format.cjs");
const { buildPlan, publicPlan, currentDigests } = require("./src/backup/plan.cjs");
const { runRestoreRecovery } = require("./src/backup/recovery.cjs");
const { readJournal } = require("./src/backup/journal.cjs");

const password = "merge-test-backup-password";
const panelPassword = "merge-panel-password";
const kdf = { N: 32768, r: 8, p: 1 };
const CONFIRM = { confirmDestructive: true };
const personaFile = join(data, "ai-persona.md");
const uploadDir = join(data, "tmp", "restore");
mkdirSync(uploadDir, { recursive: true });
const accountA = { lid: "111111111111111@lid", pn: "201000000011@s.whatsapp.net" };
const accountB = { lid: "222222222222222@lid", pn: "201000000022@s.whatsapp.net" };

let nextId = 0x500;
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
function stagingDirs() {
  const folder = join(data, "restore");
  return existsSync(folder) ? readdirSync(folder).filter((name) => /^[0-9a-f]{32}$/.test(name)) : [];
}
function snapshot() {
  return JSON.stringify({
    language: settings.get("bot_language"), model: settings.get("gemini_model"),
    gemini: settings.get("gemini_api_key"), openai: settings.get("openai_api_key"),
    prefix: runtime.getPrefix(), ping: runtime.getPermission("ping"),
    persona: existsSync(personaFile) ? readFileSync(personaFile, "utf8") : null,
    password: rawRow("auth:password"), session: rawRow("secret:session"),
    recovery: rawRow("auth:recovery-email"), creds: store.authRead?.("creds") ??
      db.prepare("SELECT value FROM baileys_auth WHERE key = 'creds'").get()?.value ?? null,
    sealedOpenai: rawRow("setting:openai_api_key"),
    accountRows: db.prepare("SELECT count(*) AS n FROM user_metadata").get().n,
  });
}
async function planOf(file) {
  const opened = await openBackup({ path: file, password });
  const m = opened.manifest;
  return buildPlan({ digests: m.digests ?? null, apiKeyNames: m.apiKeys, account: m.account,
    personaSha: m.entries.find((entry) => entry.kind === "persona")?.sha256 ?? null });
}

section("backups for the cases");
rmSync(personaFile, { force: true });
const empty = await createBackup({ password, kdf });
settings.set("bot_language", "en");
settings.set("gemini_api_key", "gem-backup-value");
runtime.setPrefix("!");
writeFileSync(personaFile, "backup persona");
const partial = await createBackup({ password, kdf });
{
  const opened = await openBackup({ path: partial.path, password });
  const text = JSON.stringify(opened.manifest);
  ok("manifest holds digests", Boolean(opened.manifest.digests));
  ok("manifest never holds a plain API key", !text.includes("gem-backup-value"));
  equal("API key digest matches the plain value", opened.manifest.digests.apiKeys.gemini_api_key,
    createHash("sha256").update("gem-backup-value").digest("hex"));
}

// The install the restores land on.
settings.set("bot_language", "ar");
settings.set("gemini_api_key", "gem-current-value");
settings.set("openai_api_key", "openai-current-value");
runtime.setPrefix(">");
runtime.setPermission("ping", "ADMINS_ONLY");
writeFileSync(personaFile, "current persona");
secrets.setDashboardPassword(panelPassword);
store.saveBotSetting("auth:recovery-email", "sealed-recovery-record");
store.saveBotSetting("secret:session", "session-key-merge-test");
pair(accountA);
db.prepare("INSERT INTO user_metadata (user_jid, is_owner, is_admin, first_seen, last_seen) VALUES (?,1,0,1,1)")
  .run(accountA.lid);
const sameAccount = await createBackup({ password, kdf });
pair(accountB);
const otherAccount = await createBackup({ password, kdf });
pair(accountA);
const target = snapshot();
ok("sealed key at rest is not plain", !String(rawRow("setting:openai_api_key")).includes("openai-current-value"));

section("empty backup keeps every value");
{
  const plan = publicPlan(await planOf(empty.path));
  equal("empty plan is not destructive", plan.destructive, false);
  ok("empty plan keeps the language", plan.settings.kept.includes("bot_language"));
  ok("empty plan keeps both API keys",
    ["gemini_api_key", "openai_api_key"].every((name) => plan.apiKeys.kept.includes(name)));
  equal("empty plan keeps the persona", plan.persona, "kept");
  equal("empty restore needs no confirmation", await outcome(() => restore.restoreUpload(upload(empty.path), password)), "ok");
  equal("empty restore changes nothing", snapshot(), target);
  equal("persona survives a backup without one", readFileSync(personaFile, "utf8"), "current persona");
}

section("partial backup: confirmation, merge and preserved secrets");
{
  const plan = publicPlan(await planOf(partial.path));
  equal("partial plan is destructive", plan.destructive, true);
  ok("language is replaced", plan.settings.replaced.includes("bot_language"));
  ok("prefix is replaced", plan.settings.replaced.includes("prefix"));
  ok("permissions are kept", plan.settings.kept.includes("command_permissions"));
  equal("gemini key is replaced", plan.apiKeys.replaced.join(","), "gemini_api_key");
  equal("openai key is kept", plan.apiKeys.kept.join(","), "openai_api_key");
  equal("persona is replaced", plan.persona, "replaced");
  ok("plan holds names only", !/[0-9a-f]{64}/.test(JSON.stringify(plan)) &&
    !JSON.stringify(plan).includes("gem-backup-value"));

  equal("unconfirmed destructive restore refused",
    await outcome(() => restore.restoreUpload(upload(partial.path), password)), "CONFIRM_REQUIRED");
  equal("refused restore changes nothing", snapshot(), target);
  equal("refused restore leaves no staging", stagingDirs().length, 0);
  equal("refused restore leaves no journal", readJournal(), null);

  const result = await restore.restoreUpload(upload(partial.path), password, undefined, CONFIRM);
  equal("language replaced", settings.get("bot_language"), "en");
  equal("gemini key replaced", settings.get("gemini_api_key"), "gem-backup-value");
  equal("openai key kept", settings.get("openai_api_key"), "openai-current-value");
  equal("sealed openai row untouched", rawRow("setting:openai_api_key"), JSON.parse(target).sealedOpenai);
  equal("prefix replaced", runtime.getPrefix(), "!");
  equal("permission kept", runtime.getPermission("ping"), "ADMINS_ONLY");
  equal("persona replaced", readFileSync(personaFile, "utf8"), "backup persona");
  const now = JSON.parse(snapshot());
  const before = JSON.parse(target);
  equal("panel password kept", now.password, before.password);
  equal("session key kept", now.session, before.session);
  equal("recovery record kept", now.recovery, before.recovery);
  equal("pairing kept", now.creds, before.creds);
  ok("result carries the plan", result.plan?.destructive === true && result.plan.apiKeys.kept.includes("openai_api_key"));
  ok("no plain key in the gemini row", !String(rawRow("setting:gemini_api_key")).includes("gem-backup-value"));

  const again = publicPlan(await planOf(partial.path));
  equal("same backup again is not destructive", again.destructive, false);
  ok("same values are unchanged", again.settings.unchanged > 0 && again.apiKeys.unchanged === 1);
  equal("repeat restore needs no confirmation",
    await outcome(() => restore.restoreUpload(upload(partial.path), password)), "ok");
}

section("added values need no confirmation");
{
  settings.set("bot_language", null);
  settings.set("gemini_api_key", null);
  const plan = publicPlan(await planOf(partial.path));
  ok("language is added", plan.settings.added.includes("bot_language"));
  equal("gemini key is added", plan.apiKeys.added.join(","), "gemini_api_key");
  equal("added-only plan is not destructive", plan.destructive, false);
  equal("added-only restore runs", await outcome(() => restore.restoreUpload(upload(partial.path), password)), "ok");
  equal("language added", settings.get("bot_language"), "en");
  equal("gemini key added", settings.get("gemini_api_key"), "gem-backup-value");
}

section("accounts");
{
  const same = publicPlan(await planOf(sameAccount.path));
  equal("same account replaces its current data", same.accountData?.replacesCurrent, true);
  equal("same account plan is destructive", same.destructive, true);
  const other = publicPlan(await planOf(otherAccount.path));
  equal("other account does not touch current data", other.accountData?.replacesCurrent, false);
  equal("nothing waits yet", other.accountData?.replacesWaiting, null);

  // Bring the settings to the other backup's values, so only account data is in play.
  settings.set("bot_language", "ar");
  settings.set("gemini_api_key", "gem-current-value");
  runtime.setPrefix(">");
  writeFileSync(personaFile, "current persona");
  const otherNow = publicPlan(await planOf(otherAccount.path));
  equal("other account restore is not destructive", otherNow.destructive, false);
  const rowsBefore = db.prepare("SELECT count(*) AS n FROM user_metadata").get().n;
  equal("other account restore runs", await outcome(() => restore.restoreUpload(upload(otherAccount.path), password)), "ok");
  equal("other account data waits", restore.pendingStatus().waiting, true);
  equal("other account data does not match", restore.pendingStatus().matchesPaired, false);
  equal("current account rows untouched", db.prepare("SELECT count(*) AS n FROM user_metadata").get().n, rowsBefore);

  const replacing = publicPlan(await planOf(otherAccount.path));
  ok("a waiting restore would be replaced", Boolean(replacing.accountData?.replacesWaiting));
  equal("replacing waiting data is destructive", replacing.destructive, true);
  const pendingBefore = readFileSync(join(data, "restore", "pending", "pending.json"), "utf8");
  equal("unconfirmed replacement refused",
    await outcome(() => restore.restoreUpload(upload(otherAccount.path), password)), "CONFIRM_REQUIRED");
  equal("waiting data unchanged", readFileSync(join(data, "restore", "pending", "pending.json"), "utf8"), pendingBefore);
  restore.discardPending();
}

section("failed restores change nothing");
{
  const before = snapshot();
  equal("wrong password", await outcome(() =>
    restore.restoreUpload(upload(partial.path), "wrong-password-long-enough", undefined, CONFIRM)), "WRONG_PASSWORD");
  const damaged = join(data, "damaged.levixbak");
  const bytes = readFileSync(partial.path);
  bytes[bytes.length - 40] ^= 0xff;
  writeFileSync(damaged, bytes);
  equal("damaged file", await outcome(() => restore.restoreUpload(upload(damaged), password, undefined, CONFIRM)), "DAMAGED");
  equal("failed restores keep every value", snapshot(), before);
  equal("failed restores leave no staging", stagingDirs().length, 0);
}

section("backups without digests");
{
  const opened = await openBackup({ path: partial.path, password });
  const dest = mkdtempSync(join(data, "nodigest-"));
  const { memory } = await opened.extract({ dest });
  const { digests: _omitted, ...manifest } = opened.manifest;
  validateManifest(manifest);
  ok("a manifest without digests is valid", true);
  const entries = manifest.entries.map((entry) => ({ ...entry,
    source: memory[entry.path] ?? join(dest, entry.path) }));
  const legacy = join(data, "legacy.levixbak");
  await writeBackup({ outPath: legacy, password, manifest, entries, kdf });
  const plan = publicPlan(await planOf(legacy));
  equal("plan is not exact", plan.exact, false);
  equal("unknown plan counts as destructive", plan.destructive, true);
  let refused = false;
  try { validateManifest({ ...manifest, digests: { settings: {}, apiKeys: {} } }); }
  catch (error) { refused = error.code === "BAD_MANIFEST"; }
  ok("digests must cover the API key names", refused);
}

section("routes: preview plan and confirmation");
{
  settings.set("bot_language", "ar");
  const { default: router } = await import("../src/routes/backup.api.esm.js");
  const app = express();
  app.use(express.json(), (req, _res, next) => { req.session = { authenticated: true }; next(); }, router);
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body) => {
    const response = await fetch(`${base}${path}`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, text: await response.text() };
  };
  const waitJob = async (id) => {
    for (let i = 0; i < 300; i++) {
      const job = await (await fetch(`${base}/backup/jobs/${id}`)).json();
      if (job.done) return job;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return null;
  };
  try {
    const id = upload(partial.path);
    const preview = await post(`/backup/restore/uploads/${id}/preview`, { password });
    const body = JSON.parse(preview.text);
    equal("preview ok", preview.status, 200);
    ok("preview lists the replaced language", body.plan?.settings.replaced.includes("bot_language"));
    ok("preview holds no digest and no value", !/[0-9a-f]{64}/.test(preview.text) &&
      !preview.text.includes("gem-backup-value"));
    const refused = JSON.parse((await post(`/backup/restore/uploads/${id}/restore`,
      { password, current: panelPassword })).text);
    equal("unconfirmed route job fails", (await waitJob(refused.jobId))?.error?.code, "CONFIRM_REQUIRED");
    equal("route refusal keeps the language", settings.get("bot_language"), "ar");
    const confirmed = JSON.parse((await post(`/backup/restore/uploads/${id}/restore`,
      { password, current: panelPassword, confirmDestructive: true })).text);
    const job = await waitJob(confirmed.jobId);
    ok("confirmed route job finishes", job?.done && !job.error);
    equal("confirmed route restore applies", settings.get("bot_language"), "en");
    settings.set("bot_language", "ar");
    const strict = JSON.parse((await post(`/backup/restore/uploads/${upload(partial.path)}/restore`,
      { password, current: panelPassword, confirmDestructive: "yes" })).text);
    equal("only literal true confirms", (await waitJob(strict.jobId))?.error?.code, "CONFIRM_REQUIRED");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

section("side effects of a restore need confirmation");
{
  // gpt-4o-mini is a seeded model without speech input, so applying the
  // provider switch turns speech off as a side effect.
  settings.set("ai_provider", "openai");
  settings.set("openai_model", "gpt-4o-mini");
  settings.set("ai_stt_enabled", null);
  store.authRemove("creds");
  const providerOnly = await createBackup({ password, kdf });
  pair(accountA);
  settings.set("ai_provider", null);
  settings.set("openai_model", null);
  settings.set("ai_stt_enabled", true);
  const preview = publicPlan(await planOf(providerOnly.path));
  ok("preview adds the provider", preview.settings.added.includes("ai_provider"));
  ok("preview keeps speech", preview.settings.kept.includes("ai_stt_enabled"));
  let refused;
  try { await restore.restoreUpload(upload(providerOnly.path), password); }
  catch (error) { refused = error; }
  equal("side effect refused", refused?.code, "CONFIRM_REQUIRED");
  ok("refusal names the side effect", refused?.plan?.settings.replaced.includes("ai_stt_enabled"));
  equal("refusal is about the side effect only", refused?.plan?.accountData, null);
  equal("refusal keeps speech on", settings.get("ai_stt_enabled"), true);
  equal("refusal keeps the provider", settings.get("ai_provider"), "gemini");
  await restore.restoreUpload(upload(providerOnly.path), password, undefined, CONFIRM);
  equal("confirmed restore switches the provider", settings.get("ai_provider"), "openai");
  equal("confirmed restore turns speech off", settings.get("ai_stt_enabled"), false);
  settings.set("ai_provider", null);
  settings.set("openai_model", null);
  settings.set("ai_stt_enabled", null);
}

section("a forged manifest cannot skip confirmation");
{
  settings.set("bot_language", "ar");
  settings.set("gemini_api_key", "gem-current-value");
  runtime.setPrefix(">");
  writeFileSync(personaFile, "backup persona");
  const opened = await openBackup({ path: partial.path, password });
  const dest = mkdtempSync(join(data, "forged-"));
  const { memory } = await opened.extract({ dest });
  const now = currentDigests();
  const forge = (claimed, current) => Object.fromEntries(Object.keys(claimed)
    .map((key) => [key, current[key] ?? claimed[key]]));
  const manifest = { ...opened.manifest, digests: {
    settings: forge(opened.manifest.digests.settings, now.settings),
    apiKeys: forge(opened.manifest.digests.apiKeys, now.apiKeys) } };
  const forged = join(data, "forged.levixbak");
  await writeBackup({ outPath: forged, password, manifest, kdf,
    entries: manifest.entries.map((entry) => ({ ...entry, source: memory[entry.path] ?? join(dest, entry.path) })) });
  equal("forged preview looks harmless", publicPlan(await planOf(forged)).destructive, false);
  let refused;
  try { await restore.restoreUpload(upload(forged), password); }
  catch (error) { refused = error; }
  equal("job refuses the forged restore", refused?.code, "CONFIRM_REQUIRED");
  ok("job plan shows the real replacement", refused?.plan?.settings.replaced.includes("bot_language"));
  equal("forged restore changes nothing", settings.get("bot_language"), "ar");
}

section("crash recovery keeps a persona the backup lacks");
{
  writeFileSync(personaFile, "persona before crash");
  restore.setCrashHookForTest((step) => { if (step === "persona") throw new Error("test crash"); });
  try { await restore.restoreUpload(upload(empty.path), password); } catch {}
  restore.setCrashHookForTest(null);
  ok("crash left a journal", readJournal() !== null);
  runRestoreRecovery();
  equal("recovery finished", readJournal(), null);
  equal("recovery keeps the persona", readFileSync(personaFile, "utf8"), "persona before crash");
}

section("an invalid command-table entry keeps the current one");
{
  store.saveBotSetting("command_permissions", { ping: "NOT_A_LEVEL", help: "MEMBERS" });
  const badPermissions = await createBackup({ password, kdf });
  store.deleteBotSetting("command_permissions");
  runtime.setPermission("ping", "ADMINS_ONLY");
  const result = await restore.restoreUpload(upload(badPermissions.path), password, undefined, CONFIRM);
  ok("entry reported as skipped", result.skipped.some((item) => item.key === "command_permissions"));
  equal("current permission kept", runtime.getPermission("ping"), "ADMINS_ONLY");
}

finish();

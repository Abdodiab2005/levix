const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { db, migrate, MIGRATIONS, fsyncDirectory } = require("../db/db.cjs");
const { SECRET_TABLES, isSecretBotKey } = require("../db/copy.cjs");
const store = require("../db/store.cjs");
const settings = require("../config/settings.cjs");
const runtime = require("../config/runtime-config.cjs");
const { dataPath, ensureDataDir } = require("../config/paths.cjs");
const { applySettingChange } = require("../services/settingsTransfer.cjs");
const { BackupError, openBackup } = require("./format.cjs");
const { classifyTables, RESTORABLE_SETTING_KEYS, COMMAND_TABLE_KEYS } = require("./content.cjs");
const { readPairedAccount, maskAccount, accountsMatch } = require("./account.cjs");
const { writeJournal, readJournal, clearJournal, writeOutcome, readOutcome, atomicJson } = require("./journal.cjs");
const uploads = require("./uploads.cjs");
const { buildPlan, appliedPlan, currentDigests, digestsFrom, restorableRows, publicPlan } = require("./plan.cjs");

const root = () => {
  const folder = ensureDataDir("restore");
  if (process.platform !== "win32") fs.chmodSync(folder, 0o700);
  return folder;
};
const stageRoot = (id) => dataPath("restore", id);
const staged = (id) => dataPath("restore", id, "staged");
const marker = () => {
  try { return JSON.parse(store.getBotSetting("restore:applied", "null"))?.id; }
  catch { return null; }
};
let crashHook = null;
// Test-only injection. Tests may throw at a named boundary, then start recovery.
function setCrashHookForTest(fn) { crashHook = fn; }
function crash(name) {
  if (!crashHook) return;
  try { crashHook(name); }
  catch (error) { error.restoreTestCrash = true; throw error; }
}
function schemaCheck(manifest) {
  if (manifest.schema > MIGRATIONS.length) throw new BackupError("SCHEMA_NEWER", "Backup schema is newer");
}
function spaceCheck(manifest) {
  const total = manifest.entries.reduce((n, entry) => n + entry.size, 0);
  const dbSize = manifest.entries.find((entry) => entry.kind === "db").size;
  const stat = fs.statfsSync(root());
  if (Number(stat.bavail) * Number(stat.bsize) < total + 2 * dbSize + 64 * 1024 ** 2)
    throw new BackupError("NO_SPACE", "Insufficient storage");
  return total;
}
function safeJson(raw, fallback) { try { return JSON.parse(raw); } catch { return fallback; } }

const restorableKeys = [...RESTORABLE_SETTING_KEYS.map((key) => `setting:${key}`), ...COMMAND_TABLE_KEYS];
function quoteSqlName(name) {
  return `"${String(name).replaceAll('"', '""')}"`;
}
// A Levix backup never contains these rows. Treat a copy that has them as crafted.
function assertNoExcludedData(database) {
  for (const table of SECRET_TABLES) {
    const present = database.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(table);
    if (!present) continue;
    const row = database.prepare(`SELECT 1 AS present FROM ${quoteSqlName(table)} LIMIT 1`).get();
    if (row) throw new BackupError("DAMAGED", "Backup database holds excluded data");
  }
  const settingsTable = database.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'bot_settings'",
  ).get();
  if (!settingsTable) return;
  for (const row of database.prepare("SELECT key FROM bot_settings").iterate()) {
    if (isSecretBotKey(row.key)) throw new BackupError("DAMAGED", "Backup database holds excluded data");
  }
}
function expectedSchema(database) {
  const version = database.prepare("PRAGMA user_version").get().user_version;
  if (!Number.isInteger(version) || version < 0) throw new BackupError("SCHEMA_MISMATCH", "Backup database schema differs");
  if (version > MIGRATIONS.length) throw new BackupError("SCHEMA_NEWER", "Backup schema is newer");
  const reference = new DatabaseSync(":memory:");
  try {
    migrate(reference, MIGRATIONS.slice(0, version));
    const definitionRows = (dbHandle, limit) => dbHandle.prepare(
      `SELECT type, name, tbl_name, substr(sql, 1, 65537) AS sql, length(sql) AS sql_length
       FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'
       ORDER BY type, name, tbl_name LIMIT ?`,
    ).all(limit);
    const wanted = definitionRows(reference, 1000);
    const actual = definitionRows(database, wanted.length + 1);
    const normalize = (sql) => String(sql ?? "").replace(/\s+/g, " ").trim();
    if (wanted.length === 1000 || actual.length !== wanted.length || actual.some((row, index) =>
      row.sql_length > 65536 || row.type !== wanted[index].type || row.name !== wanted[index].name ||
      row.tbl_name !== wanted[index].tbl_name || normalize(row.sql) !== normalize(wanted[index].sql)))
      throw new BackupError("SCHEMA_MISMATCH", "Backup database schema differs");
  } catch (error) {
    if (error instanceof BackupError) throw error;
    throw new BackupError("SCHEMA_MISMATCH", "Backup database schema differs");
  } finally { reference.close(); }
}

function fsyncStagedTree(folder) {
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const item = path.join(folder, entry.name);
    if (entry.isDirectory()) fsyncStagedTree(item);
    else if (entry.isFile()) {
      const fd = fs.openSync(item, "r");
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } else throw new BackupError("DAMAGED", "Invalid staged item");
  }
  fsyncDirectory(folder);
}

function applySettings(id, secrets, { base, confirmDestructive = false } = {}) {
  const source = new DatabaseSync(path.join(staged(id), "db", "levix.db"), { readOnly: true });
  const report = { applied: [], skipped: [], restartNeeded: [] };
  const skip = (key) => report.skipped.push({ key, reason: "Rejected value" });
  try {
    db.exec("PRAGMA synchronous = FULL");
    db.exec("BEGIN IMMEDIATE");
    try {
      const before = currentDigests();
      // Only what the backup contains is written. A setting, an API key or a
      // command-table entry the backup lacks keeps its value on this install.
      const rows = source.prepare(`SELECT key,
        CASE WHEN length(CAST(value AS BLOB)) <= 1048576 THEN value ELSE NULL END AS value,
        length(CAST(value AS BLOB)) > 1048576 AS oversized
        FROM bot_settings WHERE key IN (${restorableKeys.map(() => "?").join(",")})`).all(...restorableKeys);
      const priority = (key) => key === "setting:ai_provider" ? 0 :
        /^(setting:(gemini|openai|anthropic)_model|setting:ai_auto_detect_capabilities)$/.test(key) ? 1 :
          ["setting:ai_vision_enabled", "setting:ai_stt_enabled"].includes(key) ? 3 : 2;
      for (const { key, value, oversized } of rows.filter((row) => row.key.startsWith("setting:"))
        .sort((a, b) => priority(a.key) - priority(b.key))) {
        if (!key.startsWith("setting:")) continue;
        const name = key.slice(8);
        if (!RESTORABLE_SETTING_KEYS.includes(name)) { skip("unknown setting"); continue; }
        if (oversized) { skip(name); continue; }
        const parsed = safeJson(value, undefined);
        if (parsed === undefined) { skip(name); continue; }
        try {
          applySettingChange(name, parsed);
          report.applied.push(name);
          if (settings.RESTART_SETTING_KEYS.includes(name)) report.restartNeeded.push(name);
        } catch { skip(name); }
      }
      if (secrets) {
        if (!secrets.settings || typeof secrets.settings !== "object" || Array.isArray(secrets.settings))
          throw new BackupError("BAD_MANIFEST", "Invalid secret payload");
        for (const [key, value] of Object.entries(secrets.settings)) {
          if (!settings.SECRET_SETTING_KEYS.includes(key)) { skip("unknown secret"); continue; }
          try { applySettingChange(key, value); report.applied.push(key); }
          catch { skip(key); }
        }
      }
      for (const row of rows.filter((item) => COMMAND_TABLE_KEYS.includes(item.key) && item.oversized)) skip(row.key);
      const commandRows = new Map(rows.filter((row) => COMMAND_TABLE_KEYS.includes(row.key) && !row.oversized)
        .map((row) => [row.key, safeJson(row.value, null)]));
      if (commandRows.has("prefix")) {
        try { runtime.setPrefix(commandRows.get("prefix")); report.applied.push("prefix"); }
        catch { skip("prefix"); }
      }
      // A command-table key in the backup replaces this install's whole entry,
      // all or nothing: one bad item puts the current entry back and skips it.
      const isMap = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
      const replaceEntry = (key, value, valid, applyAll) => {
        if (!commandRows.has(key)) return;
        if (!valid(value)) { skip(key); return; }
        const previous = store.getBotSetting(key, null);
        store.deleteBotSetting(key);
        try { applyAll(value); report.applied.push(key); }
        catch {
          store.deleteBotSetting(key);
          if (previous !== null) store.saveBotSetting(key, previous);
          skip(key);
        }
      };
      replaceEntry("command_permissions", commandRows.get("command_permissions"), isMap, (map) => {
        for (const [name, level] of Object.entries(map)) runtime.setPermission(name, level);
      });
      replaceEntry("command_aliases", commandRows.get("command_aliases"), isMap, (map) => {
        for (const [name, list] of Object.entries(map)) runtime.setAliases(name, list);
      });
      replaceEntry("disabled_commands", commandRows.get("disabled_commands"), Array.isArray, (list) => {
        for (const name of list) runtime.setEnabled(String(name), false);
      });
      // The decision uses what this transaction actually changed, side effects
      // included. Refusing rolls back, so nothing live has changed.
      const plan = appliedPlan({ before, after: currentDigests(),
        source: digestsFrom(rows, secrets?.settings ?? {}), base });
      report.plan = publicPlan(plan);
      if (plan.destructive && confirmDestructive !== true) {
        const refused = new BackupError("CONFIRM_REQUIRED", "Restore replaces existing values");
        refused.plan = report.plan;
        throw refused;
      }
      crash("inside-apply");
      store.saveBotSetting("restore:applied", JSON.stringify({ id }));
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  } finally {
    try { db.exec("PRAGMA synchronous = NORMAL"); }
    finally { source.close(); }
  }
  crash("after-commit");
  return report;
}

function installPersona(id) {
  const source = path.join(staged(id), "persona.md");
  const target = dataPath("ai-persona.md");
  const { persona } = metadata(id);
  if (typeof persona !== "boolean") throw new BackupError("DAMAGED", "Staged persona metadata missing");
  if (persona && !fs.existsSync(source))
    throw new BackupError("DAMAGED", "Staged persona missing");
  // A backup without a persona leaves this install's persona as it is.
  if (!persona) return;
  const temp = dataPath(`ai-persona.${id}.part`);
  fs.copyFileSync(source, temp);
  fs.chmodSync(temp, 0o600);
  const fd = fs.openSync(temp, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, target);
  fsyncDirectory(dataPath());
}

function metadata(id) { return JSON.parse(fs.readFileSync(path.join(stageRoot(id), "metadata.json"), "utf8")); }
function stagedItemExists(file, directory = false) {
  try {
    const stat = fs.lstatSync(file);
    return directory ? stat.isDirectory() : stat.isFile();
  } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
function validateBeforePersona(id) {
  const meta = metadata(id);
  if (typeof meta.persona !== "boolean" || !meta.items ||
      ["memory", "stickers", "scheduleMedia"].some((key) => typeof meta.items[key] !== "boolean"))
    throw new BackupError("DAMAGED", "Staged metadata missing");
  if (meta.persona && !stagedItemExists(path.join(staged(id), "persona.md")))
    throw new BackupError("DAMAGED", "Staged persona missing");
  if (meta.account) {
    for (const [name, required, directory] of [
      ["db/levix.db", true, false], ["memory", meta.items.memory, true],
      ["stickers", meta.items.stickers, true], ["media/schedules", meta.items.scheduleMedia, true],
    ]) {
      if (required && !stagedItemExists(path.join(staged(id), name), directory))
        throw new BackupError("DAMAGED", "Staged account item missing");
    }
  }
}
function pendingId() {
  try { return JSON.parse(fs.readFileSync(dataPath("restore", "pending", "pending.json"), "utf8")).id; }
  catch { return null; }
}
function installPending(id) {
  const meta = metadata(id);
  if (!meta.account) return;
  if (pendingId() === id) {
    for (const [name, required, directory] of [
      ["levix.db", true, false], ["files/memory", meta.items.memory, true],
      ["files/stickers", meta.items.stickers, true],
      ["files/media/schedules", meta.items.scheduleMedia, true],
    ]) {
      if (required && !stagedItemExists(dataPath("restore", "pending", name), directory))
        throw new BackupError("DAMAGED", "Pending account item missing");
    }
    syncPendingDirectories(id);
    return;
  }
  const next = dataPath("restore", "pending.next");
  const pending = dataPath("restore", "pending");
  const replaced = path.join(stageRoot(id), "replaced");
  fs.mkdirSync(next, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(next, "files"), { recursive: true, mode: 0o700 });
  const items = [
    ["db/levix.db", "levix.db", true],
    ["memory", "files/memory", meta.items.memory],
    ["stickers", "files/stickers", meta.items.stickers],
    ["media/schedules", "files/media/schedules", meta.items.scheduleMedia],
  ];
  for (const [sourceName, targetName, required] of items) {
    if (!required) continue;
    const source = path.join(staged(id), sourceName);
    const target = path.join(next, targetName);
    if (stagedItemExists(source, sourceName !== "db/levix.db")) {
      if (fs.existsSync(target)) throw new BackupError("IO", "Duplicate pending item");
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.renameSync(source, target);
    } else if (!stagedItemExists(target, sourceName !== "db/levix.db"))
      throw new BackupError("DAMAGED", "Missing pending item");
    if (sourceName === "db/levix.db") crash("during-pending-items");
  }
  atomicJson(path.join(next, "pending.json"), { id, createdAt: new Date().toISOString(),
    backupCreated: meta.created, account: meta.account, counts: meta.counts });
  syncPendingDirectories(id);
  if (fs.existsSync(pending)) {
    if (fs.existsSync(replaced)) fs.rmSync(replaced, { recursive: true, force: true });
    fs.renameSync(pending, replaced);
    syncPendingDirectories(id);
  }
  crash("during-pending-renames");
  fs.renameSync(next, pending);
  syncPendingDirectories(id);
  fs.rmSync(replaced, { recursive: true, force: true });
  syncPendingDirectories(id);
}

function syncPendingDirectories(id) {
  for (const folder of [stageRoot(id), staged(id), path.join(staged(id), "db"),
    path.join(staged(id), "media"), dataPath("restore"),
    dataPath("restore", "pending.next"), dataPath("restore", "pending"),
    dataPath("restore", "pending.next", "files"), dataPath("restore", "pending", "files"),
    dataPath("restore", "pending.next", "files", "media"),
    dataPath("restore", "pending", "files", "media")]) {
    if (fs.existsSync(folder)) fsyncDirectory(folder);
  }
}

function finish(id, outcome = "restored") {
  const meta = metadata(id);
  const paired = readPairedAccount();
  const result = { applied: meta.report?.applied || [], skipped: meta.report?.skipped || [],
    restartNeeded: meta.report?.restartNeeded || [], plan: meta.report?.plan ?? null,
    accountData: meta.account ? "waits" : "none",
    accountMatchesPaired: accountsMatch(meta.account, paired) };
  writeOutcome({ id, outcome, at: new Date().toISOString() });
  clearJournal();
  try { fs.rmSync(stageRoot(id), { recursive: true, force: true }); }
  catch { /* Startup's orphan sweep removes it later. */ }
  return result;
}

async function restorePinnedUpload(id, file, password, onProgress, { confirmDestructive = false } = {}) {
  if (readJournal()) throw new BackupError("BUSY", "A restore is awaiting recovery");
  const opened = await openBackup({ path: file, password });
  schemaCheck(opened.manifest);
  const total = spaceCheck(opened.manifest);
  onProgress?.({ phase: "verify", bytes: 0, totalBytes: total });
  const restoreId = crypto.randomBytes(16).toString("hex");
  const dir = stageRoot(restoreId);
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.mkdirSync(staged(restoreId), { mode: 0o700 });
  atomicJson(path.join(dir, "metadata.json"), { account: opened.manifest.account,
    created: opened.manifest.created, counts: opened.manifest.counts,
    persona: opened.manifest.entries.some((entry) => entry.kind === "persona"),
    items: { memory: opened.manifest.entries.some((entry) => entry.kind === "memory"),
      stickers: opened.manifest.entries.some((entry) => entry.kind === "sticker"),
      scheduleMedia: opened.manifest.entries.some((entry) => entry.kind === "schedule-media") } });
  writeJournal({ op: "restore", id: restoreId, step: "stage" });
  crash("stage");
  let secretsBuffer = null;
  let secretsPayload = null;
  let plan = null;
  try {
    onProgress?.({ phase: "stage", bytes: 0, totalBytes: total });
    const extracted = await opened.extract({ dest: staged(restoreId),
      onProgress(update) {
        onProgress?.({ phase: "stage", bytes: update.bytes, totalBytes: total });
      } });
    secretsBuffer = extracted.memory["secrets.json"] ?? null;
    if (secretsBuffer) {
      secretsPayload = safeJson(secretsBuffer.toString("utf8"), null);
      if (!secretsPayload || !secretsPayload.settings || typeof secretsPayload.settings !== "object" ||
          Array.isArray(secretsPayload.settings))
        throw new BackupError("BAD_MANIFEST", "Invalid secret payload");
    }
    crash("after-extract");
    const stagedDb = path.join(staged(restoreId), "db", "levix.db");
    const secretScan = new DatabaseSync(stagedDb, { readOnly: true });
    try { assertNoExcludedData(secretScan); }
    finally { secretScan.close(); }
    const copy = new DatabaseSync(stagedDb);
    try {
      expectedSchema(copy);
      if (copy.prepare("PRAGMA integrity_check").get().integrity_check !== "ok")
        throw new BackupError("DAMAGED", "Backup database failed integrity check");
      classifyTables(copy);
      migrate(copy);
      // Persona and account parts of the plan; applySettings adds the exact
      // settings and API key changes inside its transaction and decides there.
      plan = buildPlan({
        digests: digestsFrom(restorableRows(copy), secretsPayload?.settings ?? {}),
        personaSha: opened.manifest.entries.find((entry) => entry.kind === "persona")?.sha256 ?? null,
        account: opened.manifest.account,
      });
    } finally { copy.close(); }
    fsyncStagedTree(staged(restoreId));
    writeJournal({ op: "restore", id: restoreId, step: "apply" });
    onProgress?.({ phase: "apply", bytes: total, totalBytes: total });
    const report = applySettings(restoreId, secretsPayload, { base: plan, confirmDestructive });
    atomicJson(path.join(dir, "metadata.json"), { ...metadata(restoreId), report });
    writeJournal({ op: "restore", id: restoreId, step: "persona" });
    validateBeforePersona(restoreId);
    crash("persona");
    installPersona(restoreId);
    crash("after-persona");
    writeJournal({ op: "restore", id: restoreId, step: "pending" });
    onProgress?.({ phase: "pending", bytes: total, totalBytes: total });
    installPending(restoreId);
    const result = finish(restoreId);
    uploads.removeUpload(id);
    onProgress?.({ phase: "done", bytes: total, totalBytes: total });
    return result;
  } catch (error) {
    if (marker() === restoreId && readJournal()?.id === restoreId)
      throw new BackupError("RESTORE_INCOMPLETE", "Restore will finish after restart");
    if (!error.restoreTestCrash) {
      fs.rmSync(dir, { recursive: true, force: true });
      clearJournal();
    }
    throw error;
  } finally {
    // Best-effort wipe of the decrypted secrets buffer. Parsed JS strings
    // cannot be overwritten.
    if (secretsBuffer) secretsBuffer.fill(0);
    secretsPayload = null;
  }
}

async function restoreUpload(id, password, onProgress, options = {}) {
  const pin = uploads.pinUpload(id);
  if (!pin) throw new BackupError("NOT_FOUND", "Upload not found");
  try { return await restorePinnedUpload(id, pin.path, password, onProgress, options); }
  finally { pin.release(); }
}

function pendingStatus() {
  const lastOutcome = readOutcome();
  try {
    const value = JSON.parse(fs.readFileSync(dataPath("restore", "pending", "pending.json"), "utf8"));
    return { waiting: true, account: maskAccount(value.account), createdAt: value.createdAt,
      backupCreated: value.backupCreated, counts: value.counts,
      matchesPaired: accountsMatch(value.account, readPairedAccount()), lastOutcome };
  } catch (error) { if (error.code === "ENOENT") return { waiting: false, lastOutcome }; throw error; }
}
function discardPending() {
  const pending = dataPath("restore", "pending");
  if (!fs.existsSync(pending)) return;
  const trash = dataPath("restore", `${crypto.randomBytes(16).toString("hex")}.trash`);
  fs.renameSync(pending, trash);
  fs.rmSync(trash, { recursive: true, force: true });
}

module.exports = { restoreUpload, schemaCheck, expectedSchema, pendingStatus, discardPending, installPersona,
  installPending, finish, marker, stageRoot, validateBeforePersona, setCrashHookForTest };

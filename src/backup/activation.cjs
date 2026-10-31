const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { dataPath } = require("../config/paths.cjs");
const { db, migrate, fsyncDirectory } = require("../db/db.cjs");
const { markLegacyMemoryHandled } = require("../utils/memory.cjs");
const logger = require("../utils/logger.cjs");
const { readPairedAccount, accountsMatch } = require("./account.cjs");
const { ACCOUNT_TABLES, classifyTables } = require("./content.cjs");
const { atomicJson, readJournal, writeJournal, clearJournal } = require("./journal.cjs");

const pendingRoot = () => dataPath("restore", "pending");
const outcomePath = () => dataPath("restore", "last-activation.json");
const marker = () => {
  try { return JSON.parse(db.prepare("SELECT value FROM bot_settings WHERE key = 'restore:activated'").get()?.value || "null")?.id; }
  catch { return null; }
};
let faultHook = null;
let faultIsCrash = true;
function setFaultHookForTest(fn, { crash = true } = {}) { faultHook = fn; faultIsCrash = crash; }
function fault(step) {
  if (!faultHook) return;
  try { faultHook(step); }
  catch (error) { if (faultIsCrash) error.activationTestCrash = true; throw error; }
}
function outcome(id, status, code) {
  atomicJson(outcomePath(), { id, status, ...(code ? { code } : {}), at: new Date().toISOString() });
}
function readLastActivation() {
  try {
    const { status, at } = JSON.parse(fs.readFileSync(outcomePath(), "utf8"));
    return { status, at };
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
function pending() {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(pendingRoot(), "pending.json"), "utf8"));
    if (!/^[0-9a-f]{32}$/.test(value.id)) throw new Error("Invalid pending activation id");
    return value;
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
function journal(id, step, moved) { writeJournal({ op: "activate", id, step, moved }); }
function ensureDurableDirectory(folder, filesystem = fs) {
  const root = dataPath();
  const relative = path.relative(root, folder);
  if (path.isAbsolute(relative) || relative.split(path.sep).includes(".."))
    throw new Error("Activation directory is outside the data directory");
  let parent = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    const next = path.join(parent, part);
    if (!filesystem.existsSync(next)) {
      filesystem.mkdirSync(next, { mode: 0o700 });
      fsyncDirectory(parent, filesystem);
    }
    parent = next;
  }
}
function unsafeActivationError() {
  const error = new Error("Account activation needs recovery before WhatsApp can run");
  error.code = "ACTIVATION_UNSAFE";
  return error;
}
function move(id, step, moved, from, to) {
  // An intent is durable before rename. Recovery checks which side exists.
  moved.push({ from: path.relative(dataPath(), from), to: path.relative(dataPath(), to) });
  journal(id, step, moved);
  ensureDurableDirectory(path.dirname(to));
  fs.renameSync(from, to);
  fsyncDirectory(path.dirname(from));
  fsyncDirectory(path.dirname(to));
}
function undoMoves(moved) {
  for (const entry of [...moved].reverse()) {
    const from = dataPath(entry.from);
    const to = dataPath(entry.to);
    if (fs.existsSync(to) && !fs.existsSync(from)) {
      ensureDurableDirectory(path.dirname(from));
      fault("undo-rename");
      fs.renameSync(to, from);
      fsyncDirectory(path.dirname(to));
      fsyncDirectory(path.dirname(from));
    }
  }
}
function finishActivation(id) {
  // A committed marker makes cleanup safe to repeat after a crash.
  fs.rmSync(dataPath("restore", id, "previous"), { recursive: true, force: true });
  fs.rmSync(pendingRoot(), { recursive: true, force: true });
  fs.rmSync(dataPath("restore", id), { recursive: true, force: true });
  clearJournal();
  outcome(id, "activated");
}
function recoverActivation(journalValue) {
  if (marker() === journalValue.id) {
    finishActivation(journalValue.id);
  } else {
    undoMoves(journalValue.moved);
    clearJournal();
    outcome(journalValue.id, "failed", "interrupted");
  }
}
function columns(database, schema, table) {
  return database.prepare(`PRAGMA ${schema}.table_info("${table}")`).all()
    .map(({ name, type, notnull, dflt_value, pk }) => ({ name, type, notnull, dflt_value, pk }));
}
function replaceTables(id) {
  db.prepare("ATTACH DATABASE ? AS pending").run(path.join(pendingRoot(), "levix.db"));
  let begun = false;
  try {
    for (const table of ACCOUNT_TABLES) {
      if (JSON.stringify(columns(db, "main", table)) !== JSON.stringify(columns(db, "pending", table)))
        throw new Error(`Activation schema mismatch: ${table}`);
    }
    db.exec("PRAGMA synchronous = FULL");
    db.exec("BEGIN IMMEDIATE");
    begun = true;
    db.exec("PRAGMA defer_foreign_keys = ON");
    // Delete children first, then insert parents first. Deferred constraints
    // cover references between account tables until COMMIT.
    for (const table of [...ACCOUNT_TABLES].reverse()) db.exec(`DELETE FROM main."${table}"`);
    for (const table of ACCOUNT_TABLES) {
      const names = columns(db, "main", table).map(({ name }) => `"${name.replaceAll('"', '""')}"`).join(", ");
      db.exec(`INSERT INTO main."${table}" (${names}) SELECT ${names} FROM pending."${table}"`);
    }
    db.prepare("INSERT OR REPLACE INTO bot_settings (key, value) VALUES ('restore:activated', ?)")
      .run(JSON.stringify({ id }));
    fault("db-before-commit");
    db.exec("COMMIT");
    begun = false;
  } catch (error) {
    if (begun) { try { db.exec("ROLLBACK"); } catch {} }
    throw error;
  } finally {
    try { db.exec("PRAGMA synchronous = NORMAL"); }
    finally { db.exec("DETACH DATABASE pending"); }
  }
}
function activatePendingIfMatching(resetAccountCaches = () => {}) {
  try {
    const existing = readJournal();
    if (existing?.op === "activate") throw unsafeActivationError();
    if (existing) return false;
  } catch { throw unsafeActivationError(); }
  let value;
  try { value = pending(); }
  catch { logger.error("[Backup] Invalid pending activation metadata"); return false; }
  if (!value) return false;
  const { id } = value;
  let matches = false;
  try { matches = accountsMatch(value.account, readPairedAccount()); }
  catch {
    logger.error("[Backup] Could not read paired account for activation");
    try { outcome(id, "failed", "IO"); } catch {}
    return false;
  }
  if (!matches) {
    try { outcome(id, "waiting"); }
    catch { logger.error("[Backup] Could not record waiting activation"); }
    return false;
  }
  const moved = [];
  try {
    journal(id, "migrate", moved);
    const copy = new DatabaseSync(path.join(pendingRoot(), "levix.db"));
    try {
      migrate(copy);
      require("./restore.cjs").expectedSchema(copy);
      classifyTables(copy);
    }
    finally { copy.close(); }
    fault("migrate");
    require("../../scheduler.cjs").bumpScheduleGeneration();
    journal(id, "files", moved);
    ensureDurableDirectory(dataPath("restore", id, "previous", "media"));
    for (const name of ["memory", "stickers", "media/schedules"]) {
      const live = dataPath(...name.split("/"));
      const source = path.join(pendingRoot(), "files", name);
      const previous = dataPath("restore", id, "previous", name);
      if (!fs.existsSync(source)) ensureDurableDirectory(source);
      if (fs.existsSync(live)) move(id, "files", moved, live, previous);
      fault(`files:${name}:previous`);
      move(id, "files", moved, source, live);
      fault(`files:${name}:live`);
    }
    markLegacyMemoryHandled(dataPath("memory"));
    fault("files");
    journal(id, "db", moved);
    replaceTables(id);
    fault("db-committed");
    try { resetAccountCaches(); }
    catch { logger.error("[Backup] Could not reset account caches after activation"); }
    journal(id, "cleanup", moved);
    finishActivation(id);
    return true;
  } catch (error) {
    // A test crash models a dead process: startup recovery owns this journal.
    if (error.activationTestCrash) return false;
    if (marker() === id) {
      try { resetAccountCaches(); }
      catch { logger.error("[Backup] Could not reset account caches after activation"); }
      try { recoverActivation({ id, moved }); }
      catch { logger.error("[Backup] Activation cleanup will retry on restart"); }
      return true;
    }
    try { undoMoves(moved); }
    catch {
      try { outcome(id, "failed", "ROLLBACK_FAILED"); } catch {}
      throw unsafeActivationError();
    }
    try { clearJournal(); }
    catch {
      try { outcome(id, "failed", "ROLLBACK_FAILED"); } catch {}
      throw unsafeActivationError();
    }
    try { outcome(id, "failed", error.code || "IO"); }
    catch { logger.error("[Backup] Could not record failed activation outcome"); }
    logger.error({ code: error.code || "IO" }, "[Backup] Account activation failed");
    return false;
  }
}

module.exports = { activatePendingIfMatching, recoverActivation, readLastActivation,
  setFaultHookForTest, ensureDurableDirectory };

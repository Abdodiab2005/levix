const fs = require("node:fs");
const path = require("node:path");
const { ensureDataDir, dataPath } = require("../config/paths.cjs");
const { atomicJson, readJournal, writeJournal, clearJournal, writeOutcome } = require("./journal.cjs");
const uploads = require("./uploads.cjs");
const logger = require("../utils/logger.cjs");
const { fsyncDirectory } = require("../db/db.cjs");

function cleanupOrphans() {
  const root = ensureDataDir("restore");
  for (const name of fs.readdirSync(root)) {
    if (/^[0-9a-f]{32}(?:\.trash)?$/.test(name))
      fs.rmSync(path.join(root, name), { recursive: true, force: true });
  }
  fs.rmSync(dataPath("restore", "pending.next"), { recursive: true, force: true });
  uploads.sweepUploads(true);
}

function recordOutcome(id, outcome) {
  try { writeOutcome({ id, outcome, at: new Date().toISOString() }); }
  catch { logger.error("[Backup] Could not record restore recovery outcome"); }
}

function quarantineJournal() {
  try {
    const folder = ensureDataDir("restore");
    let timestamp = Date.now();
    while (fs.existsSync(path.join(folder, `journal.invalid-${timestamp}.json`))) timestamp += 1;
    fs.renameSync(dataPath("restore", "journal.json"), path.join(folder, `journal.invalid-${timestamp}.json`));
    fsyncDirectory(folder);
  } catch { logger.error("[Backup] Could not quarantine invalid restore journal"); }
  logger.error("[Backup] Invalid restore journal");
  recordOutcome(null, "journal-invalid");
}

function recover(journal) {
  const restore = require("./restore.cjs");
  const { id } = journal;
  if (journal.step === "stage" || restore.marker() !== id) {
    const pending = dataPath("restore", "pending");
    const replaced = path.join(restore.stageRoot(id), "replaced");
    try {
      const pendingId = JSON.parse(fs.readFileSync(path.join(pending, "pending.json"), "utf8")).id;
      if (pendingId === id) fs.renameSync(pending, path.join(restore.stageRoot(id), "abandoned"));
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (fs.existsSync(replaced) && !fs.existsSync(pending)) fs.renameSync(replaced, pending);
    fsyncDirectory(dataPath("restore"));
    fs.rmSync(restore.stageRoot(id), { recursive: true, force: true });
    fs.rmSync(dataPath("restore", "pending.next"), { recursive: true, force: true });
    fsyncDirectory(dataPath("restore"));
    writeOutcome({ id, outcome: "interrupted-unchanged", at: new Date().toISOString() });
    clearJournal();
    return;
  }
  if (journal.step === "apply" || journal.step === "persona") {
    restore.validateBeforePersona(id);
    writeJournal({ op: "restore", id, step: "persona" });
    restore.installPersona(id);
    writeJournal({ op: "restore", id, step: "pending" });
  }
  restore.installPending(id);
  restore.finish(id, "completed-after-restart");
}

function activationRecoveryFailure(id) {
  try {
    atomicJson(dataPath("restore", "last-activation.json"),
      { id, status: "failed", code: "ACTIVATION_RECOVERY_FAILED", at: new Date().toISOString() });
  } catch {}
  logger.error("[Backup] Account activation recovery failed; refusing startup");
  const error = new Error("Account activation recovery failed");
  error.code = "ACTIVATION_RECOVERY_FAILED";
  return error;
}

function runRestoreRecovery() {
  let journal;
  try { journal = readJournal(); }
  catch { quarantineJournal(); return; }
  const validRestore = journal?.op === "restore" &&
    ["stage", "apply", "persona", "pending"].includes(journal.step);
  const validActivate = journal?.op === "activate" &&
    ["migrate", "files", "db", "cleanup"].includes(journal.step) &&
    Array.isArray(journal.moved) && journal.moved.length <= 6 &&
    journal.moved.every((entry) => entry && typeof entry === "object" &&
      ["memory", "stickers", path.join("media", "schedules")].some((name) =>
        (entry.from === name && entry.to === path.join("restore", journal.id, "previous", name)) ||
        (entry.from === path.join("restore", "pending", "files", name) && entry.to === name)));
  if (journal && (!/^[0-9a-f]{32}$/.test(journal.id) || !(validRestore || validActivate))) {
    if (journal.op === "activate") throw activationRecoveryFailure(journal.id);
    quarantineJournal();
    return;
  }
  if (journal) {
    try {
      if (journal.op === "activate") require("./activation.cjs").recoverActivation(journal);
      else recover(journal);
    }
    catch {
      if (journal.op === "activate") throw activationRecoveryFailure(journal.id);
      logger.error("[Backup] Restore recovery failed; will retry on next start");
      recordOutcome(journal.id, "recovery-failed");
      return;
    }
  }
  try { cleanupOrphans(); }
  catch { logger.error("[Backup] Restore cleanup failed"); }
}

module.exports = { runRestoreRecovery };

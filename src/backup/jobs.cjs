const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { ensureDataDir } = require("../config/paths.cjs");
const { BackupError, CODES } = require("./format.cjs");
const { createBackup } = require("./create.cjs");

function sweepBackupTemp() {
  const root = ensureDataDir("tmp", "backup");
  // A previous process cannot own a current job.
  for (const name of fs.readdirSync(root)) fs.rmSync(path.join(root, name), { recursive: true, force: true });
  ensureDataDir("tmp", "backup", "exports");
}

const jobs = new Map();
const exportsByToken = new Map();
let active = null;
const EXPIRE_MS = 30 * 60 * 1000;

function startExport(password) {
  if (active) throw new BackupError("BUSY", "Backup job busy");
  const job = { id: crypto.randomBytes(16).toString("hex"), kind: "backup",
    phase: "queued", bytes: 0, totalBytes: 0, done: false, error: null, result: null };
  jobs.set(job.id, job);
  active = job.id;
  setImmediate(async () => {
    try {
      const file = await createBackup({ password, onProgress(update) {
        job.phase = update.phase;
        job.bytes = update.bytes;
        job.totalBytes = update.totalBytes;
      } });
      const expiresAt = new Date(Date.now() + EXPIRE_MS).toISOString();
      exportsByToken.set(file.token, { ...file, expiresAt });
      job.result = { token: file.token, fileName: file.fileName, size: file.size, expiresAt };
      job.phase = "done";
      const timer = setTimeout(() => removeExport(file.token), EXPIRE_MS);
      timer.unref();
    } catch (error) {
      job.phase = "error";
      job.error = { code: [...CODES, "NO_SPACE", "UNCLASSIFIED_TABLE", "SECRET_FOUND"].includes(error?.code) ? error.code : "IO" };
    } finally {
      job.done = true;
      active = null;
      const timer = setTimeout(() => jobs.delete(job.id), EXPIRE_MS);
      timer.unref();
    }
  });
  return job.id;
}

function getJob(id) { return jobs.get(id) || null; }
function getExport(token) {
  const entry = exportsByToken.get(token);
  if (!entry) return null;
  if (Date.parse(entry.expiresAt) <= Date.now()) { removeExport(token); return null; }
  return entry;
}
function removeExport(token) {
  const entry = exportsByToken.get(token);
  if (!entry) return false;
  exportsByToken.delete(token);
  fs.rmSync(entry.path, { force: true });
  return true;
}

module.exports = { sweepBackupTemp, startExport, getJob, getExport, removeExport };

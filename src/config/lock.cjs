// SQLite holds this lock until the connection closes, including on a crash.
// The text file is only a pid hint for a useful error message.
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const { dataPath } = require("./paths.cjs");

const LOCK_FILE = dataPath("levix.lock");
const LOCK_DB_FILE = dataPath("levix.lock.db");
let connection = null;

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function readPid() {
  try {
    const pid = Number.parseInt(fs.readFileSync(LOCK_FILE, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : "unknown";
  } catch {
    return "unknown";
  }
}

function lockedError() {
  const error = new Error(
    `Another Levix (pid ${readPid()}) is already using this data directory.\n` +
      `  ${LOCK_FILE}\n\n` +
      `  Only one Levix can run per data directory. Stop the other one, or use --data.`,
  );
  error.code = "ELEVIXLOCKED";
  return error;
}

function release() {
  if (!connection) return;
  try {
    if (readPid() === process.pid) fs.rmSync(LOCK_FILE, { force: true });
  } catch {}
  connection.close();
  connection = null;
}

function isLockHeld() {
  return connection !== null;
}

function acquireSingleInstanceLock() {
  if (connection) return LOCK_FILE;
  let candidate;
  try {
    candidate = new DatabaseSync(LOCK_DB_FILE);
    candidate.exec("PRAGMA busy_timeout = 0");
    candidate.exec("PRAGMA locking_mode = EXCLUSIVE");
    candidate.exec("CREATE TABLE IF NOT EXISTS owner (pid INTEGER NOT NULL)");
    candidate.exec("DELETE FROM owner");
    candidate.prepare("INSERT INTO owner (pid) VALUES (?)").run(process.pid);
    connection = candidate;
    fs.writeFileSync(LOCK_FILE, String(process.pid), { mode: 0o600 });
    process.once("exit", release);
    return LOCK_FILE;
  } catch (error) {
    candidate?.close();
    if (connection === candidate) connection = null;
    if (error.code === "SQLITE_BUSY" || error.errcode === 5 || /database is locked/i.test(error.message)) {
      throw lockedError();
    }
    throw error;
  }
}

module.exports = { acquireSingleInstanceLock, release, isLockHeld, LOCK_FILE, LOCK_DB_FILE, processAlive };

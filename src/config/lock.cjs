// One bot process per data directory.
//
// A WhatsApp pairing is a single session. Two Levix processes on one database
// would both hold the same Baileys credentials, overwrite each other's session
// keys, and answer every message twice — and the second one would only fail
// much later, when it tried to bind the panel's port, long after it had
// touched the auth rows.
//
// So the bot claims the data directory before it does anything else. This is a
// lock file with a pid in it, which is the simplest thing that works on a
// single machine — which is the only place a WhatsApp pairing can run anyway.
// No daemon, no distributed anything.
//
// The CLI's read-only and recovery commands (`where`, `reset-password`) do NOT
// take this lock: they have to work while the bot is running, or when it is
// wedged, which is the whole point of having them.

const fs = require("node:fs");

const { dataPath } = require("./paths.cjs");
const logger = require("../utils/logger.cjs");

const LOCK_FILE = dataPath("levix.lock");

/** Is that pid a process that still exists? */
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 checks for existence without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists and belongs to somebody else — still alive.
    return err.code === "EPERM";
  }
}

function readLock() {
  try {
    const raw = fs.readFileSync(LOCK_FILE, "utf8");
    const pid = Number.parseInt(String(raw).trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

let held = false;

function release() {
  if (!held) return;
  held = false;
  try {
    // Only remove it if it is still ours — a stale-lock takeover elsewhere
    // could have replaced it.
    if (readLock() === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch {}
}

/**
 * Claim the data directory for this process.
 *
 * @throws {Error} when another live Levix already holds it. The message is
 *   written for whoever is reading the terminal, not for a stack trace.
 */
function acquireSingleInstanceLock() {
  if (held) return LOCK_FILE;

  const claim = () => {
    // "wx" fails if the file exists — the check and the create are one
    // syscall, so two processes starting together can't both win.
    const handle = fs.openSync(LOCK_FILE, "wx");
    fs.writeFileSync(handle, String(process.pid));
    fs.closeSync(handle);
  };

  try {
    claim();
  } catch (err) {
    if (err.code !== "EEXIST") throw err;

    const owner = readLock();
    if (owner !== null && owner !== process.pid && processAlive(owner)) {
      const error = new Error(
        `Another Levix (pid ${owner}) is already using this data directory.\n` +
          `  ${LOCK_FILE}\n\n` +
          `  Only one Levix can run per data directory — a WhatsApp pairing is a\n` +
          `  single session. Stop the other one, or start this one with --data\n` +
          `  pointing somewhere else.`
      );
      error.code = "ELEVIXLOCKED";
      throw error;
    }

    // The holder is gone (a crash, a kill -9, a reboot). Take it over.
    logger.warn(
      `[lock] Removing a stale lock from pid ${owner ?? "unknown"} — that process is gone`
    );
    fs.rmSync(LOCK_FILE, { force: true });
    claim();
  }

  held = true;
  // Best effort: a SIGKILL or a power cut leaves the file behind, which the
  // stale check above handles on the next start.
  process.once("exit", release);
  return LOCK_FILE;
}

module.exports = { acquireSingleInstanceLock, release, LOCK_FILE, processAlive };

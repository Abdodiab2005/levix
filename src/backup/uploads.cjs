const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { ensureDataDir } = require("../config/paths.cjs");
const { BackupError, LIMITS } = require("./format.cjs");
const logger = require("../utils/logger.cjs");

const TTL = 60 * 60 * 1000;
const idRe = /^[0-9a-f]{32}$/;
const root = () => {
  const folder = ensureDataDir("tmp", "restore");
  if (process.platform !== "win32") fs.chmodSync(folder, 0o700);
  return folder;
};
const filePath = (id) => idRe.test(id) ? path.join(root(), `${id}.levixbak`) : null;
const attempts = new Map();
const pins = new Map();
const pendingDelete = new Set();
let receiving = 0;
const activeParts = new Set();

function sweepUploads(all = false) {
  const now = Date.now();
  for (const name of fs.readdirSync(root())) {
    const file = path.join(root(), name);
    const stat = fs.lstatSync(file);
    const known = /^[0-9a-f]{32}\.levixbak(?:\.part)?$/.test(name);
    const id = name.endsWith(".levixbak") ? name.slice(0, -9) : null;
    if ((all || !known || now - stat.mtimeMs >= TTL || (id && pendingDelete.has(id))) &&
        !activeParts.has(file) && !(id && pins.has(id))) {
      fs.rmSync(file, { force: true, recursive: true });
      if (id) { pendingDelete.delete(id); if (!lockedOut(id)) attempts.delete(id); }
    }
  }
  if (all) attempts.clear();
}

function removeUpload(id) {
  const file = filePath(id);
  if (file && pins.has(id)) pendingDelete.add(id);
  else if (file) { fs.rmSync(file, { force: true }); pendingDelete.delete(id); }
  if (!lockedOut(id)) attempts.delete(id);
}

function getUpload(id) {
  const file = filePath(id);
  if (!file) return null;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) return null;
    if (Date.now() - stat.mtimeMs >= TTL && !pins.has(id)) { removeUpload(id); return null; }
    return file;
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function pinUpload(id) {
  const file = getUpload(id);
  if (!file) return null;
  pins.set(id, (pins.get(id) || 0) + 1);
  let released = false;
  return { path: file, release() {
    if (released) return;
    released = true;
    const remaining = pins.get(id) - 1;
    if (remaining) { pins.set(id, remaining); return; }
    pins.delete(id);
    try {
      const stat = fs.statSync(file, { throwIfNoEntry: false });
      if (pendingDelete.has(id) || (stat && Date.now() - stat.mtimeMs >= TTL)) removeUpload(id);
    } catch { logger.error("[Backup] Could not remove released upload"); }
  } };
}

function wrongPassword(id) {
  const count = (attempts.get(id) || 0) + 1;
  attempts.set(id, count);
  if (count >= 5) {
    if (pins.has(id)) pendingDelete.add(id);
    else {
      const file = filePath(id);
      if (file) fs.rmSync(file, { force: true });
    }
  }
  return count > 5;
}
function lockedOut(id) { return (attempts.get(id) || 0) >= 5; }

async function receiveUpload(req) {
  const header = req.headers["content-length"];
  if (header === undefined) throw new BackupError("LENGTH_REQUIRED", "Content length required");
  if (!/^\d+$/.test(header)) throw new BackupError("BAD_LENGTH", "Invalid content length");
  const length = Number(header);
  if (!Number.isSafeInteger(length) || length > LIMITS.file) throw new BackupError("LIMIT", "Upload too large");
  sweepUploads();
  if (fs.readdirSync(root()).filter((name) => /^[0-9a-f]{32}\.levixbak$/.test(name)).length + receiving >= 2)
    throw new BackupError("BUSY", "Too many uploads");
  const space = fs.statfsSync(root());
  if (Number(space.bavail) * Number(space.bsize) < length + 64 * 1024 ** 2)
    throw new BackupError("NO_SPACE", "Insufficient storage");
  receiving += 1;
  const id = crypto.randomBytes(16).toString("hex");
  const part = path.join(root(), `${id}.levixbak.part`);
  activeParts.add(part);
  const final = filePath(id);
  let fd;
  let size = 0;
  try {
    fd = fs.openSync(part, "wx", 0o600);
    for await (const chunk of req) {
      size += chunk.length;
      if (size > length) throw new BackupError("BAD_LENGTH", "Upload length mismatch");
      for (let offset = 0; offset < chunk.length;) {
        const written = fs.writeSync(fd, chunk, offset, chunk.length - offset);
        if (!written) throw new BackupError("IO", "Upload write failed");
        offset += written;
      }
    }
    if (size !== length) throw new BackupError("BAD_LENGTH", "Upload length mismatch");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(part, final);
    const timer = setTimeout(() => {
      try {
        const stat = fs.statSync(final, { throwIfNoEntry: false });
        if (stat && Date.now() - stat.mtimeMs >= TTL) {
          if (pins.has(id)) pendingDelete.add(id);
          else removeUpload(id);
        }
      } catch { logger.error("[Backup] Could not expire upload"); }
    }, TTL);
    timer.unref();
    return { uploadId: id, size };
  } catch (error) {
    if (fd !== undefined && fd !== null) fs.closeSync(fd);
    fs.rmSync(part, { force: true });
    if (size !== length && !(error instanceof BackupError))
      throw new BackupError("BAD_LENGTH", "Upload length mismatch");
    throw error;
  } finally {
    activeParts.delete(part);
    receiving -= 1;
  }
}

module.exports = { receiveUpload, getUpload, pinUpload, removeUpload, wrongPassword, lockedOut, sweepUploads, idRe };

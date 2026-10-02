// Panel uploads land as raw bytes in <data>/tmp/stickers and stay there until
// a conversion job reads them or the TTL sweep deletes them. The size cap is
// applied to each chunk before it is written, so a huge body never becomes a
// finished file that we then reject.
//
// media.cjs is required only when a file is accepted. It is written by the
// media agent and is not present in every worktree; boot only needs sweepStale.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { dataPath, ensureDataDir } = require("../config/paths.cjs");
const logger = require("../utils/logger.cjs");
const { StickerError } = require("./errors.cjs");
const { UPLOAD_MAX_BYTES, UPLOAD_TTL_MS } = require("./limits.cjs");

const SWEEP_MS = 15 * 60 * 1000;
const SNIFF_BYTES = 512;

/** @type {Map<string, object>} */
const uploads = new Map();
let mediaOverride = null;

function tmpDir() {
  return ensureDataDir("tmp", "stickers");
}

function loadMedia(explicit) {
  if (explicit) return explicit;
  if (mediaOverride) return mediaOverride;
  return require("./media.cjs");
}

function setMedia(mod) {
  mediaOverride = mod || null;
}

function storageError(error) {
  if (error?.code === "EACCES" || error?.code === "ENOSPC" || error?.code === "EROFS") {
    return new StickerError("STORAGE_UNAVAILABLE", {}, { cause: error });
  }
  return error;
}

function safeName(filename) {
  if (!filename) return "";
  const text = String(filename)
    .replace(/\p{Cc}/gu, "")
    .trim();
  return [...text].slice(0, 120).join("");
}

function publicRecord(record) {
  return {
    uploadId: record.id,
    kind: record.kind,
    mime: record.mime,
    width: record.width,
    height: record.height,
    durationMs: record.durationMs,
    animated: !!record.animated,
    size: record.size,
  };
}

function sameOwner(record, owner) {
  const known = new Set([record.ownerKey, ...(record.candidates || [])]);
  if (known.has(owner?.key)) return true;
  for (const candidate of owner?.candidates || []) {
    if (known.has(candidate)) return true;
  }
  return false;
}

function sweepStale(now = Date.now()) {
  const dir = dataPath("tmp", "stickers");
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    names = [];
  }
  for (const name of names) {
    const file = path.join(dir, name);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (now - stat.mtimeMs < UPLOAD_TTL_MS) continue;
    try {
      fs.rmSync(file, { force: true });
    } catch (error) {
      logger.warn({ err: error }, "[Stickers] failed to sweep a stale temp file");
    }
  }
  for (const [id, record] of uploads) {
    if (now - record.createdAt >= UPLOAD_TTL_MS || !fs.existsSync(record.path)) {
      uploads.delete(id);
      try {
        fs.rmSync(record.path, { force: true });
      } catch {
        // Already gone, or busy. The next sweep tries again.
      }
    }
  }
}

function discardAll() {
  for (const record of uploads.values()) {
    try {
      fs.rmSync(record.path, { force: true });
    } catch {
      // Unlink must still forget the id.
    }
  }
  uploads.clear();
  try {
    fs.rmSync(dataPath("tmp", "stickers"), { recursive: true, force: true });
  } catch (error) {
    logger.warn({ err: error }, "[Stickers] failed to remove the sticker temp directory");
  }
}

function sniffFile(file, media) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(SNIFF_BYTES);
    const n = fs.readSync(fd, buf, 0, SNIFF_BYTES, 0);
    return media.sniff(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Stream `stream` to disk for `owner`. Resolves the public record (no path).
 * @param {{ key: string, candidates?: string[] }} owner
 * @param {import("node:stream").Readable} stream
 */
function acceptStream(owner, stream, { filename, media } = {}) {
  if (!owner?.key) return Promise.reject(new StickerError("INVALID_OPTIONS", { field: "owner" }));
  const med = loadMedia(media);
  const id = crypto.randomBytes(16).toString("hex");
  const file = path.join(tmpDir(), `upload-${id}`);
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const out = fs.createWriteStream(file);
    const fail = (error) => {
      if (settled) return;
      settled = true;
      stream.pause();
      stream.removeAllListeners("data");
      stream.removeAllListeners("end");
      stream.removeAllListeners("error");
      out.destroy();
      fs.rm(file, { force: true }, () => reject(error));
    };

    stream.on("data", (chunk) => {
      if (settled) return;
      if (size + chunk.length > UPLOAD_MAX_BYTES) {
        stream.pause();
        fail(new StickerError("TOO_LARGE", { limitBytes: UPLOAD_MAX_BYTES }));
        return;
      }
      size += chunk.length;
      if (!out.write(chunk)) stream.pause();
    });
    out.on("drain", () => {
      if (!settled) stream.resume();
    });
    stream.on("error", (error) => fail(error));
    out.on("error", (error) => fail(storageError(error)));
    stream.on("end", () => {
      if (settled) return;
      out.end(() => {
        if (settled) return;
        if (size === 0) {
          fail(new StickerError("NO_MEDIA"));
          return;
        }
        let sniffed;
        try {
          sniffed = sniffFile(file, med);
        } catch (error) {
          fail(error);
          return;
        }
        if (!sniffed) {
          fail(new StickerError("UNSUPPORTED_TYPE"));
          return;
        }
        Promise.resolve(med.inspect(file, sniffed))
          .then((info) => {
            if (settled) return;
            settled = true;
            const record = {
              id,
              ownerKey: owner.key,
              candidates: [...(owner.candidates || [owner.key])],
              path: file,
              filename: safeName(filename),
              kind: info.kind,
              mime: info.mime,
              width: info.width ?? null,
              height: info.height ?? null,
              durationMs: info.durationMs ?? null,
              animated: !!info.animated,
              size,
              createdAt: Date.now(),
            };
            uploads.set(id, record);
            resolve(publicRecord(record));
          })
          .catch((error) => fail(error));
      });
    });
  });
}

/** The stored upload, or null when it is missing, expired, or not this owner's. */
function get(owner, id) {
  const record = uploads.get(id);
  if (!record || !sameOwner(record, owner)) return null;
  if (!fs.existsSync(record.path)) {
    uploads.delete(id);
    return null;
  }
  return record;
}

sweepStale();
const sweepTimer = setInterval(() => {
  try {
    sweepStale();
  } catch (error) {
    logger.warn({ err: error }, "[Stickers] upload sweep failed");
  }
}, SWEEP_MS);
sweepTimer.unref();

module.exports = {
  acceptStream,
  get,
  sweepStale,
  discardAll,
  setMedia,
};

// The technical debug log (v4.8.1 hotfix).
//
// One JSON-lines file per UTC day in `<data>/logs/debug/`, written at "debug"
// level by the Pino logger. Both previews in the panel show the exact tail that
// a send would forward, and it is never sent on its own: the only two ways it
// leaves the device are a feedback submission with "Attach device & technical
// diagnostics" ticked and a crash report the operator presses Send on.
//
// Two rules decide everything here:
//
//   * Nothing secret and no message content is ever written. Every record is
//     rebuilt key by key before it reaches the file: a secret-shaped key name
//     becomes "[redacted]" at any depth, a message-content key keeps only its
//     length, and every remaining string runs through the one shared sanitizer
//     (src/diagnostics/sanitize.cjs) before being capped at 2000 characters.
//   * A failure never reaches the caller. A full disk, a permission problem or
//     a record that cannot be serialized must not break the other log streams
//     or the code that logged.
//
// Files older than 14 days are deleted at boot and on the six-hour sweep in
// src/db/db.cjs. Clearing the logs deletes this directory too.

const fs = require("node:fs");
const path = require("node:path");

const { dataPath, ensureDataDir } = require("../config/paths.cjs");
const { sanitizeText } = require("./sanitize.cjs");

const DEBUG_DIR = dataPath("logs", "debug");
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const FIELD_MAX = 2000;
const DEFAULT_TAIL_BYTES = 256 * 1024;
const MAX_DEPTH = 8;

const FILE_PATTERN = /^debug-\d{4}-\d{2}-\d{2}\.log$/;

// Key names that name a secret, wherever they sit in the record. `code` is
// deliberately absent: `err.code`, `statusCode` and friends are diagnostic
// value, not a credential. A bare `code` is handled by the digit rule below.
const SECRET_KEY_PATTERN =
  /pass(word)?|secret|token|api[_-]?key|authorization|cookie|session|creds?|private|noise|signed|identity/i;

// Exactly these names are secrets; a substring rule would swallow `otpTimeout`
// and the like without cause.
const EXACT_SECRET_KEYS = new Set([
  "otp",
  "pairingcode",
  "resetcode",
  "verificationcode",
  "setupcode",
]);

// A bare `code` is an OTP when it is a short digit string, and an error/status
// code otherwise (`ENOENT`, `ERR_…`, 404).
const DIGIT_CODE_PATTERN = /^\d{4,10}$/;

// Key names whose value is message content: only the length survives.
const CONTENT_KEYS = new Set([
  "text",
  "body",
  "caption",
  "conversation",
  "message",
  "quoted",
  "content",
  "prompt",
  "reply",
]);

function utcDay(time) {
  const date = time === undefined ? new Date() : new Date(time);
  if (!Number.isFinite(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function debugFile(day) {
  return path.join(DEBUG_DIR, `debug-${day}.log`);
}

function contentLength(value) {
  if (typeof value === "string") return value.length;
  if (value === null || value === undefined) return 0;
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

/** A marker written by an earlier pass; re-reading must not re-measure it. */
const CONTENT_MARKER = /^\[redacted \d+ chars\]$/;

/**
 * Rebuild one value for the file. Objects are walked (bounded, cycle-safe);
 * strings lose their identities, secrets and paths through sanitizeText.
 *
 * @param {unknown} value
 * @param {number} depth
 * @param {WeakSet<object>} seen
 * @returns {unknown}
 */
function sanitizeValue(value, depth, seen) {
  if (value === null) return null;
  const type = typeof value;
  if (type === "string") return sanitizeText(value, FIELD_MAX);
  if (type === "number" || type === "boolean") return value;
  if (type === "bigint") return sanitizeText(String(value), FIELD_MAX);
  if (type !== "object") return undefined;
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Buffer.isBuffer(value)) {
    return `[buffer ${value.length} bytes]`;
  }

  if (Array.isArray(value)) {
    return value.map((item) => {
      const cleaned = sanitizeValue(item, depth + 1, seen);
      return cleaned === undefined ? null : cleaned;
    });
  }

  const out = {};
  for (const [key, item] of Object.entries(value)) {
    const lower = key.toLowerCase();
    if (SECRET_KEY_PATTERN.test(key) || EXACT_SECRET_KEYS.has(lower)) {
      out[key] = "[redacted]";
      continue;
    }
    if (lower === "code" && typeof item === "string" && DIGIT_CODE_PATTERN.test(item)) {
      out[key] = "[redacted]";
      continue;
    }
    if (CONTENT_KEYS.has(lower)) {
      out[key] =
        typeof item === "string" && CONTENT_MARKER.test(item)
          ? item
          : `[redacted ${contentLength(item)} chars]`;
      continue;
    }
    const cleaned = sanitizeValue(item, depth + 1, seen);
    if (cleaned !== undefined) out[key] = cleaned;
  }
  return out;
}

/** The exact object that reaches the file. */
function sanitizeRecord(record) {
  const cleaned = sanitizeValue(record, 0, new WeakSet());
  return cleaned && typeof cleaned === "object" && !Array.isArray(cleaned) ? cleaned : {};
}

// The open day and how much has been written to it. Sync appends keep the file
// readable the instant a record is logged, the same guarantee the other two
// streams give and the tests rely on.
let state = { day: null, bytes: 0, capped: false };

function openDay(day) {
  ensureDataDir("logs", "debug");
  const file = debugFile(day);
  let bytes = 0;
  try {
    bytes = fs.statSync(file).size;
  } catch {
    bytes = 0;
  }
  state = { day, bytes, capped: bytes >= MAX_FILE_BYTES };
  return file;
}

/** Test hook: forget the open-day bookkeeping (the files are untouched). */
function resetDebugLogState() {
  state = { day: null, bytes: 0, capped: false };
}

function writeWarning(file) {
  const line = `${JSON.stringify({
    level: 40,
    time: Date.now(),
    msg: "[debug] debug log reached its 5 MB daily cap; further records for this day are dropped",
  })}\n`;
  try {
    fs.appendFileSync(file, line);
    state.bytes += Buffer.byteLength(line);
  } catch {}
}

/**
 * Sanitize and append one record. Called by the Pino debug stream; never
 * throws.
 *
 * @param {unknown} record
 */
function writeRecord(record) {
  let line;
  try {
    line = JSON.stringify(sanitizeRecord(record));
  } catch {
    return;
  }
  if (!line) return;

  try {
    const day = utcDay(record?.time);
    if (state.day !== day) openDay(day);
    if (state.capped) return;

    const payload = `${line}\n`;
    const size = Buffer.byteLength(payload);
    if (state.bytes + size > MAX_FILE_BYTES) {
      state.capped = true;
      writeWarning(debugFile(day));
      return;
    }
    fs.appendFileSync(debugFile(day), payload);
    state.bytes += size;
  } catch {
    // A debug log that cannot be written is not a reason to fail anything.
  }
}

/** The stream handed to pino.multistream. It may receive several lines. */
const stream = {
  write(chunk) {
    try {
      const text = typeof chunk === "string" ? chunk : String(chunk);
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          record = { msg: line };
        }
        writeRecord(record);
      }
    } catch {}
    return true;
  },
  // pino.multistream calls end() on every destination; a no-op is enough for a
  // stream that is already written synchronously.
  end() {},
};

function listFiles() {
  let names;
  try {
    names = fs.readdirSync(DEBUG_DIR);
  } catch {
    return [];
  }
  return names
    .filter((name) => FILE_PATTERN.test(name))
    .sort()
    .map((name) => path.join(DEBUG_DIR, name));
}

/**
 * The newest records across the day files, newest last, re-sanitized on read.
 * Bounded by `maxBytes` and by the record that would cross the boundary.
 *
 * @param {{ maxBytes?: number }} [options]
 * @returns {string}
 */
function readDebugTail(options = {}) {
  const requested = Number(options?.maxBytes);
  const maxBytes =
    Number.isFinite(requested) && requested > 0 ? Math.trunc(requested) : DEFAULT_TAIL_BYTES;

  const files = listFiles();
  const chunks = [];
  let remaining = maxBytes;

  for (let i = files.length - 1; i >= 0 && remaining > 0; i -= 1) {
    const file = files[i];
    let fd;
    try {
      fd = fs.openSync(file, "r");
      const size = fs.fstatSync(fd).size;
      const take = Math.min(size, remaining);
      const start = size - take;
      const buffer = Buffer.alloc(take);
      const bytesRead = fs.readSync(fd, buffer, 0, take, start);
      let text = buffer.toString("utf8", 0, bytesRead);
      // A byte boundary can land inside a character or a record.
      if (start > 0) {
        const newline = text.indexOf("\n");
        text = newline < 0 ? "" : text.slice(newline + 1);
      }
      chunks.unshift(text);
      remaining -= bytesRead;
    } catch {
      // A file that vanished or cannot be read is skipped.
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {}
      }
    }
  }

  const records = [];
  for (const chunk of chunks) {
    for (const line of chunk.split("\n")) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue; // A truncated or hand-edited line must not hide newer ones.
      }
      try {
        records.push(JSON.stringify(sanitizeRecord(record)));
      } catch {}
    }
  }
  return records.join("\n");
}

/** Delete debug files older than 14 days. Runs at boot and every six hours. */
function sweepDebugLogs() {
  const now = Date.now();
  for (const file of listFiles()) {
    try {
      if (now - fs.statSync(file).mtimeMs > MAX_AGE_MS) fs.unlinkSync(file);
    } catch {}
  }
}

/** Delete every file in logs/debug. Called by logger.clearLogs(). */
function clearDebugLogs() {
  resetDebugLogState();
  let names;
  try {
    names = fs.readdirSync(DEBUG_DIR);
  } catch {
    return;
  }
  for (const name of names) {
    try {
      fs.rmSync(path.join(DEBUG_DIR, name), { recursive: true, force: true });
    } catch {}
  }
}

module.exports = {
  DEBUG_DIR,
  MAX_FILE_BYTES,
  MAX_AGE_MS,
  FIELD_MAX,
  stream,
  sanitizeRecord,
  writeRecord,
  readDebugTail,
  sweepDebugLogs,
  clearDebugLogs,
  resetDebugLogState,
};

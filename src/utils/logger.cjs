const path = require("path");
const fs = require("node:fs");
const pino = require("pino");

const { ensureDataDir } = require("../config/paths.cjs");
const debugLog = require("../diagnostics/debugLog.cjs");

// Logs go in the data directory with everything else the bot writes, so a
// global install never tries to write next to its own code.
const logDir = ensureDataDir("logs");

// A packaged executable cannot load a worker target by module path.
function isPackaged() {
  try {
    return require("node:sea").isSea() === true;
  } catch {
    return false;
  }
}

// Worker-thread transports load targets by module path. That fails inside a
// SEA, and Android's Bionic Node is happier with in-process streams too.
function useInProcessLogs() {
  return isPackaged() || process.env.LEVIX_ANDROID === "1";
}

const base = {
  level: "trace",
  serializers: {
    err: pino.stdSerializers.err,
    error: pino.stdSerializers.err,
  },
};

const PRETTY = {
  colorize: true,
  translateTime: "SYS:dd-mm-yyyy HH:MM:ss",
  ignore: "pid,hostname",
  messageFormat: "{msg}",
  errorLikeObjectKeys: ["err", "error"],
};

const combined = path.join(logDir, "combined.log");
const errors = path.join(logDir, "error.log");

// Own file writes in this thread so clearing has a precise boundary. Async
// SonicBoom flushSync() does not wait for an already in-flight write, which
// could otherwise restore an old entry after truncation. Sync destinations
// are ready immediately and leave no pending file writes behind.
const combinedStream = pino.destination({ dest: combined, mkdir: true, sync: true });
const errorStream = pino.destination({ dest: errors, mkdir: true, sync: true });
const logger = pino(
  base,
  pino.multistream([
    { level: "trace", stream: combinedStream },
    // Detailed, sanitized, local only. See src/diagnostics/debugLog.cjs.
    { level: "debug", stream: debugLog.stream },
    { level: "error", stream: errorStream },
    {
      level: "trace",
      stream: useInProcessLogs()
        ? require("pino-pretty")(PRETTY)
        : pino.transport({ target: "pino-pretty", options: PRETTY }),
    },
  ]),
);

// Writes only to the sanitized debug log: never combined.log, error.log or the
// console. For detail that matters only when diagnosing (Baileys, Node's
// network layer), and that leaves the device only inside an operator-sent
// crash report or feedback with diagnostics ticked.
logger.debugOnly = pino(base, debugLog.stream);

const MAX_READ_BYTES = 256 * 1024;

/** Read only the bounded tail of the operational log, never arbitrary files. */
logger.readLogs = function readLogs(limit = 500) {
  const requested = Number(limit);
  const count = Number.isFinite(requested)
    ? Math.max(1, Math.min(500, Math.trunc(requested)))
    : 500;
  const fd = fs.openSync(combined, "r");
  let text;
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - MAX_READ_BYTES);
    const buffer = Buffer.alloc(Math.min(size, MAX_READ_BYTES));
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, start);
    text = buffer.toString("utf8", 0, bytesRead);
    // The byte boundary can land inside a UTF-8 character or a JSON record.
    if (start > 0) {
      const newline = text.indexOf("\n");
      text = newline < 0 ? "" : text.slice(newline + 1);
    }
  } finally {
    fs.closeSync(fd);
  }

  const entries = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // A truncated or malformed record must not hide newer logs.
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const level = typeof entry.level === "number" ? entry.level : 30;
    const normalizedLevel =
      level >= 50 ? "error" : level >= 40 ? "warn" : level >= 30 ? "info" : "debug";
    const date =
      typeof entry.time === "number" || typeof entry.time === "string"
        ? new Date(entry.time)
        : new Date(NaN);
    const time = Number.isFinite(date.getTime()) ? date.toISOString() : "";
    let msg =
      typeof entry.msg === "string"
        ? entry.msg
        : entry.msg == null
          ? ""
          : JSON.stringify(entry.msg);
    const error = entry.err ?? entry.error;
    if (error && typeof error === "object") {
      const detail = error.stack || error.message;
      if (typeof detail === "string" && detail !== msg) msg = msg ? `${msg}\n${detail}` : detail;
    }
    entries.push({ time, level: normalizedLevel, msg });
  }
  return entries.slice(-count);
};

/** Truncate the open files in place, keeping later writes on the same files. */
logger.clearLogs = function clearLogs() {
  combinedStream.flushSync();
  errorStream.flushSync();
  fs.ftruncateSync(combinedStream.fd, 0);
  fs.ftruncateSync(errorStream.fd, 0);
  // The debug log is part of "the logs": one Clear removes it too.
  debugLog.clearDebugLogs();
};

module.exports = logger;

const path = require("path");
const pino = require("pino");

const { ensureDataDir } = require("../config/paths.cjs");

// Logs go in the data directory with everything else the bot writes, so a
// global install never tries to write next to its own code.
const logDir = ensureDataDir("logs");

// Pino's `transport` option runs each target in a worker thread, and a worker
// loads its target by module path — which a single-file executable can't
// provide. Same three destinations either way; packaged builds just wire them
// as plain streams in this thread.
function isPackaged() {
  try {
    return require("node:sea").isSea() === true;
  } catch {
    return false;
  }
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

const logger = isPackaged()
  ? pino(
      base,
      pino.multistream([
        { level: "trace", stream: pino.destination({ dest: combined, mkdir: true }) },
        { level: "error", stream: pino.destination({ dest: errors, mkdir: true }) },
        { level: "trace", stream: require("pino-pretty")(PRETTY) },
      ])
    )
  : pino({
      ...base,
      transport: {
        targets: [
          // Combined log file (all levels)
          {
            target: "pino/file",
            level: "trace",
            options: { destination: combined, mkdir: true },
          },
          // Error log file (errors only)
          {
            target: "pino/file",
            level: "error",
            options: { destination: errors, mkdir: true },
          },
          // Pretty console output
          { target: "pino-pretty", level: "trace", options: PRETTY },
        ],
      },
    });

module.exports = logger;

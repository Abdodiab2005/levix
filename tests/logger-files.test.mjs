import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { equal, finish, ok, require, section, useTempDataDir } from "./harness.mjs";

const dataDir = useTempDataDir("levix-logger-files");
const logger = require("./src/utils/logger.cjs");
const combined = join(dataDir, "logs", "combined.log");
const errors = join(dataDir, "logs", "error.log");
const unrelated = join(dataDir, "logs", "unrelated.log");

section("real Pino writes, clear boundary, and surviving writes");
writeFileSync(unrelated, "keep this");
logger.info("old entry");
logger.error({ err: new Error("diagnostic detail") }, "old error");
ok("combined file contains writes immediately", statSync(combined).size > 0);
ok("error file contains errors immediately", statSync(errors).size > 0);
const before = logger.readLogs();
equal(
  "Pino methods survive the exported extension",
  typeof logger.child({ source: "test" }).info,
  "function",
);
equal("read normalizes error level", before.at(-1).level, "error");
ok(
  "read preserves error diagnostic detail",
  before.at(-1).msg.includes("Error: diagnostic detail"),
);
ok("read normalizes timestamp", /^\d{4}-\d\d-\d\dT/.test(before[0].time));

// Clear immediately after writing, with no turn for asynchronous flushes.
logger.clearLogs();
equal("combined file is truncated", statSync(combined).size, 0);
equal("error file is truncated", statSync(errors).size, 0);
equal("unrelated file is preserved", readFileSync(unrelated, "utf8"), "keep this");
logger.warn("new entry");
await new Promise((resolve) => setTimeout(resolve, 30));
equal("old entries never reappear after asynchronous work", logger.readLogs().length, 1);
equal("post-clear log survives", logger.readLogs()[0].msg, "new entry");
equal("post-clear level is normalized", logger.readLogs()[0].level, "warn");
equal("old error does not reappear", statSync(errors).size, 0);

const restarted = spawnSync(
  process.execPath,
  [
    "--input-type=commonjs",
    "-e",
    `
  const logger = require(${JSON.stringify(require.resolve("./src/utils/logger.cjs"))});
  console.log(JSON.stringify(logger.readLogs()));
`,
  ],
  { encoding: "utf8", env: { ...process.env, LEVIX_ANDROID: "1" } },
);
equal("new process can read persisted logs", restarted.status, 0);
equal("restart cannot restore cleared logs", JSON.parse(restarted.stdout)[0].msg, "new entry");

section("bounded tail, invalid records, and limit normalization");
logger.clearLogs();
const record = (i) => JSON.stringify({ time: 0, level: i === 599 ? 60 : 10, msg: `entry ${i}` });
writeFileSync(
  combined,
  `not-json\nnull\n[]\n${Array.from({ length: 600 }, (_, i) => record(i)).join("\n")}\n`,
);
equal("default read is capped at 500", logger.readLogs().length, 500);
equal("oversized limit is capped", logger.readLogs(10000).length, 500);
equal("invalid limit uses bounded default", logger.readLogs("bad").length, 500);
equal("requested tail count is honored", logger.readLogs(2).length, 2);
equal("fractional limit is rounded down", logger.readLogs(2.9).length, 2);
equal("zero limit remains bounded and nonempty", logger.readLogs(0).length, 1);
equal("newest record is retained", logger.readLogs(1)[0].msg, "entry 599");
equal("fatal is presented as error", logger.readLogs(1)[0].level, "error");
equal("trace is presented as debug", logger.readLogs(2)[0].level, "debug");
equal("epoch timestamp is valid", logger.readLogs(1)[0].time, "1970-01-01T00:00:00.000Z");
appendFileSync(combined, `${JSON.stringify({ time: {}, level: {}, msg: "bad metadata" })}\n`);
equal("invalid timestamp does not fail the read", logger.readLogs(1)[0].time, "");
equal("invalid level defaults to info", logger.readLogs(1)[0].level, "info");

// An oversized record makes the 256 KB tail begin inside a valid JSON string.
writeFileSync(combined, `${JSON.stringify({ time: 0, level: 30, msg: "x".repeat(300_000) })}\n`);
appendFileSync(combined, `broken json\n${record(599)}\n`);
equal("partial first line and malformed lines are discarded", logger.readLogs().length, 1);
equal(
  "bounded read still returns the newest complete entry",
  logger.readLogs()[0].msg,
  "entry 599",
);
writeFileSync(combined, "x".repeat(300_000));
equal("a tail without any complete records is empty", logger.readLogs().length, 0);

logger.clearLogs();
logger.error("new error");
equal(
  "subsequent errors still reach error.log",
  JSON.parse(readFileSync(errors, "utf8")).msg,
  "new error",
);
finish();

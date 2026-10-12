// Node fatal capture (contract section 4, capture points).
//
// A child process imports the real src/index.js, installs its fatal handlers,
// then throws / rejects. The handler must write one local crash report before
// the existing log-and-exit, and the process must still exit.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { equal, finish, ok, ROOT, section, useTempDataDir } from "./harness.mjs";

const dataDir = useTempDataDir("levix-crash-fatal");
const crashDir = path.join(dataDir, "crash-reports");
const indexUrl = pathToFileURL(path.join(ROOT, "src", "index.js")).href;

function runChild(trigger) {
  const code = [
    `import { installShutdownHandlers } from ${JSON.stringify(indexUrl)};`,
    "installShutdownHandlers();",
    "setTimeout(() => {}, 5000);",
    trigger,
  ].join("\n");

  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
      env: { ...process.env, LEVIX_DATA_DIR: dataDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, stderr: `${stderr}\n(timed out)` });
    }, 60000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

function reports() {
  try {
    return fs
      .readdirSync(crashDir)
      .filter((name) => /^[0-9a-f]{16}\.json$/.test(name))
      .map((name) => JSON.parse(fs.readFileSync(path.join(crashDir, name), "utf8")));
  } catch {
    return [];
  }
}

try {
  section("uncaughtException writes a report and still exits");

  const uncaught = await runChild('setTimeout(() => { throw new Error("boom-from-test"); }, 50);');
  equal("the process exits with the fatal code", uncaught.code, 1);
  const uncaughtReports = reports().filter((r) => r.category === "node-uncaught");
  ok("a node-uncaught report was written", uncaughtReports.length >= 1);
  ok(
    "the report names the thrown error",
    uncaughtReports.some((r) => r.error.message.includes("boom-from-test")),
  );
  ok(
    "the report has the schema and an id",
    uncaughtReports.every((r) => r.schema === 1 && /^[0-9a-f]{16}$/.test(r.id)),
  );

  section("unhandledRejection writes a report and still exits");

  const rejected = await runChild('Promise.reject(new Error("reject-from-test"));');
  equal("the process exits with the fatal code", rejected.code, 1);
  const rejectionReports = reports().filter((r) => r.category === "node-rejection");
  ok("a node-rejection report was written", rejectionReports.length >= 1);
  ok(
    "the report names the rejected error",
    rejectionReports.some((r) => r.error.message.includes("reject-from-test")),
  );
} finally {
  fs.rmSync(crashDir, { recursive: true, force: true });
}

finish();

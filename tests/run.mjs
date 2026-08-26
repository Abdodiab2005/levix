// The test runner: `npm test`.
//
// Each *.test.mjs file runs in its own process, because every one of them
// imports modules that resolve a data directory at import time and there is no
// way to un-resolve it in-process. Isolation is the point, not speed.
//
// Files that need a built artifact (a packed tarball, a compiled executable)
// live in scripts/validate-*.mjs instead and run separately — they take
// minutes, and `npm test` has to stay something you run constantly.

import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const HERE = fileURLToPath(new URL(".", import.meta.url));

const only = process.argv[2];
const files = readdirSync(HERE)
  .filter((name) => name.endsWith(".test.mjs"))
  .filter((name) => !only || name.includes(only))
  .sort();

if (!files.length) {
  console.error(only ? `No test file matches "${only}"` : "No test files found");
  process.exit(1);
}

const results = [];
let totalChecks = 0;
let totalFailed = 0;

for (const file of files) {
  console.log(`\n${"─".repeat(64)}\n▸ ${file}`);

  const { code, output } = await new Promise((resolve) => {
    const child = spawn(process.execPath, [join(HERE, file)], {
      stdio: ["ignore", "pipe", "pipe"],
      // A stray real data directory would be a bug in the test, not something
      // to inherit quietly.
      env: { ...process.env, LEVIX_DATA_DIR: "" },
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
      process.stderr.write(chunk);
    });
    child.on("close", (code) => resolve({ code, output }));
  });

  const tally = /^CHECKS (\d+) (\d+)$/m.exec(output);
  const checks = tally ? Number(tally[1]) : 0;
  const failed = tally ? Number(tally[2]) : 0;

  totalChecks += checks;
  totalFailed += failed;

  // A file that exits non-zero without printing a tally crashed — count that
  // as a failure rather than a silent zero.
  const crashed = !tally && code !== 0;
  results.push({ file, checks, failed, crashed, code });
}

console.log(`\n${"═".repeat(64)}`);
for (const r of results) {
  const status = r.crashed
    ? "CRASHED"
    : r.failed
    ? `${r.failed} FAILED`
    : "ok";
  console.log(`  ${r.file.padEnd(34)} ${String(r.checks).padStart(4)} checks   ${status}`);
}

const crashed = results.filter((r) => r.crashed).length;
console.log(`${"═".repeat(64)}`);
console.log(`  ${totalChecks} checks · ${totalFailed} failed · ${crashed} file(s) crashed\n`);

process.exit(totalFailed || crashed ? 1 : 0);

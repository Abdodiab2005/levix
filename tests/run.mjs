// The test runner: `npm test`.
//
// Each *.test.mjs file runs in its own process, because every one of them
// imports modules that resolve a data directory at import time and there is no
// way to un-resolve it in-process. Isolation is the point, not speed.
//
// Files that need a built artifact (a packed tarball, a compiled executable)
// live in scripts/validate-*.mjs instead and run separately — they take
// minutes, and `npm test` has to stay something you run constantly.
//
// The summary lists each file's wall time and the five slowest, so a slow file
// shows up in every run's output.

import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

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
const runStart = performance.now();

for (const file of files) {
  console.log(`\n${"─".repeat(64)}\n▸ ${file}`);

  const started = performance.now();
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
  // Wall time of this file, measured from just before spawn to close.
  const seconds = (performance.now() - started) / 1000;

  const tally = /^CHECKS (\d+) (\d+)$/m.exec(output);
  const checks = tally ? Number(tally[1]) : 0;
  const failed = tally ? Number(tally[2]) : 0;

  totalChecks += checks;
  totalFailed += failed;

  // A file that exits non-zero without printing a tally crashed — count that
  // as a failure rather than a silent zero.
  const crashed = !tally && code !== 0;
  results.push({ file, checks, failed, crashed, code, seconds });
}

console.log(`\n${"═".repeat(64)}`);
for (const r of results) {
  const status = r.crashed ? "CRASHED" : r.failed ? `${r.failed} FAILED` : "ok";
  const time = `${r.seconds.toFixed(1).padStart(6)} s`;
  const row = `${r.file.padEnd(34)} ${String(r.checks).padStart(4)} checks   ${status}`;
  // Append the file's wall time in its own column.
  console.log(`  ${row.padEnd(56)}${time}`);
}

const crashed = results.filter((r) => r.crashed).length;
console.log(`${"═".repeat(64)}`);
console.log(`  ${totalChecks} checks · ${totalFailed} failed · ${crashed} file(s) crashed\n`);

// The five slowest files, slowest first, then the whole run's wall time.
const slowest = [...results].sort((a, b) => b.seconds - a.seconds).slice(0, 5);
console.log("  Slowest files");
for (const r of slowest) {
  console.log(`    ${r.file.padEnd(34)}${r.seconds.toFixed(1).padStart(6)} s`);
}
console.log(`  Total ${((performance.now() - runStart) / 1000).toFixed(1)} s`);

process.exit(totalFailed || crashed ? 1 : 0);

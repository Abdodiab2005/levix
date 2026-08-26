// One bot per data directory.
//
// Two Levix processes sharing a database would share one WhatsApp pairing:
// both writing the same session keys, both answering every message. The old
// failure mode was worse than useless — the second process only died later,
// when it tried to bind the panel's port, long after it had touched the auth
// rows the first one was using.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { useTempDataDir, require, ROOT, section, ok, equal, finish } from "./harness.mjs";

const dataDir = useTempDataDir("levix-lock");
const lock = require("./src/config/lock.cjs");

// Runs the lock in another process so the two claims are genuinely separate.
function claimInChild(dir, { holdMs = 0 } = {}) {
  return spawnSync(
    process.execPath,
    [
      "-e",
      `
      const lock = require(${JSON.stringify(`${ROOT}src/config/lock.cjs`)});
      try {
        lock.acquireSingleInstanceLock();
        process.stdout.write("ACQUIRED " + process.pid);
        ${holdMs ? `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${holdMs});` : ""}
      } catch (error) {
        process.stdout.write("REFUSED " + (error.code || "") + " " + error.message);
      }
      `,
    ],
    { env: { ...process.env, LEVIX_DATA_DIR: dir }, encoding: "utf8" }
  );
}

section("the first process wins");

const first = lock.acquireSingleInstanceLock();
ok("a lock file appears", existsSync(first));
equal("it holds our pid", readFileSync(first, "utf8").trim(), String(process.pid));
ok("claiming again in the same process is fine", lock.acquireSingleInstanceLock() === first);

section("a second process is refused, clearly");

{
  const child = claimInChild(dataDir);
  ok("the second process is refused", child.stdout.startsWith("REFUSED"));
  ok("with the code the CLI looks for", child.stdout.includes("ELEVIXLOCKED"));
  ok("naming the live pid", child.stdout.includes(String(process.pid)));
  ok("and saying what to do", /Stop the other one|--data/.test(child.stdout));
}

section("releasing hands it over");

lock.release();
ok("the lock file is gone", !existsSync(first));
{
  const child = claimInChild(dataDir);
  ok("a later process can now claim it", child.stdout.startsWith("ACQUIRED"));
}

section("a lock left behind by a crash is not fatal");

{
  // A pid that cannot be running: the file outlived its process.
  writeFileSync(first, "999999");
  ok("a dead pid is recognised as dead", lock.processAlive(999999) === false);

  const child = claimInChild(dataDir);
  ok("the stale lock is taken over", child.stdout.startsWith("ACQUIRED"));
}

{
  // A truncated or garbage file — a crash mid-write, or a filesystem hiccup.
  for (const junk of ["", "   ", "not-a-pid", "-1"]) {
    writeFileSync(first, junk);
    const child = claimInChild(dataDir);
    ok(`a lock file containing ${JSON.stringify(junk)} is taken over`, child.stdout.startsWith("ACQUIRED"));
  }
}

section("a live holder is never evicted");

{
  // Hold it from a child, then try to claim it from another child.
  const holder = spawnSync(
    process.execPath,
    [
      "-e",
      `
      const lock = require(${JSON.stringify(`${ROOT}src/config/lock.cjs`)});
      lock.acquireSingleInstanceLock();
      const fs = require("node:fs");
      // Leave the lock pointing at a process that is definitely alive: ours.
      fs.writeFileSync(${JSON.stringify(`${dataDir}/levix.lock`)}, String(process.ppid));
      process.stdout.write("PLANTED");
      `,
    ],
    { env: { ...process.env, LEVIX_DATA_DIR: dataDir }, encoding: "utf8" }
  );
  ok("a lock pointing at a live process is planted", holder.stdout === "PLANTED");

  const child = claimInChild(dataDir);
  ok("a live holder blocks the claim", child.stdout.startsWith("REFUSED"));
  ok("our own pid is reported as alive", lock.processAlive(process.pid) === true);
}

finish();

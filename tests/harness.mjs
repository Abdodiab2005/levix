// The whole test framework. No dependencies, on purpose: the bot's promise is
// that it needs nothing but Node, and a test suite that needs a toolchain to
// run is the first thing to rot.
//
// Every test file runs in its own process (see run.mjs) with its own throwaway
// data directory, so nothing leaks between files and nothing touches a real
// installation.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * A fresh data directory, exported to the environment BEFORE anything imports
 * a module that resolves it. Call this first in every test file.
 */
export function useTempDataDir(label = "levix-test") {
  const dir = mkdtempSync(join(tmpdir(), `${label}-`));
  process.env.LEVIX_DATA_DIR = dir;
  process.on("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });
  return dir;
}

/** Point the next require/import at a data directory that already exists. */
export function reuseDataDir(dir) {
  process.env.LEVIX_DATA_DIR = dir;
  return dir;
}

export const require = createRequire(join(ROOT, "package.json"));

// --- assertions -----------------------------------------------------------

let passed = 0;
const failures = [];
let currentSection = "";

export function section(name) {
  currentSection = name;
  console.log(`\n  ${name}`);
}

/** One check. `condition` must be strictly true-ish; anything else fails. */
export function ok(label, condition, detail) {
  if (condition) {
    passed += 1;
    return true;
  }
  failures.push({ section: currentSection, label, detail });
  console.log(`    FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  return false;
}

export function equal(label, actual, expected) {
  return ok(
    label,
    actual === expected,
    actual === expected ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  );
}

/** Assert that `fn` throws. Returns the error so the caller can inspect it. */
export function throws(label, fn) {
  try {
    fn();
    ok(label, false, "expected it to throw, but it returned");
    return null;
  } catch (error) {
    ok(label, true);
    return error;
  }
}

/**
 * Print the tally in the format run.mjs parses, and set the exit code.
 * Every test file must end with this.
 */
export function finish() {
  if (failures.length) {
    console.log(`\n  ${failures.length} failed:`);
    for (const f of failures) {
      console.log(`    - [${f.section}] ${f.label}${f.detail ? ` (${f.detail})` : ""}`);
    }
  }
  console.log(`\nCHECKS ${passed} ${failures.length}`);
  process.exitCode = failures.length ? 1 : 0;
}

// --- an HTTP client that keeps a cookie jar -------------------------------

export function httpClient(base) {
  let cookie = "";

  async function call(path, options = {}) {
    const response = await fetch(base + path, {
      redirect: "manual",
      ...options,
      headers: { ...(options.headers || {}), ...(cookie ? { cookie } : {}) },
    });
    const set = response.headers.getSetCookie?.() || [];
    if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ");
    return response;
  }

  return {
    call,
    form: (path, data, headers = {}) =>
      call(path, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
        body: new URLSearchParams(data).toString(),
      }),
    json: (path, data, method = "POST") =>
      call(path, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(data),
      }),
    reset() {
      cookie = "";
    },
  };
}

/**
 * Start tests/fixtures/server.mjs in its own process and wait for its URL.
 * Returns { base, stop() }. Used where one process can't hold every
 * configuration under test — app.cjs reads `trust proxy` once, at import.
 */
export async function startServer({ dataDir, trust, host, routes = false, timeoutMs = 20000 } = {}) {
  const { spawn } = await import("node:child_process");
  const args = [join(ROOT, "tests", "fixtures", "server.mjs"), "--data", dataDir];
  if (trust !== undefined) args.push("--trust", String(trust));
  if (host) args.push("--host", host);
  if (routes) args.push("--routes");

  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));

  let buffered = "";
  const address = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`server did not start in ${timeoutMs}ms\n${stderr}`)),
      timeoutMs
    );
    child.stdout.on("data", (chunk) => {
      buffered += chunk;
      const match = /^LISTENING (.+)$/m.exec(buffered);
      if (match) {
        clearTimeout(timer);
        resolve(match[1].trim());
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited with ${code}\n${stderr}`));
    });
  });

  const trustProxy = /^TRUSTPROXY (.*)$/m.exec(buffered)?.[1];

  return {
    base: `http://${address}`,
    address,
    trustProxy: trustProxy === undefined ? undefined : JSON.parse(trustProxy),
    stop() {
      child.kill("SIGKILL");
    },
  };
}

/** Wait for a listening server and hand back its base URL. */
export async function listen(server, host = "127.0.0.1") {
  await new Promise((resolve) => server.listen(0, host, resolve));
  const { port } = server.address();
  return { port, base: `http://${host}:${port}` };
}

// Does the single executable actually work?
//
// "It built" is not the question. This copies the binary somewhere with no
// source tree, no node_modules and no Node, runs it there, and exercises the
// things a packaged build breaks first: extracted assets, the view engine, the
// command manifests, the logger's worker transports, ffmpeg's absence.
//
//   npm run build:sea && npm run validate:sea

import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUILT = join(ROOT, "build", process.platform === "win32" ? "levix.exe" : "levix");
const PANEL_PORT = 34211;

let passed = 0;
const failures = [];

function ok(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${label}`);
    return true;
  }
  failures.push(label);
  console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  return false;
}

if (!existsSync(BUILT)) {
  console.error(`\n  No executable at ${BUILT}. Run: npm run build:sea\n`);
  process.exit(1);
}

// A directory with the binary and nothing else — no package.json, no src/, no
// node_modules. If the executable reaches for any of them, it fails here.
const sandbox = mkdtempSync(join(tmpdir(), "levix-sea-"));
const binary = join(sandbox, process.platform === "win32" ? "levix.exe" : "levix");
cpSync(BUILT, binary);
const dataDir = join(sandbox, "data");

console.log(`\n▸ Validating ${BUILT}`);
console.log(`  sandbox: ${sandbox}\n`);

const env = { ...process.env, LEVIX_DATA_DIR: dataDir, LEVIX_OPEN_BROWSER: "0" };

function runBinary(args, extraEnv = {}) {
  return spawnSync(binary, args, {
    cwd: sandbox,
    encoding: "utf8",
    env: { ...env, ...extraEnv },
    timeout: 60000,
  });
}

// --- the cheap commands ---------------------------------------------------

console.log("· the CLI");

{
  const version = runBinary(["--version"]);
  ok("--version answers", version.status === 0 && /^\d+\.\d+\.\d+/.test(version.stdout.trim()));

  const help = runBinary(["--help"]);
  ok("--help lists headless", help.stdout.includes("levix headless"));
  ok("--help lists domain", help.stdout.includes("levix domain"));

  const where = runBinary(["where"]);
  ok("where prints the data directory", where.stdout.trim() === dataDir, where.stdout.trim());

  const bogus = runBinary(["frobnicate"]);
  ok("an unknown command exits non-zero", bogus.status === 1);
}

// --- start it -------------------------------------------------------------

console.log("\n· starting the panel");

function startBinary(args, { waitFor, timeoutMs = 90000, extraEnv = {} } = {}) {
  const child = spawn(binary, args, {
    cwd: sandbox,
    env: { ...env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const seen = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`never printed ${JSON.stringify(waitFor)}\n${output}`)),
      timeoutMs
    );
    const check = (chunk) => {
      output += chunk;
      if (output.includes(waitFor)) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on("data", check);
    child.stderr.on("data", check);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`exited early with ${code}\n${output}`));
    });
  });
  return {
    seen,
    get output() {
      return output;
    },
    async stop() {
      child.kill("SIGTERM");
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 10000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

// The port lives in the database, and there isn't one yet — so set it the way
// a person would have to: start once, then configure. Simpler here: pass it
// through the settings table by starting on the default and reading the URL.
let panelUrl = null;

{
  const levix = await (async () => {
    const started = startBinary([], { waitFor: "Ctrl+C" });
    await started.seen;
    return started;
  })();

  ok("it starts with no source tree in sight", /is running/.test(levix.output));
  ok("it prints a panel URL", /Panel: http/.test(levix.output));
  ok("a first run points at /setup", /\/setup/.test(levix.output));
  ok("it does not try to open a browser here", /Open that link yourself/.test(levix.output));

  panelUrl = /Panel: (\S+)/.exec(levix.output)?.[1] ?? null;
  const base = panelUrl?.replace("/setup", "") ?? null;
  ok("the URL is parseable", Boolean(base), levix.output);

  // --- what a packaged build breaks first ---------------------------------

  console.log("\n· assets, views and the vendored client");

  const setup = await fetch(`${base}/setup`);
  ok("the setup view renders", setup.status === 200);
  const html = await setup.text();
  ok("…as real HTML from the EJS template", html.includes("<form") && html.includes("password"));

  const css = await fetch(`${base}/dashboard.css`);
  ok("the stylesheet is served", css.status === 200);

  const socketClient = await fetch(`${base}/socket.io.min.js`);
  ok("the vendored socket.io client is served", socketClient.status === 200);
  ok(
    "…and is the real library",
    (await socketClient.text()).includes("socket.io"),
    "the file served does not look like socket.io"
  );

  const logo = await fetch(`${base}/brand/wordmark.png`);
  ok("brand images are served", logo.status === 200);

  ok("assets were extracted into the data directory", existsSync(join(dataDir, "assets")));
  ok("the persona template was extracted", existsSync(join(dataDir, "ai-persona.md")));

  console.log("\n· the database and the commands");

  ok("SQLite was created", existsSync(join(dataDir, "levix.db")));
  ok("…and is not empty", statSync(join(dataDir, "levix.db")).size > 0);

  // Claim it, then ask the API what it loaded.
  const jar = [];
  const claim = await fetch(`${base}/setup`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      password: "a-good-password",
      confirm: "a-good-password",
    }).toString(),
  });
  ok("the first-run password can be set", claim.status === 303);
  for (const cookie of claim.headers.getSetCookie?.() || []) jar.push(cookie.split(";")[0]);

  const stats = await fetch(`${base}/dashboard/api/stats`, {
    headers: { cookie: jar.join("; ") },
  });
  const body = await stats.json();
  ok("the dashboard API answers", stats.status === 200 && body.success);
  ok(
    `every command loaded (${body.stats?.commandCount})`,
    body.stats?.commandCount > 50,
    "the generated manifests did not load"
  );

  console.log("\n· logging");

  ok("the log file was written", existsSync(join(dataDir, "logs", "combined.log")));
  const log = readFileSync(join(dataDir, "logs", "combined.log"), "utf8");
  ok("…with real entries", log.includes("Levix"), "pino's transports did not run");
  ok(
    "no worker-thread transport error",
    !/worker (has )?exited|Cannot find module/i.test(levix.output),
    levix.output.slice(-400)
  );

  console.log("\n· no lookups into a source tree that isn't there");

  ok(
    "nothing tried to require a missing module",
    !/Cannot find module/i.test(levix.output),
    levix.output.slice(-400)
  );
  ok("no unhandled crash was printed", !/Uncaught Exception|UnhandledPromiseRejection/.test(levix.output));

  await levix.stop();
}

// --- restart --------------------------------------------------------------

console.log("\n· restarting");

{
  const levix = startBinary([], { waitFor: "Ctrl+C" });
  await levix.seen;

  ok("it starts again against the existing data", /is running/.test(levix.output));
  ok("…and no longer offers first-run setup", !/\/setup/.test(levix.output));

  const base = /Panel: (\S+)/.exec(levix.output)?.[1];
  const login = await fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: "a-good-password" }).toString(),
  });
  ok("the password set before the restart still works", login.status === 303);

  await levix.stop();
}

// --- headless -------------------------------------------------------------

console.log("\n· headless");

{
  const levix = startBinary(["headless"], { waitFor: "Ctrl+C" });
  await levix.seen;

  ok("headless starts", /headless/i.test(levix.output));
  ok("…loads the commands", /\d+ commands loaded/.test(levix.output));
  ok("…and says it has no panel", /No web panel/i.test(levix.output));
  ok("…printing no panel URL", !/Panel:/.test(levix.output));

  const reachable = await fetch(`http://127.0.0.1:${PANEL_PORT}/`).then(
    () => true,
    () => false
  );
  ok("nothing answers on a panel port", reachable === false);

  await levix.stop();
}

// --- ffmpeg ---------------------------------------------------------------

console.log("\n· ffmpeg is absent, and that is fine");

{
  // An empty PATH means no ffmpeg anywhere. The binary does not carry one, so
  // this is the real deployment case for a fresh machine.
  const levix = startBinary(["headless"], {
    waitFor: "Ctrl+C",
    extraEnv: { PATH: "" },
  });
  let started = true;
  try {
    await levix.seen;
  } catch {
    started = false;
  }
  ok("Levix still starts with no ffmpeg on PATH", started, levix.output.slice(-300));
  ok("…and does not crash over it", !/Uncaught Exception/.test(levix.output));
  await levix.stop();
}

// --- recovery -------------------------------------------------------------

console.log("\n· recovery commands against a real installation");

{
  const reset = runBinary(["reset-password"]);
  ok("reset-password succeeds", reset.status === 0 && /Password cleared/i.test(reset.stdout));
  ok("…and prints no secret", !/[0-9a-f]{64}/i.test(reset.stdout));

  const levix = startBinary([], { waitFor: "Ctrl+C" });
  await levix.seen;
  ok("the panel offers first-run setup again", /\/setup/.test(levix.output));
  await levix.stop();
}

// --- done -----------------------------------------------------------------

rmSync(sandbox, { recursive: true, force: true });

console.log(`\n${"═".repeat(60)}`);
console.log(`  ${passed} checks · ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.log(`    - ${failure}`);
}
console.log();
process.exit(failures.length ? 1 : 0);

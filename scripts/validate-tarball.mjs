// Install the package the way a stranger would, and see if it works.
//
// `npm start` in this repo proves nothing about what npm publishes: it reads
// files the tarball may not carry. So this packs the real tarball, installs it
// into an empty prefix, and drives the installed `levix` binary — first run,
// password, restart, recovery, headless.
//
//   npm run validate:tarball

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

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

const workDir = mkdtempSync(join(tmpdir(), "levix-tarball-"));
const prefix = join(workDir, "prefix");
const dataDir = join(workDir, "data");

console.log(`\n▸ Packing and installing into ${prefix}\n`);

// --- pack -----------------------------------------------------------------

console.log("· npm pack");

const packed = spawnSync("npm", ["pack", "--pack-destination", workDir, "--json"], {
  cwd: ROOT,
  encoding: "utf8",
  timeout: 180000,
});
ok("npm pack succeeds", packed.status === 0, packed.stderr?.slice(0, 300));

const tarball = readdirSync(workDir).find((name) => name.endsWith(".tgz"));
ok("a tarball was produced", Boolean(tarball), readdirSync(workDir).join(" "));
if (!tarball) finish();

const tarballPath = join(workDir, tarball);

// --- install --------------------------------------------------------------

console.log("\n· npm install -g (into an empty prefix)");

const installed = spawnSync(
  "npm",
  ["install", "--prefix", prefix, "--global", "--no-audit", "--no-fund", tarballPath],
  { cwd: workDir, encoding: "utf8", timeout: 600000 }
);
ok(
  "the tarball installs",
  installed.status === 0,
  (installed.stderr || "").split("\n").slice(-6).join("\n")
);

const binary = join(prefix, "bin", "levix");
ok("the levix command is on the prefix", existsSync(binary), `${binary} is missing`);
if (!existsSync(binary)) finish();

const packageDir = join(prefix, "lib", "node_modules", "levix");
ok("the package directory exists", existsSync(packageDir));
ok("…with the views", existsSync(join(packageDir, "views", "setup.ejs")));
ok("…with the public assets", existsSync(join(packageDir, "public", "socket.io.min.js")));
ok("…with the deploy templates", existsSync(join(packageDir, "deploy", "levix.service")));
ok("…and the licence", existsSync(join(packageDir, "LICENSE")));

// --- run it ---------------------------------------------------------------

const env = {
  ...process.env,
  LEVIX_DATA_DIR: dataDir,
  LEVIX_OPEN_BROWSER: "0",
  // Nothing from this repo may be visible to the installed copy.
  NODE_PATH: "",
};

function levix(args, timeout = 60000) {
  return spawnSync(binary, args, { cwd: workDir, encoding: "utf8", env, timeout });
}

console.log("\n· the installed CLI");

{
  const version = levix(["--version"]);
  ok("--version answers", version.status === 0 && /^\d+\.\d+\.\d+/.test(version.stdout.trim()));
  ok("where prints the data directory", levix(["where"]).stdout.trim() === dataDir);
  ok("--help mentions headless", levix(["--help"]).stdout.includes("levix headless"));
}

function start(args, { waitFor = "Ctrl+C", timeoutMs = 120000 } = {}) {
  const child = spawn(binary, args, { cwd: workDir, env, stdio: ["ignore", "pipe", "pipe"] });
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

console.log("\n· first run");

let base = null;
{
  const levixProcess = start([]);
  try {
    await levixProcess.seen;
  } catch (error) {
    ok("it starts", false, String(error.message).slice(0, 400));
    finish();
  }

  ok("it starts with no .env and no database server", /is running/.test(levixProcess.output));
  ok("it offers first-run setup", /\/setup/.test(levixProcess.output));
  ok("it created the data directory", existsSync(join(dataDir, "levix.db")));

  base = /Panel: (\S+)/.exec(levixProcess.output)?.[1]?.replace("/setup", "") ?? null;
  ok("the panel URL is parseable", Boolean(base));

  const page = await fetch(`${base}/setup`);
  ok("the setup page renders", page.status === 200);

  const claim = await fetch(`${base}/setup`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      password: "a-good-password",
      confirm: "a-good-password",
    }).toString(),
  });
  ok("a password can be chosen", claim.status === 303);

  await levixProcess.stop();
}

console.log("\n· restart");

{
  const levixProcess = start([]);
  await levixProcess.seen;
  ok("it starts again", /is running/.test(levixProcess.output));
  ok("first-run setup is over", !/\/setup/.test(levixProcess.output));

  const login = await fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: "a-good-password" }).toString(),
  });
  ok("the password survived the restart", login.status === 303);
  await levixProcess.stop();
}

console.log("\n· headless");

{
  const levixProcess = start(["headless"]);
  await levixProcess.seen;
  ok("headless starts from the installed package", /headless/i.test(levixProcess.output));
  ok("…and loads the commands", /\d+ commands loaded/.test(levixProcess.output));
  ok("…with no panel", !/Panel:/.test(levixProcess.output));
  await levixProcess.stop();
}

console.log("\n· recovery");

{
  const reset = levix(["reset-password"]);
  ok("reset-password works on the installed copy", reset.status === 0);
  ok("…and says so", /Password cleared/i.test(reset.stdout));
}

function finish() {
  rmSync(workDir, { recursive: true, force: true });
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ${passed} checks · ${failures.length} failed`);
  for (const failure of failures) console.log(`    - ${failure}`);
  console.log();
  process.exit(failures.length ? 1 : 0);
}

finish();

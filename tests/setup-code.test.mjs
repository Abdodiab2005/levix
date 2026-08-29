// The first-run setup code, and the commands the docs tell people to find it with.
//
// This used to drift: the installer printed
//   journalctl -u levix -n 40 | grep -A3 'Setup code'
// while Levix printed "…also needs this code: 43CB5162", which contains no
// "Setup code" anywhere. The documented command returned nothing, on every
// install, forever.
//
// So the format is one constant in src/config/secrets.cjs, and this file runs
// the DOCUMENTED shell pipeline against the REAL stdout of a real `levix`
// process. If either side moves, this goes red.

import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  useTempDataDir,
  httpClient,
  require,
  ROOT,
  section,
  ok,
  equal,
  finish,
} from "./harness.mjs";

const dataDir = useTempDataDir("levix-setupcode");

const PANEL_PORT = 34121;
const settings = require("./src/config/settings.cjs");
const db = require("./src/db/db.cjs");
const secrets = require("./src/config/secrets.cjs");
settings.set("port", PANEL_PORT);
db.checkpoint();

// The one string everything else is built from.
const PREFIX = secrets.SETUP_CODE_LOG_PREFIX;

// The pipeline the docs hand to an operator, minus the log source. Run for
// real, by bash, over the process's actual output.
const DOC_PIPELINE = `grep -F '${PREFIX}' | tail -1`;

/**
 * Start levix and wait for its banner. Returns everything it printed plus a
 * stop(); the caller decides when the process dies, because one of the checks
 * below has to talk to the running panel.
 */
async function boot({ data = dataDir, waitFor = "Ctrl+C", timeoutMs = 60000 } = {}) {
  const child = spawn(process.execPath, [join(ROOT, "bin", "levix.js")], {
    env: { ...process.env, LEVIX_DATA_DIR: data, LEVIX_OPEN_BROWSER: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  const stop = async () => {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 8000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  };

  try {
    await new Promise((resolve, reject) => {
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
  } catch (error) {
    await stop();
    throw error;
  }

  return { output, stop };
}

/** Start, capture, stop — for the checks that only need the output. */
async function bootAndCapture(options) {
  const levix = await boot(options);
  await levix.stop();
  return levix.output;
}

/** What the documented command would print, given this log text. */
function runDocumentedCommand(logText) {
  return execFileSync("bash", ["-c", DOC_PIPELINE], {
    input: logText,
    encoding: "utf8",
  }).trim();
}

// ---------------------------------------------------------------------------

section("an unclaimed panel prints a code the documented command can find");

const levix = await boot();
const firstRun = levix.output;
const matched = runDocumentedCommand(firstRun);

ok(`the documented pipeline matches something (got ${JSON.stringify(matched)})`, matched !== "");
ok("it carries the stable prefix", matched.includes(PREFIX));
// `tail -1` would hide a code printed on every request, so count the raw output
// rather than the pipeline's.
equal(
  "printed exactly once for the whole process",
  firstRun.split(PREFIX).length - 1,
  1
);

const code = matched.slice(matched.indexOf(PREFIX) + PREFIX.length).trim();
ok(`the code is 8 uppercase hex characters (${code})`, /^[0-9A-F]{8}$/.test(code));

ok(
  "no ANSI escape rode along with it",
  // eslint-disable-next-line no-control-regex
  !/\[/.test(matched)
);

section("…and that code actually claims the panel from another machine");

{
  // The whole point of printing it. A forwarding header is enough to stop the
  // request counting as local (src/utils/requestOrigin.cjs), which is exactly
  // the situation an operator on their laptop is in.
  const http = httpClient(`http://127.0.0.1:${PANEL_PORT}`);
  const remote = { "x-forwarded-for": "203.0.113.9" };

  let res = await http.call("/setup", { headers: remote });
  ok("a remote first run is asked for a code", (await res.text()).includes("Setup code"));

  res = await http.form(
    "/setup",
    { password: "a-good-password", confirm: "a-good-password", code: "DEADBEEF" },
    remote
  );
  equal("a wrong code is refused", res.status, 401);

  res = await http.form(
    "/setup",
    { password: "a-good-password", confirm: "a-good-password", code },
    remote
  );
  equal("the code that was printed is accepted", res.status, 303);
}

await levix.stop();

section("the format has exactly one definition");

equal("the prefix is a constant", PREFIX, "[Setup] Setup code:");
equal(
  "and formatSetupCodeLine builds the printed line from it",
  secrets.formatSetupCodeLine("ABCDEF01"),
  `${PREFIX} ABCDEF01`
);
ok(
  "the running process printed exactly that shape",
  new RegExp(`${PREFIX.replace(/[[\]]/g, "\\$&")} [0-9A-F]{8}`).test(firstRun)
);

section("every documented retrieval command greps for what Levix prints");

for (const [file, needle] of [
  ["deploy/install.sh", `journalctl -u \${SERVICE} --no-pager | ${DOC_PIPELINE}`],
  ["deploy/levix.service", `journalctl -u levix --no-pager | ${DOC_PIPELINE}`],
  ["docker-compose.yml", `docker compose logs levix | ${DOC_PIPELINE}`],
  ["SETUP.md", `docker compose logs levix | ${DOC_PIPELINE}`],
  ["SETUP.md", `journalctl -u levix --no-pager | ${DOC_PIPELINE}`],
  ["PACKAGING.md", `docker compose logs levix | ${DOC_PIPELINE}`],
]) {
  const source = readFileSync(join(ROOT, file), "utf8");
  ok(`${file} documents the working command`, source.includes(needle), needle);
}

section("nothing still points at the old broken grep");

for (const file of [
  "deploy/install.sh",
  "deploy/levix.service",
  "docker-compose.yml",
  "SETUP.md",
  "PACKAGING.md",
  "README.md",
]) {
  const source = readFileSync(join(ROOT, file), "utf8");
  ok(`${file} has no -A3 context grep`, !/grep -A3/.test(source));
}

section("a claimed panel says nothing");

{
  // Same directory, claimed for real by the HTTP request above.
  ok("the panel is claimed", secrets.hasDashboardPassword());

  const secondRun = await bootAndCapture();
  equal("no code is printed once the panel is claimed", runDocumentedCommand(secondRun), "");
  ok("and the first-run banner is gone", !/First run/.test(secondRun));
}

section("a proxied install prints it too — that is the case that needs it");

{
  // `levix domain` sets these. A proxied request can never count as local, so
  // /setup will always demand the code; the old build printed it only when
  // public_domain was empty, which made such an install unclaimable.
  const proxied = mkdtempSync(join(tmpdir(), "levix-proxied-"));
  process.env.LEVIX_DATA_DIR = proxied;

  const { execFileSync: run } = await import("node:child_process");
  run(process.execPath, [
    "-e",
    `process.env.LEVIX_DATA_DIR=${JSON.stringify(proxied)};
     const s = require(${JSON.stringify(join(ROOT, "src/config/settings.cjs"))});
     s.set("port", ${PANEL_PORT + 1});
     s.set("public_domain", "bot.example.com");
     require(${JSON.stringify(join(ROOT, "src/db/db.cjs"))}).checkpoint();`,
  ]);

  const output = await bootAndCapture({ data: proxied });
  ok("the panel advertises the domain", /Panel: https:\/\/bot\.example\.com/.test(output));
  ok(
    "and still prints the setup code",
    runDocumentedCommand(output).includes(PREFIX)
  );

  process.env.LEVIX_DATA_DIR = dataDir;
}

finish();

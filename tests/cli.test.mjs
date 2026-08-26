// The recovery commands.
//
// `where` and `reset-password` are what you reach for when the panel is the
// thing that's broken, so they have to work when almost nothing else does:
// bot stopped, port taken, WhatsApp unreachable, a setting saved as nonsense.
// They must also stay cheap — a recovery tool that boots the whole bot to
// clear a password can fail for the same reason the bot is failing.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useTempDataDir, require, ROOT, section, ok, equal, finish } from "./harness.mjs";

const dataDir = useTempDataDir("levix-cli");
const CLI = join(ROOT, "bin", "levix.js");

function levix(args, { data = dataDir, probe = false } = {}) {
  const probeOut = probe ? join(mkdtempSync(join(tmpdir(), "levix-probe-")), "modules.txt") : null;
  const result = spawnSync(
    process.execPath,
    [...(probe ? ["--require", join(ROOT, "tests", "fixtures", "probe.cjs")] : []), CLI, ...args],
    {
      encoding: "utf8",
      env: { ...process.env, LEVIX_DATA_DIR: data, ...(probeOut ? { PROBE_OUT: probeOut } : {}) },
    }
  );
  result.modules =
    probeOut && existsSync(probeOut) ? readFileSync(probeOut, "utf8").split("\n") : [];
  return result;
}

// --- the trivia, which still has to be right -----------------------------

section("basic invocations");

{
  const version = levix(["--version"]);
  equal("--version exits 0", version.status, 0);
  equal(
    "…and prints the package version",
    version.stdout.trim(),
    require("./package.json").version
  );

  const help = levix(["--help"]);
  equal("--help exits 0", help.status, 0);
  ok("…and documents where", help.stdout.includes("levix where"));
  ok("…and reset-password", help.stdout.includes("levix reset-password"));

  const bogus = levix(["frobnicate"]);
  equal("an unknown command exits non-zero", bogus.status, 1);
  ok("…and says which one", bogus.stderr.includes("frobnicate"));
}

// --- where ----------------------------------------------------------------

section("where prints the directory actually in use");

{
  const result = levix(["where"], { probe: true });
  equal("it exits 0", result.status, 0);
  equal("it prints the active data directory", result.stdout.trim(), dataDir);

  const other = mkdtempSync(join(tmpdir(), "levix-elsewhere-"));
  equal(
    "--data wins over the environment",
    levix(["--data", other, "where"], { data: dataDir }).stdout.trim(),
    other
  );

  // `where` loads almost nothing, which is the point — so prove the probe saw
  // the real run rather than an empty file, or every "did not load" check
  // below would pass for the wrong reason.
  ok(
    "the probe captured the module that resolves the directory",
    result.modules.some((path) => path.endsWith("src/config/paths.cjs")),
    `probe returned ${result.modules.length} modules`
  );

  // Cheap: no WhatsApp stack, no web server, no command files.
  const heavy = result.modules.filter((path) =>
    /node_modules\/(@whiskeysockets|baileys|express|socket\.io|ejs|node-cron|qrcode)/.test(path)
  );
  ok("it loads no WhatsApp, web or scheduling dependency", heavy.length === 0, heavy[0]);
  ok(
    "it does not even open the database",
    !result.modules.some((path) => path.endsWith("src/db/db.cjs"))
  );
  ok(
    "it does not load the command files",
    !result.modules.some((path) => path.includes("src/commands/"))
  );
}

// --- reset-password -------------------------------------------------------

section("reset-password on a real installation");

const store = require("./src/db/store.cjs");
const secrets = require("./src/config/secrets.cjs");
const settings = require("./src/config/settings.cjs");
const { checkpoint } = require("./src/db/db.cjs");

secrets.setDashboardPassword("the original password");
const sessionSecret = secrets.getSessionSecret();
store.saveGroupSettings("g1@g.us", { warnLimit: 7 });
store.authWrite("creds", '{"pretend":"whatsapp session"}');
// Something unrelated saved as nonsense: reset-password must not care.
store.saveBotSetting("setting:port", { not: "a number" });
store.saveBotSetting("setting:bot_timezone", "Not/AZone");
checkpoint();

{
  const result = levix(["reset-password"], { probe: true });

  equal("it exits 0", result.status, 0);
  ok("it says what happened", /Password cleared/i.test(result.stdout));

  // Nothing secret may reach a terminal, a log file or a CI transcript.
  const output = `${result.stdout}${result.stderr}`;
  ok("it does not print the old password", !output.includes("the original password"));
  ok("it does not print the session secret", !output.includes(sessionSecret));
  ok("it does not print a hash", !/[0-9a-f]{64}/i.test(output));

  ok(
    "the module probe recorded something to check",
    result.modules.length > 3,
    `probe returned ${result.modules.length} modules`
  );

  const heavy = result.modules.filter((path) =>
    /node_modules\/(@whiskeysockets|baileys|express|socket\.io|ejs|node-cron|fluent-ffmpeg|ffmpeg-static)/.test(
      path
    )
  );
  ok("it starts no WhatsApp, web or media dependency", heavy.length === 0, heavy[0]);
  ok(
    "it does not load the command files",
    !result.modules.some((path) => path.includes("src/commands/"))
  );
  ok(
    "it does load the database, and only that",
    result.modules.some((path) => path.endsWith("src/db/db.cjs"))
  );
}

section("it cleared the password and nothing else");

{
  // Read from a fresh process: this one's handles predate the reset.
  const after = spawnSync(
    process.execPath,
    [
      "-e",
      `
      const secrets = require(${JSON.stringify(`${ROOT}src/config/secrets.cjs`)});
      const store = require(${JSON.stringify(`${ROOT}src/db/store.cjs`)});
      process.stdout.write(JSON.stringify({
        hasPassword: secrets.hasDashboardPassword(),
        oldStillWorks: secrets.verifyDashboardPassword("the original password"),
        sessionSecret: secrets.getSessionSecret(),
        warnLimit: store.getGroupSettings("g1@g.us").warnLimit,
        creds: store.authRead("creds"),
      }));
      `,
    ],
    { env: { ...process.env, LEVIX_DATA_DIR: dataDir }, encoding: "utf8" }
  );
  const state = JSON.parse(after.stdout);

  ok("the password is gone", state.hasPassword === false);
  ok("the old one no longer verifies", state.oldStillWorks === false);
  equal("the session secret is untouched", state.sessionSecret, sessionSecret);
  equal("group settings are untouched", state.warnLimit, 7);
  equal("the WhatsApp session is untouched", state.creds, '{"pretend":"whatsapp session"}');
}

section("it is safe to repeat, and safe on a fresh directory");

{
  equal("running it twice is fine", levix(["reset-password"]).status, 0);

  const empty = mkdtempSync(join(tmpdir(), "levix-empty-"));
  const result = levix(["reset-password"], { data: empty });
  equal("running it on a never-started install is fine", result.status, 0);
  ok("…and it creates the data directory", statSync(empty).isDirectory());
}

section("the panel accepts a new password afterwards");

{
  const { startServer } = await import("./harness.mjs");
  const { httpClient } = await import("./harness.mjs");
  const server = await startServer({ dataDir, trust: "" });
  try {
    const http = httpClient(server.base);
    const page = await http.call("/setup");
    equal("setup is open again", page.status, 200);
    const claim = await http.form("/setup", {
      password: "a-brand-new-password",
      confirm: "a-brand-new-password",
    });
    equal("a new password can be set", claim.status, 303);
    const login = httpClient(server.base);
    equal(
      "…and it logs in",
      (await login.form("/login", { password: "a-brand-new-password" })).status,
      303
    );
  } finally {
    server.stop();
  }
}

// --- the Node version gate ------------------------------------------------

section("an unsupported Node version fails with a sentence, not a stack");

{
  const fake = spawnSync(
    process.execPath,
    [
      "-e",
      `
      Object.defineProperty(process.versions, "node", { value: "20.11.0", configurable: true });
      import(${JSON.stringify(CLI)});
      `,
    ],
    { encoding: "utf8", env: { ...process.env, LEVIX_DATA_DIR: dataDir } }
  );

  equal("it exits non-zero", fake.status, 1);
  const output = `${fake.stdout}${fake.stderr}`;
  ok("it names the required version", output.includes("Node 24"));
  ok("it names the version found", output.includes("20.11.0"));
  ok("it says where to get one", output.includes("nodejs.org"));
  ok("and prints no stack trace", !output.includes("    at "));
}

finish();

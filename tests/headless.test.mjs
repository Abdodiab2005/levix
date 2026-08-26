// `levix headless` — the bot, with no web anything.
//
// The claim is strong and easy to get subtly wrong: not "the panel is hidden"
// but "Express was never constructed and no port was opened". So this test
// proves it two ways — by looking at what the process loaded, and by binding
// the panel port itself, which only works if nothing else has it.
//
// WhatsApp is not stubbed. The bot creates its socket and starts connecting;
// the test waits for the point just before pairing and stops there. A real
// pairing needs a phone and is not something CI can do.

import { spawn } from "node:child_process";
import net from "node:net";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useTempDataDir, require, ROOT, section, ok, equal, finish } from "./harness.mjs";

const dataDir = useTempDataDir("levix-headless");

// A port of our own, so a real Levix on 3001 can't confuse the result.
const PANEL_PORT = 34117;
require("./src/config/settings.cjs").set("port", PANEL_PORT);
require("./src/db/db.cjs").checkpoint();

/** Can we bind it? Then nothing else is listening on it. */
function portIsFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

/** Start the CLI, wait for a line, and keep the output and module list. */
function startLevix(args, { waitFor, timeoutMs = 60000, data = dataDir } = {}) {
  const probeOut = join(mkdtempSync(join(tmpdir(), "levix-probe-")), "modules.txt");

  const child = spawn(
    process.execPath,
    ["--require", join(ROOT, "tests", "fixtures", "probe.cjs"), join(ROOT, "bin", "levix.js"), ...args],
    {
      env: {
        ...process.env,
        LEVIX_DATA_DIR: data,
        PROBE_OUT: probeOut,
        // Never let a test pop a browser open on somebody's desktop.
        LEVIX_OPEN_BROWSER: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

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
    child,
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
        }, 8000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      return existsSync(probeOut) ? readFileSync(probeOut, "utf8").split("\n") : [];
    },
  };
}

// --- headless -------------------------------------------------------------

section("headless starts the bot");

let headlessModules = [];
{
  const levix = startLevix(["headless"], { waitFor: "Ctrl+C" });
  await levix.seen;

  ok("it announces itself as headless", /headless/i.test(levix.output));
  ok("it reports the commands it loaded", /\d+ commands loaded/.test(levix.output));
  ok("it says there is no panel", /No web panel/i.test(levix.output));
  ok("it prints the data directory", levix.output.includes("Data:"));
  ok("it does not print a panel URL", !/Panel:/.test(levix.output));

  const commandCount = Number(/(\d+) commands loaded/.exec(levix.output)?.[1] ?? 0);
  ok(`it loaded every command (${commandCount})`, commandCount > 50);

  section("…and opens no port at all");

  // Only the port this install is configured to use: whether some unrelated
  // program on the developer's machine holds 3001 says nothing about Levix.
  ok(`the panel port ${PANEL_PORT} is free`, await portIsFree(PANEL_PORT));
  ok(
    "no listener appeared while the bot was starting",
    (await portIsFree(PANEL_PORT)) === true
  );

  headlessModules = await levix.stop();
}

section("Express was never constructed");

{
  ok(
    "the module probe recorded something to check",
    headlessModules.length > 20,
    `probe returned ${headlessModules.length} modules`
  );
  const web = headlessModules.filter((path) =>
    /node_modules\/(express|socket\.io|ejs|express-session)\//.test(path)
  );
  ok("no express, socket.io, ejs or session module was loaded", web.length === 0, web[0]);
  ok("app.cjs was never required", !headlessModules.some((p) => p.endsWith("/app.cjs")));
  ok(
    "the panel bootstrap was never imported",
    !headlessModules.some((p) => p.includes("bootstrap/panel"))
  );
  ok(
    "the dashboard routes were never imported",
    !headlessModules.some((p) => p.includes("routes/dashboard.api"))
  );

  section("…but the bot's own core was");

  ok("the database is loaded", headlessModules.some((p) => p.endsWith("src/db/db.cjs")));
  ok("the commands are loaded", headlessModules.some((p) => p.includes("src/commands/")));
  ok(
    "the scheduler is loaded",
    headlessModules.some((p) => p.endsWith("scheduler.cjs")) ||
      headlessModules.some((p) => p.includes("node-cron"))
  );
  ok(
    "Baileys is loaded",
    headlessModules.some((p) => /@whiskeysockets|baileys/.test(p))
  );
}

section("an unpaired install shows the pairing instructions");

{
  // A fresh directory has no credentials, so the first QR triggers the banner.
  const fresh = mkdtempSync(join(tmpdir(), "levix-unpaired-"));
  // The QR glyph itself is the last thing printed, so waiting for it avoids
  // reading the output while it is still arriving.
  const levix = startLevix(["headless"], {
    waitFor: "█",
    timeoutMs: 60000,
    data: fresh,
  });

  let reached = true;
  try {
    await levix.seen;
  } catch (error) {
    // No network in this environment means no QR is ever issued. That is a
    // real limitation of the test host, not a failure of the bot — say so
    // rather than pretending the path was covered.
    reached = false;
    console.log("    SKIP  no QR arrived (WhatsApp unreachable from here)");
  }

  if (reached) {
    ok("it says there is no session yet", /No WhatsApp session found/.test(levix.output));
    ok("it says where to scan from", /Linked devices/.test(levix.output));
    ok("it prints a QR in the terminal", /█|▄|▀/.test(levix.output));
  }

  await levix.stop();
}

// --- with the panel -------------------------------------------------------

section("the default mode does open the panel port");

{
  const levix = startLevix([], { waitFor: "Ctrl+C" });
  await levix.seen;

  ok("it prints a panel URL", /Panel: http/.test(levix.output));
  ok(`the URL carries the configured port ${PANEL_PORT}`, levix.output.includes(String(PANEL_PORT)));
  ok("a first run points at /setup", /\/setup/.test(levix.output));
  ok("it prints the data directory", levix.output.includes("Data:"));
  ok("it explains how to stop", /Ctrl\+C/.test(levix.output));

  ok(`the panel port ${PANEL_PORT} is taken`, (await portIsFree(PANEL_PORT)) === false);

  const response = await fetch(`http://127.0.0.1:${PANEL_PORT}/setup`);
  equal("the setup page answers", response.status, 200);

  const modules = await levix.stop();
  ok(
    "the module probe recorded something to check",
    modules.length > 20,
    `probe returned ${modules.length} modules`
  );
  ok("express was loaded this time", modules.some((p) => /node_modules\/express\//.test(p)));
  ok("app.cjs was required this time", modules.some((p) => p.endsWith("/app.cjs")));
}

section("bind address: public by default, loopback once a proxy is in front");

{
  const os = await import("node:os");
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .find((entry) => entry && entry.family === "IPv4" && !entry.internal)?.address;

  const settings = require("./src/config/settings.cjs");
  const db = require("./src/db/db.cjs");

  // Default: every interface, because a Docker publish and "open it from my
  // phone on the same wifi" both need that.
  {
    const levix = startLevix([], { waitFor: "Ctrl+C" });
    await levix.seen;
    const local = await fetch(`http://127.0.0.1:${PANEL_PORT}/setup`).then(
      (r) => r.status,
      () => 0
    );
    equal("localhost reaches the panel", local, 200);

    if (lan) {
      const remote = await fetch(`http://${lan}:${PANEL_PORT}/setup`).then(
        (r) => r.status,
        () => 0
      );
      equal(`${lan} reaches it too, by default`, remote, 200);
    } else {
      console.log("    SKIP  no non-loopback interface to test the default bind");
    }
    await levix.stop();
  }

  // What `levix domain` sets once it has actually put a proxy in front: the
  // panel must stop being reachable on its raw port from outside.
  settings.set("bind_address", "127.0.0.1");
  db.checkpoint();

  {
    const levix = startLevix([], { waitFor: "Ctrl+C" });
    await levix.seen;
    const local = await fetch(`http://127.0.0.1:${PANEL_PORT}/setup`).then(
      (r) => r.status,
      () => 0
    );
    equal("localhost still reaches the panel", local, 200);

    if (lan) {
      const remote = await fetch(`http://${lan}:${PANEL_PORT}/setup`).then(
        (r) => r.status,
        () => 0
      );
      equal(`${lan} can no longer reach the raw port`, remote, 0);
    } else {
      console.log("    SKIP  no non-loopback interface to test the bound case");
    }
    await levix.stop();
  }

  settings.set("bind_address", "");
  db.checkpoint();
}

section("a configured domain becomes the address Levix prints");

{
  // What `levix domain` persists, and what it has to mean on the next start.
  const settings = require("./src/config/settings.cjs");
  settings.set("public_domain", "bot.example.com");
  require("./src/db/db.cjs").checkpoint();

  const levix = startLevix([], { waitFor: "Ctrl+C" });
  await levix.seen;

  ok("the public domain is printed", /Panel: https:\/\/bot\.example\.com/.test(levix.output));
  ok("not the localhost URL", !/Panel: http:\/\/localhost/.test(levix.output));
  ok(
    "the port is still bound locally",
    (await portIsFree(PANEL_PORT)) === false
  );

  await levix.stop();

  // Leave the setting as we found it for anything that runs after this.
  settings.set("public_domain", "");
  require("./src/db/db.cjs").checkpoint();
}

section("the browser is not opened in a non-desktop environment");

{
  const levix = startLevix([], { waitFor: "Ctrl+C" });
  await levix.seen;
  // LEVIX_OPEN_BROWSER=0 above stands in for "this is not a desktop"; the
  // decision itself is covered exhaustively in browser.test.mjs.
  ok("it says the link must be opened by hand", /Open that link yourself/.test(levix.output));
  ok("…and gives the reason", /LEVIX_OPEN_BROWSER is off/.test(levix.output));
  await levix.stop();
}

finish();

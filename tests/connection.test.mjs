// Panel mode never dials WhatsApp on its own.
//
// The state machine itself is covered without a network in session.test.mjs.
// This file boots the REAL `levix` process against a real database and a real
// control panel, and checks the two claims that only an end-to-end run can
// make honestly:
//
//   * starting Levix creates no Baileys socket, and the dashboard works anyway
//   * pressing Start once — or three times at once — creates exactly one
//
// It stops at the pairing boundary. Whether the QR is accepted needs a phone.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
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

const dataDir = useTempDataDir("levix-connection");

const PANEL_PORT = 34119;
require("./src/config/settings.cjs").set("port", PANEL_PORT);
require("./src/db/db.cjs").checkpoint();

// The line src/core/socket.js logs the moment a Baileys socket is constructed.
// Counting it is the most direct evidence there is of "how many sockets".
const SOCKET_MARKER = "Initializing WhatsApp socket";

function startLevix({ waitFor = "Ctrl+C", timeoutMs = 60000 } = {}) {
  const child = spawn(process.execPath, [join(ROOT, "bin", "levix.js")], {
    env: {
      ...process.env,
      LEVIX_DATA_DIR: dataDir,
      LEVIX_OPEN_BROWSER: "0",
    },
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
    child,
    seen,
    get output() {
      return output;
    },
    async waitForOutput(needle, ms = 15000) {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (output.includes(needle)) return true;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return false;
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
    },
  };
}

const count = (haystack, needle) => haystack.split(needle).length - 1;

const levix = startLevix();
const http = httpClient(`http://127.0.0.1:${PANEL_PORT}`);

try {
  await levix.seen;

  section("starting Levix does not start WhatsApp");

  equal("no Baileys socket was created", count(levix.output, SOCKET_MARKER), 0);
  ok("the terminal says how to connect", /press Start session/i.test(levix.output));
  ok("the panel URL is printed anyway", /Panel: http/.test(levix.output));

  section("the dashboard works while WhatsApp is idle");

  let res = await http.call("/setup");
  equal("the setup page answers with no WhatsApp session", res.status, 200);

  res = await http.form("/setup", {
    password: "a-good-password",
    confirm: "a-good-password",
  });
  equal("the panel can be claimed", res.status, 303);

  const stats = await (await http.call("/dashboard/api/stats")).json();
  ok("stats answer", stats.success);
  equal("the session is idle", stats.stats.connection.state, "idle");
  equal("nothing claims to be connected", stats.stats.isConnected, false);
  ok("every command is loaded regardless", stats.stats.commandCount > 30);

  const health = await (await http.call("/dashboard/api/health")).json();
  equal("Levix reports itself healthy while unlinked", health.health.status, "healthy");
  equal("…and honest about WhatsApp", health.health.bot, "disconnected");

  let session = await (await http.call("/dashboard/api/bot/session")).json();
  equal("the session route agrees", session.session.state, "idle");
  ok("it offers a Start", session.session.canStart);
  ok("there is nothing to stop", !session.session.canStop);
  equal("and no QR to show", session.qr, null);

  section("Start creates exactly one socket, even from three clicks at once");

  const [a, b, c] = await Promise.all([
    http.call("/dashboard/api/bot/session/start", { method: "POST" }),
    http.call("/dashboard/api/bot/session/start", { method: "POST" }),
    http.call("/dashboard/api/bot/session/start", { method: "POST" }),
  ]);
  ok("all three are accepted", [a, b, c].every((r) => r.status === 200));

  ok("a socket was created", await levix.waitForOutput(SOCKET_MARKER));
  equal("exactly one", count(levix.output, SOCKET_MARKER), 1);

  session = await (await http.call("/dashboard/api/bot/session")).json();
  ok(
    `the session left idle (${session.session.state})`,
    session.session.state !== "idle"
  );

  section("Stop puts it back, and does not take the panel with it");

  res = await http.call("/dashboard/api/bot/session/stop", { method: "POST" });
  equal("stop is accepted", res.status, 200);

  session = await (await http.call("/dashboard/api/bot/session")).json();
  equal("the session is idle again", session.session.state, "idle");
  ok("and startable", session.session.canStart);

  equal(
    "the panel is still answering",
    (await http.call("/dashboard/api/stats")).status,
    200
  );

  section("unlink does not need a live connection");

  {
    // Deliberately changed: it used to require a connected socket, which meant
    // a pairing WhatsApp had refused (403, 405) left dead credentials that
    // could never be cleared from the panel. The only state with nothing to
    // unlink is the one that has just been unlinked.
    res = await http.call("/dashboard/api/bot/logout", { method: "POST" });
    equal("unlinking a stopped session works", res.status, 200);

    session = await (await http.call("/dashboard/api/bot/session")).json();
    equal("the session says so", session.session.state, "logged_out");
    ok("…and offers a fresh start", session.session.canStart);
    ok("…with nothing left to unlink", !session.session.canUnlink);

    res = await http.call("/dashboard/api/bot/logout", { method: "POST" });
    equal("unlinking again is a 409", res.status, 409);
  }

  section("the browsers watching cannot steer any of this");

  {
    // A structural check, not a behavioural one: if the panel ever grows an
    // inbound socket.io handler, the guarantee that a browser cannot influence
    // the WhatsApp lifecycle stops being provable by reading one file.
    const appSource = readFileSync(join(ROOT, "app.cjs"), "utf8");
    const panelSource = readFileSync(join(ROOT, "src", "bootstrap", "panel.js"), "utf8");

    ok("the panel registers no io.on('connection')", !/io\.on\(/.test(appSource));
    ok("…and listens for nothing a browser sends", !/socket\.on\(/.test(appSource));
    ok(
      "the only bridge is one-way: hub -> io.emit",
      /attach\(\(event, payload\) => io\.emit\(event, payload\)\)/.test(panelSource)
    );

    const sessionSource = readFileSync(join(ROOT, "src", "core", "session.js"), "utf8");
    ok(
      "the session never imports socket.io or express",
      !/socket\.io|express/.test(sessionSource)
    );
    ok(
      "retry exhaustion does not kill the process",
      !/process\.exit/.test(sessionSource)
    );
  }
  section("restart really stops the process, and cleanly");

  {
    // /bot/restart signals itself rather than calling process.exit, so the
    // shutdown path runs: timers cancelled, socket closed, store flushed,
    // database closed. It has to actually finish — a "restart" that hangs until
    // the 10s hard exit is a restart that looks broken.
    const exited = new Promise((resolve) => levix.child.once("exit", (code) => resolve(code)));
    res = await http.call("/dashboard/api/bot/restart", { method: "POST" });
    equal("restart is accepted", res.status, 200);

    const code = await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 9000)),
    ]);
    ok(`it stopped promptly (exit ${code})`, code !== "timeout");
    equal("…with a clean exit code", code, 0);
    ok("the shutdown path ran", /\[shutdown\]/.test(levix.output));
  }
  section("a pairing code from a dead process is never served");

  {
    // A crash (SIGKILL, an OOM, a pulled plug) leaves the qr_codes row behind.
    // GET /qr reads that table directly, so a boot that did not clear it would
    // hand somebody a code nobody can scan. Runs last, after the restart above
    // has stopped the first process — the data directory takes one Levix.
    const store = require("./src/db/store.cjs");
    store.saveQrCode("QR-FROM-A-KILLED-PROCESS");
    require("./src/db/db.cjs").checkpoint();
    equal("the stale code is really there", store.getQrCode(), "QR-FROM-A-KILLED-PROCESS");

    const reborn = startLevix();
    try {
      await reborn.seen;
      equal("a fresh boot drops it", store.getQrCode(), null);
    } finally {
      await reborn.stop();
    }
  }
} finally {
  await levix.stop();
}

section("…and it shut down cleanly");

ok("no unhandled rejection on the way out", !/Unhandled Rejection/.test(levix.output));
ok("no uncaught exception either", !/Uncaught Exception/.test(levix.output));

finish();

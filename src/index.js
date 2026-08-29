// Starting Levix.
//
// Two shapes, one core:
//
//   levix            bootstrapCore() + bootstrapPanel(), then maybe a browser
//   levix headless   bootstrapCore({ autoStart: true }) — nothing binds a port
//
// The difference is which bootstrap runs, not a flag threaded through the
// codebase. See src/bootstrap/.
//
// WhatsApp is not dialled by starting the process. In panel mode the session
// sits idle until somebody presses Start on the Connection screen, so a fresh
// install can be configured before it ever tries to pair. Headless has no
// screen and nobody to press anything, so it asks the core to connect for it.

import os from "node:os";
import { createRequire } from "module";
import { bootstrapCore } from "./bootstrap/core.js";
import { flushStore } from "./db/store.esm.js";
import brand from "./config/brand.esm.js";

const require = createRequire(import.meta.url);
const qrcodeTerminal = require("qrcode-terminal");
const logger = require("./utils/logger.cjs");
const secrets = require("./config/secrets.cjs");
const { DATA_DIR } = require("./config/paths.cjs");
const { release: releaseLock } = require("./config/lock.cjs");
const { close: closeDatabase } = require("./db/db.cjs");
const { attach } = require("./bootstrap/events.cjs");
const { openBrowser } = require("./utils/openBrowser.cjs");

const line = (text = "") => console.log(text);

/** `/home/abdo/.levix` reads better as `~/.levix`. */
function short(path) {
  const home = os.homedir();
  return home && path.startsWith(home) ? path.replace(home, "~") : path;
}

// The session manager, so the shutdown handler can cancel its timers. Set as
// soon as the core is up.
let liveSession = null;

/**
 * Start Levix.
 *
 * @param {object} [options]
 * @param {boolean} [options.headless] - run the bot with no web panel at all
 * @param {boolean} [options.open] - open a browser when the environment suits it
 */
export async function start({ headless = false, open = true } = {}) {
  logger.info(`Starting ${brand.name} — ${brand.tagline}`);
  logger.info(`[Data] ${DATA_DIR}`);

  installShutdownHandlers();

  return headless ? startHeadless() : startWithPanel({ open });
}

/**
 * Print the QR in the terminal.
 *
 * A QR belongs there in both modes: the panel shows one too, but somebody on an
 * SSH session has no browser to show it in. This used to live inside the
 * connection handler, which meant src/core had to know a human might be
 * watching. Attached after whatever else the mode wants to say about a QR, so
 * the explanation comes before the block of glyphs rather than after it.
 */
function attachTerminalQr() {
  attach((event, payload) => {
    if (event === "qr" && typeof payload === "string") {
      qrcodeTerminal.generate(payload, { small: true });
    }
  });
}

// ---------------------------------------------------------------------------
// headless
// ---------------------------------------------------------------------------

/**
 * What headless does when the session reaches a state that needs a person.
 *
 * The panel answers this with a Start button. Headless has no button, no stdin
 * and no UI, so a bot sitting in `disconnected` or `retry_exhausted` there is
 * not "still running" in any useful sense — it is a silent process that will
 * never answer another message. Handing the decision to the supervisor is the
 * honest ending: systemd, pm2 and Docker all bring it back, and a genuinely
 * persistent refusal trips their own restart limits and surfaces as a failed
 * unit rather than as a bot that quietly stopped working.
 *
 * Panel mode never calls this. There, Levix stays up by design.
 */
const HEADLESS_GRACE_MS = 5000;

function surrender(state) {
  line();
  line("  No panel here to start it again — stopping so the supervisor can.");
  line("  (systemd / pm2 / docker restart it; without one, run levix again.)");
  line();
  logger.error(`[headless] session ended in ${state} — exiting for the supervisor`);
  // Not unref'd: in a terminal state nothing else is holding the loop open, so
  // an unref'd timer would let the process fall out with code 0 before this
  // ever ran — the same restart, but with no signal that anything went wrong.
  setTimeout(() => process.exit(1), HEADLESS_GRACE_MS);
}

async function startHeadless() {
  line();
  line(`  ${brand.name} — headless`);

  // Attached before the bot starts, because the QR can arrive during the very
  // first connection attempt.
  //
  // Headless has no Connection screen, so the terminal has to say what the
  // panel would have shown — including the states that need a person, where
  // "restart it" is the only instruction that exists here.
  let announcedPairing = false;
  let lastState = null;
  attach((event, payload) => {
    if (event === "qr" && !announcedPairing) {
      announcedPairing = true;
      line();
      line("  No WhatsApp session found.");
      line();
      line("  Scan this QR from:");
      line("  WhatsApp -> Linked devices -> Link a device");
      line();
    }

    if (event !== "session" || payload?.state === lastState) return;
    lastState = payload.state;

    switch (payload.state) {
      case "connected":
        line();
        line("  ✓ WhatsApp connected");
        break;
      case "reconnecting":
        line(`  … WhatsApp disconnected, reconnecting (attempt ${payload.attempt}/${payload.maxAttempts})`);
        break;
      case "logged_out":
      case "retry_exhausted":
      case "disconnected":
      case "error":
        line();
        line(`  ✗ WhatsApp is not connected${payload.detail ? ` — ${payload.detail}` : ""}`);
        surrender(payload.state);
        break;
      default:
        break;
    }
  });

  attachTerminalQr();

  // Headless has no Start button, so it starts itself.
  const core = await bootstrapCore({ autoStart: true });
  liveSession = core.session;

  if (announcedPairing) line("  Waiting for connection...");

  line();
  line("  ✓ Levix is ready");
  line();
  line(`  ${core.commandCount} commands loaded`);
  line(`  Data: ${short(DATA_DIR)}`);
  line();
  line("  No web panel in this mode. Press Ctrl+C to stop.");
  line();

  return core;
}

// ---------------------------------------------------------------------------
// with the panel
// ---------------------------------------------------------------------------

async function startWithPanel({ open }) {
  const { bootstrapPanel, panelUrl } = await import("./bootstrap/panel.js");

  attachTerminalQr();

  // Nothing dials WhatsApp here. The panel comes up against an idle session and
  // the Connection screen offers a Start button.
  const core = await bootstrapCore({ autoStart: false });
  liveSession = core.session;

  let panel;
  try {
    panel = await bootstrapPanel({ core });
  } catch (error) {
    if (error.code === "EADDRINUSE") {
      console.error(`\n  ${error.message}\n`);
      logger.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const firstRun = !secrets.hasDashboardPassword();
  const url = panelUrl({ port: panel.port, firstRun });

  logger.info(`✅ Control panel: ${url}`);

  line();
  line(`  ${brand.name} is running`);
  line();
  line(`  Panel: ${url}`);
  line(`  Data:  ${short(DATA_DIR)}`);

  // Only while the panel is unclaimed, and only once per process. Printed on
  // every deployment shape, including one behind a domain: a proxied request
  // can never count as local, so that is precisely the case that needs it.
  if (firstRun) {
    line();
    line("  First run — that link asks you to pick a password.");
    line("  Opening it from another machine also needs this code:");
    line();
    line(`  ${secrets.formatSetupCodeLine()}`);
  }

  if (open) {
    const { opened, reason } = openBrowser(url);
    line();
    line(
      opened
        ? `  Opening ${brand.name} in your browser...`
        : `  Open that link yourself (${reason}).`
    );
  }

  line();
  line("  Not linked to WhatsApp yet? Open the panel, go to Connection and");
  line("  press Start session.");
  line();
  line("  Press Ctrl+C to stop.");
  line();

  return { ...core, panel, url };
}

// ---------------------------------------------------------------------------
// living and dying
// ---------------------------------------------------------------------------

function installShutdownHandlers() {
  // After an uncaughtException the process state is unknown (a half-held lock,
  // a half-written auth row). Log and exit rather than keep working on top of
  // it. Run the bot under a supervisor (systemd / pm2 / docker restart) so it
  // comes back on its own — without one, this exit means the bot is down.
  const fatal = (error, label) => {
    logger.error(error, `${label} exiting — restart is up to the supervisor`);
    console.error(label, error);
    // Half a second so pino can drain its worker before we die.
    setTimeout(() => process.exit(1), 500).unref();
  };

  process.on("uncaughtException", (error) => fatal(error, "Uncaught Exception:"));
  process.on("unhandledRejection", (error) => fatal(error, "Unhandled Rejection:"));

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`[shutdown] ${signal} received, closing down...`);

    // Armed first, not last: everything below is awaited, and a socket close or
    // a request that refuses to end would otherwise mean the watchdog is never
    // reached at all. Not unref'd, for the same reason — this timer exists
    // precisely for the case where nothing else is going to wake the loop.
    const watchdog = setTimeout(() => {
      logger.error("[shutdown] took too long — exiting anyway");
      process.exit(1);
    }, 10_000);

    // Before anything else: no reconnect may fire while we are going down, and
    // a pending retry timer must not outlive the process it was scheduled in.
    if (liveSession) {
      try {
        await liveSession.shutdown();
      } catch (error) {
        logger.warn({ err: error }, "[shutdown] closing the WhatsApp session failed");
      }
    }

    const finish = async () => {
      await Promise.allSettled([flushStore()]);
      closeDatabase();
      releaseLock();
      clearTimeout(watchdog);
      process.exit(0);
    };

    // The panel may not exist at all (headless), and if it does it may not be
    // listening yet. Reaching into the module cache rather than requiring it
    // keeps this from constructing an Express app during shutdown.
    let server = null;
    let io = null;
    try {
      const cached = require.cache[require.resolve("../app.cjs")];
      server = cached?.exports?.server ?? null;
      io = cached?.exports?.io ?? null;
    } catch {}

    // server.close() waits for every open connection, and a dashboard sitting
    // on a socket.io websocket is an open connection that never ends by itself
    // — so without this the shutdown ran to the 10s hard exit every time a tab
    // was open, which is exactly what the panel's own Restart button does.
    try {
      io?.disconnectSockets(true);
      server?.closeIdleConnections?.();
    } catch (error) {
      logger.debug({ err: error?.message }, "[shutdown] closing panel connections failed");
    }

    if (server?.listening) server.close(finish);
    else await finish();
  };

  ["SIGTERM", "SIGINT"].forEach((signal) => process.on(signal, () => shutdown(signal)));
}

export default start;

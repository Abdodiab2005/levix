// Starting Levix.
//
// Two shapes, one core:
//
//   levix            bootstrapCore() + bootstrapPanel(), then maybe a browser
//   levix headless   bootstrapCore() only — nothing binds a port
//
// The difference is which bootstrap runs, not a flag threaded through the
// codebase. See src/bootstrap/.

import os from "node:os";
import { createRequire } from "module";
import { bootstrapCore } from "./bootstrap/core.js";
import { flushStore } from "./db/store.esm.js";
import brand from "./config/brand.esm.js";

const require = createRequire(import.meta.url);
const logger = require("./utils/logger.cjs");
const secrets = require("./config/secrets.cjs");
const settings = require("./config/settings.cjs");
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

// ---------------------------------------------------------------------------
// headless
// ---------------------------------------------------------------------------

async function startHeadless() {
  line();
  line(`  ${brand.name} — headless`);

  // Attached before the bot starts, because the QR can arrive during the very
  // first connection attempt.
  let announcedPairing = false;
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
    if (event === "status_update" && payload?.status === "Connected") {
      line();
      line("  ✓ WhatsApp connected");
    }
    if (event === "status_update" && payload?.status === "Disconnected") {
      line("  … WhatsApp disconnected, reconnecting");
    }
  });

  const core = await bootstrapCore();

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

  let setBotInstance = null;
  let setBotControls = null;

  // The panel needs the live socket, and a reconnect replaces it. Passing the
  // callback into the core keeps that true without the core knowing what a
  // panel is.
  const core = await bootstrapCore({
    onSocket(sock, controls) {
      if (setBotInstance) setBotInstance(sock);
      if (setBotControls) setBotControls({ clearAll: controls.clearAll });
    },
  });

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

  ({ setBotInstance, setBotControls } = panel);
  setBotInstance(core.sock);

  const firstRun = !secrets.hasDashboardPassword();
  const url = panelUrl({ port: panel.port, firstRun });

  logger.info(`✅ Control panel: ${url}`);

  line();
  line(`  ${brand.name} is running`);
  line();
  line(`  Panel: ${url}`);
  line(`  Data:  ${short(DATA_DIR)}`);

  if (firstRun && !settings.get("public_domain")) {
    line();
    line("  First run — that link asks you to pick a password.");
    line(`  Opening it from another machine also needs this code: ${secrets.getSetupCode()}`);
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

    const finish = async () => {
      await Promise.allSettled([flushStore()]);
      closeDatabase();
      releaseLock();
      process.exit(0);
    };

    // The panel may not exist at all (headless), and if it does it may not be
    // listening yet. Reaching into the module cache rather than requiring it
    // keeps this from constructing an Express app during shutdown.
    let server = null;
    try {
      const cached = require.cache[require.resolve("../app.cjs")];
      server = cached?.exports?.server ?? null;
    } catch {}

    if (server?.listening) server.close(finish);
    else await finish();

    // Don't wait forever on a request that refuses to end.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  ["SIGTERM", "SIGINT"].forEach((signal) => process.on(signal, () => shutdown(signal)));
}

export default start;

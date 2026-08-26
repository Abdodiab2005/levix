// The web control panel: Express, sessions, EJS, socket.io, the routes.
//
// Loaded only when the panel is wanted. `levix headless` never imports this
// file, so none of it is ever constructed — no app, no server, no socket.io
// namespace, and nothing bound to a port.

import { createRequire } from "module";

const require = createRequire(import.meta.url);
const logger = require("../utils/logger.cjs");
const settings = require("../config/settings.cjs");
const { attach } = require("./events.cjs");

/**
 * Start the panel and bind its port.
 *
 * @param {object} options
 * @param {object} options.core - what bootstrapCore() returned
 * @returns {Promise<{ port: number, host: string, server: object }>}
 */
export async function bootstrapPanel({ core } = {}) {
  // Required here, not at the top of the module: requiring app.cjs constructs
  // the Express app and the socket.io server, and headless mode must not.
  const {
    app,
    server,
    io,
    dashboardJson,
    requireLoginApi,
    noStore,
    installFinalHandlers,
  } = require("../../app.cjs");

  const { default: dashboardApiRoutes, setBotInstance, setBotControls } =
    await import("../routes/dashboard.api.esm.js");

  // Same session as the control panel: these routes hand back groups, debts
  // and warnings with people's numbers in them.
  app.use("/dashboard/api", requireLoginApi, noStore, dashboardJson, dashboardApiRoutes);
  logger.info("Dashboard API routes registered");

  // Everything the bot reports goes out to the browsers watching the panel.
  attach((event, payload) => io.emit(event, payload));

  if (core?.sock) {
    setBotInstance(core.sock);
    setBotControls({ clearAll: core.clearAll });
  }

  // After every route is registered — the 404 and the error handler have to be
  // last, or they swallow what comes after them.
  installFinalHandlers();

  const port = settings.get("port");
  const host = resolveBindAddress();

  await new Promise((resolve, reject) => {
    // "EADDRINUSE" plus a stack trace is not an answer anyone can act on, and
    // the overwhelmingly likely cause is a second copy of the bot.
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE") {
        const friendly = new Error(
          `Port ${port} is already taken.\n\n` +
            `  Levix is probably already running — open http://localhost:${port}/ and\n` +
            `  check. If something else owns the port, change it in the control panel\n` +
            `  under Settings -> Server, or start with a different one.`
        );
        friendly.code = "EADDRINUSE";
        return reject(friendly);
      }
      reject(error);
    });
    server.listen(port, host, resolve);
  });

  return { port, host, server, setBotInstance, setBotControls };
}

/**
 * Which address the panel binds to.
 *
 * The default is every interface, because that is what a Docker publish and a
 * "open it from my phone on the same wifi" both need. Once `levix domain` has
 * actually put a reverse proxy in front, it sets this to 127.0.0.1 so nobody
 * can reach the panel by its raw port and skip the TLS in front of it.
 */
export function resolveBindAddress() {
  const configured = settings.get("bind_address");
  return configured || "0.0.0.0";
}

/** The address a person should type, given how this install is reachable. */
export function panelUrl({ port, firstRun = false } = {}) {
  const domain = settings.get("public_domain");
  const base = domain ? `https://${domain}` : `http://localhost:${port}`;
  return firstRun ? `${base}/setup` : base;
}

// Everything Levix needs to be a WhatsApp bot.
//
// Database, settings, commands, the WhatsApp socket, the scheduler. No HTTP,
// no Express, no socket.io — those live in bootstrap/panel.js and are entirely
// optional. `levix headless` runs this file and nothing else, which is what
// makes "no panel port is opened" a fact rather than a promise.

import { createRequire } from "module";
import { createWhatsAppSocket } from "../core/socket.js";
import { setupEventListeners } from "../core/events.js";
import { loadCommands, getLoadedCommands } from "../handlers/command.handler.js";
import { initStore } from "../db/store.esm.js";

const require = createRequire(import.meta.url);
const logger = require("../utils/logger.cjs");
const { sink } = require("./events.cjs");
const { acquireSingleInstanceLock } = require("../config/lock.cjs");
const { ensureDataDir } = require("../config/paths.cjs");
const store = require("../db/store.cjs");
const { initializeScheduledJobs } = require("../../scheduler.cjs");

/**
 * Start the bot.
 *
 * @param {object} [options]
 * @param {(sock: object, controls: object) => void} [options.onSocket]
 *   Called with every socket, including the ones a reconnect produces — the
 *   panel uses it to keep its "unlink" button pointed at the live connection.
 * @returns {Promise<{ sock: object, commandCount: number, wasPaired: boolean }>}
 */
export async function bootstrapCore({ onSocket } = {}) {
  // Claim the data directory before anything touches the WhatsApp session. A
  // second copy has to fail here, not after it has written to the auth rows
  // the first one is using.
  acquireSingleInstanceLock();

  // Temp media the commands write while answering lives with the rest of the
  // bot's state, not next to the code.
  ensureDataDir("media");

  // Whether this install has ever been paired decides what the terminal says
  // next, so read it before the socket has a chance to create credentials.
  const wasPaired = store.hasCredentials();

  await initStore();
  await loadCommands();

  const sock = await connect({ onSocket });

  return { sock, commandCount: getLoadedCommands().size, wasPaired };
}

async function connect({ onSocket, isReconnect = false } = {}) {
  const { sock, saveCreds, clearAll } = await createWhatsAppSocket();

  setupEventListeners(
    sock,
    saveCreds,
    clearAll,
    // The bot reports into the hub; whoever is listening decides what that
    // means — a socket.io broadcast, a line in the terminal, or nothing.
    sink,
    initializeScheduledJobs,
    async () => {
      logger.info("[Reconnect] Attempting to reconnect to WhatsApp...");
      await connect({ onSocket, isReconnect: true });
    }
  );

  if (onSocket) onSocket(sock, { clearAll, isReconnect });

  logger.info("WhatsApp socket initialized successfully");
  return sock;
}

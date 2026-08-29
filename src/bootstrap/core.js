// Everything Levix needs to be a WhatsApp bot.
//
// Database, settings, commands, the WhatsApp session manager, the scheduler.
// No HTTP, no Express, no socket.io — those live in bootstrap/panel.js and are
// entirely optional. `levix headless` runs this file and nothing else, which is
// what makes "no panel port is opened" a fact rather than a promise.
//
// Note what this does NOT do: it does not dial WhatsApp. It builds the session
// manager and hands it back. Panel mode leaves it idle until somebody presses
// Start on the Connection screen; headless has nobody to press anything, so it
// asks for `autoStart`. That is the whole of the difference between the two
// modes — there is no `if (headless)` anywhere below this line.

import { createRequire } from "module";
import { WhatsAppSession } from "../core/session.js";
import { loadCommands, getLoadedCommands } from "../handlers/command.handler.js";
import { initStore } from "../db/store.esm.js";
import { deleteQrCode } from "../utils/storage.esm.js";

const require = createRequire(import.meta.url);
const logger = require("../utils/logger.cjs");
const { sink } = require("./events.cjs");
const { acquireSingleInstanceLock } = require("../config/lock.cjs");
const { ensureDataDir } = require("../config/paths.cjs");
const store = require("../db/store.cjs");
const { initializeScheduledJobs, stopAllScheduledJobs } = require("../../scheduler.cjs");

/**
 * Start the bot.
 *
 * @param {object} [options]
 * @param {boolean} [options.autoStart] - connect to WhatsApp straight away.
 *   Headless does; the panel waits to be asked.
 * @returns {Promise<{ session: object, commandCount: number, wasPaired: boolean }>}
 */
export async function bootstrapCore({ autoStart = false } = {}) {
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

  // A pairing code belongs to the socket that issued it. One left in the table
  // by a process that was killed rather than stopped can never be scanned, and
  // GET /qr would happily serve it to somebody who then waits for nothing.
  deleteQrCode();

  const session = new WhatsAppSession({
    // The bot reports into the hub; whoever is listening decides what that
    // means — a socket.io broadcast, a line in the terminal, or nothing.
    emit: sink.emit,
    initializeScheduledJobs,
    stopScheduledJobs: stopAllScheduledJobs,
    log: logger,
  });

  if (autoStart) await session.start({ reason: "autostart" });

  return {
    session,
    commandCount: getLoadedCommands().size,
    wasPaired,
    /** The live socket, or null. Re-read it; a reconnect replaces it. */
    get sock() {
      return session.socket;
    },
  };
}

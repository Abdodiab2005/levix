// Everything Levix needs to be a WhatsApp bot.
//
// Database, settings, commands, the WhatsApp session manager, the scheduler.
// No HTTP, no Express, no socket.io — those live in bootstrap/panel.js and are
// entirely optional. `levix headless` runs this file and nothing else, which is
// what makes "no panel port is opened" a fact rather than a promise.
//
// A brand-new panel install stays idle until somebody presses Start on the
// Connection screen, so it does not generate pairing attempts nobody asked
// for. Once the install has been paired, process restarts resume that saved
// session automatically. Headless has no Start button, so it asks for
// `autoStart` and starts even when pairing is still required.

import { createRequire } from "module";
import { WhatsAppSession } from "../core/session.js";
import { loadCommands, getLoadedCommands } from "../handlers/command.handler.js";
import { initStore } from "../db/store.esm.js";
import { deleteQrCode } from "../utils/storage.esm.js";
import { sessionStartupPolicy } from "./session-startup-policy.js";

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
 * @param {boolean} [options.autoStart] - force a WhatsApp start even when the
 *   install is not paired yet. Headless uses this; panel mode resumes only an
 *   already-paired session.
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

  // Read this before a socket can create or update auth rows. It is the boot
  // policy boundary: fresh panel installs stay idle, paired installs resume.
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

  const startup = sessionStartupPolicy({ autoStart, wasPaired });
  if (startup.start) await session.start({ reason: startup.reason });

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

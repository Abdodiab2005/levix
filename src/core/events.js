import { createRequire } from 'module';
import { handleIncomingMessage } from '../handlers/message.handler.js';
import { handleGroupParticipantsUpdate, handleGroupJoinRequests } from '../handlers/group.handler.js';
import { groupMetadataCache } from './socket.js';
import { storeLidPnMappings } from '../utils/storage.esm.js';

const require = createRequire(import.meta.url);
const logger = require('../utils/logger.cjs');

/**
 * Wire one socket up.
 *
 * `connection.update` is handed straight to the session manager
 * (src/core/session.js) — it owns the state machine and the retry schedule, so
 * nothing here decides whether to reconnect.
 *
 * @param {object} sock
 * @param {object} handlers
 * @param {() => Promise<void>} handlers.saveCreds
 * @param {(update: object) => void} handlers.onConnectionUpdate
 */
export function setupEventListeners(sock, { saveCreds, onConnectionUpdate } = {}) {
  // Every listener below goes through this. A bare `async` listener hands its
  // promise to Baileys' emitter, which drops it — so one rejection anywhere in
  // the message pipeline becomes an unhandledRejection, and src/index.js turns
  // that into a process exit. A group lookup failing mid-disconnect is exactly
  // the case the reconnect ladder exists to survive, so it must not be fatal.
  const contained = (label, handler) => (payload) => {
    Promise.resolve()
      .then(() => handler(payload))
      .catch((err) => logger.error({ err }, `[Events] ${label} handler failed`));
  };

  sock.ev.on(
    'connection.update',
    contained('connection.update', (update) => onConnectionUpdate?.(update))
  );

  // Save credentials
  if (saveCreds) sock.ev.on('creds.update', saveCreds);

  // V7: LID mapping updates
  sock.ev.on('lid-mapping.update', (updates) => {
    logger.info(`[LID] Received ${Object.keys(updates).length} LID mapping updates`);
    const mappings = [];
    for (const [lid, pn] of Object.entries(updates)) {
      if (lid && pn) {
        mappings.push({ lid, pn, deviceIndex: 0 });
      }
    }
    if (mappings.length > 0) {
      storeLidPnMappings(mappings);
    }
  });

  // Group metadata updates
  sock.ev.on('groups.upsert', (updates) => {
    for (const group of updates) {
      logger.info(`[Cache] Caching metadata for group: ${group.id}`);
      groupMetadataCache.set(group.id, group);
    }
  });

  // Incoming messages
  sock.ev.on(
    'messages.upsert',
    contained('messages.upsert', (m) => handleIncomingMessage(sock, m))
  );

  // Group participant updates
  sock.ev.on(
    'group-participants.update',
    contained('group-participants.update', (update) =>
      handleGroupParticipantsUpdate(sock, update)
    )
  );

  // Group join requests
  sock.ev.on(
    'group-requests.update',
    contained('group-requests.update', (events) => handleGroupJoinRequests(sock, events))
  );
}

import { createRequire } from 'module';
import { handleConnectionUpdate } from './connection.js';
import { handleIncomingMessage } from '../handlers/message.handler.js';
import { handleGroupParticipantsUpdate, handleGroupJoinRequests } from '../handlers/group.handler.js';
import { groupMetadataCache } from './socket.js';
import { storeLidPnMapping, storeLidPnMappings } from '../utils/storage.esm.js';

const require = createRequire(import.meta.url);
const logger = require('../utils/logger.cjs');

// Setup all event listeners for WhatsApp socket
export function setupEventListeners(sock, saveCreds, clearAll, io, initializeScheduledJobs, reconnectCallback) {
  // Connection updates
  sock.ev.on('connection.update', async (update) => {
    const result = await handleConnectionUpdate(update, sock, clearAll, io, initializeScheduledJobs);
    if (result?.shouldReconnect && reconnectCallback) {
      // Trigger reconnection
      await reconnectCallback();
    }
  });

  // Save credentials
  sock.ev.on('creds.update', saveCreds);

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
  sock.ev.on('messages.upsert', async (m) => {
    await handleIncomingMessage(sock, m);
  });

  // Group participant updates
  sock.ev.on('group-participants.update', async (update) => {
    await handleGroupParticipantsUpdate(sock, update);
  });

  // Group join requests
  sock.ev.on('group-requests.update', async (events) => {
    await handleGroupJoinRequests(sock, events);
  });
}

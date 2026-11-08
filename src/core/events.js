import { createRequire } from "module";
import { attachReactionIntake } from "../automation/reactions.js";
import {
  handleGroupJoinRequests,
  handleGroupParticipantsUpdate,
} from "../handlers/group.handler.js";
import { handleIncomingMessage } from "../handlers/message.handler.js";
import {
  applyContactRecord,
  storeLidPnMappings,
  upsertGroupDirectory,
} from "../utils/storage.esm.js";

const require = createRequire(import.meta.url);
const logger = require("../utils/logger.cjs");
const {
  markRosterChanged,
  mergePartialGroupMetadata,
  storeUnsolicitedFullRoster,
} = require("../utils/groupMetadataCache.cjs");

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
 * @param {(response: object) => void} [handlers.onHandshakeRejected]
 */
export function setupEventListeners(
  sock,
  { saveCreds, onConnectionUpdate, onHandshakeRejected } = {},
) {
  const reactions = attachReactionIntake(sock);
  // Async listeners go through this. A bare `async` listener hands its
  // promise to Baileys' emitter, which drops it — so one rejection anywhere in
  // the message pipeline becomes an unhandledRejection, and src/index.js turns
  // that into a process exit. A group lookup failing mid-disconnect is exactly
  // the case the reconnect ladder exists to survive, so it must not be fatal.
  const contained = (label, handler) => (payload) => {
    Promise.resolve()
      .then(() => handler(payload))
      .catch((err) => logger.error({ err }, `[Events] ${label} handler failed`));
  };
  // Intake is synchronous and bounded; do not queue a payload-capturing
  // microtask per reaction in a storm. Keep existing async routing contained.
  const intake = (label, handler) => (payload) => {
    try { return handler(payload); }
    catch {
      reactions.close();
      logger.warn({ event: label }, "[Events] reaction intake failed; paused until reconnect");
    }
  };
  const connectionUpdate = contained("connection.update", (update) => onConnectionUpdate?.(update));

  sock.ev.on(
    "connection.update",
    (update) => {
      if (update?.connection === "open") reactions.open();
      if (update?.connection === "close") reactions.close();
      connectionUpdate(update);
    },
  );

  // A handshake the server answered with an HTTP status instead of an upgrade.
  //
  // This has to be listened for or the connection hangs silently forever: ws
  // only calls abortHandshake() when NOTHING is listening for
  // 'unexpected-response' (ws/lib/websocket.js:928), and Baileys' own
  // WebSocketClient registers a re-emitting listener for it — which satisfies
  // that guard and then does nothing with the event. A proxy answering 407
  // therefore produced no error, no close and no connection.update at all: the
  // session simply sat in `starting` until somebody noticed.
  sock.ws?.on?.(
    "unexpected-response",
    contained("unexpected-response", (_request, response) => {
      onHandshakeRejected?.(response);
    }),
  );

  // Save credentials
  if (saveCreds) sock.ev.on("creds.update", saveCreds);

  // Address-book names (`name`) and push names (`notify`) from the linked phone.
  // No history sync — these events are the live contact list WhatsApp already
  // pushes. persist `name` as saved_name; never treat `notify` as a saved name.
  const persistContacts = (contacts) => {
    const list = Array.isArray(contacts) ? contacts : contacts ? [contacts] : [];
    for (const contact of list) applyContactRecord(contact);
  };
  sock.ev.on("contacts.upsert", contained("contacts.upsert", persistContacts));
  sock.ev.on("contacts.update", contained("contacts.update", persistContacts));

  // V7: LID mapping updates
  sock.ev.on("lid-mapping.update", (updates) => {
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

  // Group metadata updates. A participants array is a full roster (Baileys
  // emits that from its groups dirty refresh). The request that produced it
  // started at an unknown time, so it is stored only when this group had no
  // roster event in the last 10 minutes. A newer event makes it a refresh
  // hint. Anything else is a partial patch: merge it, keep the remaining
  // TTL, and never invent an entry.
  sock.ev.on("groups.upsert", (updates) => {
    for (const group of updates || []) {
      if (!group?.id) continue;
      const stored = storeUnsolicitedFullRoster(sock, group.id, group);
      if (!stored) continue;
      logger.info(`[Cache] Caching metadata for group: ${group.id}`);
      upsertGroupDirectory(group.id, {
        subject: stored.subject || null,
        participantCount: stored.participants?.length ?? null,
      });
    }
  });

  sock.ev.on("groups.update", (updates) => {
    for (const group of updates || []) {
      if (!group?.id) continue;
      if (Array.isArray(group.participants)) {
        const stored = storeUnsolicitedFullRoster(sock, group.id, group);
        if (!stored) continue;
        upsertGroupDirectory(group.id, {
          subject: stored.subject || null,
          participantCount: stored.participants?.length ?? null,
        });
        continue;
      }
      const next = mergePartialGroupMetadata(group.id, group) || group;
      upsertGroupDirectory(group.id, {
        subject: next.subject || null,
        participantCount: next.participants?.length ?? null,
      });
    }
  });

  // Incoming messages
  sock.ev.on(
    "messages.upsert",
    (m) => {
      intake("messages.upsert", (payload) => reactions.observeUpsert(payload))(m);
      contained("messages.upsert", (payload) => handleIncomingMessage(sock, payload))(m);
    },
  );

  sock.ev.on("messages.reaction", intake("messages.reaction", (entries) => reactions.observeReactions(entries)));
  sock.ev.on("messages.update", intake("messages.update", (entries) => reactions.observeUpdates(entries)));
  sock.ev.on("messages.delete", intake("messages.delete", (payload) => reactions.observeDeletes(payload)));

  // Group participant updates. Mark the roster stale in this turn, before the
  // contained handler's microtask and before any await. Every action (add,
  // remove, promote, demote, modify, leave) can change who must receive a
  // sender key.
  sock.ev.on("group-participants.update", (update) => {
    markRosterChanged(sock, update?.id);
    contained(
      "group-participants.update",
      (payload) => handleGroupParticipantsUpdate(sock, payload),
    )(update);
  });

  // Group join requests
  sock.ev.on(
    "group-requests.update",
    contained("group-requests.update", (events) => handleGroupJoinRequests(sock, events)),
  );
}

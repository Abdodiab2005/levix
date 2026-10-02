// Who a sticker belongs to.
//
// A library is a row in sticker_owners. stickers.owner and sticker_packs.owner
// hold that row's id, a random 16 hex character string. The id is opaque to
// the library. This module is the only place that turns a WhatsApp identity
// into one.
//
// `self` is the panel and the linked account. Its account is the paired
// creds.me.lid, normalized, or creds.me.id only when the credentials carry no
// lid. Everyone else is a `user` row whose account is the sender's normalized
// LID (`<digits>@lid`, no device suffix). The LID is the one on the message.
// A message that has only a phone JID asks Baileys for the current mapping of
// that number. Levix's lid_mapping table is history and is not consulted: a
// recycled phone number has a new LID, so it does not inherit the previous
// holder's library. No LID means the sender is not identified.

const store = require("../db/store.cjs");
const { getSenderCandidates } = require("../utils/permissions.esm.js");
const normalizeJidModule = require("../utils/normalizeJid.esm.js");

const normalizeJid = normalizeJidModule.default;
const { isLidJid, isPnJid } = normalizeJidModule;

const LID_LOOKUP_MS = 5000;

function normalizedLid(value) {
  const norm = normalizeJid(value);
  return isLidJid(norm) ? norm : null;
}

function normalizedPn(value) {
  const norm = normalizeJid(value);
  return isPnJid(norm) ? norm : null;
}

function readCreds() {
  if (!store.isPairedSession()) return null;
  try {
    const creds = JSON.parse(store.authRead("creds") || "");
    return creds && typeof creds === "object" ? creds : null;
  } catch {
    return null;
  }
}

function forPanel() {
  const me = readCreds()?.me;
  const lid = me?.lid ? normalizedLid(me.lid) : null;
  const phone = normalizedPn(me?.id);
  // A session paired before its credentials carried a lid bound the panel to
  // its phone. When Baileys later fills in me.lid, that is the same pairing,
  // so the panel library moves onto the LID instead of being left behind.
  return store.stickerOwnerReconcileSelf(lid || phone || null, lid ? phone : null);
}

function firstOf(ids, normalize) {
  for (const id of ids) {
    const norm = normalize(id);
    if (norm) return norm;
  }
  return null;
}

function lookupLid(sock, pn) {
  const mapping = sock?.signalRepository?.lidMapping;
  const getLIDForPN = mapping?.getLIDForPN;
  if (typeof getLIDForPN !== "function") return Promise.resolve(null);
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), LID_LOOKUP_MS);
  });
  const lookup = Promise.resolve()
    .then(() => getLIDForPN.call(mapping, pn))
    .then((value) => normalizedLid(value))
    .catch(() => null);
  return Promise.race([lookup, timeout]).finally(() => clearTimeout(timer));
}

/**
 * @param {object} msg a Baileys message
 * @param {object} [sock] the socket, for the current phone-to-LID mapping
 * @returns {Promise<{ key: string|null }>}
 */
async function forMessage(msg, sock) {
  if (msg?.key?.fromMe) return forPanel();

  const messageIds = getSenderCandidates(msg, sock);
  let lid = firstOf(messageIds, normalizedLid);
  const phone = firstOf(messageIds, normalizedPn);
  if (!lid && phone) lid = await lookupLid(sock, phone);

  const creds = readCreds();
  const pairedLid = creds?.me?.lid ? normalizedLid(creds.me.lid) : null;
  if (lid && pairedLid && lid === pairedLid) return forPanel();
  if (!creds?.me?.lid && phone) {
    const pairedPn = normalizedPn(creds?.me?.id);
    if (pairedPn && phone === pairedPn) return forPanel();
  }
  if (!lid) return { key: null };
  return store.stickerOwnerEnsure(lid);
}

module.exports = { forPanel, forMessage };

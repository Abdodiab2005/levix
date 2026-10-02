// Who a sticker belongs to.
//
// The panel operator and the linked WhatsApp account share one library, keyed
// "self". Everyone else is keyed by their phone JID when this message maps to
// one, otherwise by their LID. The candidate list is the identifiers on this
// message plus one direct mapping of each, and the library rewrites only those
// rows onto the canonical key.
//
// A LID adds its phone JID. A phone JID adds a LID only when that LID is
// already one of the message's identifiers, or it is the only LID stored for
// the number. A second LID that merely shares the number is never added, so
// its rows are neither read nor rekeyed.
//
// A recycled phone number still inherits whatever is already keyed by that
// phone JID, the same as a role granted to the number. The phone JID is the
// identifier WhatsApp gives us, and a number that has moved to a new person
// looks the same as the same person now messaging with a phone JID.

const store = require("../db/store.cjs");
const { getSenderCandidates, sameUser } = require("../utils/permissions.esm.js");
const normalizeJidModule = require("../utils/normalizeJid.esm.js");

const normalizeJid = normalizeJidModule.default;
const { isLidJid, isPnJid } = normalizeJidModule;

const SELF = Object.freeze({ key: "self", candidates: Object.freeze(["self"]) });
const MAX_CANDIDATES = 32;

function forPanel() {
  return { key: SELF.key, candidates: [...SELF.candidates] };
}

function pushCandidate(into, value) {
  const norm = normalizeJid(value);
  if (!norm || norm === "self" || into.includes(norm) || into.length >= MAX_CANDIDATES) return;
  into.push(norm);
}

// Every distinct LID whose stored phone normalizes to `pn`.
function lidsMappedTo(pn) {
  const lids = [];
  for (const row of store.getAllLidMappings()) {
    if (!row?.pn || !row?.lid) continue;
    const rowPn = normalizeJid(row.pn);
    if (rowPn !== pn && row.pn !== pn) continue;
    const lid = normalizeJid(row.lid);
    if (!isLidJid(lid) || lids.includes(lid)) continue;
    lids.push(lid);
  }
  return lids;
}

// One hop. `messageIds` is the closed set from this message, before mappings.
function directMapping(id, messageIds) {
  try {
    if (isLidJid(id)) return store.getPnForLid(id);
    if (!isPnJid(id)) return null;
    const lids = lidsMappedTo(id);
    if (lids.length === 1) return lids[0];
    const named = lids.filter((lid) => messageIds.includes(lid));
    return named.length === 1 ? named[0] : null;
  } catch {
    // Identity lookup must not hide the sender when the database is unhappy.
    return null;
  }
}

function pairedIds() {
  if (!store.isPairedSession()) return [];
  try {
    const creds = JSON.parse(store.authRead("creds") || "");
    return [creds?.me?.id, creds?.me?.lid].filter(Boolean);
  } catch {
    return [];
  }
}

function isPairedAccount(candidates) {
  const mine = pairedIds();
  if (!mine.length) return false;
  return candidates.some((id) => mine.some((me) => sameUser(id, me)));
}

/**
 * @param {object} msg a Baileys message
 * @returns {{ key: string|null, candidates: string[] }}
 */
function forMessage(msg) {
  if (msg?.key?.fromMe) return forPanel();

  const messageIds = [];
  for (const value of getSenderCandidates(msg)) pushCandidate(messageIds, value);

  const candidates = [...messageIds];
  for (const id of messageIds) {
    if (candidates.length >= MAX_CANDIDATES) break;
    pushCandidate(candidates, directMapping(id, messageIds));
  }
  if (!candidates.length) return { key: null, candidates: [] };
  if (isPairedAccount(candidates)) return forPanel();

  // Phone JID wins once we know it, so the LID-shaped row is rewritten onto
  // the same key the next message will use.
  const key =
    candidates.find((id) => isPnJid(id)) || candidates.find((id) => isLidJid(id)) || candidates[0];
  if (!candidates.includes(key)) candidates.unshift(key);
  return { key, candidates };
}

module.exports = { forPanel, forMessage };

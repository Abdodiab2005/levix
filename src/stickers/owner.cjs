// Who a sticker belongs to.
//
// The panel operator and the linked WhatsApp account share one library, keyed
// "self". Everyone else is keyed by their phone JID when the LID mapping knows
// one, otherwise by their LID. Reads pass every candidate so a person seen
// first as a LID and later as a phone number still hits the same rows; the
// library rewrites those rows onto the canonical key.

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

function expand(value, into) {
  const norm = normalizeJid(value);
  if (!norm || norm === "self" || into.includes(norm) || into.length >= MAX_CANDIDATES) return;
  into.push(norm);
  try {
    if (isLidJid(norm)) expand(store.getPnForLid(norm), into);
    else if (isPnJid(norm)) expand(store.getLidForPn(norm), into);
  } catch {
    // Identity lookup must not hide the sender when the database is unhappy.
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

  const candidates = [];
  for (const value of getSenderCandidates(msg)) expand(value, candidates);
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

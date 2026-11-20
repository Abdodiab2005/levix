// Who the linked WhatsApp account is, for routing and profile fallbacks.
//
// A phone number typed into a setting is not this. The only ids accepted are
// `creds.me.id` and `creds.me.lid` from the paired session. No creds means
// there is no owner-private destination, and the router fails closed.

const normalizeJid = require("../utils/normalizeJid.cjs");

function readCreds() {
  try {
    const storage = require("../db/store.cjs");
    if (!storage.isPairedSession()) return null;
    const creds = JSON.parse(storage.authRead("creds") || "");
    return creds && typeof creds === "object" ? creds : null;
  } catch {
    return null;
  }
}

function asUserJid(value, suffix) {
  const norm = value ? normalizeJid(value) : null;
  if (!norm?.endsWith(suffix)) return null;
  return norm;
}

function cleanCredName(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "~") return null;
  if (/^\d+(?::\d+)?@(?:s\.whatsapp\.net|lid|g\.us)$/.test(trimmed)) return null;
  return trimmed.slice(0, 256);
}

function linkedIdentity() {
  const me = readCreds()?.me || {};
  const phone = asUserJid(me.id, "@s.whatsapp.net");
  const lid = asUserJid(me.lid, "@lid") || asUserJid(me.id, "@lid");
  const name =
    cleanCredName(me.name) || cleanCredName(me.verifiedName) || cleanCredName(me.notify) || null;
  return {
    phone,
    lid,
    name,
    selfJids: [...new Set([phone, lid].filter(Boolean))],
  };
}

function isLinkedSelf(jid, identity = linkedIdentity()) {
  const norm = jid ? normalizeJid(jid) : null;
  return Boolean(norm) && identity.selfJids.includes(norm);
}

module.exports = { linkedIdentity, isLinkedSelf, readCreds };

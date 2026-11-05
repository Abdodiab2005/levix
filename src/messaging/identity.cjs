// Who the linked WhatsApp account is, for routing only.
//
// A phone number typed into a setting is not this. The only ids accepted are
// `creds.me.id` and `creds.me.lid` from the paired session. No creds means
// there is no owner-private destination, and the router fails closed.

const normalizeJid = require("../utils/normalizeJid.cjs");

function readCreds() {
  try {
    const storage = require("../utils/storage.cjs");
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

function linkedIdentity() {
  const me = readCreds()?.me || {};
  const phone = asUserJid(me.id, "@s.whatsapp.net");
  const lid = asUserJid(me.lid, "@lid");
  return {
    phone,
    lid,
    selfJids: [phone, lid].filter(Boolean),
  };
}

function isLinkedSelf(jid, identity = linkedIdentity()) {
  const norm = jid ? normalizeJid(jid) : null;
  return Boolean(norm) && identity.selfJids.includes(norm);
}

module.exports = { linkedIdentity, isLinkedSelf, readCreds };

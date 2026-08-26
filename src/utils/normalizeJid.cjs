// CommonJS wrapper for normalizeJid.esm.js
// This allows CommonJS files to use the normalizeJid function

// We can't directly require ESM from CommonJS, so we use a workaround
// by creating a simple normalizeJid function that handles both formats

/**
 * V7: Normalize WhatsApp JID to handle both PN (Phone Number) and LID (Local Identifier)
 * @param {string} jid - The JID to normalize
 * @returns {string} - Normalized JID
 */
function normalizeJid(jid) {
  if (!jid) return jid;

  // V7: Handle LID format (@lid)
  if (jid.includes("@lid")) {
    // LID format: keep as-is
    if (jid.includes(":")) {
      return jid.split(":")[0] + "@lid";
    }
    return jid;
  }

  // Handle PN format (@s.whatsapp.net)
  if (jid.includes(":")) {
    return jid.split(":")[0] + "@" + jid.split("@")[1];
  }

  return jid;
}

/**
 * V7: Helper to check if JID is a Phone Number (PN)
 * @param {string} jid - The JID to check
 * @returns {boolean}
 */
function isPnJid(jid) {
  if (!jid) return false;
  return jid.includes("@s.whatsapp.net");
}

/**
 * V7: Helper to check if JID is a LID
 * @param {string} jid - The JID to check
 * @returns {boolean}
 */
function isLidJid(jid) {
  if (!jid) return false;
  return jid.includes("@lid");
}

/**
 * V7: Helper to check if JID is a user (either PN or LID)
 * @param {string} jid - The JID to check
 * @returns {boolean}
 */
function isUserJid(jid) {
  return isPnJid(jid) || isLidJid(jid);
}

module.exports = normalizeJid;
module.exports.normalizeJid = normalizeJid;
module.exports.isPnJid = isPnJid;
module.exports.isLidJid = isLidJid;
module.exports.isUserJid = isUserJid;

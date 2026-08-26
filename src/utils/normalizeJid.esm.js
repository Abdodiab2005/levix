// V7: Updated to handle both PN (Phone Number) and LID (Local Identifier)
export default function normalizeJid(jid) {
  if (!jid) return jid;

  // V7: Handle LID format (@lid)
  if (jid.includes('@lid')) {
    // LID format: keep as-is
    if (jid.includes(':')) {
      return jid.split(':')[0] + '@lid';
    }
    return jid;
  }

  // Handle PN format (@s.whatsapp.net)
  if (jid.includes(':')) {
    return jid.split(':')[0] + '@' + jid.split('@')[1];
  }

  return jid;
}

// V7: Helper to check if JID is a Phone Number (PN)
export function isPnJid(jid) {
  if (!jid) return false;
  return jid.includes('@s.whatsapp.net');
}

// V7: Helper to check if JID is a LID
export function isLidJid(jid) {
  if (!jid) return false;
  return jid.includes('@lid');
}

// V7: Helper to check if JID is a user (either PN or LID)
export function isUserJid(jid) {
  return isPnJid(jid) || isLidJid(jid);
}

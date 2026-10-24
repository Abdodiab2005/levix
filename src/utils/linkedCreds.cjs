// Whether Baileys credentials describe a finished link to a WhatsApp account.
//
// One definition, because three places need the answer (the boot policy that
// resumes a paired install, the session manager, and the socket factory) and
// they used to disagree with Baileys instead of with each other.
//
//   me.id         requestPairingCode writes it, with name "~", before the phone
//                 accepts the code. Alone it proves nothing.
//   registered    Baileys sets it true only in the pairing-code flow. A link
//                 made by scanning a QR code stays `registered: false` forever,
//                 so `false` cannot mean "unfinished".
//   account       the signed device identity, written by pair-success in both
//                 flows and in neither unfinished state.
//
// So a link is finished when there is a me.id and either the code flow said so
// or the account identity arrived.
function isLinkedCreds(creds) {
  if (!creds?.me?.id) return false;
  return creds.registered !== false || Boolean(creds.account);
}

module.exports = { isLinkedCreds };

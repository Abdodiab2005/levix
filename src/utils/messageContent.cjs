// Unwrap WhatsApp envelopes the same way command routing already does for
// captions: view-once / ephemeral / document-caption / SKDM-first.

function unwrapMessage(message) {
  let inner = message || {};
  for (let i = 0; i < 6; i++) {
    if (inner.viewOnceMessage?.message) inner = inner.viewOnceMessage.message;
    else if (inner.viewOnceMessageV2?.message) inner = inner.viewOnceMessageV2.message;
    else if (inner.viewOnceMessageV2Extension?.message) inner = inner.viewOnceMessageV2Extension.message;
    else if (inner.ephemeralMessage?.message) inner = inner.ephemeralMessage.message;
    else if (inner.documentWithCaptionMessage?.message) inner = inner.documentWithCaptionMessage.message;
    else if (inner.editedMessage?.message) inner = inner.editedMessage.message;
    else break;
  }
  return inner;
}

function visibleText(message) {
  const inner = unwrapMessage(message);
  return (
    inner.conversation ||
    inner.extendedTextMessage?.text ||
    inner.imageMessage?.caption ||
    inner.videoMessage?.caption ||
    inner.documentMessage?.caption ||
    ""
  );
}

const MEDIA_KEYS = ["imageMessage", "videoMessage", "stickerMessage", "audioMessage", "documentMessage"];

function mediaType(message) {
  const inner = unwrapMessage(message);
  for (const key of MEDIA_KEYS) {
    if (inner[key]) return key.replace("Message", "").toLowerCase();
  }
  return "";
}

module.exports = { unwrapMessage, visibleText, mediaType };

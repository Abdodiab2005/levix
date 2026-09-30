// Re-sends content into the current chat. Built for statuses (stories): reply
// to one with !send and the bot re-posts it here, so a photo that lives 24
// hours on the status ring stays in the chat. Works on any replied message —
// photo, video, voice note, sticker, document or plain text.
//
// No storage is involved: the reply's quotedMessage carries the full media
// metadata (url, mediaKey, directPath), which is enough to download and
// decrypt it again — nothing is cached and nothing is archived.
const { downloadContentFromMessage } = require("@whiskeysockets/baileys");
const { downloadMedia } = require("../utils/geminiMedia.cjs");
const { unwrapMessage, visibleText } = require("../utils/messageContent.cjs");
const { createStatus } = require("../utils/statusMessage.cjs");
const logger = require("../utils/logger.cjs");
const { tr } = require("../utils/i18n.cjs");

// The media in a message plus the download type that decrypts it — the type
// WhatsApp filed it under, not the MIME type (same rule as the AI command).
function pickMedia(message) {
  const inner = unwrapMessage(message);
  if (inner.stickerMessage) return { media: inner.stickerMessage, type: "sticker" };
  if (inner.imageMessage) return { media: inner.imageMessage, type: "image" };
  if (inner.videoMessage) return { media: inner.videoMessage, type: "video" };
  if (inner.audioMessage) return { media: inner.audioMessage, type: "audio" };
  if (inner.documentMessage) return { media: inner.documentMessage, type: "document" };
  return null;
}

function quotedOf(msg) {
  const own = unwrapMessage(msg.message);
  return own.extendedTextMessage?.contextInfo?.quotedMessage || null;
}

module.exports = {
  name: "send",
  description: {
    en: "Re-sends the replied message here: a status/story, photo, video, voice note, sticker, document or text.",
    ar: "يعيد إرسال الرسالة الموجّه لها الرد هنا: استوري، صورة، فيديو، رسالة صوتية، ستيكر، مستند أو نص.",
  },
  usage: {
    en: "send   (reply to a status or any message with it)",
    ar: "send   (اعمل رد على استوري أو أي رسالة بالأمر)",
  },
  chat: "all",

  async execute(sock, msg) {
    const chatId = msg.key.remoteJid;
    const quoted = quotedOf(msg);

    // Media attached to the command itself counts too — "send this" with a
    // caption works like a reply does.
    const target = pickMedia(msg.message) || (quoted ? pickMedia(quoted) : null);

    if (!target) {
      const quotedText = quoted ? visibleText(quoted) : "";
      if (quotedText) {
        return await sock.sendMessage(chatId, { text: quotedText });
      }
      return await sock.sendMessage(chatId, {
        text: tr(
          "Reply to a status or any message with `!send` and I'll re-send it here.",
          "اعمل رد على استوري أو أي رسالة بالأمر `!send` وأنا هعيد إرسالها هنا.",
        ),
      });
    }

    const status = await createStatus(sock, chatId, tr("📥 Sending...", "📥 جارٍ الإرسال..."), {
      replyTo: msg,
    });

    try {
      const buffer = await downloadMedia(downloadContentFromMessage, target.media, target.type);
      const media = target.media;
      const { mimetype, caption } = media;

      let content;
      if (target.type === "image") {
        content = {
          image: buffer,
          ...(caption ? { caption } : {}),
          ...(mimetype ? { mimetype } : {}),
        };
      } else if (target.type === "video") {
        content = {
          video: buffer,
          ...(caption ? { caption } : {}),
          ...(mimetype ? { mimetype } : {}),
          ...(media.gifPlayback ? { gifPlayback: true } : {}),
        };
      } else if (target.type === "audio") {
        content = { audio: buffer, ...(mimetype ? { mimetype } : {}), ptt: !!media.ptt };
      } else if (target.type === "sticker") {
        content = { sticker: buffer, ...(mimetype ? { mimetype } : {}) };
      } else {
        content = {
          document: buffer,
          ...(mimetype ? { mimetype } : {}),
          ...(media.fileName ? { fileName: media.fileName } : {}),
          ...(caption ? { caption } : {}),
        };
      }

      await sock.sendMessage(chatId, content);
      // The media is the answer — the status line goes away.
      await status.remove();
    } catch (error) {
      logger.error({ err: error, command: "send" }, "Failed to re-send replied media");
      await status.fail(
        error,
        tr(
          "Couldn't re-send it — the media may have expired",
          "تعذّر إرساله — ربما انتهت صلاحية ملف الوسائط",
        ),
      );
    }
  },
};

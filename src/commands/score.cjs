const logger = require("../utils/logger.cjs");

/**
 * Extracts quoted message info with forwarding score
 * @param {object} msg - WhatsApp message object
 * @returns {object|null} - { stanzaId, quotedMessage, forwardingScore, isForwarded }
 */
function getQuotedInfo(msg) {
  const m = msg.message;
  if (!m) return null;

  // List of all possible message types that can contain contextInfo
  const messageTypes = [
    "extendedTextMessage",
    "imageMessage",
    "videoMessage",
    "documentMessage",
    "documentWithCaptionMessage",
    "audioMessage",
    "stickerMessage",
    "contactMessage",
    "locationMessage",
    "liveLocationMessage",
  ];

  for (const type of messageTypes) {
    const messageContent = m[type];
    if (!messageContent?.contextInfo) continue;

    const contextInfo = messageContent.contextInfo;
    const stanzaId = contextInfo.stanzaId;
    const quotedMessage = contextInfo.quotedMessage;

    // Skip if no stanzaId (not a reply)
    if (!stanzaId) continue;

    // Initialize result
    let forwardingScore = 0;
    let isForwarded = false;

    // IMPORTANT: Try to extract forwarding info from the quoted message
    if (quotedMessage) {
      // Check all possible message types in quotedMessage
      for (const quotedType of messageTypes) {
        const quotedContent = quotedMessage[quotedType];

        // Check if this message type exists and has contextInfo
        if (quotedContent && quotedContent.contextInfo) {
          const quotedContextInfo = quotedContent.contextInfo;

          // Extract forwarding score and isForwarded flag
          if (quotedContextInfo.forwardingScore !== undefined && quotedContextInfo.forwardingScore !== null) {
            forwardingScore = quotedContextInfo.forwardingScore;
          }
          if (quotedContextInfo.isForwarded !== undefined && quotedContextInfo.isForwarded !== null) {
            isForwarded = quotedContextInfo.isForwarded;
          }

          // Don't break - check all types in case there are multiple
        }
      }

      // Also check conversation type (simple text without media)
      if (quotedMessage.conversation !== undefined) {
        // For simple conversation, forwarding info might be in parent contextInfo
        if (contextInfo.forwardingScore !== undefined && contextInfo.forwardingScore !== null) {
          forwardingScore = contextInfo.forwardingScore;
        }
        if (contextInfo.isForwarded !== undefined && contextInfo.isForwarded !== null) {
          isForwarded = contextInfo.isForwarded;
        }
      }
    }

    return {
      stanzaId,
      quotedMessage,
      forwardingScore,
      isForwarded,
    };
  }

  return null;
}

module.exports = {
  name: "score",
  aliases: ["نقاط", "احصائية"],
  description: "عرض عدد مرات إعادة توجيه رسالة معينة",
  usage: "score   (رد على الرسالة)",
  chat: "all",

  async execute(sock, msg, args, body, groupMetadata) {
    const chatId = msg.key.remoteJid;

    const quotedInfo = getQuotedInfo(msg);

    if (!quotedInfo || !quotedInfo.stanzaId) {
      return await sock.sendMessage(chatId, {
        text:
          "❌ يرجى الرد على رسالة لعرض نقاطها.\n\n" +
          "*الاستخدام:* قم بالرد على رسالة واكتب `!score`",
      });
    }

    try {
      const { forwardingScore, isForwarded } = quotedInfo;

      // Display the forward score
      let responseText = "📊 *نقاط الرسالة*\n\n";

      if (isForwarded || forwardingScore > 0) {
        responseText += `🔢 *عدد مرات إعادة التوجيه:* ${forwardingScore}\n`;
        responseText += `✅ *حالة الرسالة:* تم إعادة توجيهها`;
      } else {
        responseText += `🔢 *عدد مرات إعادة التوجيه:* 0\n`;
        responseText += `ℹ️ *حالة الرسالة:* رسالة أصلية (لم يتم إعادة توجيهها)`;
      }

      await sock.sendMessage(chatId, {
        text: responseText,
      });
    } catch (error) {
      logger.error({ err: error }, "Error in !score command");
      await sock.sendMessage(chatId, {
        text: "❌ حدث خطأ أثناء جلب نقاط الرسالة.",
      });
    }
  },
};

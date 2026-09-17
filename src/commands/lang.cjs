// file: src/commands/lang.cjs
const logger = require("../utils/logger.cjs");
const settings = require("../config/settings.cjs");
const runtimeConfig = require("../config/runtime-config.cjs");
const { isOwnerJidSync, isBotAdminUserSync } = require("../utils/permissions.cjs");

module.exports = {
  name: "lang",
  aliases: ["language", "لغة"],
  description: "View or change bot response language (ar / en / auto)",
  usage: "lang [ar|en|auto]",
  chat: "all",

  async execute(sock, msg, args) {
    const chatId = msg.key.remoteJid;
    const sender = msg.key.participant || msg.key.remoteJid;
    const prefix = runtimeConfig.getPrefix();
    const currentLang = settings.get("bot_language") || "auto";

    if (!args || args.length === 0) {
      const labels = {
        auto: "تلقائي (حسب لغة رسالتك) / Auto-detect",
        ar: "العربية الفصحى (Modern Standard Arabic)",
        en: "English (الإنجليزية)",
      };
      const text = `🌐 *لغة البوت الحالية / Current Bot Language:*
• \`${labels[currentLang] || currentLang}\`

*لتغيير اللغة / To change language:*
• \`${prefix}lang ar\` — العربية الفصحى
• \`${prefix}lang en\` — English
• \`${prefix}lang auto\` — تلقائي حسب رسالتك / Auto-detect

_ملاحظة: يمكن للمالك والمسؤولين تغيير اللغة لكافة المحادثات._`;
      await sock.sendMessage(chatId, { text }, { quoted: msg });
      return;
    }

    const isOwner = isOwnerJidSync(sender);
    const isAdmin = isBotAdminUserSync(sender);
    if (!isOwner && !isAdmin) {
      await sock.sendMessage(
        chatId,
        {
          text: `⚠️ عذراً، تغيير لغة البوت متاح لمالك البوت والمسؤولين فقط.\nSorry, only bot owner and admins can change bot language.`,
        },
        { quoted: msg }
      );
      return;
    }

    const choice = String(args[0]).toLowerCase().trim();
    if (choice !== "ar" && choice !== "en" && choice !== "auto") {
      await sock.sendMessage(
        chatId,
        {
          text: `❌ خيار غير صحيح. الخيارات المتاحة: \`ar\` أو \`en\` أو \`auto\`.\nInvalid option. Valid options are: \`ar\`, \`en\`, or \`auto\`.`,
        },
        { quoted: msg }
      );
      return;
    }

    settings.set("bot_language", choice);
    logger.info(`[Language] Bot response language set to: ${choice}`);

    if (choice === "ar") {
      await sock.sendMessage(
        chatId,
        { text: "✅ تم ضبط لغة البوت على **العربية الفصحى**. سيتحدث الذكاء الاصطناعي بالعربية الفصحى دائماً." },
        { quoted: msg }
      );
    } else if (choice === "en") {
      await sock.sendMessage(
        chatId,
        { text: "✅ Bot language set to **English**. The AI assistant will now always respond in English." },
        { quoted: msg }
      );
    } else {
      await sock.sendMessage(
        chatId,
        { text: "✅ تم ضبط اللغة على **التلقائي (Auto)**. سيرد البوت بحسب لغة كل رسالة ترسلها له تلقائياً." },
        { quoted: msg }
      );
    }
  },
};

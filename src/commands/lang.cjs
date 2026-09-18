// file: src/commands/lang.cjs
const logger = require("../utils/logger.cjs");
const settings = require("../config/settings.cjs");
const runtimeConfig = require("../config/runtime-config.cjs");
const { isOwnerJidSync, isBotAdminUserSync } = require("../utils/permissions.cjs");

module.exports = {
  name: "lang",
  aliases: ["language", "لغة"],
  description: "View or change the bot response language",
  usage: "lang [en|ar|auto]",
  chat: "all",

  async execute(sock, msg, args) {
    const chatId = msg.key.remoteJid;
    const sender = msg.key.participant || msg.key.remoteJid;
    const prefix = runtimeConfig.getPrefix();
    const currentLang = settings.get("bot_language") || "auto";

    const firstArg = args?.[0] ? String(args[0]).toLowerCase().trim() : "";

    if (!args || args.length === 0) {
      const labels = {
        auto: "تلقائي (حسب لغة رسالتك) / Auto-detect",
        ar: "العربية الفصحى (Modern Standard Arabic)",
        en: "English (الإنجليزية)",
      };
      const text = `🌐 *لغة البوت / Bot language*

⚙️ *اللغة الحالية:* \`${labels[currentLang] || currentLang}\`
• \`${prefix}lang ar\` — العربية الفصحى دائماً
• \`${prefix}lang en\` — English always
• \`${prefix}lang auto\` — تلقائي حسب لغة الرسالة

🔢 *لتحويل الأرقام* استخدم \`${prefix}digit\` — مثال: \`${prefix}digit 12345\``;
      await sock.sendMessage(chatId, { text }, { quoted: msg });
      return;
    }

    if (firstArg === "ar" || firstArg === "en" || firstArg === "auto") {
      if (args.length > 1) {
        await sock.sendMessage(
          chatId,
          {
            text: `🔢 لتحويل الأرقام استخدم \`${prefix}digit\`:\n• \`${prefix}digit ${firstArg} ${args.slice(1).join(" ")}\`\n• أو \`${prefix}digit ${args.slice(1).join(" ")}\` للتحويل التلقائي.\nTo convert digits, use \`${prefix}digit\`.`,
          },
          { quoted: msg },
        );
        return;
      }

      const isOwner = isOwnerJidSync(sender);
      const isAdmin = isBotAdminUserSync(sender);
      if (!isOwner && !isAdmin) {
        await sock.sendMessage(
          chatId,
          {
            text: `⚠️ عذراً، تغيير لغة البوت متاح لمالك البوت والمسؤولين فقط.\nSorry, only bot owner and admins can change bot language.\n_لتحويل الأرقام استخدم \`${prefix}digit\`._`,
          },
          { quoted: msg },
        );
        return;
      }

      settings.set("bot_language", firstArg);
      logger.info(`[Language] Bot response language set to: ${firstArg}`);

      if (firstArg === "ar") {
        await sock.sendMessage(
          chatId,
          {
            text: "✅ تم ضبط لغة البوت على *العربية الفصحى*. سيتحدث الذكاء الاصطناعي بالعربية الفصحى دائماً.",
          },
          { quoted: msg },
        );
      } else if (firstArg === "en") {
        await sock.sendMessage(
          chatId,
          {
            text: "✅ Bot language set to *English*. The AI assistant will now always respond in English.",
          },
          { quoted: msg },
        );
      } else {
        await sock.sendMessage(
          chatId,
          {
            text: "✅ تم ضبط اللغة على *التلقائي (Auto)*. سيرد البوت بحسب لغة كل رسالة ترسلها له تلقائياً.",
          },
          { quoted: msg },
        );
      }
      return;
    }

    await sock.sendMessage(
      chatId,
      {
        text: `❌ خيار غير صحيح.\nاستخدم:\n• \`${prefix}lang ar\` / \`${prefix}lang en\` / \`${prefix}lang auto\` للغة البوت\n• \`${prefix}digit 12345\` لتحويل الأرقام`,
      },
      { quoted: msg },
    );
  },
};

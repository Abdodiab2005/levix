// file: src/commands/lang.cjs
const logger = require("../utils/logger.cjs");
const settings = require("../config/settings.cjs");
const runtimeConfig = require("../config/runtime-config.cjs");
const { isOwnerJidSync, isBotAdminUserSync } = require("../utils/permissions.cjs");

const ARABIC_DIGITS = ["٠", "١", "٢", "٣", "٤", "٥", "٦", "٧", "٨", "٩"];
const PERSIAN_DIGITS = ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"];
const ENGLISH_DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

/**
 * Converts digits between Arabic (Eastern Arabic / Hindi) and English (Western Arabic).
 */
function convertNumerals(text, targetLang) {
  if (!text || typeof text !== "string") return text;

  if (targetLang === "ar") {
    // English digits to Arabic digits
    return text.replace(/[0-9]/g, (d) => ARABIC_DIGITS[parseInt(d, 10)]);
  }

  if (targetLang === "en") {
    // Arabic or Persian digits to English digits
    let result = text;
    for (let i = 0; i < 10; i++) {
      result = result.split(ARABIC_DIGITS[i]).join(ENGLISH_DIGITS[i]);
      result = result.split(PERSIAN_DIGITS[i]).join(ENGLISH_DIGITS[i]);
    }
    return result;
  }

  return text;
}

function getQuotedText(msg) {
  const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  if (!quoted) return null;
  return (
    quoted.conversation ||
    quoted.extendedTextMessage?.text ||
    quoted.imageMessage?.caption ||
    quoted.videoMessage?.caption ||
    null
  );
}

module.exports = {
  name: "lang",
  aliases: ["language", "لغة", "num", "numbers", "ارقام"],
  description: "Convert numbers between Arabic & English, or view/change bot language",
  usage: "lang [en|ar] [optional number/text] (or reply to a message)",
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
      const text = `🌐 *أمر اللغة وتحويل الأرقام / Language & Number Converter*

🔢 *تحويل الأرقام / Convert numbers:*
• \`${prefix}lang ar 12345\` ➔ 12345 ➔ ١٢٣٤٥
• \`${prefix}lang en ١٢٣٤٥\` ➔ ١٢٣٤٥ ➔ 12345
_أو قم بالرد على أي رسالة تحتوي أرقام بـ \`${prefix}lang ar\` أو \`${prefix}lang en\`._

⚙️ *لغة البوت الحالية:* \`${labels[currentLang] || currentLang}\`
• \`${prefix}lang ar\` — تغيير لغة البوت إلى العربية
• \`${prefix}lang en\` — تغيير لغة البوت إلى الإنجليزية
• \`${prefix}lang auto\` — تلقائي`;
      await sock.sendMessage(chatId, { text }, { quoted: msg });
      return;
    }

    const firstArg = String(args[0]).toLowerCase().trim();

    // Check if user is asking for number conversion
    const isTargetAr = firstArg === "ar" || firstArg === "عربي" || firstArg === "ع";
    const isTargetEn = firstArg === "en" || firstArg === "انجليزي" || firstArg === "إنجليزي";

    const inlineText = args.slice(1).join(" ").trim();
    const quotedText = getQuotedText(msg);
    const textToConvert = inlineText || quotedText;

    if ((isTargetAr || isTargetEn) && textToConvert) {
      const targetLang = isTargetAr ? "ar" : "en";
      const converted = convertNumerals(textToConvert, targetLang);
      await sock.sendMessage(chatId, { text: converted }, { quoted: msg });
      return;
    }

    // If no text provided, handle bot language change (requires owner/admin)
    if (firstArg === "ar" || firstArg === "en" || firstArg === "auto") {
      const isOwner = isOwnerJidSync(sender);
      const isAdmin = isBotAdminUserSync(sender);
      if (!isOwner && !isAdmin) {
        await sock.sendMessage(
          chatId,
          {
            text: `⚠️ عذراً، تغيير لغة البوت متاح لمالك البوت والمسؤولين فقط.\nSorry, only bot owner and admins can change bot language.\n_لتحويل الأرقام، اكتب الرقم بعد الأمر، مثل: \`${prefix}lang ${firstArg} 12345\`_`,
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
        text: `❌ خيار غير صحيح.\nاستخدم:\n• \`${prefix}lang ar [رقم]\` لتحويل الأرقام إلى عربية\n• \`${prefix}lang en [رقم]\` لتحويل الأرقام إلى إنجليزية\n• أو رد على الرسالة بالأمر.`,
      },
      { quoted: msg },
    );
  },
};

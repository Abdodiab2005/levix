// Convert digits between Western 0-9 and Eastern Arabic / Persian numerals.
const runtimeConfig = require("../config/runtime-config.cjs");
const {
  classifyNumerals,
  convertNumerals,
  getQuotedText,
  isExplicitAr,
  isExplicitEn,
  oppositeNumeralLang,
} = require("../utils/numerals.cjs");

function mixedDigitsNotice(prefix) {
  return `⚠️ الأرقام مختلطة (عربي وإنجليزي). حدد الاتجاه:\n\`${prefix}digit ar ...\` أو \`${prefix}digit en ...\`.\nDigits are mixed Arabic and English. Specify \`${prefix}digit ar\` or \`${prefix}digit en\`.`;
}

function helpText(prefix) {
  return `🔢 *تحويل الأرقام / Digit converter*

• \`${prefix}digit 12345\` ➔ ١٢٣٤٥  (يُكتشف تلقائياً / auto-detected)
• \`${prefix}digit ١٢٣٤٥\` ➔ 12345
• \`${prefix}digit ar 12345\` ➔ ١٢٣٤٥
• \`${prefix}digit en ١٢٣٤٥\` ➔ 12345
_أو رد على رسالة فيها أرقام بـ \`${prefix}digit\` — يحوّل للاتجاه المعاكس._
_إذا اختلطت الأرقام العربية والإنجليزية يجب تحديد الاتجاه: \`${prefix}digit ar\` أو \`${prefix}digit en\`._`;
}

module.exports = {
  name: "digit",
  aliases: ["digits", "num", "numbers", "numeral", "ارقام", "رقم"],
  description: "Convert numbers between Arabic and English digits",
  usage: "digit [en|ar] [number/text] (or reply to a message)",
  chat: "all",

  async execute(sock, msg, args) {
    const chatId = msg.key.remoteJid;
    const prefix = runtimeConfig.getPrefix();
    const quotedText = getQuotedText(msg);
    const firstArg = args?.[0] ? String(args[0]).toLowerCase().trim() : "";
    const targetAr = isExplicitAr(firstArg);
    const targetEn = isExplicitEn(firstArg);
    const hasExplicitTarget = targetAr || targetEn;

    if (!args || args.length === 0) {
      if (quotedText && classifyNumerals(quotedText) !== "none") {
        const kind = classifyNumerals(quotedText);
        if (kind === "mixed") {
          await sock.sendMessage(chatId, { text: mixedDigitsNotice(prefix) }, { quoted: msg });
          return;
        }
        const converted = convertNumerals(quotedText, oppositeNumeralLang(kind));
        await sock.sendMessage(chatId, { text: converted }, { quoted: msg });
        return;
      }
      await sock.sendMessage(chatId, { text: helpText(prefix) }, { quoted: msg });
      return;
    }

    const inlineText = hasExplicitTarget ? args.slice(1).join(" ").trim() : args.join(" ").trim();
    const textToConvert = inlineText || quotedText;

    if (!textToConvert) {
      await sock.sendMessage(
        chatId,
        {
          text: `❌ اكتب رقماً بعد الأمر، أو رد على رسالة.\nType a number after the command, or reply to a message.\nمثال: \`${prefix}digit 12345\` أو \`${prefix}digit ar 12345\``,
        },
        { quoted: msg },
      );
      return;
    }

    if (hasExplicitTarget) {
      const converted = convertNumerals(textToConvert, targetAr ? "ar" : "en");
      await sock.sendMessage(chatId, { text: converted }, { quoted: msg });
      return;
    }

    const kind = classifyNumerals(textToConvert);
    if (kind === "mixed") {
      await sock.sendMessage(chatId, { text: mixedDigitsNotice(prefix) }, { quoted: msg });
      return;
    }
    if (kind === "none") {
      await sock.sendMessage(
        chatId,
        {
          text: `❌ لا توجد أرقام للتحويل.\nNo digits found to convert.\nاستخدم:\n• \`${prefix}digit 12345\`\n• \`${prefix}digit ar\` / \`${prefix}digit en\` مع النص أو بالرد على رسالة.`,
        },
        { quoted: msg },
      );
      return;
    }

    const converted = convertNumerals(textToConvert, oppositeNumeralLang(kind));
    await sock.sendMessage(chatId, { text: converted }, { quoted: msg });
  },
};

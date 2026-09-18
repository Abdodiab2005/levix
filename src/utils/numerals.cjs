// Digit-script conversion: Western 0-9 <-> Eastern Arabic / Persian.

const ARABIC_DIGITS = ["٠", "١", "٢", "٣", "٤", "٥", "٦", "٧", "٨", "٩"];
const PERSIAN_DIGITS = ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"];
const ENGLISH_DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

function convertNumerals(text, targetLang) {
  if (!text || typeof text !== "string") return text;

  if (targetLang === "ar") {
    return text.replace(/[0-9]/g, (d) => ARABIC_DIGITS[parseInt(d, 10)]);
  }

  if (targetLang === "en") {
    let result = text;
    for (let i = 0; i < 10; i++) {
      result = result.split(ARABIC_DIGITS[i]).join(ENGLISH_DIGITS[i]);
      result = result.split(PERSIAN_DIGITS[i]).join(ENGLISH_DIGITS[i]);
    }
    return result;
  }

  return text;
}

function classifyNumerals(text) {
  const source = String(text || "");
  const hasEn = /[0-9]/.test(source);
  const hasAr = /[٠-٩۰-۹]/.test(source);
  if (hasEn && hasAr) return "mixed";
  if (hasEn) return "en";
  if (hasAr) return "ar";
  return "none";
}

function oppositeNumeralLang(kind) {
  if (kind === "en") return "ar";
  if (kind === "ar") return "en";
  return null;
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

function isExplicitAr(token) {
  const t = String(token || "")
    .toLowerCase()
    .trim();
  return t === "ar" || t === "عربي" || t === "ع";
}

function isExplicitEn(token) {
  const t = String(token || "")
    .toLowerCase()
    .trim();
  return t === "en" || t === "انجليزي" || t === "إنجليزي";
}

module.exports = {
  convertNumerals,
  classifyNumerals,
  oppositeNumeralLang,
  getQuotedText,
  isExplicitAr,
  isExplicitEn,
};

// Sticker Studio errors: one vocabulary for the panel and the bot.
//
// Every failure a person can see is a StickerError with a code from CODES.
// The panel API answers `{ error, code, ...details }` with the status below and
// the dashboard translates the code; a bot command replies with userMessage(),
// which goes through tr() so it follows the reply language of the message.
// Internal detail (ffmpeg stderr, paths) belongs in `cause` and the log, never
// in `message` or `details`.

const { tr } = require("../utils/i18n.cjs");

const CODES = Object.freeze({
  NO_MEDIA: "NO_MEDIA",
  UNSUPPORTED_TYPE: "UNSUPPORTED_TYPE",
  TOO_LARGE: "TOO_LARGE",
  DIMENSIONS_TOO_LARGE: "DIMENSIONS_TOO_LARGE",
  VIDEO_TOO_LONG: "VIDEO_TOO_LONG",
  CORRUPT: "CORRUPT",
  CONVERSION_FAILED: "CONVERSION_FAILED",
  OUTPUT_TOO_LARGE: "OUTPUT_TOO_LARGE",
  ENCODER_MISSING: "ENCODER_MISSING",
  TIMEOUT: "TIMEOUT",
  BUSY: "BUSY",
  NOT_FOUND: "NOT_FOUND",
  PACK_NOT_FOUND: "PACK_NOT_FOUND",
  PACK_EXISTS: "PACK_EXISTS",
  INVALID_NAME: "INVALID_NAME",
  INVALID_OPTIONS: "INVALID_OPTIONS",
  LIBRARY_FULL: "LIBRARY_FULL",
  PACK_LIMIT: "PACK_LIMIT",
  IN_USE: "IN_USE",
  STORAGE_UNAVAILABLE: "STORAGE_UNAVAILABLE",
  NOT_CONNECTED: "NOT_CONNECTED",
  CANCELLED: "CANCELLED",
});

const HTTP_STATUS = Object.freeze({
  NO_MEDIA: 400,
  UNSUPPORTED_TYPE: 415,
  TOO_LARGE: 413,
  DIMENSIONS_TOO_LARGE: 413,
  VIDEO_TOO_LONG: 422,
  CORRUPT: 422,
  CONVERSION_FAILED: 422,
  OUTPUT_TOO_LARGE: 422,
  ENCODER_MISSING: 501,
  TIMEOUT: 504,
  BUSY: 429,
  NOT_FOUND: 404,
  PACK_NOT_FOUND: 404,
  PACK_EXISTS: 409,
  INVALID_NAME: 400,
  INVALID_OPTIONS: 400,
  LIBRARY_FULL: 409,
  PACK_LIMIT: 409,
  IN_USE: 409,
  STORAGE_UNAVAILABLE: 503,
  NOT_CONNECTED: 503,
  CANCELLED: 409,
});

class StickerError extends Error {
  /**
   * @param {keyof CODES} code
   * @param {object} [details] safe to show: numbers, names, ids — no paths
   * @param {{ cause?: unknown }} [options]
   */
  constructor(code, details = {}, options = {}) {
    if (!CODES[code]) throw new TypeError(`unknown sticker error code: ${code}`);
    super(code, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "StickerError";
    this.code = code;
    this.details = details;
  }
}

function isStickerError(error) {
  return error instanceof StickerError;
}

function httpStatus(error) {
  return isStickerError(error) ? HTTP_STATUS[error.code] : 500;
}

/** The `{ error, code, ...details }` body the panel API answers with. */
function toResponseBody(error) {
  if (!isStickerError(error)) return { error: "Sticker operation failed", code: "INTERNAL" };
  return { error: userMessageIn("en", error), code: error.code, ...error.details };
}

function userMessageIn(lang, error) {
  const pick = (en, ar) => (lang === "ar" ? ar : en);
  return message(pick, error);
}

/** A reply for the person who sent the command, in the language of that message. */
function userMessage(error) {
  return message(tr, error);
}

function message(pick, error) {
  const d = (isStickerError(error) && error.details) || {};
  switch (isStickerError(error) ? error.code : "INTERNAL") {
    case "NO_MEDIA":
      return pick(
        "Send or reply to an image, GIF, video or sticker.",
        "أرسل صورة أو صورة متحركة أو فيديو أو ملصقًا، أو رد على واحد منها.",
      );
    case "UNSUPPORTED_TYPE":
      return pick(
        "That file type can't be made into a sticker. Use a JPEG, PNG, WebP, GIF or MP4/WebM video.",
        "لا يمكن تحويل هذا النوع من الملفات إلى ملصق. استخدم صورة JPEG أو PNG أو WebP أو GIF أو فيديو MP4/WebM.",
      );
    case "TOO_LARGE":
      if (d.limitFrames) {
        return pick(
          `The animation has too many frames (limit ${d.limitFrames}).`,
          `في الرسم المتحرك إطارات كثيرة جدًا (الحد ${d.limitFrames}).`,
        );
      }
      return pick(
        `The file is too large (limit ${formatMb(d.limitBytes)}).`,
        `الملف كبير جدًا (الحد ${formatMb(d.limitBytes)}).`,
      );
    case "DIMENSIONS_TOO_LARGE":
      return pick(
        `The image is too large (limit ${d.limit || 4096} px per side).`,
        `أبعاد الصورة كبيرة جدًا (الحد ${d.limit || 4096} بكسل لكل ضلع).`,
      );
    case "VIDEO_TOO_LONG":
      return pick(
        `The video is too long (limit ${d.limitSeconds || 10} seconds). Send a shorter clip, or trim it in the panel's Sticker Studio.`,
        `الفيديو طويل جدًا (الحد ${secondsAr(d.limitSeconds || 10)}). أرسل مقطعًا أقصر، أو اقتطع جزءًا منه في استوديو الملصقات في لوحة التحكم.`,
      );
    case "CORRUPT":
      return pick(
        "The file is damaged or incomplete, so it can't be read.",
        "الملف تالف أو غير مكتمل، ولا يمكن قراءته.",
      );
    case "CONVERSION_FAILED":
      return pick(
        "The sticker could not be created from this file.",
        "تعذّر إنشاء ملصق من هذا الملف.",
      );
    case "OUTPUT_TOO_LARGE":
      return pick(
        "Even at the lowest quality the sticker is over WhatsApp's size limit. Try a shorter or simpler clip.",
        "حجم الملصق يتجاوز حد واتساب حتى بأقل جودة. جرّب مقطعًا أقصر أو أبسط.",
      );
    case "ENCODER_MISSING":
      return pick(
        "This Levix build can't encode stickers (its FFmpeg has no WebP encoder). Update Levix.",
        "لا يستطيع إصدار Levix هذا ترميز الملصقات (أداة FFmpeg فيه بلا مرمّز WebP). حدّث Levix.",
      );
    case "TIMEOUT":
      return pick(
        "The conversion took too long and was stopped.",
        "استغرق التحويل وقتًا طويلًا فأُوقف.",
      );
    case "BUSY":
      return pick(
        "Levix is converting other stickers right now. Try again in a moment.",
        "يحوّل Levix ملصقات أخرى الآن. حاول مرة أخرى بعد قليل.",
      );
    case "NOT_FOUND":
      return pick("That sticker is not in your library.", "هذا الملصق غير موجود في مكتبتك.");
    case "PACK_NOT_FOUND":
      return pick(
        `There is no pack named "${d.name || ""}".`,
        `لا توجد حزمة باسم "${d.name || ""}".`,
      );
    case "PACK_EXISTS":
      return pick(
        `A pack named "${d.name || ""}" already exists.`,
        `توجد حزمة باسم "${d.name || ""}" بالفعل.`,
      );
    case "INVALID_NAME":
      return pick(
        "Pack names are 1–40 letters, digits, spaces, - or _, and can't be a command word.",
        "اسم الحزمة من 1 إلى 40 حرفًا أو رقمًا أو مسافة أو - أو _، ولا يجوز أن يكون كلمة أمر.",
      );
    case "INVALID_OPTIONS":
      return pick("Those sticker options are not valid.", "خيارات الملصق هذه غير صالحة.");
    case "LIBRARY_FULL":
      return pick(
        `Your sticker library is full (${d.limit || 0} stickers). Delete some first.`,
        `مكتبة ملصقاتك ممتلئة (${d.limit || 0} ملصق). احذف بعضها أولًا.`,
      );
    case "PACK_LIMIT":
      return pick(
        `You can have at most ${d.limit || 0} packs.`,
        `الحد الأقصى لعدد الحزم ${d.limit || 0}.`,
      );
    case "IN_USE":
      return pick(
        "This sticker is in one or more packs. Confirm to delete it everywhere.",
        "هذا الملصق موجود في حزمة أو أكثر. أكّد لحذفه من كل مكان.",
      );
    case "STORAGE_UNAVAILABLE":
      return pick(
        "The sticker library can't be written right now.",
        "لا يمكن الكتابة في مكتبة الملصقات الآن.",
      );
    case "NOT_CONNECTED":
      return pick(
        "WhatsApp is not connected, so nothing can be sent.",
        "واتساب غير متصل، فلا يمكن إرسال شيء.",
      );
    case "CANCELLED":
      return pick("The conversion was cancelled.", "أُلغي التحويل.");
    default:
      return pick("Something went wrong with the sticker.", "حدث خطأ في الملصق.");
  }
}

// Arabic counts agree with the number: 3–10 take the plural, 11 and up the
// singular accusative.
function secondsAr(n) {
  if (n === 1) return "ثانية واحدة";
  if (n === 2) return "ثانيتان";
  if (n >= 3 && n <= 10) return `${n} ثوانٍ`;
  return `${n} ثانية`;
}

function formatMb(bytes) {
  const mb = Number(bytes) / (1024 * 1024);
  return Number.isFinite(mb) && mb > 0 ? `${Math.round(mb)} MB` : "16 MB";
}

module.exports = {
  CODES,
  HTTP_STATUS,
  StickerError,
  isStickerError,
  httpStatus,
  toResponseBody,
  userMessage,
  userMessageIn,
};

// Sticker Studio errors: one vocabulary for the panel and the bot.
//
// Every failure a person can see is a StickerError with a code from CODES.
// The panel API answers `{ error, code, ...details }` with the status below and
// the dashboard translates the code; a bot command replies with userMessage(),
// which reads the catalog through t() so it follows the reply language of the
// message (one pair, VIDEO_TOO_LONG, is still on tr() because the English
// number and the Arabic secondsAr() form need different placeholders).
// Internal detail (ffmpeg stderr, paths) belongs in `cause` and the log, never
// in `message` or `details`.

const { tr, t, withLang } = require("../utils/i18n.cjs");
const { isolate } = require("../utils/bidi.cjs");

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
  // withLang is what forces the catalog onto `lang`; only "en" is used today.
  return withLang(lang, () => message(error));
}

/** A reply for the person who sent the command, in the language of that message. */
function userMessage(error) {
  return message(error);
}

function message(error) {
  const d = (isStickerError(error) && error.details) || {};
  switch (isStickerError(error) ? error.code : "INTERNAL") {
    case "NO_MEDIA":
      return t("bot.stickers.errors.noMedia");
    case "UNSUPPORTED_TYPE":
      return t("bot.stickers.errors.unsupportedType");
    case "TOO_LARGE":
      if (d.limitFrames) {
        return t("bot.stickers.errors.tooManyFrames", { limitFrames: d.limitFrames });
      }
      return t("bot.stickers.errors.tooLarge", { limitMb: formatMb(d.limitBytes) });
    case "DIMENSIONS_TOO_LARGE":
      return t("bot.stickers.errors.dimensionsTooLarge", { limit: d.limit || 4096 });
    case "VIDEO_TOO_LONG":
      // English shows the raw number where Arabic needs secondsAr(); keying
      // would need different placeholders per language, so this stays tr().
      return tr(
        `The video is too long (limit ${d.limitSeconds || 10} seconds). Send a shorter clip, or trim it in the panel's Sticker Studio.`,
        `الفيديو طويل جدًا (الحد ${secondsAr(d.limitSeconds || 10)}). أرسل مقطعًا أقصر، أو اقتطع جزءًا منه في استوديو الملصقات في لوحة التحكم.`,
      );
    case "CORRUPT":
      return t("bot.stickers.errors.corrupt");
    case "CONVERSION_FAILED":
      return t("bot.stickers.errors.conversionFailed");
    case "OUTPUT_TOO_LARGE":
      return t("bot.stickers.errors.outputTooLarge");
    case "ENCODER_MISSING":
      return t("bot.stickers.errors.encoderMissing");
    case "TIMEOUT":
      return t("bot.stickers.errors.timeout");
    case "BUSY":
      return t("bot.stickers.errors.busy");
    case "NOT_FOUND":
      return t("bot.stickers.errors.notFound");
    case "PACK_NOT_FOUND":
      return t("bot.stickers.errors.packNotFound", { name: isolate(d.name || "") });
    case "PACK_EXISTS":
      return t("bot.stickers.errors.packExists", { name: isolate(d.name || "") });
    case "INVALID_NAME":
      return t("bot.stickers.errors.invalidName");
    case "INVALID_OPTIONS":
      return t("bot.stickers.errors.invalidOptions");
    case "LIBRARY_FULL":
      return t("bot.stickers.errors.libraryFull", { limit: d.limit || 0 });
    case "PACK_LIMIT":
      return t("bot.stickers.errors.packLimit", { limit: d.limit || 0 });
    case "IN_USE":
      return t("bot.stickers.errors.inUse");
    case "STORAGE_UNAVAILABLE":
      return t("bot.stickers.errors.storageUnavailable");
    case "NOT_CONNECTED":
      return t("bot.stickers.errors.notConnected");
    case "CANCELLED":
      return t("bot.stickers.errors.cancelled");
    default:
      return t("bot.stickers.errors.internal");
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

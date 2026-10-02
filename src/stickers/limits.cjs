// Sticker Studio limits, shared by the converter, the library, the panel API
// and the bot commands. Change a number here and every surface follows.
//
// WhatsApp's own numbers: a sticker is a 512×512 WebP; a static one should be
// ≤ 100 KB and an animated one ≤ 500 KB, and clients refuse anything near
// 1 MB. Animations longer than 10 seconds are not shown as stickers.

const MB = 1024 * 1024;

module.exports = Object.freeze({
  CANVAS: 512,

  // What we accept as input.
  UPLOAD_MAX_BYTES: 16 * MB,
  WHATSAPP_MEDIA_MAX_BYTES: 16 * MB,
  MAX_INPUT_SIDE: 4096,
  MAX_INPUT_PIXELS: 4096 * 4096,
  // A source video may be longer than a sticker as long as the panel trims it.
  VIDEO_MAX_SOURCE_SECONDS: 60,
  // The bot has no trim control, so its sources must already fit.
  BOT_VIDEO_MAX_SECONDS: 10,
  STICKER_MAX_SECONDS: 10,
  ANIMATED_MAX_FRAMES: 300,

  // What we produce.
  ANIMATED_FPS: 15,
  STATIC_TARGET_BYTES: 100 * 1024,
  ANIMATED_TARGET_BYTES: 500 * 1024,
  STICKER_MAX_BYTES: 1 * MB,
  // A saved WhatsApp sticker is kept byte for byte when it fits these.
  EXISTING_MAX_SIDE: 1024,
  THUMB_SIZE: 160,

  // The conversion queue.
  JOB_CONCURRENCY: 2,
  JOB_MAX_QUEUED: 16,
  JOB_TIMEOUT_MS: 90_000,
  FFMPEG_STEP_TIMEOUT_MS: 60_000,
  JOB_RETENTION_MS: 10 * 60_000,
  UPLOAD_TTL_MS: 60 * 60_000,

  // The library.
  STICKER_NAME_MAX: 60,
  PACK_NAME_MAX: 40,
  PACKS_MAX_PER_OWNER: 100,
  EXPORT_MAX_IDS: 200,
  SEND_MAX_IDS: 10,
  BOT_PAGE_SIZE: 5,

  // Sub-command words of `!pack`. A pack can't be named any of them, in the
  // panel either, or the bot could never address it.
  PACK_SUBCOMMANDS: Object.freeze({
    create: Object.freeze(["create", "new", "إنشاء", "انشاء", "جديد"]),
    add: Object.freeze(["add", "أضف", "اضف", "إضافة", "اضافة"]),
    remove: Object.freeze(["remove", "rm", "أزل", "ازل", "إزالة", "ازالة"]),
    rename: Object.freeze(["rename", "تسمية", "إعادة-تسمية", "اعادة-تسمية"]),
    delete: Object.freeze(["delete", "del", "احذف", "حذف"]),
    show: Object.freeze(["show", "list", "عرض"]),
  }),
});

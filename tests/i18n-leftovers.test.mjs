// Oracles for phrases that used to be built in code.
// countLabel and secondsAr are copied from git show HEAD. They call the live
// tr(), so English and Arabic follow the language withLang selected.
// Run `npm run i18n:build` before this file. t() reads the generated catalog.

import { equal, finish, require, section, useTempDataDir } from "./harness.mjs";

useTempDataDir("levix-i18n-leftovers");

const { countLabel } = require("./src/utils/stickerBot.cjs");
const { StickerError, userMessage } = require("./src/stickers/errors.cjs");
const { t, tr, withLang } = require("./src/utils/i18n.cjs");

function countLabelOracle(count, kind = "sticker") {
  const n = Number(count);
  const singular = kind === "pack" ? "pack" : "sticker";
  const english = `${n} ${singular}${n === 1 ? "" : "s"}`;
  if (kind === "pack") {
    // i18n-exception: reference oracle copied from HEAD
    return tr(
      english,
      n === 1 ? "حزمة واحدة" : n === 2 ? "حزمتان" : n <= 10 ? `${n} حزم` : `${n} حزمة`,
    );
  }
  // i18n-exception: reference oracle copied from HEAD
  return tr(
    english,
    n === 1 ? "ملصق واحد" : n === 2 ? "ملصقان" : n <= 10 ? `${n} ملصقات` : `${n} ملصقًا`,
  );
}

// Copied from git show HEAD:src/stickers/errors.cjs.
function secondsAr(n) {
  if (n === 1) return "ثانية واحدة";
  if (n === 2) return "ثانيتان";
  if (n >= 3 && n <= 10) return `${n} ثوانٍ`;
  return `${n} ثانية`;
}

function videoOracle(limitSeconds) {
  // i18n-exception: reference oracle copied from HEAD
  return tr(
    `The video is too long (limit ${limitSeconds || 10} seconds). Send a shorter clip, or trim it in the panel's Sticker Studio.`,
    `الفيديو طويل جدًا (الحد ${secondsAr(limitSeconds || 10)}). أرسل مقطعًا أقصر، أو اقتطع جزءًا منه في استوديو الملصقات في لوحة التحكم.`,
  );
}

// Copied from git show HEAD:src/commands/group/flagged.cjs.
function flaggedOracle(tag, count, rule, when) {
  const safeRule = rule || "\u2014";
  // i18n-exception: reference oracle copied from HEAD
  return tr(
    `• ${tag} \u2014 warnings ${count}, last: ${safeRule}${when ? `, ${when}` : ""}`,
    `• ${tag} \u2014 الإنذارات ${count}\u060c آخر مخالفة: ${safeRule}${when ? `\u060c ${when}` : ""}`,
  );
}

function flaggedNow(tag, count, rule, when) {
  return t("bot.moderation.flagged.line", {
    tag,
    count,
    rule: rule || "\u2014",
    when: when ? t("bot.moderation.flagged.when", { when }) : "",
  });
}

const HELP = {
  "loop": {
    "key": "bot.tools.loop.help",
    "params": {
      "maxItems": 100,
      "maxSplit": 15
    },
    "en": "🔁 *Loop*\n\n*Usage:*\n`!loop <count> <text>` — repeat the text in one message\n`!loop <from>-<to>` — print the numbers from/to\n`!loop <from>-<to>:<step>` — with a custom step\n\n*Options:*\n`-s` separate messages instead of one\n`-n` no numbering\n\n*Placeholders in the text:*\n`{n}` the current number · `{i}` the repetition number\n\n*Examples:*\n`!loop 5 hello`\n`!loop 1-10`\n`!loop 0-100:25 counter {n}`\n`!loop 3 good morning -s`\n\n_At most {maxItems} repetitions in one message, {maxSplit} separate messages._",
    "ar": "🔁 *أمر التكرار*\n\n*الاستخدام:*\n`!loop <عدد> <النص>` — يكرر النص في رسالة واحدة\n`!loop <من>-<إلى>` — يطبع الأرقام من/إلى\n`!loop <من>-<إلى>:<خطوة>` — بخطوة مخصصة\n\n*خيارات:*\n`-s` رسائل منفصلة بدل رسالة واحدة\n`-n` من غير ترقيم\n\n*متغيرات داخل النص:*\n`{n}` الرقم الحالي · `{i}` رقم التكرار\n\n*أمثلة:*\n`!loop 5 اهلا`\n`!loop 1-10`\n`!loop 0-100:25 العداد {n}`\n`!loop 3 صباح الخير -s`\n\n_الحد الأقصى: {maxItems} تكرار في رسالة واحدة، {maxSplit} رسالة منفصلة._"
  },
  "rand": {
    "key": "bot.tools.rand.help",
    "params": {},
    "en": "🎲 *Random*\n\n`!rand` a number from 1 to 100\n`!rand <max>` a number from 1 to that number\n`!rand <min> <max>` a number between the two\n`!rand dice [count d sides]` dice — e.g. `!rand dice 2d6`\n`!rand coin` heads or tails\n`!rand pick option | option | option` picks one",
    "ar": "🎲 *عشوائي*\n\n`!rand` رقم من 1 لـ 100\n`!rand <أقصى>` رقم من 1 للرقم ده\n`!rand <أدنى> <أقصى>` رقم بين الحدّين\n`!rand dice [عدد d أوجه]` نرد — مثال `!rand dice 2d6`\n`!rand coin` ملك ولا كتابة\n`!rand pick خيار | خيار | خيار` يختار واحد"
  },
  "dice": {
    "key": "bot.tools.rand.diceError",
    "params": {
      "maxDice": 20,
      "maxSides": 1000
    },
    "en": "❌ Wrong dice format. Use `<count>d<sides>` — e.g. `2d6`.\n(at most {maxDice} dice and {maxSides} sides)",
    "ar": "❌ صيغة النرد غلط. استخدم `عددdأوجه` — مثال `2d6`.\n(حد أقصى {maxDice} نرد و {maxSides} وجه)"
  },
  "poll": {
    "key": "bot.tools.poll.help",
    "params": {
      "min": 2,
      "max": 12
    },
    "en": "📊 *Poll*\n\n*Usage:*\n`!poll <question> | <option> | <option> ...`\n\n*Options:*\n`--multi` allows more than one answer\n\n*Example:*\n`!poll Where to? | Cinema | Beach | Home`\n\n_{min} to {max} options._",
    "ar": "📊 *استفتاء*\n\n*الاستخدام:*\n`!poll <السؤال> | <خيار> | <خيار> ...`\n\n*خيارات:*\n`--multi` يسمح باختيار أكتر من إجابة\n\n*مثال:*\n`!poll إلى أين نذهب؟ | السينما | البحر | البيت`\n\n_من {min} لـ {max} خيارات._"
  },
  "perm": {
    "key": "bot.tools.perm.usage",
    "params": {},
    "en": "Wrong usage.\n\n`!perm list` — the current roles\n`!perm add admin @member` — make an admin\n`!perm add owner <number>` — make an owner\n`!perm remove admin @member` — take the role away",
    "ar": "استخدام غير صحيح.\n\n`!perm list` — القائمة الحالية\n`!perm add admin @عضو` — تعيين أدمن\n`!perm add owner <رقم>` — تعيين مالك\n`!perm remove admin @عضو` — سحب الصلاحية"
  },
  "debt": {
    "key": "bot.tools.debt.help",
    "params": {},
    "en": "📊 *Debt tracker (private chats only)*\n\nCommands:\n\n• `!debt add <amount> [description]` — add a debt\n• `!debt list` — list debts\n• `!debt del <id>` — delete a debt\n\nExample:\n`!debt add 50 lunch`",
    "ar": "📊 *نظام الديون (خاص فقط)*\n\nالأوامر:\n\n• `!debt add <amount> [description]` — إضافة دين\n• `!debt list` — عرض الديون\n• `!debt del <id>` — حذف دين\n\nمثال:\n`!debt add 50 غداء`"
  },
  "debtAdd": {
    "key": "bot.tools.debt.addUsage",
    "params": {},
    "en": "❌ Usage: `!debt add <amount> [description]`",
    "ar": "❌ الاستخدام: `!debt add <amount> [description]`"
  },
  "debtDel": {
    "key": "bot.tools.debt.delUsage",
    "params": {},
    "en": "❌ Usage: `!debt del <id>`",
    "ar": "❌ الاستخدام: `!debt del <id>`"
  },
  "prefix": {
    "key": "bot.core.setprefix.current",
    "params": {
      "prefix": "!"
    },
    "en": "The bot's current prefix: `{prefix}`\n\nTo change it, use:\n`{prefix}setprefix <new_prefix>`\n\nExample: `{prefix}setprefix /`\n\n⚠️ Only the owner can change the prefix.",
    "ar": "البادئة الحالية للبوت: `{prefix}`\n\nلتغيير البادئة، استخدم:\n`{prefix}setprefix <البادئة_الجديدة>`\n\nمثال: `{prefix}setprefix /`\n\n⚠️ ملاحظة: يمكن للمالك فقط تغيير البادئة."
  },
  "prayer": {
    "key": "bot.tools.prayer.needCity",
    "params": {},
    "en": "Give the city's name in English.\n\n*Example:* `!prayer cairo`",
    "ar": "يرجى تقديم اسم المدينة باللغة الانجليزية.\n\n*مثال:* `!prayer cairo`"
  }
};

function fill(text, params) {
  return text.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (token, name) =>
    Object.hasOwn(params, name) ? String(params[name]) : token,
  );
}

const samples = [];
for (let n = 0; n <= 120; n += 1) samples.push(n);
samples.push(200, 1000, 1010, 1011, 1000000, 1000003, -1, -2, 2.5, NaN, Infinity);

section("count labels match the old phrases");
for (const lang of ["en", "ar"]) {
  for (const n of samples) {
    for (const kind of ["sticker", "pack"]) {
      equal(
        `${lang} ${kind} ${n}`,
        withLang(lang, () => countLabel(n, kind === "sticker" ? undefined : kind)),
        withLang(lang, () => countLabelOracle(n, kind === "sticker" ? undefined : kind)),
      );
    }
  }
}

section("video too long matches the old sentence");
for (const lang of ["en", "ar"]) {
  for (const n of samples) {
    equal(
      `${lang} video ${n}`,
      withLang(lang, () => userMessage(new StickerError("VIDEO_TOO_LONG", { limitSeconds: n }))),
      withLang(lang, () => videoOracle(n)),
    );
  }
}

section("flagged lines match the old join");
for (const lang of ["en", "ar"]) {
  for (const [tag, count, rule, when] of [
    ["@123", 1, "links", "2026-01-02T03:04:05.000Z"],
    ["@9", 0, "", ""],
    ["@9", 11, null, ""],
  ]) {
    equal(
      `${lang} flagged ${count} ${Boolean(when)}`,
      withLang(lang, () => flaggedNow(tag, count, rule, when)),
      withLang(lang, () => flaggedOracle(tag, count, rule, when)),
    );
  }
}

section("help texts match the old English and Arabic");
for (const [name, item] of Object.entries(HELP)) {
  for (const lang of ["en", "ar"]) {
    equal(
      `${name} ${lang}`,
      withLang(lang, () => t(item.key, item.params)),
      fill(item[lang], item.params),
    );
  }
}

section("pt-BR and es-419 use their own words");
equal("pt-BR one sticker", withLang("pt-BR", () => countLabel(1)), "1 figurinha");
equal("pt-BR many stickers", withLang("pt-BR", () => countLabel(1000000)), "1000000 figurinhas");
equal("es-419 one pack", withLang("es-419", () => countLabel(1, "pack")), "1 paquete");
equal(
  "es-419 video",
  withLang("es-419", () => userMessage(new StickerError("VIDEO_TOO_LONG", { limitSeconds: 1 }))),
  "El video es demasiado largo (límite de 1 segundo). Envía un clip más corto o recórtalo en el Sticker Studio del panel.",
);
equal(
  "prayer Arabic stars",
  withLang("ar", () => t("bot.tools.prayer.needCity")).split("*").length - 1,
  2,
);

finish();

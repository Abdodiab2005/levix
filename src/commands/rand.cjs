// عشوائي — !rand
//
//   !rand                 رقم من 1 لـ 100
//   !rand 6               رقم من 1 لـ 6
//   !rand 10 50           رقم بين 10 و 50
//   !rand dice            نرد 1d6
//   !rand dice 2d20       نردين وجه 20
//   !rand coin            ملك / كتابة
//   !rand pick شاي | قهوة | عصير
//
// Used for settling arguments in the group. No dependencies, no state.

const { sendBotMessage } = require("../utils/sendBotMessage.cjs");

const MAX_DICE = 20;
const MAX_SIDES = 1000;
const MAX_CHOICES = 30;

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function toNumber(token) {
  const normalized = String(token ?? "")
    .trim()
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
  if (!normalized) return null; // Number("") is 0 — not what we mean here
  const value = Number(normalized);
  return Number.isFinite(value) ? Math.trunc(value) : null;
}

const HELP_TEXT =
  "🎲 *عشوائي*\n\n" +
  "`!rand` رقم من 1 لـ 100\n" +
  "`!rand <أقصى>` رقم من 1 للرقم ده\n" +
  "`!rand <أدنى> <أقصى>` رقم بين الاتنين\n" +
  "`!rand dice [عدد d أوجه]` نرد — مثال `!rand dice 2d6`\n" +
  "`!rand coin` ملك ولا كتابة\n" +
  "`!rand pick خيار | خيار | خيار` يختار واحد";

function rollDice(spec) {
  const match = String(spec || "1d6")
    .toLowerCase()
    .match(/^(\d+)?d(\d+)$/);
  const count = match?.[1] ? Number(match[1]) : 1;
  const sides = match?.[2] ? Number(match[2]) : 6;

  if (!match || count < 1 || count > MAX_DICE || sides < 2 || sides > MAX_SIDES) {
    return {
      error:
        `❌ صيغة النرد غلط. استخدم \`عددdأوجه\` — مثال \`2d6\`.\n` +
        `(حد أقصى ${MAX_DICE} نرد و ${MAX_SIDES} وجه)`,
    };
  }

  const rolls = Array.from({ length: count }, () => randomInt(1, sides));
  const total = rolls.reduce((sum, value) => sum + value, 0);
  return { rolls, total, count, sides };
}

module.exports = {
  name: "rand",
  aliases: ["random", "roll", "عشوائي", "قرعة"],
  description: "أرقام عشوائية، نرد، عملة، أو اختيار من قائمة.",
  usage: "rand [<أقصى> | <أدنى> <أقصى> | dice [2d6] | coin | pick أ | ب | ج]",
  chat: "all",

  async execute(sock, msg, args) {
    const chatId = msg.key.remoteJid;
    const reply = (text) => sendBotMessage(sock, chatId, { text }, { replyTo: msg });

    const mode = (args[0] || "").toLowerCase();

    if (["help", "?", "مساعدة"].includes(mode)) return reply(HELP_TEXT);

    if (["coin", "flip", "عملة", "معملة"].includes(mode)) {
      const heads = Math.random() < 0.5;
      return reply(`🪙 *${heads ? "ملك 👑" : "كتابة ✍️"}*`);
    }

    if (["dice", "die", "نرد", "زهر"].includes(mode)) {
      const result = rollDice(args[1]);
      if (result.error) return reply(result.error);
      const detail =
        result.rolls.length > 1 ? `\n(${result.rolls.join(" + ")})` : "";
      return reply(
        `🎲 *${result.total}* — ${result.count}d${result.sides}${detail}`
      );
    }

    if (["pick", "choose", "اختار", "اختر"].includes(mode)) {
      const choices = args
        .slice(1)
        .join(" ")
        .split(/\s*[|،,]\s*/)
        .map((choice) => choice.trim())
        .filter(Boolean);

      if (choices.length < 2) {
        return reply("❌ اديني خيارين على الأقل مفصولين بـ `|`.\nمثال: `!rand pick شاي | قهوة`");
      }
      if (choices.length > MAX_CHOICES) {
        return reply(`❌ الخيارات كتير أوي (الحد ${MAX_CHOICES}).`);
      }

      const winner = choices[randomInt(0, choices.length - 1)];
      return reply(`🎯 اخترت: *${winner}*\n_(من ${choices.length} خيارات)_`);
    }

    // Plain number forms: !rand · !rand 6 · !rand 10 50
    const first = toNumber(args[0]);
    const second = toNumber(args[1]);

    if (args[0] && first === null) return reply(HELP_TEXT);

    let min = 1;
    let max = 100;
    if (first !== null && second !== null) {
      min = Math.min(first, second);
      max = Math.max(first, second);
    } else if (first !== null) {
      min = first < 1 ? first : 1;
      max = first < 1 ? 1 : first;
    }

    if (min === max) return reply(`🎲 *${min}*`);

    return reply(`🎲 *${randomInt(min, max)}*\n_(بين ${min} و ${max})_`);
  },
};

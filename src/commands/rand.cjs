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
const { t, tr } = require("../utils/i18n.cjs");

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

const helpText = () =>
  tr(
    "🎲 *Random*\n\n" +
      "`!rand` a number from 1 to 100\n" +
      "`!rand <max>` a number from 1 to that number\n" +
      "`!rand <min> <max>` a number between the two\n" +
      "`!rand dice [count d sides]` dice — e.g. `!rand dice 2d6`\n" +
      "`!rand coin` heads or tails\n" +
      "`!rand pick option | option | option` picks one",
    HELP_TEXT_AR,
  );

const HELP_TEXT_AR =
  "🎲 *عشوائي*\n\n" +
  "`!rand` رقم من 1 لـ 100\n" +
  "`!rand <أقصى>` رقم من 1 للرقم ده\n" +
  "`!rand <أدنى> <أقصى>` رقم بين الحدّين\n" +
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
      error: tr(
        `❌ Wrong dice format. Use \`<count>d<sides>\` — e.g. \`2d6\`.\n` +
          `(at most ${MAX_DICE} dice and ${MAX_SIDES} sides)`,
        `❌ صيغة النرد غلط. استخدم \`عددdأوجه\` — مثال \`2d6\`.\n` +
          `(حد أقصى ${MAX_DICE} نرد و ${MAX_SIDES} وجه)`,
      ),
    };
  }

  const rolls = Array.from({ length: count }, () => randomInt(1, sides));
  const total = rolls.reduce((sum, value) => sum + value, 0);
  return { rolls, total, count, sides };
}

module.exports = {
  name: "rand",
  aliases: ["random", "roll", "عشوائي", "قرعة"],
  chat: "all",

  async execute(sock, msg, args) {
    const chatId = msg.key.remoteJid;
    const reply = (text) => sendBotMessage(sock, chatId, { text }, { replyTo: msg });

    const mode = (args[0] || "").toLowerCase();

    if (["help", "?", "مساعدة"].includes(mode)) return reply(helpText());

    if (["coin", "flip", "عملة", "معملة"].includes(mode)) {
      const heads = Math.random() < 0.5;
      return reply(`🪙 *${heads ? t("bot.tools.rand.heads") : t("bot.tools.rand.tails")}*`);
    }

    if (["dice", "die", "نرد", "زهر"].includes(mode)) {
      const result = rollDice(args[1]);
      if (result.error) return reply(result.error);
      const detail = result.rolls.length > 1 ? `\n(${result.rolls.join(" + ")})` : "";
      return reply(`🎲 *${result.total}* — ${result.count}d${result.sides}${detail}`);
    }

    if (["pick", "choose", "اختار", "اختر"].includes(mode)) {
      const choices = args
        .slice(1)
        .join(" ")
        .split(/\s*[|،,]\s*/)
        .map((choice) => choice.trim())
        .filter(Boolean);

      if (choices.length < 2) {
        return reply(t("bot.tools.rand.pickTooFew"));
      }
      if (choices.length > MAX_CHOICES) {
        return reply(t("bot.tools.rand.pickTooMany", { limit: MAX_CHOICES }));
      }

      const winner = choices[randomInt(0, choices.length - 1)];
      return reply(
        t("bot.tools.rand.picked", { winner, count: choices.length }),
      );
    }

    // Plain number forms: !rand · !rand 6 · !rand 10 50
    const first = toNumber(args[0]);
    const second = toNumber(args[1]);

    if (args[0] && first === null) return reply(helpText());

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

    const value = randomInt(min, max);
    return reply(t("bot.tools.rand.rolled", { value, min, max }));
  },
};

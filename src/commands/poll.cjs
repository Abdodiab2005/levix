// استفتاء — !poll
//
//   !poll نروح فين النهاردة؟ | السينما | البحر | نقعد في البيت
//   !poll --multi اختر أكلك | كشري | فراخ | بيتزا     (يسمح بأكتر من اختيار)
//
// Sends a native WhatsApp poll (not a text list), so members vote with a tap
// and WhatsApp counts the results.

const { sendBotMessage } = require("../utils/sendBotMessage.cjs");

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 12; // WhatsApp's own ceiling
const MAX_QUESTION_CHARS = 255;
const MAX_OPTION_CHARS = 100;

const MULTI_FLAGS = new Set(["--multi", "-m", "متعدد"]);

const HELP_TEXT =
  "📊 *استفتاء*\n\n" +
  "*الاستخدام:*\n" +
  "`!poll <السؤال> | <خيار> | <خيار> ...`\n\n" +
  "*خيارات:*\n" +
  "`--multi` يسمح باختيار أكتر من إجابة\n\n" +
  "*مثال:*\n" +
  "`!poll نروح فين؟ | السينما | البحر | البيت`\n\n" +
  `_من ${MIN_OPTIONS} لـ ${MAX_OPTIONS} خيارات._`;

module.exports = {
  name: "poll",
  aliases: ["vote", "استفتاء", "تصويت"],
  description: "ينشئ استفتاء (تصويت) داخل الشات.",
  usage: "poll <السؤال> | <خيار1> | <خيار2> [| ...] [--multi]",
  chat: "all",

  async execute(sock, msg, args) {
    const chatId = msg.key.remoteJid;
    const reply = (text) => sendBotMessage(sock, chatId, { text }, { replyTo: msg });

    let multi = false;
    const rest = args.filter((arg) => {
      if (MULTI_FLAGS.has(arg.toLowerCase())) {
        multi = true;
        return false;
      }
      return true;
    });

    const parts = rest
      .join(" ")
      .split(/\s*[|،]\s*/)
      .map((part) => part.trim())
      .filter(Boolean);

    if (parts.length < MIN_OPTIONS + 1) return reply(HELP_TEXT);

    const question = parts[0].slice(0, MAX_QUESTION_CHARS);
    // WhatsApp rejects a poll with duplicate options.
    const options = [...new Set(parts.slice(1).map((o) => o.slice(0, MAX_OPTION_CHARS)))];

    if (options.length < MIN_OPTIONS) {
      return reply("❌ محتاج خيارين مختلفين على الأقل.");
    }
    if (options.length > MAX_OPTIONS) {
      return reply(`❌ الحد الأقصى ${MAX_OPTIONS} خيار (انت كاتب ${options.length}).`);
    }

    return sendBotMessage(
      sock,
      chatId,
      {
        poll: {
          name: question,
          values: options,
          selectableCount: multi ? options.length : 1,
        },
      },
      { replyTo: msg }
    );
  },
};

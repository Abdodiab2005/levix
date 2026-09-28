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

/**
 * Validate question/options and build the exact `sendMessage` content for a
 * native poll — shared by the !poll command and the AI agent's `create_poll`
 * tool so both doors enforce the same WhatsApp limits. Throws with an Arabic
 * message on any violation; returns the `{ poll: ... }` content object.
 */
function buildPollContent(question, options, { multi = false } = {}) {
  const name = String(question || "").trim().slice(0, MAX_QUESTION_CHARS);
  const values = [...new Set((options || []).map((o) => String(o || "").trim().slice(0, MAX_OPTION_CHARS)).filter(Boolean))];

  if (!name) throw new Error("السؤال مطلوب.");
  if (values.length < MIN_OPTIONS) throw new Error("محتاج خيارين مختلفين على الأقل.");
  if (values.length > MAX_OPTIONS) {
    throw new Error(`الحد الأقصى ${MAX_OPTIONS} خيار (اتعطى ${values.length}).`);
  }

  return {
    poll: {
      name,
      values,
      selectableCount: multi ? values.length : 1,
    },
  };
}

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

    const question = parts[0];
    const options = parts.slice(1);

    let content;
    try {
      content = buildPollContent(question, options, { multi });
    } catch (err) {
      return reply(`❌ ${err.message}`);
    }

    return sendBotMessage(sock, chatId, content, { replyTo: msg });
  },

  // exported for the AI agent's `create_poll` tool — one builder, two doors
  _buildPollContent: buildPollContent,
};

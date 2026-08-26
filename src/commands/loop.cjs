// تكرار — !loop
//
// Repeats a number range or a piece of text, either bundled into ONE message
// or sent as SEPARATE messages.
//
//   !loop 5 اهلا              5 lines in one message
//   !loop 1-10                the numbers 1 … 10
//   !loop 1-20:5              1, 6, 11, 16  (step 5)
//   !loop 3 صباح الخير -s     three separate messages
//   !loop 1-5 السطر رقم {n}   {n} = current number, {i} = iteration index
//
// Hard caps keep an innocent `!loop 100000` from turning the bot into a
// flood bot (and from getting the account banned).

const { sendBotMessage } = require("../utils/sendBotMessage.cjs");

const MAX_ITEMS = 100; // total iterations, one-message mode
const MAX_SPLIT_ITEMS = 15; // total iterations, separate-messages mode
const MAX_OUTPUT_CHARS = 3500; // WhatsApp starts truncating well past this
const SPLIT_GAP_MS = 900; // breathing room between separate sends

const SPLIT_FLAGS = new Set(["-s", "--split", "split", "منفصل", "منفصلة"]);
const NO_NUMBER_FLAGS = new Set(["-n", "--nonum", "--plain", "بدون-ترقيم"]);

const HELP_TEXT =
  "🔁 *أمر التكرار*\n\n" +
  "*الاستخدام:*\n" +
  "`!loop <عدد> <النص>` — يكرر النص في رسالة واحدة\n" +
  "`!loop <من>-<إلى>` — يطبع الأرقام من/إلى\n" +
  "`!loop <من>-<إلى>:<خطوة>` — بخطوة مخصصة\n\n" +
  "*خيارات:*\n" +
  "`-s` رسائل منفصلة بدل رسالة واحدة\n" +
  "`-n` من غير ترقيم\n\n" +
  "*متغيرات داخل النص:*\n" +
  "`{n}` الرقم الحالي · `{i}` رقم التكرار\n\n" +
  "*أمثلة:*\n" +
  "`!loop 5 اهلا`\n" +
  "`!loop 1-10`\n" +
  "`!loop 0-100:25 العداد {n}`\n" +
  "`!loop 3 صباح الخير -s`\n\n" +
  `_الحد الأقصى: ${MAX_ITEMS} تكرار في رسالة واحدة، ${MAX_SPLIT_ITEMS} رسالة منفصلة._`;

/**
 * `5` -> 1..5 · `3-9` -> 3..9 · `0-100:25` -> 0,25,50,75,100
 * Returns null when the token isn't a count/range at all.
 */
function parseRange(token) {
  if (!token) return null;

  const match = String(token)
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .match(/^(-?\d+)(?:\s*(?:-|\.\.|إلى|to)\s*(-?\d+))?(?::(\d+))?$/);
  if (!match) return null;

  const first = Number(match[1]);
  const second = match[2] === undefined ? null : Number(match[2]);
  const step = match[3] ? Number(match[3]) : 1;
  if (!step || step < 1) return null;

  // A bare number is a repeat count, not a range.
  const from = second === null ? 1 : first;
  const to = second === null ? first : second;

  return { from, to, step, isCount: second === null };
}

/** How many iterations the range asks for — computed, not enumerated. */
function countOf({ from, to, step }) {
  return Math.floor(Math.abs(to - from) / step) + 1;
}

function buildNumbers({ from, to, step }, limit) {
  const numbers = [];
  const descending = to < from;
  for (
    let value = from;
    descending ? value >= to : value <= to;
    value += descending ? -step : step
  ) {
    numbers.push(value);
    if (numbers.length >= limit) break;
  }
  return numbers;
}

function renderLine(template, number, index) {
  if (!template) return String(number);
  return template
    .replace(/\{n\}/gi, String(number))
    .replace(/\{i\}/gi, String(index));
}

module.exports = {
  name: "loop",
  aliases: ["repeat", "كرر", "تكرار"],
  description: "يكرر نص أو أرقام — في رسالة واحدة أو رسائل منفصلة.",
  usage:
    "loop <عدد|من-إلى[:خطوة]> [النص] [-s رسائل منفصلة] [-n بدون ترقيم]",
  chat: "all",

  async execute(sock, msg, args) {
    const chatId = msg.key.remoteJid;
    const reply = (text) => sendBotMessage(sock, chatId, { text }, { replyTo: msg });

    // Pull the flags out wherever the user put them.
    let split = false;
    let numbered = true;
    const rest = [];
    for (const arg of args) {
      const token = arg.toLowerCase();
      if (SPLIT_FLAGS.has(token)) split = true;
      else if (NO_NUMBER_FLAGS.has(token)) numbered = false;
      else rest.push(arg);
    }

    const range = parseRange(rest[0]);
    if (!range) return reply(HELP_TEXT);

    const template = rest.slice(1).join(" ").trim();
    const limit = split ? MAX_SPLIT_ITEMS : MAX_ITEMS;
    const requested = countOf(range);

    if (requested < 1) return reply("❌ المدى ده مش بيطلع أي أرقام.");
    if (requested > limit) {
      return reply(
        `❌ ${requested} تكرار كتير أوي.\n` +
          `الحد الأقصى ${limit} ${split ? "رسالة منفصلة" : "تكرار في الرسالة الواحدة"}.`
      );
    }

    const numbers = buildNumbers(range, limit);
    if (!numbers.length) return reply("❌ المدى ده مش بيطلع أي أرقام.");

    // A bare count with text repeats the text; a range without text prints the
    // numbers. Either way {n}/{i} are substituted per line.
    const lines = numbers.map((number, index) =>
      renderLine(template, number, index + 1)
    );

    if (split) {
      for (let i = 0; i < lines.length; i++) {
        const body = numbered ? `${i + 1}. ${lines[i]}` : lines[i];
        await sendBotMessage(
          sock,
          chatId,
          { text: body },
          { replyTo: i === 0 ? msg : null, typing: false, delayMs: SPLIT_GAP_MS }
        );
      }
      return;
    }

    let text = lines
      .map((line, i) => (numbered ? `${i + 1}. ${line}` : line))
      .join("\n");

    if (text.length > MAX_OUTPUT_CHARS) {
      text = `${text.slice(0, MAX_OUTPUT_CHARS)}\n…\n_(اتقصت عشان طولها)_`;
    }

    return reply(text);
  },
};

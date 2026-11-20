// Deterministic Auto Reply acknowledgements.
//
// A whole message that is only thanks or only laughter gets a WhatsApp
// reaction without a model call. Matching is on the WHOLE normalized message:
// "thanks, now do X", a question, or a command is never an acknowledgement.
// Four reply languages: ar, en, pt-BR, es-419. Pure module, no I/O.

const THANKS_EMOJI = "❤️";
const LAUGHTER_EMOJI = "😂";
const MAX_ACK_LENGTH = 80;

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

// Compared with U+FE0F removed, so "❤️" and "❤" are the same entry.
const LAUGHTER_EMOJIS = new Set(["😂", "🤣", "😹", "😆"]);
const HEART_EMOJIS = new Set([
  "❤",
  "♥",
  "❣",
  "🧡",
  "💛",
  "💚",
  "💙",
  "💜",
  "🖤",
  "🤍",
  "🤎",
  "🩷",
  "🩵",
  "🩶",
  "💕",
  "💖",
  "💗",
  "💓",
  "💞",
  "💘",
  "💝",
  "❤\u200d🔥",
  "❤\u200d🩹",
]);

const THANKS_PHRASES = [
  // en
  "thanks",
  "thank you",
  "thank u",
  "thanks a lot",
  "thanks so much",
  "thanks a bunch",
  "thank you so much",
  "thank you very much",
  "many thanks",
  "much appreciated",
  "appreciate it",
  "thx",
  "thnx",
  "tnx",
  "ty",
  "tysm",
  "tyvm",
  // ar
  "شكرا",
  "شكرا جزيلا",
  "شكرا لك",
  "شكرا ليك",
  "شكرا ليكي",
  "شكرا كتير",
  "شكرا كثيرا",
  "الف شكر",
  "متشكر",
  "متشكرة",
  "متشكرين",
  "مشكور",
  "مشكورة",
  "تسلم",
  "تسلمي",
  "تسلم ايدك",
  "تسلمي ايدك",
  "يسلمو",
  "يسلموا",
  "جزاك الله خيرا",
  "جزاك الله خير",
  "يعطيك العافية",
  "ميرسي",
  "مرسي",
  // pt-BR
  "obrigado",
  "obrigada",
  "obrigadão",
  "muito obrigado",
  "muito obrigada",
  "obg",
  "brigado",
  "brigada",
  "valeu",
  "valeu mesmo",
  "vlw",
  "agradeço",
  "grato",
  "grata",
  // es-419
  "gracias",
  "muchas gracias",
  "mil gracias",
  "muchísimas gracias",
  "gracias totales",
  "grax",
  "te agradezco",
  "se agradece",
];

// A thanks phrase may open with one filler and close with one form of address.
const LEADING_FILLERS = ["ok", "okay", "تمام", "طيب", "ماشي", "beleza", "vale", "dale", "listo"];
const TRAILING_ADDRESS = [
  "bro",
  "man",
  "dude",
  "buddy",
  "mate",
  "sir",
  "boss",
  "friend",
  "bot",
  "يا باشا",
  "يا معلم",
  "يا غالي",
  "يا حبيبي",
  "حبيبي",
  "يا صاحبي",
  "cara",
  "mano",
  "amigo",
  "amiga",
  "hermano",
];

const LAUGH_WORDS = new Set(["lol", "lmao", "lmfao", "rofl", "xd"]);

// Tested on the message with spaces removed. `raw` keeps repeated letters,
// `collapsed` has every run of one letter reduced to a single letter.
const LAUGH_RAW = [/^ه{2,}[هخ]*$/u, /^خ{3,}$/u, /^h{3,}$/u, /^k{3,}$/u];
const LAUGH_COLLAPSED = [
  /^(?:ha){2,}h?$/u,
  /^(?:ah){2,}a?$/u,
  /^(?:he){2,}h?$/u,
  /^(?:ja){2,}j?$/u,
  /^(?:je){2,}j?$/u,
  /^(?:js){2,}j?$/u,
  /^(?:rs){2,}r?$/u,
  /^(?:lo)+l$/u,
  /^(?:ها){2,}$/u,
];

function collapse(value) {
  return value.replace(/(\p{L})\1+/gu, "$1");
}

/**
 * Lowercase, accents and Arabic diacritics removed, punctuation to spaces,
 * whitespace collapsed. Repeated letters are NOT collapsed here; see
 * normalizeAckText for the full form.
 */
function baseNormalize(value) {
  return String(value)
    .normalize("NFD")
    .replace(/\p{Mn}/gu, "")
    .normalize("NFC")
    .replace(/\u0640/gu, "")
    .replace(/ة/gu, "ه")
    .replace(/ى/gu, "ي")
    .toLowerCase()
    .replace(/\p{P}+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/** The form every phrase list entry and every message is compared in. */
function normalizeAckText(value) {
  return collapse(baseNormalize(value));
}

const THANKS = new Set(THANKS_PHRASES.map(normalizeAckText));
const FILLERS = LEADING_FILLERS.map(normalizeAckText);
const ADDRESS = TRAILING_ADDRESS.map(normalizeAckText);

function emojiKind(grapheme) {
  const bare = grapheme.replace(/\uFE0F/gu, "");
  if (LAUGHTER_EMOJIS.has(bare)) return "laughter";
  if (HEART_EMOJIS.has(bare)) return "thanks";
  return null;
}

function isLaughter(spaced) {
  const raw = spaced.replace(/\s+/gu, "");
  if (!raw) return false;
  const collapsed = collapse(raw);
  if (LAUGH_WORDS.has(collapsed)) return true;
  return (
    LAUGH_RAW.some((pattern) => pattern.test(raw)) ||
    LAUGH_COLLAPSED.some((pattern) => pattern.test(collapsed))
  );
}

function isThanks(spaced) {
  let core = collapse(spaced);
  for (const filler of FILLERS) {
    if (core.startsWith(`${filler} `)) {
      core = core.slice(filler.length + 1);
      break;
    }
  }
  for (const address of ADDRESS) {
    if (core.endsWith(` ${address}`)) {
      core = core.slice(0, -(address.length + 1));
      break;
    }
  }
  return THANKS.has(core);
}

function result(kind) {
  if (kind === "thanks") return Object.freeze({ kind, emoji: THANKS_EMOJI });
  if (kind === "laughter") return Object.freeze({ kind, emoji: LAUGHTER_EMOJI });
  return null;
}

/**
 * { kind: "thanks" | "laughter", emoji } when the whole message is an
 * acknowledgement, else null.
 */
function classifyAcknowledgement(text) {
  if (typeof text !== "string") return null;
  const raw = text.normalize("NFC").trim();
  if (!raw || raw.length > MAX_ACK_LENGTH) return null;
  // A question or a command is a request, never an acknowledgement.
  if (/[?؟¿]/u.test(raw)) return null;
  if (/^[!/.#$%&*+=~^\\|<>@]/u.test(raw)) return null;

  // Peel trailing laughter/heart emoji, spaces and punctuation.
  const graphemes = Array.from(segmenter.segment(raw), (entry) => entry.segment);
  const tailKinds = new Set();
  let end = graphemes.length;
  while (end > 0) {
    const grapheme = graphemes[end - 1];
    if (/^[\s\p{P}]+$/u.test(grapheme)) {
      end -= 1;
      continue;
    }
    const kind = emojiKind(grapheme);
    if (!kind) break;
    tailKinds.add(kind);
    end -= 1;
  }
  const head = graphemes.slice(0, end).join("");
  if (!head.trim()) {
    // Emoji only: all laughter or all hearts. A mix is left to the model.
    return tailKinds.size === 1 ? result([...tailKinds][0]) : null;
  }

  const spaced = baseNormalize(head);
  if (!spaced) return null;
  if (isLaughter(spaced)) return result("laughter");
  if (isThanks(spaced)) return result("thanks");
  return null;
}

module.exports = {
  classifyAcknowledgement,
  normalizeAckText,
  THANKS_EMOJI,
  LAUGHTER_EMOJI,
  MAX_ACK_LENGTH,
};

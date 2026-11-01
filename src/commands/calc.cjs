// آلة حاسبة — !calc
//
// A self-contained expression evaluator. Deliberately NOT `eval()`: the input
// comes straight from any group member, so we tokenize and parse it ourselves
// and only ever touch the whitelisted functions below.
//
// Supports: + - * / % ^ (and ** ), parentheses, unary minus, implicit
// multiplication (2(3+4), 3pi), postfix factorial (5!), percentages
// (15%, «20% من 300»), Arabic-Indic digits, and the math functions listed in
// FUNCTIONS.

const { sendBotMessage } = require("../utils/sendBotMessage.cjs");
const { t } = require("../utils/i18n.cjs");

// ---------------------------------------------------------------------------
// whitelist
// ---------------------------------------------------------------------------

const CONSTANTS = {
  pi: Math.PI,
  π: Math.PI,
  e: Math.E,
  tau: Math.PI * 2,
};

const DEG = Math.PI / 180;

const FUNCTIONS = {
  sqrt: { arity: 1, fn: Math.sqrt },
  cbrt: { arity: 1, fn: Math.cbrt },
  abs: { arity: 1, fn: Math.abs },
  round: { arity: 1, fn: Math.round },
  floor: { arity: 1, fn: Math.floor },
  ceil: { arity: 1, fn: Math.ceil },
  sign: { arity: 1, fn: Math.sign },
  ln: { arity: 1, fn: Math.log },
  log: { arity: 1, fn: Math.log10 },
  log2: { arity: 1, fn: Math.log2 },
  exp: { arity: 1, fn: Math.exp },
  sin: { arity: 1, fn: Math.sin },
  cos: { arity: 1, fn: Math.cos },
  tan: { arity: 1, fn: Math.tan },
  asin: { arity: 1, fn: Math.asin },
  acos: { arity: 1, fn: Math.acos },
  atan: { arity: 1, fn: Math.atan },
  // Degree variants — nobody types sin(rad(30)) in a chat.
  sind: { arity: 1, fn: (x) => Math.sin(x * DEG) },
  cosd: { arity: 1, fn: (x) => Math.cos(x * DEG) },
  tand: { arity: 1, fn: (x) => Math.tan(x * DEG) },
  deg: { arity: 1, fn: (x) => x / DEG },
  rad: { arity: 1, fn: (x) => x * DEG },
  fact: { arity: 1, fn: (x) => factorial(x) },
  pow: { arity: 2, fn: Math.pow },
  root: { arity: 2, fn: (x, n) => (n % 2 === 0 || x >= 0 ? x ** (1 / n) : -((-x) ** (1 / n))) },
  hypot: { arity: -1, fn: (...a) => Math.hypot(...a) },
  min: { arity: -1, fn: (...a) => Math.min(...a) },
  max: { arity: -1, fn: (...a) => Math.max(...a) },
  avg: { arity: -1, fn: (...a) => a.reduce((s, x) => s + x, 0) / a.length },
  sum: { arity: -1, fn: (...a) => a.reduce((s, x) => s + x, 0) },
};

function factorial(n) {
  if (!Number.isInteger(n)) {
    throw new CalcError(
      t("bot.tools.calc.factorialWholeNumbers"),
    );
  }
  if (n < 0) throw new CalcError(t("bot.tools.calc.factorialNegative"));
  if (n > 170) return Infinity; // beyond this a double is Infinity anyway
  let result = 1;
  for (let i = 2; i <= n; i++) result *= i;
  return result;
}

class CalcError extends Error {}

// ---------------------------------------------------------------------------
// normalisation
// ---------------------------------------------------------------------------

const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

function normalize(input) {
  let text = String(input || "");

  // Arabic-Indic / Persian digits -> ASCII
  text = text.replace(/[٠-٩]/g, (d) => String(ARABIC_DIGITS.indexOf(d)));
  text = text.replace(/[۰-۹]/g, (d) => String(PERSIAN_DIGITS.indexOf(d)));

  // Arabic decimal separator + the symbols people paste from calculators
  text = text
    .replace(/٫/g, ".")
    .replace(/\*\*/g, "^")
    .replace(/[×✕✖]/g, "*")
    .replace(/[÷➗]/g, "/")
    .replace(/[−–—]/g, "-")
    .replace(/(\d)\s*[xX]\s*(\d)/g, "$1*$2") // «3 x 4»
    // thousands separators only — a comma between function arguments stays put
    // (write `max(3, 900)` with a space so it isn't read as 3900)
    .replace(/(?<=\d),(?=\d{3}(?!\d))/g, "");

  // «20% من 300» / «20% of 300» -> (20/100)*300, so % stays modulo elsewhere.
  text = text.replace(/(\d+(?:\.\d+)?)\s*%\s*(?:of|من)\s*/gi, (_, value) => `(${value}/100)*`);

  return text.trim();
}

// ---------------------------------------------------------------------------
// tokenizer
// ---------------------------------------------------------------------------

function tokenize(text) {
  const tokens = [];
  let i = 0;

  while (i < text.length) {
    const char = text[i];

    if (/\s/.test(char)) {
      i++;
      continue;
    }

    if (/[0-9.]/.test(char)) {
      let raw = "";
      while (i < text.length && /[0-9.]/.test(text[i])) raw += text[i++];
      // scientific notation: 1e5, 2.5e-3
      const signed = /[+-]/.test(text[i + 1] || "");
      const exponentDigit = signed ? text[i + 2] : text[i + 1];
      if (/[eE]/.test(text[i] || "") && /[0-9]/.test(exponentDigit || "")) {
        raw += text[i++];
        if (signed) raw += text[i++];
        while (i < text.length && /[0-9]/.test(text[i])) raw += text[i++];
      }
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        throw new CalcError(t("bot.tools.calc.invalidNumber", { raw }));
      }
      tokens.push({ type: "num", value });
      continue;
    }

    if (/[a-zA-Zπ_]/.test(char)) {
      let name = "";
      while (i < text.length && /[a-zA-Z0-9π_]/.test(text[i])) name += text[i++];
      tokens.push({ type: "ident", value: name.toLowerCase() });
      continue;
    }

    if ("+-*/%^()!,".includes(char)) {
      tokens.push({ type: char });
      i++;
      continue;
    }

    throw new CalcError(t("bot.tools.calc.unknownSymbol", { char }));
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// parser (recursive descent)
// ---------------------------------------------------------------------------

function parse(tokens) {
  let pos = 0;

  const peek = (offset = 0) => tokens[pos + offset];
  const eat = (type) => {
    if (peek()?.type !== type) return null;
    return tokens[pos++];
  };
  const expect = (type, message) => {
    const token = eat(type);
    if (!token) throw new CalcError(message);
    return token;
  };

  // A token that can start a value — used for implicit multiplication.
  const startsValue = (token) =>
    !!token && (token.type === "num" || token.type === "ident" || token.type === "(");

  function parseExpression() {
    let left = parseTerm();
    for (;;) {
      if (eat("+")) left += parseTerm();
      else if (eat("-")) left -= parseTerm();
      else return left;
    }
  }

  function parseTerm() {
    let left = parseUnary();
    for (;;) {
      if (eat("*")) {
        left *= parseUnary();
      } else if (eat("/")) {
        const right = parseUnary();
        if (right === 0) {
          throw new CalcError(t("bot.tools.calc.divisionByZero"));
        }
        left /= right;
      } else if (peek()?.type === "%" && startsValue(peek(1))) {
        // infix `%` is modulo; the postfix «15%» form is handled in parsePostfix
        pos++;
        const right = parseUnary();
        if (right === 0) {
          throw new CalcError(t("bot.tools.calc.moduloByZero"));
        }
        left %= right;
      } else if (startsValue(peek())) {
        // implicit multiplication: 2(3+4), 3pi, 2sqrt(9)
        left *= parseUnary();
      } else {
        return left;
      }
    }
  }

  function parseUnary() {
    if (eat("-")) return -parseUnary();
    if (eat("+")) return parseUnary();
    return parsePower();
  }

  function parsePower() {
    const base = parsePostfix();
    if (eat("^")) return base ** parseUnary(); // right-associative
    return base;
  }

  function parsePostfix() {
    let value = parsePrimary();
    for (;;) {
      if (eat("!")) {
        value = factorial(value);
      } else if (peek()?.type === "%" && !startsValue(peek(1))) {
        pos++;
        value /= 100;
      } else {
        return value;
      }
    }
  }

  function parsePrimary() {
    const token = peek();
    if (!token) throw new CalcError(t("bot.tools.calc.emptyExpression"));

    if (eat("(")) {
      const value = parseExpression();
      expect(")", t("bot.tools.calc.unclosedBracket"));
      return value;
    }

    if (token.type === "num") {
      pos++;
      return token.value;
    }

    if (token.type === "ident") {
      pos++;
      const name = token.value;

      if (FUNCTIONS[name]) {
        const spec = FUNCTIONS[name];
        expect(
          "(",
          t("bot.tools.calc.needsBrackets", { name }),
        );
        const args = [];
        if (peek()?.type !== ")") {
          args.push(parseExpression());
          while (eat(",")) args.push(parseExpression());
        }
        expect(")", t("bot.tools.calc.unfinishedBracket", { name }));
        if (spec.arity !== -1 && args.length !== spec.arity) {
          throw new CalcError(
            t("bot.tools.calc.functionArity", { name, count: spec.arity }),
          );
        }
        if (!args.length) {
          throw new CalcError(
            t("bot.tools.calc.functionNoValues", { name }),
          );
        }
        return spec.fn(...args);
      }

      if (name in CONSTANTS) return CONSTANTS[name];

      throw new CalcError(t("bot.tools.calc.unknownName", { name }));
    }

    throw new CalcError(
      t("bot.tools.calc.wrongTokenPlace", { symbol: token.type }),
    );
  }

  const result = parseExpression();
  if (pos < tokens.length) {
    throw new CalcError(
      t("bot.tools.calc.trailingContent"),
    );
  }
  return result;
}

function evaluate(expression) {
  const normalized = normalize(expression);
  if (!normalized) throw new CalcError(t("bot.tools.calc.typeExpression"));
  if (normalized.length > 300) {
    throw new CalcError(t("bot.tools.calc.expressionTooLong"));
  }

  const value = parse(tokenize(normalized));
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new CalcError(t("bot.tools.calc.invalidResult"));
  }
  return { normalized, value };
}

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

function formatNumber(value) {
  if (!Number.isFinite(value)) return value > 0 ? "∞" : "-∞";
  if (Number.isInteger(value) && Math.abs(value) < 1e15) {
    return value.toLocaleString("en-US");
  }
  const absolute = Math.abs(value);
  if (absolute !== 0 && (absolute >= 1e15 || absolute < 1e-7)) {
    return value.toExponential(6).replace(/e([+-])(\d)$/, "e$10$2");
  }
  // 0.1 + 0.2 should read 0.3, not 0.30000000000000004
  const cleaned = Number(value.toPrecision(12));
  const [whole, fraction] = String(cleaned).split(".");
  const grouped = Number(whole).toLocaleString("en-US");
  return fraction ? `${grouped}.${fraction}` : grouped;
}

const helpText = () => t("bot.tools.calc.help");

module.exports = {
  name: "calc",
  aliases: ["calculate", "حساب", "احسب", "="],
  description: {
    en: "Calculator: arithmetic, percentages, powers and math functions.",
    ar: "آلة حاسبة: عمليات حسابية، ونِسب مئوية، وأُسس، ودوال رياضية.",
  },
  usage: {
    en: "calc <expression>",
    ar: "calc <معادلة>",
  },
  chat: "all",

  async execute(sock, msg, args) {
    const chatId = msg.key.remoteJid;

    // Fall back to the quoted message so «رد على الرقم واكتب !calc» works.
    const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    const quotedText = quoted?.conversation || quoted?.extendedTextMessage?.text || "";

    const expression = args.join(" ").trim() || quotedText.trim();

    if (!expression) {
      return sendBotMessage(sock, chatId, { text: helpText() }, { replyTo: msg });
    }

    try {
      const { normalized, value } = evaluate(expression);
      return sendBotMessage(
        sock,
        chatId,
        {
          text: `🧮 \`${normalized}\`\n` + `*=* ${formatNumber(value)}`,
        },
        { replyTo: msg },
      );
    } catch (error) {
      const reason =
        error instanceof CalcError
          ? error.message
          : t("bot.tools.calc.unclearExpression");
      return sendBotMessage(
        sock,
        chatId,
        {
          text: t("bot.tools.calc.errorWithHint", { reason }),
        },
        { replyTo: msg },
      );
    }
  },

  // exported for reuse / quick sanity checks
  _evaluate: evaluate,
  _format: formatNumber,
};

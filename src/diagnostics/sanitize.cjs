// The one diagnostics text sanitizer (contract section 4).
//
// Anything a crash report or a feedback diagnostics object can carry — an error
// message, a stack frame, a breadcrumb name — is put through here before it is
// stored locally and again before it leaves the device. The point is narrow and
// absolute: a report must never carry a WhatsApp identity, an e-mail address, a
// phone number, a URL's query string, an API key or a token, or an absolute
// path that names the machine it came from.
//
// It is deliberately the same function on every side (Levix Node here, Android
// at capture, levix-ui on receipt), so a value cannot survive one hop and be
// scrubbed on the next.

const os = require("node:os");
const { DATA_DIR } = require("../config/paths.cjs");

// A WhatsApp JID in any of the v7 shapes: phone, group, LID, broadcast,
// newsletter. `[^\s@]+` rather than `\S+` so the match cannot swallow an
// earlier `@` and leave its tail behind.
const JID_PATTERN = /[^\s@]+@(?:s\.whatsapp\.net|g\.us|lid|broadcast|newsletter)\b/gi;

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

// Scheme + authority; the tail (path, query, fragment) is dropped.
const URL_PATTERN = /(https?):\/\/([^\s/?#]+)([^\s]*)/gi;

// 24+ chars from the URL-safe alphabet. A value that is only digits is left for
// the number rule, so a long phone number still reads as <number>.
const SECRET_PATTERN = /[A-Za-z0-9_+\-/=]{24,}/g;

const NUMBER_PATTERN = /\+?\d{7,}/g;

/**
 * Control characters mangle text on the way out and cannot be rendered anyway.
 * Tabs and line breaks are kept: a multi-line message or stack is still content
 * the operator may need to read.
 */
function stripControl(value) {
  let out = "";
  for (const char of String(value ?? "")) {
    const code = char.codePointAt(0);
    const control = code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
    if (!control || char === "\n" || char === "\r" || char === "\t") out += char;
  }
  return out;
}

/** Replace one occurrence of a literal string (no regex escaping to get wrong). */
function replaceLiteral(text, needle, replacement) {
  if (!needle || !text.includes(needle)) return text;
  return text.split(needle).join(replacement);
}

function collapseUrl(_match, scheme, authority, rest) {
  const base = `${scheme}://${authority}`;
  return rest ? `${base}/<path>` : base;
}

/**
 * Sanitize one value. `max` (when > 0) is the hard length cap applied after the
 * substitutions, matching the per-field caps in the contract.
 *
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
function sanitizeText(value, max = 0) {
  let text = stripControl(value);

  // Order matters. URLs first so a path is gone before the raw path rules can
  // rewrite a URL's own path; identities before the generic token rule so a JID
  // reads as <jid> rather than as several fragments.
  text = text.replace(URL_PATTERN, collapseUrl);
  text = text.replace(JID_PATTERN, "<jid>");
  text = text.replace(EMAIL_PATTERN, "<email>");

  // Absolute paths that name the install, then the user's home.
  text = replaceLiteral(text, DATA_DIR, "<data>");
  text = replaceLiteral(text, os.homedir(), "~");

  // Secrets before numbers: a long key that happens to contain digits is fully
  // redacted, while a pure-digit run falls through to <number>.
  text = text.replace(SECRET_PATTERN, (match) => (/^\+?\d+$/.test(match) ? match : "<secret>"));
  text = text.replace(NUMBER_PATTERN, "<number>");

  text = text.trim();
  return max > 0 ? text.slice(0, max) : text;
}

module.exports = { sanitizeText, stripControl };

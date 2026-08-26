// Text decoding helpers shared by the scrapers, the downloaders and the AI
// agent. Arabic is where every shortcut shows up, so this is the one place
// that knows how to turn "what the network gave us" into real characters.
//
// Four separate problems, four fixes:
//
//   1. charset          - a page served as windows-1256 (still common on Arab
//                         sites) decoded as UTF-8 is unreadable. decodeBuffer()
//                         reads the charset from the Content-Type header or the
//                         <meta charset> tag and decodes accordingly.
//   2. HTML entities    - Facebook happily emits `&#1575;&#1604;` and `&quot;`
//                         in og:title. Nothing downstream decoded those.
//   3. JS/JSON escapes  - the embedded JSON blobs carry `ال` and
//                         `\/`. Surrogate pairs (emoji) must survive.
//   4. mojibake         - UTF-8 bytes that were already decoded as latin1
//                         (the classic two-characters-per-letter soup).

const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  laquo: "«",
  raquo: "»",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
  middot: "·",
  bull: "•",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  euro: "€",
  pound: "£",
  times: "×",
  divide: "÷",
};

/** `&#1575;` / `&#x627;` / `&quot;` -> the real character. */
function decodeHtmlEntities(text) {
  if (!text || typeof text !== "string" || !text.includes("&")) return text;
  return text
    .replace(/&#x([0-9a-f]+);/gi, (match, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    })
    .replace(/&#(\d+);/g, (match, dec) => {
      const code = Number(dec);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    })
    .replace(/&([a-z]+);/gi, (match, name) => {
      const value = NAMED_ENTITIES[name.toLowerCase()];
      return value === undefined ? match : value;
    });
}

/**
 * `ا`, `\xe9`, `\/`, `\n` -> the real character.
 * fromCharCode per unit keeps surrogate pairs (emoji) intact, because the two
 * halves are emitted next to each other and re-pair naturally.
 */
function decodeEscapes(text) {
  if (!text || typeof text !== "string" || !text.includes("\\")) return text;
  return text
    .replace(/\\u([0-9a-f]{4})/gi, (match, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    )
    .replace(/\\x([0-9a-f]{2})/gi, (match, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    )
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\r/g, "")
    .replace(/\\\//g, "/")
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, "\\");
}

// The tell-tale pair that appears when UTF-8 bytes are decoded as latin1: a
// lead byte (0xC2-0xDF) followed by a continuation byte that landed in the
// latin1 supplement or the cp1252 punctuation block.
const MOJIBAKE_HINT =
  /[Â-ß][-¿–—‘-„†-•…‰‹›€™ŒœŠšŸŽžƒˆ˜]/;

function textScore(text) {
  let score = 0;
  for (const char of text) {
    const code = char.codePointAt(0);
    // Arabic block, ASCII letters/digits and plain punctuation are "good"
    if (code >= 0x0600 && code <= 0x06ff) score += 2;
    else if (code < 0x80) score += 1;
    // the latin1 supplement is what mojibake is made of
    else if (code >= 0x80 && code <= 0xff) score -= 2;
  }
  return score;
}

/** Recover text that was already mis-decoded as latin1. */
function repairMojibake(text) {
  if (!text || typeof text !== "string") return text;
  if (!MOJIBAKE_HINT.test(text)) return text;
  try {
    const repaired = Buffer.from(text, "binary").toString("utf8");
    if (repaired.includes("�")) return text;
    return textScore(repaired) > textScore(text) ? repaired : text;
  } catch {
    return text;
  }
}

// Plain spaces, tabs, non-breaking spaces, zero-width characters and the bidi
// marks Arabic pages are full of - all collapse to a single space.
const NOISE_SPACE = /[ \t ​-‏‪-‮﻿]+/g;

/** Everything above, in the order that actually works. */
function decodeText(text) {
  if (!text || typeof text !== "string") return text;
  let out = decodeEscapes(text);
  out = decodeHtmlEntities(out);
  out = repairMojibake(out);
  return out.replace(NOISE_SPACE, " ").trim();
}

/** Charset name from a Content-Type header and/or an HTML <meta> tag. */
function detectCharset(contentType, headSample) {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType || "");
  if (fromHeader) return fromHeader[1].toLowerCase();

  if (headSample) {
    const meta =
      /<meta[^>]+charset=["']?([\w-]+)/i.exec(headSample) ||
      /<meta[^>]+content=["'][^"']*charset=([\w-]+)/i.exec(headSample);
    if (meta) return meta[1].toLowerCase();
  }
  return "utf-8";
}

/**
 * Decode a response body with the right charset.
 * Node ships full ICU, so windows-1256 / iso-8859-6 (the two encodings Arabic
 * pages still use) decode natively; anything unknown falls back to UTF-8.
 */
function decodeBuffer(buffer, contentType) {
  if (!Buffer.isBuffer(buffer)) return String(buffer == null ? "" : buffer);

  // Sniff the first 2 KB as latin1 to find a <meta charset> without committing
  // to an encoding yet.
  const sample = buffer.subarray(0, 2048).toString("latin1");
  let charset = detectCharset(contentType, sample);
  if (charset === "utf8") charset = "utf-8";

  if (charset === "utf-8" || charset === "us-ascii" || charset === "ascii") {
    return buffer.toString("utf8");
  }

  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return buffer.toString("utf8");
  }
}

/** HTML -> readable plain text (used when the agent opens a page). */
function stripHtml(html) {
  if (!html || typeof html !== "string") return "";
  return decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<\/(p|div|li|tr|h[1-6]|br)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(NOISE_SPACE, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

module.exports = {
  decodeHtmlEntities,
  decodeEscapes,
  repairMojibake,
  decodeText,
  detectCharset,
  decodeBuffer,
  stripHtml,
};

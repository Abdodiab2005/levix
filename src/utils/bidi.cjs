// Display isolation for a value interpolated into a sentence.
//
// A Latin pack name inside an Arabic reply (or the reverse) reorders around the
// punctuation next to it: "حُفظ الملصق في My Pack." can render as
// "My Pack. حُفظ الملصق في". First-Strong-Isolate / Pop-Directional-Isolate
// (U+2068 … U+2069) pin the value's own direction without leaking it to the
// surrounding text. The characters are invisible; they only order the run.
//
// Keep this dependency-free: the sticker errors, the bot helpers and the
// commands all reach it, and none of them may form a cycle.

const FSI = "\u2068";
const PDI = "\u2069";

/** Isolate `value` for safe interpolation into a message. */
function isolate(value) {
  const text = String(value ?? "");
  return text ? `${FSI}${text}${PDI}` : text;
}

module.exports = { isolate, FSI, PDI };

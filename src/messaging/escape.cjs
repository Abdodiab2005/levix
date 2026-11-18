// Strip control and bidi-override characters, and neutralize braces so a
// parameter cannot invent a catalog placeholder. Used by renderMessage and
// by the Plus template-override path.

function escapeParam(value) {
  let out = "";
  for (const char of String(value ?? "")) {
    const code = char.codePointAt(0);
    const keep = code === 0x09 || code === 0x0a || code === 0x0d;
    const control = code <= 0x1f || code === 0x7f;
    const bidi = (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
    if (!keep && (control || bidi)) continue;
    if (char === "{") out += "｛";
    else if (char === "}") out += "｝";
    else out += char;
  }
  return out;
}

function hasForbiddenChars(text) {
  for (const char of String(text ?? "")) {
    const code = char.codePointAt(0);
    const keep = code === 0x09 || code === 0x0a || code === 0x0d;
    const control = code <= 0x1f || code === 0x7f;
    const bidi = (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
    if (!keep && (control || bidi)) return true;
  }
  return false;
}

module.exports = { escapeParam, hasForbiddenChars };

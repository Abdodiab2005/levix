// Dates, versions, URLs and e-mail addresses stay left-to-right inside Arabic.
// Plain Latin words (Levix, SHA-256) are not tokens: the bidi algorithm already
// orders a strong Latin run. Weak digits and punctuation do not. Slices join
// back to the input.

const URL_TOKEN = /https?:\/\/[A-Za-z0-9._~:/?#@!$&'*+,;=%()[\]-]+/y;
// Trailing .,;:) and closing quotes stay outside the URL. Quotes are not URL
// characters, so they never enter the match; the tail peels the punctuation.
const URL_TAIL = /[.,;:)"'\u2019\u201d\u00bb\u203a\u00ab]+$/;
const EMAIL_BODY = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/y;
const ISO_DATE_BODY = /\d{4}-\d{2}-\d{2}(?:\.\d+)?/y;
const VERSION_BODY = /\d+\.\d+\.\d+(?:\.\d+)*(?:\+[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*)?/y;

const EMAIL_CHAR = /[A-Za-z0-9._%+-]/;

function startsAt(pattern, text, index) {
  pattern.lastIndex = index;
  const match = pattern.exec(text);
  return match ? match[0] : "";
}

function tokenAt(text, index) {
  const url = startsAt(URL_TOKEN, text, index);
  if (url) {
    const trimmed = url.replace(URL_TAIL, "");
    if (trimmed) return trimmed;
  }

  const previous = index > 0 ? text[index - 1] : "";
  if (!EMAIL_CHAR.test(previous)) {
    const email = startsAt(EMAIL_BODY, text, index);
    const after = text[index + email.length] ?? "";
    // A trailing dot or comma is sentence punctuation, not part of the address.
    if (email && !/[A-Za-z0-9]/.test(after)) return email;
  }
  if (!/\d/.test(previous)) {
    const date = startsAt(ISO_DATE_BODY, text, index);
    const after = text[index + date.length] ?? "";
    if (date && !/\d/.test(after)) return date;
  }
  if (!/[\d.]/.test(previous)) {
    const version = startsAt(VERSION_BODY, text, index);
    const after = text[index + version.length] ?? "";
    if (version && !/\d/.test(after)) return version;
  }
  return "";
}

/** @returns {{ text: string, ltr: boolean }[]} */
export function ltrSegments(text) {
  const segments = [];
  let cursor = 0;
  let plainStart = 0;
  while (cursor < text.length) {
    const token = tokenAt(text, cursor);
    if (!token) {
      cursor += 1;
      continue;
    }
    if (cursor > plainStart) segments.push({ text: text.slice(plainStart, cursor), ltr: false });
    segments.push({ text: token, ltr: true });
    cursor += token.length;
    plainStart = cursor;
  }
  if (plainStart < text.length) segments.push({ text: text.slice(plainStart), ltr: false });
  return segments;
}

const PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g;

/** `{name}` rules match fill.ts. Values are LTR. Unknown placeholders stay literal. */
export function templateSegments(template, vars) {
  const segments = [];
  const input = String(template);
  let cursor = 0;
  PLACEHOLDER.lastIndex = 0;
  let match = PLACEHOLDER.exec(input);
  while (match) {
    if (match.index > cursor) {
      segments.push({ text: input.slice(cursor, match.index), ltr: false });
    }
    const key = match[1];
    if (Object.hasOwn(vars, key)) segments.push({ text: String(vars[key]), ltr: true });
    else segments.push({ text: match[0], ltr: false });
    cursor = match.index + match[0].length;
    match = PLACEHOLDER.exec(input);
  }
  if (cursor < input.length) segments.push({ text: input.slice(cursor), ltr: false });
  return segments;
}

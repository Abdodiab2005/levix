// Numeric caps copied from src/stickers/limits.cjs. The server remains the authority.

export const UPLOAD_MAX_BYTES = 16 * 1024 * 1024;
export const EXPORT_MAX_IDS = 200;
export const SEND_MAX_IDS = 10;
export const PACK_NAME_MAX = 40;
export const STICKER_NAME_MAX = 60;
export const PAGE_SIZE = 60;

// Mirrors `QUOTE_PAIRS` in src/stickers/library.cjs: one surrounding pair is
// decoration, not part of the name.
const QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ["“", "”"],
  ["«", "»"],
  ["„", "‟"],
  ["‹", "›"],
];

const GRAPHEMES: Intl.Segmenter | null =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter("en", { granularity: "grapheme" })
    : null;

function stripQuotes(raw: string): string {
  const text = raw.trim();
  if (text.length < 2) return text;
  for (const [open, close] of QUOTE_PAIRS) {
    if (
      text.startsWith(open) &&
      text.endsWith(close) &&
      text.length > open.length + close.length - 1
    ) {
      return text.slice(open.length, text.length - close.length).trim();
    }
  }
  return text;
}

function graphemeLength(text: string): number {
  if (!GRAPHEMES) return [...text].length;
  let length = 0;
  for (const _ of GRAPHEMES.segment(text)) length += 1;
  return length;
}

/**
 * Client-side length check. Character class and reserved words are the server's.
 * Matches `normalizePackName` in `src/stickers/library.cjs`: strip one
 * surrounding quote pair, NFC, collapse whitespace, trim, count graphemes.
 */
export function packNameLengthError(name: string): "empty" | "long" | null {
  const normalized = stripQuotes(name).normalize("NFC").replace(/\s+/g, " ").trim();
  const length = graphemeLength(normalized);
  if (length < 1) return "empty";
  if (length > PACK_NAME_MAX) return "long";
  return null;
}

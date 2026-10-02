// Numeric caps copied from src/stickers/limits.cjs. The server remains the authority.

export const EXPORT_MAX_IDS = 200;
export const SEND_MAX_IDS = 10;
export const PACK_NAME_MAX = 40;
export const STICKER_NAME_MAX = 60;
export const PAGE_SIZE = 60;

/** Client-side length check. Character class and reserved words are the server's. */
export function packNameLengthError(name: string): "empty" | "long" | null {
  const length = [...name.trim()].length;
  if (length < 1) return "empty";
  if (length > PACK_NAME_MAX) return "long";
  return null;
}

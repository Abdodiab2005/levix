// file: frontend/src/utils/byteSize.ts

/** The two translation keys a byte label needs. */
type Translate = (key: "fileSizeKb" | "fileSizeMb", fallback?: string) => string;

/**
 * `1.2 MB` / `12 KB` for a byte count. One label everywhere the panel shows a
 * size, so the debug-log preview and an attachment chip read the same way.
 */
export function formatByteSize(bytes: number, t: Translate): string {
  const value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (value >= 1024 * 1024) {
    return t("fileSizeMb").replace("{size}", (value / (1024 * 1024)).toFixed(1));
  }
  return t("fileSizeKb").replace("{size}", String(Math.max(1, Math.round(value / 1024))));
}

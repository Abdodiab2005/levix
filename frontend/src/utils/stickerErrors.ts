import { ApiError } from "../api/client";
import type { translations } from "../i18n/translations";

type TranslationKey = keyof typeof translations.en;

const ERROR_CODE_KEYS: Record<string, TranslationKey> = {
  NO_MEDIA: "stickerErr_NO_MEDIA",
  UNSUPPORTED_TYPE: "stickerErr_UNSUPPORTED_TYPE",
  TOO_LARGE: "stickerErr_TOO_LARGE",
  DIMENSIONS_TOO_LARGE: "stickerErr_DIMENSIONS_TOO_LARGE",
  VIDEO_TOO_LONG: "stickerErr_VIDEO_TOO_LONG",
  CORRUPT: "stickerErr_CORRUPT",
  CONVERSION_FAILED: "stickerErr_CONVERSION_FAILED",
  OUTPUT_TOO_LARGE: "stickerErr_OUTPUT_TOO_LARGE",
  ENCODER_MISSING: "stickerErr_ENCODER_MISSING",
  TIMEOUT: "stickerErr_TIMEOUT",
  BUSY: "stickerErr_BUSY",
  NOT_FOUND: "stickerErr_NOT_FOUND",
  PACK_NOT_FOUND: "stickerErr_PACK_NOT_FOUND",
  PACK_EXISTS: "stickerErr_PACK_EXISTS",
  INVALID_NAME: "stickerErr_INVALID_NAME",
  INVALID_OPTIONS: "stickerErr_INVALID_OPTIONS",
  LIBRARY_FULL: "stickerErr_LIBRARY_FULL",
  PACK_LIMIT: "stickerErr_PACK_LIMIT",
  IN_USE: "stickerErr_IN_USE",
  STORAGE_UNAVAILABLE: "stickerErr_STORAGE_UNAVAILABLE",
  NOT_CONNECTED: "stickerErr_NOT_CONNECTED",
  CANCELLED: "stickerErr_CANCELLED",
  INTERNAL: "stickerErr_INTERNAL",
};

/**
 * Get the translation key for a sticker error code.
 * Returns the key to pass to t(); null if the code is unknown.
 */
export function stickerErrorKey(code: string | undefined): TranslationKey | null {
  if (!code) return null;
  return ERROR_CODE_KEYS[code] ?? null;
}

export function stickerErrorMessage(
  t: (key: TranslationKey, fallback?: string) => string,
  code: string | undefined,
): string {
  const key = stickerErrorKey(code);
  if (key) return t(key);
  return t("stickerErr_INTERNAL");
}

export function explainError(
  t: (key: TranslationKey, fallback?: string) => string,
  err: unknown,
): string {
  if (err instanceof ApiError) return stickerErrorMessage(t, err.code);
  return t("stickerErr_INTERNAL");
}

export function jobStageMessage(
  t: (key: TranslationKey, fallback?: string) => string,
  stage?: string | null,
): string {
  const stageKeys: Record<string, TranslationKey> = {
    probing: "jobStage_probing",
    decoding: "jobStage_decoding",
    encoding: "jobStage_encoding",
    optimizing: "jobStage_optimizing",
    queued: "jobQueued",
  };
  const key = stage ? stageKeys[stage] : null;
  if (key) return t(key);
  return t("jobQueued");
}

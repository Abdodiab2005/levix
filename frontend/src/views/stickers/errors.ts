import { ApiError } from "../../api/client";
import type { MessageKey } from "../../i18n/translations";
import { stickerErrorKey } from "../../utils/stickerErrors";
import { userErrorMessage } from "../../utils/userError";

export function explainError(
  t: (key: MessageKey) => string,
  err: unknown,
  fallbackKey = "stickerActionError",
): string {
  const code = err instanceof ApiError ? (err.code ?? err.data?.error) : undefined;
  const key = typeof code === "string" ? stickerErrorKey(code) : null;
  return typeof key === "string" ? t(key) : userErrorMessage(t, err, fallbackKey);
}

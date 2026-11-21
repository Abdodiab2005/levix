// file: frontend/src/views/plus/plusApi.ts
import { ApiError, api } from "../../api/client";
import { userErrorMessage } from "../../utils/userError";
import type { MessageKey } from "../../i18n/translations";
import type { PlusStatusResponse } from "./types";

const BASE = "/plus/ext";

export const plusGet = <T>(path: string) => api.get<T>(`${BASE}${path}`);
export const plusPut = <T>(path: string, body: unknown) => api.put<T>(`${BASE}${path}`, body);
export const plusPost = <T>(path: string, body?: unknown) =>
  api.post<T>(`${BASE}${path}`, body ?? {});
export const plusDelete = <T>(path: string) => api.delete<T>(`${BASE}${path}`);

/** Every contract error code, plus the two client-side codes, in one place. */
const ERROR_KEYS: Record<string, MessageKey> = {
  inactive: "plusExtErrorInactive",
  CONFLICT: "plusExtErrorConflict",
  BAD_REQUEST: "plusExtErrorBadRequest",
  INVALID_TEMPLATE: "plusExtErrorInvalidTemplate",
  UNKNOWN_PLACEHOLDER: "plusExtErrorUnknownPlaceholder",
  NOT_CUSTOMIZABLE: "plusExtErrorNotCustomizable",
  TOO_LONG: "plusExtErrorTooLong",
  INVALID_CHAT: "plusExtErrorInvalidChat",
  LIMIT: "plusExtErrorLimit",
  NOT_FOUND: "plusExtErrorNotFound",
  TRANSLATE_FAILED: "plusExtErrorTranslateFailed",
  network: "plusErrorNetwork",
};

/**
 * A stable code for any failure of an ext route. The extension answers 409 for
 * two different things and the body tells them apart: `inactive` means Core
 * stopped the extension, `CONFLICT` means the Auto Reply document changed since
 * this tab read it. An unknown 409 body stays `inactive`, as before.
 */
export function plusErrorCode(error: unknown): string {
  if (!(error instanceof ApiError)) return "network";
  if (error.status === 409) {
    const fromBody = error.data?.error;
    if (typeof fromBody === "string" && fromBody && fromBody !== "inactive") return fromBody;
    return "inactive";
  }
  if (error.status === 0) return "network";
  if (error.code) return error.code;
  const fromBody = error.data?.error;
  if (typeof fromBody === "string" && fromBody) return fromBody;
  return "FAILED";
}

export function plusErrorKey(code: string): MessageKey {
  return Object.hasOwn(ERROR_KEYS, code) ? ERROR_KEYS[code] : "plusExtErrorFailed";
}

export function plusErrorMessage(
  t: (key: MessageKey) => string,
  error: unknown,
  fallbackKey = "plusExtErrorFailed",
): string {
  const code = plusErrorCode(error);
  const key = Object.hasOwn(ERROR_KEYS, code) ? ERROR_KEYS[code] : undefined;
  return key ? t(key) : userErrorMessage(t, error, fallbackKey);
}

/** The server decides whether Plus is active. Local state never does. */
export function readPlusStatus(): Promise<PlusStatusResponse> {
  return api.get<PlusStatusResponse>("/plus/status");
}

/** Run one ext call, reporting an inactive extension through `onInactive`. */
export async function withPlus<T>(run: () => Promise<T>, onInactive: () => void): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (plusErrorCode(error) === "inactive") onInactive();
    throw error;
  }
}

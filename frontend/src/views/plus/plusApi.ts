// file: frontend/src/views/plus/plusApi.ts
import { ApiError, api } from "../../api/client";
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

/** A stable code for any failure of an ext route. 409 is always "inactive". */
export function plusErrorCode(error: unknown): string {
  if (!(error instanceof ApiError)) return "network";
  if (error.status === 409) return "inactive";
  if (error.status === 0) return "network";
  if (error.code) return error.code;
  const fromBody = error.data?.error;
  if (typeof fromBody === "string" && fromBody) return fromBody;
  return "FAILED";
}

export function plusErrorKey(code: string): MessageKey {
  return ERROR_KEYS[code] ?? "plusExtErrorFailed";
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

// Sticker Studio's Android bridge carries references and small JSON only.
import { ApiError } from "../api/client";
import type { StickerUpload } from "../types";

interface LevixHost {
  takePendingSticker?(): string;
  pickStickerSource?(id: string): string;
  pickFile?(id: string): string;
  uploadSource?(id: string, token: string, name: string, maxBytes: number): string;
  uploadForm?(
    id: string,
    path: string,
    payloadJson: string,
    token: string,
    maxBytes: number,
  ): string;
  exportFile?(
    id: string,
    action: string,
    path: string,
    method: string,
    jsonBody: string,
    name: string,
    mime: string,
  ): string;
  cancel?(id: string): void;
}

type HostResult = {
  ok: boolean;
  cancelled?: boolean;
  code?: string;
  error?: string;
  status?: number;
  body?: string;
  name?: string;
  dir?: string;
  token?: string;
  url?: string;
  mime?: string;
  size?: number;
};
const host = () => (window as { LevixHost?: LevixHost }).LevixHost;
const waiting = new Map<string, (value: HostResult) => void>();
let installed = false;

function installDone() {
  if (installed) return;
  installed = true;
  (
    window as Window & { __levixHostDone?: (id: string, result: HostResult) => void }
  ).__levixHostDone = (id, result) => {
    const done = waiting.get(id);
    waiting.delete(id);
    done?.(result);
  };
}

function call(
  method: "pickStickerSource" | "pickFile" | "uploadSource" | "uploadForm" | "exportFile",
  args: (string | number)[],
  signal?: AbortSignal,
): Promise<HostResult> {
  const h = host();
  const fn = h?.[method];
  if (!h || typeof fn !== "function") return Promise.resolve({ ok: false, code: "UNAVAILABLE" });
  installDone();
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    const finish = (result: HostResult) => {
      signal?.removeEventListener("abort", abort);
      resolve(result);
    };
    const abort = () => h.cancel?.(id);
    if (signal?.aborted) return finish({ ok: false, cancelled: true });
    waiting.set(id, finish);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const raw =
        method === "pickStickerSource"
          ? h.pickStickerSource?.(id)
          : method === "pickFile"
            ? h.pickFile?.(id)
            : method === "uploadSource"
              ? h.uploadSource?.(id, args[0] as string, args[1] as string, args[2] as number)
              : method === "uploadForm"
                ? h.uploadForm?.(
                    id,
                    args[0] as string,
                    args[1] as string,
                    args[2] as string,
                    args[3] as number,
                  )
                : h.exportFile?.(
                    id,
                    args[0] as string,
                    args[1] as string,
                    args[2] as string,
                    args[3] as string,
                    args[4] as string,
                    args[5] as string,
                  );
      const reply = JSON.parse(raw || "") as HostResult;
      if (!reply.ok) {
        waiting.delete(id);
        finish(reply);
      }
    } catch {
      waiting.delete(id);
      finish({ ok: false, code: "UNAVAILABLE" });
    }
  });
}

export interface HostSource {
  token: string;
  url: string;
  name: string;
  mime: string;
  size: number;
}
export interface PendingSticker extends HostSource {
  intent: "create" | "save";
}
export function canPickHostSource(): boolean {
  return typeof host()?.pickStickerSource === "function";
}
export function canHostExport(): boolean {
  return typeof host()?.exportFile === "function";
}
export async function pickHostSource(): Promise<HostSource | null> {
  const result = await call("pickStickerSource", []);
  if (!result.ok && !result.cancelled) throw apiError(result);
  return result.ok && result.token && result.url ? (result as HostSource) : null;
}
export function takePendingSticker(): PendingSticker | null {
  try {
    const h = host();
    const result = h?.takePendingSticker ? JSON.parse(h.takePendingSticker()) : null;
    return result?.ok && result.token && result.url && ["create", "save"].includes(result.intent)
      ? result
      : null;
  } catch {
    return null;
  }
}

function apiError(result: HostResult): ApiError {
  if (result.status === 401) window.location.href = "/login";
  const body = result.body;
  const data = body
    ? (() => {
        try {
          return JSON.parse(body);
        } catch {
          return null;
        }
      })()
    : null;
  const code = result.cancelled
    ? "CANCELLED"
    : result.code === "UNAVAILABLE"
      ? "STORAGE_UNAVAILABLE"
      : result.code;
  return new ApiError(
    result.status || 0,
    data?.error || result.error || code || "Sticker operation failed",
    data || { code },
  );
}

export async function uploadHostSource(
  token: string,
  name: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<StickerUpload> {
  const result = await call("uploadSource", [token, name, maxBytes], signal);
  if (!result.ok || !result.status || result.status < 200 || result.status >= 300)
    throw apiError(result);
  try {
    return JSON.parse(result.body || "") as StickerUpload;
  } catch {
    throw new ApiError(result.status, "Invalid upload response", { code: "INTERNAL" });
  }
}

/** The native multipart upload exists only next to the native any-file picker. */
export function canHostUploadForm(): boolean {
  return typeof host()?.uploadForm === "function" && typeof host()?.pickFile === "function";
}

/** Any openable file through the native picker (feedback, scheduled media). */
export async function pickHostFile(): Promise<HostSource | null> {
  const result = await call("pickFile", []);
  if (!result.ok && !result.cancelled) throw apiError(result);
  return result.ok && result.token && result.url ? (result as HostSource) : null;
}

/**
 * Multipart POST of a host-picked file plus small text fields, streamed
 * natively (feedback attachment, scheduled-message media). The panel route
 * must be one of the paths the bridge allowlists.
 */
export async function uploadHostForm<T = unknown>(
  path: string,
  payload: Record<string, string>,
  token: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<T> {
  const result = await call("uploadForm", [path, JSON.stringify(payload), token, maxBytes], signal);
  if (!result.ok || !result.status || result.status < 200 || result.status >= 300)
    throw apiError(result);
  try {
    return (result.body ? JSON.parse(result.body) : {}) as T;
  } catch {
    throw new ApiError(result.status || 0, "Invalid upload response", { code: "INTERNAL" });
  }
}

export async function hostExport(
  action: "share" | "save",
  path: string,
  method: "GET" | "POST",
  jsonBody: string,
  fileName: string,
  mime: string,
): Promise<HostResult> {
  const result = await call("exportFile", [action, path, method, jsonBody, fileName, mime]);
  if (!result.ok) throw apiError(result);
  return result;
}

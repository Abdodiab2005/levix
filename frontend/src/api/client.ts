// file: frontend/src/api/client.ts

import type {
  AutoDeleteLogEntry,
  AutoDeleteRule,
  AutoDeleteRuleInput,
  Capabilities,
  EditOptions,
  Job,
  Pack,
  Sticker,
  StickerBulkResult,
  StickerFile,
  StickerJobSource,
  StickerList,
  StickerUpload,
} from "../types";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public data?: any,
  ) {
    super(message);
    this.name = "ApiError";
  }

  get code(): string | undefined {
    return this.data?.code;
  }
}

async function request<T = any>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const url = endpoint.startsWith("/dashboard/api")
    ? endpoint
    : `/dashboard/api${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;

  const headers: Record<string, string> = {
    ...(options.body instanceof Blob ? {} : { "Content-Type": "application/json" }),
    ...(options.headers as Record<string, string>),
  };

  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (response.status === 401) {
    // Session expired -> redirect to login
    window.location.href = "/login";
    throw new ApiError(401, "Session expired, redirecting to login...");
  }

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new ApiError(
      response.status,
      data?.error || data?.message || `HTTP ${response.status}: Request failed`,
      data,
    );
  }

  return data as T;
}

function fileNameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      return star[1];
    }
  }
  const plain = /filename="([^"]*)"/.exec(header);
  return plain?.[1] || null;
}

async function requestFile(endpoint: string, options: RequestInit = {}): Promise<StickerFile> {
  const response = await fetch(`/dashboard/api${endpoint}`, options);
  if (response.status === 401) {
    window.location.href = "/login";
    throw new ApiError(401, "Session expired");
  }
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new ApiError(response.status, data?.error || "Sticker operation failed", data);
  }
  return {
    blob: await response.blob(),
    fileName: fileNameFromDisposition(response.headers.get("Content-Disposition")),
    animated: response.headers.get("X-Levix-Animated") === "1",
  };
}

export interface ModelCapabilities {
  textInput: boolean;
  textOutput: boolean;
  vision: boolean;
  audioInput: boolean;
  stt: boolean;
  videoInput: boolean;
  pdfInput: boolean;
}

export interface NormalizedModel {
  id: string;
  displayName: string;
  provider: string;
  recommended: boolean;
  capabilities: ModelCapabilities;
  capabilitySource: "provider" | "seed" | "unknown";
  status?: string;
  isRecommendedSeed?: boolean;
}

export type FeedbackTopic = "bug" | "idea" | "question" | "praise" | "other";

export interface FeedbackMeta {
  success: boolean;
  topics: FeedbackTopic[];
  messageMin: number;
  messageMax: number;
  attachmentMax?: number;
  runtime: { version: string; platform: string };
}

export interface FeedbackPayload {
  message: string;
  topic: FeedbackTopic;
  rating?: number | null;
  contact?: string | null;
}

export interface FetchAiModelsResponse {
  success: boolean;
  live: boolean;
  requiresApiKey?: boolean;
  fallback?: boolean;
  provider: string;
  models: NormalizedModel[];
  cached?: boolean;
  message?: string;
  error?: {
    code: number;
    type: string;
    message: string;
  };
}

export const api = {
  get: <T = any>(endpoint: string) => request<T>(endpoint, { method: "GET" }),
  post: <T = any>(endpoint: string, body?: any) =>
    request<T>(endpoint, { method: "POST", body: body ? JSON.stringify(body) : undefined }),
  patch: <T = any>(endpoint: string, body?: any) =>
    request<T>(endpoint, { method: "PATCH", body: body ? JSON.stringify(body) : undefined }),
  put: <T = any>(endpoint: string, body?: any) =>
    request<T>(endpoint, { method: "PUT", body: body ? JSON.stringify(body) : undefined }),
  delete: <T = any>(endpoint: string) => request<T>(endpoint, { method: "DELETE" }),

  // Helpers
  getStats: () => api.get<{ stats: any; success: boolean }>("/stats"),
  getSession: () =>
    api.get<{ status?: any; session?: any; qr?: string | null; pairingCode?: string | null }>(
      "/bot/session",
    ),
  startSession: (body?: { method?: "qr" | "pairing"; phone?: string }) =>
    api.post("/bot/session/start", body),
  reconnectSession: () => api.post("/bot/session/reconnect"),
  stopSession: () => api.post("/bot/session/stop"),
  unlinkSession: () => api.post("/bot/logout"),
  restartBot: () => api.post("/bot/restart"),
  getSettings: () => api.get<{ settings: any[]; prefix?: string; success: boolean }>("/settings"),
  updateSetting: (key: string, value: any) => api.patch("/settings", { key, value }),
  updatePrefix: (prefix: string) => api.patch("/settings", { key: "prefix", value: prefix }),
  exportSettings: () =>
    api.get<{
      format: string;
      version: number;
      exportedAt: string;
      settings: Record<string, any>;
      commands: {
        prefix: string;
        permissions: Record<string, string>;
        aliases: Record<string, string[]>;
        disabled: string[];
      };
    }>("/settings/export"),
  importSettings: (payload: unknown) =>
    api.post<{
      success: boolean;
      applied: string[];
      skipped: Array<{ key: string; reason: string }>;
      restartNeeded: string[];
      counts: { permissions: number; aliases: number; disabled: number };
    }>("/settings/import", payload),
  getCommands: () =>
    api.get<{ commands: any[]; prefix?: string; levels?: string[]; success: boolean }>("/commands"),
  updateCommand: (name: string, payload: any) =>
    api.patch(`/commands/${encodeURIComponent(name)}`, payload),
  /**
   * One multipart POST with small text fields and one file (schedule media,
   * feedback attachments that need no progress). Never set a Content-Type
   * here: the browser must build the multipart boundary itself.
   */
  postMultipart: <T = any>(endpoint: string, fields: Record<string, string>, file: File) =>
    new Promise<T>((resolve, reject) => {
      const form = new FormData();
      for (const [key, value] of Object.entries(fields)) {
        if (value !== undefined && value !== null && value !== "") form.set(key, value);
      }
      form.set("file", file);
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/dashboard/api${endpoint}`);
      xhr.responseType = "json";
      xhr.onload = () => {
        const data =
          xhr.response && typeof xhr.response === "object" ? (xhr.response as any) : null;
        if (xhr.status === 401) {
          window.location.href = "/login";
          reject(new ApiError(401, "Session expired"));
          return;
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(data as T);
        } else {
          reject(
            new ApiError(
              xhr.status,
              data?.error || data?.message || `HTTP ${xhr.status}: Request failed`,
              data,
            ),
          );
        }
      };
      xhr.onerror = () => reject(new ApiError(0, "Network error"));
      xhr.send(form);
    }),

  getSchedules: () =>
    api.get<{ schedules: any[]; timezone: string; success: boolean }>("/schedules"),
  createSchedule: (payload: any) => api.post("/schedules", payload),
  deleteSchedule: (id: string) => api.delete(`/schedules/${encodeURIComponent(id)}`),
  retrySchedule: (id: string) => api.post(`/schedules/${encodeURIComponent(id)}/retry`),
  getGroups: () => api.get<{ groups: any[] }>("/groups"),
  updateGroup: (jid: string, payload: any) =>
    api.patch(`/groups/${encodeURIComponent(jid)}`, payload),
  getPersona: () =>
    api.get<{ persona: { header?: string; body?: string } | string }>("/ai/persona"),
  updatePersona: (persona: string) => api.put("/ai/persona", { body: persona }),
  getMemoryFiles: () =>
    api.get<{
      files?: string[];
      scopes?: Array<{
        scope: string;
        label: string;
        entries?: number;
        bytes?: number;
        updatedAt?: number | null;
      }>;
    }>("/ai/memory"),
  getMemoryFile: (name: string) =>
    api.get<{ content: string }>(`/ai/memory/${encodeURIComponent(name)}`),
  updateMemoryFile: (name: string, content: string) =>
    api.put(`/ai/memory/${encodeURIComponent(name)}`, { content }),
  deleteMemoryFile: (name: string) => api.delete(`/ai/memory/${encodeURIComponent(name)}`),
  getAiConversations: () =>
    api.get<{ conversations: Array<{ chatId: string; turns: number; updatedAt: number | null }> }>(
      "/ai/conversations",
    ),
  getAiConversation: (chatId: string) =>
    api.get<{
      chatId: string;
      updatedAt: number | null;
      truncated: boolean;
      messages: Array<{
        role: "user" | "model";
        kind: "text" | "media" | "tool" | "toolResult";
        text?: string;
        mimeType?: string | null;
        name?: string;
      }>;
    }>(`/ai/conversations/${encodeURIComponent(chatId)}`),
  getRecipients: () =>
    api.get<{
      recipients: Array<{
        id: string;
        name: string;
        type: "group" | "contact";
        phone?: string | null;
      }>;
    }>("/recipients"),
  fetchAiModels: (payload?: {
    provider?: string;
    apiKey?: string;
    baseUrl?: string;
    refresh?: boolean;
    cacheOnly?: boolean;
  }) => api.post<FetchAiModelsResponse>("/ai/models", payload || {}),
  changePassword: (current: string, next: string) =>
    api.post("/security/password", { current, next }),
  // The bot forwards this to the developer; nothing about it is stored locally.
  getFeedbackMeta: () => api.get<FeedbackMeta>("/feedback/meta"),
  sendFeedback: (payload: FeedbackPayload) => api.post<{ success: boolean }>("/feedback", payload),
  /**
   * The same feedback with one file, as multipart/form-data. XHR rather than
   * fetch because upload progress is the point. Only used off the Android
   * host, where the native bridge owns file uploads instead.
   */
  sendFeedbackMultipart: (
    payload: FeedbackPayload,
    attachment: File,
    onProgress?: (fraction: number) => void,
  ) =>
    new Promise<{ success: boolean }>((resolve, reject) => {
      const form = new FormData();
      form.set("message", payload.message);
      form.set("topic", payload.topic);
      if (payload.rating) form.set("rating", String(payload.rating));
      if (payload.contact) form.set("contact", payload.contact);
      form.set("file", attachment, attachment.name);
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/dashboard/api/feedback");
      xhr.responseType = "json";
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total);
      };
      xhr.onload = () => {
        const data =
          xhr.response && typeof xhr.response === "object" ? (xhr.response as any) : null;
        if (xhr.status === 401) {
          window.location.href = "/login";
          reject(new ApiError(401, "Session expired"));
          return;
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(data ?? { success: true });
        } else {
          reject(
            new ApiError(
              xhr.status,
              data?.error || data?.message || `HTTP ${xhr.status}: Request failed`,
              data,
            ),
          );
        }
      };
      xhr.onerror = () => reject(new ApiError(0, "Network error"));
      xhr.send(form);
    }),
  getLogs: () => api.get<{ logs: any[] }>("/logs"),
  // Sticker Studio
  getStickerCapabilities: () => api.get<Capabilities>("/stickers/capabilities"),
  getStickers: (query: {
    q?: string;
    sort?: string;
    filter?: string;
    pack?: string;
    offset?: number;
    limit?: number;
  }) => {
    const params = new URLSearchParams();
    if (query.q) params.set("q", query.q);
    if (query.sort) params.set("sort", query.sort);
    if (query.filter) params.set("filter", query.filter);
    if (query.pack) params.set("pack", query.pack);
    if (query.offset !== undefined) params.set("offset", query.offset.toString());
    if (query.limit !== undefined) params.set("limit", query.limit.toString());
    return api.get<StickerList>(`/stickers?${params.toString()}`);
  },
  uploadStickerSource: (file: File | Blob, filename?: string) => {
    const headers: Record<string, string> = {};
    if (filename) headers["X-Filename"] = encodeURIComponent(filename);
    return request<StickerUpload>("/stickers/uploads", {
      method: "POST",
      body: file,
      headers,
    });
  },
  uploadExistingStickerSource: (id: string) =>
    request<StickerUpload>(`/stickers/${encodeURIComponent(id)}/uploads`, { method: "POST" }),
  createStickerJob: (payload: {
    uploadId: string;
    options?: EditOptions;
    overlay?: string;
    name?: string;
    packId?: string;
    source?: StickerJobSource;
  }) => api.post<{ jobId: string }>("/stickers/jobs", payload),
  getStickerJob: (id: string) => api.get<Job>(`/stickers/jobs/${encodeURIComponent(id)}`),
  exportSticker: (id: string, format: "webp" | "png" | "gif") =>
    requestFile(`/stickers/${encodeURIComponent(id)}/export?format=${format}`),
  exportStickers: (ids: string[], format: "webp" | "png") =>
    requestFile("/stickers/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, format }),
    }),
  updateSticker: (id: string, payload: { name?: string; favorite?: boolean }) =>
    api.patch<Sticker>(`/stickers/${encodeURIComponent(id)}`, payload),
  deleteSticker: (id: string, confirm?: boolean) =>
    api.delete<{ deleted: string[] }>(
      `/stickers/${encodeURIComponent(id)}${confirm ? "?confirm=1" : ""}`,
    ),
  bulkStickers: (payload: {
    action:
      | "favorite"
      | "unfavorite"
      | "delete"
      | "addToPack"
      | "moveToPack"
      | "removeFromPack"
      | "touch";
    ids: string[];
    packId?: string;
    fromPackId?: string;
    confirm?: boolean;
  }) => api.post<StickerBulkResult>("/stickers/bulk", payload),
  sendStickers: (payload: { ids: string[]; jid: string }) =>
    api.post<{ sent: number }>("/stickers/send", payload),
  getPacks: () => api.get<{ packs: Pack[] }>("/sticker-packs"),
  createPack: (name: string) => api.post<Pack>("/sticker-packs", { name }),
  getPack: (id: string) =>
    api.get<{ pack: Pack; items: Sticker[] }>(`/sticker-packs/${encodeURIComponent(id)}`),
  updatePack: (id: string, name: string) =>
    api.patch<Pack>(`/sticker-packs/${encodeURIComponent(id)}`, { name }),
  // deletedPack is the pack id. The route does not return the pack object.
  deletePack: (id: string, deleteStickers?: boolean) =>
    api.delete<{ deletedPack: string; deletedStickers: string[] }>(
      `/sticker-packs/${encodeURIComponent(id)}${deleteStickers ? "?deleteStickers=1" : ""}`,
    ),
  reorderPack: (id: string, ids: string[]) =>
    api.put<{ ok: true }>(`/sticker-packs/${encodeURIComponent(id)}/order`, { ids }),
  mergePack: (id: string, intoPackId: string) =>
    api.post<{ pack: Pack; moved: number }>(`/sticker-packs/${encodeURIComponent(id)}/merge`, {
      intoPackId,
    }),

  listAutoDeleteRules: () =>
    api.get<{ success: boolean; rules: AutoDeleteRule[] }>("/auto-delete/rules"),
  createAutoDeleteRule: (body: AutoDeleteRuleInput) =>
    api.post<{ success: boolean; rule: AutoDeleteRule }>("/auto-delete/rules", body),
  updateAutoDeleteRule: (id: number, body: AutoDeleteRuleInput) =>
    api.patch<{ success: boolean; rule: AutoDeleteRule }>(`/auto-delete/rules/${id}`, body),
  deleteAutoDeleteRule: (id: number) =>
    api.delete<{ success: boolean }>(`/auto-delete/rules/${id}`),
  resetAutoDeleteRule: (id: number) =>
    api.post<{ success: boolean; rule: AutoDeleteRule }>(`/auto-delete/rules/${id}/reset`),
  listAutoDeleteLog: (query: { ruleId?: string; limit?: number; offset?: number } = {}) => {
    const params = new URLSearchParams();
    if (query.ruleId) params.set("ruleId", query.ruleId);
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    if (query.offset !== undefined) params.set("offset", String(query.offset));
    const qs = params.toString();
    return api.get<{ success: boolean; log: AutoDeleteLogEntry[] }>(
      `/auto-delete/log${qs ? `?${qs}` : ""}`,
    );
  },
  clearAutoDeleteLog: (ruleId?: string) =>
    api.delete<{ success: boolean; cleared: number }>(
      ruleId ? `/auto-delete/log?ruleId=${encodeURIComponent(ruleId)}` : "/auto-delete/log",
    ),
};

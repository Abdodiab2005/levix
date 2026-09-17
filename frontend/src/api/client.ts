// file: frontend/src/api/client.ts

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public data?: any,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T = any>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const url = endpoint.startsWith("/dashboard/api")
    ? endpoint
    : `/dashboard/api${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
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
  getSession: () => api.get<{ status: any }>("/session"),
  startSession: () => api.post("/session/start"),
  stopSession: () => api.post("/session/stop"),
  unlinkSession: () => api.post("/session/unlink"),
  restartBot: () => api.post("/session/restart"),
  getSettings: () => api.get<{ settings: any[]; prefix?: string; success: boolean }>("/settings"),
  updateSetting: (key: string, value: any) => api.patch("/settings", { key, value }),
  updatePrefix: (prefix: string) => api.patch("/settings", { key: "prefix", value: prefix }),
  getCommands: () => api.get<{ commands: any[]; prefix?: string; success: boolean }>("/commands"),
  updateCommand: (name: string, payload: any) =>
    api.patch(`/commands/${encodeURIComponent(name)}`, payload),
  getSchedules: () =>
    api.get<{ schedules: any[]; timezone: string; success: boolean }>("/schedules"),
  createSchedule: (payload: any) => api.post("/schedules", payload),
  deleteSchedule: (id: string) => api.delete(`/schedules/${encodeURIComponent(id)}`),
  retrySchedule: (id: string) => api.post(`/schedules/${encodeURIComponent(id)}/retry`),
  getGroups: () => api.get<{ groups: any[] }>("/groups"),
  updateGroup: (jid: string, payload: any) =>
    api.patch(`/groups/${encodeURIComponent(jid)}`, payload),
  getPersona: () => api.get<{ persona: string }>("/persona"),
  updatePersona: (persona: string) => api.put("/persona", { persona }),
  getMemoryFiles: () => api.get<{ files: string[] }>("/memory"),
  getMemoryFile: (name: string) =>
    api.get<{ content: string }>(`/memory/${encodeURIComponent(name)}`),
  updateMemoryFile: (name: string, content: string) =>
    api.put(`/memory/${encodeURIComponent(name)}`, { content }),
  deleteMemoryFile: (name: string) => api.delete(`/memory/${encodeURIComponent(name)}`),
  changePassword: (current: string, next: string) =>
    api.post("/security/password", { current, next }),
  getLogs: () => api.get<{ logs: any[] }>("/logs"),
};

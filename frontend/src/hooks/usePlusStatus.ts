// file: frontend/src/hooks/usePlusStatus.ts
// One shared reader of GET /dashboard/api/plus/status. The store lives at
// module scope, so the sidebar, the Plus page and the in-context rows share one
// copy and one request. The server decides entitlement; nothing here does.

import { useCallback, useSyncExternalStore } from "react";
import { ApiError, api } from "../api/client";
import { isPlusConfigured } from "../utils/hostBridge";
import { type PlusStatus, plusAvailableFrom } from "../utils/plusAccess";
import { useSocketEvent } from "./useSocket";

export interface PlusStatusState {
  /** Whether Plus is offered on this platform. null until known. */
  available: boolean | null;
  /** The last answer of the server. null while loading or after a failed read. */
  status: PlusStatus | null;
  /** True until the first read settles. */
  loading: boolean;
  /** Stable code of the last failed read, cleared by the next good one. */
  error: string | null;
}

function initialState(): PlusStatusState {
  return {
    available: plusAvailableFrom({ hostConfigured: isPlusConfigured(), status: null, failed: false }),
    status: null,
    loading: true,
    error: null,
  };
}

let state: PlusStatusState = initialState();
const listeners = new Set<() => void>();
let generation = 0;
let latest: Promise<PlusStatus> | null = null;
let inflight: Promise<PlusStatus> | null = null;
let batchTimer: ReturnType<typeof setTimeout> | null = null;

function set(next: Partial<PlusStatusState>) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

function errorCode(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 429) return "RATE_LIMITED";
    return error.code || (typeof error.data?.error === "string" ? error.data.error : "FAILED");
  }
  return "network";
}

/**
 * Reads the status again. Always asks the server. The newest read wins: an
 * older answer that arrives late is dropped, and an older failure falls back to
 * the newest read.
 */
export function refreshPlusStatus(): Promise<PlusStatus> {
  const token = ++generation;
  const request = api.get<PlusStatus>("/plus/status").then(
    (value) => {
      if (token === generation) {
        set({
          status: value,
          error: null,
          loading: false,
          available: plusAvailableFrom({
            hostConfigured: isPlusConfigured(),
            status: value,
            failed: false,
            previous: state.available,
          }),
        });
      }
      return value;
    },
    (err) => {
      if (token === generation) {
        set({
          status: null,
          error: errorCode(err),
          loading: false,
          available: plusAvailableFrom({
            hostConfigured: isPlusConfigured(),
            status: null,
            failed: true,
            previous: state.available,
          }),
        });
        throw err;
      }
      if (latest) return latest;
      throw err;
    },
  );
  latest = request;
  inflight = request;
  const clear = () => {
    if (inflight === request) inflight = null;
  };
  request.then(clear, clear);
  return request;
}

/** The cached answer if there is one, else the read in flight, else a new read. */
export function ensurePlusStatus(): Promise<PlusStatus> {
  if (state.status) return Promise.resolve(state.status);
  return inflight ?? refreshPlusStatus();
}

/** Events from many hook instances in one tick become a single read. */
function refreshSoon() {
  if (batchTimer) return;
  batchTimer = setTimeout(() => {
    batchTimer = null;
    void refreshPlusStatus().catch(() => {});
  }, 0);
}

function onVisible() {
  if (document.visibilityState === "visible") refreshSoon();
}

function subscribe(listener: () => void): () => void {
  const first = listeners.size === 0;
  listeners.add(listener);
  if (first) {
    document.addEventListener("visibilitychange", onVisible);
    if (state.loading && !inflight) refreshSoon();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) document.removeEventListener("visibilitychange", onVisible);
  };
}

const getSnapshot = () => state;

export function usePlusStatus(): PlusStatusState & { refresh: () => Promise<PlusStatus> } {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const onEvent = useCallback(() => refreshSoon(), []);
  useSocketEvent("plus_status", onEvent);
  useSocketEvent("connect", onEvent);
  return { ...snapshot, refresh: refreshPlusStatus };
}

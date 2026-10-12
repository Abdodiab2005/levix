// file: frontend/src/utils/errorCapture.ts
import { api } from "../api/client";
import type { Breadcrumb, CrashReportCategory, CrashReportInput } from "../types";
import { getClientDiagnostics } from "./diagnostics";

const MAX_POSTS_PER_PAGE_LOAD = 3;
const MAX_BREADCRUMBS = 20;

let sentCount = 0;
const seenFingerprints = new Set<string>();
let isUnloading = false;

const breadcrumbs: Breadcrumb[] = [];

function getCurrentScreen(): string {
  try {
    const raw = window.location.hash.replace(/^#\/?/, "").split("/")[0];
    const s = raw ? raw.trim() : "overview";
    return s.slice(0, 40) || "overview";
  } catch {
    return "overview";
  }
}

export function pushNavBreadcrumb(screenName: string): void {
  try {
    const name = (screenName || "overview").slice(0, 60);
    breadcrumbs.push({
      at: new Date().toISOString(),
      kind: "nav",
      name,
    });
    if (breadcrumbs.length > MAX_BREADCRUMBS) {
      breadcrumbs.shift();
    }
  } catch {
    // never throw
  }
}

// Initialize unload listener and initial route breadcrumb
if (typeof window !== "undefined") {
  try {
    window.addEventListener("beforeunload", () => {
      isUnloading = true;
    });
    window.addEventListener("pagehide", () => {
      isUnloading = true;
    });

    pushNavBreadcrumb(getCurrentScreen());

    window.addEventListener("hashchange", () => {
      pushNavBreadcrumb(getCurrentScreen());
    });
  } catch {
    // never throw
  }
}

export function captureReport(
  category: CrashReportCategory,
  err: unknown,
  customType?: string,
): void {
  try {
    if (isUnloading || sentCount >= MAX_POSTS_PER_PAGE_LOAD) {
      return;
    }

    let type = customType || "Error";
    let message = "Unknown error";
    let stack: string[] = [];

    if (err instanceof Error) {
      type = customType || err.name || "Error";
      message = err.message || "Unknown error";
      if (err.stack) {
        stack = err.stack
          .split("\n")
          .map((s) => s.trim().slice(0, 200))
          .filter(Boolean)
          .slice(0, 20);
      }
    } else if (typeof err === "string") {
      message = err;
    } else if (err && typeof err === "object") {
      const maybeObj = err as Record<string, unknown>;
      if (typeof maybeObj.message === "string") {
        message = maybeObj.message;
      }
      if (typeof maybeObj.name === "string") {
        type = customType || maybeObj.name;
      }
      if (typeof maybeObj.stack === "string") {
        stack = maybeObj.stack
          .split("\n")
          .map((s) => s.trim().slice(0, 200))
          .filter(Boolean)
          .slice(0, 20);
      }
    }

    type = type.slice(0, 120);
    message = message.slice(0, 300);

    const fingerprint = `${type}|${message}`;
    if (seenFingerprints.has(fingerprint)) {
      return;
    }
    seenFingerprints.add(fingerprint);
    sentCount++;

    const payload: CrashReportInput = {
      category,
      error: {
        type,
        message,
        stack,
      },
      screen: getCurrentScreen(),
      breadcrumbs: [...breadcrumbs],
      device: getClientDiagnostics(),
    };

    api.submitCrashReport(payload).catch(() => {
      // ignore
    });
  } catch {
    // capture must never throw
  }
}

export function initWindowErrorHandlers(): () => void {
  if (typeof window === "undefined") return () => {};

  const onError = (event: ErrorEvent) => {
    try {
      captureReport("web-error", event.error || event.message);
    } catch {
      // never throw
    }
  };

  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    try {
      captureReport("web-rejection", event.reason);
    } catch {
      // never throw
    }
  };

  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onUnhandledRejection);

  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onUnhandledRejection);
  };
}

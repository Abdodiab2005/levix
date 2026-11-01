// file: frontend/src/utils/diagnostics.ts
import { resolveLocale } from "../i18n/locale";
import type { ClientDiagnostics } from "../types";

export function getClientDiagnostics(
  language?: ClientDiagnostics["language"],
  theme?: "light" | "dark",
): ClientDiagnostics {
  const lang = resolveLocale(language || document.documentElement.lang);
  const thm =
    theme || (document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark");
  const screen = `${window.innerWidth}x${window.innerHeight}@${Number(window.devicePixelRatio || 1).toFixed(2)}`;
  const d: ClientDiagnostics = {
    screen: screen.length > 24 ? screen.slice(0, 24) : screen,
    language: lang,
    theme: thm,
  };
  const host = (window as unknown as { LevixHost?: { getDiagnostics?: () => string } }).LevixHost;
  if (host && typeof host.getDiagnostics === "function") {
    try {
      const raw = host.getDiagnostics();
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          const allowedKeys: (keyof ClientDiagnostics)[] = [
            "nativeApp",
            "android",
            "device",
            "abi",
            "webview",
            "connectivity",
            "memory",
            "storage",
          ];
          for (const k of allowedKeys) {
            if (typeof parsed[k] === "string") {
              d[k] = parsed[k];
            }
          }
        }
      }
    } catch {
      // never throws
    }
  }
  return d;
}

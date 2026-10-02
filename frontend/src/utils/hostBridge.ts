// Android WebView bridge (window.LevixHost). Always feature-detect.

interface LevixHost {
  takePendingSticker(): string;
  shareFile(fileName: string, mime: string, base64: string): string;
  saveDownload(fileName: string, mime: string, base64: string): string;
}

function getHost(): LevixHost | null {
  const h = (window as { LevixHost?: LevixHost }).LevixHost;
  return h && typeof h.takePendingSticker === "function" ? h : null;
}

export interface PendingSticker {
  ok: true;
  intent: "create" | "save";
  name: string;
  mime: string;
  data: string; // base64
}

export function takePendingSticker(): PendingSticker | null {
  const host = getHost();
  if (!host) return null;
  try {
    const result = JSON.parse(host.takePendingSticker());
    if (result?.ok && (result.intent === "create" || result.intent === "save")) {
      return result as PendingSticker;
    }
    return null;
  } catch {
    return null;
  }
}

export function canUseHostBridge(): boolean {
  return getHost() !== null;
}

export async function hostShareFile(
  fileName: string,
  mime: string,
  base64: string,
): Promise<boolean> {
  const host = getHost();
  if (!host) return false;
  try {
    const result = JSON.parse(host.shareFile(fileName, mime, base64));
    return result?.ok === true;
  } catch {
    return false;
  }
}

export async function hostSaveDownload(
  fileName: string,
  mime: string,
  base64: string,
): Promise<{ ok: true; name: string; dir: string } | null> {
  const host = getHost();
  if (!host) return null;
  try {
    const result = JSON.parse(host.saveDownload(fileName, mime, base64));
    if (result?.ok) return result;
    return null;
  } catch {
    return null;
  }
}

/** Convert bytes to base64. Used only for the Android bridge, never for browser downloads. */
export function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBlob(data: string, mime: string): Blob {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime || "application/octet-stream" });
}

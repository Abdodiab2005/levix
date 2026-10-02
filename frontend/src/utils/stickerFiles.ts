import { hostExport } from "./hostBridge";

export type Delivered =
  | { ok: true; via: "host"; dir: string; name: string }
  | { ok: true; via: "browser" }
  | { ok: true; via: "share" }
  | { ok: false; cancelled: boolean };

export function stickerFileName(name: string, ext: string): string {
  const base = (name || "sticker").replace(/[\\/:*?"<>|]+/g, " ").trim() || "sticker";
  return `${[...base].slice(0, 80).join("")}.${ext}`;
}

function browserDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/** Browser downloads keep their existing blob URL path. */
export async function saveBlob(blob: Blob, fileName: string): Promise<Delivered> {
  browserDownload(blob, fileName);
  return { ok: true, via: "browser" };
}

/** A cancelled share sheet is not a failure. */
export async function shareBlob(blob: Blob, fileName: string, mime: string): Promise<Delivered> {
  const file = new File([blob], fileName, { type: mime });
  const canShare =
    typeof navigator.share === "function" &&
    typeof navigator.canShare === "function" &&
    navigator.canShare({ files: [file] });
  if (canShare) {
    try {
      await navigator.share({ files: [file] });
      return { ok: true, via: "share" };
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        return { ok: false, cancelled: true };
      }
    }
  }
  browserDownload(blob, fileName);
  return { ok: true, via: "browser" };
}

export async function deliverHost(
  action: "share" | "save",
  path: string,
  method: "GET" | "POST",
  body: string,
  fileName: string,
  mime: string,
): Promise<Delivered> {
  const result = await hostExport(action, path, method, body, fileName, mime);
  if (action === "share") return { ok: true, via: "share" };
  return {
    ok: true,
    via: "host",
    name: result.name || fileName,
    dir: result.dir || "Downloads/Levix",
  };
}

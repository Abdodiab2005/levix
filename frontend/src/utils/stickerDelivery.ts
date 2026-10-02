import { api } from "../api/client";
import type { Sticker } from "../types";
import { saveBlob, shareBlob, stickerFileName, type Delivered } from "./stickerFiles";

const MIME = {
  webp: "image/webp",
  png: "image/png",
  gif: "image/gif",
  zip: "application/zip",
} as const;

function named(fileName: string | null, fallback: string, blob: Blob, mime: string) {
  return { name: fileName || fallback, mime: blob.type || mime, blob };
}

export async function saveOne(
  sticker: Sticker,
  format: "webp" | "png" | "gif",
): Promise<Delivered> {
  const file = await api.exportSticker(sticker.id, format);
  const saved = named(
    file.fileName,
    stickerFileName(sticker.name, format),
    file.blob,
    MIME[format],
  );
  return saveBlob(saved.blob, saved.name, saved.mime);
}

export async function shareOne(
  sticker: Sticker,
  format: "webp" | "png" | "gif",
): Promise<Delivered> {
  const file = await api.exportSticker(sticker.id, format);
  const saved = named(
    file.fileName,
    stickerFileName(sticker.name, format),
    file.blob,
    MIME[format],
  );
  return shareBlob(saved.blob, saved.name, saved.mime);
}

export async function saveZip(ids: string[], format: "webp" | "png"): Promise<Delivered> {
  const file = await api.exportStickers(ids, format);
  const saved = named(file.fileName, `stickers-${format}.zip`, file.blob, MIME.zip);
  return saveBlob(saved.blob, saved.name, saved.mime);
}

export async function shareZip(ids: string[], format: "webp" | "png"): Promise<Delivered> {
  const file = await api.exportStickers(ids, format);
  const saved = named(file.fileName, `stickers-${format}.zip`, file.blob, MIME.zip);
  return shareBlob(saved.blob, saved.name, saved.mime);
}

/** Last-used is best-effort. The file was already handed to the user. */
export async function markUsed(ids: string[]) {
  if (!ids.length) return;
  try {
    await api.bulkStickers({ action: "touch", ids });
  } catch {
    // Ignore. A failed touch must not look like a failed download.
  }
}

import { ApiError, api } from "../../api/client";
import type { StickerJobSource } from "../../types";
import { base64ToBlob, takePendingSticker } from "../../utils/hostBridge";

export interface CreateSeed {
  blob: Blob;
  name: string;
  source: StickerJobSource;
}

export type HandoffEvent =
  | { type: "saved"; created: boolean; qualityReduced: boolean }
  | { type: "error"; code?: string };

let queuedCreate: CreateSeed | null = null;
let saving = false;
let onEvent: ((event: HandoffEvent) => void) | null = null;

export function bindHandoffNotice(listener: ((event: HandoffEvent) => void) | null) {
  onEvent = listener;
}

async function saveToLibrary(blob: Blob, name: string) {
  try {
    const upload = await api.uploadStickerSource(blob, name);
    const { jobId } = await api.createStickerJob({
      uploadId: upload.uploadId,
      source: "MEDIA_HUB",
    });
    for (;;) {
      const job = await api.getStickerJob(jobId);
      if (job.state === "done") {
        onEvent?.({
          type: "saved",
          created: job.created !== false,
          qualityReduced: job.qualityReduced === true,
        });
        return;
      }
      if (job.state === "failed") {
        onEvent?.({ type: "error", code: job.error?.code });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
  } catch (err) {
    onEvent?.({ type: "error", code: err instanceof ApiError ? err.code : undefined });
  } finally {
    saving = false;
  }
}

/**
 * Read a one-shot Media Hub sticker. The create payload is kept until the
 * studio clears it, so a React strict-mode remount can still open Create.
 * A save runs to completion even if the view unmounts.
 */
export function claimCreateSeed(): CreateSeed | null {
  // A save already in flight must not consume the next one-shot handoff.
  if (saving) return queuedCreate;
  const pending = takePendingSticker();
  if (pending?.intent === "create") {
    queuedCreate = {
      blob: base64ToBlob(pending.data, pending.mime),
      name: pending.name || "sticker",
      source: "MEDIA_HUB",
    };
  } else if (pending?.intent === "save" && !saving) {
    saving = true;
    void saveToLibrary(base64ToBlob(pending.data, pending.mime), pending.name || "sticker");
  }
  return queuedCreate;
}

export function clearCreateSeed() {
  queuedCreate = null;
}

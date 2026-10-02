import { ApiError, api } from "../../api/client";
import type { StickerJobSource } from "../../types";
import { takePendingSticker, uploadHostSource } from "../../utils/hostBridge";
import { UPLOAD_MAX_BYTES } from "../../utils/stickerLimits";

export interface CreateSeed {
  blob: Blob | Promise<Blob>;
  name: string;
  source: StickerJobSource;
  token?: string;
  existingId?: string;
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

async function saveToLibrary(token: string, name: string) {
  try {
    const upload = await uploadHostSource(token, name, UPLOAD_MAX_BYTES);
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
      blob: fetch(pending.url).then((response) => {
        if (!response.ok) throw new Error("source unavailable");
        return response.blob();
      }),
      name: pending.name || "sticker",
      source: "MEDIA_HUB",
      token: pending.token,
    };
  } else if (pending?.intent === "save" && !saving) {
    saving = true;
    void saveToLibrary(pending.token, pending.name || "sticker");
  }
  return queuedCreate;
}

export function clearCreateSeed() {
  queuedCreate = null;
}

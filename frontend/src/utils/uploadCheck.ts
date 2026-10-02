import type { translations } from "../i18n/translations";
import type { Capabilities } from "../types";

type Key = keyof typeof translations.en;

function isVideo(file: File): boolean {
  return file.type.startsWith("video/") || /\.(mp4|webm|mov|mkv)$/i.test(file.name);
}

function probeImage(file: File): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    image.src = url;
  });
}

function probeVideo(
  file: File,
): Promise<{ width: number; height: number; duration: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      const result = {
        width: video.videoWidth,
        height: video.videoHeight,
        duration: video.duration,
      };
      URL.revokeObjectURL(url);
      video.src = "";
      resolve(result);
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    video.src = url;
  });
}

/**
 * Reject a file the server would refuse, before the bytes are uploaded.
 * `limits.maxSide` is the largest source side (4096), not the 512 sticker canvas.
 * A probe that cannot be read is left for the server.
 */
export async function uploadBlockReason(
  file: File,
  limits: Capabilities["limits"],
): Promise<Key | null> {
  if (file.size <= 0) return "stickerErr_NO_MEDIA";
  if (file.size > limits.uploadBytes) return "stickerErr_TOO_LARGE";
  if (isVideo(file)) {
    const probed = await probeVideo(file);
    if (!probed) return null;
    if (probed.width > limits.maxSide || probed.height > limits.maxSide) {
      return "stickerErr_DIMENSIONS_TOO_LARGE";
    }
    if (Number.isFinite(probed.duration) && probed.duration > limits.videoSeconds + 0.05) {
      return "stickerErr_VIDEO_TOO_LONG";
    }
    return null;
  }
  const image = await probeImage(file);
  if (image && (image.width > limits.maxSide || image.height > limits.maxSide)) {
    return "stickerErr_DIMENSIONS_TOO_LARGE";
  }
  return null;
}

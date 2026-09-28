// Getting WhatsApp media in front of Gemini.
//
// Two things used to break here, and both ended in an error card instead of an
// answer:
//
//   * The Files API needs a MIME type, and @google/genai reads it from
//     `config.mimeType` or infers it from a file extension — nowhere else. The
//     agent passed it at the top level of the call and wrote the bytes to a
//     temp file with no extension, so every photo, video, voice note and
//     document failed with "Can not determine mimeType".
//   * WhatsApp labels voice notes `audio/ogg; codecs=opus`. Gemini's supported
//     type is `audio/ogg`; the codec parameter is not part of it.
//
// Nothing here touches the disk. The bytes go up as a Blob, so there is no temp
// file written next to the code (which a global install, a packaged binary or
// the Android build may not even allow) and nothing to clean up afterwards.

// Used only when WhatsApp sent no MIME type at all.
const FALLBACK_MIME = {
  image: "image/jpeg",
  video: "video/mp4",
  audio: "audio/ogg",
  document: "application/octet-stream",
};

// A video is usable only once Google has processed it; images and audio are
// normally ACTIVE straight away.
const PROCESSING_POLL_MS = 1500;
const PROCESSING_TIMEOUT_MS = 90_000;

/** "image" | "video" | "audio" | "document", from a MIME type. */
function mediaKind(mime) {
  const type = String(mime || "").toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  return "document";
}

/**
 * The bare type Gemini expects: parameters dropped, lower-cased.
 * `audio/ogg; codecs=opus` -> `audio/ogg`.
 */
function baseMimeType(mime, kind = mediaKind(mime)) {
  const bare = String(mime || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  return bare || FALLBACK_MIME[kind] || FALLBACK_MIME.document;
}

/**
 * Download and decrypt a WhatsApp media message into one Buffer.
 *
 * `downloadType` picks the decryption keys, so it has to follow the message
 * type (an image sent as a document is a "document"), not the MIME type.
 */
async function downloadMedia(downloadContentFromMessage, mediaMessage, downloadType) {
  const stream = await downloadContentFromMessage(mediaMessage, downloadType);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const buffer = Buffer.concat(chunks);
  if (!buffer.length) throw new Error("Empty media buffer");
  return buffer;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Upload bytes to the Gemini Files API and return the File once it can be
 * used in a request.
 */
async function uploadToGemini(
  genAI,
  buffer,
  mimeType,
  { displayName, pollMs = PROCESSING_POLL_MS, timeoutMs = PROCESSING_TIMEOUT_MS } = {},
) {
  let file = await genAI.files.upload({
    file: new Blob([buffer], { type: mimeType }),
    config: { mimeType, ...(displayName ? { displayName } : {}) },
  });

  const deadline = Date.now() + timeoutMs;
  while (file?.state === "PROCESSING" && file.name) {
    if (Date.now() > deadline) {
      throw new Error("Gemini is still processing the file — try again in a moment");
    }
    await sleep(pollMs);
    file = await genAI.files.get({ name: file.name });
  }
  if (file?.state === "FAILED") {
    throw new Error("Gemini could not process this file");
  }
  if (!file?.uri) throw new Error("Gemini did not return a file URI");
  return file;
}

module.exports = { mediaKind, baseMimeType, downloadMedia, uploadToGemini };

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
//
// And not every Gemini endpoint has a Files API. A gateway or reverse proxy set
// as `gemini_base_url` often forwards generateContent and nothing else — and
// even one that forwards everything breaks if it lives under a path: the SDK
// takes the upload URL Google hands back and swaps in the base URL's host only,
// so `https://proxy.example/gemini` uploads to `https://proxy.example/upload/…`
// and gets the proxy's own 404. Text and voice notes worked (they ride inside
// the request); every photo failed. geminiMediaPart() tries the upload, and
// when the endpoint isn't there sends the bytes inline instead — and remembers,
// so the next photo doesn't pay for the failed upload again.

const logger = require("./logger.cjs");

// Used only when WhatsApp sent no MIME type at all.
const FALLBACK_MIME = {
  image: "image/jpeg",
  video: "video/mp4",
  audio: "audio/ogg",
  document: "application/octet-stream",
};

// Gemini caps a whole inline request at 20 MB; media past this goes through the
// Files API or not at all.
const INLINE_MEDIA_LIMIT = 15 * 1024 * 1024;

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

/**
 * True when an upload failed because the endpoint has no Files API — not
 * because of the key, the quota or the file. A 404/405/501, an HTML page where
 * JSON belongs, or the SDK's own complaints about the upload handshake.
 */
function isMissingUploadEndpoint(error) {
  const status = Number(error?.status || error?.code || error?.response?.status);
  if ([404, 405, 501].includes(status)) return true;
  const message = String(error?.message || "");
  return /<html|upload url|upload status is not finalized/i.test(message);
}

// Base URLs whose Files API turned out to be missing. In memory on purpose: a
// restart (or a changed base URL) tries the upload again.
const inlineOnly = new Set();

/**
 * The part that puts `buffer` in front of Gemini: a `fileData` reference when
 * the Files API is there, else the bytes inline.
 *
 * Inline media rides along in the stored conversation, the way the
 * OpenAI-compatible and Anthropic providers already keep their images, so a
 * follow-up question can still see the photo.
 */
async function geminiMediaPart(genAI, buffer, mimeType, { baseUrl = "", ...uploadOptions } = {}) {
  const key = baseUrl || "(default)";
  const inline = () => ({ inlineData: { mimeType, data: buffer.toString("base64") } });
  const fitsInline = buffer.length <= INLINE_MEDIA_LIMIT;

  if (inlineOnly.has(key) && fitsInline) return inline();

  try {
    const file = await uploadToGemini(genAI, buffer, mimeType, uploadOptions);
    return { fileData: { fileUri: file.uri, mimeType: file.mimeType || mimeType } };
  } catch (error) {
    if (!fitsInline || !isMissingUploadEndpoint(error)) throw error;
    inlineOnly.add(key);
    logger.warn(
      { status: error?.status, baseUrl: baseUrl || null },
      "[geminiMedia] this Gemini endpoint has no Files API — sending media inline from now on",
    );
    return inline();
  }
}

module.exports = {
  INLINE_MEDIA_LIMIT,
  mediaKind,
  baseMimeType,
  downloadMedia,
  uploadToGemini,
  geminiMediaPart,
  isMissingUploadEndpoint,
};

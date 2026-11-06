// Shared cost/concurrency boundary for model-initiated media operations.
const settings = require("../config/settings.cjs");
const { isTrustedCaller } = require("./aiToolAuth.cjs");
const MAX_MEDIA_BYTES = 8 * 1024 * 1024;
const windows = new Map();
const WINDOW_MS = 60_000;

async function withMediaLimit(caller, action) {
  if (!isTrustedCaller(caller) || !caller.senderId) throw new Error("MEDIA_CALLER_REQUIRED");
  const now = Date.now();
  for (const [key, state] of windows) {
    if (!state.busy && now - state.start >= WINDOW_MS) windows.delete(key);
  }
  const key = caller.senderId;
  let state = windows.get(key);
  if (state?.busy) throw new Error("MEDIA_BUSY");
  if (!state) {
    if (windows.size >= 1000) throw new Error("MEDIA_BUSY");
    state = { start: now, attempts: 0, busy: false };
    windows.set(key, state);
  }
  if (state.attempts >= 3) throw new Error("MEDIA_RATE_LIMIT");
  state.attempts += 1;
  state.busy = true;
  const controller = new AbortController();
  const timeout = Math.max(
    1,
    Math.min(120_000, Number(settings.get("ai_tool_timeout_ms")) || 30_000),
  );
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error("MEDIA_TIMEOUT");
      controller.abort(error);
      reject(error);
    }, timeout);
  });
  // Keep a non-cancellable operation busy until it actually finishes, even
  // after its caller has timed out. It must check this signal before sending.
  const work = Promise.resolve()
    .then(() => action(controller.signal))
    .finally(() => {
      state.busy = false;
    });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

function assertAudio(buffer, mimetype, ptt = false) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4 || buffer.length > MAX_MEDIA_BYTES) {
    throw new Error("MEDIA_AUDIO_INVALID");
  }
  const mime = String(mimetype || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const ogg = buffer.subarray(0, 4).toString() === "OggS";
  const mpeg =
    buffer.subarray(0, 3).toString() === "ID3" || (buffer[0] === 255 && (buffer[1] & 224) === 224);
  const valid =
    mime === "audio/ogg"
      ? ogg
      : ["audio/mpeg", "audio/mp3", "audio/aac"].includes(mime)
        ? mpeg
        : ["audio/wav", "audio/x-wav"].includes(mime)
          ? buffer.subarray(0, 4).toString() === "RIFF" &&
            buffer.subarray(8, 12).toString() === "WAVE"
          : ["audio/mp4", "audio/m4a"].includes(mime)
            ? buffer.subarray(4, 8).toString() === "ftyp"
            : mime === "audio/flac"
              ? buffer.subarray(0, 4).toString() === "fLaC"
              : mime === "audio/webm"
                ? buffer.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))
                : mime === "audio/amr"
                  ? buffer.subarray(0, 5).toString() === "#!AMR"
                  : false;
  if (!valid || (ptt && !ogg)) throw new Error("MEDIA_AUDIO_INVALID");
  return buffer;
}

function assertWhatsAppAudio(audio) {
  if (!audio || Number(audio.fileLength || 0) > MAX_MEDIA_BYTES)
    throw new Error("MEDIA_NOT_AVAILABLE");
  if (audio.url) {
    let url;
    try {
      url = new URL(audio.url);
    } catch {
      throw new Error("MEDIA_URL_INVALID");
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      !/^(?:[a-z0-9-]+\.)*whatsapp\.net$/i.test(url.hostname)
    )
      throw new Error("MEDIA_URL_INVALID");
  }
  if (
    audio.directPath &&
    (typeof audio.directPath !== "string" ||
      !audio.directPath.startsWith("/") ||
      audio.directPath.startsWith("//") ||
      audio.directPath.includes("\\"))
  ) {
    throw new Error("MEDIA_URL_INVALID");
  }
  if (!audio.url && !audio.directPath) throw new Error("MEDIA_NOT_AVAILABLE");
  if (
    !/^audio\/(?:ogg|mpeg|mp3|aac|wav|x-wav|mp4|m4a|flac|webm|amr)(?:\s*;.*)?$/i.test(
      audio.mimetype || "",
    )
  ) {
    throw new Error("MEDIA_AUDIO_INVALID");
  }
}

function mediaFailure(error) {
  const message = String(error?.message || "");
  const known =
    /^(?:MEDIA_(?:TIMEOUT|RATE_LIMIT|BUSY|AUDIO_INVALID|URL_INVALID|NOT_AVAILABLE|TOO_LARGE|DISABLED|ARGUMENT_INVALID|DELIVERY_REFUSED|CALLER_REQUIRED)|IMAGE_(?:KEY_REQUIRED|OUTPUT_INVALID|QUOTA|FAILED)|STT_(?:KEY_REQUIRED|QUOTA|OUTPUT_INVALID|FAILED))$/;
  const code = known.test(error?.code)
    ? error.code
    : known.test(message)
      ? message
      : /quota|429|RESOURCE_EXHAUSTED/i.test(message)
        ? "MEDIA_RATE_LIMIT"
        : "MEDIA_FAILED";
  return {
    error:
      "The media request could not be completed. Check the error code, permissions and configured provider.",
    code,
  };
}

module.exports = {
  withMediaLimit,
  assertAudio,
  assertWhatsAppAudio,
  mediaFailure,
  MAX_MEDIA_BYTES,
};

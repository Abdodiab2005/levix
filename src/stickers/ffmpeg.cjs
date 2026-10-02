// Sticker Studio's single FFmpeg runner. Forced demuxers and a file/pipe
// protocol whitelist prevent a crafted input from opening playlists or URLs.
const { spawn } = require("node:child_process");
const path = require("node:path");
const { ffmpegPath } = require("../utils/thumbnail.cjs");
const { StickerError } = require("./errors.cjs");
const { FFMPEG_STEP_TIMEOUT_MS } = require("./limits.cjs");

const DEMUXERS = new Set([
  "png_pipe",
  "jpeg_pipe",
  "gif",
  "webp_pipe",
  "mov",
  "matroska",
  "rawvideo",
]);

function validateInputs(args) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new TypeError("FFmpeg arguments must be strings");
  }
  let start = 0;
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "-i") continue;
    const prefix = args.slice(start, i);
    const f = prefix.lastIndexOf("-f");
    const whitelist = prefix.lastIndexOf("-protocol_whitelist");
    if (
      f < 0 ||
      !DEMUXERS.has(prefix[f + 1]) ||
      whitelist < 0 ||
      prefix[whitelist + 1] !== "file,pipe" ||
      !(args[i + 1] === "pipe:0" || path.isAbsolute(args[i + 1] || ""))
    ) {
      throw new StickerError("CONVERSION_FAILED");
    }
    start = i + 2;
  }
}

function run(
  args,
  {
    input,
    signal,
    maxOutputBytes = 32 * 1024 * 1024,
    timeoutMs = FFMPEG_STEP_TIMEOUT_MS,
    probe = false,
  } = {},
) {
  validateInputs(args);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new StickerError("TIMEOUT"));
    const argv = [
      "-hide_banner",
      "-nostdin",
      "-loglevel",
      "error",
      ...(probe ? ["-loglevel", "info"] : []),
      ...args,
    ];
    let child;
    try {
      child = spawn(ffmpegPath(), argv, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (cause) {
      reject(new StickerError("CONVERSION_FAILED", {}, { cause }));
      return;
    }
    let total = 0;
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let overflow = false;
    let sourceError = null;
    const pieces = [];
    const abort = () => {
      timedOut = true;
      child.kill("SIGKILL");
    };
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    child.stdout.on("data", (part) => {
      total += part.length;
      if (total > maxOutputBytes) {
        overflow = true;
        child.kill("SIGKILL");
      } else pieces.push(part);
    });
    child.stderr.on("data", (part) => {
      stderr = (stderr + part.toString()).slice(-4096);
    });
    child.on("error", (cause) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      input?.destroy?.();
      reject(new StickerError("CONVERSION_FAILED", {}, { cause }));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      input?.destroy?.();
      if (sourceError) {
        reject(
          sourceError instanceof StickerError
            ? sourceError
            : new StickerError("CONVERSION_FAILED", {}, { cause: sourceError }),
        );
      } else if (timedOut) {
        reject(new StickerError("TIMEOUT"));
      } else if (overflow || code !== 0) {
        reject(new StickerError("CONVERSION_FAILED", {}, { cause: stderr }));
      } else {
        resolve({ buffer: Buffer.concat(pieces), stderr });
      }
    });
    if (Buffer.isBuffer(input)) child.stdin.end(input);
    else if (input) {
      input.on("error", (error) => {
        sourceError = error;
        child.kill("SIGKILL");
      });
      input.pipe(child.stdin);
    } else child.stdin.end();
    child.stdin.on("error", () => {});
  });
}

module.exports = { run };

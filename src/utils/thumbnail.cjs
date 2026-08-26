// Outgoing media thumbnails (jpegThumbnail) for images and videos.
//
// Why this file exists
// --------------------
// Baileys only attaches a `jpegThumbnail` to an outgoing image/video when it
// can find the tools it needs:
//   * images -> an image processing library (`sharp` or `jimp`)
//   * videos -> an `ffmpeg` binary ON THE PATH (it shells out to `ffmpeg ...`)
//
// This project ships neither: sharp/jimp aren't dependencies, and our ffmpeg
// comes from the `ffmpeg-static` package — a binary inside node_modules that is
// NOT on the PATH. So Baileys silently gives up and every picture / clip the
// bot sends arrives with a blank grey preview: no thumbnail in the chat list,
// none in reply quotes, and nothing to look at until the media downloads.
//
// The fix is to build the thumbnail ourselves with the ffmpeg we already have
// and hand it to Baileys ready-made — Baileys skips its own generation when
// `jpegThumbnail` is already present on the content. While ffmpeg has the file
// open we also read the real dimensions (and a video's duration), which Baileys
// would otherwise leave empty and which WhatsApp uses to size the bubble
// before the download finishes.
//
// CommonJS on purpose: both the ESM core and the .cjs commands consume it.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const logger = require("./logger.cjs");

// Only used for remote sources; required lazily so a missing axios can never
// take the send path down.
function getAxios() {
  try {
    return require("axios");
  } catch {
    return null;
  }
}

const ffmpegStatic = (() => {
  try {
    return require("ffmpeg-static");
  } catch {
    return null;
  }
})();

// Read at call time so the dashboard can point at another binary without a
// restart; ffmpeg-static is what ships with the bot and works nearly everywhere.
function ffmpegBin() {
  return settings.get("ffmpeg_path") || ffmpegStatic || "ffmpeg";
}
const FFMPEG_TIMEOUT_MS = 20000;

// WhatsApp carries the preview inline in the message envelope — keep it small.
// (Real clients send ~100–300px JPEGs; anything huge just bloats the stanza.)
const MAX_THUMB_BYTES = 60 * 1024;
const THUMB_STEPS = [
  [320, 6],
  [240, 10],
  [160, 16],
  [120, 22],
];

// Media handed to us as a remote URL (`{ image: { url: "https://…" } }`) used
// to get no preview at all, because we refused to fetch it. We now pull it
// down once — capped and time-boxed — so those sends look like every other.
// Read per call (config/settings.cjs) so the dashboard can flip these without
// a restart.
const settings = require("../config/settings.cjs");
const remoteThumbsEnabled = () => settings.get("thumbnail_remote");
const remoteMaxBytes = () => settings.get("thumbnail_remote_max_mb") * 1024 * 1024;
const remoteTimeoutMs = () => settings.get("thumbnail_remote_timeout_ms");

// Last-resort fallback: when ffmpeg can't run at all, a JPEG that is already
// small enough can simply BE its own preview. Not ideal (the full picture
// travels twice) but a real preview beats a grey box, and it keeps the feature
// working on hosts where the ffmpeg-static binary is missing or unusable.
const RAW_JPEG_FALLBACK_BYTES = 100 * 1024;

// Flipped to false the first time the binary turns out to be missing, so we
// don't pay a failed spawn on every single media message.
let ffmpegAvailable = true;
let warnedAboutFfmpeg = false;

function warnMissingFfmpeg(reason) {
  if (warnedAboutFfmpeg) return;
  warnedAboutFfmpeg = true;
  logger.warn(
    { ffmpeg: ffmpegBin(), reason },
    "[thumbnail] ffmpeg isn't runnable — video previews are off and images " +
      "fall back to raw-JPEG previews. Reinstall `ffmpeg-static`, or point " +
      "Settings -> Media -> ffmpeg path at a working binary."
  );
}

// ---------------------------------------------------------------------------
// tiny fs helpers
// ---------------------------------------------------------------------------

function tmpPath(ext) {
  const rand = Math.random().toString(36).slice(2, 10);
  return path.join(os.tmpdir(), `wa-bot-thumb-${Date.now()}-${rand}.${ext}`);
}

function safeUnlink(file) {
  if (!file) return;
  try {
    fs.unlinkSync(file);
  } catch {
    // already gone
  }
}

function sizeOf(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// ffmpeg
// ---------------------------------------------------------------------------

/**
 * Run ffmpeg and always resolve — the caller decides what a failure means.
 * We keep stderr because that's where ffmpeg prints the stream info we parse.
 */
function runFfmpeg(args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(ffmpegBin(), ["-hide_banner", "-nostdin", ...args], {
        windowsHide: true,
      });
    } catch (err) {
      ffmpegAvailable = false;
      warnMissingFfmpeg(err?.message);
      return resolve({ ok: false, stderr: String(err?.message || err), stdout: "" });
    }

    let stderr = "";
    let stdout = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already dead
      }
    }, FFMPEG_TIMEOUT_MS);

    child.stderr?.on("data", (chunk) => {
      // ffmpeg can be chatty; the header we care about comes first.
      if (stderr.length < 64 * 1024) stderr += chunk.toString();
    });
    child.stdout?.on("data", (chunk) => {
      if (stdout.length < 4 * 1024) stdout += chunk.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      // ENOENT (no binary) / EACCES (not executable) / ENOEXEC (wrong libc —
      // happens with ffmpeg-static on Alpine) are all permanent for this run.
      if (["ENOENT", "EACCES", "ENOEXEC"].includes(err?.code)) {
        ffmpegAvailable = false;
        warnMissingFfmpeg(err?.code);
      }
      resolve({ ok: false, stderr: String(err?.message || err), stdout });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stderr, stdout });
    });
  });
}

/**
 * Is the ffmpeg binary actually runnable here? Used by `!status` so a missing
 * or unusable binary is visible instead of silently costing every preview.
 *
 * @returns {Promise<{ok: boolean, path: string, version?: string, error?: string}>}
 */
async function checkFfmpeg() {
  const result = await runFfmpeg(["-version"]);
  if (result.ok) {
    ffmpegAvailable = true;
    const version = (result.stdout.split("\n")[0] || "").trim();
    return { ok: true, path: ffmpegBin(), version };
  }
  return { ok: false, path: ffmpegBin(), error: result.stderr.slice(0, 200) };
}

/** Pull `1920x1080` / `Duration: 00:01:23.45` out of ffmpeg's stderr header. */
function parseProbe(stderr = "") {
  const info = {
    width: 0,
    height: 0,
    seconds: 0,
    hasVideo: /Stream #\d+:\d+[^\n]*?: Video:/.test(stderr),
    hasAudio: /Stream #\d+:\d+[^\n]*?: Audio:/.test(stderr),
  };

  const dimensions = stderr.match(
    /Stream #\d+:\d+[^\n]*?: Video:[^\n]*?[,\s](\d{2,5})x(\d{2,5})/
  );
  if (dimensions) {
    info.width = Number(dimensions[1]) || 0;
    info.height = Number(dimensions[2]) || 0;
  }

  const duration = stderr.match(/Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/);
  if (duration) {
    const seconds =
      Number(duration[1]) * 3600 +
      Number(duration[2]) * 60 +
      Number(duration[3]);
    // Round, but never down to 0 — a sub-second clip still has a duration.
    if (Number.isFinite(seconds) && seconds > 0) {
      info.seconds = Math.max(1, Math.round(seconds));
    }
  }

  return info;
}

/**
 * Build a JPEG preview of a local image/video file.
 *
 * @param {string} filePath
 * @param {"image"|"video"} kind
 * @returns {Promise<{thumbnail: Buffer, width: number, height: number, seconds: number}|null>}
 */
async function generateThumbnail(filePath, kind) {
  if (!ffmpegAvailable) return null;

  let probe = null;
  let fallback = null; // smallest buffer we managed to produce

  for (const [width, quality] of THUMB_STEPS) {
    const target = tmpPath("jpg");
    const encodeArgs = [
      "-i",
      filePath,
      "-frames:v",
      "1",
      "-vf",
      `scale='min(${width},iw)':-2`,
      "-q:v",
      String(quality),
      "-f",
      "image2",
      target,
    ];

    // For video, seek a second in — frame 0 of a lot of clips is a black fade.
    let result = await runFfmpeg(
      kind === "video" ? ["-y", "-ss", "1", ...encodeArgs] : ["-y", ...encodeArgs]
    );

    if (kind === "video" && (!result.ok || !sizeOf(target))) {
      // Clip shorter than the seek point — take the very first frame instead.
      result = await runFfmpeg(["-y", ...encodeArgs]);
    }

    if (!ffmpegAvailable) {
      safeUnlink(target);
      return null;
    }

    if (!probe) probe = parseProbe(result.stderr);

    const bytes = sizeOf(target) ? fs.readFileSync(target) : null;
    safeUnlink(target);

    if (!bytes?.length) continue;
    if (bytes.length <= MAX_THUMB_BYTES) {
      return { thumbnail: bytes, ...probe };
    }
    fallback = bytes; // still too heavy — try the next, smaller step
  }

  if (fallback) return { thumbnail: fallback, ...(probe || {}) };
  return null;
}

// ---------------------------------------------------------------------------
// pure-JS image headers (no ffmpeg needed)
// ---------------------------------------------------------------------------

/** Dimensions straight out of a JPEG's SOF marker. */
function jpegMeta(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;

  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = buffer[offset + 1];
    // standalone markers carry no length
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break; // end of header / start of scan
    const length = buffer.readUInt16BE(offset + 2);
    // SOF0..SOF15, minus the DHT/JPG/DAC markers that share the range
    const isFrameHeader =
      marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isFrameHeader) {
      return {
        format: "jpeg",
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }
    if (length < 2) break;
    offset += 2 + length;
  }
  return { format: "jpeg", width: 0, height: 0 };
}

/**
 * Format + dimensions from the file header alone. Covers the formats WhatsApp
 * actually carries; anything else just reports nothing.
 */
function readImageMeta(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) return null;

  if (buffer[0] === 0xff && buffer[1] === 0xd8) return jpegMeta(buffer);

  // PNG: 8-byte signature, then IHDR (length+type) then w/h
  if (buffer.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    return {
      format: "png",
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
  }

  if (buffer.subarray(0, 3).toString("latin1") === "GIF") {
    return {
      format: "gif",
      width: buffer.readUInt16LE(6),
      height: buffer.readUInt16LE(8),
    };
  }

  if (
    buffer.subarray(0, 4).toString("latin1") === "RIFF" &&
    buffer.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    const chunk = buffer.subarray(12, 16).toString("latin1");
    if (chunk === "VP8X" && buffer.length >= 30) {
      return {
        format: "webp",
        width: (buffer.readUIntLE(24, 3) & 0xffffff) + 1,
        height: (buffer.readUIntLE(27, 3) & 0xffffff) + 1,
      };
    }
    if (chunk === "VP8 " && buffer.length >= 30) {
      return {
        format: "webp",
        width: buffer.readUInt16LE(26) & 0x3fff,
        height: buffer.readUInt16LE(28) & 0x3fff,
      };
    }
    if (chunk === "VP8L" && buffer.length >= 25) {
      const bits = buffer.readUInt32LE(21);
      return {
        format: "webp",
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
      };
    }
    return { format: "webp", width: 0, height: 0 };
  }

  return null;
}

/** Read just enough of a file to identify it (JPEG SOF can sit past big EXIF). */
function readHead(filePath, bytes = 512 * 1024) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(Math.min(bytes, sizeOf(filePath)));
    fs.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

// ---------------------------------------------------------------------------
// content enrichment
// ---------------------------------------------------------------------------

/** Give ffmpeg a filename it can demux from: guess the extension. */
function extensionFor(buffer, kind) {
  const meta = readImageMeta(buffer);
  if (meta?.format) return meta.format === "jpeg" ? "jpg" : meta.format;
  return kind === "video" ? "mp4" : "bin";
}

/** Fetch a remote asset to a temp file so we can build a preview from it. */
async function downloadToTemp(url, kind) {
  const axios = getAxios();
  if (!axios) return null;

  const response = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: remoteTimeoutMs(),
    maxRedirects: 4,
    maxContentLength: remoteMaxBytes(),
    headers: { Accept: "*/*" },
  });

  const buffer = Buffer.from(response.data);
  if (!buffer.length) return null;

  const file = tmpPath(extensionFor(buffer, kind));
  await fs.promises.writeFile(file, buffer);
  return { file, temp: true };
}

/**
 * Turn whatever Baileys accepts as media into a local file path.
 * Streams are skipped on purpose: consuming one here would leave nothing for
 * the actual upload.
 */
async function resolveSource(media, kind) {
  if (Buffer.isBuffer(media)) {
    if (!media.length) return null;
    const file = tmpPath(extensionFor(media, kind));
    await fs.promises.writeFile(file, media);
    return { file, temp: true };
  }

  const url =
    typeof media === "string"
      ? media
      : media && typeof media === "object" && typeof media.url === "string"
        ? media.url
        : null;

  if (!url) return null;

  if (/^https?:\/\//i.test(url)) {
    if (!remoteThumbsEnabled()) return null;
    try {
      return await downloadToTemp(url, kind);
    } catch (err) {
      logger.debug(
        { err: err?.message, url },
        "[thumbnail] remote source could not be fetched for a preview"
      );
      return null;
    }
  }

  return sizeOf(url) ? { file: url, temp: false } : null;
}

/**
 * What in this content could carry a preview?
 *   image / video          -> the obvious ones
 *   document + image|video mimetype -> WhatsApp renders a preview for those
 *                                      too, and a document was the one send
 *                                      path that never got one
 * Everything else (text, audio, stickers, edits, reactions, deletes) is passed
 * straight through.
 *
 * @returns {{field: string, kind: "image"|"video"}|null}
 */
function previewTarget(content) {
  if (content.image) return { field: "image", kind: "image" };
  if (content.video) return { field: "video", kind: "video" };

  if (content.document) {
    const mime = String(content.mimetype || "");
    if (mime.startsWith("image/")) return { field: "document", kind: "image" };
    if (mime.startsWith("video/")) return { field: "document", kind: "video" };
  }

  return null;
}

/**
 * Return `content` with `jpegThumbnail` (and width/height/seconds when we can
 * work them out) filled in. Never throws: a missing preview is not a reason to
 * drop a message.
 */
async function withMediaThumbnail(content) {
  if (!content || typeof content !== "object") return content;

  const target = previewTarget(content);
  if (!target) return content;
  if (content.jpegThumbnail) return content; // caller supplied its own

  const { field, kind } = target;

  let source = null;
  try {
    source = await resolveSource(content[field], kind);
    if (!source) return content;

    const info = await generateThumbnail(source.file, kind);

    // ffmpeg is missing or choked on this file — read what we can from the
    // header, and let a small JPEG stand in as its own preview.
    let headerMeta = null;
    const readHeaderMeta = () => {
      if (headerMeta !== null) return headerMeta;
      const head = readHead(source.file);
      headerMeta = (head && readImageMeta(head)) || false;
      return headerMeta;
    };

    let thumbnail = info?.thumbnail || null;
    if (!thumbnail && kind === "image") {
      const meta = readHeaderMeta();
      if (meta && meta.format === "jpeg" && sizeOf(source.file) <= RAW_JPEG_FALLBACK_BYTES) {
        thumbnail = fs.readFileSync(source.file);
        logger.debug(
          { bytes: thumbnail.length },
          "[thumbnail] reusing the image itself as its preview"
        );
      }
    }

    // Dimensions matter even when the preview itself failed: WhatsApp sizes the
    // bubble from them, so a wrong/zero size is a visibly broken message.
    let width = info?.width || 0;
    let height = info?.height || 0;
    if ((!width || !height) && kind === "image") {
      const meta = readHeaderMeta();
      if (meta) {
        width = width || meta.width || 0;
        height = height || meta.height || 0;
      }
    }

    const patch = {};
    if (thumbnail) patch.jpegThumbnail = thumbnail;
    if (width && height && !content.width && !content.height) {
      patch.width = width;
      patch.height = height;
    }
    if (kind === "video" && info?.seconds && !content.seconds) {
      patch.seconds = info.seconds;
    }

    if (!Object.keys(patch).length) {
      logger.debug({ kind, field }, "[thumbnail] no preview could be built");
      return content;
    }

    return { ...content, ...patch };
  } catch (err) {
    logger.debug(
      { err: err?.message, kind, field },
      "[thumbnail] could not build a preview — sending without one"
    );
    return content;
  } finally {
    if (source?.temp) safeUnlink(source.file);
  }
}

module.exports = {
  withMediaThumbnail,
  previewTarget,
  generateThumbnail,
  readImageMeta,
  checkFfmpeg,
  isFfmpegAvailable: () => ffmpegAvailable,
  ffmpegPath: () => ffmpegBin(),
};

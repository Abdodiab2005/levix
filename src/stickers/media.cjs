// One converter for panel and bot stickers. A bounded quality ladder keeps
// WhatsApp files small without needlessly warning about moderate compression.
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { Readable } = require("node:stream");
const { setImmediate: nextTick } = require("node:timers/promises");
const { ensureDataDir } = require("../config/paths.cjs");
const { ffmpegPath, readImageMeta } = require("../utils/thumbnail.cjs");
const { StickerError } = require("./errors.cjs");
const L = require("./limits.cjs");
const { normalizeOptions, placement } = require("./options.cjs");
const webp = require("./webp.cjs");
const ffmpeg = require("./ffmpeg.cjs");

const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const DEMUX = {
  "image/png": "png_pipe",
  "image/jpeg": "jpeg_pipe",
  "image/gif": "gif",
  "image/webp": "webp_pipe",
  "video/mp4": "mov",
  "video/quicktime": "mov",
  "video/3gpp": "mov",
  "video/webm": "matroska",
};
let cachedCapabilities;
let cachedFfmpegPath;

function sniff(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  if (
    buffer.length >= 24 &&
    buffer.subarray(0, 8).equals(PNG) &&
    buffer.toString("ascii", 12, 16) === "IHDR"
  )
    return { kind: "image", mime: "image/png", ext: "png" };
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
    return { kind: "image", mime: "image/jpeg", ext: "jpg" };
  if (buffer.length >= 10 && ["GIF87a", "GIF89a"].includes(buffer.toString("ascii", 0, 6)))
    return { kind: "gif", mime: "image/gif", ext: "gif" };
  if (
    buffer.length >= 20 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  )
    return { kind: "webp", mime: "image/webp", ext: "webp" };
  if (buffer.length >= 12 && buffer.toString("ascii", 4, 8) === "ftyp") {
    const brands = buffer.toString("ascii", 8, Math.min(buffer.length, 32));
    if (/^(qt {2})/.test(brands)) return { kind: "video", mime: "video/quicktime", ext: "mov" };
    if (/^(3g[ep6789])/.test(brands)) return { kind: "video", mime: "video/3gpp", ext: "3gp" };
    if (/^(isom|iso[23456]|mp4[12]|mp41|avc1|M4V |MSNV|dash)/.test(brands))
      return { kind: "video", mime: "video/mp4", ext: "mp4" };
  }
  if (
    buffer.length >= 16 &&
    buffer.subarray(0, 4).equals(Buffer.from("1a45dfa3", "hex")) &&
    /(?:webm|matroska)/i.test(buffer.toString("latin1", 0, Math.min(256, buffer.length)))
  )
    return { kind: "video", mime: "video/webm", ext: "webm" };
  return null;
}

function sourceArgs(sniffed, input) {
  const demux = DEMUX[sniffed?.mime];
  if (!demux) throw new StickerError("UNSUPPORTED_TYPE");
  return ["-f", demux, "-protocol_whitelist", "file,pipe", "-i", input];
}

function dimensions(width, height) {
  if (!width || !height) throw new StickerError("CORRUPT");
  if (width > L.MAX_INPUT_SIDE || height > L.MAX_INPUT_SIDE || width * height > L.MAX_INPUT_PIXELS)
    throw new StickerError("DIMENSIONS_TOO_LARGE", { limit: L.MAX_INPUT_SIDE });
}

function gifInfo(b) {
  if (b.length < 13) throw new StickerError("CORRUPT");
  let at = 13;
  let frames = 0;
  let durationMs = 0;
  let delay = 100;
  if (b[10] & 0x80) at += 3 * 2 ** ((b[10] & 7) + 1);
  while (at < b.length) {
    const type = b[at++];
    if (type === 0x3b) break;
    if (type === 0x21) {
      const label = b[at++];
      if (label === 0xf9 && b[at] === 4 && at + 5 < b.length)
        delay = Math.max(20, b.readUInt16LE(at + 2) * 10);
      while (at < b.length) {
        const len = b[at++];
        if (!len) break;
        at += len;
      }
    } else if (type === 0x2c) {
      if (at + 9 > b.length) throw new StickerError("CORRUPT");
      const packed = b[at + 8];
      at += 9;
      if (packed & 0x80) at += 3 * 2 ** ((packed & 7) + 1);
      at++;
      while (at < b.length) {
        const len = b[at++];
        if (!len) break;
        at += len;
      }
      frames++;
      durationMs += delay;
      delay = 100;
    } else throw new StickerError("CORRUPT");
  }
  if (at > b.length || !frames) throw new StickerError("CORRUPT");
  return { frames, durationMs };
}

async function inspect(filePath, sniffed, maxSourceSeconds = L.VIDEO_MAX_SOURCE_SECONDS, signal) {
  if (!sniffed || !DEMUX[sniffed.mime]) throw new StickerError("UNSUPPORTED_TYPE");
  let b = null;
  if (sniffed.kind !== "video") {
    try {
      const size = (await fs.promises.stat(filePath)).size;
      if (size > L.UPLOAD_MAX_BYTES)
        throw new StickerError("TOO_LARGE", { limitBytes: L.UPLOAD_MAX_BYTES });
      b = await fs.promises.readFile(filePath, { signal });
    } catch (error) {
      if (error instanceof StickerError) throw error;
      if (signal?.aborted) throw new StickerError("TIMEOUT", {}, { cause: error });
      throw new StickerError("CORRUPT", {}, { cause: error });
    }
  }
  let width;
  let height;
  let durationMs = 0;
  let frames = null;
  let animated = false;
  if (sniffed.kind === "webp") {
    const meta = webp.parse(b);
    ({ width, height, durationMs, animated } = meta);
    frames = meta.animated ? meta.frames.length : 1;
    enforceAnimatedWebp(meta);
  } else if (sniffed.kind === "video") {
    let stderr;
    try {
      ({ stderr } = await ffmpeg.run(
        [...sourceArgs(sniffed, filePath), "-frames:v", "0", "-f", "image2pipe", "pipe:1"],
        { probe: true, maxOutputBytes: 1024, signal },
      ));
    } catch (error) {
      if (error.code === "TIMEOUT") throw error;
      stderr = String(error.cause || "");
    }
    const d = /Stream #\d+:\d+[^\n]*Video:[^\n]*?,\s*(\d{1,5})x(\d{1,5})(?=\s|,)/.exec(stderr);
    const t = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
    if (!d || !t) throw new StickerError("CORRUPT");
    width = Number(d[1]);
    height = Number(d[2]);
    durationMs = Math.round((Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3])) * 1000);
    animated = true;
  } else {
    const meta = readImageMeta(b);
    width = meta?.width;
    height = meta?.height;
    if (sniffed.kind === "gif") {
      const g = gifInfo(b);
      frames = g.frames;
      durationMs = g.durationMs;
      animated = frames > 1;
      // Reject oversized canvas headers before asking FFmpeg to parse the GIF.
      dimensions(width, height);
      let stderr;
      try {
        ({ stderr } = await ffmpeg.run(
          [...sourceArgs(sniffed, filePath), "-frames:v", "0", "-f", "image2pipe", "pipe:1"],
          { probe: true, maxOutputBytes: 1024, signal },
        ));
      } catch (error) {
        if (error.code === "TIMEOUT") throw error;
        throw new StickerError("CORRUPT", {}, { cause: error });
      }
      const stream = /Stream #\d+:\d+[^\n]*Video:[^\n]*?,\s*(\d{1,5})x(\d{1,5})(?=\s|,)/.exec(
        stderr,
      );
      if (!stream || Number(stream[1]) !== width || Number(stream[2]) !== height)
        throw new StickerError("CORRUPT");
      const time = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
      if (time)
        durationMs = Math.round(
          (Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3])) * 1000,
        );
    }
  }
  dimensions(width, height);
  if (durationMs > maxSourceSeconds * 1000)
    throw new StickerError("VIDEO_TOO_LONG", { limitSeconds: maxSourceSeconds });
  return { kind: sniffed.kind, mime: sniffed.mime, width, height, durationMs, animated, frames };
}

function validateOverlay(buffer) {
  if (buffer === undefined) return;
  if (
    !Buffer.isBuffer(buffer) ||
    buffer.length > 2 * 1024 * 1024 ||
    buffer.length < 24 ||
    !buffer.subarray(0, 8).equals(PNG) ||
    buffer.toString("ascii", 12, 16) !== "IHDR" ||
    buffer.readUInt32BE(16) !== L.CANVAS ||
    buffer.readUInt32BE(20) !== L.CANVAS
  )
    throw new StickerError("INVALID_OPTIONS", { field: "overlay" });
}

// Map the canvas window back into the rotated source before scaling. Lanczos
// needs a few source pixels outside the visible area, bounded by the maximum
// intermediate size even when a one-pixel edge is zoomed to the whole canvas.
function visibleSource(width, height, options, placed) {
  const quarter = options.rotate === 90 || options.rotate === 270;
  const sourceWidth = quarter ? height : width;
  const sourceHeight = quarter ? width : height;
  const cap = Math.floor(Math.min(L.CANVAS * 4, L.CANVAS * options.zoom + L.CANVAS / 2));
  function axis(sourceSize, scaledSize, offset) {
    const scale = scaledSize / sourceSize;
    const first = Math.max(0, -offset);
    const last = Math.min(L.CANVAS, offset + scaledSize) - offset;
    const margin = Math.min(3, Math.floor((cap - L.CANVAS) / (2 * scale)));
    const start = Math.max(0, Math.floor(first / scale) - margin);
    const end = Math.min(sourceSize, Math.ceil(last / scale) + margin);
    const natural =
      start === 0 && end === sourceSize
        ? scaledSize
        : Math.max(1, Math.round((end - start) * scale));
    const bounded = Math.min(cap, natural);
    const oldVisibleStart = first - start * scale;
    const visibleFraction =
      natural > L.CANVAS ? Math.max(0, Math.min(1, oldVisibleStart / (natural - L.CANVAS))) : 0;
    return {
      start,
      size: Math.max(1, end - start),
      scaled: bounded,
      offset:
        natural > cap
          ? -Math.round(visibleFraction * (bounded - L.CANVAS))
          : offset + Math.round(start * scale),
    };
  }
  const x = axis(sourceWidth, placed.width, placed.x);
  const y = axis(sourceHeight, placed.height, placed.y);
  return {
    x: x.start,
    y: y.start,
    width: x.size,
    height: y.size,
    scaledWidth: x.scaled,
    scaledHeight: y.scaled,
    overlayX: x.offset,
    overlayY: y.offset,
  };
}

function filterGraph(
  width,
  height,
  options,
  { overlay = false, fps = L.ANIMATED_FPS, keyColor = "0x000000" } = {},
) {
  const o = normalizeOptions(options);
  const p = placement(width, height, o);
  const visible = visibleSource(width, height, o, p);
  // placement() is the same 512-canvas geometry the panel preview uses.
  const stages = ["[0:v]format=rgba"];
  if (o.removeBackground) stages.push(`colorkey=${keyColor}:${o.removeBackground.tolerance}:0.05`);
  if (o.rotate === 90) stages.push("transpose=clock");
  else if (o.rotate === 270) stages.push("transpose=cclock");
  else if (o.rotate === 180) stages.push("hflip,vflip");
  stages.push(`crop=${visible.width}:${visible.height}:${visible.x}:${visible.y}`);
  stages.push(`scale=${visible.scaledWidth}:${visible.scaledHeight}:flags=lanczos`);
  const color = o.background === "transparent" ? "black@0.0" : `0x${o.background.slice(1)}`;
  const parts = [
    `${stages.join(",")}[scaled]`,
    `color=c=${color}:s=512x512:r=${fps},format=rgba[bg]`,
    `[bg][scaled]overlay=${visible.overlayX}:${visible.overlayY}:shortest=1:format=auto[base]`,
  ];
  // The PNG is one frame; repeat it while the already bounded base stream runs.
  if (overlay) parts.push("[base][1:v]overlay=0:0:eof_action=repeat:format=auto[out]");
  else parts.push("[base]format=rgba[out]");
  return { graph: parts.join(";"), placement: p, visible };
}

async function capabilities() {
  const binary = ffmpegPath();
  if (cachedCapabilities && cachedFfmpegPath === binary) return cachedCapabilities;
  let listing = "";
  try {
    listing = (
      await ffmpeg.run(["-encoders"], { probe: true, maxOutputBytes: 1024 * 1024 })
    ).buffer.toString();
  } catch {
    /* missing binary */
  }
  const has = (name) => new RegExp(`\\b${name}\\b`).test(listing);
  cachedFfmpegPath = binary;
  cachedCapabilities = {
    webp: has("libwebp"),
    animated: has("libwebp_anim"),
    gif: has("gif"),
    mp4: has("mpeg4") || has("libx264"),
    backgroundRemoval: ["plain"],
  };
  return cachedCapabilities;
}

function tempPath(ext) {
  return path.join(ensureDataDir("tmp", "stickers"), `${randomUUID()}.${ext}`);
}

async function sweepTemp(maxAgeMs) {
  const dir = ensureDataDir("tmp", "stickers");
  const now = Date.now();
  for (const name of await fs.promises.readdir(dir)) {
    const file = path.join(dir, name);
    try {
      if (now - (await fs.promises.stat(file)).mtimeMs > maxAgeMs)
        await fs.promises.rm(file, { force: true });
    } catch {
      /* another job removed it */
    }
  }
}

function describeWebp(buffer) {
  const m = webp.parse(buffer);
  enforceAnimatedWebp(m);
  return {
    width: m.width,
    height: m.height,
    animated: m.animated,
    durationMs: m.durationMs,
    frames: m.animated ? m.frames.length : 1,
  };
}

function enforceAnimatedWebp(meta) {
  if (!meta.animated) return;
  if (meta.width > L.EXISTING_MAX_SIDE || meta.height > L.EXISTING_MAX_SIDE) {
    throw new StickerError("DIMENSIONS_TOO_LARGE", { limit: L.EXISTING_MAX_SIDE });
  }
  if (meta.frames.length > L.ANIMATED_MAX_FRAMES) {
    throw new StickerError("TOO_LARGE", { limitFrames: L.ANIMATED_MAX_FRAMES });
  }
}

function withStickerMetadata(buffer, data) {
  return webp.metadata(buffer, data);
}

function canonicalWebp(buffer) {
  return webp.canonical(buffer);
}

function paint(canvas, pixels, frame, canvasWidth) {
  const { x, y, width, height, blend } = frame;
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const src = (row * width + col) * 4;
      const dst = ((y + row) * canvasWidth + x + col) * 4;
      const a = pixels[src + 3] / 255;
      if (!blend || a === 1) {
        pixels.copy(canvas, dst, src, src + 4);
        continue;
      }
      if (a === 0) continue;
      const da = canvas[dst + 3] / 255;
      const out = a + da * (1 - a);
      for (let c = 0; c < 3; c++) {
        canvas[dst + c] = Math.round((pixels[src + c] * a + canvas[dst + c] * da * (1 - a)) / out);
      }
      canvas[dst + 3] = Math.round(out * 255);
    }
  }
}

function clearFrame(canvas, frame, canvasWidth) {
  for (let row = 0; row < frame.height; row++) {
    canvas.fill(
      0,
      ((frame.y + row) * canvasWidth + frame.x) * 4,
      ((frame.y + row) * canvasWidth + frame.x + frame.width) * 4,
    );
  }
}

async function* webpFrames(buffer, { fps = L.ANIMATED_FPS, trim = null, signal } = {}) {
  const meta = webp.parse(buffer);
  enforceAnimatedWebp(meta);
  if (!meta.animated) throw new StickerError("INVALID_OPTIONS");
  const frames = meta.frames;
  const canvas = Buffer.alloc(meta.width * meta.height * 4);
  const start = (trim?.start || 0) * 1000;
  const end = Math.min(meta.durationMs, start + (trim?.duration || L.STICKER_MAX_SECONDS) * 1000);
  let cursor = 0;
  let prior = null;
  let elapsed = 0;
  for (let t = start; t < end; t += 1000 / fps) {
    if (signal?.aborted) throw new StickerError("TIMEOUT");
    while (cursor < frames.length && elapsed <= t) {
      // Disposal clears the previous rectangle before the next frame blends.
      if (prior?.dispose) clearFrame(canvas, prior, meta.width);
      const frame = frames[cursor];
      const standalone = webp.extractFrame(buffer, cursor);
      const decoded = await ffmpeg.run(
        [
          ...sourceArgs({ mime: "image/webp" }, "pipe:0"),
          "-frames:v",
          "1",
          "-pix_fmt",
          "rgba",
          "-f",
          "rawvideo",
          "pipe:1",
        ],
        { input: standalone, signal, maxOutputBytes: frame.width * frame.height * 4 + 1024 },
      );
      if (decoded.buffer.length !== frame.width * frame.height * 4)
        throw new StickerError("CORRUPT");
      paint(canvas, decoded.buffer, frame, meta.width);
      prior = frame;
      elapsed += Math.max(1, frame.durationMs);
      cursor++;
      await nextTick();
    }
    yield Buffer.from(canvas);
    await nextTick();
  }
}

async function renderAnimatedWebp(buffer, output, { signal, fps = L.ANIMATED_FPS, trim } = {}) {
  const meta = webp.parse(buffer);
  enforceAnimatedWebp(meta);
  const frames = Readable.from(webpFrames(buffer, { signal, fps, trim }));
  return ffmpeg.run(
    [
      "-f",
      "rawvideo",
      "-pixel_format",
      "rgba",
      "-video_size",
      `${meta.width}x${meta.height}`,
      "-framerate",
      String(fps),
      "-protocol_whitelist",
      "file,pipe",
      "-i",
      "pipe:0",
      ...output,
    ],
    { input: frames, signal, maxOutputBytes: 32 * 1024 * 1024 },
  );
}

async function sampleCorner(inputPath, sniffed, raw, signal) {
  let result;
  if (raw) {
    result = await renderAnimatedWebp(
      raw,
      ["-frames:v", "1", "-vf", "crop=1:1:0:0,format=rgb24", "-f", "rawvideo", "pipe:1"],
      { signal, fps: 1 },
    );
  } else {
    result = await ffmpeg.run(
      [
        ...sourceArgs(sniffed, inputPath),
        "-frames:v",
        "1",
        "-vf",
        "crop=1:1:0:0,format=rgb24",
        "-f",
        "rawvideo",
        "pipe:1",
      ],
      { signal, maxOutputBytes: 16 },
    );
  }
  if (result.buffer.length < 3) throw new StickerError("CORRUPT");
  return `0x${result.buffer.subarray(0, 3).toString("hex")}`;
}

async function createSticker({
  inputPath,
  sniffed,
  options,
  overlayPng,
  maxSourceSeconds = L.VIDEO_MAX_SOURCE_SECONDS,
  signal,
  onProgress,
  _maxBytes = L.STICKER_MAX_BYTES,
  _targetBytes,
  _qualitySteps,
}) {
  const cap = await capabilities();
  if (!cap.webp) throw new StickerError("ENCODER_MISSING");
  validateOverlay(overlayPng);
  onProgress?.("probing", 0);
  const info = await inspect(inputPath, sniffed, maxSourceSeconds, signal);
  const o = normalizeOptions(options);
  const animated = info.animated;
  if (animated && !cap.animated) throw new StickerError("ENCODER_MISSING");
  const durationMs = animated
    ? Math.min(
        info.durationMs - (o.trim?.start || 0) * 1000,
        (o.trim?.duration || L.STICKER_MAX_SECONDS) * 1000,
      )
    : 0;
  if (animated && durationMs <= 0) throw new StickerError("INVALID_OPTIONS", { field: "trim" });
  let raw = null;
  if (sniffed.kind === "webp" && animated) {
    try {
      raw = await fs.promises.readFile(inputPath, { signal });
    } catch (error) {
      if (signal?.aborted) throw new StickerError("TIMEOUT", {}, { cause: error });
      throw new StickerError("CORRUPT", {}, { cause: error });
    }
  }
  const temp = [];
  try {
    let overlayPath;
    if (overlayPng) {
      overlayPath = tempPath("png");
      temp.push(overlayPath);
      await fs.promises.writeFile(overlayPath, overlayPng);
    }
    let best = null;
    let reduced = false;
    let bestQuality = null;
    let bestFps = null;
    const keyColor = o.removeBackground
      ? await sampleCorner(inputPath, sniffed, raw, signal)
      : "0x000000";
    // Moderate compression is routine; warn only below the visible-quality thresholds.
    const steps =
      _qualitySteps ??
      (animated
        ? [
            [90, 15],
            [75, 15],
            [60, 12],
            [45, 10],
            [30, 8],
          ]
        : [
            [95, 1],
            [80, 1],
            [65, 1],
            [45, 1],
            [25, 1],
          ]);
    for (let step = 0; step < steps.length; step++) {
      if (signal?.aborted) throw new StickerError("TIMEOUT");
      const [quality, fps] = steps[step];
      onProgress?.("decoding", step / steps.length);
      const inputDims = [info.width, info.height];
      const { graph } = filterGraph(...inputDims, o, { overlay: !!overlayPath, fps, keyColor });
      const args = [];
      if (!raw && o.trim?.start) args.push("-ss", String(o.trim.start));
      if (!raw) args.push(...sourceArgs(sniffed, inputPath));
      if (overlayPath) args.push(...sourceArgs({ mime: "image/png" }, overlayPath));
      args.push("-filter_complex", graph, "-map", "[out]");
      if (animated) {
        args.push(
          "-t",
          String(Math.min(durationMs / 1000, L.STICKER_MAX_SECONDS)),
          "-r",
          String(fps),
          "-an",
          "-c:v",
          "libwebp_anim",
          "-quality",
          String(quality),
          "-loop",
          "0",
        );
      } else {
        args.push("-frames:v", "1", "-c:v", "libwebp", "-quality", String(quality));
      }
      args.push("-f", "webp", "pipe:1");
      onProgress?.("encoding", step / steps.length);
      const encoded = raw
        ? await renderAnimatedWebp(raw, args, { signal, fps, trim: o.trim })
        : await ffmpeg.run(args, { signal, maxOutputBytes: 16 * 1024 * 1024 });
      const bytes = encoded.buffer;
      onProgress?.("optimizing", (step + 1) / steps.length);
      if (!best || bytes.length < best.length) {
        best = bytes;
        bestQuality = quality;
        bestFps = fps;
      }
      if (
        bytes.length <=
        (_targetBytes ?? (animated ? L.ANIMATED_TARGET_BYTES : L.STATIC_TARGET_BYTES))
      ) {
        best = bytes;
        bestQuality = quality;
        bestFps = fps;
        break;
      }
    }
    reduced = animated ? bestQuality < 60 || bestFps < L.ANIMATED_FPS : bestQuality < 65;
    if (!best || best.length > Math.min(_maxBytes, L.STICKER_MAX_BYTES))
      throw new StickerError("OUTPUT_TOO_LARGE");
    return {
      buffer: best,
      width: L.CANVAS,
      height: L.CANVAS,
      animated,
      durationMs,
      sourceMime: sniffed.mime,
      qualityReduced: reduced,
    };
  } finally {
    await Promise.all(temp.map((file) => fs.promises.rm(file, { force: true })));
  }
}

async function toPng(buffer, { signal } = {}) {
  const meta = webp.parse(buffer);
  let result;
  if (meta.animated) {
    result = await renderAnimatedWebp(
      buffer,
      ["-frames:v", "1", "-c:v", "png", "-f", "image2pipe", "pipe:1"],
      { signal, fps: 1, trim: { start: 0, duration: 1 } },
    );
  } else {
    result = await ffmpeg.run(
      [
        ...sourceArgs({ mime: "image/webp" }, "pipe:0"),
        "-frames:v",
        "1",
        "-c:v",
        "png",
        "-f",
        "image2pipe",
        "pipe:1",
      ],
      { input: buffer, signal },
    );
  }
  return { buffer: result.buffer, animated: meta.animated };
}

async function toGif(buffer, { signal } = {}) {
  const meta = webp.parse(buffer);
  if (!meta.animated) throw new StickerError("INVALID_OPTIONS", { field: "format" });
  return (
    await renderAnimatedWebp(
      buffer,
      [
        "-t",
        String(Math.min(10, meta.durationMs / 1000)),
        "-filter_complex",
        "[0:v]split[image][colors];[colors]palettegen=reserve_transparent=1:stats_mode=full[palette];[image][palette]paletteuse=alpha_threshold=128[out]",
        "-map",
        "[out]",
        "-c:v",
        "gif",
        "-f",
        "gif",
        "pipe:1",
      ],
      { signal },
    )
  ).buffer;
}

async function toMp4(buffer, { signal } = {}) {
  const meta = webp.parse(buffer);
  if (!meta.animated) throw new StickerError("INVALID_OPTIONS", { field: "format" });
  const videoWidth = Math.ceil(meta.width / 2) * 2;
  const videoHeight = Math.ceil(meta.height / 2) * 2;
  const file = tempPath("mp4");
  try {
    for (const encoder of ["libx264", "mpeg4"]) {
      try {
        await renderAnimatedWebp(
          buffer,
          [
            "-t",
            String(Math.min(10, meta.durationMs / 1000)),
            "-filter_complex",
            `color=c=white:s=${videoWidth}x${videoHeight}:r=15[white];[white][0:v]overlay=0:0:shortest=1:format=auto,format=yuv420p[out]`,
            "-map",
            "[out]",
            "-c:v",
            encoder,
            "-movflags",
            "+faststart",
            "-f",
            "mp4",
            "-y",
            file,
          ],
          { signal, fps: L.ANIMATED_FPS },
        );
        return await fs.promises.readFile(file);
      } catch (error) {
        if (encoder === "mpeg4" || error.code === "TIMEOUT") throw error;
      }
    }
  } finally {
    await fs.promises.rm(file, { force: true });
  }
}

async function makeThumbnail(buffer, { signal } = {}) {
  const png = await toPng(buffer, { signal });
  return (
    await ffmpeg.run(
      [
        ...sourceArgs({ mime: "image/png" }, "pipe:0"),
        "-vf",
        `scale=${L.THUMB_SIZE}:${L.THUMB_SIZE}:force_original_aspect_ratio=decrease,pad=${L.THUMB_SIZE}:${L.THUMB_SIZE}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`,
        "-frames:v",
        "1",
        "-c:v",
        "libwebp",
        "-f",
        "webp",
        "pipe:1",
      ],
      { input: png.buffer, signal },
    )
  ).buffer;
}

module.exports = {
  sniff,
  inspect,
  createSticker,
  toPng,
  toGif,
  toMp4,
  makeThumbnail,
  describeWebp,
  withStickerMetadata,
  canonicalWebp,
  capabilities,
  sweepTemp,
  filterGraph,
  validateOverlay,
  compositeWebpFrames: webpFrames,
};

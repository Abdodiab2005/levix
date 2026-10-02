// The glue between an upload (or a WhatsApp buffer) and the library.
//
// media.cjs and jobs.cjs are required only when a call needs them. Tests pass
// fakes that honour the same signatures. Every conversion goes through the job
// queue, so a burst of export requests cannot start unbounded FFmpeg processes.
// An upload is converted from its own file (the panel retries that same id).
// Only a buffer — the bot — is copied to a work file, and only when the bytes
// cannot be kept as they are.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const brand = require("../config/brand.cjs");
const { ensureDataDir } = require("../config/paths.cjs");
const logger = require("../utils/logger.cjs");
const { StickerError } = require("./errors.cjs");
const { EXISTING_MAX_SIDE, STICKER_MAX_BYTES, VIDEO_MAX_SOURCE_SECONDS } = require("./limits.cjs");
const { isDefaultOptions, normalizeOptions } = require("./options.cjs");
const { zipStore } = require("./zip.cjs");

const SOURCES = new Set(["BOT_COMMAND", "PANEL_UPLOAD", "WHATSAPP_STICKER", "MEDIA_HUB"]);
const ID_RE = /^[0-9a-f]{16}$/;
const JOB_MAP_MAX = 1000;
const SNIFF_BYTES = 512;

function extOf(sniffed) {
  const ext = String(sniffed?.ext || "bin").replace(/[^a-z0-9]/gi, "");
  return ext || "bin";
}

function fitsKeep(sniffed, options, overlay, byteLength) {
  // An overlay is drawn over the whole sticker, so the bytes cannot be kept.
  return (
    sniffed?.kind === "webp" &&
    !overlay?.length &&
    isDefaultOptions(options) &&
    byteLength > 0 &&
    byteLength <= STICKER_MAX_BYTES
  );
}

function acceptableWebp(buffer, media) {
  try {
    const info = media.describeWebp(buffer);
    return (
      info.width >= 1 &&
      info.height >= 1 &&
      info.width <= EXISTING_MAX_SIDE &&
      info.height <= EXISTING_MAX_SIDE
    );
  } catch {
    return false;
  }
}

function sniffHeader(file, media) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(SNIFF_BYTES);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    if (n <= 0) return null;
    return media.sniff(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
}

function writeWorkFile(buffer, sniffed) {
  const dir = ensureDataDir("tmp", "stickers");
  const temp = path.join(dir, `work-${crypto.randomBytes(8).toString("hex")}.${extOf(sniffed)}`);
  try {
    fs.writeFileSync(temp, buffer);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    if (error?.code === "EACCES" || error?.code === "ENOSPC" || error?.code === "EROFS") {
      throw new StickerError("STORAGE_UNAVAILABLE", {}, { cause: error });
    }
    throw error;
  }
  return temp;
}

function dropWorkFile(file) {
  if (!file) return;
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // The job already failed. A leftover work file is swept with the temp dir.
  }
}

function createStudio({ media, jobs, library, uploads } = {}) {
  const jobOwners = new Map();

  const useMedia = () => media || require("./media.cjs");
  const useJobs = () => jobs || require("./jobs.cjs");
  const useLibrary = () => library || require("./library.cjs");
  const useUploads = () => uploads || require("./uploads.cjs");

  function remember(id, owner) {
    if (jobOwners.size >= JOB_MAP_MAX) {
      const oldest = jobOwners.keys().next().value;
      jobOwners.delete(oldest);
    }
    jobOwners.set(id, owner.key);
  }

  function owns(owner, id) {
    const key = jobOwners.get(id);
    if (!key || !owner) return false;
    if (key === owner.key) return true;
    return Array.isArray(owner.candidates) && owner.candidates.includes(key);
  }

  function assertPack(owner, packId) {
    if (packId == null) return;
    if (typeof packId !== "string" || !ID_RE.test(packId)) {
      throw new StickerError("INVALID_OPTIONS", { field: "packId" });
    }
    try {
      useLibrary().getPack(owner, packId);
    } catch (error) {
      if (error instanceof StickerError && error.code === "NOT_FOUND") {
        throw new StickerError("PACK_NOT_FOUND");
      }
      throw error;
    }
  }

  function runCreate({
    owner,
    inputPath,
    sniffed,
    keepBuffer,
    options,
    overlayPng,
    source,
    packId,
    name,
    maxSourceSeconds,
    removeInput,
  }) {
    const med = useMedia();
    const lib = useLibrary();
    if (!sniffed) throw new StickerError("UNSUPPORTED_TYPE");
    if (!keepBuffer && !inputPath) throw new StickerError("NO_MEDIA");
    const opts = normalizeOptions(options);
    const src = source || "PANEL_UPLOAD";
    if (!SOURCES.has(src)) throw new StickerError("INVALID_OPTIONS", { field: "source" });
    assertPack(owner, packId);

    let submitted;
    try {
      submitted = useJobs().submit(
        async ({ signal, progress }) => {
          try {
            let produced;
            if (keepBuffer) {
              progress("encoding", 1);
              const described = med.describeWebp(keepBuffer);
              produced = {
                buffer: keepBuffer,
                width: described.width,
                height: described.height,
                animated: !!described.animated,
                durationMs: described.durationMs ?? 0,
                sourceMime: sniffed.mime,
                qualityReduced: false,
              };
            } else {
              produced = await med.createSticker({
                inputPath,
                sniffed,
                options: opts,
                overlayPng,
                maxSourceSeconds,
                signal,
                onProgress: progress,
              });
            }
            const thumb = await med.makeThumbnail(produced.buffer, { signal });
            const saved = lib.saveSticker(owner, {
              buffer: produced.buffer,
              thumbBuffer: thumb,
              width: produced.width,
              height: produced.height,
              animated: !!produced.animated,
              durationMs: produced.durationMs,
              sourceMime: produced.sourceMime || sniffed.mime,
              source: src,
              name,
            });
            if (packId) lib.addToPack(owner, packId, [saved.sticker.id]);
            const sticker = lib.getSticker(owner, saved.sticker.id);
            return {
              sticker,
              created: saved.created,
              qualityReduced: !!produced.qualityReduced,
            };
          } finally {
            if (removeInput) dropWorkFile(inputPath);
          }
        },
        { kind: "create" },
      );
    } catch (error) {
      if (removeInput) dropWorkFile(inputPath);
      throw error;
    }

    remember(submitted.id, owner);
    // The route returns 202 and does not await this. The handler keeps the
    // rejection from becoming an unhandled rejection; callers can still await.
    submitted.promise.catch((error) => {
      logger.warn({ err: error, jobId: submitted.id }, "[Stickers] create job failed");
    });
    return { jobId: submitted.id, promise: submitted.promise };
  }

  function createFromBuffer(input) {
    const buffer = input?.buffer;
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new StickerError("NO_MEDIA");
    const med = useMedia();
    const sniffed = med.sniff(buffer);
    if (!sniffed) throw new StickerError("UNSUPPORTED_TYPE");
    const opts = normalizeOptions(input.options);
    const keep =
      fitsKeep(sniffed, opts, input.overlayPng, buffer.length) && acceptableWebp(buffer, med);
    // The source buffer stays in the queued closure only when those bytes are
    // the sticker. Anything else is read back from the work file.
    const keepBuffer = keep ? buffer : null;
    const inputPath = keepBuffer ? null : writeWorkFile(buffer, sniffed);
    return runCreate({
      owner: input.owner,
      inputPath,
      sniffed,
      keepBuffer,
      options: opts,
      overlayPng: input.overlayPng,
      source: input.source,
      packId: input.packId,
      name: input.name,
      maxSourceSeconds: input.maxSourceSeconds,
      removeInput: inputPath != null,
    });
  }

  function createFromUpload({ owner, uploadId, options, overlayPng, source, packId, name }) {
    const record = useUploads().get(owner, uploadId);
    if (!record) throw new StickerError("NOT_FOUND");
    const med = useMedia();
    let sniffed;
    try {
      sniffed = sniffHeader(record.path, med);
    } catch (error) {
      logger.error({ err: error }, "[Stickers] upload file disappeared");
      throw new StickerError("NOT_FOUND");
    }
    if (!sniffed) throw new StickerError("UNSUPPORTED_TYPE");
    const opts = normalizeOptions(options);
    let keepBuffer = null;
    // Only a small WebP is worth reading. A video or a large image stays on
    // disk and is converted from that path; the job must not delete it,
    // because "Try again" submits the same upload id.
    if (fitsKeep(sniffed, opts, overlayPng, record.size)) {
      let bytes;
      try {
        bytes = fs.readFileSync(record.path);
      } catch (error) {
        logger.error({ err: error }, "[Stickers] upload file disappeared");
        throw new StickerError("NOT_FOUND");
      }
      if (bytes.length <= STICKER_MAX_BYTES && acceptableWebp(bytes, med)) keepBuffer = bytes;
    }
    return runCreate({
      owner,
      inputPath: record.path,
      sniffed,
      keepBuffer,
      options: opts,
      overlayPng,
      source: source || "PANEL_UPLOAD",
      packId,
      name: name == null ? record.filename : name,
      maxSourceSeconds: VIDEO_MAX_SOURCE_SECONDS,
      removeInput: false,
    });
  }

  // Export jobs are awaited by the request that queued them, so they are not
  // remembered. Remembering them would push create jobs out of the owner map.
  function queueExport(run) {
    const submitted = useJobs().submit(run, { kind: "export" });
    submitted.promise.catch((error) => {
      logger.warn({ err: error, jobId: submitted.id }, "[Stickers] export job failed");
    });
    return submitted.promise;
  }

  async function exportImage(owner, stickerId, format) {
    const lib = useLibrary();
    const sticker = lib.getSticker(owner, stickerId);
    if (format === "webp") {
      return {
        buffer: lib.readStickerFile(owner, stickerId),
        mime: "image/webp",
        fileName: lib.fileNameFor(sticker, "webp"),
        animated: sticker.animated,
      };
    }
    if (format !== "png" && format !== "gif") {
      throw new StickerError("INVALID_OPTIONS", { field: "format" });
    }
    // A static gif is rejected before it takes a queue slot.
    if (format === "gif" && !sticker.animated) {
      throw new StickerError("INVALID_OPTIONS", { field: "format" });
    }
    return queueExport(async ({ signal }) => {
      const webp = lib.readStickerFile(owner, stickerId);
      if (format === "png") {
        const png = await useMedia().toPng(webp, { signal });
        return {
          buffer: png.buffer,
          mime: "image/png",
          fileName: lib.fileNameFor(sticker, "png"),
          animated: !!png.animated,
        };
      }
      const gif = await useMedia().toGif(webp, { signal });
      return {
        buffer: gif,
        mime: "image/gif",
        fileName: lib.fileNameFor(sticker, "gif"),
        animated: true,
      };
    });
  }

  async function exportZip(owner, ids, format) {
    if (format !== "webp" && format !== "png") {
      throw new StickerError("INVALID_OPTIONS", { field: "format" });
    }
    const lib = useLibrary();
    // Resolve every id before taking a slot, so a missing sticker is a 404
    // and not a queued conversion.
    const stickers = ids.map((id) => lib.getSticker(owner, id));
    if (format === "webp") {
      return zipStore(
        stickers.map((sticker) => ({
          name: lib.fileNameFor(sticker, "webp"),
          data: lib.readStickerFile(owner, sticker.id),
        })),
      );
    }
    return queueExport(async ({ signal, progress }) => {
      const entries = [];
      for (let i = 0; i < stickers.length; i++) {
        const sticker = stickers[i];
        const png = await useMedia().toPng(lib.readStickerFile(owner, sticker.id), { signal });
        entries.push({ name: lib.fileNameFor(sticker, "png"), data: png.buffer });
        progress("encoding", (i + 1) / stickers.length);
      }
      return zipStore(entries);
    });
  }

  function firstPackName(owner, sticker) {
    const packId = sticker.packIds?.[0];
    if (!packId) return null;
    try {
      return useLibrary().getPack(owner, packId).pack.name;
    } catch {
      return null;
    }
  }

  async function sendStickers(owner, ids, jid, sock) {
    if (!sock) throw new StickerError("NOT_CONNECTED");
    const lib = useLibrary();
    const med = useMedia();
    const stickers = [];
    for (const id of ids) stickers.push(lib.getSticker(owner, id));
    for (const sticker of stickers) {
      const raw = lib.readStickerFile(owner, sticker.id);
      const packed = med.withStickerMetadata(raw, {
        packName: firstPackName(owner, sticker) || "Levix",
        publisher: brand.name,
      });
      await sock.sendMessage(jid, { sticker: packed });
    }
    lib.touch(
      owner,
      stickers.map((sticker) => sticker.id),
    );
    return { sent: stickers.length };
  }

  function getJob(owner, jobId) {
    if (!owns(owner, jobId)) return null;
    const job = useJobs().get(jobId);
    return job || null;
  }

  return {
    createFromBuffer,
    createFromUpload,
    exportImage,
    exportZip,
    sendStickers,
    getJob,
  };
}

module.exports = Object.assign(createStudio(), { createStudio });

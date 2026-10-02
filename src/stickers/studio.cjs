// The glue between an upload (or a WhatsApp buffer) and the library.
//
// media.cjs and jobs.cjs belong to the media agent and are required only when
// a call needs them, so this module loads in a worktree where they do not
// exist yet. Tests pass fakes that honour the same signatures.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const brand = require("../config/brand.cjs");
const { ensureDataDir } = require("../config/paths.cjs");
const logger = require("../utils/logger.cjs");
const { StickerError } = require("./errors.cjs");
const { EXISTING_MAX_SIDE, STICKER_MAX_BYTES, VIDEO_MAX_SOURCE_SECONDS } = require("./limits.cjs");
const { isDefaultOptions, normalizeOptions } = require("./options.cjs");

const SOURCES = new Set(["BOT_COMMAND", "PANEL_UPLOAD", "WHATSAPP_STICKER", "MEDIA_HUB"]);
const ID_RE = /^[0-9a-f]{16}$/;
const JOB_MAP_MAX = 1000;

function extOf(sniffed) {
  const ext = String(sniffed?.ext || "bin").replace(/[^a-z0-9]/gi, "");
  return ext || "bin";
}

function canKeep(buffer, sniffed, options, overlay, media) {
  // An overlay is drawn over the whole sticker, so the bytes cannot be kept.
  if (sniffed?.kind !== "webp" || overlay?.length) return false;
  if (!isDefaultOptions(options) || buffer.length > STICKER_MAX_BYTES) return false;
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
    buffer,
    options,
    overlayPng,
    source,
    packId,
    name,
    maxSourceSeconds,
  }) {
    const med = useMedia();
    const lib = useLibrary();
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new StickerError("NO_MEDIA");
    const sniffed = med.sniff(buffer);
    if (!sniffed) throw new StickerError("UNSUPPORTED_TYPE");
    const opts = normalizeOptions(options);
    const src = source || "PANEL_UPLOAD";
    if (!SOURCES.has(src)) throw new StickerError("INVALID_OPTIONS", { field: "source" });
    assertPack(owner, packId);

    const keep = canKeep(buffer, sniffed, opts, overlayPng, med);
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

    let submitted;
    try {
      submitted = useJobs().submit(
        async ({ signal, progress }) => {
          try {
            let produced;
            if (keep) {
              progress("encoding", 1);
              const described = med.describeWebp(buffer);
              produced = {
                buffer,
                width: described.width,
                height: described.height,
                animated: !!described.animated,
                durationMs: described.durationMs ?? 0,
                sourceMime: sniffed.mime,
                qualityReduced: false,
              };
            } else {
              produced = await med.createSticker({
                inputPath: temp,
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
            fs.rmSync(temp, { force: true });
          }
        },
        { kind: "create" },
      );
    } catch (error) {
      fs.rmSync(temp, { force: true });
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
    return runCreate(input);
  }

  function createFromUpload({ owner, uploadId, options, overlayPng, source, packId, name }) {
    const record = useUploads().get(owner, uploadId);
    if (!record) throw new StickerError("NOT_FOUND");
    let buffer;
    try {
      buffer = fs.readFileSync(record.path);
    } catch (error) {
      logger.error({ err: error }, "[Stickers] upload file disappeared");
      throw new StickerError("NOT_FOUND");
    }
    return runCreate({
      owner,
      buffer,
      options,
      overlayPng,
      source: source || "PANEL_UPLOAD",
      packId,
      name: name == null ? record.filename : name,
      maxSourceSeconds: VIDEO_MAX_SOURCE_SECONDS,
    });
  }

  async function exportImage(owner, stickerId, format) {
    const lib = useLibrary();
    const sticker = lib.getSticker(owner, stickerId);
    const webp = lib.readStickerFile(owner, stickerId);
    if (format === "webp") {
      return {
        buffer: webp,
        mime: "image/webp",
        fileName: lib.fileNameFor(sticker, "webp"),
        animated: sticker.animated,
      };
    }
    if (format === "png") {
      const png = await useMedia().toPng(webp, {});
      return {
        buffer: png.buffer,
        mime: "image/png",
        fileName: lib.fileNameFor(sticker, "png"),
        animated: !!png.animated,
      };
    }
    if (format === "gif") {
      if (!sticker.animated) throw new StickerError("INVALID_OPTIONS", { field: "format" });
      const gif = await useMedia().toGif(webp, {});
      return {
        buffer: gif,
        mime: "image/gif",
        fileName: lib.fileNameFor(sticker, "gif"),
        animated: true,
      };
    }
    throw new StickerError("INVALID_OPTIONS", { field: "format" });
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
    sendStickers,
    getJob,
  };
}

module.exports = Object.assign(createStudio(), { createStudio });

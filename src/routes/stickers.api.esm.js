// Sticker Studio HTTP API. Mounted at /dashboard/api behind the same session
// check as the rest of the panel. The operator is owner "self" — the linked
// WhatsApp account's library. Errors are the sticker vocabulary; anything else
// is logged and answered as INTERNAL, never with the exception text.
//
// The upload is not JSON. jsonUnlessStickerUpload skips the dashboard parser
// for that one path so the route can cap the body while it is still a stream.

import { Router } from "express";
import { createRequire } from "module";
import normalizeJid from "../utils/normalizeJid.esm.js";

const require = createRequire(import.meta.url);
const logger = require("../utils/logger.cjs");
const settings = require("../config/settings.cjs");
const library = require("../stickers/library.cjs");
const uploads = require("../stickers/uploads.cjs");
const studioModule = require("../stickers/studio.cjs");
const owner = require("../stickers/owner.cjs");
const {
  CODES,
  StickerError,
  httpStatus,
  toResponseBody,
  userMessageIn,
} = require("../stickers/errors.cjs");
const {
  CANVAS,
  EXPORT_MAX_IDS,
  MAX_INPUT_SIDE,
  PACKS_MAX_PER_OWNER,
  SEND_MAX_IDS,
  STICKER_MAX_SECONDS,
  UPLOAD_MAX_BYTES,
  VIDEO_MAX_SOURCE_SECONDS,
} = require("../stickers/limits.cjs");
const { normalizeOptions } = require("../stickers/options.cjs");

const ID_RE = /^[0-9a-f]{16}$/;
const UPLOAD_ID_RE = /^[0-9a-f]{32}$/;
const JOB_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const JID_RE = /@(s\.whatsapp\.net|g\.us|lid)$/;
const SORTS = new Set(["newest", "oldest", "name", "recent"]);
const FILTERS = new Set(["all", "favorites", "recent", "animated", "static"]);
const ACTIONS = new Set([
  "favorite",
  "unfavorite",
  "delete",
  "addToPack",
  "moveToPack",
  "removeFromPack",
  "touch",
]);
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const OVERLAY_MAX_BYTES = 4 * 1024 * 1024;

const router = Router();
let session = null;
let studioOverride = null;
let mediaOverride = null;

export function setSession(manager) {
  session = manager;
}

export function setStudio(instance) {
  studioOverride = instance || null;
}

export function setMedia(mod) {
  mediaOverride = mod || null;
  uploads.setMedia(mod || null);
}

function studio() {
  return studioOverride || studioModule;
}

function media() {
  return mediaOverride || require("../stickers/media.cjs");
}

function currentSocket() {
  return session?.socket ?? null;
}

function panelOwner() {
  return owner.forPanel();
}

export function jsonUnlessStickerUpload(jsonParser) {
  return (req, res, next) => {
    const urlPath = (req.originalUrl || "").split("?")[0];
    if (req.method === "POST" && urlPath.endsWith("/stickers/uploads")) return next();
    return jsonParser(req, res, next);
  };
}

function asyncRoute(handler) {
  return (req, res) => {
    Promise.resolve(handler(req, res)).catch((error) => {
      if (res.headersSent) return;
      if (!(error instanceof StickerError)) {
        logger.error({ err: error }, `[Stickers] ${req.method} ${req.path} failed`);
      }
      res.status(httpStatus(error)).json(toResponseBody(error));
      if (error instanceof StickerError && error.code === "TOO_LARGE") {
        res.on("finish", () => req.destroy());
      }
    });
  };
}

function asPackError(error) {
  if (error instanceof StickerError && error.code === "NOT_FOUND") {
    throw new StickerError("PACK_NOT_FOUND");
  }
  throw error;
}

function bodyOf(req) {
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new StickerError("INVALID_OPTIONS", { field: "body" });
  }
  return body;
}

function parseIds(value, max, { field = "ids", allowEmpty = false } = {}) {
  if (!Array.isArray(value) || value.length > max || (!allowEmpty && value.length === 0)) {
    throw new StickerError("INVALID_OPTIONS", { field });
  }
  const ids = [];
  const seen = new Set();
  for (const id of value) {
    if (typeof id !== "string" || !ID_RE.test(id) || seen.has(id)) {
      throw new StickerError("INVALID_OPTIONS", { field });
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function requireStickerId(id) {
  if (typeof id !== "string" || !ID_RE.test(id)) {
    throw new StickerError("INVALID_OPTIONS", { field: "id" });
  }
  return id;
}

function contentDisposition(fileName) {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function decodeOverlay(value) {
  if (typeof value !== "string" || !value.startsWith("data:image/png;base64,")) {
    throw new StickerError("INVALID_OPTIONS", { field: "overlay" });
  }
  const buffer = Buffer.from(value.slice("data:image/png;base64,".length), "base64");
  if (
    buffer.length < 24 ||
    buffer.length > OVERLAY_MAX_BYTES ||
    !buffer.subarray(0, 8).equals(PNG_SIG)
  ) {
    throw new StickerError("INVALID_OPTIONS", { field: "overlay" });
  }
  if (buffer.toString("ascii", 12, 16) !== "IHDR") {
    throw new StickerError("INVALID_OPTIONS", { field: "overlay" });
  }
  if (buffer.readUInt32BE(16) !== CANVAS || buffer.readUInt32BE(20) !== CANVAS) {
    throw new StickerError("INVALID_OPTIONS", { field: "overlay" });
  }
  return buffer;
}

function jobErrorBody(error) {
  if (!error) return null;
  const code = CODES[error.code] ? error.code : "CONVERSION_FAILED";
  const details = error.details && typeof error.details === "object" ? error.details : {};
  const wrapped = new StickerError(code, details);
  return { code, message: userMessageIn("en", wrapped), ...details };
}

function intQuery(value, fallback, field, min, max) {
  if (value == null || value === "") return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new StickerError("INVALID_OPTIONS", { field });
  }
  const n = Number(value);
  if (n < min || n > max) throw new StickerError("INVALID_OPTIONS", { field });
  return n;
}

router.get(
  "/stickers/capabilities",
  asyncRoute(async (_req, res) => {
    const caps = await media().capabilities();
    res.json({
      webp: !!caps.webp,
      animated: !!caps.animated,
      gif: !!caps.gif,
      mp4: !!caps.mp4,
      backgroundRemoval: Array.isArray(caps.backgroundRemoval) ? caps.backgroundRemoval : [],
      limits: {
        uploadBytes: UPLOAD_MAX_BYTES,
        videoSeconds: VIDEO_MAX_SOURCE_SECONDS,
        stickerSeconds: STICKER_MAX_SECONDS,
        maxSide: MAX_INPUT_SIDE,
        libraryMax: settings.get("sticker_library_limit"),
        packsMax: PACKS_MAX_PER_OWNER,
      },
    });
  }),
);

router.get(
  "/stickers",
  asyncRoute(async (req, res) => {
    const sort = req.query.sort || "newest";
    const filter = req.query.filter || "all";
    if (typeof sort !== "string" || !SORTS.has(sort)) {
      throw new StickerError("INVALID_OPTIONS", { field: "sort" });
    }
    if (typeof filter !== "string" || !FILTERS.has(filter)) {
      throw new StickerError("INVALID_OPTIONS", { field: "filter" });
    }
    const pack = req.query.pack;
    if (pack != null && pack !== "none" && (typeof pack !== "string" || !ID_RE.test(pack))) {
      throw new StickerError("INVALID_OPTIONS", { field: "pack" });
    }
    const q = req.query.q == null ? "" : String(req.query.q);
    res.json(
      library.listStickers(panelOwner(), {
        q,
        sort,
        filter,
        pack: pack ?? null,
        offset: intQuery(req.query.offset, 0, "offset", 0, 1_000_000),
        limit: intQuery(req.query.limit, 60, "limit", 1, 200),
      }),
    );
  }),
);

router.post(
  "/stickers/uploads",
  asyncRoute(async (req, res) => {
    let filename = "";
    const header = req.get("x-filename");
    if (header) {
      try {
        filename = decodeURIComponent(header);
      } catch {
        filename = header;
      }
    }
    const record = await uploads.acceptStream(panelOwner(), req, { filename, media: media() });
    res.status(201).json(record);
  }),
);

router.post(
  "/stickers/jobs",
  asyncRoute(async (req, res) => {
    const body = bodyOf(req);
    if (typeof body.uploadId !== "string" || !UPLOAD_ID_RE.test(body.uploadId)) {
      throw new StickerError("INVALID_OPTIONS", { field: "uploadId" });
    }
    const options = body.options == null ? undefined : normalizeOptions(body.options);
    const overlay = body.overlay == null ? undefined : decodeOverlay(body.overlay);
    if (body.name != null && typeof body.name !== "string") {
      throw new StickerError("INVALID_OPTIONS", { field: "name" });
    }
    if (body.packId != null && (typeof body.packId !== "string" || !ID_RE.test(body.packId))) {
      throw new StickerError("INVALID_OPTIONS", { field: "packId" });
    }
    const source = body.source ?? "PANEL_UPLOAD";
    if (source !== "PANEL_UPLOAD" && source !== "MEDIA_HUB") {
      throw new StickerError("INVALID_OPTIONS", { field: "source" });
    }
    const { jobId } = studio().createFromUpload({
      owner: panelOwner(),
      uploadId: body.uploadId,
      options,
      overlayPng: overlay,
      source,
      packId: body.packId,
      name: body.name,
    });
    res.status(202).json({ jobId });
  }),
);

router.get(
  "/stickers/jobs/:id",
  asyncRoute(async (req, res) => {
    if (!JOB_ID_RE.test(req.params.id)) throw new StickerError("NOT_FOUND");
    const job = studio().getJob(panelOwner(), req.params.id);
    if (!job) throw new StickerError("NOT_FOUND");
    const result = job.result || null;
    res.json({
      id: job.id,
      state: job.state,
      stage: job.stage ?? null,
      progress: job.progress ?? 0,
      error: jobErrorBody(job.error),
      sticker: result?.sticker ?? null,
      created: result ? result.created : null,
      qualityReduced: result ? !!result.qualityReduced : null,
    });
  }),
);

router.post(
  "/stickers/bulk",
  asyncRoute(async (req, res) => {
    const body = bodyOf(req);
    if (!ACTIONS.has(body.action)) throw new StickerError("INVALID_OPTIONS", { field: "action" });
    if (body.confirm !== undefined && typeof body.confirm !== "boolean") {
      throw new StickerError("INVALID_OPTIONS", { field: "confirm" });
    }
    const ids = parseIds(body.ids, EXPORT_MAX_IDS);
    const who = panelOwner();
    if (body.action === "favorite" || body.action === "unfavorite") {
      res.json(library.setFavorite(who, ids, body.action === "favorite"));
      return;
    }
    if (body.action === "touch") {
      res.json(library.touch(who, ids));
      return;
    }
    if (body.action === "delete") {
      let affected = 0;
      const skipped = [];
      for (const id of ids) {
        try {
          const result = library.deleteStickers(who, [id], { confirm: body.confirm === true });
          affected += result.deleted.length;
        } catch (error) {
          if (
            error instanceof StickerError &&
            (error.code === "IN_USE" || error.code === "NOT_FOUND")
          ) {
            skipped.push({ id, code: error.code });
            continue;
          }
          throw error;
        }
      }
      res.json({ affected, skipped });
      return;
    }
    if (typeof body.packId !== "string" || !ID_RE.test(body.packId)) {
      throw new StickerError("INVALID_OPTIONS", { field: "packId" });
    }
    if (
      body.fromPackId != null &&
      (typeof body.fromPackId !== "string" || !ID_RE.test(body.fromPackId))
    ) {
      throw new StickerError("INVALID_OPTIONS", { field: "fromPackId" });
    }
    try {
      if (body.action === "addToPack") res.json(library.addToPack(who, body.packId, ids));
      else if (body.action === "removeFromPack") {
        res.json(library.removeFromPack(who, body.packId, ids));
      } else {
        res.json(library.moveToPack(who, ids, body.packId, { fromPackId: body.fromPackId }));
      }
    } catch (error) {
      asPackError(error);
    }
  }),
);

router.post(
  "/stickers/export",
  asyncRoute(async (req, res) => {
    const body = bodyOf(req);
    if (body.format !== "webp" && body.format !== "png") {
      throw new StickerError("INVALID_OPTIONS", { field: "format" });
    }
    const ids = parseIds(body.ids, EXPORT_MAX_IDS);
    const archive = await studio().exportZip(panelOwner(), ids, body.format);
    res.set("Content-Type", "application/zip");
    res.set("Content-Disposition", contentDisposition("stickers.zip"));
    res.send(archive);
  }),
);

router.post(
  "/stickers/send",
  asyncRoute(async (req, res) => {
    const body = bodyOf(req);
    const ids = parseIds(body.ids, SEND_MAX_IDS);
    const jid = normalizeJid(typeof body.jid === "string" ? body.jid : "");
    if (!jid || !JID_RE.test(jid)) throw new StickerError("INVALID_OPTIONS", { field: "jid" });
    const sock = currentSocket();
    if (!sock) throw new StickerError("NOT_CONNECTED");
    res.json(await studio().sendStickers(panelOwner(), ids, jid, sock));
  }),
);

router.get(
  "/stickers/:id/file",
  asyncRoute(async (req, res) => {
    const buffer = library.readStickerFile(panelOwner(), requireStickerId(req.params.id));
    // Private, and revalidated on every load. Express still answers a matching
    // If-None-Match with 304, so a reload does not resend the bytes.
    res.set("Cache-Control", "private, no-cache");
    res.set("Content-Type", "image/webp");
    res.send(buffer);
  }),
);

router.get(
  "/stickers/:id/thumb",
  asyncRoute(async (req, res) => {
    const buffer = library.readThumbnail(panelOwner(), requireStickerId(req.params.id));
    res.set("Cache-Control", "private, no-cache");
    res.set("Content-Type", "image/webp");
    res.send(buffer);
  }),
);

router.get(
  "/stickers/:id/export",
  asyncRoute(async (req, res) => {
    const format = req.query.format;
    if (format !== "png" && format !== "webp" && format !== "gif") {
      throw new StickerError("INVALID_OPTIONS", { field: "format" });
    }
    const out = await studio().exportImage(panelOwner(), requireStickerId(req.params.id), format);
    res.set("Content-Type", out.mime);
    res.set("Content-Disposition", contentDisposition(out.fileName));
    if (format === "png" && out.animated) res.set("X-Levix-Animated", "1");
    res.send(out.buffer);
  }),
);

router.patch(
  "/stickers/:id",
  asyncRoute(async (req, res) => {
    const body = bodyOf(req);
    const patch = {};
    if (body.name !== undefined) {
      if (typeof body.name !== "string")
        throw new StickerError("INVALID_OPTIONS", { field: "name" });
      patch.name = body.name;
    }
    if (body.favorite !== undefined) {
      if (typeof body.favorite !== "boolean") {
        throw new StickerError("INVALID_OPTIONS", { field: "favorite" });
      }
      patch.favorite = body.favorite;
    }
    res.json(library.updateSticker(panelOwner(), requireStickerId(req.params.id), patch));
  }),
);

router.delete(
  "/stickers/:id",
  asyncRoute(async (req, res) => {
    const confirm = req.query.confirm === "1";
    res.json(library.deleteStickers(panelOwner(), [requireStickerId(req.params.id)], { confirm }));
  }),
);

router.get(
  "/sticker-packs",
  asyncRoute(async (_req, res) => {
    res.json({ packs: library.listPacks(panelOwner()) });
  }),
);

router.post(
  "/sticker-packs",
  asyncRoute(async (req, res) => {
    const body = bodyOf(req);
    if (typeof body.name !== "string") throw new StickerError("INVALID_NAME");
    res.status(201).json(library.createPack(panelOwner(), body.name));
  }),
);

router.get(
  "/sticker-packs/:id",
  asyncRoute(async (req, res) => {
    try {
      res.json(library.getPack(panelOwner(), requireStickerId(req.params.id)));
    } catch (error) {
      asPackError(error);
    }
  }),
);

router.patch(
  "/sticker-packs/:id",
  asyncRoute(async (req, res) => {
    const body = bodyOf(req);
    if (typeof body.name !== "string") throw new StickerError("INVALID_NAME");
    try {
      res.json(library.updatePack(panelOwner(), requireStickerId(req.params.id), body.name));
    } catch (error) {
      asPackError(error);
    }
  }),
);

router.delete(
  "/sticker-packs/:id",
  asyncRoute(async (req, res) => {
    try {
      res.json(
        library.deletePack(panelOwner(), requireStickerId(req.params.id), {
          deleteStickers: req.query.deleteStickers === "1",
        }),
      );
    } catch (error) {
      asPackError(error);
    }
  }),
);

router.put(
  "/sticker-packs/:id/order",
  asyncRoute(async (req, res) => {
    const ids = parseIds(bodyOf(req).ids, 100_000, { allowEmpty: true });
    try {
      res.json(library.reorderPack(panelOwner(), requireStickerId(req.params.id), ids));
    } catch (error) {
      asPackError(error);
    }
  }),
);

router.post(
  "/sticker-packs/:id/merge",
  asyncRoute(async (req, res) => {
    const intoPackId = bodyOf(req).intoPackId;
    if (typeof intoPackId !== "string" || !ID_RE.test(intoPackId)) {
      throw new StickerError("INVALID_OPTIONS", { field: "intoPackId" });
    }
    try {
      res.json(library.mergePacks(panelOwner(), requireStickerId(req.params.id), intoPackId));
    } catch (error) {
      asPackError(error);
    }
  }),
);

export default router;

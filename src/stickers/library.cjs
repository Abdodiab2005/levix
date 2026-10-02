// The sticker library. Every call takes an owner ({ key, candidates }) and
// treats another owner's ids as missing. Files are content-addressed by the
// WebP's sha256 under <data>/stickers/<sha[0..2]>/ and are removed only when
// no row, of any owner, still points at that hash.
//
// The write-then-insert and the delete-then-unlink pairs are synchronous, with
// no await between them, so two requests cannot interleave halfway. A crash
// after the commit and before the unlink leaves an orphan file; the reverse
// would leave a row whose bytes are gone.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { dataPath } = require("../config/paths.cjs");
const settings = require("../config/settings.cjs");
const store = require("../db/store.cjs");
const logger = require("../utils/logger.cjs");
const { StickerError } = require("./errors.cjs");
const webp = require("./webp.cjs");
const {
  PACK_NAME_MAX,
  PACK_SUBCOMMANDS,
  PACKS_MAX_PER_OWNER,
  STICKER_NAME_MAX,
} = require("./limits.cjs");

const SOURCES = new Set(["BOT_COMMAND", "PANEL_UPLOAD", "WHATSAPP_STICKER", "MEDIA_HUB"]);
const ID_RE = /^[0-9a-f]{16}$/;
const PACK_NAME_RE = /^[\p{L}\p{N}\p{M} _-]+$/u;
const SORTS = new Set(["newest", "oldest", "name", "recent"]);
const FILTERS = new Set(["all", "favorites", "recent", "animated", "static"]);
const DEFAULT_LIBRARY_LIMIT = 1000;
const MAX_BATCH = 100_000;

const RESERVED_PACK_NAMES = new Set();
for (const words of Object.values(PACK_SUBCOMMANDS)) {
  for (const word of words) {
    RESERVED_PACK_NAMES.add(
      String(word).normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase(),
    );
  }
}

function newId() {
  return crypto.randomBytes(8).toString("hex");
}

function libraryLimit() {
  try {
    const value = settings.get("sticker_library_limit");
    if (Number.isFinite(value) && value >= 1) return value;
  } catch {
    // A broken settings read must not refuse every save.
  }
  return DEFAULT_LIBRARY_LIMIT;
}

function canonicalContent(buffer) {
  if (
    buffer.length < 12 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WEBP"
  )
    return buffer;
  try {
    return webp.canonical(buffer);
  } catch (error) {
    // Old library callers and API fixtures can provide opaque bytes with a
    // WebP-looking header. Keep their existing storage behavior. The studio
    // validates actual WhatsApp media before it reaches this function.
    if (error instanceof StickerError && error.code === "CORRUPT") return buffer;
    throw error;
  }
}

function bind(owner) {
  if (!owner || typeof owner.key !== "string" || !owner.key || owner.key.length > 128) {
    throw new StickerError("INVALID_OPTIONS", { field: "owner" });
  }
  const candidates = [];
  const push = (value) => {
    if (typeof value !== "string" || !value || value.length > 128) return;
    if (!candidates.includes(value) && candidates.length < 32) candidates.push(value);
  };
  push(owner.key);
  if (Array.isArray(owner.candidates)) {
    for (const value of owner.candidates) push(value);
  }
  // Before this call's own transaction. Rekey opens one and must not nest.
  store.stickerRekey(candidates, owner.key);
  return { key: owner.key, candidates };
}

function eachId(ids, field = "ids") {
  if (!Array.isArray(ids) || ids.length > MAX_BATCH) {
    throw new StickerError("INVALID_OPTIONS", { field });
  }
  for (const id of ids) {
    if (typeof id !== "string" || !ID_RE.test(id)) {
      throw new StickerError("INVALID_OPTIONS", { field });
    }
  }
  return ids;
}

function sanitizeStickerName(raw) {
  if (raw == null) return "";
  if (typeof raw !== "string") throw new StickerError("INVALID_OPTIONS", { field: "name" });
  const text = raw.replace(/\p{Cc}/gu, "").trim();
  return [...text].slice(0, STICKER_NAME_MAX).join("");
}

function normalizePackName(raw) {
  if (typeof raw !== "string") throw new StickerError("INVALID_NAME");
  const name = raw.normalize("NFKC").replace(/\s+/g, " ").trim();
  const length = [...name].length;
  if (length < 1 || length > PACK_NAME_MAX || !PACK_NAME_RE.test(name)) {
    throw new StickerError("INVALID_NAME");
  }
  const nameKey = name.toLowerCase();
  if (RESERVED_PACK_NAMES.has(nameKey)) {
    throw new StickerError("INVALID_NAME", { reason: "reserved" });
  }
  return { name, nameKey };
}

function isUnique(error) {
  return /UNIQUE constraint failed/i.test(String(error?.message || ""));
}

function storageError(error) {
  if (error?.code === "EACCES" || error?.code === "ENOSPC" || error?.code === "EROFS") {
    return new StickerError("STORAGE_UNAVAILABLE", {}, { cause: error });
  }
  return error;
}

function bucket(sha) {
  return dataPath("stickers", sha.slice(0, 2));
}

function webpPath(sha) {
  return path.join(bucket(sha), `${sha}.webp`);
}

function thumbPath(sha) {
  return path.join(bucket(sha), `${sha}.thumb.webp`);
}

function writeAtomic(target, buffer) {
  const dir = path.dirname(target);
  const tmp = path.join(
    dir,
    `.${path.basename(target)}.${crypto.randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    // Inside the catch: a read-only stickers directory fails here (EACCES),
    // and that has to become STORAGE_UNAVAILABLE rather than a raw fs error.
    fs.mkdirSync(dir, { recursive: true });
    const fd = fs.openSync(tmp, "w", 0o644);
    try {
      fs.writeSync(fd, buffer);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, target);
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // The original error is the one the caller needs.
    }
    throw storageError(error);
  }
}

function writeIfAbsent(target, buffer) {
  if (fs.existsSync(target)) return;
  writeAtomic(target, buffer);
}

function rmQuiet(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch (error) {
    logger.warn({ err: error }, "[Stickers] failed to remove an unreferenced file");
  }
}

function removeIfOrphan(sha) {
  if (!sha || store.stickerShaCount(sha) > 0) return;
  rmQuiet(webpPath(sha));
  rmQuiet(thumbPath(sha));
  try {
    fs.rmdirSync(bucket(sha));
  } catch {
    // The bucket still holds another hash, or is already gone.
  }
}

function versionOf(sha) {
  return String(sha || "").slice(0, 12);
}

function stickerDto(row, packIds) {
  const version = versionOf(row.sha256);
  return {
    id: row.id,
    name: row.name,
    animated: !!row.animated,
    width: row.width,
    height: row.height,
    durationMs: row.duration_ms,
    fileSize: row.file_size,
    sourceMime: row.source_mime,
    source: row.source,
    favorite: !!row.is_favorite,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
    packIds: packIds || [],
    url: `/dashboard/api/stickers/${row.id}/file?v=${version}`,
    thumbUrl: `/dashboard/api/stickers/${row.id}/thumb?v=${version}`,
  };
}

function packDto(row) {
  const coverUrl =
    row.cover_id && row.cover_sha
      ? `/dashboard/api/stickers/${row.cover_id}/thumb?v=${versionOf(row.cover_sha)}`
      : null;
  return {
    id: row.id,
    name: row.name,
    count: row.item_count,
    coverUrl,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function present(bound, row) {
  if (!row) throw new StickerError("NOT_FOUND");
  const membership = store.stickerPackMembership(bound.candidates, [row.id]);
  return stickerDto(row, membership.get(row.id) || []);
}

function presentMany(bound, rows) {
  if (!rows.length) return [];
  const membership = store.stickerPackMembership(
    bound.candidates,
    rows.map((row) => row.id),
  );
  return rows.map((row) => stickerDto(row, membership.get(row.id) || []));
}

function requireStickerRow(bound, id) {
  if (typeof id !== "string" || !ID_RE.test(id)) {
    throw new StickerError("INVALID_OPTIONS", { field: "id" });
  }
  const row = store.stickerGet(bound.candidates, id);
  if (!row) throw new StickerError("NOT_FOUND");
  return row;
}

function requirePack(bound, id) {
  if (typeof id !== "string" || !ID_RE.test(id)) {
    throw new StickerError("INVALID_OPTIONS", { field: "packId" });
  }
  const pack = store.stickerPackGet(bound.candidates, id);
  if (!pack) throw new StickerError("NOT_FOUND");
  return pack;
}

function fileNameFor(sticker, ext) {
  const raw = sticker?.name ? String(sticker.name) : sticker.id;
  const cleaned = raw
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const base = [...cleaned].slice(0, STICKER_NAME_MAX).join("") || sticker.id;
  return `${base}.${ext}`;
}

function integerOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

function saveSticker(owner, input) {
  const bound = bind(owner);
  const sourceBuffer = input?.buffer;
  if (!Buffer.isBuffer(sourceBuffer) || sourceBuffer.length === 0)
    throw new StickerError("NO_MEDIA");
  const buffer = canonicalContent(sourceBuffer);
  if (!SOURCES.has(input.source)) throw new StickerError("INVALID_OPTIONS", { field: "source" });
  const name = sanitizeStickerName(input.name);
  const sha = crypto.createHash("sha256").update(buffer).digest("hex");
  const thumb =
    Buffer.isBuffer(input.thumbBuffer) && input.thumbBuffer.length ? input.thumbBuffer : null;

  const existing = store.stickerFindBySha(bound.candidates, sha);
  if (existing) {
    // The row won the race against a deleted file. Put the bytes back, still
    // one copy, and hand the original sticker back.
    writeIfAbsent(webpPath(sha), buffer);
    if (thumb) writeIfAbsent(thumbPath(sha), thumb);
    return {
      sticker: present(bound, store.stickerGet(bound.candidates, existing.id)),
      created: false,
    };
  }

  const limit = libraryLimit();
  if (store.stickerCount(bound.candidates) >= limit) {
    throw new StickerError("LIBRARY_FULL", { limit });
  }

  const id = newId();
  const now = Date.now();
  try {
    writeIfAbsent(webpPath(sha), buffer);
    if (thumb) writeIfAbsent(thumbPath(sha), thumb);
    store.stickerInsert({
      id,
      owner: bound.key,
      sha256: sha,
      name,
      animated: !!input.animated,
      width: integerOrNull(input.width),
      height: integerOrNull(input.height),
      durationMs: integerOrNull(input.durationMs),
      fileSize: buffer.length,
      source: input.source,
      sourceMime: input.sourceMime == null ? null : String(input.sourceMime),
      favorite: 0,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
    });
  } catch (error) {
    if (isUnique(error)) {
      const raced = store.stickerFindBySha(bound.candidates, sha);
      if (raced) return { sticker: present(bound, raced), created: false };
    }
    removeIfOrphan(sha);
    throw storageError(error);
  }
  return { sticker: present(bound, store.stickerGet(bound.candidates, id)), created: true };
}

function hasRoom(owner) {
  const bound = bind(owner);
  return store.stickerCount(bound.candidates) < libraryLimit();
}

function findStickerByContent(owner, buffer) {
  const bound = bind(owner);
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new StickerError("NOT_FOUND");
  const sha = crypto.createHash("sha256").update(canonicalContent(buffer)).digest("hex");
  return present(bound, store.stickerFindBySha(bound.candidates, sha));
}

function getSticker(owner, id) {
  const bound = bind(owner);
  return present(bound, requireStickerRow(bound, id));
}

function readBytes(owner, id, which) {
  const bound = bind(owner);
  const row = requireStickerRow(bound, id);
  const file = which === "thumb" ? thumbPath(row.sha256) : webpPath(row.sha256);
  try {
    return fs.readFileSync(file);
  } catch (error) {
    logger.error({ err: error, stickerId: id }, "[Stickers] library row has no file");
    throw new StickerError("NOT_FOUND");
  }
}

function readStickerFile(owner, id) {
  return readBytes(owner, id, "file");
}

function readThumbnail(owner, id) {
  return readBytes(owner, id, "thumb");
}

function listStickers(owner, query = {}) {
  const bound = bind(owner);
  const sort = query.sort || "newest";
  const filter = query.filter || "all";
  if (!SORTS.has(sort)) throw new StickerError("INVALID_OPTIONS", { field: "sort" });
  if (!FILTERS.has(filter)) throw new StickerError("INVALID_OPTIONS", { field: "filter" });
  const pack = query.pack ?? null;
  if (pack != null && pack !== "none" && (typeof pack !== "string" || !ID_RE.test(pack))) {
    throw new StickerError("INVALID_OPTIONS", { field: "pack" });
  }
  const limit = query.limit == null ? 60 : query.limit;
  const offset = query.offset == null ? 0 : query.offset;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new StickerError("INVALID_OPTIONS", { field: "limit" });
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new StickerError("INVALID_OPTIONS", { field: "offset" });
  }
  const q = query.q == null ? "" : String(query.q);
  if (q.length > 200) throw new StickerError("INVALID_OPTIONS", { field: "q" });
  const { rows, total } = store.stickerQuery(bound.candidates, {
    q,
    sort,
    filter,
    pack,
    limit,
    offset,
  });
  return { items: presentMany(bound, rows), total };
}

function updateSticker(owner, id, patch = {}) {
  const bound = bind(owner);
  const row = requireStickerRow(bound, id);
  const fields = {};
  if (patch.name !== undefined) fields.name = sanitizeStickerName(patch.name);
  if (patch.favorite !== undefined) {
    if (typeof patch.favorite !== "boolean") {
      throw new StickerError("INVALID_OPTIONS", { field: "favorite" });
    }
    fields.isFavorite = patch.favorite;
  }
  if (Object.keys(fields).length) {
    fields.updatedAt = Date.now();
    store.stickerUpdate(row.id, fields);
  }
  return present(bound, store.stickerGet(bound.candidates, row.id));
}

function deleteStickers(owner, ids, options = {}) {
  const bound = bind(owner);
  const list = eachId(ids);
  const rows = list.map((id) => requireStickerRow(bound, id));
  if (!options.confirm) {
    for (const row of rows) {
      const packs = store.stickerPacksUsing(bound.candidates, row.id);
      if (packs.length) throw new StickerError("IN_USE", { packs });
    }
  }
  const shas = store.withImmediateTransaction(() => {
    const touched = new Set();
    for (const row of rows) {
      for (const pack of store.stickerPackIdsOf(row.id)) touched.add(pack.pack_id);
    }
    for (const row of rows) store.stickerDelete(row.id);
    for (const packId of touched) store.stickerPackRenumber(packId);
    return rows.map((row) => row.sha256);
  });
  for (const sha of new Set(shas)) removeIfOrphan(sha);
  return { deleted: rows.map((row) => row.id) };
}

function applyEach(owner, ids, fn) {
  const bound = bind(owner);
  const list = eachId(ids);
  let affected = 0;
  const skipped = [];
  for (const id of list) {
    const row = store.stickerGet(bound.candidates, id);
    if (!row) {
      skipped.push({ id, code: "NOT_FOUND" });
      continue;
    }
    if (fn(row)) affected += 1;
  }
  return { affected, skipped };
}

function setFavorite(owner, ids, favorite) {
  if (typeof favorite !== "boolean") {
    throw new StickerError("INVALID_OPTIONS", { field: "favorite" });
  }
  const now = Date.now();
  return applyEach(owner, ids, (row) => {
    store.stickerUpdate(row.id, { isFavorite: favorite, updatedAt: now });
    return true;
  });
}

function touch(owner, ids) {
  const now = Date.now();
  return applyEach(owner, ids, (row) => {
    store.stickerUpdate(row.id, { lastUsedAt: now });
    return true;
  });
}

function createPack(owner, name) {
  const bound = bind(owner);
  const parsed = normalizePackName(name);
  if (store.stickerPackByKey(bound.candidates, parsed.nameKey)) {
    throw new StickerError("PACK_EXISTS", { name: parsed.name });
  }
  if (store.stickerPackCount(bound.candidates) >= PACKS_MAX_PER_OWNER) {
    throw new StickerError("PACK_LIMIT", { limit: PACKS_MAX_PER_OWNER });
  }
  const now = Date.now();
  const id = newId();
  try {
    store.stickerPackInsert({
      id,
      owner: bound.key,
      name: parsed.name,
      nameKey: parsed.nameKey,
      createdAt: now,
      updatedAt: now,
    });
  } catch (error) {
    if (isUnique(error)) throw new StickerError("PACK_EXISTS", { name: parsed.name });
    throw error;
  }
  return packDto(store.stickerPackGet(bound.candidates, id));
}

function listPacks(owner) {
  const bound = bind(owner);
  return store.stickerPackList(bound.candidates).map(packDto);
}

function getPack(owner, id) {
  const bound = bind(owner);
  const pack = requirePack(bound, id);
  const rows = store.stickerPackItems(pack.id);
  return { pack: packDto(pack), items: presentMany(bound, rows) };
}

function updatePack(owner, id, name) {
  const bound = bind(owner);
  const pack = requirePack(bound, id);
  const parsed = normalizePackName(name);
  const other = store.stickerPackByKey(bound.candidates, parsed.nameKey);
  if (other && other.id !== pack.id) throw new StickerError("PACK_EXISTS", { name: parsed.name });
  store.stickerPackRename(pack.id, parsed.name, parsed.nameKey, Date.now());
  return packDto(store.stickerPackGet(bound.candidates, pack.id));
}

function deletePack(owner, id, options = {}) {
  const bound = bind(owner);
  const pack = requirePack(bound, id);
  const removed = store.withImmediateTransaction(() => {
    const exclusive = options.deleteStickers ? store.stickerPackExclusive(pack.id) : [];
    store.stickerPackDelete(pack.id);
    for (const item of exclusive) store.stickerDelete(item.id);
    return exclusive;
  });
  for (const item of removed) removeIfOrphan(item.sha256);
  return { deletedPack: pack.id, deletedStickers: removed.map((item) => item.id) };
}

function findPackByName(owner, name) {
  const bound = bind(owner);
  let parsed;
  try {
    parsed = normalizePackName(name);
  } catch (error) {
    if (error instanceof StickerError && error.code === "INVALID_NAME") return null;
    throw error;
  }
  const row = store.stickerPackByKey(bound.candidates, parsed.nameKey);
  return row ? packDto(row) : null;
}

function membershipResult(bound, packId, ids, mutate) {
  const list = eachId(ids);
  return store.withImmediateTransaction(() => {
    const pack = requirePack(bound, packId);
    let affected = 0;
    const skipped = [];
    const now = Date.now();
    for (const id of list) {
      const sticker = store.stickerGet(bound.candidates, id);
      if (!sticker) {
        skipped.push({ id, code: "NOT_FOUND" });
        continue;
      }
      if (mutate(pack, sticker, now)) affected += 1;
    }
    return { affected, skipped };
  });
}

function addToPack(owner, packId, ids) {
  const bound = bind(owner);
  return membershipResult(bound, packId, ids, (pack, sticker, now) =>
    store.stickerPackAdd(pack.id, sticker.id, now),
  );
}

function removeFromPack(owner, packId, ids) {
  const bound = bind(owner);
  return membershipResult(bound, packId, ids, (pack, sticker) =>
    store.stickerPackRemoveItem(pack.id, sticker.id),
  );
}

function moveToPack(owner, ids, packId, options = {}) {
  const bound = bind(owner);
  const list = eachId(ids);
  const fromPackId = options.fromPackId;
  return store.withImmediateTransaction(() => {
    const pack = requirePack(bound, packId);
    const from = fromPackId == null ? null : requirePack(bound, fromPackId);
    let affected = 0;
    const skipped = [];
    const now = Date.now();
    for (const id of list) {
      const sticker = store.stickerGet(bound.candidates, id);
      if (!sticker) {
        skipped.push({ id, code: "NOT_FOUND" });
        continue;
      }
      if (from) {
        if (from.id !== pack.id) store.stickerPackRemoveItem(from.id, sticker.id);
      } else {
        for (const membership of store.stickerPackIdsOf(sticker.id)) {
          if (membership.pack_id === pack.id) continue;
          if (!store.stickerPackGet(bound.candidates, membership.pack_id)) continue;
          store.stickerPackRemoveItem(membership.pack_id, sticker.id);
        }
      }
      store.stickerPackAdd(pack.id, sticker.id, now);
      affected += 1;
    }
    return { affected, skipped };
  });
}

function reorderPack(owner, packId, ids) {
  const bound = bind(owner);
  const list = eachId(ids);
  store.withImmediateTransaction(() => {
    const pack = requirePack(bound, packId);
    if (!store.stickerPackReorder(pack.id, list)) {
      throw new StickerError("INVALID_OPTIONS", { field: "ids" });
    }
  });
  return { ok: true };
}

function mergePacks(owner, sourceId, intoPackId) {
  const bound = bind(owner);
  if (sourceId === intoPackId) throw new StickerError("INVALID_OPTIONS", { field: "intoPackId" });
  const moved = store.withImmediateTransaction(() => {
    const source = requirePack(bound, sourceId);
    const target = requirePack(bound, intoPackId);
    const items = store.stickerPackItems(source.id);
    const now = Date.now();
    let added = 0;
    for (const item of items) {
      if (store.stickerPackAdd(target.id, item.id, now)) added += 1;
    }
    store.stickerPackDelete(source.id);
    store.stickerPackRenumber(target.id);
    return added;
  });
  return { pack: packDto(store.stickerPackGet(bound.candidates, intoPackId)), moved };
}

function clearAll() {
  store.stickerClearAll();
  try {
    fs.rmSync(dataPath("stickers"), { recursive: true, force: true });
  } catch (error) {
    logger.error({ err: error }, "[Stickers] failed to remove sticker files");
    throw new StickerError("STORAGE_UNAVAILABLE", {}, { cause: error });
  }
  try {
    require("./uploads.cjs").discardAll();
  } catch (error) {
    logger.warn({ err: error }, "[Stickers] failed to discard uploads");
  }
}

module.exports = {
  saveSticker,
  hasRoom,
  findStickerByContent,
  getSticker,
  readStickerFile,
  readThumbnail,
  listStickers,
  updateSticker,
  deleteStickers,
  setFavorite,
  touch,
  createPack,
  listPacks,
  getPack,
  updatePack,
  deletePack,
  findPackByName,
  addToPack,
  removeFromPack,
  moveToPack,
  reorderPack,
  mergePacks,
  clearAll,
  fileNameFor,
};

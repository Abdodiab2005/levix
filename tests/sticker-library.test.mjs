// Sticker library: ownership, packs, files, and the unlink wipe.
// Media conversion is not involved here — saving takes WebP bytes directly.

import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { equal, finish, ok, require, section, throws, useTempDataDir } from "./harness.mjs";

useTempDataDir("levix-stk-lib");

const store = require("./src/db/store.cjs");
const { db } = require("./src/db/db.cjs");
const { dataPath } = require("./src/config/paths.cjs");
const settings = require("./src/config/settings.cjs");
const library = require("./src/stickers/library.cjs");
const owner = require("./src/stickers/owner.cjs");
const uploads = require("./src/stickers/uploads.cjs");
const { zipStore } = require("./src/stickers/zip.cjs");
const { UPLOAD_TTL_MS, PACKS_MAX_PER_OWNER } = require("./src/stickers/limits.cjs");
const zlib = require("node:zlib");

const self = () => owner.forPanel();
const person = (key, ...more) => ({ key, candidates: [key, ...more] });

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function stickerFile(buffer) {
  const sha = sha256(buffer);
  return dataPath("stickers", sha.slice(0, 2), `${sha}.webp`);
}

function save(who, bytes, extra = {}) {
  const buffer = Buffer.from(bytes);
  return library.saveSticker(who, {
    width: 64,
    height: 64,
    animated: false,
    durationMs: 0,
    sourceMime: "image/webp",
    source: "PANEL_UPLOAD",
    name: "",
    ...extra,
    buffer,
    thumbBuffer: extra.thumbBuffer || Buffer.from(`thumb:${buffer.toString("utf8")}`),
  });
}

function positionsOf(packId) {
  return db
    .prepare("SELECT position FROM sticker_pack_items WHERE pack_id = ? ORDER BY position ASC")
    .all(packId)
    .map((row) => row.position);
}

function idsOf(packId) {
  return db
    .prepare("SELECT sticker_id FROM sticker_pack_items WHERE pack_id = ? ORDER BY position ASC")
    .all(packId)
    .map((row) => row.sticker_id);
}

function codeOf(fn) {
  const error = throws("throws", fn);
  return error?.code || null;
}

section("dedupe keeps one row and one file per owner");

{
  const who = self();
  const first = save(who, "pixel-cat", { name: "Cat" });
  ok("the first save is new", first.created);
  equal(
    "content lookup finds the owner's row",
    library.findStickerByContent(who, Buffer.from("pixel-cat")).id,
    first.sticker.id,
  );
  equal(
    "content lookup hides another owner",
    codeOf(() =>
      library.findStickerByContent(person("201777000000@s.whatsapp.net"), Buffer.from("pixel-cat")),
    ),
    "NOT_FOUND",
  );
  const second = save(who, "pixel-cat", { name: "Other" });
  ok("the same bytes are not created again", !second.created);
  equal("it is the same sticker", second.sticker.id, first.sticker.id);
  equal("the original name stays", second.sticker.name, "Cat");
  equal("one row", library.listStickers(who, {}).total, 1);
  ok("one file", existsSync(stickerFile(Buffer.from("pixel-cat"))));
  const read = library.readStickerFile(who, first.sticker.id);
  ok("the file is the original bytes", read.equals(Buffer.from("pixel-cat")));
  ok(
    "the thumbnail is stored beside it",
    library.readThumbnail(who, first.sticker.id).equals(Buffer.from("thumb:pixel-cat")),
  );
}

section("a person seen as a LID and later as a phone number is one library");

{
  const lid = "111222333444555@lid";
  const pn = "201555000111@s.whatsapp.net";
  const bytes = Buffer.from("lid-then-pn");
  const lidOwner = owner.forMessage({ key: { remoteJid: lid } });
  equal("a bare LID is its own key", lidOwner.key, lid);
  const named = save(lidOwner, bytes, { name: "Cat" });
  library.setFavorite(lidOwner, [named.sticker.id], true);

  const pnOnly = person(pn);
  const duplicate = save(pnOnly, bytes, { name: "" });
  ok("without the mapping the phone key is a second row", duplicate.created);

  store.storeLidPnMapping(lid, pn);
  const unified = owner.forMessage({ key: { remoteJid: lid } });
  equal("once mapped, the LID resolves to the phone JID", unified.key, pn);
  ok("both identifiers are candidates", unified.candidates.includes(lid));
  const list = library.listStickers(unified, {});
  equal("the two rows collapse", list.total, 1);
  equal("the name survives the merge", list.items[0].name, "Cat");
  ok("the favorite survives the merge", list.items[0].favorite);
  const again = save(unified, bytes);
  ok("saving the bytes again is the kept sticker", !again.created);
  equal("still one file", library.listStickers(person(pn, lid), {}).total, 1);

  const lid2 = "999888777666555@lid";
  const pn2 = "201555000222@s.whatsapp.net";
  const only = save(owner.forMessage({ key: { remoteJid: lid2 } }), "only-lid", { name: "Only" });
  store.storeLidPnMapping(lid2, pn2);
  const later = owner.forMessage({ key: { remoteJid: pn2 } });
  equal("a later phone message is the canonical key", later.key, pn2);
  equal(
    "it finds the sticker saved under the LID",
    library.getSticker(later, only.sticker.id).name,
    "Only",
  );
  const missed = codeOf(() => library.getSticker(person(lid2), only.sticker.id));
  equal("a stale LID-only owner does not open a second library", missed, "NOT_FOUND");
}

section("two LIDs mapped to one phone do not share a library");

{
  const lidA = "111000000000001@lid";
  const lidB = "111000000000002@lid";
  const pn = "201888000111@s.whatsapp.net";
  const saved = save(owner.forMessage({ key: { remoteJid: lidA } }), "a-secret", {
    name: "A only",
  });
  store.storeLidPnMapping(lidA, pn);
  store.storeLidPnMapping(lidB, pn);

  function ownerOf(id) {
    return db.prepare("SELECT owner FROM stickers WHERE id = ?").get(id).owner;
  }

  const b = owner.forMessage({ key: { remoteJid: lidB } });
  equal("B's canonical key is the shared phone", b.key, pn);
  ok("B keeps their own LID", b.candidates.includes(lidB));
  ok("B resolves that LID to the phone", b.candidates.includes(pn));
  ok("B does not gain A's LID", !b.candidates.includes(lidA));
  equal("B's list is empty", library.listStickers(b, {}).total, 0);
  equal(
    "B cannot read A's sticker",
    codeOf(() => library.getSticker(b, saved.sticker.id)),
    "NOT_FOUND",
  );
  equal(
    "B cannot update A's sticker",
    codeOf(() => library.updateSticker(b, saved.sticker.id, { name: "stolen" })),
    "NOT_FOUND",
  );
  equal(
    "B cannot delete A's sticker",
    codeOf(() => library.deleteStickers(b, [saved.sticker.id], { confirm: true })),
    "NOT_FOUND",
  );
  equal("A's row was not rekeyed", ownerOf(saved.sticker.id), lidA);
  equal(
    "A still has the sticker",
    library.getSticker(person(lidA), saved.sticker.id).name,
    "A only",
  );

  const asPhone = owner.forMessage({ key: { remoteJid: pn } });
  equal("a shared phone pulls in no LID", asPhone.candidates.length, 1);
  equal("that candidate is the phone itself", asPhone.candidates[0], pn);
  library.listStickers(asPhone, {});
  equal("a phone message did not rekey A's row", ownerOf(saved.sticker.id), lidA);

  const grouped = owner.forMessage({
    key: {
      remoteJid: "120363000111222@g.us",
      participant: lidB,
      participantAlt: pn,
    },
  });
  ok("a group message does not pull in the other LID", !grouped.candidates.includes(lidA));

  const onPhone = save(person(pn), "on-the-number", { name: "On the number" });
  equal(
    "a row already keyed by the phone JID is visible to B",
    library.getSticker(b, onPhone.sticker.id).name,
    "On the number",
  );
  equal("A's LID row is still A's", ownerOf(saved.sticker.id), lidA);
}

section("the paired account shares the panel library");

{
  store.authWrite(
    "creds",
    JSON.stringify({
      registered: true,
      me: { id: "201777000333:12@s.whatsapp.net", lid: "424242424242@lid" },
    }),
  );
  equal(
    "fromMe is self",
    owner.forMessage({ key: { fromMe: true, remoteJid: "201000000009@s.whatsapp.net" } }).key,
    "self",
  );
  equal(
    "the paired phone, device suffix included, is self",
    owner.forMessage({ key: { remoteJid: "201777000333@s.whatsapp.net" } }).key,
    "self",
  );
  equal(
    "the paired LID is self",
    owner.forMessage({ key: { remoteJid: "424242424242@lid" } }).key,
    "self",
  );
  const stranger = owner.forMessage({ key: { remoteJid: "201666000444:12@s.whatsapp.net" } });
  equal(
    "someone else keeps a phone key, suffix stripped",
    stranger.key,
    "201666000444@s.whatsapp.net",
  );
  const group = owner.forMessage({
    key: {
      remoteJid: "120363999@g.us",
      participant: "555666777888@lid",
      participantAlt: "201444000333@s.whatsapp.net",
    },
  });
  equal("a group sender prefers the phone JID", group.key, "201444000333@s.whatsapp.net");
  ok("and still matches the LID", group.candidates.includes("555666777888@lid"));
  equal("the panel is self", owner.forPanel().key, "self");
  store.authRemove("creds");
}

section("another owner cannot see, change, or pack these stickers");

{
  const a = person("201100000001@s.whatsapp.net");
  const b = person("201100000002@s.whatsapp.net");
  const saved = save(a, "owner-a", { name: "Mine" });
  const pack = library.createPack(a, "Mine");
  library.addToPack(a, pack.id, [saved.sticker.id]);
  equal("B's list is empty", library.listStickers(b, {}).total, 0);
  equal(
    "B's list filtered to A's pack is empty",
    library.listStickers(b, { pack: pack.id }).total,
    0,
  );
  equal(
    "reading A's sticker",
    codeOf(() => library.getSticker(b, saved.sticker.id)),
    "NOT_FOUND",
  );
  equal(
    "exporting the file",
    codeOf(() => library.readStickerFile(b, saved.sticker.id)),
    "NOT_FOUND",
  );
  equal(
    "favoriting",
    codeOf(() => library.updateSticker(b, saved.sticker.id, { favorite: true })),
    "NOT_FOUND",
  );
  equal(
    "deleting",
    codeOf(() => library.deleteStickers(b, [saved.sticker.id], {})),
    "NOT_FOUND",
  );
  const own = library.createPack(b, "Theirs");
  const added = library.addToPack(b, own.id, [saved.sticker.id]);
  equal("adding A's sticker into B's pack skips it", added.skipped[0].code, "NOT_FOUND");
  equal(
    "reordering A's pack",
    codeOf(() => library.reorderPack(b, pack.id, [saved.sticker.id])),
    "NOT_FOUND",
  );
  equal(
    "merging A's pack",
    codeOf(() => library.mergePacks(b, pack.id, own.id)),
    "NOT_FOUND",
  );
  ok("A's sticker is still there", library.getSticker(a, saved.sticker.id).name === "Mine");
}

section("pack names");

{
  const who = person("201200000001@s.whatsapp.net");
  const pack = library.createPack(who, "  My   Pack ");
  equal("whitespace is collapsed", pack.name, "My Pack");
  const renamed = library.updatePack(who, pack.id, "my pack");
  equal("a case-only rename is the same pack", renamed.id, pack.id);
  equal("the new spelling is kept", renamed.name, "my pack");
  equal(
    "a second pack with that key",
    codeOf(() => library.createPack(who, "MY PACK")),
    "PACK_EXISTS",
  );
  equal(
    "an empty name",
    codeOf(() => library.createPack(who, "   ")),
    "INVALID_NAME",
  );
  equal(
    "punctuation",
    codeOf(() => library.createPack(who, "hello!")),
    "INVALID_NAME",
  );
  equal(
    "a reserved word",
    codeOf(() => library.createPack(who, "Create")),
    "INVALID_NAME",
  );
  equal(
    "an Arabic reserved word",
    codeOf(() => library.createPack(who, "إنشاء")),
    "INVALID_NAME",
  );
  const arabic = library.createPack(who, "ملصقات");
  equal("Arabic letters are a name", arabic.name, "ملصقات");
  equal("find is case-insensitive", library.findPackByName(who, "MY PACK").id, pack.id);
  equal("a reserved lookup is not a pack", library.findPackByName(who, "create"), null);
  equal(
    "forty-one letters",
    codeOf(() => library.createPack(who, "ا".repeat(41))),
    "INVALID_NAME",
  );

  const limited = person("201200000002@s.whatsapp.net");
  for (let i = 0; i < PACKS_MAX_PER_OWNER; i += 1) library.createPack(limited, `Pack ${i}`);
  equal(
    "the cap is the pack limit",
    codeOf(() => library.createPack(limited, "one more")),
    "PACK_LIMIT",
  );
  equal(
    "a duplicate at the cap is still a duplicate",
    codeOf(() => library.createPack(limited, "pack 0")),
    "PACK_EXISTS",
  );
}

section("membership, order, and merge");

{
  const who = person("201300000001@s.whatsapp.net");
  const s1 = save(who, "s1", { name: "one" }).sticker;
  const s2 = save(who, "s2", { name: "two" }).sticker;
  const s3 = save(who, "s3", { name: "three" }).sticker;
  const alpha = library.createPack(who, "Alpha");
  const beta = library.createPack(who, "Beta");
  library.addToPack(who, alpha.id, [s1.id, s2.id]);
  library.addToPack(who, beta.id, [s2.id, s3.id]);
  equal(
    "adding s2 to Alpha again changes nothing",
    library.addToPack(who, alpha.id, [s2.id]).affected,
    0,
  );
  equal("copy leaves it in both", library.getSticker(who, s2.id).packIds.length, 2);
  equal("positions start dense", JSON.stringify(positionsOf(alpha.id)), JSON.stringify([0, 1]));

  library.removeFromPack(who, alpha.id, [s1.id]);
  ok("removing from a pack keeps the sticker", library.getSticker(who, s1.id).id === s1.id);
  equal("the hole is closed", JSON.stringify(positionsOf(alpha.id)), JSON.stringify([0]));
  equal("Alpha now holds only s2", idsOf(alpha.id)[0], s2.id);

  library.addToPack(who, alpha.id, [s1.id, s3.id]);
  library.reorderPack(who, alpha.id, [s3.id, s1.id, s2.id]);
  equal(
    "reorder is the permutation",
    JSON.stringify(idsOf(alpha.id)),
    JSON.stringify([s3.id, s1.id, s2.id]),
  );
  equal(
    "a partial order is rejected",
    codeOf(() => library.reorderPack(who, alpha.id, [s1.id, s2.id])),
    "INVALID_OPTIONS",
  );
  equal(
    "and does not change the pack",
    JSON.stringify(idsOf(alpha.id)),
    JSON.stringify([s3.id, s1.id, s2.id]),
  );

  library.moveToPack(who, [s1.id], beta.id, { fromPackId: alpha.id });
  ok("move drops it from the source", !idsOf(alpha.id).includes(s1.id));
  ok("and puts it on the target", idsOf(beta.id).includes(s1.id));
  library.addToPack(who, alpha.id, [s1.id]);
  library.moveToPack(who, [s1.id], beta.id, {});
  ok(
    "a move with no source pack removes it from every other pack",
    !idsOf(alpha.id).includes(s1.id),
  );

  const merged = library.mergePacks(who, alpha.id, beta.id);
  equal(
    "duplicates are not appended twice",
    merged.moved,
    idsOf(beta.id).filter((id) => id === s2.id).length === 1 ? merged.moved : -1,
  );
  ok(
    "s2 is still a single membership in Beta",
    idsOf(beta.id).filter((id) => id === s2.id).length === 1,
  );
  const betaIds = idsOf(beta.id);
  equal("Beta's own items stay in front", betaIds[0], s2.id);
  ok("Alpha's remaining items were appended", betaIds.includes(s3.id));
  equal(
    "the source pack is gone",
    codeOf(() => library.getPack(who, alpha.id)),
    "NOT_FOUND",
  );
  ok("merge does not delete a sticker", library.getSticker(who, s3.id).name === "three");
  equal(
    "merged positions are dense",
    JSON.stringify(positionsOf(beta.id)),
    JSON.stringify(betaIds.map((_, i) => i)),
  );
}

section("deletion rules");

{
  const who = person("201400000001@s.whatsapp.net");
  const a = save(who, "del-a").sticker;
  const b = save(who, "del-b").sticker;
  const c = save(who, "del-c").sticker;
  const pack = library.createPack(who, "Keep");
  const other = library.createPack(who, "Other");
  library.addToPack(who, pack.id, [a.id, b.id]);
  library.addToPack(who, other.id, [b.id]);

  const blocked = throws("in use", () => library.deleteStickers(who, [a.id], {}));
  equal("deleting a packed sticker needs confirm", blocked.code, "IN_USE");
  equal("the pack is named", blocked.details.packs[0].name, "Keep");
  ok("and the sticker is still there", library.getSticker(who, a.id).id === a.id);

  library.deleteStickers(who, [a.id], { confirm: true });
  equal(
    "confirm removes it",
    codeOf(() => library.getSticker(who, a.id)),
    "NOT_FOUND",
  );
  equal("the pack closes the gap", JSON.stringify(positionsOf(pack.id)), JSON.stringify([0]));
  equal("the remaining item is b", idsOf(pack.id)[0], b.id);

  const kept = library.deletePack(who, pack.id, {});
  equal("deleting a pack deletes no stickers by default", kept.deletedStickers.length, 0);
  ok("b is still in the library", library.getSticker(who, b.id).id === b.id);
  ok("b is still in the other pack", library.getSticker(who, b.id).packIds.includes(other.id));

  const again = library.createPack(who, "Temp");
  library.addToPack(who, again.id, [c.id, b.id]);
  const wiped = library.deletePack(who, again.id, { deleteStickers: true });
  ok("an exclusive sticker is deleted with the pack", wiped.deletedStickers.includes(c.id));
  ok("a sticker that lives in another pack is kept", library.getSticker(who, b.id).id === b.id);
  equal(
    "c is gone",
    codeOf(() => library.getSticker(who, c.id)),
    "NOT_FOUND",
  );
}

section("a file stays until every owner has dropped it");

{
  const a = person("201500000001@s.whatsapp.net");
  const b = person("201500000002@s.whatsapp.net");
  const bytes = Buffer.from("shared-bytes");
  const left = save(a, bytes).sticker;
  const right = save(b, bytes).sticker;
  ok("two rows share one file", existsSync(stickerFile(bytes)));
  library.deleteStickers(a, [left.id], { confirm: true });
  ok("the file remains while B still references it", existsSync(stickerFile(bytes)));
  library.deleteStickers(b, [right.id], { confirm: true });
  ok("the file goes when the last row goes", !existsSync(stickerFile(bytes)));
}

section("favorites, recency, and search");

{
  const who = person("201600000001@s.whatsapp.net");
  const cat = save(who, "cat", { name: "Cat" }).sticker;
  const dog = save(who, "dog", { name: "dog_100%" }).sticker;
  const ant = save(who, "ant", { name: "ant" }).sticker;
  library.setFavorite(who, [cat.id], true);
  equal("favorites filter", library.listStickers(who, { filter: "favorites" }).total, 1);
  equal(
    "name sort is case-insensitive",
    library.listStickers(who, { sort: "name" }).items[0].name,
    "ant",
  );

  const starred = library.setFavorite(who, [dog.id, "ab".repeat(8)], false);
  equal("a missing id is skipped", starred.skipped[0].code, "NOT_FOUND");
  equal("the real one is updated", starred.affected, 1);

  library.touch(who, [cat.id]);
  ok("touch sets last used", library.getSticker(who, cat.id).lastUsedAt > 0);
  const before = library.getSticker(who, dog.id).updatedAt;
  library.touch(who, [dog.id]);
  equal("touch does not bump updatedAt", library.getSticker(who, dog.id).updatedAt, before);

  const now = Date.now();
  store.stickerUpdate(cat.id, { lastUsedAt: now - 5000 });
  store.stickerUpdate(dog.id, { lastUsedAt: now - 1000 });
  store.stickerUpdate(ant.id, { lastUsedAt: now - 40 * 24 * 60 * 60 * 1000 });
  const recent = library.listStickers(who, { filter: "recent", sort: "name" });
  ok(
    "an old last-used sticker drops out of recent",
    recent.items.every((item) => item.id !== ant.id),
  );
  // Name order would put cat before dog. Recency puts the later touch first.
  equal("recent is ordered by recency even when sort is name", recent.items[0].id, dog.id);
  equal("the older recent sticker follows", recent.items[1].id, cat.id);

  equal("a percent sign is not a wildcard", library.listStickers(who, { q: "%" }).total, 1);
  equal(
    "an underscore is not a wildcard",
    library.listStickers(who, { q: "_" }).items[0].id,
    dog.id,
  );
  equal("case-insensitive", library.listStickers(who, { q: "cat" }).items[0].id, cat.id);

  const loose = save(who, "loose").sticker;
  equal(
    "pack=none is the unpacked ones",
    library.listStickers(who, { pack: "none" }).items.some((item) => item.id === loose.id),
    true,
  );
  const page = library.listStickers(who, { limit: 1, offset: 0, sort: "oldest" });
  equal("paging reports the total", page.total > 1, true);
  equal("and returns one page", page.items.length, 1);
  equal(
    "limit 201 is rejected",
    codeOf(() => library.listStickers(who, { limit: 201 })),
    "INVALID_OPTIONS",
  );

  const cleaned = save(who, "controls", { name: "a\u0001b" }).sticker;
  equal("control characters are stripped", cleaned.name, "ab");
  const clipped = save(who, "long-name", { name: "ن".repeat(80) }).sticker;
  equal("names clip at the limit", [...clipped.name].length, 60);
}

section("the library cap is read when the sticker is saved");

{
  const who = person("201700000001@s.whatsapp.net");
  settings.set("sticker_library_limit", 1);
  try {
    ok("hasRoom before save", library.hasRoom(who));
    const first = save(who, "full-1");
    ok("hasRoom after save", !library.hasRoom(who));
    equal(
      "a new sticker past the cap",
      codeOf(() => save(who, "full-2")),
      "LIBRARY_FULL",
    );
    ok("the same bytes still dedupe", !save(who, "full-1").created);
    equal("it is the existing sticker", save(who, "full-1").sticker.id, first.sticker.id);
    settings.set("sticker_library_limit", 1000);
    ok("hasRoom reads changed setting", library.hasRoom(who));
    ok("a raised cap applies without a restart", save(who, "full-2").created);
  } finally {
    settings.set("sticker_library_limit", null);
  }
  const described = settings.describe().find((item) => item.key === "sticker_library_limit");
  equal("the setting is described like its neighbours", described.label, "Sticker library size");
  ok("the hint says the cap is read on save", described.hint.includes("Read on every save"));
}

section("store-only zip");

{
  const archive = zipStore(
    [
      { name: "cat.webp", data: Buffer.from("cat") },
      { name: "cat.webp", data: Buffer.from("cat-2") },
      { name: "../ملصق.webp", data: Buffer.from("arabic") },
    ],
    new Date(2026, 0, 2, 3, 4, 5),
  );
  const entries = readZip(archive);
  equal("three entries", entries.length, 3);
  equal("duplicate names are uniqued", entries[1].name, "cat-2.webp");
  equal("paths are stripped and Arabic is kept", entries[2].name, "ملصق.webp");
  equal("method is store", entries[0].method, 0);
  ok("the utf-8 flag is set", (entries[2].flags & 0x0800) !== 0);
  ok("the bytes round-trip", entries[2].data.equals(Buffer.from("arabic")));
  equal("crc matches", entries[0].crc, zlib.crc32(Buffer.from("cat")) >>> 0);
}

section("uploads are capped, typed, and owner-bound");

{
  const media = {
    sniff(buffer) {
      if (buffer[0] === 0xff && buffer[1] === 0xd8)
        return { kind: "image", mime: "image/jpeg", ext: "jpg" };
      return null;
    },
    async inspect() {
      return {
        kind: "image",
        mime: "image/jpeg",
        width: 8,
        height: 9,
        durationMs: 0,
        animated: false,
        frames: null,
      };
    },
  };
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const a = person("201800000001@s.whatsapp.net");
  const b = person("201800000002@s.whatsapp.net");
  const saved = await uploads.acceptStream(a, Readable.from([jpeg]), { filename: "a.jpg", media });
  equal("kind", saved.kind, "image");
  ok("the public record has no path", !("path" in saved));
  ok("the owner can read it back", uploads.get(a, saved.uploadId)?.path);
  equal("another owner cannot", uploads.get(b, saved.uploadId), null);

  const corrupt = {
    ...media,
    async inspect() {
      const { StickerError } = require("./src/stickers/errors.cjs");
      throw new StickerError("CORRUPT");
    },
  };
  let failed = null;
  try {
    await uploads.acceptStream(a, Readable.from([jpeg]), { media: corrupt });
  } catch (error) {
    failed = error;
  }
  equal("inspect failures surface", failed?.code, "CORRUPT");

  const dir = dataPath("tmp", "stickers");
  const stale = `${dir}/upload-stale-test`;
  const fresh = `${dir}/upload-fresh-test`;
  writeFileSync(stale, "old");
  writeFileSync(fresh, "new");
  const old = (Date.now() - UPLOAD_TTL_MS - 5000) / 1000;
  utimesSync(stale, old, old);
  uploads.sweepStale();
  ok("a stale temp file is removed", !existsSync(stale));
  ok("a fresh temp file stays", existsSync(fresh));
}

section("a write the disk refuses is storage unavailable");

{
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    ok("skipped as root", true);
  } else {
    const who = person("201900000001@s.whatsapp.net");
    save(who, "seed-file");
    const dir = dataPath("stickers");
    try {
      // The next hash almost certainly needs a new bucket inside this directory.
      const mode = 0o555;
      const { chmodSync } = require("node:fs");
      chmodSync(dir, mode);
      let blocked = null;
      for (let i = 0; i < 8 && !blocked; i += 1) {
        try {
          save(who, `denied-${i}-${randomBytes(8).toString("hex")}`);
        } catch (error) {
          blocked = error;
        }
      }
      equal("the save fails closed", blocked?.code, "STORAGE_UNAVAILABLE");
    } finally {
      const { chmodSync } = require("node:fs");
      chmodSync(dir, 0o755);
    }
  }
}

section("unlink clears every sticker, pack, and file");

{
  const who = self();
  const saved = save(who, "unlink-me", { name: "Gone" });
  library.createPack(who, "Gone");
  ok("the file exists before unlink", existsSync(stickerFile(Buffer.from("unlink-me"))));
  const { WhatsAppSession } = await import("../src/core/session.js");
  const session = new WhatsAppSession({
    clearCredentials: async () => store.authClearAll(),
    isLinked: () => false,
    log: { info() {}, warn() {}, error() {}, debug() {} },
  });
  await session.logout();
  equal("the library is empty", library.listStickers(who, {}).total, 0);
  equal("packs are empty", library.listPacks(who).length, 0);
  equal(
    "the sticker is gone",
    codeOf(() => library.getSticker(who, saved.sticker.id)),
    "NOT_FOUND",
  );
  ok("the file is gone", !existsSync(stickerFile(Buffer.from("unlink-me"))));
}

section("unlink cancels running and queued sticker work");

{
  const { createStudio } = require("./src/stickers/studio.cjs");
  const who = person("201900000099@s.whatsapp.net");
  let thumbnailStarted = 0;
  let conversionStarted = 0;
  let releaseThumbs;
  const thumbnailGate = new Promise((resolve) => {
    releaseThumbs = resolve;
  });
  const fakeMedia = {
    sniff: () => ({ kind: "webp", mime: "image/webp", ext: "webp" }),
    describeWebp: () => ({ width: 64, height: 64, animated: false, durationMs: 0 }),
    async makeThumbnail() {
      thumbnailStarted++;
      await thumbnailGate;
      return Buffer.from("thumbnail");
    },
    async createSticker() {
      conversionStarted++;
      throw new Error("queued conversion should not run");
    },
  };
  const studio = createStudio({ media: fakeMedia });
  const jobs = ["late-1", "late-2"].map((value) =>
    studio.createFromBuffer({ owner: who, buffer: Buffer.from(value) }),
  );
  jobs.push(
    studio.createFromBuffer({ owner: who, buffer: Buffer.from("queued-3"), options: { zoom: 2 } }),
  );
  const workFiles = () => {
    const dir = dataPath("tmp", "stickers");
    return existsSync(dir) ? readdirSync(dir).filter((name) => name.startsWith("work-")) : [];
  };
  equal("queued conversion has a temporary work file", workFiles().length, 1);
  const failures = jobs.map((job) => job.promise.catch((error) => error));
  for (let i = 0; i < 20 && thumbnailStarted < 2; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  equal("two keep-bytes jobs reached thumbnail", thumbnailStarted, 2);
  const oldEpoch = library.epoch();
  library.clearAll();
  releaseThumbs();
  const errors = await Promise.all(failures);
  await new Promise((resolve) => setImmediate(resolve));
  ok(
    "all jobs cancelled",
    errors.every((error) => error?.code === "CANCELLED"),
  );
  equal("queued job never reached thumbnail", thumbnailStarted, 2);
  equal("queued conversion never ran", conversionStarted, 0);
  equal("queued work file was removed", workFiles().length, 0);
  equal("no sticker rows after worker settles", library.listStickers(who).total, 0);
  equal("no sticker files after worker settles", existsSync(dataPath("stickers")), false);
  equal(
    "old epoch cannot save",
    codeOf(() => save(who, "late-write", { epoch: oldEpoch })),
    "CANCELLED",
  );
  const pack = library.createPack(who, "After unlink");
  equal(
    "old epoch cannot add to pack",
    codeOf(() => library.addToPack(who, pack.id, [], { epoch: oldEpoch })),
    "CANCELLED",
  );
  library.clearAll();
}

function readZip(buffer) {
  const eocd = buffer.length - 22;
  if (buffer.readUInt32LE(eocd) !== 0x06054b50) throw new Error("missing end of central directory");
  const count = buffer.readUInt16LE(eocd + 8);
  let cursor = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error("bad central header");
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const size = buffer.readUInt32LE(cursor + 20);
    const nameLen = buffer.readUInt16LE(cursor + 28);
    const extra = buffer.readUInt16LE(cursor + 30);
    const comment = buffer.readUInt16LE(cursor + 32);
    const localOff = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString("utf8", cursor + 46, cursor + 46 + nameLen);
    const name2 = buffer.readUInt16LE(localOff + 26);
    const extra2 = buffer.readUInt16LE(localOff + 28);
    const start = localOff + 30 + name2 + extra2;
    entries.push({ name, flags, method, crc, data: buffer.subarray(start, start + size) });
    cursor += 46 + nameLen + extra + comment;
  }
  return entries;
}

finish();

// Sticker libraries belong to an internal id. A phone number never selects one.

import { Readable } from "node:stream";
import { equal, finish, ok, require, section, throws, useTempDataDir } from "./harness.mjs";

useTempDataDir("levix-stk-owner");

const store = require("./src/db/store.cjs");
const { db } = require("./src/db/db.cjs");
const library = require("./src/stickers/library.cjs");
const owner = require("./src/stickers/owner.cjs");
const studio = require("./src/stickers/studio.cjs");
const uploads = require("./src/stickers/uploads.cjs");

const LID_A = "111111111111@lid";
const LID_B = "222222222222@lid";
const LID_Q = "333333333333@lid";
const PHONE_P = "201555000001@s.whatsapp.net";
const PHONE_Q = "201555000099@s.whatsapp.net";

function dm(lid, phone) {
  return {
    key: {
      fromMe: false,
      remoteJid: lid,
      ...(phone ? { remoteJidAlt: phone } : {}),
    },
  };
}

function phoneMessage(phone) {
  return { key: { fromMe: false, remoteJid: phone } };
}

function mappingSock(getLIDForPN) {
  return { signalRepository: { lidMapping: { getLIDForPN } } };
}

function pair(id, lid) {
  const me = { id };
  if (lid) me.lid = lid;
  store.authWrite("creds", JSON.stringify({ registered: true, me }));
}

function unpair() {
  store.authRemove("creds");
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
    thumbBuffer: Buffer.from(`thumb:${buffer.toString("utf8")}`),
  });
}

function codeOf(fn) {
  const error = throws("throws", fn);
  return error?.code || null;
}

function countOf(table) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}

function selfRow() {
  return db.prepare("SELECT * FROM sticker_owners WHERE kind = 'self'").get();
}

section("a recycled phone number does not inherit the library");

{
  const first = await owner.forMessage(dm(LID_A, PHONE_P));
  const saved = save(first, "recycle-a", { name: "Secret" });
  library.setFavorite(first, [saved.sticker.id], true);
  const pack = library.createPack(first, "Secrets");
  library.addToPack(first, pack.id, [saved.sticker.id]);

  const second = await owner.forMessage(dm(LID_B, PHONE_P));
  ok("the new LID gets its own id", /^[0-9a-f]{16}$/.test(second.key));
  ok("the new LID differs from the old one", second.key !== first.key);
  equal("the new LID has an empty library", library.listStickers(second).total, 0);
  equal("the new LID has no packs", library.listPacks(second).length, 0);
  equal(
    "the new LID cannot read the old sticker",
    codeOf(() => library.getSticker(second, saved.sticker.id)),
    "NOT_FOUND",
  );
  equal(
    "the new LID cannot open the old pack",
    codeOf(() => library.getPack(second, pack.id)),
    "NOT_FOUND",
  );

  const again = await owner.forMessage(dm(LID_A, PHONE_Q));
  equal("the original LID on a new phone keeps its id", again.key, first.key);
  equal("the original library is still there", library.listStickers(again).total, 1);
  ok("the favorite is still there", library.listStickers(again).items[0].favorite);
  equal("the pack is still there", library.listPacks(again).length, 1);
  equal(
    "the pack still holds the sticker",
    library.getPack(again, pack.id).items[0].id,
    saved.sticker.id,
  );
}

section("Baileys has the current phone mapping and lid_mapping does not");

{
  const staleLid = "121212121212@lid";
  const currentLid = "343434343434@lid";
  const phone = "201777000777@s.whatsapp.net";
  store.storeLidPnMapping(staleLid, phone);
  const stale = await owner.forMessage(dm(staleLid));
  const saved = save(stale, "stale-secret", { name: "Stale" });

  const current = await owner.forMessage(
    phoneMessage(phone),
    mappingSock(async () => currentLid),
  );
  ok("the current mapping gets an id", /^[0-9a-f]{16}$/.test(current.key));
  ok("the current mapping differs from the stale LID", current.key !== stale.key);
  equal("the current mapping starts empty", library.listStickers(current).total, 0);
  equal(
    "the stale library is untouched",
    library.getSticker(stale, saved.sticker.id).name,
    "Stale",
  );

  equal(
    "a null mapping identifies nobody",
    (
      await owner.forMessage(
        phoneMessage(phone),
        mappingSock(async () => null),
      )
    ).key,
    null,
  );
  equal(
    "a thrown mapping identifies nobody",
    (
      await owner.forMessage(
        phoneMessage(phone),
        mappingSock(() => {
          throw new Error("mapping down");
        }),
      )
    ).key,
    null,
  );

  const started = Date.now();
  const hung = await owner.forMessage(
    phoneMessage(phone),
    mappingSock(
      () =>
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve(staleLid), 20000);
          timer.unref();
        }),
    ),
  );
  const elapsed = Date.now() - started;
  equal("a hung mapping identifies nobody", hung.key, null);
  ok("the lookup stops at the timeout", elapsed >= 4500 && elapsed < 18000);
}

section("an unbound legacy library is not reachable by its phone");

{
  const phone = "201888000888@s.whatsapp.net";
  const orphanId = "abcdefabcdefabcd";
  db.prepare(
    `INSERT INTO sticker_owners (id, kind, account, legacy_key, created_at)
     VALUES (?, 'user', NULL, ?, ?)`,
  ).run(orphanId, phone, 1);
  const saved = save({ key: orphanId }, "legacy-orphan", { name: "Orphan" });
  equal(
    "a phone with no Baileys LID does not open it",
    (
      await owner.forMessage(
        phoneMessage(phone),
        mappingSock(async () => null),
      )
    ).key,
    null,
  );
  const stranger = await owner.forMessage(
    phoneMessage(phone),
    mappingSock(async () => "454545454545@lid"),
  );
  ok("a newly mapped LID is a different id", stranger.key !== orphanId);
  equal("that LID does not see the legacy sticker", library.listStickers(stranger).total, 0);
  equal(
    "the legacy row is still stored",
    library.getSticker({ key: orphanId }, saved.sticker.id).name,
    "Orphan",
  );
  equal(
    "the new LID cannot read it",
    codeOf(() => library.getSticker(stranger, saved.sticker.id)),
    "NOT_FOUND",
  );
}

section("the linked account is the panel library");

{
  pair("201700000001:2@s.whatsapp.net", "424242424242:4@lid");
  const panel = owner.forPanel();
  equal("self is bound to the normalized LID", selfRow().account, "424242424242@lid");
  const saved = save(panel, "shared-bytes", { name: "Shared" });
  const fromMe = await owner.forMessage({
    key: { fromMe: true, remoteJid: "201000000009@s.whatsapp.net" },
  });
  equal("fromMe is the panel", fromMe.key, panel.key);
  const grouped = await owner.forMessage({
    key: {
      remoteJid: "120363000000001@g.us",
      participant: "424242424242@lid",
      participantAlt: "201700000001@s.whatsapp.net",
    },
  });
  equal("a group message from the paired LID is the panel", grouped.key, panel.key);
  equal("the panel sees the sticker", library.getSticker(panel, saved.sticker.id).name, "Shared");
  equal(
    "the bot sees the same sticker",
    library.getSticker(fromMe, saved.sticker.id).name,
    "Shared",
  );
  equal("the group sender sees it too", library.listStickers(grouped).total, 1);
  unpair();
}

section("a linked phone with no lid is the panel");

{
  library.clearAll();
  pair("201700000002:8@s.whatsapp.net");
  const panel = owner.forPanel();
  equal("self is bound to the normalized phone", selfRow().account, "201700000002@s.whatsapp.net");
  equal(
    "fromMe is that library",
    (await owner.forMessage({ key: { fromMe: true, remoteJid: "1999@s.whatsapp.net" } })).key,
    panel.key,
  );
  equal(
    "a message from that phone is that library",
    (await owner.forMessage(phoneMessage("201700000002:3@s.whatsapp.net"))).key,
    panel.key,
  );
  equal(
    "a different phone is not identified",
    (await owner.forMessage(phoneMessage("201700000003@s.whatsapp.net"))).key,
    null,
  );
  unpair();
}

section("relinking gives the new account its own library");

{
  library.clearAll();
  pair("201700000010@s.whatsapp.net", LID_A);
  const panelA = owner.forPanel();
  const alpha = save(panelA, "alpha-bytes", { name: "Alpha" });
  const userB = await owner.forMessage(dm(LID_B));
  const beta = save(userB, "beta-bytes", { name: "Beta" });

  pair("201700000011@s.whatsapp.net", LID_B);
  const panelB = owner.forPanel();
  equal("the new panel is B's existing library", panelB.key, userB.key);
  ok("the new panel differs from A's", panelB.key !== panelA.key);
  equal("the panel shows B's sticker", library.listStickers(panelB).total, 1);
  equal("the panel shows Beta", library.listStickers(panelB).items[0].name, "Beta");
  equal(
    "the panel cannot read A's sticker",
    codeOf(() => library.getSticker(panelB, alpha.sticker.id)),
    "NOT_FOUND",
  );
  const asA = await owner.forMessage(dm(LID_A, PHONE_P));
  equal("A still opens the old library", asA.key, panelA.key);
  equal("A still has Alpha", library.getSticker(asA, alpha.sticker.id).name, "Alpha");
  equal("B still has Beta", library.getSticker(panelB, beta.sticker.id).name, "Beta");
  equal("the panel is bound to B", selfRow().account, LID_B);
  const old = db.prepare("SELECT kind, account FROM sticker_owners WHERE id = ?").get(panelA.key);
  equal("A's library is now a user row", old.kind, "user");
  equal("A's library keeps A's account", old.account, LID_A);
  unpair();
}

section("an unbound self row binds to the first paired account");

{
  library.clearAll();
  unpair();
  const created = owner.forPanel();
  equal("an unpaired panel has no account", selfRow().account, null);
  const saved = save(created, "waiting-bytes", { name: "Waiting" });
  pair("201700000020@s.whatsapp.net", LID_Q);
  const bound = owner.forPanel();
  equal("the same row becomes self", bound.key, created.key);
  equal("it is bound to the paired LID", selfRow().account, LID_Q);
  equal("its sticker is still there", library.getSticker(bound, saved.sticker.id).name, "Waiting");
  unpair();
}

section("an unbound self yields when the paired account already has a library");

{
  library.clearAll();
  unpair();
  const unbound = owner.forPanel();
  const parked = save(unbound, "parked-bytes", { name: "Parked" });
  const user = await owner.forMessage(dm(LID_Q));
  const mine = save(user, "mine-bytes", { name: "Mine" });
  pair("201700000021@s.whatsapp.net", LID_Q);
  const panel = owner.forPanel();
  equal("the existing account becomes the panel", panel.key, user.key);
  equal("the panel shows that library", library.getSticker(panel, mine.sticker.id).name, "Mine");
  equal(
    "the panel does not show the unbound library",
    codeOf(() => library.getSticker(panel, parked.sticker.id)),
    "NOT_FOUND",
  );
  const parkedRow = db
    .prepare("SELECT kind, account FROM sticker_owners WHERE id = ?")
    .get(unbound.key);
  equal("the old self row is kept as a user", parkedRow.kind, "user");
  equal("the old self row has no account", parkedRow.account, null);
  equal(
    "the parked sticker is still stored under its id",
    library.getSticker(unbound, parked.sticker.id).name,
    "Parked",
  );
  unpair();
}

section("a phone-bound self follows its pairing once the credentials gain a lid");

{
  library.clearAll();
  pair("201700000030:4@s.whatsapp.net");
  const phonePanel = owner.forPanel();
  const saved = save(phonePanel, "phone-bound", { name: "PhoneBound" });
  const stray = await owner.forMessage(dm("565656565656@lid"));
  const strayBytes = save(stray, "stray-bytes", { name: "Stray" });
  // Baileys fills in me.lid for a session paired before it carried one.
  pair("201700000030:4@s.whatsapp.net", "565656565656:4@lid");
  const lidPanel = owner.forPanel();
  equal("the panel keeps its library", lidPanel.key, phonePanel.key);
  equal("the panel moved onto the LID", selfRow().account, "565656565656@lid");
  equal(
    "the panel still has its sticker",
    library.getSticker(lidPanel, saved.sticker.id).name,
    "PhoneBound",
  );
  equal(
    "the paired LID is the panel",
    (await owner.forMessage(dm("565656565656@lid"))).key,
    lidPanel.key,
  );
  const strayRow = db
    .prepare("SELECT kind, account FROM sticker_owners WHERE id = ?")
    .get(stray.key);
  equal("a stray row on that LID is unbound", strayRow.account, null);
  equal(
    "the stray sticker is still stored",
    library.getSticker(stray, strayBytes.sticker.id).name,
    "Stray",
  );
  equal(
    "the panel does not show the stray sticker",
    codeOf(() => library.getSticker(lidPanel, strayBytes.sticker.id)),
    "NOT_FOUND",
  );
  unpair();
}

section("a phone-bound self does not follow a different phone");

{
  library.clearAll();
  pair("201700000031@s.whatsapp.net");
  const phonePanel = owner.forPanel();
  const saved = save(phonePanel, "first-phone", { name: "FirstPhone" });
  pair("201700000032@s.whatsapp.net", "575757575757@lid");
  const otherPanel = owner.forPanel();
  ok("another phone gets another library", otherPanel.key !== phonePanel.key);
  equal("that library is empty", library.listStickers(otherPanel).total, 0);
  equal(
    "it cannot read the first phone's sticker",
    codeOf(() => library.getSticker(otherPanel, saved.sticker.id)),
    "NOT_FOUND",
  );
  const old = db
    .prepare("SELECT kind, account FROM sticker_owners WHERE id = ?")
    .get(phonePanel.key);
  equal("the first phone's library became a user row", old.kind, "user");
  equal("it keeps its phone account", old.account, "201700000031@s.whatsapp.net");
  unpair();
}

section("unlink deletes owner rows and the next pairing starts empty");

{
  library.clearAll();
  pair("201700000040@s.whatsapp.net", "575757575757@lid");
  const first = owner.forPanel();
  const saved = save(first, "doomed-bytes", { name: "Doomed" });
  const pack = library.createPack(first, "Doomed");
  library.addToPack(first, pack.id, [saved.sticker.id]);
  ok("owners exist before unlink", countOf("sticker_owners") > 0);
  const epoch = library.epoch();
  library.clearAll();
  equal("the epoch still advances", library.epoch(), epoch + 1);
  equal("stickers are empty", countOf("stickers"), 0);
  equal("packs are empty", countOf("sticker_packs"), 0);
  equal("pack items are empty", countOf("sticker_pack_items"), 0);
  equal("owners are empty", countOf("sticker_owners"), 0);

  const same = owner.forPanel();
  ok("re-pairing the same account mints a new id", same.key !== first.key);
  equal("that library is empty", library.listStickers(same).total, 0);
  equal("that account has no packs", library.listPacks(same).length, 0);

  library.clearAll();
  pair("201700000041@s.whatsapp.net", "585858585858@lid");
  const other = owner.forPanel();
  equal("another account also starts empty", library.listStickers(other).total, 0);
  equal("another account has no packs", library.listPacks(other).length, 0);
  equal("owners after the fresh pair", countOf("sticker_owners"), 1);
  unpair();
}

section("an upload belongs to one owner id");

{
  const media = {
    sniff() {
      return { kind: "image", mime: "image/jpeg", ext: "jpg" };
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
  const a = await owner.forMessage(dm("595959595959@lid"));
  const b = await owner.forMessage(dm("606060606060@lid"));
  const saved = await uploads.acceptStream(a, Readable.from([jpeg]), {
    filename: "a.jpg",
    media,
  });
  ok("the owner can read the upload", uploads.get(a, saved.uploadId)?.path);
  equal("another owner cannot", uploads.get(b, saved.uploadId), null);
  const pack = library.createPack(a, "Uploads");
  equal(
    "a job for the other owner cannot use the pack",
    codeOf(() => studio.createFromBuffer({ owner: b, packId: pack.id, buffer: Buffer.from("x") })),
    "PACK_NOT_FOUND",
  );
}

finish();

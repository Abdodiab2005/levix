import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { equal, finish, ok, require, section, useTempDataDir } from "./harness.mjs";

const dir = useTempDataDir("sticker-commands");
const bin = require("ffmpeg-static");
let downloads = 0;
require("./src/utils/geminiMedia.cjs").downloadMedia = async (_download, media) => {
  downloads++;
  return media.__bytes;
};

const settings = require("./src/config/settings.cjs");
const runtimeConfig = require("./src/config/runtime-config.cjs");
const { db } = require("./src/db/db.cjs");
const library = require("./src/stickers/library.cjs");
const owner = require("./src/stickers/owner.cjs");
const studio = require("./src/stickers/studio.cjs");
const media = require("./src/stickers/media.cjs");
const webpModule = require("./src/stickers/webp.cjs");
const jobs = require("./src/stickers/jobs.cjs");
const { countLabel } = require("./src/utils/stickerBot.cjs");
const limits = require("./src/stickers/limits.cjs");
const defaults = require("./src/config/defaults.cjs");
const { withLang } = require("./src/utils/i18n.cjs");
const { userMessage, StickerError } = require("./src/stickers/errors.cjs");
const { loadCommands, getCommandCatalog, handleCommand } = await import(
  "../src/handlers/command.handler.js"
);

settings.set("bot_min_delay_ms", 0);
settings.set("bot_max_delay_ms", 0);
settings.set("bot_language", "en");
await loadCommands();

function make(name, args) {
  const file = join(dir, name);
  const result = spawnSync(bin, ["-hide_banner", "-loglevel", "error", "-y", ...args, file]);
  if (result.status) throw new Error(`${name}: ${result.stderr}`);
  return readFileSync(file);
}
const png = make("red.png", ["-f", "lavfi", "-i", "color=c=red:s=32x32:d=1", "-frames:v", "1"]);
const greenPng = make("green.png", [
  "-f",
  "lavfi",
  "-i",
  "color=c=green:s=32x32:d=1",
  "-frames:v",
  "1",
]);
const video = make("move.mp4", [
  "-f",
  "lavfi",
  "-i",
  "testsrc=s=32x32:r=5:d=1",
  "-t",
  "1",
  "-c:v",
  "mpeg4",
]);
const longVideo = make("long.mp4", [
  "-f",
  "lavfi",
  "-i",
  "testsrc=s=32x32:r=2:d=11",
  "-t",
  "11",
  "-c:v",
  "mpeg4",
]);
const webp = make("red.webp", [
  "-f",
  "lavfi",
  "-i",
  "color=c=red:s=32x32:d=1",
  "-frames:v",
  "1",
  "-c:v",
  "libwebp",
]);
const greenWebp = make("green.webp", [
  "-f",
  "lavfi",
  "-i",
  "color=c=green:s=32x32:d=1",
  "-frames:v",
  "1",
  "-c:v",
  "libwebp",
]);
const animated = make("move.webp", [
  "-f",
  "lavfi",
  "-i",
  "testsrc=s=32x32:r=5:d=1",
  "-t",
  "1",
  "-c:v",
  "libwebp_anim",
  "-loop",
  "0",
]);
const SELF = "201999999999@s.whatsapp.net";
const OTHER = "201555555555@s.whatsapp.net";

function mediaMessage(type, bytes, extra = {}) {
  return {
    [`${type}Message`]: {
      __bytes: bytes,
      mimetype: type === "video" ? "video/mp4" : type === "sticker" ? "image/webp" : "image/png",
      fileLength: bytes.length,
      ...extra,
    },
  };
}
function sock() {
  const sent = [];
  return {
    sent,
    user: { id: SELF },
    async sendMessage(jid, content) {
      sent.push(content);
      return { key: { id: `sent${sent.length}`, remoteJid: jid, fromMe: true } };
    },
    async sendPresenceUpdate() {},
    async presenceSubscribe() {},
  };
}
async function run(text, { quoted, attached, fromMe = true, jid = SELF } = {}) {
  const socket = sock();
  const message = attached
    ? { ...attached, [Object.keys(attached)[0]]: { ...Object.values(attached)[0], caption: text } }
    : quoted
      ? { extendedTextMessage: { text, contextInfo: { quotedMessage: quoted } } }
      : { conversation: text };
  const msg = { key: { remoteJid: jid, fromMe, id: `in${Math.random()}` }, message };
  await handleCommand(socket, msg, text);
  return socket.sent;
}
const lines = (sent) => sent.map((item) => item.text).filter(Boolean);
const lastLine = (sent) => lines(sent).at(-1) || "";
const count = (sent, key) => sent.filter((item) => item[key]).length;

section("catalog, permissions, aliases and syntax");
{
  const catalog = getCommandCatalog();
  const allAliases = new Map();
  for (const command of catalog) {
    for (const alias of [command.name, ...command.aliases]) {
      const names = allAliases.get(alias) || new Set();
      names.add(command.name);
      allAliases.set(alias, names);
    }
  }
  for (const name of ["sticker", "toimage", "pack", "packs", "stickers"]) {
    const command = catalog.find((item) => item.name === name);
    ok(`${name} catalog entry`, !!command);
    equal(`${name} default permission`, command.defaultPermission, "MEMBERS");
    equal(`${name} shipped permission`, defaults.command_permissions[name], "MEMBERS");
    ok(
      `${name} bilingual docs`,
      !!command.descriptions.en &&
        !!command.descriptions.ar &&
        !!command.usages.en &&
        !!command.usages.ar,
    );
    for (const alias of [name, ...command.aliases])
      equal(`${alias} has one owner`, allAliases.get(alias).size, 1);
    for (const lang of ["en", "ar"]) {
      ok(
        `${name} ${lang} usage uses lines`,
        command.usages[lang].split("\n").every((line) => line.startsWith(name)),
      );
      ok(`${name} ${lang} usage has no joined variants`, !/[;؛]/.test(command.usages[lang]));
    }
  }
  const pack = require("./src/commands/pack.cjs");
  for (const word of Object.values(limits.PACK_SUBCOMMANDS).flat())
    ok(`${word} is syntax`, pack.keywords.includes(word));
}

section("sticker and pack counts agree in both languages");
for (const [n, enSticker, arSticker, enPack, arPack] of [
  [1, "1 sticker", "ملصق واحد", "1 pack", "حزمة واحدة"],
  [2, "2 stickers", "ملصقان", "2 packs", "حزمتان"],
  [5, "5 stickers", "5 ملصقات", "5 packs", "5 حزم"],
  [11, "11 stickers", "11 ملصقًا", "11 packs", "11 حزمة"],
]) {
  equal(
    `English ${n} stickers`,
    withLang("en", () => countLabel(n)),
    enSticker,
  );
  equal(
    `Arabic ${n} stickers`,
    withLang("ar", () => countLabel(n)),
    arSticker,
  );
  equal(
    `English ${n} packs`,
    withLang("en", () => countLabel(n, "pack")),
    enPack,
  );
  equal(
    `Arabic ${n} packs`,
    withLang("ar", () => countLabel(n, "pack")),
    arPack,
  );
}

section("sticker creation, ownership and safe errors");
{
  const submit = jobs.submit;
  let submitted = 0;
  jobs.submit = (...args) => {
    submitted++;
    return submit(...args);
  };
  const image = await run("!sticker crop", { attached: mediaMessage("image", png) });
  equal("image sends one sticker", count(image, "sticker"), 1);
  equal("save path submits one conversion job", submitted, 1);
  equal("image appears for panel owner", library.listStickers(owner.forPanel()).total, 1);
  const record = library.listStickers(owner.forPanel()).items[0];
  equal("source is bot command", record.source, "BOT_COMMAND");
  const taggedByBot = image.find((item) => item.sticker)?.sticker;
  ok("bot send has EXIF", !!webpModule.readMetadata(taggedByBot));
  ok(
    "bot save has no EXIF",
    !webpModule.readMetadata(library.readStickerFile(owner.forPanel(), record.id)),
  );
  ok(
    "pack reply to sent sticker dedupes",
    /Already in your library/.test(
      lastLine(await run("!pack memes", { quoted: mediaMessage("sticker", taggedByBot) })),
    ),
  );
  equal(
    "pack association uses original id",
    library.getPack(owner.forPanel(), library.findPackByName(owner.forPanel(), "memes").id).items[0]
      .id,
    record.id,
  );
  const differentlyTagged = media.withStickerMetadata(
    library.readStickerFile(owner.forPanel(), record.id),
    { packName: "unrelated name", publisher: "Someone" },
  );
  ok(
    "remove ignores EXIF pack name",
    /remains in your library/.test(
      lastLine(
        await run("!pack remove memes", { quoted: mediaMessage("sticker", differentlyTagged) }),
      ),
    ),
  );
  const moving = await run("!sticker", { quoted: mediaMessage("video", video) });
  equal("video sends a sticker", count(moving, "sticker"), 1);
  const other = await run("!sticker", {
    attached: mediaMessage("image", png),
    fromMe: false,
    jid: OTHER,
  });
  equal("other sender gets a sticker", count(other, "sticker"), 1);
  equal(
    "other library is separate",
    library.listStickers(owner.forMessage({ key: { remoteJid: OTHER, fromMe: false } })).total,
    1,
  );
  equal("self still has only two", library.listStickers(owner.forPanel()).total, 2);

  equal(
    "no media localized",
    lastLine(await run("!sticker")),
    await withLang("en", () => userMessage(new StickerError("NO_MEDIA"))),
  );
  equal(
    "unsupported localized",
    lastLine(
      await run("!sticker", {
        attached: mediaMessage("document", Buffer.from("garbage"), { mimetype: "image/png" }),
      }),
    ),
    await withLang("en", () => userMessage(new StickerError("UNSUPPORTED_TYPE"))),
  );
  const beforeUnsupported = downloads;
  for (const [type, mime] of [
    ["audio", "audio/ogg"],
    ["document", "application/pdf"],
  ]) {
    equal(
      `${type} rejected`,
      lastLine(
        await run("!sticker", {
          attached: mediaMessage(type, Buffer.from("file"), { mimetype: mime }),
        }),
      ),
      await withLang("en", () => userMessage(new StickerError("UNSUPPORTED_TYPE"))),
    );
  }
  equal("audio and nonmedia documents rejected before download", downloads, beforeUnsupported);
  const before = downloads;
  const big = mediaMessage("image", png, { fileLength: limits.WHATSAPP_MEDIA_MAX_BYTES + 1 });
  equal(
    "oversize reply",
    lastLine(await run("!sticker", { attached: big })),
    await withLang("en", () =>
      userMessage(new StickerError("TOO_LARGE", { limitBytes: limits.WHATSAPP_MEDIA_MAX_BYTES })),
    ),
  );
  equal("oversize rejected before download", downloads, before);
  ok(
    "long video rejected",
    /too long/.test(lastLine(await run("!sticker", { quoted: mediaMessage("video", longVideo) }))),
  );

  const original = studio.createFromBuffer;
  for (const code of ["BUSY", "CONVERSION_FAILED"]) {
    studio.createFromBuffer = () => {
      throw new StickerError(code, {}, { cause: new Error("secret ffmpeg stderr") });
    };
    const reply = lastLine(await run("!sticker", { attached: mediaMessage("image", png) }));
    equal(
      `${code} localized`,
      reply,
      await withLang("en", () => userMessage(new StickerError(code))),
    );
    ok(`${code} hides internals`, !/secret|ffmpeg|stack/i.test(reply));
  }
  studio.createFromBuffer = original;
  settings.set("sticker_library_limit", 1);
  submitted = 0;
  const full = await run("!sticker", { attached: mediaMessage("image", greenPng) });
  equal("full library still sends", count(full, "sticker"), 1);
  equal("full library submits one conversion job", submitted, 1);
  equal("full library does not save", library.listStickers(owner.forPanel()).total, 2);
  settings.set("sticker_library_limit", 1000);
  jobs.submit = submit;
  settings.set("bot_language", "ar");
  equal(
    "Arabic no-media reply",
    lastLine(await run("!sticker")),
    await withLang("ar", () => userMessage(new StickerError("NO_MEDIA"))),
  );
  settings.set("bot_language", "en");
}

section("toimage and the sticker shortcut");
{
  const staticQuote = mediaMessage("sticker", webp);
  const animatedQuote = mediaMessage("sticker", animated);
  ok("usage for nonsticker", /Reply to a sticker/.test(lastLine(await run("!toimg"))));
  equal("static PNG", count(await run("!toimage", { quoted: staticQuote }), "image"), 1);
  const doc = await run("!toimage doc", { quoted: staticQuote });
  equal("document PNG", count(doc, "document"), 1);
  equal("document MIME", doc.find((item) => item.document)?.mimetype, "image/png");
  const frame = await run("!toimage", { quoted: animatedQuote });
  ok(
    "animated first frame explained",
    /First frame/.test(frame.find((item) => item.image)?.caption || ""),
  );
  const gif = await run("!toimage gif", { quoted: animatedQuote });
  ok(
    "gif playback video",
    gif.some((item) => item.video && item.gifPlayback),
  );
  const staticGif = await run("!toimage gif", { quoted: staticQuote });
  equal("static gif sends PNG", count(staticGif, "image"), 1);
  ok(
    "static gif explains fallback",
    /not animated/.test(staticGif.find((item) => item.image)?.caption || ""),
  );
  equal(
    "!sticker reply to sticker uses toimage",
    count(await run("!sticker", { quoted: staticQuote }), "image"),
    1,
  );
  settings.set("bot_language", "ar");
  ok(
    "Arabic animated caption",
    /الإطار الأول/.test(
      (await run("!صورة ملف", { quoted: animatedQuote })).find((item) => item.document)?.caption ||
        "",
    ),
  );
  settings.set("bot_language", "en");
}

section("pack grammar, dedupe and retention");
{
  const quote = mediaMessage("sticker", webp);
  for (const [text, expected] of [
    ["!pack create funny cats", "funny cats"],
    ["!حزمة إنشاء قطط مضحكة", "قطط مضحكة"],
  ]) {
    ok(`${text} created`, /Created|أُنشئت/.test(lastLine(await run(text))));
    ok(`${expected} exists`, !!library.findPackByName(owner.forPanel(), expected));
  }
  ok("auto show", /0 stickers/.test(lastLine(await run("!pack funny cats"))));
  ok("show variant", /0 stickers/.test(lastLine(await run("!pack show funny cats"))));
  settings.set("bot_language", "ar");
  ok("Arabic show", /0 ملصق/.test(lastLine(await run("!حزمة عرض قطط مضحكة"))));
  settings.set("bot_language", "en");
  ok(
    "add quoted sticker",
    /Saved sticker/.test(lastLine(await run("!pack funny cats", { quoted: quote }))),
  );
  ok(
    "dedupe reply",
    /Already in your library/.test(lastLine(await run("!pack add funny cats", { quoted: quote }))),
  );
  settings.set("bot_language", "ar");
  ok("Arabic add", /أُضيف/.test(lastLine(await run("!حزمة إضافة قطط مضحكة", { quoted: quote }))));
  ok("Arabic remove", /بقي/.test(lastLine(await run("!حزمة إزالة قطط مضحكة", { quoted: quote }))));
  settings.set("bot_language", "en");
  equal(
    "sticker in two packs",
    library.listStickers(owner.forPanel(), {
      pack: library.findPackByName(owner.forPanel(), "funny cats").id,
    }).total,
    1,
  );
  const sentFromLibrary = (await run("!stickers pack funny cats")).find(
    (item) => item.sticker,
  )?.sticker;
  ok(
    "remove matches metadata added for sending",
    /remains in your library/.test(
      lastLine(
        await run("!pack remove funny cats", { quoted: mediaMessage("sticker", sentFromLibrary) }),
      ),
    ),
  );
  await run("!pack add funny cats", { quoted: quote });
  ok(
    "remove association",
    /remains in your library/.test(
      lastLine(await run("!pack remove funny cats", { quoted: quote })),
    ),
  );
  equal("removed from pack", library.findPackByName(owner.forPanel(), "funny cats").count, 0);
  ok("sticker stays", library.listStickers(owner.forPanel()).total >= 3);
  ok(
    "rename with bar",
    /Renamed/.test(lastLine(await run("!pack rename funny cats | silly cats"))),
  );
  await run("!pack create old");
  ok("rename two words", /Renamed/.test(lastLine(await run("!pack rename old fresh"))));
  settings.set("bot_language", "ar");
  ok("Arabic rename", /أُعيدت/.test(lastLine(await run("!حزمة تسمية قطط مضحكة | قطة"))));
  settings.set("bot_language", "en");
  ok("delete keeps stickers", /remain/.test(lastLine(await run("!pack delete fresh"))));
  settings.set("bot_language", "ar");
  ok("Arabic delete", /بقيت/.test(lastLine(await run("!حزمة حذف قطة"))));
  settings.set("bot_language", "en");
  ok("missing pack", /no pack/.test(lastLine(await run("!pack show absent"))));

  const foreign = media.withStickerMetadata(greenWebp, {
    packName: "Another app",
    publisher: "Other",
  });
  ok(
    "foreign sticker saved",
    /Saved sticker/.test(
      lastLine(await run("!pack foreign", { quoted: mediaMessage("sticker", foreign) })),
    ),
  );
  const foreignId = library.getPack(
    owner.forPanel(),
    library.findPackByName(owner.forPanel(), "foreign").id,
  ).items[0].id;
  const savedForeign = library.readStickerFile(owner.forPanel(), foreignId);
  equal("foreign EXIF is removed from storage", webpModule.readMetadata(savedForeign), null);
  ok("foreign bytes canonicalized", savedForeign.equals(media.canonicalWebp(greenWebp)));

  ok("Latin Create ignores case", /Created/.test(lastLine(await run("!pack Create Mixed"))));
  ok(
    "Latin ADD ignores case",
    /Already in your library/.test(lastLine(await run("!pack ADD Mixed", { quoted: quote }))),
  );
  ok("Latin SHOW ignores case", /1 sticker/.test(lastLine(await run("!pack SHOW Mixed"))));
  ok(
    "Latin REMOVE ignores case",
    /remains in your library/.test(lastLine(await run("!pack REMOVE Mixed", { quoted: quote }))),
  );
  ok("Latin DELETE ignores case", /Deleted/.test(lastLine(await run("!pack DELETE Mixed"))));

  const broken = mediaMessage("image", Buffer.from("not an image"));
  ok(
    "failed new-pack save replies with error",
    /file type/.test(lastLine(await run("!pack doomed", { quoted: broken }))),
  );
  equal(
    "failed new-pack save rolls back empty pack",
    library.findPackByName(owner.forPanel(), "doomed"),
    null,
  );
  await run("!pack create stable");
  await run("!pack stable", { quoted: broken });
  ok("failed save preserves existing pack", !!library.findPackByName(owner.forPanel(), "stable"));
}

section("packs and sticker pages");
{
  const who = owner.forPanel();
  const oldBytes = make("old.webp", [
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=32x32:d=1",
    "-frames:v",
    "1",
    "-c:v",
    "libwebp",
  ]);
  const old = library.saveSticker(who, {
    buffer: oldBytes,
    thumbBuffer: oldBytes,
    width: 32,
    height: 32,
    animated: false,
    durationMs: 0,
    sourceMime: "image/webp",
    source: "BOT_COMMAND",
    name: "old",
  }).sticker;
  db.prepare("UPDATE stickers SET created_at = ?, last_used_at = NULL WHERE id = ?").run(
    Date.now() - 40 * 24 * 60 * 60 * 1000,
    old.id,
  );
  equal(
    "30-day filter excludes old sticker",
    library.listStickers(who, { filter: "recent" }).items.some((item) => item.id === old.id),
    false,
  );
  const allBeforePaging = await run("!stickers");
  ok(
    "default recency includes old sticker",
    count(allBeforePaging, "sticker") === library.listStickers(who).total,
  );
  for (let i = 0; i < 7; i++) {
    const bytes = make(`fixture-${i}.webp`, [
      "-f",
      "lavfi",
      "-i",
      `color=c=0x${(0x111111 * (i + 1)).toString(16).padStart(6, "0")}:s=32x32:d=1`,
      "-frames:v",
      "1",
      "-c:v",
      "libwebp",
    ]);
    library.saveSticker(who, {
      buffer: bytes,
      thumbBuffer: bytes,
      width: 32,
      height: 32,
      animated: false,
      durationMs: 0,
      sourceMime: "image/webp",
      source: "BOT_COMMAND",
      name: `test ${i}`,
    });
  }
  const packs = await run("!packs");
  ok("pack list includes total", /Library:/.test(lastLine(packs)));
  const first = await run("!stickers");
  equal("first page cap", count(first, "sticker"), limits.BOT_PAGE_SIZE);
  ok("first page header", /page 1\//.test(lines(first)[0]));
  ok("first page offers a next page", /!stickers 2 for more/.test(lines(first)[0]));
  const second = await run("!stickers 2");
  ok("second page cap", count(second, "sticker") <= limits.BOT_PAGE_SIZE);
  const finalPage = Math.ceil(library.listStickers(who).total / limits.BOT_PAGE_SIZE);
  ok(
    "last page has no next-page hint",
    !/for more/.test(lines(await run(`!stickers ${finalPage}`))[0]),
  );
  const other = await run("!stickers", { fromMe: false, jid: OTHER });
  ok("other sender does not see self's page", count(other, "sticker") <= 1);
  settings.set("bot_language", "ar");
  ok("Arabic packs", /حزمك/.test(lastLine(await run("!حزم"))));
  ok("Arabic stickers header", /الصفحة/.test(lines(await run("!ملصقاتي الأحدث"))[0]));
  settings.set("bot_language", "en");
}

section("command hints use the live prefix");
runtimeConfig.setPrefix("#");
try {
  ok("pack usage uses live prefix", /#pack <name>/.test(lastLine(await run("#pack"))));
  ok("pack show uses live prefix", /#stickers pack/.test(lastLine(await run("#pack show stable"))));
  ok(
    "packs empty state uses live prefix",
    /#pack <name>/.test(lastLine(await run("#packs", { fromMe: false, jid: OTHER }))),
  );
  ok("toimage usage uses live prefix", /#toimage/.test(lastLine(await run("#toimage"))));
  ok(
    "animated caption uses live prefix",
    /#toimage gif/.test(
      (await run("#toimage", { quoted: mediaMessage("sticker", animated) })).find(
        (item) => item.image,
      )?.caption || "",
    ),
  );
  ok(
    "stickers page hint uses live prefix",
    /#stickers 2 for more/.test(lines(await run("#stickers"))[0]),
  );
  ok(
    "stickers empty state uses live prefix",
    /#sticker/.test(lastLine(await run("#stickers favorites"))),
  );
} finally {
  runtimeConfig.setPrefix("!");
}

finish();

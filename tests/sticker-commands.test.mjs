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
const library = require("./src/stickers/library.cjs");
const owner = require("./src/stickers/owner.cjs");
const studio = require("./src/stickers/studio.cjs");
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
  }
  const pack = require("./src/commands/pack.cjs");
  for (const word of Object.values(limits.PACK_SUBCOMMANDS).flat())
    ok(`${word} is syntax`, pack.keywords.includes(word));
}

section("sticker creation, ownership and safe errors");
{
  const image = await run("!sticker crop", { attached: mediaMessage("image", png) });
  equal("image sends one sticker", count(image, "sticker"), 1);
  equal("image appears for panel owner", library.listStickers(owner.forPanel()).total, 1);
  const record = library.listStickers(owner.forPanel()).items[0];
  equal("source is bot command", record.source, "BOT_COMMAND");
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
    lastLine(await run("!sticker", { attached: mediaMessage("document", Buffer.from("garbage")) })),
    await withLang("en", () => userMessage(new StickerError("UNSUPPORTED_TYPE"))),
  );
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
  const full = await run("!sticker", { attached: mediaMessage("image", greenPng) });
  equal("full library still sends", count(full, "sticker"), 1);
  equal("full library does not save", library.listStickers(owner.forPanel()).total, 2);
  settings.set("sticker_library_limit", 1000);
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
  equal(
    "static gif reports invalid options",
    lastLine(await run("!toimage gif", { quoted: staticQuote })),
    await withLang("en", () => userMessage(new StickerError("INVALID_OPTIONS"))),
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
}

section("packs and sticker pages");
{
  const who = owner.forPanel();
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
  const second = await run("!stickers 2");
  ok("second page cap", count(second, "sticker") <= limits.BOT_PAGE_SIZE);
  const other = await run("!stickers", { fromMe: false, jid: OTHER });
  ok("other sender does not see self's page", count(other, "sticker") <= 1);
  settings.set("bot_language", "ar");
  ok("Arabic packs", /حزمك/.test(lastLine(await run("!حزم"))));
  ok("Arabic stickers header", /الصفحة/.test(lines(await run("!ملصقاتي الأحدث"))[0]));
  settings.set("bot_language", "en");
}

finish();

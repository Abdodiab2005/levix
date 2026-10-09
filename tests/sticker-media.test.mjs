import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { equal, finish, ok, require, section, throws, useTempDataDir } from "./harness.mjs";

const dir = useTempDataDir("sticker-media");
const bin = require("ffmpeg-static");
const media = require("./src/stickers/media.cjs");
const webp = require("./src/stickers/webp.cjs");
const { normalizeOptions, placement } = require("./src/stickers/options.cjs");
const L = require("./src/stickers/limits.cjs");
const { createQueue } = require("./src/stickers/jobs.cjs");
const { run: runFfmpeg } = require("./src/stickers/ffmpeg.cjs");
const { Readable } = await import("node:stream");
const fs = require("node:fs");

function make(name, args) {
  const file = join(dir, name);
  const r = spawnSync(bin, ["-hide_banner", "-loglevel", "error", "-y", ...args, file]);
  if (r.status !== 0) throw new Error(`${name}: ${r.stderr}`);
  return { file, bytes: readFileSync(file) };
}
const png = make("square.png", ["-f", "lavfi", "-i", "color=c=red:s=64x32:d=1", "-frames:v", "1"]);
const jpg = make("square.jpg", ["-f", "lavfi", "-i", "color=c=red:s=64x32:d=1", "-frames:v", "1"]);
const gif = make("move.gif", ["-f", "lavfi", "-i", "testsrc=s=64x64:r=5:d=1", "-t", "1"]);
const mp4 = make("move.mp4", [
  "-f",
  "lavfi",
  "-i",
  "testsrc=s=64x64:r=5:d=1",
  "-t",
  "1",
  "-c:v",
  "mpeg4",
]);
const animatedWebp = make("move.webp", [
  "-f",
  "lavfi",
  "-i",
  "testsrc=s=64x64:r=5:d=1",
  "-t",
  "1",
  "-c:v",
  "libwebp_anim",
  "-loop",
  "0",
]);
const transparentPng = make("transparent.png", [
  "-f",
  "lavfi",
  "-i",
  "color=c=red@0.0:s=32x32:d=1,format=rgba",
  "-frames:v",
  "1",
]);
const lossyWebp = make("lossy.webp", [
  "-f",
  "lavfi",
  "-i",
  "color=c=red:s=32x32:d=1",
  "-frames:v",
  "1",
  "-c:v",
  "libwebp",
]);
const losslessWebp = make("lossless.webp", [
  "-f",
  "lavfi",
  "-i",
  "color=c=green:s=32x32:d=1",
  "-frames:v",
  "1",
  "-c:v",
  "libwebp",
  "-lossless",
  "1",
]);
const alphaWebp = make("alpha.webp", [
  "-f",
  "lavfi",
  "-i",
  "color=c=red@0.5:s=32x32:d=1,format=rgba",
  "-frames:v",
  "1",
  "-c:v",
  "libwebp",
  "-lossless",
  "0",
]);
const redFrame = make("red.webp", [
  "-f",
  "lavfi",
  "-i",
  "color=c=red:s=4x4:d=1",
  "-frames:v",
  "1",
  "-c:v",
  "libwebp",
  "-lossless",
  "1",
]);
const blueFrame = make("blue.webp", [
  "-f",
  "lavfi",
  "-i",
  "color=c=blue@0.5:s=2x2:d=1,format=rgba",
  "-frames:v",
  "1",
  "-c:v",
  "libwebp",
  "-lossless",
  "1",
]);
const opaqueBlueFrame = make("opaque-blue.webp", [
  "-f",
  "lavfi",
  "-i",
  "color=c=blue:s=2x2:d=1",
  "-frames:v",
  "1",
  "-c:v",
  "libwebp",
  "-lossless",
  "1",
]);
const longGif = make("long.gif", ["-f", "lavfi", "-i", "testsrc=s=64x64:r=10:d=3", "-t", "3"]);
const longMp4 = make("long.mp4", [
  "-f",
  "lavfi",
  "-i",
  "testsrc=s=64x64:r=10:d=3",
  "-t",
  "3",
  "-c:v",
  "mpeg4",
]);
const overlay = make("overlay.png", [
  "-f",
  "lavfi",
  "-i",
  "color=c=black@0:s=512x512:d=1,format=rgba,drawbox=x=0:y=0:w=20:h=20:color=magenta@1:t=fill:replace=1",
  "-frames:v",
  "1",
]);
section("magic and headers");
for (const [bytes, kind] of [
  [png.bytes, "image"],
  [jpg.bytes, "image"],
  [gif.bytes, "gif"],
  [mp4.bytes, "video"],
  [animatedWebp.bytes, "webp"],
])
  equal(`sniff ${kind}`, media.sniff(bytes)?.kind, kind);
for (const value of ["hello", "<html>", "#EXTM3U", "PK\x03\x04"])
  equal(`reject ${value.slice(0, 6)}`, media.sniff(Buffer.from(value)), null);
const huge = Buffer.from(png.bytes);
huge.writeUInt32BE(5000, 16);
const hugeFile = join(dir, "huge.png");
writeFileSync(hugeFile, huge);
try {
  await media.inspect(hugeFile, media.sniff(huge));
  ok("header size rejected", false);
} catch (e) {
  equal("header size rejected", e.code, "DIMENSIONS_TOO_LARGE");
}
section("graph");
const opts = normalizeOptions({
  fit: "cover",
  zoom: 2,
  panX: 1,
  panY: -1,
  rotate: 90,
  background: "#abcdef",
});
const graph = media.filterGraph(64, 32, opts);
const p = placement(64, 32, opts);
equal(
  "shared placement remains the geometry source",
  JSON.stringify(graph.placement),
  JSON.stringify(p),
);
ok(
  "visible source is cropped before scaling",
  graph.graph.includes(`crop=${graph.visible.width}:${graph.visible.height}`),
);
ok(
  "visible scale is bounded",
  graph.visible.scaledWidth <= 2048 && graph.visible.scaledHeight <= 2048,
);
ok(
  "visible offset",
  graph.graph.includes(`overlay=${graph.visible.overlayX}:${graph.visible.overlayY}`),
);
ok("background color", graph.graph.includes("0xabcdef"));
for (const height of [1, 8]) {
  const skinny = make(`skinny-${height}.png`, [
    "-f",
    "lavfi",
    "-i",
    `color=c=red:s=4096x${height}:d=1,format=rgb24`,
    "-frames:v",
    "1",
  ]);
  const options = normalizeOptions({ fit: "cover", zoom: 4 });
  const bounded = media.filterGraph(4096, height, options);
  const scale = /scale=(\d+):(\d+):flags=lanczos/.exec(bounded.graph);
  ok(
    `skinny ${height} small scale`,
    !!scale && Number(scale[1]) <= 2048 && Number(scale[2]) <= 2048,
  );
  ok(
    `skinny ${height} frame cap`,
    bounded.visible.scaledWidth <= 2048 && bounded.visible.scaledHeight <= 2048,
  );
  const result = await media.createSticker({
    inputPath: skinny.file,
    sniffed: media.sniff(skinny.bytes),
    options,
  });
  equal(`skinny ${height} output width`, media.describeWebp(result.buffer).width, 512);
  equal(`skinny ${height} output height`, media.describeWebp(result.buffer).height, 512);
}
const patterned = make("patterned.png", [
  "-f",
  "lavfi",
  "-i",
  "testsrc=s=96x64:d=1",
  "-frames:v",
  "1",
]);
async function renderGraph(graphText) {
  return (
    await runFfmpeg(
      [
        "-f",
        "png_pipe",
        "-protocol_whitelist",
        "file,pipe",
        "-i",
        patterned.file,
        "-filter_complex",
        graphText,
        "-map",
        "[out]",
        "-frames:v",
        "1",
        "-pix_fmt",
        "rgba",
        "-f",
        "rawvideo",
        "pipe:1",
      ],
      { maxOutputBytes: 2 * 1024 * 1024 },
    )
  ).buffer;
}
for (const [label, rawOptions] of [
  ["contain", { fit: "contain" }],
  ["cover", { fit: "cover" }],
  ["pan", { fit: "cover", zoom: 2, panX: 0.5, panY: -0.5 }],
  ["rotate", { fit: "cover", zoom: 2, panX: -0.5, rotate: 90 }],
]) {
  const options = normalizeOptions(rawOptions);
  const placed = placement(96, 64, options);
  const rotation =
    options.rotate === 90
      ? ",transpose=clock"
      : options.rotate === 270
        ? ",transpose=cclock"
        : options.rotate === 180
          ? ",hflip,vflip"
          : "";
  const oldGraph = `[0:v]format=rgba${rotation},scale=${placed.width}:${placed.height}:flags=lanczos[scaled];color=c=black@0.0:s=512x512:r=15,format=rgba[bg];[bg][scaled]overlay=${placed.x}:${placed.y}:shortest=1:format=auto[base];[base]format=rgba[out]`;
  const [before, after] = await Promise.all([
    renderGraph(oldGraph),
    renderGraph(media.filterGraph(96, 64, options).graph),
  ]);
  equal(`${label} rendered pixel count`, after.length, before.length);
  let biggestDifference = 0;
  for (let i = 0; i < after.length; i++)
    biggestDifference = Math.max(biggestDifference, Math.abs(after[i] - before[i]));
  ok(
    `${label} pixels match old graph`,
    biggestDifference <= 3,
    `max channel difference ${biggestDifference}`,
  );
}
const badOverlay = Buffer.from(png.bytes);
equal(
  "overlay validation",
  throws("overlay throws", () => media.validateOverlay(badOverlay))?.code,
  "INVALID_OPTIONS",
);
section("conversion");
const caps = await media.capabilities();
ok("webp encoder", caps.webp);
const staticResult = await media.createSticker({
  inputPath: png.file,
  sniffed: media.sniff(png.bytes),
  options: normalizeOptions(),
});
const staticMeta = media.describeWebp(staticResult.buffer);
equal("canvas width", staticMeta.width, 512);
equal("canvas height", staticMeta.height, 512);
ok("static target", staticResult.buffer.length < L.STATIC_TARGET_BYTES);
equal("static animation", staticResult.animated, false);
const alphaResult = await media.createSticker({
  inputPath: transparentPng.file,
  sniffed: media.sniff(transparentPng.bytes),
  options: normalizeOptions(),
});
ok("transparent input retains alpha flag", webp.parse(alphaResult.buffer).alpha);
function rgba(bytes, kind = "webp_pipe") {
  const r = spawnSync(
    bin,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      kind,
      "-i",
      "pipe:0",
      "-frames:v",
      "1",
      "-pix_fmt",
      "rgba",
      "-f",
      "rawvideo",
      "pipe:1",
    ],
    { input: bytes },
  );
  if (r.status !== 0) throw new Error(String(r.stderr));
  return r.stdout;
}
const colored = await media.createSticker({
  inputPath: png.file,
  sniffed: media.sniff(png.bytes),
  options: normalizeOptions({ background: "#123456" }),
});
const coloredPixel = rgba(colored.buffer);
ok(
  "background color rendered",
  Math.abs(coloredPixel[0] - 0x12) < 12 &&
    Math.abs(coloredPixel[1] - 0x34) < 12 &&
    Math.abs(coloredPixel[2] - 0x56) < 12,
);
const removed = await media.createSticker({
  inputPath: png.file,
  sniffed: media.sniff(png.bytes),
  options: normalizeOptions({ removeBackground: { mode: "plain", tolerance: 0.15 } }),
});
ok("plain background removal", webp.parse(removed.buffer).alpha);
const removedPixel = rgba(removed.buffer);
ok("plain removal pixel alpha", removedPixel[(256 * 512 + 256) * 4 + 3] < 100);
const pngOut = await media.toPng(staticResult.buffer);
ok("PNG export", media.sniff(pngOut.buffer)?.mime === "image/png");
equal("PNG animation flag", pngOut.animated, false);
const thumb = await media.makeThumbnail(staticResult.buffer);
equal("thumbnail size", media.describeWebp(thumb).width, L.THUMB_SIZE);
const tagged = media.withStickerMetadata(staticResult.buffer, {
  packName: "A",
  publisher: "B",
  emojis: ["🙂"],
});
equal("EXIF roundtrip", webp.readMetadata(tagged)["sticker-pack-name"], "A");
const gifResult = await media.createSticker({
  inputPath: gif.file,
  sniffed: media.sniff(gif.bytes),
  options: normalizeOptions(),
});
ok("GIF animation", gifResult.animated);
ok("GIF duration limit", gifResult.durationMs <= 10000);
const mp4Result = await media.createSticker({
  inputPath: mp4.file,
  sniffed: media.sniff(mp4.bytes),
  options: normalizeOptions({ trim: { start: 0, duration: 0.5 } }),
});
ok("MP4 animation", mp4Result.animated);
ok("trim applied", mp4Result.durationMs <= 500);
let videoReads = 0;
const originalReadFile = fs.promises.readFile;
fs.promises.readFile = async (...args) => {
  if (args[0] === mp4.file) videoReads++;
  return originalReadFile(...args);
};
try {
  await media.inspect(mp4.file, media.sniff(mp4.bytes));
} finally {
  fs.promises.readFile = originalReadFile;
}
equal("video probe does not read whole file", videoReads, 0);
section("moving overlay");
for (const source of [longGif, longMp4]) {
  const sniffed = media.sniff(source.bytes);
  const plain = await media.createSticker({
    inputPath: source.file,
    sniffed,
    options: normalizeOptions(),
  });
  const layered = await media.createSticker({
    inputPath: source.file,
    sniffed,
    options: normalizeOptions(),
    overlayPng: overlay.bytes,
  });
  const kind = sniffed.kind;
  ok(`${kind} overlay stays animated`, layered.animated);
  equal(
    `${kind} overlay frame count`,
    media.describeWebp(layered.buffer).frames,
    media.describeWebp(plain.buffer).frames,
  );
  const frames = media.compositeWebpFrames(layered.buffer);
  let middle;
  const middleIndex = Math.floor(media.describeWebp(layered.buffer).frames / 2);
  for (let i = 0; i <= middleIndex; i++) middle = (await frames.next()).value;
  ok(`${kind} overlay reaches middle frame`, middle[0] > 90 && middle[2] > 90 && middle[1] < 90);
  await frames.return();
}
const staticLayered = await media.createSticker({
  inputPath: png.file,
  sniffed: media.sniff(png.bytes),
  options: normalizeOptions(),
  overlayPng: overlay.bytes,
});
equal("static overlay frame count", media.describeWebp(staticLayered.buffer).frames, 1);
const rawPlain = await media.createSticker({
  inputPath: animatedWebp.file,
  sniffed: media.sniff(animatedWebp.bytes),
  options: normalizeOptions(),
});
const rawLayered = await media.createSticker({
  inputPath: animatedWebp.file,
  sniffed: media.sniff(animatedWebp.bytes),
  options: normalizeOptions(),
  overlayPng: overlay.bytes,
});
ok("animated WebP overlay stays animated", rawLayered.animated);
equal(
  "animated WebP overlay frame count",
  media.describeWebp(rawLayered.buffer).frames,
  media.describeWebp(rawPlain.buffer).frames,
);
const webpInput = await media.createSticker({
  inputPath: animatedWebp.file,
  sniffed: media.sniff(animatedWebp.bytes),
  options: normalizeOptions(),
});
ok("animated WebP input", webpInput.animated);
ok("animated WebP frames", media.describeWebp(webpInput.buffer).frames > 1);
equal(
  "lossless EXIF",
  webp.readMetadata(
    media.withStickerMetadata(losslessWebp.bytes, { packName: "L", publisher: "P" }),
  )["sticker-pack-name"],
  "L",
);
equal("VP8 simple fixture", webp.parse(lossyWebp.bytes).chunks[0].type, "VP8 ");
const vp8Tagged = media.withStickerMetadata(lossyWebp.bytes, { packName: "V", publisher: "P" });
equal("VP8 EXIF", webp.readMetadata(vp8Tagged)["sticker-pack-name"], "V");
ok("tagged VP8 decodes", rgba(vp8Tagged).length > 0);
const packA = webp.readMetadata(
  media.withStickerMetadata(lossyWebp.bytes, { packName: "A", publisher: "P" }),
)["sticker-pack-id"];
const packARepeat = webp.readMetadata(
  media.withStickerMetadata(lossyWebp.bytes, { packName: "A", publisher: "P" }),
)["sticker-pack-id"];
const packB = webp.readMetadata(
  media.withStickerMetadata(lossyWebp.bytes, { packName: "B", publisher: "P" }),
)["sticker-pack-id"];
equal("stable derived pack id", packA, packARepeat);
ok("distinct pack ids", packA !== packB);
equal(
  "explicit pack id",
  webp.readMetadata(
    media.withStickerMetadata(lossyWebp.bytes, { packId: "custom", packName: "A", publisher: "P" }),
  )["sticker-pack-id"],
  "custom",
);
const gifOut = await media.toGif(gifResult.buffer);
equal("GIF export", media.sniff(gifOut)?.kind, "gif");
const mp4Out = await media.toMp4(gifResult.buffer);
equal("MP4 export", media.sniff(mp4Out)?.kind, "video");
const largeAnimated = make("large-animated.webp", [
  "-f",
  "lavfi",
  "-i",
  "testsrc=s=600x400:r=2:d=1",
  "-t",
  "1",
  "-c:v",
  "libwebp_anim",
]);
const largeMp4 = await media.toMp4(largeAnimated.bytes);
equal("kept wide sticker MP4 width and height", rgba(largeMp4, "mov").length, 600 * 400 * 4);
const largeProbe = spawnSync(
  bin,
  ["-hide_banner", "-i", "pipe:0", "-frames:v", "0", "-f", "null", "-"],
  { input: largeMp4 },
);
ok("kept wide sticker MP4 reports 600x400", /Video:[^\n]*600x400/.test(String(largeProbe.stderr)));
const first = await media.toPng(gifResult.buffer);
equal("animated PNG flag", first.animated, true);
equal(
  "animated EXIF",
  webp.readMetadata(media.withStickerMetadata(gifResult.buffer, { packName: "G", publisher: "P" }))[
    "sticker-pack-name"
  ],
  "G",
);
section("metadata canonicalization");
for (const [name, bytes, firstChunk] of [
  ["simple VP8", lossyWebp.bytes, "VP8 "],
  ["simple VP8L", losslessWebp.bytes, "VP8L"],
  ["VP8X with alpha", alphaWebp.bytes, "VP8X"],
  ["animated VP8X", animatedWebp.bytes, "VP8X"],
]) {
  equal(`${name} shape`, webp.parse(bytes).chunks[0].type, firstChunk);
  const tagged = media.withStickerMetadata(bytes, { packName: "Foreign", publisher: "Other" });
  ok(
    `${name} canonical tagged equals original`,
    media.canonicalWebp(tagged).equals(media.canonicalWebp(bytes)),
  );
  equal(`${name} metadata removed`, webp.readMetadata(media.canonicalWebp(tagged)), null);
  const second = media.withStickerMetadata(tagged, { packName: "Another", publisher: "Other" });
  ok(
    `${name} pack metadata changes no content`,
    media.canonicalWebp(second).equals(media.canonicalWebp(bytes)),
  );
}
{
  const tagged = media.withStickerMetadata(alphaWebp.bytes, { packName: "A", publisher: "P" });
  const parts = webp.parse(tagged).chunks;
  const flags = Buffer.from(parts[0].data);
  flags[0] |= 0x04;
  const withXmp = riff([
    chunk("VP8X", flags),
    ...parts.slice(1).map((part) => part.raw),
    chunk("XMP ", Buffer.from("foreign")),
  ]);
  const cleaned = media.canonicalWebp(withXmp);
  ok("EXIF and XMP removed together", cleaned.equals(media.canonicalWebp(alphaWebp.bytes)));
  equal("metadata flags cleared", webp.parse(cleaned).chunks[0].data[0] & 0x0c, 0);
}
section("pack metadata round-trips multi-word names");
for (const packName of [
  "My Pack",
  "حزمة العيد",
  "Mixed حزمة pack",
  "Abdo's pack, 2",
  "عيد 2",
  "party 🎉",
  "My Pack\u200cName",
]) {
  const tagged = media.withStickerMetadata(lossyWebp.bytes, { packName, publisher: "Levix" });
  const meta = webp.readMetadata(tagged);
  equal(`EXIF keeps ${packName}`, meta["sticker-pack-name"], packName);
  equal(`EXIF keeps the publisher for ${packName}`, meta["sticker-pack-publisher"], "Levix");
  equal(
    `canonical drops the metadata for ${packName}`,
    webp.readMetadata(media.canonicalWebp(tagged)),
    null,
  );
}
const corrupt = Buffer.from(staticResult.buffer.subarray(0, 40));
equal(
  "truncated WebP",
  throws("truncated throws", () => media.describeWebp(corrupt))?.code,
  "CORRUPT",
);
equal(
  "RIFF ignores trailing bytes",
  media.describeWebp(Buffer.concat([staticResult.buffer, Buffer.from("xyz")])).width,
  512,
);
equal(
  "RIFF rejects missing final byte",
  throws("RIFF truncated throws", () => media.describeWebp(staticResult.buffer.subarray(0, -1)))
    ?.code,
  "CORRUPT",
);
try {
  await media.createSticker({
    inputPath: png.file,
    sniffed: media.sniff(png.bytes),
    options: normalizeOptions(),
    _maxBytes: 1,
  });
  ok("size failure", false);
} catch (e) {
  equal("size failure", e.code, "OUTPUT_TOO_LARGE");
}
section("animated WebP compositing");
function chunk(type, body) {
  const header = Buffer.alloc(8);
  header.write(type);
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body, body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}
function riff(chunks) {
  const body = Buffer.concat([Buffer.from("WEBP"), ...chunks]);
  const h = Buffer.alloc(8);
  h.write("RIFF");
  h.writeUInt32LE(body.length, 4);
  return Buffer.concat([h, body]);
}
function frame(bytes, x, y, width, height, flags) {
  const h = Buffer.alloc(16);
  h.writeUIntLE(x / 2, 0, 3);
  h.writeUIntLE(y / 2, 3, 3);
  h.writeUIntLE(width - 1, 6, 3);
  h.writeUIntLE(height - 1, 9, 3);
  h.writeUIntLE(100, 12, 3);
  h[15] = flags;
  const parts = webp
    .parse(bytes)
    .chunks.filter((c) => c.type === "VP8 " || c.type === "VP8L" || c.type === "ALPH")
    .map((c) => c.raw);
  return chunk("ANMF", Buffer.concat([h, ...parts]));
}
const header = Buffer.alloc(10);
header[0] = 0x12;
header.writeUIntLE(3, 4, 3);
header.writeUIntLE(3, 7, 3);
const anim = Buffer.alloc(6);
const blendFixture = riff([
  chunk("VP8X", header),
  chunk("ANIM", anim),
  frame(redFrame.bytes, 0, 0, 4, 4, 0),
  frame(blueFrame.bytes, 2, 0, 2, 2, 0),
]);
const disposalFixture = riff([
  chunk("VP8X", header),
  chunk("ANIM", anim),
  frame(redFrame.bytes, 0, 0, 4, 4, 1),
  frame(blueFrame.bytes, 2, 0, 2, 2, 0),
]);
const transparentFixture = riff([
  chunk("VP8X", header),
  chunk("ANIM", anim),
  frame(opaqueBlueFrame.bytes, 2, 0, 2, 2, 0),
  frame(opaqueBlueFrame.bytes, 2, 0, 2, 2, 0),
]);
const frameLimitFixture = riff([
  chunk("VP8X", header),
  chunk("ANIM", anim),
  ...Array.from({ length: L.ANIMATED_MAX_FRAMES + 1 }, () => frame(redFrame.bytes, 0, 0, 4, 4, 0)),
]);
const excessChunks = riff([
  lossyWebp.bytes.subarray(12),
  ...Array(200001).fill(chunk("JUNK", Buffer.alloc(0))),
]);
equal(
  "200002 top-level chunks rejected",
  throws("chunk cap", () => webp.parse(excessChunks))?.code,
  "CORRUPT",
);
const excessFrameParts = riff([
  chunk("VP8X", header),
  chunk("ANIM", anim),
  chunk(
    "ANMF",
    Buffer.concat([
      Buffer.alloc(16),
      ...Array(8).fill(chunk("JUNK", Buffer.alloc(0))),
      webp.parse(redFrame.bytes).chunks[0].raw,
    ]),
  ),
]);
equal(
  "ANMF sub-chunk cap",
  throws("frame part cap", () => webp.parse(excessFrameParts))?.code,
  "CORRUPT",
);
const wideHeader = Buffer.from(header);
wideHeader.writeUIntLE(L.EXISTING_MAX_SIDE, 4, 3);
const wideFixture = riff([
  chunk("VP8X", wideHeader),
  chunk("ANIM", anim),
  frame(redFrame.bytes, 0, 0, 4, 4, 0),
]);
for (const [label, bytes, code, detail] of [
  ["frame cap", frameLimitFixture, "TOO_LARGE", L.ANIMATED_MAX_FRAMES],
  ["animated canvas cap", wideFixture, "DIMENSIONS_TOO_LARGE", L.EXISTING_MAX_SIDE],
]) {
  const error = throws(`${label} describe throws`, () => media.describeWebp(bytes));
  equal(`${label} code`, error?.code, code);
  equal(`${label} detail`, error?.details.limitFrames ?? error?.details.limit, detail);
  const file = join(dir, `${label.replaceAll(" ", "-")}.webp`);
  writeFileSync(file, bytes);
  try {
    await media.inspect(file, media.sniff(bytes));
    ok(`${label} inspect rejects`, false);
  } catch (caught) {
    equal(`${label} inspect code`, caught.code, code);
  }
}
equal("blend frame flag", webp.parse(blendFixture).frames[1].blend, true);
equal("disposal frame flag", webp.parse(disposalFixture).frames[0].dispose, true);
const third = async (bytes) => {
  let i = 0;
  for await (const frame of media.compositeWebpFrames(bytes, { fps: 15 })) {
    if (i++ === 2) return frame;
  }
};
const blended = await third(blendFixture);
const disposed = await third(disposalFixture);
const blendPixel = (0 * 4 + 2) * 4;
ok("blend shows both colors", blended[blendPixel] > 50 && blended[blendPixel + 2] > 50);
ok("disposal clears prior canvas", disposed[(3 * 4 + 0) * 4 + 3] < 128);
const transparentGif = await media.toGif(transparentFixture);
const gifPixels = rgba(transparentGif, "gif");
ok("GIF keeps transparent pixel", gifPixels[3] < 128);
ok("GIF keeps blue pixel", gifPixels[(0 * 4 + 2) * 4 + 2] > 180 && gifPixels[(0 * 4 + 2) * 4] < 80);
const whiteMp4 = await media.toMp4(transparentFixture);
const mp4Pixels = rgba(whiteMp4, "mov");
const whiteCorner = mp4Pixels.length - 4;
ok(
  "MP4 flattens transparency onto white",
  mp4Pixels[whiteCorner] > 235 &&
    mp4Pixels[whiteCorner + 1] > 235 &&
    mp4Pixels[whiteCorner + 2] > 235,
  `${mp4Pixels.length} bytes; corner ${[...mp4Pixels.subarray(whiteCorner, whiteCorner + 4)]}`,
);
section("quality warning thresholds");
for (const [label, source, steps, expected] of [
  ["static q80", png, [[80, 1]], false],
  ["static q45", png, [[45, 1]], true],
  ["animated q60 full fps", gif, [[60, L.ANIMATED_FPS]], false],
  ["animated q60 low fps", gif, [[60, L.ANIMATED_FPS - 3]], true],
]) {
  const result = await media.createSticker({
    inputPath: source.file,
    sniffed: media.sniff(source.bytes),
    options: normalizeOptions(),
    _qualitySteps: steps,
    _targetBytes: L.STICKER_MAX_BYTES,
  });
  equal(label, result.qualityReduced, expected);
}
section("queue");
const cancelledQueue = createQueue({ concurrency: 1, maxQueued: 2, timeoutMs: 1000 });
let finishCancelled;
let queuedRan = false;
let runningAborted = false;
const runningJob = cancelledQueue.submit(
  ({ signal }) =>
    new Promise((resolve) => {
      finishCancelled = resolve;
      signal.addEventListener(
        "abort",
        () => {
          runningAborted = true;
          resolve("late");
        },
        { once: true },
      );
    }),
  { kind: "create" },
);
const queuedJob = cancelledQueue.submit(async () => {
  queuedRan = true;
  return "wrong";
});
const runningFailure = runningJob.promise.catch((error) => error);
const queuedFailure = queuedJob.promise.catch((error) => error);
await new Promise((resolve) => setImmediate(resolve));
cancelledQueue.cancelAll();
equal("running job cancelled", (await runningFailure).code, "CANCELLED");
equal("queued job cancelled", (await queuedFailure).code, "CANCELLED");
equal("running record failed", cancelledQueue.get(runningJob.id)?.error?.code, "CANCELLED");
equal("queued record failed", cancelledQueue.get(queuedJob.id)?.error?.code, "CANCELLED");
equal("running signal aborted", runningAborted, true);
equal("queued work did not run", queuedRan, false);
finishCancelled?.();
const exportQueue = createQueue();
const exportedBytes = Buffer.alloc(1024 * 1024);
const exportJob = exportQueue.submit(async () => ({ buffer: exportedBytes }), { kind: "export" });
equal("export caller receives bytes", (await exportJob.promise).buffer, exportedBytes);
equal("export record has no result bytes", exportQueue.get(exportJob.id)?.result, null);
const createResultJob = exportQueue.submit(
  async () => ({
    sticker: { id: "one" },
    created: true,
    qualityReduced: false,
    buffer: exportedBytes,
  }),
  { kind: "create" },
);
await createResultJob.promise;
equal(
  "create record retains only sticker DTO",
  JSON.stringify(exportQueue.get(createResultJob.id)?.result),
  JSON.stringify({ sticker: { id: "one" }, created: true, qualityReduced: false }),
);
const q = createQueue({ concurrency: 1, maxQueued: 1, timeoutMs: 20, retentionMs: 20 });
let release;
const one = q.submit(
  () =>
    new Promise((r) => {
      release = r;
    }),
  { kind: "one" },
);
const two = q.submit(async () => 2, { kind: "two" });
equal("BUSY", throws("full queue throws", () => q.submit(async () => 3))?.code, "BUSY");
await new Promise((r) => setImmediate(r));
release(1);
await one.promise;
equal("queued result", await two.promise, 2);
await new Promise((r) => setTimeout(r, 40));
equal("retention expiry", q.get(one.id), null);
const stalled = createQueue({
  concurrency: 1,
  timeoutMs: 10,
  retentionMs: 100,
  timeoutGraceMs: 50,
});
const stuck = stalled.submit(() => new Promise(() => {}), { kind: "stuck" });
try {
  await stuck.promise;
  ok("queue timeout", false);
} catch (e) {
  equal("queue timeout", e.code, "TIMEOUT");
}
equal("queue failed state", stalled.get(stuck.id)?.state, "failed");
const ignored = createQueue({ concurrency: 1, maxQueued: 1, timeoutMs: 15, timeoutGraceMs: 80 });
let finishIgnoring;
let secondStarted = false;
const ignoring = ignored.submit(
  () =>
    new Promise((resolve) => {
      finishIgnoring = resolve;
    }),
);
const waiting = ignored.submit(async () => {
  secondStarted = true;
  return "next";
});
try {
  await ignoring.promise;
} catch (error) {
  equal("ignoring worker times out", error.code, "TIMEOUT");
}
await new Promise((resolve) => setTimeout(resolve, 30));
equal("slot stays occupied during abort grace", secondStarted, false);
finishIgnoring();
equal("slot releases when work settles", await waiting.promise, "next");
const graceQueue = createQueue({ concurrency: 1, maxQueued: 1, timeoutMs: 10, timeoutGraceMs: 40 });
const neverSettles = graceQueue.submit(() => new Promise(() => {}));
const afterGrace = graceQueue.submit(async () => "after grace");
try {
  await neverSettles.promise;
} catch (error) {
  equal("grace job timeout", error.code, "TIMEOUT");
}
equal("slot held immediately after timeout", graceQueue.get(afterGrace.id)?.state, "queued");
equal("slot released after grace", await afterGrace.promise, "after grace");
try {
  await runFfmpeg(
    [
      "-f",
      "png_pipe",
      "-protocol_whitelist",
      "file,pipe",
      "-i",
      png.file,
      "-frames:v",
      "1",
      "-pix_fmt",
      "rgba",
      "-f",
      "rawvideo",
      "pipe:1",
    ],
    { maxOutputBytes: 1 },
  );
  ok("stdout cap", false);
} catch (e) {
  equal("stdout cap", e.code, "CONVERSION_FAILED");
}
const gate = new AbortController();
const slow = new Readable({ read() {} });
const ff = runFfmpeg(
  [
    "-f",
    "rawvideo",
    "-pixel_format",
    "rgba",
    "-video_size",
    "512x512",
    "-protocol_whitelist",
    "file,pipe",
    "-i",
    "pipe:0",
    "-f",
    "rawvideo",
    "pipe:1",
  ],
  { input: slow, signal: gate.signal },
);
setTimeout(() => gate.abort(), 20);
try {
  await ff;
  ok("ffmpeg abort", false);
} catch (e) {
  equal("ffmpeg abort", e.code, "TIMEOUT");
}
slow.destroy();
finish();

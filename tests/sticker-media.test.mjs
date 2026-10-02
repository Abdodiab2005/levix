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
ok("placement scale", graph.graph.includes(`scale=${p.width}:${p.height}`));
ok("placement offset", graph.graph.includes(`overlay=${p.x}:${p.y}`));
ok("background color", graph.graph.includes("0xabcdef"));
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
const first = await media.toPng(gifResult.buffer);
equal("animated PNG flag", first.animated, true);
equal(
  "animated EXIF",
  webp.readMetadata(media.withStickerMetadata(gifResult.buffer, { packName: "G", publisher: "P" }))[
    "sticker-pack-name"
  ],
  "G",
);
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
const whiteCorner = (511 * 512 + 511) * 4;
ok(
  "MP4 flattens transparency onto white",
  mp4Pixels[whiteCorner] > 235 &&
    mp4Pixels[whiteCorner + 1] > 235 &&
    mp4Pixels[whiteCorner + 2] > 235,
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

// Sticker Studio end to end: the real panel, the real queue, and the real
// converter. Fixtures are generated with the bundled ffmpeg at test time.
// Nothing here is faked.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  equal,
  finish,
  httpClient,
  listen,
  ok,
  require,
  section,
  useTempDataDir,
} from "./harness.mjs";

const dataDir = useTempDataDir("levix-stk-e2e");
const bin = require("ffmpeg-static");
const media = require("./src/stickers/media.cjs");
const {
  THUMB_SIZE,
  UPLOAD_MAX_BYTES,
  VIDEO_MAX_SOURCE_SECONDS,
} = require("./src/stickers/limits.cjs");

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function make(name, args) {
  const file = join(dataDir, name);
  const result = spawnSync(bin, ["-hide_banner", "-loglevel", "error", "-y", ...args, file]);
  if (result.status !== 0) {
    throw new Error(`${name}: ${result.stderr}`);
  }
  return { file, bytes: readFileSync(file) };
}

function readZip(buf) {
  const eocdSig = 0x06054b50;
  let eocd = -1;
  const start = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === eocdSig) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip has no end of central directory");
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const names = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error("bad central directory");
    const nameLen = buf.readUInt16LE(offset + 28);
    const extra = buf.readUInt16LE(offset + 30);
    const comment = buf.readUInt16LE(offset + 32);
    names.push(buf.subarray(offset + 46, offset + 46 + nameLen).toString("utf8"));
    offset += 46 + nameLen + extra + comment;
  }
  return names;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

let server;
let io;

try {
  const png = make("src.png", ["-f", "lavfi", "-i", "color=c=red:s=80x60:d=1", "-frames:v", "1"]);
  const gif = make("src.gif", ["-f", "lavfi", "-i", "testsrc=s=64x64:r=8:d=1", "-t", "1"]);
  const webp = make("src.webp", [
    "-f",
    "lavfi",
    "-i",
    "color=c=green:s=512x512:d=1",
    "-frames:v",
    "1",
    "-c:v",
    "libwebp",
  ]);
  const overlay = make("overlay.png", [
    "-f",
    "lavfi",
    "-i",
    "color=c=black@0.4:s=512x512:d=1,format=rgba",
    "-frames:v",
    "1",
  ]);
  const longVideo = make("long.mp4", [
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=32x32:r=1:d=62",
    "-t",
    "62",
    "-c:v",
    "mpeg4",
  ]);

  const {
    app,
    server: httpServer,
    io: socket,
    dashboardJson,
    requireLoginApi,
    noStore,
    installFinalHandlers,
  } = require("./app.cjs");
  server = httpServer;
  io = socket;
  const stickerApi = await import("../src/routes/stickers.api.esm.js");
  app.use(
    "/dashboard/api",
    requireLoginApi,
    noStore,
    stickerApi.jsonUnlessStickerUpload(dashboardJson),
    stickerApi.default,
  );
  installFinalHandlers();

  const { base } = await listen(server);
  const http = httpClient(base);

  async function bodyOf(res) {
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  function upload(bytes, filename) {
    const headers = { "content-type": "application/octet-stream" };
    if (filename) headers["x-filename"] = encodeURIComponent(filename);
    return http.call("/dashboard/api/stickers/uploads", { method: "POST", headers, body: bytes });
  }

  async function waitJob(id) {
    let last = null;
    const deadline = Date.now() + 80_000;
    while (Date.now() < deadline) {
      const res = await http.call(`/dashboard/api/stickers/jobs/${id}`);
      last = { status: res.status, body: await bodyOf(res) };
      if (last.body?.state === "done" || last.body?.state === "failed" || last.status !== 200) {
        return last;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return last;
  }

  async function runJob(bytes, filename, job) {
    const uploaded = await upload(bytes, filename);
    const record = await bodyOf(uploaded);
    ok("upload accepted", uploaded.status === 201, JSON.stringify(record));
    const postedRes = await http.json("/dashboard/api/stickers/jobs", {
      uploadId: record.uploadId,
      ...job,
    });
    const posted = await bodyOf(postedRes);
    equal("a job is accepted", postedRes.status, 202);
    const done = await waitJob(posted.jobId);
    return { record, done };
  }

  section("the real panel signs in");

  let res = await http.form("/setup", { password: "a-good-password", confirm: "a-good-password" });
  equal("setup signs the operator in", res.status, 303);
  await bodyOf(res);

  section("a png with options and an overlay becomes a 512 sticker");

  const encoded = await runJob(png.bytes, "panel.png", {
    name: "Panel cat",
    options: { zoom: 2 },
    overlay: `data:image/png;base64,${overlay.bytes.toString("base64")}`,
  });
  ok(
    "the png job finishes",
    encoded.done.body?.state === "done",
    JSON.stringify(encoded.done.body?.error || encoded.done.body),
  );
  equal("the png sticker is new", encoded.done.body.created, true);
  const sticker = encoded.done.body.sticker;
  res = await http.call(sticker.url);
  const fileBytes = Buffer.from(await res.arrayBuffer());
  equal("the file route answers", res.status, 200);
  equal("the file is webp", res.headers.get("content-type"), "image/webp");
  const described = media.describeWebp(fileBytes);
  equal("the sticker is 512 wide", described.width, 512);
  equal("the sticker is 512 tall", described.height, 512);
  equal("the png sticker is static", described.animated, false);

  res = await http.call(sticker.thumbUrl);
  const thumbBytes = Buffer.from(await res.arrayBuffer());
  equal("the thumb route answers", res.status, 200);
  equal("the thumb is webp", res.headers.get("content-type"), "image/webp");
  const thumb = media.describeWebp(thumbBytes);
  equal("the thumb is the thumbnail size wide", thumb.width, THUMB_SIZE);
  equal("the thumb is the thumbnail size tall", thumb.height, THUMB_SIZE);

  section("a gif becomes an animated sticker");

  const motion = await runJob(gif.bytes, "panel.gif", { name: "Motion" });
  ok(
    "the gif job finishes",
    motion.done.body?.state === "done",
    JSON.stringify(motion.done.body?.error || motion.done.body),
  );
  equal("the gif sticker is animated", motion.done.body.sticker.animated, true);
  res = await http.call(motion.done.body.sticker.url);
  const motionBytes = Buffer.from(await res.arrayBuffer());
  equal("the animated file is webp", res.headers.get("content-type"), "image/webp");
  const motionInfo = media.describeWebp(motionBytes);
  equal("the animated sticker is 512 wide", motionInfo.width, 512);
  equal("the animated sticker is 512 tall", motionInfo.height, 512);
  equal("describeWebp agrees it is animated", motionInfo.animated, true);
  const animatedId = motion.done.body.sticker.id;

  section("a fitting webp is kept byte for byte");

  const kept = await runJob(webp.bytes, "kept.webp", { name: "Kept" });
  ok(
    "the webp job finishes",
    kept.done.body?.state === "done",
    JSON.stringify(kept.done.body?.error || kept.done.body),
  );
  equal("the kept sticker is new", kept.done.body.created, true);
  res = await http.call(kept.done.body.sticker.url);
  const keptBytes = Buffer.from(await res.arrayBuffer());
  equal("the kept file matches the upload", sha256(keptBytes), sha256(webp.bytes));
  const again = await runJob(webp.bytes, "kept-again.webp", {});
  ok(
    "the second webp job finishes",
    again.done.body?.state === "done",
    JSON.stringify(again.done.body?.error || again.done.body),
  );
  equal("the same bytes are not created again", again.done.body.created, false);
  equal(
    "the same bytes are the same sticker",
    again.done.body.sticker.id,
    kept.done.body.sticker.id,
  );

  section("png export and a png zip go through the real converter");

  res = await http.call(`/dashboard/api/stickers/${animatedId}/export?format=png`);
  const exported = Buffer.from(await res.arrayBuffer());
  equal("png export status", res.status, 200);
  equal("png export type", res.headers.get("content-type"), "image/png");
  equal("an animated export is marked", res.headers.get("x-levix-animated"), "1");
  ok("the export starts with the png signature", exported.subarray(0, 8).equals(PNG_SIG));

  res = await http.json("/dashboard/api/stickers/export", {
    ids: [sticker.id, animatedId],
    format: "png",
  });
  const archive = Buffer.from(await res.arrayBuffer());
  equal("png zip status", res.status, 200);
  ok("png zip type", (res.headers.get("content-type") || "").includes("application/zip"));
  const names = readZip(archive);
  equal("the zip has both stickers", names.length, 2);
  ok(
    "both entries are pngs",
    names.every((name) => name.endsWith(".png")),
  );
  ok("the zip stores png bytes", archive.includes(PNG_SIG));

  section("uploads that cannot become stickers");

  res = await upload(Buffer.from("hello, this is text"));
  let body = await bodyOf(res);
  equal("a text file is 415", res.status, 415);
  equal("text file code", body.code, "UNSUPPORTED_TYPE");

  res = await upload(Buffer.alloc(UPLOAD_MAX_BYTES + 1, 1));
  body = await bodyOf(res);
  equal("an oversized upload is 413", res.status, 413);
  equal("oversized code", body.code, "TOO_LARGE");
  equal("the limit is named", body.limitBytes, UPLOAD_MAX_BYTES);

  res = await upload(longVideo.bytes, "long.mp4");
  body = await bodyOf(res);
  equal("a video past the source cap is 422", res.status, 422);
  equal("the upload rejects it as VIDEO_TOO_LONG", body.code, "VIDEO_TOO_LONG");
  equal("the cap is the source limit", body.limitSeconds, VIDEO_MAX_SOURCE_SECONDS);

  ok("the temp data dir was used", typeof dataDir === "string");
} catch (error) {
  ok("the e2e test ran", false, error?.stack || String(error));
} finally {
  server?.closeAllConnections?.();
  io?.close();
  server?.close();
  finish();
}

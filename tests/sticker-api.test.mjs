// Sticker Studio HTTP API, against the real panel session and the real library.
// This process injects fake media and jobs so the HTTP contract can be checked
// without FFmpeg. tests/sticker-e2e.test.mjs drives the real modules. The
// child fixture used by the panel tests cannot inject fakes, which is why the
// server is started in-process here.

import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
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

const dataDir = useTempDataDir("levix-stk-api");

const { app, server, io, dashboardJson, requireLoginApi, noStore, installFinalHandlers } =
  require("./app.cjs");
const stickerApi = await import("../src/routes/stickers.api.esm.js");
const { StickerError } = require("./src/stickers/errors.cjs");
const { MAX_INPUT_SIDE, UPLOAD_MAX_BYTES } = require("./src/stickers/limits.cjs");
const studioFactory = require("./src/stickers/studio.cjs");
const library = require("./src/stickers/library.cjs");
const uploads = require("./src/stickers/uploads.cjs");
const owner = require("./src/stickers/owner.cjs");
const settings = require("./src/config/settings.cjs");
const { dataPath } = require("./src/config/paths.cjs");

function makeWebp(width, height, payload, animated = false) {
  const body = Buffer.from(payload);
  const buf = Buffer.alloc(20 + body.length);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(buf.length - 8, 4);
  buf.write("WEBP", 8);
  buf.writeUInt16LE(width, 12);
  buf.writeUInt16LE(height, 14);
  buf[16] = animated ? 1 : 0;
  body.copy(buf, 20);
  return buf;
}

function makeJpeg() {
  return Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
}

function overlayDataUrl() {
  const buf = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(512, 16);
  buf.writeUInt32BE(512, 20);
  return `data:image/png;base64,${buf.toString("base64")}`;
}

function createFakeMedia() {
  const calls = [];
  const media = {
    calls,
    failCreate: false,
    qualityReduced: false,
    sniff(buffer) {
      if (
        buffer.length >= 12 &&
        buffer.toString("ascii", 0, 4) === "RIFF" &&
        buffer.toString("ascii", 8, 12) === "WEBP"
      ) {
        return { kind: "webp", mime: "image/webp", ext: "webp" };
      }
      if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
        return { kind: "image", mime: "image/jpeg", ext: "jpg" };
      }
      return null;
    },
    async inspect(filePath, sniffed) {
      if (sniffed.kind === "webp") {
        const { readFileSync } = require("node:fs");
        const info = media.describeWebp(readFileSync(filePath));
        return { kind: "webp", mime: sniffed.mime, frames: info.frames, ...info };
      }
      return {
        kind: "image",
        mime: sniffed.mime,
        width: 32,
        height: 32,
        durationMs: 0,
        animated: false,
        frames: null,
      };
    },
    describeWebp(buffer) {
      if (!buffer || buffer.length < 20 || buffer.toString("ascii", 0, 4) !== "RIFF") {
        throw new StickerError("CORRUPT");
      }
      const animated = buffer[16] === 1;
      return {
        width: buffer.readUInt16LE(12),
        height: buffer.readUInt16LE(14),
        animated,
        durationMs: animated ? 500 : 0,
        frames: animated ? 2 : 1,
      };
    },
    async createSticker(input) {
      calls.push({
        overlay: !!input.overlayPng,
        zoom: input.options?.zoom,
        kind: input.sniffed?.kind,
        inputPath: input.inputPath,
      });
      input.onProgress?.("encoding", 1);
      if (media.failCreate) throw new StickerError("CONVERSION_FAILED");
      return {
        buffer: makeWebp(512, 512, `encoded-${calls.length}-${Date.now()}`),
        width: 512,
        height: 512,
        animated: false,
        durationMs: 0,
        sourceMime: input.sniffed.mime,
        qualityReduced: !!media.qualityReduced,
      };
    },
    async makeThumbnail() {
      return makeWebp(16, 16, "thumb");
    },
    async toPng(webpBuffer) {
      return { buffer: Buffer.from("PNG"), animated: !!media.describeWebp(webpBuffer).animated };
    },
    async toGif() {
      return Buffer.from("GIF89a");
    },
    withStickerMetadata(webpBuffer, { packName, publisher }) {
      return Buffer.concat([Buffer.from(`${packName}|${publisher}|`), webpBuffer]);
    },
    async capabilities() {
      return {
        webp: true,
        animated: true,
        gif: true,
        mp4: true,
        backgroundRemoval: ["plain"],
      };
    },
  };
  return media;
}

function createFakeJobs() {
  const jobs = new Map();
  let seq = 0;
  return {
    busy: false,
    submits: [],
    submit(run, { kind } = {}) {
      if (this.busy) throw new StickerError("BUSY");
      this.submits.push({ kind });
      const id = `job${++seq}`;
      const job = {
        id,
        kind,
        state: "queued",
        stage: null,
        progress: 0,
        error: null,
        result: null,
      };
      jobs.set(id, job);
      const promise = Promise.resolve().then(async () => {
        job.state = "running";
        try {
          const result = await run({
            signal: new AbortController().signal,
            progress(stage, fraction) {
              job.stage = stage;
              job.progress = fraction;
            },
          });
          job.result = result;
          job.state = "done";
          job.progress = 1;
          return result;
        } catch (error) {
          job.state = "failed";
          job.error = {
            code: error instanceof StickerError ? error.code : "CONVERSION_FAILED",
            details: error instanceof StickerError && error.details ? error.details : {},
          };
          throw error;
        }
      });
      return { id, promise };
    },
    get(id) {
      return jobs.get(id) || null;
    },
  };
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
    const method = buf.readUInt16LE(offset + 10);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extra = buf.readUInt16LE(offset + 30);
    const comment = buf.readUInt16LE(offset + 32);
    names.push(buf.subarray(offset + 46, offset + 46 + nameLen).toString("utf8"));
    ok("zip entries are stored, not deflated", method === 0);
    offset += 46 + nameLen + extra + comment;
  }
  return names;
}

function workFiles() {
  try {
    return readdirSync(dataPath("tmp", "stickers")).filter((name) => name.startsWith("work-"));
  } catch {
    return [];
  }
}

const media = createFakeMedia();
const jobs = createFakeJobs();
const studio = studioFactory.createStudio({ media, jobs });
stickerApi.setMedia(media);
stickerApi.setStudio(studio);

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
  for (let i = 0; i < 40; i++) {
    const res = await http.call(`/dashboard/api/stickers/jobs/${id}`);
    last = { status: res.status, body: await bodyOf(res) };
    if (last.body?.state === "done" || last.body?.state === "failed" || last.status !== 200) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  return last;
}

async function createFrom(bytes, fields = {}) {
  const uploaded = await upload(bytes, fields.filename);
  const record = await bodyOf(uploaded);
  ok("upload accepted", uploaded.status === 201, JSON.stringify(record));
  const res = await http.json("/dashboard/api/stickers/jobs", {
    uploadId: record.uploadId,
    ...fields.job,
  });
  const posted = await bodyOf(res);
  equal("a job is accepted", res.status, 202);
  const done = await waitJob(posted.jobId);
  return { record, posted, done };
}

try {
  section("the api is behind the panel session");

  let res = await http.call("/dashboard/api/stickers");
  equal("a stranger gets 401", res.status, 401);
  await bodyOf(res);

  res = await http.form("/setup", { password: "a-good-password", confirm: "a-good-password" });
  equal("setup signs the operator in", res.status, 303);
  await bodyOf(res);

  section("capabilities");

  res = await http.call("/dashboard/api/stickers/capabilities");
  let body = await bodyOf(res);
  equal("capabilities answer", res.status, 200);
  equal("webp is reported", body.webp, true);
  equal("animated is reported", body.animated, true);
  ok("background removal lists plain", body.backgroundRemoval?.includes("plain"));
  equal("upload cap is the shared limit", body.limits.uploadBytes, UPLOAD_MAX_BYTES);
  equal("source video cap is 60s", body.limits.videoSeconds, 60);
  equal("sticker cap is 10s", body.limits.stickerSeconds, 10);
  equal("max side is the largest source the panel may upload", body.limits.maxSide, MAX_INPUT_SIDE);
  equal("library cap starts at the setting default", body.limits.libraryMax, 1000);
  equal("pack cap is 100", body.limits.packsMax, 100);

  settings.set("sticker_library_limit", 7);
  res = await http.call("/dashboard/api/stickers/capabilities");
  body = await bodyOf(res);
  equal("library cap is read live", body.limits.libraryMax, 7);
  settings.set("sticker_library_limit", null);

  section("uploads reject the wrong size and the wrong type");

  res = await upload(Buffer.alloc(0));
  body = await bodyOf(res);
  equal("an empty upload is NO_MEDIA", res.status, 400);
  equal("empty upload code", body.code, "NO_MEDIA");

  res = await upload(Buffer.from("not-an-image"));
  body = await bodyOf(res);
  equal("an unknown type is 415", res.status, 415);
  equal("unknown type code", body.code, "UNSUPPORTED_TYPE");

  res = await upload(Buffer.from("RIFF????WEBP"));
  body = await bodyOf(res);
  equal("a truncated webp is corrupt", res.status, 422);
  equal("corrupt code", body.code, "CORRUPT");

  res = await upload(Buffer.alloc(UPLOAD_MAX_BYTES + 1, 1));
  body = await bodyOf(res);
  equal("an oversized upload is 413", res.status, 413);
  equal("oversized code", body.code, "TOO_LARGE");
  equal("the limit is named", body.limitBytes, UPLOAD_MAX_BYTES);

  section("jobs: re-encode, keep bytes, dedupe, failure, busy");

  const beforeEncode = media.calls.length;
  const jpeg = await createFrom(makeJpeg(), { job: { name: "Jpeg One" } });
  equal("a jpeg job finishes", jpeg.done.status, 200);
  equal("a jpeg job is done", jpeg.done.body.state, "done");
  equal("a jpeg sticker is new", jpeg.done.body.created, true);
  equal("quality stays false until asked", jpeg.done.body.qualityReduced, false);
  equal("the jpeg error is null", jpeg.done.body.error, null);
  equal("the sticker is named", jpeg.done.body.sticker.name, "Jpeg One");
  equal("the source is the panel", jpeg.done.body.sticker.source, "PANEL_UPLOAD");
  ok("a jpeg is re-encoded", media.calls.length === beforeEncode + 1);
  const jpegUpload = uploads.get(owner.forPanel(), jpeg.record.uploadId);
  equal("a jpeg is converted from its upload file", media.calls.at(-1).inputPath, jpegUpload.path);
  ok("the upload path is not a work file", !String(jpegUpload.path).includes("work-"));
  ok("the upload file survives a successful job", existsSync(jpegUpload.path));
  equal("an upload conversion leaves no work file", workFiles().length, 0);
  const jpegId = jpeg.done.body.sticker.id;

  const keptBytes = makeWebp(64, 48, "percent-cat");
  const beforeKeep = media.calls.length;
  const kept = await createFrom(keptBytes, { job: { name: "Percent%_name" } });
  equal("a fitting webp is kept", kept.done.body.state, "done");
  equal("keeping bytes does not call the encoder", media.calls.length, beforeKeep);
  equal("the kept sticker is new", kept.done.body.created, true);
  equal("kept width comes from the file", kept.done.body.sticker.width, 64);
  equal("kept height comes from the file", kept.done.body.sticker.height, 48);
  const sha = createHash("sha256").update(keptBytes).digest("hex").slice(0, 12);
  ok("the file url is content-addressed", kept.done.body.sticker.url.endsWith(`?v=${sha}`));
  ok("the thumb url uses the same version", kept.done.body.sticker.thumbUrl.endsWith(`?v=${sha}`));
  const keptId = kept.done.body.sticker.id;

  res = await http.call(kept.done.body.sticker.url);
  const fileBytes = Buffer.from(await res.arrayBuffer());
  equal("the file route returns the original bytes", res.status, 200);
  equal("file content type", res.headers.get("content-type"), "image/webp");
  equal("file cache header", res.headers.get("cache-control"), "private, no-cache");
  ok("the bytes were not re-encoded", fileBytes.equals(keptBytes));

  res = await http.call(kept.done.body.sticker.thumbUrl);
  equal("the thumb route is webp", res.status, 200);
  equal("thumb content type", res.headers.get("content-type"), "image/webp");
  equal("thumb cache header", res.headers.get("cache-control"), "private, no-cache");
  await res.arrayBuffer();

  const again = await createFrom(keptBytes, { job: { name: "second save" } });
  equal("the same bytes are the existing sticker", again.done.body.created, false);
  equal("dedupe returns the same id", again.done.body.sticker.id, keptId);
  equal("dedupe reports quality unchanged", again.done.body.qualityReduced, false);

  const beforeOverlay = media.calls.length;
  const overlaid = await createFrom(keptBytes, {
    job: { name: "with overlay", overlay: overlayDataUrl() },
  });
  equal("an overlay still finishes", overlaid.done.body.state, "done");
  ok("an overlay forces a re-encode", media.calls.length === beforeOverlay + 1);
  ok("the encoder saw the overlay", media.calls.at(-1).overlay);
  ok("the overlay produced its own sticker", overlaid.done.body.sticker.id !== keptId);

  const beforeZoom = media.calls.length;
  media.qualityReduced = true;
  const zoomed = await createFrom(makeJpeg(), { job: { name: "Zoomed", options: { zoom: 2 } } });
  media.qualityReduced = false;
  equal("a zoomed jpeg finishes", zoomed.done.body.state, "done");
  ok("non-default options re-encode", media.calls.length === beforeZoom + 1);
  equal("the encoder received the zoom", media.calls.at(-1).zoom, 2);
  equal("qualityReduced is reported", zoomed.done.body.qualityReduced, true);

  res = await http.json("/dashboard/api/stickers/jobs", {
    uploadId: kept.record.uploadId,
    options: { zoom: 9 },
  });
  body = await bodyOf(res);
  equal("a bad option is 400", res.status, 400);
  equal("a bad option names the field", body.field, "zoom");

  res = await http.json("/dashboard/api/stickers/jobs", { uploadId: "nope" });
  body = await bodyOf(res);
  equal("a bad upload id is refused", res.status, 400);
  equal("bad upload id code", body.code, "INVALID_OPTIONS");

  res = await http.json("/dashboard/api/stickers/jobs", {
    uploadId: kept.record.uploadId,
    source: "BOT_COMMAND",
  });
  body = await bodyOf(res);
  equal("the bot source is not a panel job", res.status, 400);

  media.failCreate = true;
  const failed = await createFrom(makeJpeg(), { job: { name: "broken" } });
  media.failCreate = false;
  equal("a failed conversion is still 200 on the poll", failed.done.status, 200);
  equal("the job failed", failed.done.body.state, "failed");
  equal("the failure code is CONVERSION_FAILED", failed.done.body.error.code, "CONVERSION_FAILED");
  ok(
    "the failure has an english message",
    failed.done.body.error.message.includes("could not be created"),
  );
  equal("a failed job has no sticker", failed.done.body.sticker, null);
  equal("a failed job has created null", failed.done.body.created, null);
  equal("a failed job has qualityReduced null", failed.done.body.qualityReduced, null);
  const failedUpload = uploads.get(owner.forPanel(), failed.record.uploadId);
  ok("a failed job leaves the upload in place", failedUpload && existsSync(failedUpload.path));
  equal("a failed upload conversion leaves no work file", workFiles().length, 0);

  const retryRes = await http.json("/dashboard/api/stickers/jobs", {
    uploadId: failed.record.uploadId,
    name: "retried",
  });
  const retryPosted = await bodyOf(retryRes);
  equal("the same upload can be submitted again", retryRes.status, 202);
  const retried = await waitJob(retryPosted.jobId);
  equal("the retried job finishes", retried.body.state, "done");
  equal("the retried upload creates a sticker", retried.body.created, true);
  ok("the upload file survives the retry", existsSync(failedUpload.path));
  equal("the retried conversion leaves no work file", workFiles().length, 0);

  jobs.busy = true;
  const busyUpload = await upload(makeJpeg());
  const busyRecord = await bodyOf(busyUpload);
  res = await http.json("/dashboard/api/stickers/jobs", { uploadId: busyRecord.uploadId });
  body = await bodyOf(res);
  jobs.busy = false;
  equal("a full queue is 429", res.status, 429);
  equal("busy code", body.code, "BUSY");
  equal("a refused job leaves no work file", workFiles().length, 0);

  const bot = studio.createFromBuffer({
    owner: owner.forPanel(),
    buffer: makeJpeg(),
    source: "BOT_COMMAND",
    name: "from the bot",
  });
  const botResult = await bot.promise;
  equal("a bot buffer is converted", botResult.created, true);
  ok("a bot conversion reads a work file", String(media.calls.at(-1).inputPath).includes("work-"));
  equal("the bot work file is removed", workFiles().length, 0);

  jobs.busy = true;
  let busyBot = null;
  try {
    studio.createFromBuffer({
      owner: owner.forPanel(),
      buffer: makeJpeg(),
      source: "BOT_COMMAND",
    });
  } catch (error) {
    busyBot = error;
  }
  jobs.busy = false;
  equal("a full queue refuses a bot conversion", busyBot?.code, "BUSY");
  equal("a refused bot conversion leaves no work file", workFiles().length, 0);

  const animatedBytes = makeWebp(80, 80, "motion", true);
  const animated = await createFrom(animatedBytes, { job: { name: "Motion" } });
  equal("an animated webp is kept", animated.done.body.sticker.animated, true);
  const animatedId = animated.done.body.sticker.id;

  section("listing, search, and favorites");

  res = await http.call(
    `/dashboard/api/stickers?q=${encodeURIComponent("Percent%_name")}&sort=name`,
  );
  body = await bodyOf(res);
  equal("search finds the named sticker", body.total, 1);
  equal("search returns that sticker", body.items[0].id, keptId);

  res = await http.call("/dashboard/api/stickers?q=_");
  body = await bodyOf(res);
  equal("an underscore is not a wildcard", body.total, 1);
  equal("the underscore hit is the named sticker", body.items[0].id, keptId);

  res = await http.json(`/dashboard/api/stickers/${jpegId}`, { favorite: true }, "PATCH");
  body = await bodyOf(res);
  equal("favorite is set", res.status, 200);
  equal("the sticker is a favorite", body.favorite, true);

  res = await http.call("/dashboard/api/stickers?filter=favorites");
  body = await bodyOf(res);
  ok(
    "the favorites filter returns it",
    body.items.some((item) => item.id === jpegId),
  );
  ok(
    "the favorites filter skips the rest",
    body.items.every((item) => item.favorite),
  );

  res = await http.call("/dashboard/api/stickers?filter=animated");
  body = await bodyOf(res);
  ok(
    "the animated filter returns the motion sticker",
    body.items.some((item) => item.id === animatedId) && body.items.every((item) => item.animated),
  );

  res = await http.json(`/dashboard/api/stickers/${"ab".repeat(8)}`, { name: "nope" }, "PATCH");
  body = await bodyOf(res);
  equal("a missing sticker is 404", res.status, 404);
  equal("missing sticker code", body.code, "NOT_FOUND");

  res = await http.json("/dashboard/api/stickers/not-an-id", { name: "nope" }, "PATCH");
  body = await bodyOf(res);
  equal("a malformed id is 400", res.status, 400);
  equal("malformed id code", body.code, "INVALID_OPTIONS");

  section("packs");

  res = await http.json("/dashboard/api/sticker-packs", { name: "Cats" });
  body = await bodyOf(res);
  equal("a pack is created", res.status, 201);
  equal("the pack is named Cats", body.name, "Cats");
  const catsId = body.id;

  res = await http.json(`/dashboard/api/sticker-packs/${catsId}`, { name: "cats" }, "PATCH");
  body = await bodyOf(res);
  equal("a case-only rename is allowed", res.status, 200);
  equal("the rename keeps the id", body.id, catsId);
  equal("the new casing is stored", body.name, "cats");

  res = await http.json("/dashboard/api/sticker-packs", { name: "CATS" });
  body = await bodyOf(res);
  equal("a duplicate key is 409", res.status, 409);
  equal("duplicate code", body.code, "PACK_EXISTS");

  res = await http.json("/dashboard/api/sticker-packs", { name: "list" });
  body = await bodyOf(res);
  equal("a reserved word is 400", res.status, 400);
  equal("reserved code", body.code, "INVALID_NAME");

  res = await http.json("/dashboard/api/sticker-packs", { name: "حذف" });
  body = await bodyOf(res);
  equal("an arabic command word is reserved", res.status, 400);
  equal("arabic reserved code", body.code, "INVALID_NAME");

  res = await http.json("/dashboard/api/sticker-packs", { name: "bad/name" });
  body = await bodyOf(res);
  equal("punctuation is an invalid pack name", res.status, 400);

  res = await http.json("/dashboard/api/sticker-packs", { name: "قطط" });
  body = await bodyOf(res);
  equal("an arabic pack name is accepted", res.status, 201);
  const arabicId = body.id;

  res = await http.json("/dashboard/api/stickers/bulk", {
    action: "addToPack",
    ids: [jpegId, animatedId],
    packId: catsId,
  });
  body = await bodyOf(res);
  equal("two stickers join the pack", body.affected, 2);

  res = await http.json("/dashboard/api/stickers/bulk", {
    action: "addToPack",
    ids: [jpegId],
    packId: arabicId,
  });
  body = await bodyOf(res);
  equal("adding to a second pack copies", body.affected, 1);

  res = await http.call(`/dashboard/api/sticker-packs/${catsId}`);
  body = await bodyOf(res);
  equal("the pack lists both stickers", body.items.length, 2);
  ok("the cover points at a member", typeof body.pack.coverUrl === "string");

  const flipped = [body.items[1].id, body.items[0].id];
  res = await http.json(`/dashboard/api/sticker-packs/${catsId}/order`, { ids: flipped }, "PUT");
  equal("reorder accepts a permutation", res.status, 200);
  await bodyOf(res);

  res = await http.call(`/dashboard/api/sticker-packs/${catsId}`);
  body = await bodyOf(res);
  equal("the first item moved", body.items[0].id, flipped[0]);
  equal("the second item moved", body.items[1].id, flipped[1]);

  res = await http.json(
    `/dashboard/api/sticker-packs/${catsId}/order`,
    { ids: [flipped[0]] },
    "PUT",
  );
  body = await bodyOf(res);
  equal("a partial order is rejected", res.status, 400);
  equal("partial order code", body.code, "INVALID_OPTIONS");

  res = await http.call(`/dashboard/api/sticker-packs/${catsId}`);
  body = await bodyOf(res);
  equal("a rejected reorder changes nothing", body.items[0].id, flipped[0]);

  res = await http.json("/dashboard/api/sticker-packs", { name: "Dogs" });
  const dogsId = (await bodyOf(res)).id;
  res = await http.json("/dashboard/api/stickers/bulk", {
    action: "moveToPack",
    ids: [jpegId],
    packId: dogsId,
    fromPackId: catsId,
  });
  body = await bodyOf(res);
  equal("move reports the sticker", body.affected, 1);

  res = await http.call(`/dashboard/api/stickers?pack=${catsId}`);
  body = await bodyOf(res);
  ok(
    "move took the sticker out of the source pack",
    body.items.every((item) => item.id !== jpegId),
  );
  res = await http.call(`/dashboard/api/stickers?pack=${arabicId}`);
  body = await bodyOf(res);
  ok(
    "move from one pack left the other membership",
    body.items.some((item) => item.id === jpegId),
  );

  const extraSticker = await createFrom(makeWebp(20, 20, "extra-one"), { job: { name: "Extra" } });
  const extraId = extraSticker.done.body.sticker.id;
  res = await http.json("/dashboard/api/sticker-packs", { name: "Extra pack" });
  const extraPackId = (await bodyOf(res)).id;
  await bodyOf(
    await http.json("/dashboard/api/stickers/bulk", {
      action: "addToPack",
      ids: [extraId, animatedId],
      packId: extraPackId,
    }),
  );

  res = await http.json(`/dashboard/api/sticker-packs/${extraPackId}/merge`, {
    intoPackId: catsId,
  });
  body = await bodyOf(res);
  equal("merge appends only the new sticker", body.moved, 1);
  equal("merge returns the target", body.pack.id, catsId);

  res = await http.call(`/dashboard/api/sticker-packs/${extraPackId}`);
  body = await bodyOf(res);
  equal("the source pack is gone", res.status, 404);
  equal("a missing pack is PACK_NOT_FOUND", body.code, "PACK_NOT_FOUND");

  res = await http.call(`/dashboard/api/stickers/${extraId}/file`);
  equal("merge does not delete the sticker", res.status, 200);
  await res.arrayBuffer();

  res = await http.call(`/dashboard/api/sticker-packs/${catsId}`);
  body = await bodyOf(res);
  const mergedIds = body.items.map((item) => item.id);
  equal("the duplicate stayed a single row", mergedIds.filter((id) => id === animatedId).length, 1);
  ok("the new sticker was appended", mergedIds.at(-1) === extraId);

  section("deletion rules");

  res = await http.call(`/dashboard/api/stickers/${jpegId}`, { method: "DELETE" });
  body = await bodyOf(res);
  equal("deleting a packed sticker needs confirm", res.status, 409);
  equal("in-use code", body.code, "IN_USE");
  ok(
    "the pack is named",
    body.packs.some((pack) => pack.id === arabicId),
  );

  res = await http.json("/dashboard/api/stickers/bulk", {
    action: "delete",
    ids: [jpegId],
    confirm: 1,
  });
  body = await bodyOf(res);
  equal("confirm must be a boolean", res.status, 400);
  equal("numeric confirm code", body.code, "INVALID_OPTIONS");

  res = await http.json("/dashboard/api/stickers/bulk", {
    action: "delete",
    ids: [jpegId],
    confirm: "true",
  });
  body = await bodyOf(res);
  equal("a string confirm is refused", res.status, 400);

  res = await http.call(`/dashboard/api/stickers/${jpegId}?confirm=1`, { method: "DELETE" });
  body = await bodyOf(res);
  equal("confirm=1 deletes it", res.status, 200);
  ok("the id is in deleted", body.deleted.includes(jpegId));

  res = await http.call(`/dashboard/api/sticker-packs/${arabicId}`, { method: "DELETE" });
  body = await bodyOf(res);
  equal("deleting a pack keeps stickers", res.status, 200);
  equal("no sticker was deleted with the pack", body.deletedStickers.length, 0);

  res = await http.call(`/dashboard/api/sticker-packs/${dogsId}?deleteStickers=1`, {
    method: "DELETE",
  });
  body = await bodyOf(res);
  // The member was already deleted, so the pack has nothing exclusive left.
  equal("an empty pack deletes no stickers", body.deletedStickers.length, 0);

  const lone = await createFrom(makeWebp(22, 22, "lone"), { job: { name: "Lone" } });
  const loneId = lone.done.body.sticker.id;
  const shared = await createFrom(makeWebp(22, 22, "shared"), { job: { name: "Shared" } });
  const sharedId = shared.done.body.sticker.id;
  res = await http.json("/dashboard/api/sticker-packs", { name: "Only" });
  const onlyId = (await bodyOf(res)).id;
  res = await http.json("/dashboard/api/sticker-packs", { name: "Also" });
  const alsoId = (await bodyOf(res)).id;
  await bodyOf(
    await http.json("/dashboard/api/stickers/bulk", {
      action: "addToPack",
      ids: [loneId, sharedId],
      packId: onlyId,
    }),
  );
  await bodyOf(
    await http.json("/dashboard/api/stickers/bulk", {
      action: "addToPack",
      ids: [sharedId],
      packId: alsoId,
    }),
  );
  res = await http.call(`/dashboard/api/sticker-packs/${onlyId}?deleteStickers=1`, {
    method: "DELETE",
  });
  body = await bodyOf(res);
  ok("the exclusive sticker is deleted", body.deletedStickers.includes(loneId));
  ok("the shared sticker is kept", !body.deletedStickers.includes(sharedId));
  res = await http.call(`/dashboard/api/stickers/${sharedId}/file`);
  equal("the shared sticker file is still there", res.status, 200);
  await res.arrayBuffer();

  res = await http.json("/dashboard/api/stickers/bulk", {
    action: "removeFromPack",
    ids: [sharedId],
    packId: alsoId,
  });
  body = await bodyOf(res);
  equal("remove drops only the membership", body.affected, 1);
  res = await http.call(`/dashboard/api/stickers/${sharedId}/file`);
  equal("remove does not delete the sticker", res.status, 200);
  await res.arrayBuffer();

  section("another owner is invisible");

  const stranger = { key: "201555000111@s.whatsapp.net" };
  const hidden = library.saveSticker(stranger, {
    buffer: makeWebp(30, 30, "hidden-bytes"),
    thumbBuffer: makeWebp(8, 8, "hidden-thumb"),
    width: 30,
    height: 30,
    animated: false,
    durationMs: 0,
    sourceMime: "image/webp",
    source: "WHATSAPP_STICKER",
    name: "Hidden",
  });
  const hiddenId = hidden.sticker.id;
  const hiddenPack = library.createPack(stranger, "Secret");

  res = await http.call("/dashboard/api/stickers?q=Hidden");
  body = await bodyOf(res);
  equal("the list hides the other owner", body.total, 0);

  res = await http.call(`/dashboard/api/stickers/${hiddenId}/file`);
  body = await bodyOf(res);
  equal("the file route hides the other owner", res.status, 404);
  equal("file miss code", body.code, "NOT_FOUND");

  res = await http.call(`/dashboard/api/stickers/${hiddenId}/export?format=png`);
  body = await bodyOf(res);
  equal("export hides the other owner", res.status, 404);
  equal("export miss code", body.code, "NOT_FOUND");

  res = await http.json(`/dashboard/api/stickers/${hiddenId}`, { favorite: true }, "PATCH");
  body = await bodyOf(res);
  equal("favorite hides the other owner", res.status, 404);

  res = await http.call(`/dashboard/api/stickers/${hiddenId}?confirm=1`, { method: "DELETE" });
  body = await bodyOf(res);
  equal("delete hides the other owner", res.status, 404);

  res = await http.json("/dashboard/api/stickers/bulk", {
    action: "favorite",
    ids: [hiddenId],
  });
  body = await bodyOf(res);
  equal("bulk skips the other owner", body.skipped[0]?.code, "NOT_FOUND");
  equal("bulk did not affect it", body.affected, 0);

  res = await http.json("/dashboard/api/stickers/bulk", {
    action: "addToPack",
    ids: [keptId],
    packId: hiddenPack.id,
  });
  body = await bodyOf(res);
  equal("adding to another owner's pack is PACK_NOT_FOUND", res.status, 404);
  equal("foreign pack code", body.code, "PACK_NOT_FOUND");

  res = await http.call(`/dashboard/api/sticker-packs/${hiddenPack.id}`);
  body = await bodyOf(res);
  equal("reading another owner's pack is PACK_NOT_FOUND", body.code, "PACK_NOT_FOUND");

  res = await http.json(`/dashboard/api/sticker-packs/${hiddenPack.id}/order`, { ids: [] }, "PUT");
  body = await bodyOf(res);
  equal("reordering another owner's pack is PACK_NOT_FOUND", body.code, "PACK_NOT_FOUND");

  res = await http.json(`/dashboard/api/sticker-packs/${hiddenPack.id}/merge`, {
    intoPackId: catsId,
  });
  body = await bodyOf(res);
  equal("merging another owner's pack is PACK_NOT_FOUND", body.code, "PACK_NOT_FOUND");

  const foreign = studio.createFromBuffer({
    owner: stranger,
    buffer: makeWebp(40, 40, "foreign-job"),
    source: "WHATSAPP_STICKER",
  });
  res = await http.call(`/dashboard/api/stickers/jobs/${foreign.jobId}`);
  body = await bodyOf(res);
  equal("polling another owner's job is 404", res.status, 404);
  equal("foreign job code", body.code, "NOT_FOUND");
  ok("the foreign job body has no sticker", body.sticker === undefined);
  await foreign.promise;
  equal("a kept bot webp writes no work file", workFiles().length, 0);

  res = await http.call(`/dashboard/api/stickers/jobs/${kept.posted.jobId}`);
  body = await bodyOf(res);
  equal("the operator can still poll their own job", res.status, 200);
  equal("the own job is done", body.state, "done");

  section("export and send");

  const beforeWebpFile = jobs.submits.length;
  res = await http.call(`/dashboard/api/stickers/${keptId}/export?format=webp`);
  equal("webp export status", res.status, 200);
  equal("webp export type", res.headers.get("content-type"), "image/webp");
  equal("a webp export does not queue a conversion", jobs.submits.length, beforeWebpFile);
  await res.arrayBuffer();

  const beforeWebpZip = jobs.submits.length;
  res = await http.json("/dashboard/api/stickers/export", {
    ids: [keptId, animatedId],
    format: "webp",
  });
  equal("zip export status", res.status, 200);
  ok("zip content type", (res.headers.get("content-type") || "").includes("application/zip"));
  const names = readZip(Buffer.from(await res.arrayBuffer()));
  equal("the zip has both stickers", names.length, 2);
  ok(
    "entry names come from the stickers",
    names.some((name) => name.includes("Percent")) && names.some((name) => name.includes("Motion")),
  );
  equal("a webp zip does not queue a conversion", jobs.submits.length, beforeWebpZip);

  const beforePng = jobs.submits.length;
  res = await http.call(`/dashboard/api/stickers/${animatedId}/export?format=png`);
  equal("png export status", res.status, 200);
  equal("an animated png is marked", res.headers.get("x-levix-animated"), "1");
  equal("a png export queues one conversion", jobs.submits.length, beforePng + 1);
  equal("a png export is an export job", jobs.submits.at(-1).kind, "export");
  await res.arrayBuffer();

  const beforeStaticGif = jobs.submits.length;
  res = await http.call(`/dashboard/api/stickers/${keptId}/export?format=gif`);
  body = await bodyOf(res);
  equal("gif of a static sticker is 400", res.status, 400);
  equal("static gif code", body.code, "INVALID_OPTIONS");
  equal("a static gif takes no queue slot", jobs.submits.length, beforeStaticGif);

  const beforeGif = jobs.submits.length;
  res = await http.call(`/dashboard/api/stickers/${animatedId}/export?format=gif`);
  equal("gif of an animated sticker is 200", res.status, 200);
  equal("gif content type", res.headers.get("content-type"), "image/gif");
  equal("a gif export queues one conversion", jobs.submits.length, beforeGif + 1);
  equal("a gif export is an export job", jobs.submits.at(-1).kind, "export");
  await res.arrayBuffer();

  jobs.busy = true;
  const beforeBusyExport = jobs.submits.length;
  res = await http.call(`/dashboard/api/stickers/${animatedId}/export?format=png`);
  body = await bodyOf(res);
  equal("a busy png export is 429", res.status, 429);
  equal("busy png export code", body.code, "BUSY");
  res = await http.json("/dashboard/api/stickers/export", {
    ids: [keptId, animatedId],
    format: "png",
  });
  body = await bodyOf(res);
  equal("a busy png zip is 429", res.status, 429);
  equal("busy png zip code", body.code, "BUSY");
  equal("a refused export is not queued", jobs.submits.length, beforeBusyExport);
  jobs.busy = false;

  const beforePngZip = jobs.submits.length;
  res = await http.json("/dashboard/api/stickers/export", {
    ids: [keptId, animatedId],
    format: "png",
  });
  equal("png zip status", res.status, 200);
  ok("png zip content type", (res.headers.get("content-type") || "").includes("application/zip"));
  const pngNames = readZip(Buffer.from(await res.arrayBuffer()));
  equal("the png zip has both stickers", pngNames.length, 2);
  equal("a png zip is one queued conversion", jobs.submits.length, beforePngZip + 1);
  equal("a png zip is an export job", jobs.submits.at(-1).kind, "export");

  const tooMany = Array.from({ length: 201 }, (_, i) => i.toString(16).padStart(16, "0"));
  res = await http.json("/dashboard/api/stickers/export", { ids: tooMany, format: "webp" });
  body = await bodyOf(res);
  equal("export refuses more than the cap", res.status, 400);

  res = await http.json("/dashboard/api/stickers/send", {
    ids: [keptId],
    jid: "201000000000@s.whatsapp.net",
  });
  body = await bodyOf(res);
  equal("send without a socket is 503", res.status, 503);
  equal("not connected code", body.code, "NOT_CONNECTED");

  const sent = [];
  stickerApi.setSession({
    socket: {
      async sendMessage(jid, message) {
        sent.push({ jid, message });
      },
    },
  });
  res = await http.json("/dashboard/api/stickers/send", {
    ids: [animatedId],
    jid: "201000000000@s.whatsapp.net",
  });
  body = await bodyOf(res);
  equal("send reports one sticker", res.status, 200);
  equal("sent count", body.sent, 1);
  equal("send used the jid", sent[0].jid, "201000000000@s.whatsapp.net");
  const meta = sent[0].message.sticker.toString("utf8");
  ok("metadata names the pack", meta.startsWith("cats|"));
  ok("metadata names the brand", meta.includes("|Levix|"));

  res = await http.call("/dashboard/api/stickers?q=Motion");
  body = await bodyOf(res);
  ok("send touches lastUsedAt", typeof body.items[0]?.lastUsedAt === "number");

  section("the library cap is enforced inside the job");

  res = await http.call("/dashboard/api/stickers?limit=1");
  body = await bodyOf(res);
  settings.set("sticker_library_limit", body.total);
  const blocked = await createFrom(makeJpeg(), { job: { name: "one too many" } });
  equal("a full library fails the job", blocked.done.body.state, "failed");
  equal("the job error is LIBRARY_FULL", blocked.done.body.error.code, "LIBRARY_FULL");
  const deduped = await createFrom(keptBytes);
  equal("a duplicate still saves when the library is full", deduped.done.body.created, false);
  settings.set("sticker_library_limit", null);

  ok("the temp data dir was used", typeof dataDir === "string");
} catch (error) {
  ok("the api test ran", false, error?.stack || String(error));
} finally {
  server.closeAllConnections?.();
  io.close();
  server.close();
  finish();
}

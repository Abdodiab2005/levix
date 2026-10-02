// RIFF/WebP parsing and metadata stay in Buffer code. FFmpeg 7 skips ANMF,
// so the converter extracts each animated frame as a static WebP for decoding.
const { createHash } = require("node:crypto");
const { StickerError } = require("./errors.cjs");

function corrupt() {
  throw new StickerError("CORRUPT");
}

function chunk(type, payload) {
  const out = Buffer.alloc(8 + payload.length + (payload.length & 1));
  out.write(type, 0, 4, "ascii");
  out.writeUInt32LE(payload.length, 4);
  payload.copy(out, 8);
  return out;
}

function riff(chunks) {
  const size = chunks.reduce((n, item) => n + item.length, 4);
  const out = Buffer.alloc(8);
  out.write("RIFF", 0);
  out.writeUInt32LE(size, 4);
  return Buffer.concat([out, Buffer.from("WEBP"), ...chunks]);
}

function parse(buffer) {
  const riffEnd = Buffer.isBuffer(buffer) && buffer.length >= 8 ? buffer.readUInt32LE(4) + 8 : 0;
  if (
    !Buffer.isBuffer(buffer) ||
    buffer.length < 20 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WEBP" ||
    riffEnd < 20 ||
    riffEnd > buffer.length
  ) {
    corrupt();
  }
  const chunks = [];
  for (let at = 12; at < riffEnd; ) {
    if (at + 8 > riffEnd) corrupt();
    const type = buffer.toString("ascii", at, at + 4);
    const len = buffer.readUInt32LE(at + 4);
    const end = at + 8 + len;
    if (end > riffEnd || end + (len & 1) > riffEnd) corrupt();
    chunks.push({
      type,
      data: buffer.subarray(at + 8, end),
      raw: buffer.subarray(at, end + (len & 1)),
    });
    at = end + (len & 1);
  }
  let width = 0;
  let height = 0;
  let alpha = false;
  let animated = false;
  let loopCount = 0;
  const frames = [];
  const first = chunks[0];
  if (!first) corrupt();
  if (first.type === "VP8X") {
    if (first.data.length !== 10) corrupt();
    // VP8X stores alpha in bit 4 and animation in bit 1.
    const flags = first.data[0];
    alpha = !!(flags & 0x10);
    animated = !!(flags & 0x02);
    width = first.data.readUIntLE(4, 3) + 1;
    height = first.data.readUIntLE(7, 3) + 1;
  } else if (first.type === "VP8 ") {
    if (
      first.data.length < 10 ||
      first.data[3] !== 0x9d ||
      first.data[4] !== 0x01 ||
      first.data[5] !== 0x2a
    ) {
      corrupt();
    }
    width = first.data.readUInt16LE(6) & 0x3fff;
    height = first.data.readUInt16LE(8) & 0x3fff;
  } else if (first.type === "VP8L") {
    if (first.data.length < 5 || first.data[0] !== 0x2f) corrupt();
    const bits = first.data.readUInt32LE(1);
    width = (bits & 0x3fff) + 1;
    height = ((bits >>> 14) & 0x3fff) + 1;
    alpha = !!(bits & 0x10000000);
  } else corrupt();
  if (!width || !height) corrupt();
  const anim = chunks.find((c) => c.type === "ANIM");
  if (animated) {
    if (anim?.data.length !== 6) corrupt();
    loopCount = anim.data.readUInt16LE(4);
    for (const c of chunks.filter((item) => item.type === "ANMF")) {
      const d = c.data;
      if (d.length < 24) corrupt();
      // ANMF positions are half-pixel units; width and height are minus one.
      const x = d.readUIntLE(0, 3) * 2;
      const y = d.readUIntLE(3, 3) * 2;
      const w = d.readUIntLE(6, 3) + 1;
      const h = d.readUIntLE(9, 3) + 1;
      if (x + w > width || y + h > height) corrupt();
      const parts = [];
      for (let at = 16; at < d.length; ) {
        if (at + 8 > d.length) corrupt();
        const len = d.readUInt32LE(at + 4);
        const end = at + 8 + len;
        if (end + (len & 1) > d.length) corrupt();
        parts.push({ type: d.toString("ascii", at, at + 4), raw: d.subarray(at, end + (len & 1)) });
        at = end + (len & 1);
      }
      if (!parts.some((p) => p.type === "VP8 " || p.type === "VP8L")) corrupt();
      frames.push({
        x,
        y,
        width: w,
        height: h,
        durationMs: d.readUIntLE(12, 3),
        blend: !(d[15] & 2),
        dispose: !!(d[15] & 1),
        parts,
      });
    }
    if (!frames.length) corrupt();
  } else if (!chunks.some((c) => c.type === "VP8 " || c.type === "VP8L")) corrupt();
  return {
    width,
    height,
    alpha,
    animated,
    loopCount,
    frames,
    chunks,
    durationMs: frames.reduce((n, f) => n + f.durationMs, 0),
  };
}

function extractFrame(buffer, index) {
  const meta = parse(buffer);
  const frame = meta.frames[index];
  if (!frame) corrupt();
  const payload = Buffer.alloc(10);
  payload[0] = frame.parts.some((p) => p.type === "ALPH" || p.type === "VP8L") ? 0x10 : 0;
  payload.writeUIntLE(frame.width - 1, 4, 3);
  payload.writeUIntLE(frame.height - 1, 7, 3);
  return riff([chunk("VP8X", payload), ...frame.parts.map((p) => p.raw)]);
}

function metadata(buffer, { packId, packName, publisher, emojis = [] }) {
  const meta = parse(buffer);
  const id =
    packId ??
    createHash("sha256")
      .update(JSON.stringify([packName, publisher]))
      .digest("hex")
      .slice(0, 32);
  const json = Buffer.from(
    JSON.stringify({
      "sticker-pack-id": id,
      "sticker-pack-name": packName,
      "sticker-pack-publisher": publisher,
      emojis,
    }),
    "utf8",
  );
  const tiff = Buffer.alloc(8 + 2 + 12 + 4 + json.length);
  tiff.write("II", 0);
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x5741, 10);
  tiff.writeUInt16LE(7, 12);
  tiff.writeUInt32LE(json.length, 14);
  tiff.writeUInt32LE(26, 18);
  json.copy(tiff, 26);
  const source = meta.chunks.filter((c) => c.type !== "EXIF");
  const first = source[0];
  const vp8x = Buffer.alloc(10);
  if (first.type === "VP8X") first.data.copy(vp8x);
  vp8x[0] |= 0x08;
  if (meta.alpha) vp8x[0] |= 0x10;
  if (meta.animated) vp8x[0] |= 0x02;
  vp8x.writeUIntLE(meta.width - 1, 4, 3);
  vp8x.writeUIntLE(meta.height - 1, 7, 3);
  const rest = source.slice(first.type === "VP8X" ? 1 : 0).map((c) => c.raw);
  const xmp = rest.findIndex((c) => c.toString("ascii", 0, 4) === "XMP ");
  rest.splice(xmp < 0 ? rest.length : xmp, 0, chunk("EXIF", tiff));
  return riff([chunk("VP8X", vp8x), ...rest]);
}

function readMetadata(buffer) {
  const exif = parse(buffer).chunks.find((c) => c.type === "EXIF")?.data;
  if (
    !exif ||
    exif.length < 26 ||
    exif.toString("ascii", 0, 2) !== "II" ||
    exif.readUInt16LE(8) !== 1 ||
    exif.readUInt16LE(10) !== 0x5741 ||
    exif.readUInt16LE(12) !== 7
  ) {
    return null;
  }
  const len = exif.readUInt32LE(14);
  const offset = exif.readUInt32LE(18);
  if (offset + len > exif.length) corrupt();
  try {
    return JSON.parse(exif.toString("utf8", offset, offset + len));
  } catch {
    corrupt();
  }
}

module.exports = { parse, extractFrame, metadata, readMetadata };

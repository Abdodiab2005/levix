// A store-only ZIP (method 0). The sticker export is a handful of already
// compressed WebP/PNG files, so deflate would cost CPU and save nothing.
// Node 24's zlib.crc32 is the checksum; names are flagged UTF-8 so an Arabic
// sticker name round-trips.

const zlib = require("node:zlib");

function dosDateTime(date) {
  const when = date instanceof Date ? date : new Date();
  const year = Math.max(1980, when.getFullYear());
  const dosTime =
    (when.getHours() << 11) | (when.getMinutes() << 5) | Math.floor(when.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
  return { dosTime, dosDate };
}

function uniqueName(name, used) {
  const leaf = String(name || "sticker")
    .replace(/\\/g, "/")
    .split("/")
    .pop();
  let base = leaf.replace(/\p{Cc}/gu, "").replace(/^\.+/, "");
  if (!base) base = "sticker";
  if ([...base].length > 180) base = [...base].slice(0, 180).join("");
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  let n = 2;
  while (used.has(`${stem}-${n}${ext}`)) n += 1;
  const next = `${stem}-${n}${ext}`;
  used.add(next);
  return next;
}

/**
 * @param {{ name: string, data: Buffer }[]} entries
 * @param {Date} [now]
 * @returns {Buffer}
 */
function zipStore(entries, now = new Date()) {
  const { dosTime, dosDate } = dosDateTime(now);
  const parts = [];
  const centrals = [];
  const used = new Set();
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(uniqueName(entry.name, used), "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data || "");
    const crc = zlib.crc32(data) >>> 0;

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    parts.push(local, data);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length + data.length;
  }

  const centralDir = centrals.length ? Buffer.concat(centrals) : Buffer.alloc(0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, centralDir, eocd]);
}

module.exports = { zipStore };

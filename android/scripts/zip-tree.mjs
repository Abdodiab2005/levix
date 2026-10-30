// Byte-reproducible zip of a directory. Entry order, times and modes are fixed,
// so two builds of the same tree are the same bytes. Android's ZipInputStream
// reads sizes and the CRC from the local header, so bit 3 (data descriptor)
// stays clear.
import { lstatSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const VERSION_NEEDED = 20;
const VERSION_MADE_BY = 0x0314;
const DOS_TIME = 0;
const DOS_DATE = 0x0021;
const FLAG_UTF8 = 0x0800;
const ZIP32_MAX = 0xffffffff;
// Unix mode lives in the high 16 bits. 0o100644 << 16 exceeds 2^31-1, so the
// shift is forced unsigned before it is stored.
const FILE_ATTR = (0o100644 << 16) >>> 0;
const DIR_ATTR = ((0o040755 << 16) | 0x10) >>> 0;

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

function isAscii(name) {
  for (let i = 0; i < name.length; i += 1) {
    if (name.charCodeAt(i) > 0x7f) return false;
  }
  return true;
}

function assertZip32(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > ZIP32_MAX) {
    throw new Error(`${label} needs ZIP64 (${value})`);
  }
}

function u16(value) {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(value, 0);
  return buf;
}

function u32(value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value >>> 0, 0);
  return buf;
}

// Symlinks and special files have no single byte content to store.
function classifyPath(full) {
  const st = lstatSync(full);
  if (st.isSymbolicLink()) throw new Error(`refusing symlink: ${full}`);
  if (st.isDirectory()) return "dir";
  if (st.isFile()) return "file";
  throw new Error(`refusing special file: ${full}`);
}

function walk(root, current, entries) {
  const kind = classifyPath(current);
  if (current !== root) {
    const rel = relative(root, current).split(sep).join("/");
    if (rel === "" || rel.startsWith("..")) {
      throw new Error(`refusing path outside the tree: ${current}`);
    }
    if (kind === "dir") entries.push({ name: `${rel}/`, dir: true });
    else entries.push({ name: rel, dir: false, data: readFileSync(current) });
  }
  if (kind !== "dir") return;
  for (const name of readdirSync(current)) walk(root, join(current, name), entries);
}

function entryBytes(entry) {
  if (entry.dir) {
    return { method: 0, crc: 0, payload: Buffer.alloc(0), uncompressed: 0 };
  }
  const data = entry.data;
  const deflated = deflateRawSync(data, { level: 9 });
  // Store when deflate does not shrink the file. Equal length is not a win.
  if (deflated.length < data.length) {
    return { method: 8, crc: crc32(data) >>> 0, payload: deflated, uncompressed: data.length };
  }
  return { method: 0, crc: crc32(data) >>> 0, payload: data, uncompressed: data.length };
}

function localHeader(nameBuf, flags, method, crc, compressed, uncompressed) {
  return Buffer.concat([
    u32(SIG_LOCAL),
    u16(VERSION_NEEDED),
    u16(flags),
    u16(method),
    u16(DOS_TIME),
    u16(DOS_DATE),
    u32(crc),
    u32(compressed),
    u32(uncompressed),
    u16(nameBuf.length),
    u16(0),
    nameBuf,
  ]);
}

function centralHeader(nameBuf, flags, method, crc, compressed, uncompressed, attr, offset) {
  return Buffer.concat([
    u32(SIG_CENTRAL),
    u16(VERSION_MADE_BY),
    u16(VERSION_NEEDED),
    u16(flags),
    u16(method),
    u16(DOS_TIME),
    u16(DOS_DATE),
    u32(crc),
    u32(compressed),
    u32(uncompressed),
    u16(nameBuf.length),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(attr),
    u32(offset),
    nameBuf,
  ]);
}

function buildZip(entries) {
  // 0xFFFF is the ZIP64 sentinel. size-report.mjs rejects that count, so ZIP32 stops at 65,534.
  if (entries.length >= 0xffff) {
    throw new Error(`entry count needs ZIP64 (${entries.length})`);
  }
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    if (nameBuf.length > 0xffff) {
      throw new Error(`${entry.name}: name does not fit in a ZIP32 header`);
    }
    const flags = isAscii(entry.name) ? 0 : FLAG_UTF8;
    const packed = entryBytes(entry);
    assertZip32(packed.payload.length, `${entry.name}: compressed size`);
    assertZip32(packed.uncompressed, `${entry.name}: uncompressed size`);
    assertZip32(offset, `${entry.name}: local header offset`);
    const header = localHeader(
      nameBuf,
      flags,
      packed.method,
      packed.crc,
      packed.payload.length,
      packed.uncompressed,
    );
    const local = Buffer.concat([header, packed.payload]);
    localParts.push(local);
    centralParts.push(
      centralHeader(
        nameBuf,
        flags,
        packed.method,
        packed.crc,
        packed.payload.length,
        packed.uncompressed,
        entry.dir ? DIR_ATTR : FILE_ATTR,
        offset,
      ),
    );
    offset += local.length;
    assertZip32(offset, "archive offset");
  }
  const central = centralParts.length === 0 ? Buffer.alloc(0) : Buffer.concat(centralParts);
  assertZip32(central.length, "central directory size");
  assertZip32(offset, "central directory offset");
  const eocd = Buffer.concat([
    u32(SIG_EOCD),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(central.length),
    u32(offset),
    u16(0),
  ]);
  return Buffer.concat([...localParts, central, eocd]);
}

// Zip of `dir`'s contents. The directory itself is not an entry.
export function zipTree(dir) {
  const root = resolve(dir);
  if (classifyPath(root) !== "dir") throw new Error(`not a directory: ${root}`);
  const entries = [];
  walk(root, root, entries);
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  return buildZip(entries);
}

// Temp file sits next to the destination so rename stays on one filesystem.
export function writeZipFile(dir, outPath) {
  const bytes = zipTree(dir);
  const dest = resolve(outPath);
  const tmp = join(dirname(dest), `.${basename(dest)}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, bytes);
    renameSync(tmp, dest);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  return bytes;
}

if (isDirectRun()) {
  const dir = process.argv[2];
  const out = process.argv[3];
  if (!dir || !out) {
    process.stderr.write("usage: node zip-tree.mjs <dir> <out.zip>\n");
    process.exit(2);
  }
  writeZipFile(dir, out);
}

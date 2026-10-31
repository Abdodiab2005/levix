// zip-tree.mjs writes the same bytes for the same tree, whatever the mtimes and modes.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { inflateRawSync } from "node:zlib";
import { zipTree } from "../android/scripts/zip-tree.mjs";
import { readZip } from "../scripts/size-report.mjs";
import { equal, finish, ok, section, throws } from "./harness.mjs";

const dirs = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "levix-zip-"));
  dirs.push(dir);
  return dir;
}

function restamp(dir) {
  const stamp = new Date("2001-02-03T04:05:06Z");
  const visit = (current) => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      if (lstatSync(full).isDirectory()) visit(full);
      else chmodSync(full, 0o640);
      utimesSync(full, stamp, stamp);
    }
    chmodSync(current, 0o700);
    utimesSync(current, stamp, stamp);
  };
  visit(dir);
}

function nonAscii(name) {
  for (let i = 0; i < name.length; i += 1) {
    if (name.charCodeAt(i) > 0x7f) return true;
  }
  return false;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const HEADER_FIELDS = [
  "versionNeeded",
  "flags",
  "method",
  "time",
  "date",
  "crc",
  "compressedSize",
  "uncompressedSize",
  "name",
];

// Central directory and the local header it points at, read from the bytes themselves.
function zipHeaders(buf) {
  if (buf.length < 22) throw new Error("zip is shorter than an end record");
  let eocd = -1;
  const min = Math.max(0, buf.length - (22 + 0xffff));
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) !== SIG_EOCD) continue;
    const commentLen = buf.readUInt16LE(i + 20);
    if (i + 22 + commentLen === buf.length) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("end of central directory not found");
  const total = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const rows = [];
  for (let n = 0; n < total; n += 1) {
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localStart = localOffset + 30;
    const localName = buf.subarray(localStart, localStart + localNameLen).toString("utf8");
    rows.push({
      central: {
        signature: buf.readUInt32LE(p),
        versionNeeded: buf.readUInt16LE(p + 6),
        flags: buf.readUInt16LE(p + 8),
        method: buf.readUInt16LE(p + 10),
        time: buf.readUInt16LE(p + 12),
        date: buf.readUInt16LE(p + 14),
        crc: buf.readUInt32LE(p + 16),
        compressedSize: buf.readUInt32LE(p + 20),
        uncompressedSize: buf.readUInt32LE(p + 24),
        name,
      },
      local: {
        signature: buf.readUInt32LE(localOffset),
        versionNeeded: buf.readUInt16LE(localOffset + 4),
        flags: buf.readUInt16LE(localOffset + 6),
        method: buf.readUInt16LE(localOffset + 8),
        time: buf.readUInt16LE(localOffset + 10),
        date: buf.readUInt16LE(localOffset + 12),
        crc: buf.readUInt32LE(localOffset + 14),
        compressedSize: buf.readUInt32LE(localOffset + 18),
        uncompressedSize: buf.readUInt32LE(localOffset + 22),
        name: localName,
      },
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return rows;
}

function listFiles(root) {
  const out = [];
  const visit = (current) => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      if (lstatSync(full).isDirectory()) visit(full);
      else out.push(relative(root, full).split(sep).join("/"));
    }
  };
  visit(root);
  return out.sort();
}

section("the same tree zips to the same bytes");

const helloText = "hello ".repeat(80);
const rawBytes = Buffer.from([0x5a]);
const cafeName = `nested/caf\u00e9.txt`;
const dir = tempDir();

try {
  mkdirSync(join(dir, "nested", "sub"), { recursive: true });
  mkdirSync(join(dir, "empty"));
  writeFileSync(join(dir, "nested", "sub", "hello.txt"), helloText);
  writeFileSync(join(dir, "nested", `caf\u00e9.txt`), "tea");
  // One byte is shorter than any deflate stream, so the entry is stored.
  writeFileSync(join(dir, "raw.bin"), rawBytes);

  const first = zipTree(dir);
  restamp(dir);
  const second = zipTree(dir);
  ok("bytes match after mtime and mode changes", first.equals(second));

  section("entry headers are fixed and the payload round-trips");

  const { entries } = readZip(first);
  const names = entries.map((entry) => entry.name);
  const sorted = [...names].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  ok(
    "entries are sorted by UTF-8 name",
    names.every((name, i) => name === sorted[i]),
    names.join(" "),
  );
  for (const name of ["empty/", "nested/", "nested/sub/"]) {
    ok(`${name} is present`, names.includes(name));
  }
  for (const entry of entries) {
    const utf8 = nonAscii(entry.name);
    equal(`${entry.name} flags`, entry.flags, utf8 ? 0x800 : 0);
    equal(`${entry.name} local flags`, entry.localFlags, entry.flags);
    equal(`${entry.name} time`, entry.time, 0);
    equal(`${entry.name} date`, entry.date, 0x0021);
    equal(`${entry.name} local time`, entry.localTime, 0);
    equal(`${entry.name} local date`, entry.localDate, 0x0021);
    ok(`${entry.name} has no data descriptor`, (entry.flags & 0x8) === 0);
    if (entry.name.endsWith("/")) {
      equal(`${entry.name} method`, entry.method, 0);
      equal(`${entry.name} compressed`, entry.compressedSize, 0);
      equal(`${entry.name} uncompressed`, entry.uncompressedSize, 0);
      equal(`${entry.name} crc`, entry.crc, 0);
    }
  }
  ok("bit 11 is set on the non-ASCII name", names.includes(cafeName));
  const hello = entries.find((entry) => entry.name === "nested/sub/hello.txt");
  equal("hello is deflated", hello.method, 8);
  ok(
    "hello inflates to the original",
    inflateRawSync(hello.compressed).equals(Buffer.from(helloText)),
  );
  const raw = entries.find((entry) => entry.name === "raw.bin");
  equal("raw is stored", raw.method, 0);
  ok("raw bytes round-trip", raw.data.equals(rawBytes));

  section("local headers match the central directory");

  const headers = zipHeaders(first);
  equal("header count", headers.length, entries.length);
  for (const row of headers) {
    const label = row.central.name;
    // The two signatures differ by spec. Each must be its own constant.
    equal(`${label} central signature`, row.central.signature, SIG_CENTRAL);
    equal(`${label} local signature`, row.local.signature, SIG_LOCAL);
    for (const field of HEADER_FIELDS) {
      equal(`${label} ${field}`, row.local[field], row.central[field]);
    }
  }

  section("unzip reads the archive");

  const unzip = spawnSync("unzip", ["-v"], { encoding: "utf8" });
  if (unzip.status === 0) {
    const packed = tempDir();
    const extracted = tempDir();
    const zipPath = join(packed, "tree.zip");
    writeFileSync(zipPath, first);
    const tested = spawnSync("unzip", ["-t", zipPath], { encoding: "utf8" });
    equal("unzip -t", tested.status, 0);
    const unpacked = spawnSync("unzip", ["-qq", "-d", extracted, zipPath], { encoding: "utf8" });
    equal("unzip -qq", unpacked.status, 0);
    const sourceFiles = listFiles(dir);
    const extractedFiles = listFiles(extracted);
    equal("unzip file list", extractedFiles.join(","), sourceFiles.join(","));
    for (const rel of sourceFiles) {
      const sourceBytes = readFileSync(join(dir, ...rel.split("/")));
      const extractedBytes = readFileSync(join(extracted, ...rel.split("/")));
      ok(`unzip bytes ${rel}`, extractedBytes.equals(sourceBytes));
    }
  } else {
    console.log("    skip: unzip is not installed");
  }

  section("a symlink is refused");

  const linkDir = tempDir();
  writeFileSync(join(linkDir, "a.txt"), "a");
  symlinkSync("a.txt", join(linkDir, "link.txt"));
  const error = throws("zipTree throws", () => zipTree(linkDir));
  ok("the error names the symlink", error?.message.includes("link.txt") === true);
} finally {
  for (const path of dirs) rmSync(path, { recursive: true, force: true });
}

finish();

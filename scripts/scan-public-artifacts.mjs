// Refuse a public artifact that carries private Levix Plus code.
//
// A public artifact is anything a stranger can download: the npm tarball, the
// SEA executable, the Android levix-app.zip and (at release time) the Docker
// image. Private runtime files start with LEVIX-PLUS-PRIVATE-CANARY and live
// under extensions/levix-plus/ or levix-plus/runtime/. Neither may appear here
// (ADR-002, docs/plans/v5/PHASE-08-PLAN.md section 2.2).
//
//   node scripts/scan-public-artifacts.mjs <path>...
//
// A path may be a directory, a .tgz/.tar.gz, a .zip, or any other file (raw
// bytes, e.g. the SEA binary). Exit 1 on a forbidden path or a canary byte
// string. Only artifact and entry paths are printed, never content.
//
// Node standard library only: node:fs, node:path, node:zlib.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, inflateRawSync } from "node:zlib";

export const CANARY = "LEVIX-PLUS-PRIVATE-CANARY";
export const MAX_ENTRY_BYTES = 256 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

const CANARY_BYTES = Buffer.from(CANARY, "utf8");
const FORBIDDEN_SEQUENCES = ["extensions/levix-plus", "levix-plus/runtime"];
const TAR_BLOCK = 512;
const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const ZIP64 = 0xffffffff;
const ZIP64_COUNT = 0xffff;

function amount(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function human(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${amount(bytes / (1024 * 1024 * 1024))} GiB`;
  if (bytes >= 1024 * 1024) return `${amount(bytes / (1024 * 1024))} MiB`;
  if (bytes >= 1024) return `${amount(bytes / 1024)} KiB`;
  return `${bytes} B`;
}

// One run's work budget. Every decompressed entry and every raw file passes
// through here, so a compression bomb cannot exhaust memory before it fails.
export function createBudget(options = {}) {
  const maxEntryBytes = options.maxEntryBytes ?? MAX_ENTRY_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? MAX_TOTAL_BYTES;
  let used = 0;
  return {
    get used() {
      return used;
    },
    get maxEntryBytes() {
      return maxEntryBytes;
    },
    get maxTotalBytes() {
      return maxTotalBytes;
    },
    use(bytes, label) {
      if (!Number.isSafeInteger(bytes) || bytes < 0) {
        throw new Error(`${label}: invalid entry size`);
      }
      if (bytes > maxEntryBytes) {
        throw new Error(`${label}: entry exceeds ${human(maxEntryBytes)} cap`);
      }
      used += bytes;
      if (used > maxTotalBytes) {
        throw new Error(`${label}: total work exceeds ${human(maxTotalBytes)} cap`);
      }
    },
  };
}

function segments(name) {
  return String(name)
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part !== "" && part !== ".");
}

// A path is forbidden when two adjacent segments spell one of the private
// locations, wherever they sit in the tree.
export function hasForbiddenPath(name) {
  const parts = segments(name);
  for (let index = 0; index < parts.length - 1; index += 1) {
    const pair = `${parts[index]}/${parts[index + 1]}`;
    if (FORBIDDEN_SEQUENCES.includes(pair)) return true;
  }
  return false;
}

export function containsCanary(data) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");
  return bytes.indexOf(CANARY_BYTES) !== -1;
}

function resultFor(artifact, kind) {
  return {
    artifact,
    kind,
    entries: 0,
    bytes: 0,
    findings: [],
    error: null,
    get ok() {
      return this.findings.length === 0 && this.error === null;
    },
  };
}

function notePath(result, name) {
  if (hasForbiddenPath(name)) {
    result.findings.push({ path: name, reason: "path" });
  }
}

function inspectContent(result, name, data, budget) {
  budget.use(data.length, name);
  result.bytes += data.length;
  if (containsCanary(data)) {
    result.findings.push({ path: name, reason: "canary" });
  }
}

function readName(buffer, start, length) {
  let end = start + length;
  while (end > start && buffer[end - 1] === 0) end -= 1;
  return buffer.subarray(start, end).toString("utf8");
}

// Tar stores numbers as NUL/space-terminated octal, or base-256 when the high
// bit of the first byte is set.
function readTarNumber(buffer, start, length) {
  if (buffer[start] & 0x80) {
    let value = BigInt(buffer[start] & 0x7f);
    for (let index = start + 1; index < start + length; index += 1) {
      value = value * 256n + BigInt(buffer[index]);
    }
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw new Error("tar number out of range");
    return number;
  }
  const text = readName(buffer, start, length).trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new Error("bad octal field in tar header");
  return Number.parseInt(text, 8);
}

function isZeroBlock(buffer) {
  for (let index = 0; index < TAR_BLOCK; index += 1) {
    if (buffer[index] !== 0) return false;
  }
  return true;
}

function scanTarBuffer(tar, result, budget) {
  let offset = 0;
  let pendingLongName = null;
  let zeroBlocks = 0;

  while (offset + TAR_BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK);
    if (isZeroBlock(header)) {
      zeroBlocks += 1;
      offset += TAR_BLOCK;
      if (zeroBlocks >= 2) break;
      continue;
    }
    zeroBlocks = 0;

    const nameField = readName(header, 0, 100);
    const prefix = readName(header, 345, 155);
    const size = readTarNumber(header, 124, 12);
    const type = String.fromCharCode(header[156] || 0x30);
    const name = pendingLongName ?? (prefix ? `${prefix}/${nameField}` : nameField);
    pendingLongName = null;

    const dataStart = offset + TAR_BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) {
      throw new Error(`${name}: truncated tar entry`);
    }

    // GNU long name: the payload is the next entry's name.
    if (type === "L") {
      pendingLongName = readName(tar, dataStart, size);
      offset = dataStart + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
      continue;
    }
    // PAX extended headers are metadata, not file content.
    if (type === "x" || type === "g") {
      offset = dataStart + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
      continue;
    }

    result.entries += 1;
    notePath(result, name);
    if (type === "0" || type === "7") {
      inspectContent(result, name, tar.subarray(dataStart, dataEnd), budget);
    }

    offset = dataStart + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
  }
}

export function scanTarGz(input, options = {}) {
  const result = resultFor(options.artifact ?? "<tar.gz>", "tar.gz");
  const budget = options.budget ?? createBudget(options);
  try {
    const raw = Buffer.isBuffer(input) ? input : readFileSync(input);
    const tar = gunzipSync(raw, { maxOutputLength: budget.maxTotalBytes });
    scanTarBuffer(tar, result, budget);
  } catch (error) {
    result.error = error.message;
  }
  return result;
}

function findEocd(buffer) {
  const min = Math.max(0, buffer.length - (22 + 0xffff));
  for (let offset = buffer.length - 22; offset >= min; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== SIG_EOCD) continue;
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === buffer.length) return offset;
  }
  throw new Error("end of central directory not found");
}

function need(buffer, offset, length, label) {
  if (offset < 0 || length < 0 || offset + length > buffer.length) {
    throw new Error(`${label}: truncated zip`);
  }
}

function scanZipBuffer(zip, result, budget) {
  const eocd = findEocd(zip);
  const diskEntries = zip.readUInt16LE(eocd + 8);
  const totalEntries = zip.readUInt16LE(eocd + 10);
  const cdSize = zip.readUInt32LE(eocd + 12);
  const cdOffset = zip.readUInt32LE(eocd + 16);

  if (
    diskEntries === ZIP64_COUNT ||
    totalEntries === ZIP64_COUNT ||
    cdSize === ZIP64 ||
    cdOffset === ZIP64
  ) {
    throw new Error("ZIP64 archives are not supported");
  }

  need(zip, cdOffset, cdSize, "central directory");
  let cursor = cdOffset;

  for (let index = 0; index < totalEntries; index += 1) {
    need(zip, cursor, 46, "central directory header");
    if (zip.readUInt32LE(cursor) !== SIG_CENTRAL) {
      throw new Error("bad central directory signature");
    }

    const method = zip.readUInt16LE(cursor + 10);
    const compressedSize = zip.readUInt32LE(cursor + 20);
    const uncompressedSize = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const localOffset = zip.readUInt32LE(cursor + 42);

    if (
      compressedSize === ZIP64 ||
      uncompressedSize === ZIP64 ||
      localOffset === ZIP64 ||
      nameLength === ZIP64_COUNT
    ) {
      throw new Error("ZIP64 archives are not supported");
    }

    need(zip, cursor + 46, nameLength, "entry name");
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");

    need(zip, localOffset, 30, `${name}: local header`);
    if (zip.readUInt32LE(localOffset) !== SIG_LOCAL) {
      throw new Error(`${name}: bad local header`);
    }
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    need(zip, dataStart, compressedSize, `${name}: compressed data`);

    result.entries += 1;
    notePath(result, name);

    const compressed = zip.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) {
      if (compressed.length !== uncompressedSize) {
        throw new Error(`${name}: stored size mismatch`);
      }
      inspectContent(result, name, compressed, budget);
    } else if (method === 8) {
      budget.use(uncompressedSize, name);
      let data;
      try {
        data = inflateRawSync(compressed, { maxOutputLength: budget.maxEntryBytes });
      } catch (error) {
        if (String(error.code).startsWith("ERR_BUFFER_TOO_LARGE")) {
          throw new Error(`${name}: entry exceeds ${human(budget.maxEntryBytes)} cap`);
        }
        throw error;
      }
      if (data.length !== uncompressedSize) {
        throw new Error(`${name}: uncompressed size mismatch`);
      }
      result.bytes += data.length;
      if (containsCanary(data)) {
        result.findings.push({ path: name, reason: "canary" });
      }
    } else {
      throw new Error(`${name}: unsupported compression method ${method}`);
    }

    cursor += 46 + nameLength + extraLength + commentLength;
  }
}

export function scanZip(input, options = {}) {
  const result = resultFor(options.artifact ?? "<zip>", "zip");
  const budget = options.budget ?? createBudget(options);
  try {
    scanZipBuffer(Buffer.isBuffer(input) ? input : readFileSync(input), result, budget);
  } catch (error) {
    result.error = error.message;
  }
  return result;
}

function walkDirectory(dir, prefix, result, budget) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = join(dir, entry.name);
    notePath(result, name);

    // A symlink is not artifact content. npm's .bin links point at files that
    // are already walked, and following them risks a cycle.
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      walkDirectory(full, name, result, budget);
      continue;
    }
    if (!entry.isFile()) continue;

    const size = statSync(full).size;
    budget.use(size, name);
    result.entries += 1;
    const data = readFileSync(full);
    result.bytes += data.length;
    if (containsCanary(data)) {
      result.findings.push({ path: name, reason: "canary" });
    }
  }
}

export function scanDirectory(dir, options = {}) {
  const result = resultFor(options.artifact ?? dir, "directory");
  const budget = options.budget ?? createBudget(options);
  try {
    walkDirectory(resolve(dir), "", result, budget);
  } catch (error) {
    result.error = error.message;
  }
  return result;
}

export function scanRaw(input, options = {}) {
  const result = resultFor(options.artifact ?? "<file>", "file");
  const budget = options.budget ?? createBudget(options);
  try {
    const data = Buffer.isBuffer(input) ? input : readFileSync(input);
    result.entries = 1;
    inspectContent(result, options.entryName ?? "<raw>", data, budget);
  } catch (error) {
    result.error = error.message;
  }
  return result;
}

export function artifactKind(target) {
  if (statSync(target).isDirectory()) return "directory";
  const lower = target.toLowerCase();
  if (lower.endsWith(".tgz") || lower.endsWith(".tar.gz")) return "tar.gz";
  if (lower.endsWith(".zip")) return "zip";
  return "file";
}

export function scanArtifact(target, options = {}) {
  let kind;
  try {
    kind = artifactKind(target);
  } catch (error) {
    const result = resultFor(target, "missing");
    result.error = error.message;
    return result;
  }
  const scanOptions = { ...options, artifact: target };
  if (kind === "directory") return scanDirectory(target, scanOptions);
  if (kind === "tar.gz") return scanTarGz(target, scanOptions);
  if (kind === "zip") return scanZip(target, scanOptions);
  return scanRaw(target, scanOptions);
}

// Scan every argument against ONE work budget, so two artifacts cannot add up
// to more work than one.
export function scanArtifacts(targets, options = {}) {
  const budget = options.budget ?? createBudget(options);
  return targets.map((target) => scanArtifact(target, { ...options, budget }));
}

function printResult(result, out) {
  if (result.error) {
    out.write(`FAIL ${result.artifact} :: ${result.error}\n`);
    return;
  }
  for (const finding of result.findings) {
    out.write(`FAIL ${result.artifact} :: ${finding.path} (${finding.reason})\n`);
  }
  if (result.ok) {
    out.write(
      `ok   ${result.artifact} (${result.kind}, ${result.entries} entries, ` +
        `${human(result.bytes)})\n`,
    );
  }
}

export function main(argv = process.argv.slice(2), out = process.stdout, err = process.stderr) {
  if (argv.length === 0) {
    err.write("usage: node scripts/scan-public-artifacts.mjs <path>...\n");
    return 2;
  }

  const results = scanArtifacts(argv);
  for (const result of results) printResult(result, out);

  const failed = results.filter((result) => !result.ok);
  if (failed.length > 0) {
    err.write(`${failed.length} artifact(s) failed the public scan\n`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = main();
}

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

import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
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

export function archiveType(name) {
  const lower = String(name).toLowerCase();
  if (lower.endsWith(".tgz") || lower.endsWith(".tar.gz")) return "tar.gz";
  if (lower.endsWith(".tar")) return "tar";
  if (
    lower.endsWith(".zip") ||
    lower.endsWith(".jar") ||
    lower.endsWith(".apk") ||
    lower.endsWith(".aab")
  ) {
    return "zip";
  }
  return null;
}

export function parsePax(buffer) {
  const records = {};
  let offset = 0;
  while (offset < buffer.length) {
    if (buffer[offset] === 0) {
      for (let index = offset; index < buffer.length; index += 1) {
        if (buffer[index] !== 0) {
          throw new Error("malformed PAX record: unexpected non-zero byte in padding");
        }
      }
      break;
    }
    const spaceIndex = buffer.indexOf(0x20, offset);
    if (spaceIndex === -1) {
      throw new Error("malformed PAX record: missing space after length");
    }
    const lenStr = buffer.subarray(offset, spaceIndex).toString("utf8");
    if (!/^[0-9]+$/.test(lenStr)) {
      throw new Error("malformed PAX record: invalid length field");
    }
    const length = Number.parseInt(lenStr, 10);
    if (length < 5 || offset + length > buffer.length) {
      throw new Error("malformed PAX record: length out of bounds");
    }
    if (buffer[offset + length - 1] !== 0x0a) {
      throw new Error("malformed PAX record: missing trailing newline");
    }
    const body = buffer.subarray(spaceIndex + 1, offset + length - 1).toString("utf8");
    const eqIndex = body.indexOf("=");
    if (eqIndex === -1) {
      throw new Error("malformed PAX record: missing equals sign");
    }
    const key = body.slice(0, eqIndex);
    const value = body.slice(eqIndex + 1);
    if (key.length === 0) {
      throw new Error("malformed PAX record: empty keyword");
    }
    records[key] = value;
    offset += length;
  }
  return records;
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
    if (buffer[start] & 0x40) throw new Error("tar number out of range");
    let value = BigInt(buffer[start] & 0x7f);
    for (let index = start + 1; index < start + length; index += 1) {
      value = value * 256n + BigInt(buffer[index]);
    }
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0) throw new Error("tar number out of range");
    return number;
  }
  const text = readName(buffer, start, length).trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new Error("bad octal field in tar header");
  const number = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error("tar number out of range");
  return number;
}

function isZeroBlock(buffer) {
  for (let index = 0; index < TAR_BLOCK; index += 1) {
    if (buffer[index] !== 0) return false;
  }
  return true;
}

function isUstar(buffer) {
  return buffer.length >= 262 && buffer.subarray(257, 262).toString("ascii") === "ustar";
}

function scanTarBuffer(tar, result, budget, depth = 0, archivePrefix = "") {
  let offset = 0;
  let pendingLongName = null;
  let pendingPax = null;
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
    const ustarSize = readTarNumber(header, 124, 12);
    const type = String.fromCharCode(header[156] || 0x30);

    let size = ustarSize;
    if (type !== "L" && type !== "x" && type !== "g" && pendingPax?.size !== undefined) {
      const rawPaxSize = pendingPax.size;
      if (!/^[0-9]+$/.test(rawPaxSize)) {
        const entryName =
          pendingPax?.path ?? pendingLongName ?? (prefix ? `${prefix}/${nameField}` : nameField);
        throw new Error(`${entryName}: invalid PAX size`);
      }
      const parsed = Number(rawPaxSize);
      if (!Number.isSafeInteger(parsed) || parsed < 0) {
        const entryName =
          pendingPax?.path ?? pendingLongName ?? (prefix ? `${prefix}/${nameField}` : nameField);
        throw new Error(`${entryName}: invalid PAX size`);
      }
      size = parsed;
    }

    if (!Number.isSafeInteger(size) || size < 0) {
      const entryName =
        pendingPax?.path ?? pendingLongName ?? (prefix ? `${prefix}/${nameField}` : nameField);
      throw new Error(`${entryName}: invalid entry size`);
    }

    const dataStart = offset + TAR_BLOCK;
    if (size > tar.length - dataStart) {
      const entryName =
        pendingPax?.path ?? pendingLongName ?? (prefix ? `${prefix}/${nameField}` : nameField);
      throw new Error(`${entryName}: truncated tar entry`);
    }
    const dataEnd = dataStart + size;

    // GNU long name: the payload is the next entry's name.
    if (type === "L") {
      pendingLongName = readName(tar, dataStart, size);
      offset = dataStart + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
      continue;
    }
    // PAX extended headers can carry path and linkpath overrides.
    if (type === "x" || type === "g") {
      const records = parsePax(tar.subarray(dataStart, dataEnd));
      pendingPax = { ...pendingPax, ...records };
      offset = dataStart + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
      continue;
    }

    const paxPath = pendingPax?.path;
    const paxLinkpath = pendingPax?.linkpath;
    pendingPax = null;

    const name = paxPath ?? pendingLongName ?? (prefix ? `${prefix}/${nameField}` : nameField);
    pendingLongName = null;
    const qualifiedName = archivePrefix ? `${archivePrefix}/${name}` : name;

    result.entries += 1;
    notePath(result, qualifiedName);

    if (type === "1" || type === "2") {
      const linkName = paxLinkpath ?? readName(header, 157, 100);
      if (linkName) {
        notePath(result, archivePrefix ? `${archivePrefix}/${linkName}` : linkName);
      }
    }

    if (type === "0" || type === "7") {
      const data = tar.subarray(dataStart, dataEnd);
      inspectContent(result, qualifiedName, data, budget);
      scanNestedArchive(data, qualifiedName, result, budget, depth + 1);
    }

    offset = dataStart + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
  }
}

export function scanTar(input, options = {}) {
  const result = options.result ?? resultFor(options.artifact ?? "<tar>", "tar");
  const budget = options.budget ?? createBudget(options);
  const depth = options.depth ?? 0;
  const prefix = options.prefix ?? "";
  try {
    if (depth > 4) {
      throw new Error(
        `${prefix || (options.artifact ?? "<tar>")}: archive nesting exceeds depth cap of 4`,
      );
    }
    const raw = Buffer.isBuffer(input) ? input : readFileSync(input);
    scanTarBuffer(raw, result, budget, depth, prefix);
  } catch (error) {
    result.error = error.message;
  }
  return result;
}

export function scanTarGz(input, options = {}) {
  const result = options.result ?? resultFor(options.artifact ?? "<tar.gz>", "tar.gz");
  const budget = options.budget ?? createBudget(options);
  const depth = options.depth ?? 0;
  const prefix = options.prefix ?? "";
  try {
    if (depth > 4) {
      throw new Error(
        `${prefix || (options.artifact ?? "<tar.gz>")}: archive nesting exceeds depth cap of 4`,
      );
    }
    const raw = Buffer.isBuffer(input) ? input : readFileSync(input);
    const remaining = Math.max(0, budget.maxTotalBytes - budget.used);
    const tar = gunzipSync(raw, { maxOutputLength: remaining });
    scanTarBuffer(tar, result, budget, depth, prefix);
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

function scanZipBuffer(zip, result, budget, depth = 0, archivePrefix = "") {
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
    const qualifiedName = archivePrefix ? `${archivePrefix}/${name}` : name;

    need(zip, localOffset, 30, `${qualifiedName}: local header`);
    if (zip.readUInt32LE(localOffset) !== SIG_LOCAL) {
      throw new Error(`${qualifiedName}: bad local header`);
    }
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    need(zip, dataStart, compressedSize, `${qualifiedName}: compressed data`);

    result.entries += 1;
    notePath(result, qualifiedName);

    const compressed = zip.subarray(dataStart, dataStart + compressedSize);
    let data;
    if (method === 0) {
      if (compressed.length !== uncompressedSize) {
        throw new Error(`${qualifiedName}: stored size mismatch`);
      }
      inspectContent(result, qualifiedName, compressed, budget);
      data = compressed;
    } else if (method === 8) {
      budget.use(uncompressedSize, qualifiedName);
      let dataBuffer;
      try {
        dataBuffer = inflateRawSync(compressed, { maxOutputLength: budget.maxEntryBytes });
      } catch (error) {
        if (String(error.code).startsWith("ERR_BUFFER_TOO_LARGE")) {
          throw new Error(`${qualifiedName}: entry exceeds ${human(budget.maxEntryBytes)} cap`);
        }
        throw error;
      }
      if (dataBuffer.length !== uncompressedSize) {
        throw new Error(`${qualifiedName}: uncompressed size mismatch`);
      }
      result.bytes += dataBuffer.length;
      if (containsCanary(dataBuffer)) {
        result.findings.push({ path: qualifiedName, reason: "canary" });
      }
      data = dataBuffer;
    } else {
      throw new Error(`${qualifiedName}: unsupported compression method ${method}`);
    }

    scanNestedArchive(data, qualifiedName, result, budget, depth + 1);

    cursor += 46 + nameLength + extraLength + commentLength;
  }
}

export function scanZip(input, options = {}) {
  const result = options.result ?? resultFor(options.artifact ?? "<zip>", "zip");
  const budget = options.budget ?? createBudget(options);
  const depth = options.depth ?? 0;
  const prefix = options.prefix ?? "";
  try {
    if (depth > 4) {
      throw new Error(
        `${prefix || (options.artifact ?? "<zip>")}: archive nesting exceeds depth cap of 4`,
      );
    }
    scanZipBuffer(
      Buffer.isBuffer(input) ? input : readFileSync(input),
      result,
      budget,
      depth,
      prefix,
    );
  } catch (error) {
    result.error = error.message;
  }
  return result;
}

function scanNestedArchive(data, prefix, result, budget, depth) {
  if (data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b) {
    if (depth > 4) {
      throw new Error(`${prefix}: archive nesting exceeds depth cap of 4`);
    }
    const remaining = Math.max(0, budget.maxTotalBytes - budget.used);
    let inflated;
    try {
      inflated = gunzipSync(data, { maxOutputLength: remaining });
    } catch (error) {
      if (
        String(error?.code).startsWith("ERR_BUFFER_TOO_LARGE") ||
        error?.message?.includes("cap")
      ) {
        throw error;
      }
      if (archiveType(prefix) === "tar.gz") {
        throw error;
      }
      return;
    }
    if (isUstar(inflated)) {
      scanTarBuffer(inflated, result, budget, depth, prefix);
    }
    return;
  }
  if (
    data.length >= 4 &&
    data[0] === 0x50 &&
    data[1] === 0x4b &&
    data[2] === 0x03 &&
    data[3] === 0x04
  ) {
    if (depth > 4) {
      throw new Error(`${prefix}: archive nesting exceeds depth cap of 4`);
    }
    scanZipBuffer(data, result, budget, depth, prefix);
    return;
  }
  if (isUstar(data)) {
    if (depth > 4) {
      throw new Error(`${prefix}: archive nesting exceeds depth cap of 4`);
    }
    scanTarBuffer(data, result, budget, depth, prefix);
    return;
  }
  const fallback = archiveType(prefix);
  if (fallback === "zip") {
    if (depth > 4) {
      throw new Error(`${prefix}: archive nesting exceeds depth cap of 4`);
    }
    scanZipBuffer(data, result, budget, depth, prefix);
  } else if (fallback === "tar") {
    if (depth > 4) {
      throw new Error(`${prefix}: archive nesting exceeds depth cap of 4`);
    }
    scanTarBuffer(data, result, budget, depth, prefix);
  }
}

function walkDirectory(
  dir,
  prefix,
  result,
  budget,
  depth = 0,
  ancestors = new Set([dir]),
  readFiles = new Map(),
  root = dir,
) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = join(dir, entry.name);
    notePath(result, name);

    if (entry.isSymbolicLink()) {
      let realTarget;
      try {
        realTarget = realpathSync(full);
      } catch (error) {
        throw new Error(`${name}: cannot read symlink (${error.message})`);
      }
      const rel = relative(root, realTarget);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        throw new Error(`${name}: symlink escapes scanned root (${realTarget})`);
      }

      const st = statSync(realTarget);
      if (st.isDirectory()) {
        if (ancestors.has(realTarget)) continue;
        const nextAncestors = new Set(ancestors);
        nextAncestors.add(realTarget);
        walkDirectory(realTarget, name, result, budget, depth, nextAncestors, readFiles, root);
      } else if (st.isFile()) {
        result.entries += 1;
        const cached = readFiles.get(realTarget);
        if (cached) {
          if (cached.hasCanary) {
            result.findings.push({ path: name, reason: "canary" });
          }
          continue;
        }
        budget.use(st.size, name);
        const data = readFileSync(realTarget);
        result.bytes += data.length;
        const hasCanary = containsCanary(data);
        readFiles.set(realTarget, { hasCanary });
        if (hasCanary) {
          result.findings.push({ path: name, reason: "canary" });
        }
        scanNestedArchive(data, name, result, budget, depth + 1);
      }
      continue;
    }

    if (entry.isDirectory()) {
      let real;
      try {
        real = realpathSync(full);
      } catch (error) {
        throw new Error(`${name}: cannot read directory (${error.message})`);
      }
      if (ancestors.has(real)) continue;
      const nextAncestors = new Set(ancestors);
      nextAncestors.add(real);
      walkDirectory(full, name, result, budget, depth, nextAncestors, readFiles, root);
      continue;
    }

    if (!entry.isFile()) continue;

    let realFile;
    try {
      realFile = realpathSync(full);
    } catch (error) {
      throw new Error(`${name}: cannot read file (${error.message})`);
    }

    result.entries += 1;
    const cached = readFiles.get(realFile);
    if (cached) {
      if (cached.hasCanary) {
        result.findings.push({ path: name, reason: "canary" });
      }
      continue;
    }

    const size = statSync(full).size;
    budget.use(size, name);
    const data = readFileSync(full);
    result.bytes += data.length;
    const hasCanary = containsCanary(data);
    readFiles.set(realFile, { hasCanary });
    if (hasCanary) {
      result.findings.push({ path: name, reason: "canary" });
    }
    scanNestedArchive(data, name, result, budget, depth + 1);
  }
}

export function scanDirectory(dir, options = {}) {
  const result = options.result ?? resultFor(options.artifact ?? dir, "directory");
  const budget = options.budget ?? createBudget(options);
  const depth = options.depth ?? 0;
  try {
    const root = realpathSync(resolve(dir));
    walkDirectory(root, "", result, budget, depth, new Set([root]), new Map(), root);
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
  if (lower.endsWith(".tar")) return "tar";
  if (
    lower.endsWith(".zip") ||
    lower.endsWith(".jar") ||
    lower.endsWith(".apk") ||
    lower.endsWith(".aab")
  ) {
    return "zip";
  }
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
  if (kind === "tar") return scanTar(target, scanOptions);
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

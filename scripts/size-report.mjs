// Sizes of an APK, an AAB or a zip. Stored bytes are the compressed sizes in
// the central directory (what the archive actually holds). No ZIP64.
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { crc32, inflateRawSync } from "node:zlib";

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const ZIP64 = 0xffffffff;
// 0xFFFF is the ZIP64 sentinel for the entry count. zip-tree.mjs refuses a count >= 0xFFFF.
const ZIP64_COUNT = 0xffff;

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

function need(buf, offset, length, label) {
  if (offset < 0 || length < 0 || offset + length > buf.length) {
    throw new Error(`${label} is outside the zip`);
  }
}

function findEocd(buf) {
  if (buf.length < 22) throw new Error("zip is shorter than an end record");
  const min = Math.max(0, buf.length - (22 + 0xffff));
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) !== SIG_EOCD) continue;
    const commentLen = buf.readUInt16LE(i + 20);
    if (i + 22 + commentLen === buf.length) return i;
  }
  throw new Error("end of central directory not found");
}

// Central directory first, then each local header, so sizes are known before
// the bytes are inflated. Bit 3 would put the sizes after the data; we still
// slice with the central-directory size.
export function readZip(input) {
  const buf = Buffer.isBuffer(input) ? input : readFileSync(input);
  const eocd = findEocd(buf);
  const totalEntries = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (
    buf.readUInt16LE(eocd + 8) === ZIP64_COUNT ||
    totalEntries === ZIP64_COUNT ||
    cdSize === ZIP64 ||
    cdOffset === ZIP64
  ) {
    throw new Error("ZIP64 archives are not supported");
  }
  need(buf, cdOffset, cdSize, "central directory");
  const entries = [];
  let p = cdOffset;
  for (let n = 0; n < totalEntries; n += 1) {
    need(buf, p, 46, "central directory header");
    if (buf.readUInt32LE(p) !== SIG_CENTRAL) {
      throw new Error("bad central directory signature");
    }
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const time = buf.readUInt16LE(p + 12);
    const date = buf.readUInt16LE(p + 14);
    const crc = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    need(buf, p + 46, nameLen, "entry name");
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    need(buf, localOffset, 30, `${name}: local header`);
    if (buf.readUInt32LE(localOffset) !== SIG_LOCAL) {
      throw new Error(`${name}: bad local header`);
    }
    const localFlags = buf.readUInt16LE(localOffset + 6);
    const localMethod = buf.readUInt16LE(localOffset + 8);
    const localTime = buf.readUInt16LE(localOffset + 10);
    const localDate = buf.readUInt16LE(localOffset + 12);
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    need(buf, dataStart, compressedSize, `${name}: compressed data`);
    const compressed = Buffer.from(buf.subarray(dataStart, dataStart + compressedSize));
    let data;
    if (method === 0) data = Buffer.from(compressed);
    else if (method === 8) data = inflateRawSync(compressed);
    else throw new Error(`${name}: unsupported method ${method}`);
    if (data.length !== uncompressedSize) {
      throw new Error(`${name}: uncompressed size ${data.length} != ${uncompressedSize}`);
    }
    if (crc32(data) >>> 0 !== crc) throw new Error(`${name}: crc mismatch`);
    p += 46 + nameLen + extraLen + commentLen;
    if (p > cdOffset + cdSize) throw new Error(`${name}: central header exceeds the directory`);
    entries.push({
      name,
      flags,
      method,
      time,
      date,
      crc,
      compressedSize,
      uncompressedSize,
      localOffset,
      localFlags,
      localMethod,
      localTime,
      localDate,
      compressed,
      data,
    });
  }
  return { entries };
}

const NATIVE_FILE = /(?:^|\/)lib\/([^/]+)\/[^/]+$/;

// One component name per entry, so component totals partition the archive.
export function classifyEntry(name) {
  const base = name.slice(name.lastIndexOf("/") + 1);
  if (base === "levix-app.zip") return "levix-app.zip";
  const native = NATIVE_FILE.exec(name);
  if (native) return `native ${native[1]}`;
  if (/^classes\d*\.dex$/.test(base) || name.startsWith("base/dex/")) return "dex";
  if (
    base === "resources.arsc" ||
    name === "base/resources.pb" ||
    name.startsWith("res/") ||
    name.startsWith("base/res/")
  ) {
    return "resources";
  }
  return "other";
}

// AAB, APK (ABIs joined with +) or a plain zip named by its file name.
export function artifactKey(filePath, entries) {
  const names = new Set(entries.map((entry) => entry.name));
  if (names.has("base/manifest/AndroidManifest.xml")) return "aab";
  if (names.has("AndroidManifest.xml")) {
    const abis = new Set();
    for (const entry of entries) {
      const match = NATIVE_FILE.exec(entry.name);
      if (match) abis.add(match[1]);
    }
    return `apk:${[...abis].sort().join("+")}`;
  }
  return `zip:${basename(filePath)}`;
}

function componentRank(name) {
  if (name.startsWith("native ")) return `0${name}`;
  if (name === "levix-app.zip") return "1";
  if (name === "dex") return "2";
  if (name === "resources") return "3";
  if (name === "other") return "4";
  return `5${name}`;
}

function compareRank(a, b) {
  const left = componentRank(a);
  const right = componentRank(b);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareNames(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function sortedRecord(record, compare) {
  const out = {};
  for (const key of Object.keys(record).sort(compare)) out[key] = record[key];
  return out;
}

function lockPackageKeys(lock) {
  if (!lock?.packages) return [];
  return Object.keys(lock.packages).filter((key) => key.startsWith("node_modules/"));
}

// Outermost package when the lockfile has no longer prefix: one segment, or two for a scope.
function outermostPackage(clean) {
  const parts = clean.split("/");
  for (let i = 0; i < parts.length; i += 1) {
    if (parts[i] !== "node_modules") continue;
    const next = parts[i + 1];
    if (!next || next.startsWith(".")) return null;
    if (next.startsWith("@")) {
      const scoped = parts[i + 2];
      if (!scoped || scoped.startsWith(".")) return null;
      return `${next}/${scoped}`;
    }
    return next;
  }
  return null;
}

// Longest `packages` key that prefixes the entry. The reported name drops the leading
// `node_modules/`, so a nested copy stays `a/node_modules/b` instead of the inner name.
function attributedPackage(clean, keys) {
  let best = null;
  for (const key of keys) {
    if (clean !== key && !clean.startsWith(`${key}/`)) continue;
    if (best === null || key.length > best.length) best = key;
  }
  if (best) return best.slice("node_modules/".length);
  return outermostPackage(clean);
}

export function packageOf(name, lock) {
  const clean = name.endsWith("/") ? name.slice(0, -1) : name;
  return attributedPackage(clean, lockPackageKeys(lock));
}

function topLevelOf(name) {
  const clean = name.endsWith("/") ? name.slice(0, -1) : name;
  const slash = clean.indexOf("/");
  return slash === -1 ? clean : clean.slice(0, slash);
}

// Type comes from that same lockfile key. `dev: true` is dev-only. A missing key is unknown.
export function packageType(lock, name) {
  const rec = lock?.packages?.[`node_modules/${name}`];
  if (!rec) return "unknown";
  return rec.dev === true ? "dev" : "prod";
}

function summarizeApp(entries, lock) {
  const topLevel = {};
  const packages = {};
  const keys = lockPackageKeys(lock);
  let compressed = 0;
  let uncompressed = 0;
  let devCompressed = 0;
  for (const entry of entries) {
    compressed += entry.compressedSize;
    uncompressed += entry.uncompressedSize;
    const top = topLevelOf(entry.name);
    const topRow = topLevel[top] ?? { compressed: 0, uncompressed: 0 };
    topRow.compressed += entry.compressedSize;
    topRow.uncompressed += entry.uncompressedSize;
    topLevel[top] = topRow;
    const clean = entry.name.endsWith("/") ? entry.name.slice(0, -1) : entry.name;
    const pkg = attributedPackage(clean, keys);
    if (!pkg) continue;
    if (!packages[pkg]) {
      packages[pkg] = { type: packageType(lock, pkg), compressed: 0, uncompressed: 0 };
    }
    packages[pkg].compressed += entry.compressedSize;
    packages[pkg].uncompressed += entry.uncompressedSize;
    if (packages[pkg].type === "dev") devCompressed += entry.compressedSize;
  }
  return {
    entries: entries.length,
    compressed,
    uncompressed,
    topLevel: sortedRecord(topLevel),
    packages: sortedRecord(packages),
    devCompressed,
  };
}

function appZip(filePath, zip, lock) {
  const embedded = zip.entries.find((entry) => entry.name.split("/").pop() === "levix-app.zip");
  if (embedded) return summarizeApp(readZip(embedded.data).entries, lock);
  if (basename(filePath) === "levix-app.zip") return summarizeApp(zip.entries, lock);
  return null;
}

export function summarizeZip(zip, fileBytes, filePath, lock = null) {
  const components = {};
  const libraries = {};
  for (const entry of zip.entries) {
    const component = classifyEntry(entry.name);
    const row = components[component] ?? { stored: 0, uncompressed: 0 };
    row.stored += entry.compressedSize;
    row.uncompressed += entry.uncompressedSize;
    components[component] = row;
    if (component.startsWith("native ")) {
      libraries[entry.name] = {
        stored: entry.compressedSize,
        uncompressed: entry.uncompressedSize,
      };
    }
  }
  return {
    fileBytes,
    entries: zip.entries.length,
    components: sortedRecord(components, compareRank),
    libraries: sortedRecord(libraries),
    app: appZip(filePath, zip, lock),
  };
}

export function inspectFile(filePath, lock = null) {
  const buf = readFileSync(filePath);
  const zip = readZip(buf);
  return {
    key: artifactKey(filePath, zip.entries),
    artifact: summarizeZip(zip, buf.length, filePath, lock),
  };
}

export function buildReport(files, lock = null) {
  const artifacts = {};
  for (const file of files) {
    const { key, artifact } = inspectFile(file, lock);
    artifacts[key] = artifact;
  }
  return { schema: 1, artifacts };
}

export function componentRows(components, baselineComponents = undefined) {
  const showBaseline = baselineComponents != null;
  const names = Object.keys(components).sort(compareRank);
  return names.map((name) => {
    const stored = components[name].stored;
    const uncompressed = components[name].uncompressed;
    if (!showBaseline) return { name, stored, uncompressed };
    if (baselineComponents[name] === undefined) {
      return { name, stored, uncompressed, baseline: null, delta: null, deltaPct: null };
    }
    const baseline = baselineComponents[name].stored;
    const delta = stored - baseline;
    const deltaPct = baseline === 0 ? null : (delta / baseline) * 100;
    return { name, stored, uncompressed, baseline, delta, deltaPct };
  });
}

function formatDelta(delta) {
  if (delta > 0) return `+${delta}`;
  return String(delta);
}

function formatPct(pct) {
  if (pct === null) return "n/a";
  if (pct > 0) return `+${pct.toFixed(1)}%`;
  if (pct < 0) return `${pct.toFixed(1)}%`;
  return "0.0%";
}

function markdownTable(headers, rows) {
  const head = `| ${headers.join(" | ")} |`;
  const sep = `| ${headers.map((_, i) => (i === 0 ? "---" : "---:")).join(" | ")} |`;
  const body = rows.map((row) => `| ${row.join(" | ")} |`);
  return [head, sep, ...body].join("\n");
}

function renderArtifact(key, artifact, baselineArtifact) {
  const showBaseline = baselineArtifact != null;
  const rows = componentRows(
    artifact.components,
    showBaseline ? (baselineArtifact.components ?? {}) : undefined,
  );
  const headers = showBaseline
    ? ["component", "stored bytes", "baseline", "delta", "delta %"]
    : ["component", "stored bytes"];
  const tableRows = rows.map((row) => {
    if (!showBaseline) return [row.name, String(row.stored)];
    if (row.baseline === null) return [row.name, String(row.stored), "", "", ""];
    return [
      row.name,
      String(row.stored),
      String(row.baseline),
      formatDelta(row.delta),
      formatPct(row.deltaPct),
    ];
  });
  const lines = [
    `## ${key}`,
    "",
    `file bytes: ${artifact.fileBytes}`,
    `entries: ${artifact.entries}`,
    "",
    markdownTable(headers, tableRows),
  ];
  const libs = Object.entries(artifact.libraries);
  if (libs.length > 0) {
    lines.push(
      "",
      "### Native libraries",
      "",
      markdownTable(
        ["library", "stored bytes", "uncompressed"],
        libs.map(([path, row]) => [path, String(row.stored), String(row.uncompressed)]),
      ),
    );
  }
  if (artifact.app) {
    const { app } = artifact;
    const share = app.compressed === 0 ? 0 : (app.devCompressed / app.compressed) * 100;
    const tops = Object.entries(app.topLevel);
    const largest = Object.entries(app.packages)
      .sort((a, b) => b[1].compressed - a[1].compressed || compareNames(a[0], b[0]))
      .slice(0, 15);
    lines.push(
      "",
      "### levix-app.zip",
      "",
      `entries: ${app.entries}`,
      `compressed: ${app.compressed}`,
      `uncompressed: ${app.uncompressed}`,
      `dev-only compressed: ${app.devCompressed} (${share.toFixed(1)}%)`,
      "",
      "### levix-app.zip top-level",
      "",
      markdownTable(
        ["path", "compressed", "uncompressed"],
        tops.map(([path, row]) => [path, String(row.compressed), String(row.uncompressed)]),
      ),
      "",
      "### levix-app.zip packages",
      "",
      markdownTable(
        ["package", "type", "compressed", "uncompressed"],
        largest.map(([name, row]) => [
          name,
          row.type,
          String(row.compressed),
          String(row.uncompressed),
        ]),
      ),
    );
  }
  return lines.join("\n");
}

export function renderMarkdown(report, baseline = null) {
  const parts = [];
  for (const [key, artifact] of Object.entries(report.artifacts)) {
    const baselineArtifact = baseline?.artifacts ? (baseline.artifacts[key] ?? null) : null;
    parts.push(renderArtifact(key, artifact, baselineArtifact));
  }
  return `${parts.join("\n\n")}\n`;
}

function parseArgs(argv) {
  const args = { lock: null, baseline: null, json: null, artifacts: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--lock" || token === "--baseline" || token === "--json") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Error(`missing value for ${token}`);
      i += 1;
      if (token === "--lock") args.lock = value;
      else if (token === "--baseline") args.baseline = value;
      else args.json = value;
      continue;
    }
    if (token.startsWith("--")) throw new Error(`unknown option ${token}`);
    args.artifacts.push(token);
  }
  return args;
}

const USAGE = `${[
  "usage: node size-report.mjs [--lock package-lock.json]",
  "[--baseline <json>] [--json <out>] <artifact>...",
].join(" ")}\n`;

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.stderr.write(USAGE);
    process.exit(2);
  }
  if (args.artifacts.length === 0) {
    process.stderr.write(USAGE);
    process.exit(2);
  }
  const lock = args.lock ? JSON.parse(readFileSync(args.lock, "utf8")) : null;
  const baseline = args.baseline ? JSON.parse(readFileSync(args.baseline, "utf8")) : null;
  const report = buildReport(args.artifacts, lock);
  process.stdout.write(renderMarkdown(report, baseline));
  if (args.json) writeFileSync(args.json, `${JSON.stringify(report, null, 2)}\n`);
}

if (isDirectRun()) main(process.argv.slice(2));

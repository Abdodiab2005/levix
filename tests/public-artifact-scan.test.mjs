// The public artifact scanner must fail on private Levix Plus code and pass on
// an artifact that carries none. Fixtures are built at runtime, so the test
// needs no committed archives.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { zipTree } from "../android/scripts/zip-tree.mjs";
import {
  CANARY,
  MAX_ENTRY_BYTES,
  MAX_TOTAL_BYTES,
  hasForbiddenPath,
  hasTarChecksum,
  parsePax,
  scanArtifact,
  scanDirectory,
  scanRaw,
  scanTar,
  scanTarGz,
  scanZip,
} from "../scripts/scan-public-artifacts.mjs";
import { equal, finish, ok, section } from "./harness.mjs";

const dirs = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "levix-scan-"));
  dirs.push(dir);
  return dir;
}

function writeTree(root, files) {
  for (const [name, data] of Object.entries(files)) {
    const full = join(root, name);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, data);
  }
}

// --- a small ustar writer -------------------------------------------------

function writeOctal(buf, offset, length, value) {
  const text = value.toString(8).padStart(length - 1, "0");
  buf.write(text, offset, length - 1, "ascii");
  buf[offset + length - 1] = 0;
}

function tarHeader(name, size, type = "0", prefix = "") {
  const buf = Buffer.alloc(512, 0);
  buf.write(name, 0, 100, "utf8");
  writeOctal(buf, 100, 8, 0o644);
  writeOctal(buf, 108, 8, 0);
  writeOctal(buf, 116, 8, 0);
  writeOctal(buf, 124, 12, size);
  writeOctal(buf, 136, 12, 0);
  buf.fill(0x20, 148, 156);
  buf.write(type, 156, 1, "ascii");
  buf.write("ustar", 257, 6, "ascii");
  buf[262] = 0;
  buf.write("00", 263, 2, "ascii");
  if (prefix) buf.write(prefix, 345, 155, "utf8");

  let sum = 0;
  for (const byte of buf) sum += byte;
  buf.write(sum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  buf[154] = 0;
  buf[155] = 0x20;
  return buf;
}

function padded(data) {
  const pad = (512 - (data.length % 512)) % 512;
  return pad ? Buffer.concat([data, Buffer.alloc(pad)]) : data;
}

function tarBuffer(entries) {
  const chunks = [];
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? "", "utf8");
    let name = entry.name;
    if (name.length > 100) {
      const long = Buffer.from(`${name}\0`, "utf8");
      chunks.push(tarHeader("././@LongLink", long.length, "L"), padded(long));
      name = name.slice(0, 100);
    }
    chunks.push(tarHeader(name, data.length, entry.type ?? "0", entry.prefix ?? ""), padded(data));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function tarGz(entries) {
  return gzipSync(tarBuffer(entries));
}

function v7TarHeader(name, size, type = "0") {
  const buf = Buffer.alloc(512, 0);
  buf.write(name, 0, 100, "utf8");
  writeOctal(buf, 100, 8, 0o644);
  writeOctal(buf, 108, 8, 0);
  writeOctal(buf, 116, 8, 0);
  writeOctal(buf, 124, 12, size);
  writeOctal(buf, 136, 12, 0);
  buf.fill(0x20, 148, 156);
  buf.write(type, 156, 1, "ascii");

  let sum = 0;
  for (const byte of buf) sum += byte;
  buf.write(sum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  buf[154] = 0;
  buf[155] = 0x20;
  return buf;
}

function v7TarBuffer(entries) {
  const chunks = [];
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? "", "utf8");
    chunks.push(v7TarHeader(entry.name, data.length, entry.type ?? "0"), padded(data));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function v7TarGz(entries) {
  return gzipSync(v7TarBuffer(entries));
}

function makePax(records) {
  const parts = [];
  for (const [key, val] of Object.entries(records)) {
    const suffix = ` ${key}=${val}\n`;
    const suffixLen = Buffer.byteLength(suffix, "utf8");
    let len = suffixLen + 2;
    while (true) {
      const lenStr = String(len);
      if (lenStr.length + suffixLen === len) break;
      len = lenStr.length + suffixLen;
    }
    parts.push(Buffer.from(`${len}${suffix}`, "utf8"));
  }
  return Buffer.concat(parts);
}

// --- fixtures -------------------------------------------------------------

const root = tempDir();

try {
  section("path rules");

  ok("extensions/levix-plus is forbidden", hasForbiddenPath("extensions/levix-plus/index.cjs"));
  ok("levix-plus/runtime is forbidden", hasForbiddenPath("a/levix-plus/runtime/x.cjs"));
  ok("a clean path is allowed", !hasForbiddenPath("src/extensions/levix/index.cjs"));
  ok(
    "the caps are the documented numbers",
    MAX_ENTRY_BYTES === 256 * 1024 * 1024 && MAX_TOTAL_BYTES === 2 * 1024 * 1024 * 1024,
  );

  section("a directory");

  const cleanDir = join(root, "clean-dir");
  writeTree(cleanDir, {
    "src/index.js": "console.log(1);\n",
    "public/app.css": "body { color: red; }\n",
  });
  const cleanDirectory = scanDirectory(cleanDir);
  ok("a clean directory passes", cleanDirectory.ok, cleanDirectory.error ?? "");

  const privateDir = join(root, "private-dir");
  writeTree(privateDir, {
    "extensions/levix-plus/index.cjs": "module.exports = 1;\n",
  });
  const privateDirectory = scanDirectory(privateDir);
  ok("extensions/levix-plus fails", !privateDirectory.ok);
  ok(
    "…and names the entry",
    privateDirectory.findings.some((finding) => finding.path === "extensions/levix-plus/index.cjs"),
  );

  const canaryDir = join(root, "canary-dir");
  writeTree(canaryDir, { "src/deep/nested/file.txt": `prefix ${CANARY} suffix` });
  const canaryDirectory = scanDirectory(canaryDir);
  ok("a canary in a nested file fails", !canaryDirectory.ok);

  section("tar.gz");

  const cleanTar = tarGz([{ name: "package/src/index.js", data: "console.log(1);\n" }]);
  ok("a clean tar.gz passes", scanTarGz(cleanTar).ok);

  const longName = `${"deep/".repeat(25)}extensions/levix-plus/index.cjs`;
  ok("the long-name fixture is longer than one header", longName.length > 100);
  const longTar = tarGz([{ name: longName, data: "module.exports = 1;\n" }]);
  const longResult = scanTarGz(longTar);
  ok("a GNU long name reaches the path rule", !longResult.ok);
  ok(
    "…and names the long entry",
    longResult.findings.some((finding) => finding.path === longName),
  );

  const prefixTar = tarGz([
    { name: "index.cjs", prefix: "extensions/levix-plus", data: "module.exports = 1;\n" },
  ]);
  ok("a ustar prefix reaches the path rule", !scanTarGz(prefixTar).ok);

  const canaryTar = tarGz([{ name: "src/file.txt", data: `x ${CANARY} y` }]);
  ok("a canary in a tar.gz entry fails", !scanTarGz(canaryTar).ok);

  section("zip");

  const cleanZipDir = join(root, "clean-zip");
  writeTree(cleanZipDir, { "src/index.js": "console.log(1);\n" });
  const cleanZip = zipTree(cleanZipDir);
  ok("a clean zip passes", scanZip(cleanZip).ok);

  const cleanZipPath = join(root, "clean.zip");
  writeFileSync(cleanZipPath, cleanZip);

  const canaryZipDir = join(root, "canary-zip");
  writeTree(canaryZipDir, {
    "src/payload.txt": `${CANARY}${"x".repeat(4000)}`,
  });
  const canaryZip = scanZip(zipTree(canaryZipDir));
  ok("a canary in a deflated zip entry fails", !canaryZip.ok);

  const privateZipDir = join(root, "private-zip");
  writeTree(privateZipDir, { "extensions/levix-plus/index.cjs": "module.exports = 1;\n" });
  ok("a forbidden zip path fails", !scanZip(zipTree(privateZipDir)).ok);

  const zip64 = Buffer.alloc(22);
  zip64.writeUInt32LE(0x06054b50, 0);
  zip64.writeUInt16LE(0xffff, 8);
  zip64.writeUInt16LE(0xffff, 10);
  const zip64Result = scanZip(zip64);
  ok("ZIP64 is refused", !zip64Result.ok && /ZIP64/.test(zip64Result.error ?? ""));

  section("raw bytes and caps");

  const raw = Buffer.concat([
    Buffer.from([0, 1, 2]),
    Buffer.from(CANARY, "utf8"),
    Buffer.from([3]),
  ]);
  ok("a canary in a raw binary fails", !scanRaw(raw).ok);
  ok("a clean raw binary passes", scanRaw(Buffer.from("plain bytes")).ok);

  const oversizeDir = join(root, "oversize");
  writeTree(oversizeDir, { "big.bin": Buffer.alloc(2048, 0x61) });
  const oversize = scanZip(zipTree(oversizeDir), { maxEntryBytes: 1024 });
  ok("an entry over the cap fails", !oversize.ok && /cap/.test(oversize.error ?? ""));

  const artifact = scanArtifact(cleanZipPath);
  ok("scanArtifact detects a zip", artifact.kind === "zip" && artifact.ok);

  section("nested archives and depth cap");

  const nestedTgzDir = join(root, "nested-tgz-dir");
  const canaryTgz = tarGz([{ name: "src/secret.txt", data: `prefix ${CANARY} suffix` }]);
  writeTree(nestedTgzDir, { "clean.txt": "hello\n" });
  writeFileSync(join(nestedTgzDir, "payload.tgz"), canaryTgz);
  const nestedTgzResult = scanDirectory(nestedTgzDir);
  ok("nested tgz in a directory is inspected", !nestedTgzResult.ok);
  ok(
    "…and detects canary in nested tgz",
    nestedTgzResult.findings.some((finding) => finding.path === "payload.tgz/src/secret.txt"),
  );

  const v7NestedDir = join(root, "v7-nested-dir");
  const v7Payload = v7TarGz([
    { name: "extensions/levix-plus/index.cjs", data: "module.exports = 1;\n" },
  ]);
  writeTree(v7NestedDir, { "clean.txt": "hello\n" });
  writeFileSync(join(v7NestedDir, "payload.tgz"), v7Payload);
  const v7NestedResult = scanDirectory(v7NestedDir);
  ok("nested payload.tgz holding a V7 tar with private path fails", !v7NestedResult.ok);
  ok(
    "…and detects private path in nested V7 tar",
    v7NestedResult.findings.some(
      (finding) =>
        finding.path === "payload.tgz/extensions/levix-plus/index.cjs" && finding.reason === "path",
    ),
  );

  const plainCanaryGzDir = join(root, "plain-canary-gz-dir");
  writeTree(plainCanaryGzDir, { "clean.txt": "hello\n" });
  const canaryPlainGz = gzipSync(Buffer.from(`prefix ${CANARY} suffix\n`, "utf8"));
  writeFileSync(join(plainCanaryGzDir, "notes.txt.gz"), canaryPlainGz);
  const plainCanaryGzResult = scanDirectory(plainCanaryGzDir);
  ok("nested gzip of plain text containing the canary fails", !plainCanaryGzResult.ok);
  ok(
    "…and detects canary in nested plain gzip",
    plainCanaryGzResult.findings.some(
      (finding) => finding.path === "notes.txt.gz" && finding.reason === "canary",
    ),
  );

  const notTarDir = join(root, "not-tar-tgz-dir");
  writeTree(notTarDir, { "clean.txt": "hello\n" });
  const notTarGz = gzipSync(Buffer.from("just plain text, definitely not a tar\n", "utf8"));
  writeFileSync(join(notTarDir, "broken.tgz"), notTarGz);
  const notTarResult = scanDirectory(notTarDir);
  ok(
    "nested .tgz whose content is not a tar fails with a clear error",
    !notTarResult.ok && /not a tar archive/.test(notTarResult.error ?? ""),
  );

  const innerZipDir = join(root, "inner-zip-tree");
  writeTree(innerZipDir, { "payload.txt": `${CANARY} inside zip` });
  const innerZip = zipTree(innerZipDir);
  const zipInTgz = tarGz([{ name: "bundle.zip", data: innerZip }]);
  const zipInTgzResult = scanTarGz(zipInTgz);
  ok("zip inside tgz is inspected", !zipInTgzResult.ok);
  ok(
    "…and detects canary in nested zip",
    zipInTgzResult.findings.some((finding) => finding.path === "bundle.zip/payload.txt"),
  );

  // The innermost entry is a real archive holding a text file; four more archives wrap it.
  let okArchive = tarGz([
    { name: "payload.txt", data: Buffer.from("clean inner payload\n", "utf8") },
  ]);
  for (let level = 4; level >= 1; level -= 1) {
    okArchive = tarGz([{ name: `level${level}.tgz`, data: okArchive }]);
  }
  const okDepthResult = scanTarGz(okArchive);
  ok("archive within depth cap passes", okDepthResult.ok);

  // Content detection only treats real archives as nesting, so the innermost entry is an archive too.
  let deepArchive = tarGz([
    { name: "payload.txt", data: Buffer.from("deep clean payload\n", "utf8") },
  ]);
  for (let level = 5; level >= 1; level -= 1) {
    deepArchive = tarGz([{ name: `deep${level}.tgz`, data: deepArchive }]);
  }
  const deepResult = scanTarGz(deepArchive);
  ok(
    "archive exceeding depth cap fails",
    !deepResult.ok && /depth cap/.test(deepResult.error ?? ""),
  );

  const uncompressedTar = tarBuffer([{ name: "src/clean.txt", data: "hello\n" }]);
  ok("uncompressed tar passes", scanTar(uncompressedTar).ok);
  const uncompressedPath = join(root, "clean.tar");
  writeFileSync(uncompressedPath, uncompressedTar);
  const artifactTar = scanArtifact(uncompressedPath);
  ok("scanArtifact detects tar", artifactTar.kind === "tar" && artifactTar.ok);

  const ociDigest = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const ociLayerName = `blobs/sha256/${ociDigest}`;
  const ociInnerTar = tarGz([
    { name: "extensions/levix-plus/runtime.js", data: "module.exports = 1;\n" },
  ]);
  const ociArchive = tarBuffer([{ name: ociLayerName, data: ociInnerTar }]);
  const ociResult = scanTar(ociArchive);
  ok(
    "a gzip layer named blobs/sha256/<hex> holding a private path fails",
    !ociResult.ok &&
      ociResult.findings.some((f) => f.path === `${ociLayerName}/extensions/levix-plus/runtime.js`),
  );

  section("symlinks");

  const symlinkDir = join(root, "symlink-dir");
  writeTree(symlinkDir, { "target.txt": `secret ${CANARY}` });
  symlinkSync("target.txt", join(symlinkDir, "link.txt"));
  const symlinkResult = scanDirectory(symlinkDir);
  ok(
    "in-root symlink scanned",
    !symlinkResult.ok && symlinkResult.findings.some((f) => f.path === "link.txt"),
  );

  const escapeDir = join(root, "escape-dir");
  writeTree(escapeDir, { "clean.txt": "hello\n" });
  symlinkSync("/etc/hosts", join(escapeDir, "escape.txt"));
  const escapeResult = scanDirectory(escapeDir);
  ok("escaping symlink fails", !escapeResult.ok && /escapes/.test(escapeResult.error ?? ""));

  const brokenDir = join(root, "broken-link-dir");
  mkdirSync(brokenDir);
  symlinkSync("missing.txt", join(brokenDir, "broken.txt"));
  const brokenResult = scanDirectory(brokenDir);
  ok(
    "broken symlink fails",
    !brokenResult.ok && /cannot read symlink/.test(brokenResult.error ?? ""),
  );

  const cycleDir = join(root, "cycle-dir");
  mkdirSync(join(cycleDir, "sub"), { recursive: true });
  writeFileSync(join(cycleDir, "sub", "hello.txt"), "hello\n");
  symlinkSync(cycleDir, join(cycleDir, "sub", "loop"));
  const cycleResult = scanDirectory(cycleDir);
  ok("symlink cycle is handled safely", cycleResult.ok);

  const aliasDir = join(root, "symlink-alias-dir");
  writeTree(aliasDir, {
    "a/levix-plus/x.js": "module.exports = 1;\n",
  });
  symlinkSync("a", join(aliasDir, "extensions"));
  const aliasResult = scanDirectory(aliasDir);
  ok(
    "the symlink alias case fails",
    !aliasResult.ok &&
      aliasResult.findings.some(
        (f) => f.path === "extensions/levix-plus" || f.path === "extensions/levix-plus/x.js",
      ),
  );

  section("PAX extended headers");

  const paxData = makePax({ path: "extensions/levix-plus/secret.js" });
  const paxTar = tarGz([
    { name: "PaxHeader/clean.js", data: paxData, type: "x" },
    { name: "clean.js", data: "console.log(1);\n", type: "0" },
  ]);
  const paxResult = scanTarGz(paxTar);
  ok(
    "PAX path override detected",
    !paxResult.ok && paxResult.findings.some((f) => f.path === "extensions/levix-plus/secret.js"),
  );

  const paxSizeData = makePax({ size: "1024" });
  const paxSizeHeader = tarHeader("PaxHeader/zeros.bin", paxSizeData.length, "x");
  const zerosHeader = tarHeader("zeros.bin", 0, "0");
  const zerosPayload = Buffer.alloc(1024, 0);
  const privatePayload = Buffer.from("module.exports = 1;\n", "utf8");
  const privateHeader = tarHeader("extensions/levix-plus/secret.js", privatePayload.length, "0");
  const paxSizeTar = Buffer.concat([
    paxSizeHeader,
    padded(paxSizeData),
    zerosHeader,
    zerosPayload,
    privateHeader,
    padded(privatePayload),
    Buffer.alloc(1024, 0),
  ]);
  const paxSizeResult = scanTar(paxSizeTar);
  ok(
    "PAX size override with ustar size 0 followed by a private entry fails",
    !paxSizeResult.ok &&
      paxSizeResult.findings.some((f) => f.path === "extensions/levix-plus/secret.js"),
  );

  const badPaxTar = tarGz([
    { name: "PaxHeader/bad", data: "malformed pax record with no length or space\n", type: "x" },
    { name: "clean.js", data: "console.log(1);\n", type: "0" },
  ]);
  const badPaxResult = scanTarGz(badPaxTar);
  ok("malformed PAX record fails", !badPaxResult.ok && /PAX/.test(badPaxResult.error ?? ""));

  section("the repository itself");

  // Only the scanner may carry the canary literal. The test file is outside
  // these trees; it is listed anyway so the rule is explicit.
  const scanner = resolve(
    fileURLToPath(new URL("../scripts/scan-public-artifacts.mjs", import.meta.url)),
  );
  const testFile = resolve(fileURLToPath(import.meta.url));
  const allowed = new Set([scanner, testFile]);
  const trees = ["src", "public", "bin", "scripts", "android", "frontend/src"].map((name) =>
    resolve(fileURLToPath(new URL(`../${name}`, import.meta.url))),
  );

  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  for (const tree of trees) walk(tree);

  const offenders = files.filter((file) => {
    if (allowed.has(resolve(file))) return false;
    return readFileSync(file).includes(Buffer.from(CANARY, "utf8"));
  });
  ok("no tracked source carries the canary", offenders.length === 0, offenders.join(", "));
} finally {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}

finish();

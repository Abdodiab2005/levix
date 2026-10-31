import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync, createGzip } from "node:zlib";
import { Readable } from "node:stream";
import { finish, ok, require, section } from "./harness.mjs";

const { writeBackup, openBackup, validateManifest, validatePassword, LIMITS, _internal } =
  require("./src/backup/format.cjs");
const PASSWORD = "backup-password-marker-SECRET";
const SECRET = "secret-entry-marker-PRIVATE";
const kdf = { N: 32768, r: 8, p: 1 };
const salt = Buffer.alloc(32, 7);
const testDir = mkdtempSync(join(tmpdir(), "levix-backup-format-"));
process.on("exit", () => rmSync(testDir, { recursive: true, force: true }));
const errors = [];
let sequence = 0;

function file(bytes, suffix = ".bak") {
  const name = join(testDir, `case-${++sequence}${suffix}`);
  writeFileSync(name, bytes);
  return name;
}
function sha(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function entry(path, kind, source) {
  return { path, kind, size: source.length, sha256: sha(source), source };
}
function base(entries) {
  return { format: "levix-backup-manifest", version: 1,
    created: "2026-10-31T12:00:00.000Z", app: "Levix", schema: 0,
    platform: "node", account: { lid: "123@lid", pn: null }, counts: {}, apiKeys: [], entries };
}
function plain(manifest, data = []) {
  const encoded = Buffer.from(JSON.stringify(manifest));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(encoded.length);
  return Buffer.concat([Buffer.from("LEVIXPL1"), length, encoded, ...data, Buffer.from("LEVIXEND")]);
}
async function caught(label, action, expected) {
  try {
    await action();
    ok(label, false, "expected rejection");
  } catch (error) {
    errors.push(error);
    ok(label, error?.code === expected, `expected ${expected}, got ${error?.code}`);
  }
}
function caughtSync(label, action, expected) {
  try {
    action();
    ok(label, false, "expected rejection");
  } catch (error) {
    errors.push(error);
    ok(label, error?.code === expected, `expected ${expected}, got ${error?.code}`);
  }
}

const keys = await _internal.deriveKeys(PASSWORD, { ...kdf, salt: salt.toString("base64") });
function sealed(payload, options = {}) {
  return _internal.sealRaw(payload, { keys, kdf, salt, ...options });
}
async function openRaw(bytes) { return _internal.openWithKeys({ path: file(bytes), keys }); }
async function badRaw(label, bytes, code) {
  await caught(label, async () => {
    const archive = await openRaw(bytes);
    await archive.extract({ dest: mkdtempSync(join(testDir, "bad-")) });
  }, code);
}

section("round trip and extraction");
const stickerId = "ab" + "0".repeat(62);
const data = [
  entry("db/levix.db", "db", Buffer.from("SQLite format 3\0test database")),
  entry("secrets.json", "secrets", Buffer.from(`{"gemini_api_key":"${SECRET}"}`)),
  entry("persona.md", "persona", Buffer.from("helpful bot")),
  entry("memory/one.md", "memory", Buffer.from("memory one")),
  entry("memory/chats/two.md", "memory", Buffer.from("memory two")),
  entry(`stickers/ab/${stickerId}.webp`, "sticker", randomBytes(200000)),
  entry(`stickers/ab/${stickerId}.thumb.webp`, "sticker", randomBytes(400)),
  entry(`stickers/ab/${"ab" + "1".repeat(62)}.webp`, "sticker", randomBytes(500)),
  entry("media/schedules/voice.ogg", "schedule-media", Buffer.from("audio")),
];
const manifest = { ...base(data.map(({ path, kind, size, sha256 }) => ({ path, kind, size, sha256 }))),
  apiKeys: ["gemini_api_key"] };
const outPath = join(testDir, "round.bak");
const progress = [];
const written = await writeBackup({ outPath, password: PASSWORD, manifest: { ...manifest, entries: undefined },
  entries: data, kdf, onProgress: (update) => { if (update.phase === "write") progress.push(update); } });
ok("written size matches disk", written.size === statSync(outPath).size);
ok("written sha256 matches disk", written.sha256 === sha(readFileSync(outPath)));
const entryBytes = data.reduce((sum, item) => sum + item.size, 0);
ok("write progress uses the entry total", progress.length > 0 && progress.every((update) => update.totalBytes === entryBytes));
ok("write progress is non-decreasing", progress.every((update, i) => i === 0 || update.bytes >= progress[i - 1].bytes));
ok("write progress ends at the total", progress.at(-1)?.bytes === entryBytes);
if (process.platform !== "win32") ok("backup mode 0600", (statSync(outPath).mode & 0o777) === 0o600);
const opened = await openBackup({ path: outPath, password: PASSWORD });
ok("manifest round trips", JSON.stringify(opened.manifest) === JSON.stringify(manifest));
const dest = mkdtempSync(join(testDir, "extract-"));
const report = await opened.extract({ dest });
ok("all entries extracted", report.entries === data.length);
ok("entry byte total reported", report.bytes === data.reduce((n, item) => n + item.size, 0));
for (const item of data) {
  const target = join(dest, item.path);
  ok(`${item.path} matches`, readFileSync(target).equals(item.source));
  if (process.platform !== "win32") ok(`${item.path} mode 0600`, (statSync(target).mode & 0o777) === 0o600);
}

section("exact full final chunk");
const tiny = base([{ path: "db/levix.db", kind: "db", size: 0, sha256: sha(Buffer.alloc(0)) }]);
const gz = gzipSync(plain(tiny));
// A gzip FEXTRA header makes the compressed payload exactly one full chunk.
const extra = LIMITS.chunk - gz.length - 2;
const fullGzip = Buffer.concat([gz.subarray(0, 3), Buffer.from([gz[3] | 4]),
  gz.subarray(4, 10), Buffer.from([extra & 255, extra >> 8]), Buffer.alloc(extra), gz.subarray(10)]);
ok("compressed payload fills one chunk", fullGzip.length === LIMITS.chunk);
const exact = await openRaw(sealed(fullGzip));
const exactDest = mkdtempSync(join(testDir, "exact-"));
await exact.extract({ dest: exactDest });
ok("full final chunk extracts", readFileSync(join(exactDest, "db/levix.db")).length === 0);

section("password and header");
await caught("wrong password", () => openBackup({ path: outPath, password: "different-password-marker" }), "WRONG_PASSWORD");
const emptyDest = mkdtempSync(join(testDir, "wrong-password-"));
ok("wrong password left destination empty", readFileSync(outPath).length > 0 && !existsSync(join(emptyDest, "db")));
const sample = sealed(gzipSync(plain(tiny)));
const head = (override) => sealed(gzipSync(plain(tiny)), { headerOverride: override });
for (const [label, override, code] of [
  ["unknown header field", { rogue: 1 }, "BAD_HEADER"],
  ["header version 2", { version: 2 }, "UNSUPPORTED_VERSION"],
  ["wrong chunk", { chunk: 4096 }, "BAD_HEADER"],
  ["N too low", { kdf: { N: 16384 } }, "KDF_LIMIT"],
  ["N too high", { kdf: { N: 524288 } }, "KDF_LIMIT"],
  ["N not power of two", { kdf: { N: 50000 } }, "KDF_LIMIT"],
  ["r too high", { kdf: { r: 16 } }, "KDF_LIMIT"],
  ["p too high", { kdf: { p: 2 } }, "KDF_LIMIT"],
  ["short salt", { kdf: { salt: Buffer.alloc(16).toString("base64") } }, "BAD_HEADER"],
  ["unknown KDF field", { kdf: { rogue: 1 } }, "BAD_HEADER"],
  ["wrong KDF name", { kdf: { name: "pbkdf2" } }, "BAD_HEADER"],
]) await badRaw(label, head(override), code);
const tamperedHeader = Buffer.from(sample);
const saltAt = tamperedHeader.indexOf(Buffer.from(salt.toString("base64")));
tamperedHeader[saltAt] = tamperedHeader[saltAt] === 65 ? 66 : 65;
await badRaw("valid JSON header byte changed", tamperedHeader, "WRONG_PASSWORD");
for (const [label, bytes, code] of [
  ["hlen zero", Buffer.concat([sample.subarray(0, 8), Buffer.alloc(4), sample.subarray(12)]), "BAD_HEADER"],
  ["hlen 5000", (() => { const b = Buffer.from(sample); b.writeUInt32BE(5000, 8); return b; })(), "BAD_HEADER"],
  ["wrong magic", Buffer.from("OTHERBAK"), "NOT_A_BACKUP"],
  ["empty file", Buffer.alloc(0), "NOT_A_BACKUP"],
  ["header only", sample.subarray(0, 12 + sample.readUInt32BE(8) + 32), "DAMAGED"],
]) await badRaw(label, bytes, code);

section("chunk authentication and framing");
const largePlain = plain(base([{ path: "db/levix.db", kind: "db", size: 210000, sha256: sha(randomBytes(1)) }]));
// Random entry bytes force several encrypted chunks; manifest checks stop at open,
// while extraction checks the deliberately mismatched checksum.
const wire = sealed(gzipSync(Buffer.concat([largePlain.subarray(0, -8), randomBytes(210000), Buffer.from("LEVIXEND")])));
const offset = 12 + wire.readUInt32BE(8) + 32;
const step = LIMITS.chunk + 16;
ok("adversarial file has middle chunks", wire.length - offset > step * 2);
for (const [label, at] of [["first chunk", offset], ["middle chunk", offset + step + 5],
  ["last chunk", wire.length - 20], ["tag", offset + step - 1]]) {
  const copy = Buffer.from(wire);
  copy[at] ^= 1;
  await badRaw(`tampered ${label}`, copy, "DAMAGED");
}
for (const [label, bytes] of [
  ["drop final chunk", wire.subarray(0, offset + step * 2)],
  ["cut mid-chunk", wire.subarray(0, offset + step + 11)],
  ["append byte", Buffer.concat([wire, Buffer.from([1])])],
  ["append last chunk", Buffer.concat([wire, wire.subarray(offset + step * 2)])],
  ["reorder chunks", Buffer.concat([wire.subarray(0, offset), wire.subarray(offset + step, offset + step * 2), wire.subarray(offset, offset + step), wire.subarray(offset + step * 2)])],
  ["duplicate chunk", Buffer.concat([wire.subarray(0, offset + step), wire.subarray(offset, offset + step), wire.subarray(offset + step)])],
  ["drop middle chunk", Buffer.concat([wire.subarray(0, offset + step), wire.subarray(offset + step * 2)])],
]) await badRaw(label, bytes, "DAMAGED");

section("manifest validation");
const db = tiny.entries[0];
async function badManifest(label, changed, code = "BAD_MANIFEST") {
  await badRaw(label, sealed(gzipSync(plain(changed))), code);
}
await badManifest("unknown top field", { ...tiny, rogue: 1 });
await badManifest("two db entries", { ...tiny, entries: [db, db] });
await badManifest("no db", { ...tiny, entries: [] });
await badManifest("unknown kind", { ...tiny, entries: [db, { ...db, kind: "unknown" }] });
for (const badPath of ["../x", "/abs", "memory/../x", "memory/a//b.md", "a/b/c/d/e",
  `stickers/ff/${stickerId}.webp`, `stickers/ab/${stickerId.toUpperCase()}.webp`])
  await badManifest(`bad path ${badPath}`, { ...tiny, entries: [db,
    { ...db, kind: badPath.startsWith("stickers/") ? "sticker" : "memory", path: badPath }] });
await badManifest("case-folded duplicate", { ...tiny, entries: [db,
  { ...db, kind: "memory", path: "memory/Case.md" }, { ...db, kind: "memory", path: "memory/case.md" }] });
await badManifest("db size limit", { ...tiny, entries: [{ ...db, size: LIMITS.db + 1 }] }, "LIMIT");
await badManifest("other size limit", { ...tiny, entries: [db, { ...db, kind: "persona", path: "persona.md", size: LIMITS.entry + 1 }] }, "LIMIT");
await badManifest("total size limit", { ...tiny, entries: [db,
  ...Array.from({ length: 257 }, (_, i) => ({ ...db, kind: "memory", path: `memory/${i}.md`, size: LIMITS.entry }))] }, "LIMIT");
await badManifest("bad lid", { ...tiny, account: { lid: "bad@lid", pn: null } });
await badManifest("bad pn", { ...tiny, account: { lid: null, pn: "12@s.whatsapp.net" } });
await badManifest("both account IDs null", { ...tiny, account: { lid: null, pn: null } });
await badManifest("unknown count", { ...tiny, counts: { rogue: 1 } });
await badManifest("apiKeys missing", { ...tiny, apiKeys: undefined });
await badManifest("apiKeys not an array", { ...tiny, apiKeys: "gemini_api_key" });
await badManifest("apiKeys duplicate", { ...tiny, apiKeys: ["gemini_api_key", "gemini_api_key"] });
await badManifest("apiKeys bad name", { ...tiny, apiKeys: ["Gemini-Key"] });
await badManifest("apiKeys over 32", { ...tiny, apiKeys: Array.from({ length: 33 }, (_, i) => `key_${i}`) });
await badManifest("manifest version 2", { ...tiny, version: 2 }, "UNSUPPORTED_VERSION");
caughtSync("too many entries", () => validateManifest({ ...tiny, entries: Array(LIMITS.entries + 1).fill(db) }), "LIMIT");

section("inner payload and inflation");
const wrongInner = Buffer.from(plain(tiny));
wrongInner[0] ^= 1;
await badRaw("wrong inner marker", sealed(gzipSync(wrongInner)), "DAMAGED");
const zeroLength = Buffer.from(plain(tiny));
zeroLength.writeUInt32BE(0, 8);
await badRaw("manifest length zero", sealed(gzipSync(zeroLength)), "BAD_MANIFEST");
const longLength = Buffer.from(plain(tiny));
longLength.writeUInt32BE(LIMITS.manifest + 1, 8);
await badRaw("manifest length over limit", sealed(gzipSync(longLength)), "LIMIT");
const shortEntry = base([{ ...db, size: 10 }]);
const short = await openRaw(sealed(gzipSync(plain(shortEntry))));
await caught("entry shorter than declared", () => short.extract({ dest: mkdtempSync(join(testDir, "short-")) }), "DAMAGED");
const trailing = await openRaw(sealed(gzipSync(Buffer.concat([plain(tiny), Buffer.from([1])]))));
await caught("bytes after end", () => trailing.extract({ dest: mkdtempSync(join(testDir, "trail-")) }), "DAMAGED");
const missing = await openRaw(sealed(gzipSync(plain(tiny).subarray(0, -8))));
await caught("missing end", () => missing.extract({ dest: mkdtempSync(join(testDir, "missing-")) }), "DAMAGED");
async function compressedBomb() {
  const zip = createGzip({ level: 6 });
  const producer = Readable.from((async function* () {
    const limited = base([{ ...db, size: 10, sha256: sha(Buffer.alloc(10)) }]);
    yield plain(limited).subarray(0, -8);
    const block = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < 50; i++) yield block;
    yield Buffer.from("LEVIXEND");
  })());
  producer.pipe(zip);
  const pieces = [];
  for await (const piece of zip) pieces.push(piece);
  return Buffer.concat(pieces);
}
const bomb = await openRaw(sealed(await compressedBomb()));
const bombDest = mkdtempSync(join(testDir, "bomb-"));
await caught("inflation bomb", () => bomb.extract({ dest: bombDest }), "LIMIT");
ok("bomb did not write beyond declared size", !existsSync(join(bombDest, "db/levix.db")) ||
  statSync(join(bombDest, "db/levix.db")).size <= 10);

section("writer failures and destination rules");
const sourcePath = file(Buffer.from("actual"), ".src");
for (const [label, altered] of [
  ["source checksum changed", { sha256: "0".repeat(64) }],
  ["source length changed", { size: 7 }],
]) {
  const output = join(testDir, `changed-${++sequence}.bak`);
  await caught(label, () => writeBackup({ outPath: output, password: PASSWORD,
    manifest: { ...tiny, entries: undefined }, entries: [{ ...db, ...altered, source: sourcePath }], kdf }), "SOURCE_CHANGED");
  ok(`${label} removed part`, !existsSync(`${output}.part`) && !existsSync(output));
}
for (const [label, password, value, code] of [
  ["invalid password first", "short", tiny, "BAD_PASSWORD"],
  ["invalid manifest first", PASSWORD, { ...tiny, entries: undefined, account: { lid: null, pn: null } }, "BAD_MANIFEST"],
]) {
  const output = join(testDir, `preflight-${++sequence}.bak`);
  await caught(label, () => writeBackup({ outPath: output, password, manifest: value,
    entries: [{ ...db, source: Buffer.alloc(0) }], kdf }), code);
  ok(`${label} created no file`, !existsSync(output) && !existsSync(`${output}.part`));
}
const nonempty = mkdtempSync(join(testDir, "nonempty-"));
writeFileSync(join(nonempty, "occupied"), "x");
const single = await openBackup({ path: outPath, password: PASSWORD });
await caught("nonempty destination", () => single.extract({ dest: nonempty }), "IO");
await caught("second extraction", () => single.extract({ dest: nonempty }), "IO");
if (typeof process.getuid === "function") {
  const shared = mkdtempSync(join(testDir, "shared-"));
  chmodSync(shared, 0o755);
  const sharedBackup = await openBackup({ path: outPath, password: PASSWORD });
  await caught("0755 destination refused", () => sharedBackup.extract({ dest: shared }), "IO");

  const privateDest = mkdtempSync(join(testDir, "private-"));
  chmodSync(privateDest, 0o700);
  const privateBackup = await openBackup({ path: outPath, password: PASSWORD });
  const privateReport = await privateBackup.extract({ dest: privateDest });
  ok("0700 destination extracts", privateReport.entries === data.length &&
    readFileSync(join(privateDest, "db/levix.db")).equals(data[0].source));
}

section("in-memory secrets extraction");
const memDest = mkdtempSync(join(testDir, "in-memory-"));
const memOpened = await openBackup({ path: outPath, password: PASSWORD });
const memReport = await memOpened.extract({ dest: memDest, inMemoryKinds: ["secrets"] });
ok("in-memory extract writes no secrets.json", !existsSync(join(memDest, "secrets.json")));
ok("in-memory extract returns secrets bytes",
  Buffer.isBuffer(memReport.memory["secrets.json"]) && memReport.memory["secrets.json"].equals(data[1].source));
ok("in-memory extract still writes other files", readFileSync(join(memDest, "db/levix.db")).equals(data[0].source));
ok("in-memory extract reports all entries", memReport.entries === data.length);
ok("in-memory extract reports all bytes", memReport.bytes === data.reduce((n, item) => n + item.size, 0));
try {
  const badKinds = await openBackup({ path: outPath, password: PASSWORD });
  await badKinds.extract({ dest: mkdtempSync(join(testDir, "bad-kinds-")), inMemoryKinds: ["persona"] });
  ok("non-secrets inMemoryKinds rejected", false);
} catch (error) {
  ok("non-secrets inMemoryKinds rejected", error instanceof TypeError);
}
const secretBytes = Buffer.from(`{"settings":{"gemini_api_key":"${SECRET}"}}`);
const tamperedSecrets = await openRaw(sealed(gzipSync(plain(base([db,
  { path: "secrets.json", kind: "secrets", size: secretBytes.length, sha256: "0".repeat(64) }]), [secretBytes]))));
const tamperedDest = mkdtempSync(join(testDir, "tampered-secrets-"));
await caught("tampered in-memory secrets checksum", () => tamperedSecrets.extract({
  dest: tamperedDest, inMemoryKinds: ["secrets"],
}), "DAMAGED");
ok("tampered in-memory secrets wrote no secrets.json", !existsSync(join(tamperedDest, "secrets.json")));
const hugeSecrets = await openRaw(sealed(gzipSync(plain(base([db,
  { path: "secrets.json", kind: "secrets", size: LIMITS.memory + 1, sha256: sha(Buffer.alloc(0)) }])))));
await caught("in-memory secrets over 1 MiB", () => hugeSecrets.extract({
  dest: mkdtempSync(join(testDir, "huge-secrets-")), inMemoryKinds: ["secrets"],
}), "LIMIT");

section("KDF queue and secret-safe errors");
const requests = Array.from({ length: 4 }, () => _internal.deriveKeys(PASSWORD,
  { ...kdf, salt: salt.toString("base64") }).then(() => "ok", (error) => {
    errors.push(error);
    return error.code;
  }));
const outcomes = await Promise.all(requests);
ok("one excess derivation is busy", outcomes.filter((x) => x === "BUSY").length >= 1);
ok("accepted derivations resolve", outcomes.filter((x) => x === "ok").length >= 1);
caughtSync("password validator rejects short input", () => validatePassword("short"), "BAD_PASSWORD");
ok("no error reveals password or secret entry", errors.every((error) =>
  !error.message.includes(PASSWORD) && !error.message.includes(SECRET)));

finish();

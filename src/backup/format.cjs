// Version 1 encrypted backups. The header authenticates the KDF parameters
// before any payload is opened; the final chunk flag authenticates EOF.

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const { Readable } = require("node:stream");
const zlib = require("node:zlib");
const { promisify, TextDecoder } = require("node:util");

const CODES = Object.freeze([
  "NOT_A_BACKUP", "UNSUPPORTED_VERSION", "BAD_HEADER", "KDF_LIMIT",
  "WRONG_PASSWORD", "DAMAGED", "BAD_MANIFEST", "LIMIT", "BAD_PASSWORD",
  "SOURCE_CHANGED", "BUSY", "IO",
]);
const DEFAULT_KDF = Object.freeze({ N: 131072, r: 8, p: 1 });
const LIMITS = Object.freeze({
  header: 4096, manifest: 8 * 1024 * 1024, chunk: 65536,
  file: 16 * 1024 ** 3, db: 4 * 1024 ** 3, entry: 64 * 1024 ** 2,
  memory: 1024 ** 2,
  entries: 200000, passwordPointsMin: 12, passwordPointsMax: 1024,
  passwordBytes: 4096, saltBytes: 32, kdfMinN: 32768, kdfMaxN: 262144,
  maxPathSegments: 4,
});
const MAGIC = Buffer.from("LEVIXBAK");
const INNER = Buffer.from("LEVIXPL1");
const END = Buffer.from("LEVIXEND");
const TAG = 16;
const WIRE_CHUNK = LIMITS.chunk + TAG;
const scrypt = promisify(crypto.scrypt);

class BackupError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BackupError";
    this.code = code;
  }
}

function fail(code, message) { throw new BackupError(code, message); }
function io(error) {
  if (error instanceof BackupError) return error;
  const result = new BackupError("IO", "Backup I/O failed");
  result.cause = error;
  return result;
}
function exactKeys(value, names, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !names.includes(key)) ||
      names.some((key) => !Object.hasOwn(value, key))) fail(code, "Invalid backup metadata");
}
function allowedKeys(value, names, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !names.includes(key))) fail(code, "Invalid backup metadata");
}
function safeSize(value) { return Number.isSafeInteger(value) && value >= 0; }

function validatePassword(password) {
  if (typeof password !== "string") fail("BAD_PASSWORD", "Invalid backup password");
  const normalized = password.normalize("NFC");
  const points = [...normalized].length;
  if (points < LIMITS.passwordPointsMin || points > LIMITS.passwordPointsMax ||
      Buffer.byteLength(normalized, "utf8") > LIMITS.passwordBytes)
    fail("BAD_PASSWORD", "Invalid backup password");
  return normalized;
}

function validPath(entry) {
  const segments = entry.path.split("/");
  const segment = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/;
  if (segments.length > LIMITS.maxPathSegments || segments.some((s) => !segment.test(s) || s === "..")) return false;
  if (entry.kind === "db") return entry.path === "db/levix.db";
  if (entry.kind === "secrets") return entry.path === "secrets.json";
  if (entry.kind === "persona") return entry.path === "persona.md";
  if (entry.kind === "memory")
    return (segments.length === 2 && segments[0] === "memory" && segments[1].endsWith(".md")) ||
      (segments.length === 3 && segments[0] === "memory" && segments[1] === "chats" && segments[2].endsWith(".md"));
  if (entry.kind === "schedule-media")
    return segments.length === 3 && segments[0] === "media" && segments[1] === "schedules";
  if (entry.kind === "sticker") {
    const match = /^stickers\/([0-9a-f]{2})\/([0-9a-f]{64})(?:\.thumb)?\.webp$/.exec(entry.path);
    return !!match && match[1] === match[2].slice(0, 2);
  }
  return false;
}

// Optional: digests of the restorable settings and API keys, so the restore
// preview can list what changes. Files from earlier v1 builds have none.
function validateDigests(digests, apiKeys) {
  exactKeys(digests, ["settings", "apiKeys"], "BAD_MANIFEST");
  const map = (value, keyRe, limit) => value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length <= limit &&
    Object.entries(value).every(([key, hash]) => keyRe.test(key) && typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash));
  if (!map(digests.settings, /^[a-z][a-z0-9_:]{0,95}$/, 1024) || !map(digests.apiKeys, /^[a-z][a-z0-9_]{0,63}$/, 32))
    fail("BAD_MANIFEST", "Invalid manifest digests");
  const names = Object.keys(digests.apiKeys).sort();
  if (JSON.stringify(names) !== JSON.stringify([...apiKeys].sort()))
    fail("BAD_MANIFEST", "Manifest digests do not match the API key names");
}

function validateManifest(manifest) {
  const required = ["format", "version", "created", "app", "schema", "platform", "account", "counts", "apiKeys", "entries"];
  const hasDigests = Boolean(manifest) && typeof manifest === "object" && Object.hasOwn(manifest, "digests");
  exactKeys(manifest, hasDigests ? [...required, "digests"] : required, "BAD_MANIFEST");
  if (manifest.format !== "levix-backup-manifest") fail("BAD_MANIFEST", "Invalid manifest format");
  if (manifest.version !== 1) fail("UNSUPPORTED_VERSION", "Unsupported manifest version");
  if (typeof manifest.created !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(manifest.created) ||
      Number.isNaN(Date.parse(manifest.created)) || new Date(manifest.created).toISOString() !== manifest.created)
    fail("BAD_MANIFEST", "Invalid manifest date");
  if (typeof manifest.app !== "string" || [...manifest.app].length > 64 ||
      typeof manifest.platform !== "string" || [...manifest.platform].length > 64 ||
      !safeSize(manifest.schema)) fail("BAD_MANIFEST", "Invalid manifest metadata");
  if (manifest.account !== null) {
    exactKeys(manifest.account, ["lid", "pn"], "BAD_MANIFEST");
    const { lid, pn } = manifest.account;
    if ((lid !== null && (typeof lid !== "string" || !/^\d{1,32}@lid$/.test(lid))) ||
        (pn !== null && (typeof pn !== "string" || !/^\d{5,20}@s\.whatsapp\.net$/.test(pn))) ||
        (lid === null && pn === null)) fail("BAD_MANIFEST", "Invalid account metadata");
  }
  allowedKeys(manifest.counts, ["settings", "apiKeys", "schedules", "groups", "roles", "conversations", "memoryFiles", "stickers", "packs"], "BAD_MANIFEST");
  if (Object.values(manifest.counts).some((n) => !safeSize(n))) fail("BAD_MANIFEST", "Invalid manifest counts");
  if (!Array.isArray(manifest.apiKeys) || manifest.apiKeys.length > 32 ||
      manifest.apiKeys.some((name) => typeof name !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(name)) ||
      new Set(manifest.apiKeys).size !== manifest.apiKeys.length)
    fail("BAD_MANIFEST", "Invalid API key names");
  if (hasDigests) validateDigests(manifest.digests, manifest.apiKeys);
  if (!Array.isArray(manifest.entries)) fail("BAD_MANIFEST", "Invalid manifest entries");
  if (manifest.entries.length > LIMITS.entries) fail("LIMIT", "Too many backup entries");
  const paths = new Set();
  let dbCount = 0;
  let secretsCount = 0;
  let personaCount = 0;
  let total = 0;
  for (const entry of manifest.entries) {
    exactKeys(entry, ["path", "kind", "size", "sha256"], "BAD_MANIFEST");
    if (typeof entry.path !== "string" || !validPath(entry) ||
        typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256) ||
        !safeSize(entry.size)) fail("BAD_MANIFEST", "Invalid backup entry");
    const folded = entry.path.toLowerCase();
    if (paths.has(folded)) fail("BAD_MANIFEST", "Duplicate backup path");
    paths.add(folded);
    if (entry.size > (entry.kind === "db" ? LIMITS.db : LIMITS.entry)) fail("LIMIT", "Backup entry too large");
    total += entry.size;
    if (total > LIMITS.file) fail("LIMIT", "Backup payload too large");
    dbCount += Number(entry.kind === "db");
    secretsCount += Number(entry.kind === "secrets");
    personaCount += Number(entry.kind === "persona");
  }
  if (dbCount !== 1 || secretsCount > 1 || personaCount > 1) fail("BAD_MANIFEST", "Invalid entry set");
}

function strictSalt(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(value)) return false;
  const bytes = Buffer.from(value, "base64");
  return bytes.length === LIMITS.saltBytes && bytes.toString("base64") === value;
}
function validateKdf(kdf) {
  exactKeys(kdf, ["name", "N", "r", "p", "salt"], "BAD_HEADER");
  if (kdf.name !== "scrypt" || !strictSalt(kdf.salt)) fail("BAD_HEADER", "Invalid backup KDF");
  if (!Number.isInteger(kdf.N) || kdf.N < LIMITS.kdfMinN || kdf.N > LIMITS.kdfMaxN ||
      (kdf.N & (kdf.N - 1)) !== 0 || kdf.r !== 8 || kdf.p !== 1)
    fail("KDF_LIMIT", "Unsupported backup KDF parameters");
}
function validateHeader(header) {
  exactKeys(header, ["format", "version", "cipher", "chunk", "kdf"], "BAD_HEADER");
  if (header.format !== "levix-backup") fail("BAD_HEADER", "Invalid backup format");
  if (header.version !== 1) fail("UNSUPPORTED_VERSION", "Unsupported backup version");
  if (header.cipher !== "aes-256-gcm" || header.chunk !== LIMITS.chunk)
    fail("BAD_HEADER", "Invalid backup cipher");
  validateKdf(header.kdf);
}
function parseJson(bytes, code) {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { fail(code, "Invalid backup JSON"); }
}

let deriving = false;
const waiters = [];
async function deriveKeys(password, kdf) {
  const normalized = validatePassword(password);
  const parameters = { name: "scrypt", ...kdf };
  validateKdf(parameters);
  // The queue caps expensive scrypt work and its memory to one worker at a time.
  if (deriving) {
    if (waiters.length >= 2) fail("BUSY", "Backup key derivation busy");
    await new Promise((resolve) => waiters.push(resolve));
  } else deriving = true;
  try {
    const key = await scrypt(normalized, Buffer.from(parameters.salt, "base64"), 64, {
      N: parameters.N, r: parameters.r, p: parameters.p,
      maxmem: 128 * parameters.N * parameters.r + 1024 * 1024,
    });
    return { encKey: key.subarray(0, 32), macKey: key.subarray(32, 64) };
  } finally {
    if (waiters.length) waiters.shift()();
    else deriving = false;
  }
}
function headerBytes(header) {
  const bytes = Buffer.from(JSON.stringify(header));
  if (!bytes.length || bytes.length > LIMITS.header) fail("BAD_HEADER", "Invalid header length");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return { bytes, prefix: Buffer.concat([MAGIC, length, bytes]) };
}
function headerFor(kdf, salt) {
  return { format: "levix-backup", version: 1, cipher: "aes-256-gcm", chunk: LIMITS.chunk,
    kdf: { name: "scrypt", N: kdf.N, r: kdf.r, p: kdf.p, salt: salt.toString("base64") } };
}
function nonce(index, final) {
  const result = Buffer.alloc(12);
  // Eleven bytes leave a nonce domain far beyond the 16 GiB file limit.
  result.writeBigUInt64BE(BigInt(index), 3);
  result[11] = Number(final);
  return result;
}
function sealChunk(bytes, index, final, keys, aad) {
  const cipher = crypto.createCipheriv("aes-256-gcm", keys.encKey, nonce(index, final));
  cipher.setAAD(aad);
  return Buffer.concat([cipher.update(bytes), cipher.final(), cipher.getAuthTag()]);
}
function openChunk(bytes, index, final, keys, aad) {
  if (bytes.length < 17) fail("DAMAGED", "Truncated backup chunk");
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", keys.encKey, nonce(index, final));
    decipher.setAAD(aad);
    decipher.setAuthTag(bytes.subarray(bytes.length - TAG));
    return Buffer.concat([decipher.update(bytes.subarray(0, -TAG)), decipher.final()]);
  } catch { fail("DAMAGED", "Backup chunk authentication failed"); }
}
async function readHeader(filePath) {
  let handle;
  try {
    handle = await fsp.open(filePath, "r");
    const stat = await handle.stat();
    if (stat.size > LIMITS.file) fail("LIMIT", "Backup file too large");
    const first = Buffer.alloc(12);
    const start = await handle.read(first, 0, 12, 0);
    if (start.bytesRead < 8 || !first.subarray(0, 8).equals(MAGIC)) fail("NOT_A_BACKUP", "Not a Levix backup");
    if (start.bytesRead < 12) fail("DAMAGED", "Truncated backup header");
    const hlen = first.readUInt32BE(8);
    if (hlen < 1 || hlen > LIMITS.header) fail("BAD_HEADER", "Invalid backup header length");
    if (stat.size < 12 + hlen + 32 + 17) fail("DAMAGED", "Truncated backup file");
    const rest = Buffer.alloc(hlen + 32);
    const got = await handle.read(rest, 0, rest.length, 12);
    if (got.bytesRead !== rest.length) fail("DAMAGED", "Truncated backup header");
    const header = parseJson(rest.subarray(0, hlen), "BAD_HEADER");
    validateHeader(header);
    return { header, prefix: Buffer.concat([first, rest.subarray(0, hlen)]),
      hmac: rest.subarray(hlen), offset: 12 + hlen + 32 };
  } catch (error) { throw io(error); }
  finally { await handle?.close(); }
}
function verifyHeader(info, keys) {
  const expected = crypto.createHmac("sha256", keys.macKey).update(info.prefix).digest();
  if (!crypto.timingSafeEqual(expected, info.hmac)) fail("WRONG_PASSWORD", "Wrong backup password or changed header");
}
async function* decrypted(filePath, info, keys) {
  let pending = Buffer.alloc(0);
  let index = 0;
  let seen = info.offset;
  const input = fs.createReadStream(filePath, { start: info.offset });
  try {
    for await (const data of input) {
      seen += data.length;
      if (seen > LIMITS.file) fail("LIMIT", "Backup file too large");
      pending = Buffer.concat([pending, data]);
      // Hold a whole wire chunk until another byte proves it is not final.
      while (pending.length > WIRE_CHUNK) {
        yield openChunk(pending.subarray(0, WIRE_CHUNK), index++, false, keys, info.hmac);
        pending = pending.subarray(WIRE_CHUNK);
      }
    }
    if (pending.length < 17 || pending.length > WIRE_CHUNK) fail("DAMAGED", "Truncated backup tail");
    yield openChunk(pending, index, true, keys, info.hmac);
  } catch (error) { throw error instanceof BackupError ? error : io(error); }
  finally { input.destroy(); }
}
function payloadStream(filePath, info, keys) {
  const source = Readable.from(decrypted(filePath, info, keys));
  const unzip = zlib.createGunzip();
  source.on("error", (error) => unzip.destroy(error));
  source.pipe(unzip);
  return { source, unzip };
}
class ByteReader {
  constructor(stream) {
    this.iterator = stream[Symbol.asyncIterator]();
    this.pending = Buffer.alloc(0);
    this.count = 0;
    // One output chunk may straddle the manifest boundary before its length is known.
    this.limit = 20 + LIMITS.manifest + LIMITS.chunk;
    this.readingManifest = true;
  }
  async pull() {
    const next = await this.iterator.next();
    if (next.done) return false;
    this.pending = next.value;
    this.count += this.pending.length;
    if (this.readingManifest && this.count > this.limit)
      fail("LIMIT", "Inflated backup exceeds manifest limit");
    return true;
  }
  async read(size, onBytes) {
    const pieces = onBytes ? null : [];
    let remaining = size;
    while (remaining) {
      if (!this.pending.length && !(await this.pull())) fail("DAMAGED", "Truncated backup payload");
      const piece = this.pending.subarray(0, Math.min(remaining, this.pending.length));
      if (onBytes) await onBytes(piece);
      else pieces.push(piece);
      this.pending = this.pending.subarray(piece.length);
      remaining -= piece.length;
    }
    return pieces ? Buffer.concat(pieces) : undefined;
  }
  async end() {
    if (this.pending.length || await this.pull()) fail("DAMAGED", "Trailing backup payload");
  }
}
async function readManifest(reader) {
  if (!(await reader.read(8)).equals(INNER)) fail("DAMAGED", "Invalid backup payload marker");
  const length = (await reader.read(4)).readUInt32BE();
  if (!length) fail("BAD_MANIFEST", "Empty backup manifest");
  if (length > LIMITS.manifest) fail("LIMIT", "Backup manifest too large");
  const bytes = await reader.read(length);
  const manifest = parseJson(bytes, "BAD_MANIFEST");
  validateManifest(manifest);
  const total = manifest.entries.reduce((sum, item) => sum + item.size, 0);
  reader.limit = 20 + length + total;
  reader.readingManifest = false;
  return { manifest, bytes, total };
}
async function withPayload(filePath, info, keys, action) {
  const { source, unzip } = payloadStream(filePath, info, keys);
  try { return await action(new ByteReader(unzip)); }
  catch (error) {
    if (error instanceof BackupError) throw error;
    // zlib's failures indicate corrupt authenticated plaintext, not I/O.
    if (error?.code?.startsWith?.("Z_")) fail("DAMAGED", "Invalid backup compression");
    throw io(error);
  } finally {
    const closed = source.closed ? Promise.resolve() : new Promise((resolve) => source.once("close", resolve));
    source.destroy();
    unzip.destroy();
    await closed;
  }
}
async function emptyDestination(dest) {
  try {
    const stat = await fsp.lstat(dest);
    if (!stat.isDirectory() || stat.isSymbolicLink() ||
        (typeof process.getuid === "function" &&
          (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)) ||
        (await fsp.readdir(dest)).length)
      fail("IO", "Backup destination must be an empty directory");
    return await fsp.realpath(dest);
  } catch (error) { throw io(error); }
}
async function entryTarget(root, entryPath) {
  const target = path.resolve(root, entryPath);
  if (!target.startsWith(root + path.sep)) fail("BAD_MANIFEST", "Invalid backup path");
  const parts = entryPath.split("/");
  let parent = root;
  for (const part of parts.slice(0, -1)) {
    parent = path.join(parent, part);
    try { await fsp.mkdir(parent, { mode: 0o700 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    // A pre-existing link must never redirect a later file creation.
    if (!(await fsp.lstat(parent)).isDirectory() || await fsp.realpath(parent) !== parent)
      fail("IO", "Unsafe backup destination");
  }
  return target;
}
async function extractInto(filePath, info, keys, manifestBytes, dest, onProgress) {
  const root = await emptyDestination(dest);
  return withPayload(filePath, info, keys, async (reader) => {
    const current = await readManifest(reader);
    if (!current.bytes.equals(manifestBytes)) fail("DAMAGED", "Backup manifest changed");
    let done = 0;
    const memory = {};
    for (const entry of current.manifest.entries) {
      const hash = crypto.createHash("sha256");
      // Decrypted API keys stay in memory. Callers cannot opt into a file.
      if (entry.kind === "secrets") {
        if (entry.size > LIMITS.memory) fail("LIMIT", "In-memory backup entry too large");
        const buffer = await reader.read(entry.size);
        hash.update(buffer);
        done += buffer.length;
        onProgress?.({ phase: "write", bytes: done, totalBytes: current.total });
        if (hash.digest("hex") !== entry.sha256) {
          buffer.fill(0);
          fail("DAMAGED", "Backup entry checksum failed");
        }
        memory[entry.path] = buffer;
        continue;
      }
      const target = await entryTarget(root, entry.path);
      const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW || 0);
      const output = await fsp.open(target, flags, 0o600);
      try {
        await reader.read(entry.size, async (piece) => {
          hash.update(piece);
          await output.writeFile(piece);
          done += piece.length;
          onProgress?.({ phase: "write", bytes: done, totalBytes: current.total });
        });
      } finally { await output.close(); }
      if (hash.digest("hex") !== entry.sha256) fail("DAMAGED", "Backup entry checksum failed");
    }
    if (!(await reader.read(8)).equals(END)) {
      if (reader.count > reader.limit) fail("LIMIT", "Inflated backup exceeds declared size");
      fail("DAMAGED", "Missing backup end marker");
    }
    await reader.end();
    return { entries: current.manifest.entries.length, bytes: done, memory };
  });
}
async function openWithKeys({ path: filePath, keys }) {
  const info = await readHeader(filePath);
  verifyHeader(info, keys);
  const { manifest, bytes } = await withPayload(filePath, info, keys, readManifest);
  let used = false;
  return { header: info.header, manifest,
    // Callers must create dest as a private directory and remove it on any
    // failure; extraction leaves partial files for the caller to clean up.
    async extract({ dest, onProgress } = {}) {
    if (used) fail("IO", "Backup extraction already used");
    used = true;
    try { return await extractInto(filePath, info, keys, bytes, dest, onProgress); }
    catch (error) { throw io(error); }
  } };
}
async function openBackup({ path: filePath, password }) {
  const normalized = validatePassword(password);
  const info = await readHeader(filePath);
  const keys = await deriveKeys(normalized, info.header.kdf);
  return openWithKeys({ path: filePath, keys });
}

async function* rawPayload(manifestBytes, entries, onSourceBytes) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(manifestBytes.length);
  yield INNER;
  yield length;
  yield manifestBytes;
  for (const entry of entries) {
    const hash = crypto.createHash("sha256");
    let size = 0;
    const source = Buffer.isBuffer(entry.source) ? Readable.from([entry.source]) :
      fs.createReadStream(entry.source);
    for await (const bytes of source) {
      size += bytes.length;
      if (size > entry.size) fail("SOURCE_CHANGED", "Backup source changed");
      hash.update(bytes);
      onSourceBytes(bytes.length);
      yield bytes;
    }
    if (size !== entry.size || hash.digest("hex") !== entry.sha256)
      fail("SOURCE_CHANGED", "Backup source changed");
  }
  yield END;
}
async function writeAll(handle, bytes, hash, state) {
  if (state.size + bytes.length > LIMITS.file) fail("LIMIT", "Backup file too large");
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.write(bytes, offset, bytes.length - offset);
    if (!result.bytesWritten) fail("IO", "Backup write failed");
    offset += result.bytesWritten;
  }
  hash.update(bytes);
  state.size += bytes.length;
}
async function writeBackup({ outPath, password, manifest, entries, kdf = DEFAULT_KDF, onProgress }) {
  const normalized = validatePassword(password);
  if (!Array.isArray(entries)) fail("BAD_MANIFEST", "Invalid backup entries");
  const full = { ...manifest, entries: entries.map(({ path, kind, size, sha256 }) => ({ path, kind, size, sha256 })) };
  validateManifest(full);
  const manifestBytes = Buffer.from(JSON.stringify(full));
  if (!manifestBytes.length || manifestBytes.length > LIMITS.manifest) fail("LIMIT", "Backup manifest too large");
  for (const entry of entries) {
    if (!Buffer.isBuffer(entry.source) && (typeof entry.source !== "string" || !path.isAbsolute(entry.source)))
      fail("BAD_MANIFEST", "Invalid backup source");
  }
  exactKeys(kdf, ["N", "r", "p"], "BAD_HEADER");
  const salt = crypto.randomBytes(32);
  const header = headerFor(kdf, salt);
  validateHeader(header);
  onProgress?.({ phase: "kdf", bytes: 0, totalBytes: 0 });
  const keys = await deriveKeys(normalized, header.kdf);
  const { prefix } = headerBytes(header);
  const aad = crypto.createHmac("sha256", keys.macKey).update(prefix).digest();
  let handle;
  let ownsPart = false;
  const part = `${outPath}.part`;
  try {
    handle = await fsp.open(part, "wx", 0o600);
    ownsPart = true;
    const hash = crypto.createHash("sha256");
    const state = { size: 0 };
    await writeAll(handle, Buffer.concat([prefix, aad]), hash, state);
    const total = full.entries.reduce((sum, item) => sum + item.size, 0);
    let consumed = 0;
    const gzip = zlib.createGzip({ level: 6 });
    const source = Readable.from(rawPayload(manifestBytes, entries, (size) => {
      consumed += size;
      onProgress?.({ phase: "write", bytes: consumed, totalBytes: total });
    }));
    source.on("error", (error) => gzip.destroy(error));
    source.pipe(gzip);
    let pending = Buffer.alloc(0);
    let index = 0;
    try {
      for await (const bytes of gzip) {
        pending = Buffer.concat([pending, bytes]);
        while (pending.length > LIMITS.chunk) {
          await writeAll(handle, sealChunk(pending.subarray(0, LIMITS.chunk), index++, false, keys, aad), hash, state);
          pending = pending.subarray(LIMITS.chunk);
        }
      }
      if (!pending.length) fail("DAMAGED", "Empty backup payload");
      await writeAll(handle, sealChunk(pending, index, true, keys, aad), hash, state);
    } finally { source.destroy(); gzip.destroy(); }
    onProgress?.({ phase: "write", bytes: total, totalBytes: total });
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.rename(part, outPath);
    try {
      const dir = await fsp.open(path.dirname(outPath), "r");
      try { await dir.sync(); } finally { await dir.close(); }
    } catch (error) {
      if (!["EINVAL", "ENOTSUP", "EISDIR", "EPERM", "EBADF"].includes(error.code)) throw error;
    }
    return { size: state.size, sha256: hash.digest("hex") };
  } catch (error) {
    await handle?.close().catch(() => {});
    if (ownsPart) await fsp.rm(part, { force: true }).catch(() => {});
    throw io(error);
  }
}

// Test-only hooks. Production callers use writeBackup and openBackup.
function sealRaw(payloadBytes, { keys, kdf = DEFAULT_KDF, salt = crypto.randomBytes(32), headerOverride } = {}) {
  const base = headerFor(kdf, salt);
  const header = { ...base, ...headerOverride, kdf: { ...base.kdf, ...headerOverride?.kdf } };
  const { prefix } = headerBytes(header);
  const aad = crypto.createHmac("sha256", keys.macKey).update(prefix).digest();
  const chunks = [];
  for (let offset = 0, index = 0; offset < payloadBytes.length; offset += LIMITS.chunk, index++) {
    const end = Math.min(offset + LIMITS.chunk, payloadBytes.length);
    chunks.push(sealChunk(payloadBytes.subarray(offset, end), index, end === payloadBytes.length, keys, aad));
  }
  return Buffer.concat([prefix, aad, ...chunks]);
}

module.exports = { BackupError, CODES, DEFAULT_KDF, LIMITS, validatePassword, validateManifest,
  writeBackup, openBackup, _internal: { deriveKeys, sealRaw, openWithKeys } };

// Signed remote Terms releases. No network: every fetch is injected.
// Ephemeral Ed25519 keys stay in memory. The owner script is a child process
// with a temp HOME and an output directory outside this repository.

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  equal,
  finish,
  ok,
  require,
  ROOT,
  section,
  throws,
  useTempDataDir,
} from "./harness.mjs";

const dataDir = useTempDataDir("levix-legal-remote");
const home = mkdtempSync(join(tmpdir(), "levix-legal-home-"));
const outside = mkdtempSync(join(tmpdir(), "levix-legal-keys-"));
const insideKey = join(ROOT, "src", "legal", "owner-key.pem");
const cacheFile = join(dataDir, "legal", "remote-release.json");

process.on("exit", () => {
  rmSync(insideKey, { force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const document = require("./src/legal/document.cjs");
const terms = require("./src/legal/terms.cjs");
const consent = require("./src/legal/consent.cjs");
const release = require("./src/legal/release.cjs");
const remote = require("./src/legal/remote.cjs");
const keyStore = require("./src/legal/keys.cjs");
const store = require("./src/db/store.cjs");

const bundled = {
  ar: require("./src/legal/bundled/ar.json"),
  en: require("./src/legal/bundled/en.json"),
  "pt-BR": require("./src/legal/bundled/pt-BR.json"),
  "es-419": require("./src/legal/bundled/es-419.json"),
};

const shippedKeys = keyStore.TRUSTED_KEYS;
const bundledVersion = terms.bundledRelease().version;
const newerVersion = bundledVersion.includes(".")
  ? bundledVersion.replace(/\.(\d+)$/, (_m, n) => `.${Number(n) + 1}`)
  : `${bundledVersion}.1`;
const olderVersion = "2026-10-01";

function makeKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const raw = keyStore.rawFromKeyObject(publicKey);
  return {
    publicKey,
    privateKey,
    entry: { keyId: keyStore.keyIdForRaw(raw), publicKey: raw.toString("base64") },
  };
}

function documentsFor(version, mutate) {
  const documents = {};
  for (const locale of document.LOCALES) {
    const copy = JSON.parse(JSON.stringify(bundled[locale]));
    copy.version = version;
    documents[locale] = copy;
  }
  if (mutate) mutate(documents);
  return documents;
}

function signed(value, pair) {
  const payload = Buffer.from(document.canonicalJson(value), "utf8");
  return {
    keyId: pair.entry.keyId,
    payload: payload.toString("base64"),
    signature: crypto.sign(null, payload, pair.privateKey).toString("base64"),
  };
}

function jsonResponse(body, status = 200, type = "application/json; charset=utf-8") {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, { status, headers: { "content-type": type } });
}

function clearCache() {
  rmSync(cacheFile, { force: true });
  terms.invalidate();
}

function installKeys(list) {
  keyStore.TRUSTED_KEYS = Object.freeze(list);
  terms.invalidate();
}

async function attempt(run) {
  try {
    return { result: await run() };
  } catch (error) {
    return { error };
  }
}

async function refresh(fetchImpl, extra = {}) {
  return attempt(() =>
    remote.refreshRemoteRelease({
      url: remote.RELEASE_URL,
      fetchImpl,
      keys: [pair.entry],
      dataDir,
      ...extra,
    }),
  );
}

const pair = makeKey();
const other = makeKey();
const goodRelease = release.buildRelease(documentsFor(newerVersion));
const goodEnvelope = release.signRelease(goodRelease, pair.privateKey);

section("constants and shipped keys");

{
  equal("shipped trusted key list is empty", shippedKeys.length, 0);
  equal("release url", remote.RELEASE_URL, "https://levix.leviro.net/api/legal/v1/release");
  equal("body cap", remote.MAX_BODY_BYTES, 393216);
  equal("timeout", remote.TIMEOUT_MS, 5000);
  equal("first delay", remote.FIRST_DELAY_MS, 60_000);
  equal("interval", remote.INTERVAL_MS, 24 * 60 * 60 * 1000);
  let validated = false;
  try {
    keyStore.assertTrustedKeys(shippedKeys);
    validated = true;
  } catch {
    validated = false;
  }
  ok("empty trusted list validates", validated);
}

section("verifyEnvelope");

{
  equal("signRelease keyId", goodEnvelope.keyId, pair.entry.keyId);
  const verified = release.verifyEnvelope(goodEnvelope, [pair.entry]);
  equal("verified release source is remote", verified.source, "remote");
  equal("verified release version", verified.version, newerVersion);
  ok(
    "verified release is frozen",
    Object.isFrozen(verified) && Object.isFrozen(verified.documents),
  );
  for (const locale of document.LOCALES) {
    equal(
      `${locale} sha256 matches documentHash`,
      verified.documents[locale].sha256,
      document.documentHash(verified.documents[locale].document),
    );
  }
}

async function refused(label, envelope, code, keys = [pair.entry], snippet) {
  clearCache();
  let error = null;
  try {
    release.verifyEnvelope(envelope, keys);
  } catch (caught) {
    error = caught;
  }
  const { result, error: thrown } = await refresh(async () => jsonResponse(envelope), { keys });
  const message = error && error.message ? error.message : "";
  ok(
    label,
    !thrown &&
      error instanceof release.LegalReleaseError &&
      error.code === code &&
      (!snippet || message.includes(snippet)) &&
      result &&
      result.updated === false &&
      !existsSync(cacheFile),
    `${error?.code || "no-error"} ${message} ${result?.error || ""}`,
  );
}

section("refused envelopes are not cached");

{
  const payload = Buffer.from(goodEnvelope.payload, "base64");
  payload[payload.length - 1] ^= 0x01;
  await refused(
    "tampered payload",
    { ...goodEnvelope, payload: payload.toString("base64") },
    "BAD_SIGNATURE",
  );

  const signature = Buffer.from(goodEnvelope.signature, "base64");
  signature[0] ^= 0xff;
  await refused(
    "tampered signature",
    { ...goodEnvelope, signature: signature.toString("base64") },
    "BAD_SIGNATURE",
  );

  const unknownId = pair.entry.keyId.startsWith("0")
    ? `1${pair.entry.keyId.slice(1)}`
    : `0${pair.entry.keyId.slice(1)}`;
  await refused(
    "unknown keyId",
    { ...goodEnvelope, keyId: unknownId, payload: "@@@@" },
    "UNKNOWN_KEY",
  );

  await refused(
    "keyId of a different key",
    { ...goodEnvelope, keyId: other.entry.keyId },
    "BAD_SIGNATURE",
    [pair.entry, other.entry],
  );

  await refused("extra envelope key", { ...goodEnvelope, extra: 1 }, "ENVELOPE_SHAPE");

  const broken = `${goodEnvelope.payload.slice(0, 8)}\n${goodEnvelope.payload.slice(8)}`;
  await refused("non-strict base64", { ...goodEnvelope, payload: broken }, "BAD_BASE64");

  const pretty = JSON.stringify(goodRelease, null, 2);
  const prettyBytes = Buffer.from(pretty, "utf8");
  await refused(
    "non-canonical payload",
    {
      keyId: pair.entry.keyId,
      payload: prettyBytes.toString("base64"),
      signature: crypto.sign(null, prettyBytes, pair.privateKey).toString("base64"),
    },
    "NOT_CANONICAL",
  );

  const invalid = documentsFor(newerVersion, (docs) => {
    docs.en.terms.sections[0].paragraphs[0] = "See https://example.com";
  });
  await refused(
    "invalid document",
    signed({ schema: 1, version: newerVersion, documents: invalid }, pair),
    "INVALID_RELEASE",
    [pair.entry],
    "link",
  );

  const mismatch = documentsFor(newerVersion, (docs) => {
    docs.en.locale = "ar";
  });
  await refused(
    "locale key mismatch",
    signed({ schema: 1, version: newerVersion, documents: mismatch }, pair),
    "INVALID_RELEASE",
    [pair.entry],
    "declares",
  );

  const mixed = documentsFor(newerVersion, (docs) => {
    docs.ar.version = olderVersion;
  });
  await refused(
    "mixed versions",
    signed({ schema: 1, version: newerVersion, documents: mixed }, pair),
    "INVALID_RELEASE",
    [pair.entry],
    "does not match",
  );
  const mixedError = throws("buildRelease rejects mixed versions", () =>
    release.buildRelease(mixed),
  );
  equal("buildRelease mixed code", mixedError?.code, "INVALID_RELEASE");

  const missing = documentsFor(newerVersion);
  delete missing.en;
  await refused(
    "missing en",
    signed({ schema: 1, version: newerVersion, documents: missing }, pair),
    "INVALID_RELEASE",
    [pair.entry],
    "missing en",
  );

  const foreign = documentsFor(newerVersion);
  foreign.fr = JSON.parse(JSON.stringify(foreign.en));
  foreign.fr.locale = "fr";
  await refused(
    "unknown locale key",
    signed({ schema: 1, version: newerVersion, documents: foreign }, pair),
    "INVALID_RELEASE",
    [pair.entry],
    "unknown locale",
  );

  const extraRelease = { ...goodRelease, note: "no" };
  await refused(
    "extra release key",
    signed(extraRelease, pair),
    "INVALID_RELEASE",
    [pair.entry],
    "exactly",
  );
}

section("trusted key entries");

{
  const wrong = pair.entry.keyId.replace(/^./, (ch) => (ch === "a" ? "b" : "a"));
  const mismatch = throws("mismatched keyId is rejected", () =>
    keyStore.assertTrustedKeys([{ keyId: wrong, publicKey: pair.entry.publicKey }]),
  );
  equal("mismatched keyId name", mismatch?.name, "LegalKeyError");
  const shortKey = throws("short public key is rejected", () =>
    keyStore.assertTrustedKeys([{ keyId: "0123456789abcdef", publicKey: "YQ==" }]),
  );
  equal("short public key name", shortKey?.name, "LegalKeyError");
}

section("empty trusted key list");

{
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new Error("schedule must not fetch");
  };
  const stopped = remote.startRemoteTermsSchedule({ keys: [], fetchImpl });
  stopped();
  stopped();
  const omitted = remote.startRemoteTermsSchedule({ fetchImpl });
  omitted();
  equal("empty key list does not fetch", calls, 0);
  const armed = remote.startRemoteTermsSchedule({ keys: [pair.entry], fetchImpl });
  armed();
  equal("stop before the first delay does not fetch", calls, 0);
}

section("fetch rules");

{
  clearCache();
  const httpCalls = [];
  const http = await refresh(
    async (url, init) => {
      httpCalls.push({ url, init });
      return jsonResponse(goodEnvelope);
    },
    { url: "http://levix.leviro.net/api/legal/v1/release", keys: [pair.entry] },
  );
  ok(
    "http url is refused before any request",
    httpCalls.length === 0 &&
      http.result?.updated === false &&
      http.result?.error === "url must use https",
    http.result?.error,
  );

  const queryCalls = [];
  const query = await refresh(
    async (url) => {
      queryCalls.push(url);
      return jsonResponse(goodEnvelope);
    },
    { url: "https://levix.leviro.net/api/legal/v1/release?x=1", keys: [pair.entry] },
  );
  ok(
    "query string is refused before any request",
    queryCalls.length === 0 && query.result?.error === "url must not contain a query string",
    query.result?.error,
  );

  for (const status of [301, 302]) {
    clearCache();
    const redirected = await refresh(async () => jsonResponse("go", status), {
      keys: [pair.entry],
    });
    ok(
      `${status} is refused`,
      redirected.result?.updated === false &&
        redirected.result?.error === "redirect refused" &&
        !existsSync(cacheFile),
      redirected.result?.error,
    );
  }

  for (const status of [404, 500]) {
    clearCache();
    const failed = await refresh(async () => jsonResponse("no", status), { keys: [pair.entry] });
    ok(
      `${status} is refused`,
      failed.result?.updated === false &&
        failed.result?.error === `status ${status}` &&
        !existsSync(cacheFile),
      failed.result?.error,
    );
  }

  clearCache();
  const typed = await refresh(async () => jsonResponse(goodEnvelope, 200, "text/plain"), {
    keys: [pair.entry],
  });
  ok(
    "wrong content-type is refused",
    typed.result?.error === "content-type refused" && !existsSync(cacheFile),
    typed.result?.error,
  );

  clearCache();
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(remote.MAX_BODY_BYTES + 1));
    },
    cancel() {
      cancelled = true;
    },
  });
  const capped = await refresh(
    async () =>
      new Response(stream, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    { keys: [pair.entry] },
  );
  ok(
    "body over 393216 bytes is aborted",
    cancelled && capped.result?.error === "response exceeds 393216 bytes" && !existsSync(cacheFile),
    capped.result?.error,
  );

  clearCache();
  const timed = await refresh(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        const onAbort = () => reject(init.signal.reason || new Error("aborted"));
        if (init.signal.aborted) onAbort();
        else init.signal.addEventListener("abort", onAbort, { once: true });
      }),
    { keys: [pair.entry] },
  );
  ok(
    "timeout is refused",
    !timed.error &&
      timed.result?.updated === false &&
      timed.result?.error === "timeout" &&
      !existsSync(cacheFile),
    timed.error?.message || timed.result?.error,
  );

  clearCache();
  const network = await refresh(() => {
    throw new Error("socket hang up");
  }, { keys: [pair.entry] });
  ok(
    "network error is refused",
    !network.error && network.result?.updated === false && !existsSync(cacheFile),
    network.error?.message || network.result?.error,
  );
}

section("cache");

{
  installKeys([pair.entry]);
  clearCache();
  const sameText = documentsFor(bundledVersion, (docs) => {
    docs.en.terms.sections[0].paragraphs[0] = "Same version, different sentence.";
  });
  const sameEnvelope = release.signRelease(release.buildRelease(sameText), pair.privateKey);
  const same = await refresh(async () => jsonResponse(sameEnvelope));
  ok(
    "equal remote is ignored",
    same.result?.updated === false && same.result?.error === null,
    same.result?.error,
  );
  ok("equal remote leaves no cache", !existsSync(cacheFile));
  equal("equal remote keeps the bundled release", terms.currentRelease().source, "bundled");

  clearCache();
  const olderEnvelope = release.signRelease(
    release.buildRelease(documentsFor(olderVersion)),
    pair.privateKey,
  );
  const older = await refresh(async () => jsonResponse(olderEnvelope));
  ok("older remote is ignored", older.result?.updated === false && older.result?.error === null);
  ok("older remote leaves no cache", !existsSync(cacheFile));

  let seen = null;
  const updated = await refresh(async (url, init) => {
    seen = { url, init };
    return jsonResponse(goodEnvelope);
  });
  ok(
    "newer release is cached",
    updated.result?.updated === true && updated.result?.version === newerVersion,
  );
  const names = readdirSync(join(dataDir, "legal"));
  equal("cache directory has one file", names.length, 1);
  equal("cache file name", names[0], "remote-release.json");
  const current = terms.currentRelease();
  equal("currentRelease uses the newer remote release", current.source, "remote");
  equal("currentRelease version", current.version, newerVersion);
  equal("documentFor source is remote", terms.documentFor("en").source, "remote");
  equal(
    "documentFor hash is the remote hash",
    terms.documentFor("en").sha256,
    document.documentHash(current.documents.en.document),
  );
  const headers = seen?.init?.headers || {};
  const headerNames = Object.keys(headers).map((name) => name.toLowerCase());
  equal("request method is GET", seen?.init?.method, "GET");
  equal("request redirect is manual", seen?.init?.redirect, "manual");
  equal("request has only the accept header", headerNames.length, 1);
  equal("request accept header", headers.accept, "application/json");
  ok("request has no cookie header", !headerNames.includes("cookie"));
  ok("request has no query string", seen?.url && new URL(seen.url).search === "");
  ok("request has no body", seen?.init?.body == null);
  equal("default url is the release endpoint", seen?.url, remote.RELEASE_URL);

  const kept = readFileSync(cacheFile);
  const downgrade = await refresh(async () => jsonResponse(olderEnvelope));
  ok("older remote does not downgrade", downgrade.result?.updated === false);
  ok("older remote does not replace the cache", readFileSync(cacheFile).equals(kept));
  equal("currentRelease stays on the newer release", terms.currentRelease().version, newerVersion);

  installKeys([other.entry]);
  equal("untrusted cache key is ignored", terms.currentRelease().source, "bundled");
  ok("untrusted cache stays on disk", existsSync(cacheFile));
  installKeys([pair.entry]);
  equal("restoring the key trusts the cache again", terms.currentRelease().source, "remote");

  const edited = JSON.parse(readFileSync(cacheFile, "utf8"));
  const bytes = Buffer.from(edited.payload, "base64");
  bytes[0] ^= 0x01;
  edited.payload = bytes.toString("base64");
  writeFileSync(cacheFile, JSON.stringify(edited));
  terms.invalidate();
  equal("edited cache is ignored", terms.currentRelease().source, "bundled");
  ok("edited cache stays on disk", existsSync(cacheFile));
}

section("consent follows the current release");

{
  clearCache();
  installKeys([pair.entry]);
  consent.revokeAcceptance();
  const bundledDoc = terms.documentFor("en");
  equal("before the cache the source is bundled", bundledDoc.source, "bundled");
  consent.recordAcceptance({
    version: bundledDoc.version,
    sha256: bundledDoc.sha256,
    locale: "en",
    via: "provision",
  });
  equal("bundled acceptance is ok", consent.consentStatus().ok, true);

  const again = release.signRelease(goodRelease, pair.privateKey);
  await refresh(async () => jsonResponse(again));
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = () => {
    fetches += 1;
    return Promise.reject(new Error("consent must not fetch"));
  };
  try {
    const changed = consent.consentStatus();
    equal("newer remote makes the acceptance terms_changed", changed.reason, "terms_changed");
    const remoteDoc = terms.documentFor("en");
    const recorded = consent.recordAcceptance({
      version: remoteDoc.version,
      sha256: remoteDoc.sha256,
      locale: "en",
      via: "provision",
    });
    equal("accepting the remote hash is ok", consent.consentStatus().ok, true);
    equal("consentStatus and recordAcceptance do not fetch", fetches, 0);
    equal(
      "acceptance record keys",
      Object.keys(recorded).sort().join(","),
      "acceptedAt,appVersion,locale,schema,sha256,termsVersion,via",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

section("offline fallback");

{
  clearCache();
  installKeys([pair.entry]);
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = () => {
    fetches += 1;
    return Promise.reject(new Error("offline"));
  };
  try {
    const failed = await refresh(async () => {
      throw new Error("offline");
    });
    ok("failed fetch does not throw", !failed.error, failed.error?.message);
    ok("failed fetch does not update", failed.result?.updated === false);
    equal("bundled release stays current", terms.currentRelease().source, "bundled");
    const doc = terms.documentFor("en");
    consent.recordAcceptance({
      version: doc.version,
      sha256: doc.sha256,
      locale: "en",
      via: "provision",
    });
    const status = consent.consentStatus();
    ok("bundled release stays acceptable", status.ok === true, status.reason);
    equal("offline consent path does not fetch", fetches, 0);
    ok(
      "acceptance row is still local",
      store.getBotSetting(consent.KEY, null)?.sha256 === doc.sha256,
    );
  } finally {
    globalThis.fetch = originalFetch;
    installKeys(shippedKeys);
  }
}

section("legal-release.mjs");

{
  const script = join(ROOT, "scripts", "legal-release.mjs");
  const runScript = (args) => {
    const env = { ...process.env, HOME: home };
    delete env.GIT_DIR;
    delete env.GIT_WORK_TREE;
    return spawnSync(process.execPath, [script, ...args], { cwd: ROOT, env, encoding: "utf8" });
  };
  const printed = (text) => ({
    keyId: /^keyId: ([0-9a-f]{16})$/m.exec(text)?.[1],
    publicKey: /^publicKey: ([A-Za-z0-9+/]+=*)$/m.exec(text)?.[1],
  });

  const relative = runScript(["keygen", "--out", "src/legal/owner-key.pem"]);
  ok("keygen refuses a path inside the repository", relative.status !== 0);
  ok("keygen writes nothing inside the repository", !existsSync(insideKey));

  const existing = join(outside, "existing.pem");
  writeFileSync(existing, "keep-me\n");
  const overwrite = runScript(["keygen", "--out", existing]);
  ok("keygen refuses an existing file", overwrite.status !== 0);
  equal("keygen leaves the existing file untouched", readFileSync(existing, "utf8"), "keep-me\n");

  const keyPath = join(outside, "release.pem");
  const created = runScript(["keygen", "--out", keyPath]);
  equal("keygen exit", created.status, 0);
  equal("keygen mode is 0600", statSync(keyPath).mode & 0o777, 0o600);
  const pub = printed(created.stdout);
  ok("keygen prints a keyId", Boolean(pub.keyId));
  ok("keygen prints a public key", Boolean(pub.publicKey));
  const pem = readFileSync(keyPath, "utf8");
  const pemBody = pem.split("\n").find((line) => line && !line.startsWith("-----"));
  const dumped = `${created.stdout}\n${created.stderr}`;
  ok(
    "keygen output has no private key",
    Boolean(pemBody) && !dumped.includes("PRIVATE") && !dumped.includes(pemBody),
  );

  const shown = runScript(["public-key", "--key", keyPath]);
  equal("public-key exit", shown.status, 0);
  const shownPub = printed(shown.stdout);
  equal("public-key keyId", shownPub.keyId, pub.keyId);
  equal("public-key publicKey", shownPub.publicKey, pub.publicKey);

  const out = join(outside, "envelope.json");
  const signedRun = runScript(["sign", "--key", keyPath, "--out", out]);
  equal("sign exit", signedRun.status, 0);
  const signedDump = `${signedRun.stdout}\n${signedRun.stderr}`;
  ok(
    "sign output has no private key",
    !signedDump.includes("PRIVATE") && !signedDump.includes(pemBody),
  );
  const envelope = JSON.parse(readFileSync(out, "utf8"));
  const verified = release.verifyEnvelope(envelope, [
    { keyId: pub.keyId, publicKey: pub.publicKey },
  ]);
  equal("sign output verifies with the printed public key", verified.source, "remote");
  equal("sign output version is the bundled version", verified.version, bundledVersion);
}

finish();

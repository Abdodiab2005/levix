// Terms document, hash, acceptance record, and the local-only rule (Phase 04a).

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync,
  writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

const dataDir = useTempDataDir("levix-legal-consent");

const document = require("./src/legal/document.cjs");
const terms = require("./src/legal/terms.cjs");
const consent = require("./src/legal/consent.cjs");
const store = require("./src/db/store.cjs");
const { checkpoint, db } = require("./src/db/db.cjs");
const transfer = require("./src/services/settingsTransfer.cjs");
const { RESTORABLE_BOT_KEYS } = require("./src/backup/content.cjs");
const { restorableRows, currentDigests } = require("./src/backup/plan.cjs");

const bundled = require("./src/legal/bundled/en.json");

// Computed from canonicalJson + sha256 of src/legal/bundled/en.json (same
// algorithm as documentHash). A mismatch means the text changed.
const PINNED_BUNDLED_EN_SHA256 =
  "2ff5fb5a5a4d361f22a4c2a169aba1b1fd972e18835cbf1a703e3d2292db17d7";

function cloneDoc() {
  return JSON.parse(JSON.stringify(bundled));
}

function filesUnder(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out;
}

function validRecord(overrides = {}) {
  const current = terms.documentFor("en");
  return {
    schema: 1,
    appVersion: consent.appVersion(),
    termsVersion: current.version,
    sha256: current.sha256,
    locale: "en",
    acceptedAt: "2026-11-02T12:00:00.000Z",
    via: "provision",
    ...overrides,
  };
}

// --- a. bundled document and pinned hash ---------------------------------

section("bundled English document");

{
  const doc = document.validateDocument(cloneDoc());
  ok("the bundled English document validates", doc.locale === "en" && doc.schema === 1);
  const actual = document.documentHash(doc);
  ok(
    "its hash is pinned",
    actual === PINNED_BUNDLED_EN_SHA256,
    actual === PINNED_BUNDLED_EN_SHA256
      ? undefined
      : `${actual}; a text change needs a new version and a LEGAL_COPY_REVIEW.md entry`,
  );
  equal("documentFor uses the same hash", terms.documentFor("en").sha256, PINNED_BUNDLED_EN_SHA256);
  equal("documentFor constructor is null", terms.documentFor("constructor"), null);
  equal("resolveLocale __proto__ is en", terms.resolveLocale("__proto__"), "en");
}

// --- b. validateDocument refusals ----------------------------------------

section("validateDocument refusals");

{
  throws("an unknown key", () => {
    const doc = cloneDoc();
    doc.extra = "no";
    document.validateDocument(doc);
  });

  throws("a missing key", () => {
    const doc = cloneDoc();
    delete doc.effective;
    document.validateDocument(doc);
  });

  throws("schema 2", () => {
    const doc = cloneDoc();
    doc.schema = 2;
    document.validateDocument(doc);
  });

  throws("version 2026-13-01", () => {
    const doc = cloneDoc();
    doc.version = "2026-13-01";
    document.validateDocument(doc);
  });

  throws("version 2026-11-02.0", () => {
    const doc = cloneDoc();
    doc.version = "2026-11-02.0";
    document.validateDocument(doc);
  });

  throws("version 2026-11-02.1000", () => {
    const doc = cloneDoc();
    doc.version = "2026-11-02.1000";
    document.validateDocument(doc);
  });

  throws("an unknown locale", () => {
    const doc = cloneDoc();
    doc.locale = "xx";
    document.validateDocument(doc);
  });

  throws("a bad effective date", () => {
    const doc = cloneDoc();
    doc.effective = "2026-11-31";
    document.validateDocument(doc);
  });

  throws("a control character", () => {
    const doc = cloneDoc();
    doc.terms.sections[0].paragraphs[0] = `Has a control\ncharacter`;
    document.validateDocument(doc);
  });

  throws("a bidi override U+202E", () => {
    const doc = cloneDoc();
    doc.terms.sections[0].heading = `Heading\u202E`;
    document.validateDocument(doc);
  });

  throws("a bidi isolate U+2066", () => {
    const doc = cloneDoc();
    doc.terms.sections[0].heading = `Heading\u2066`;
    document.validateDocument(doc);
  });

  throws("https://", () => {
    const doc = cloneDoc();
    doc.privacy.sections[0].paragraphs[0] = "See https://example.com";
    document.validateDocument(doc);
  });

  throws("www.", () => {
    const doc = cloneDoc();
    doc.privacy.sections[0].paragraphs[0] = "See www.example.com";
    document.validateDocument(doc);
  });

  throws("a non-NFC string", () => {
    const doc = cloneDoc();
    doc.terms.title = "Cafe\u0301";
    document.validateDocument(doc);
  });

  throws("leading space", () => {
    const doc = cloneDoc();
    doc.terms.title = " Levix Terms of Use";
    document.validateDocument(doc);
  });

  throws("trailing space", () => {
    const doc = cloneDoc();
    doc.terms.title = "Levix Terms of Use ";
    document.validateDocument(doc);
  });

  throws("an empty paragraph list", () => {
    const doc = cloneDoc();
    doc.terms.sections[0].paragraphs = [];
    document.validateDocument(doc);
  });

  throws("31 sections", () => {
    const doc = cloneDoc();
    doc.terms.sections = Array.from({ length: 31 }, (_, i) => ({
      heading: `Section ${i + 1}`,
      paragraphs: ["A paragraph."],
    }));
    document.validateDocument(doc);
  });

  throws("21 paragraphs", () => {
    const doc = cloneDoc();
    doc.terms.sections[0].paragraphs = Array.from({ length: 21 }, () => "A paragraph.");
    document.validateDocument(doc);
  });

  throws("a 2001-character paragraph", () => {
    const doc = cloneDoc();
    doc.terms.sections[0].paragraphs[0] = "a".repeat(2001);
    document.validateDocument(doc);
  });

  throws("a document over 65536 canonical bytes", () => {
    const doc = cloneDoc();
    const para = "a".repeat(2000);
    doc.terms.sections = [
      { heading: "A", paragraphs: Array.from({ length: 20 }, () => para) },
      { heading: "B", paragraphs: Array.from({ length: 20 }, () => para) },
    ];
    document.validateDocument(doc);
  });
}

// --- c. canonical bytes, hash, versions ----------------------------------

section("canonicalJson, documentHash, compareVersions");

{
  equal(
    "canonicalJson sorts keys at every depth and keeps array order",
    document.canonicalJson({ b: 1, a: [{ z: 1, y: 2 }, { m: 3, k: 4 }] }),
    '{"a":[{"y":2,"z":1},{"k":4,"m":3}],"b":1}',
  );

  const original = document.validateDocument(cloneDoc());
  const first = document.documentHash(original);
  const changed = cloneDoc();
  changed.terms.sections[0].heading = "1. What Levix is not";
  const second = document.documentHash(document.validateDocument(changed));
  ok("changing one heading changes documentHash", first !== second);

  ok(
    "2026-11-02 < 2026-11-02.1",
    document.compareVersions("2026-11-02", "2026-11-02.1") < 0,
  );
  ok(
    "2026-11-02.1 < 2026-11-02.10",
    document.compareVersions("2026-11-02.1", "2026-11-02.10") < 0,
  );
  ok(
    "2026-11-02.10 < 2026-11-03",
    document.compareVersions("2026-11-02.10", "2026-11-03") < 0,
  );
}

// --- d. consentStatus and recordAcceptance -------------------------------

section("consentStatus and recordAcceptance");

{
  consent.revokeAcceptance();
  const none = consent.consentStatus();
  equal("no record is not accepted", none.ok, false);
  equal("no record reason", none.reason, "terms_not_accepted");

  const current = terms.documentFor("en");
  const mismatchVersion = throws("wrong version throws TERMS_MISMATCH", () =>
    consent.recordAcceptance({
      version: "2020-01-01",
      sha256: current.sha256,
      locale: "en",
      via: "provision",
    }),
  );
  equal("wrong version code", mismatchVersion?.code, "TERMS_MISMATCH");
  equal("wrong version wrote nothing", store.getBotSetting(consent.KEY, null), null);

  const mismatchHash = throws("wrong hash throws TERMS_MISMATCH", () =>
    consent.recordAcceptance({
      version: current.version,
      sha256: "a".repeat(64),
      locale: "en",
      via: "provision",
    }),
  );
  equal("wrong hash code", mismatchHash?.code, "TERMS_MISMATCH");
  equal("wrong hash wrote nothing", store.getBotSetting(consent.KEY, null), null);

  const recorded = consent.recordAcceptance({
    version: current.version,
    sha256: current.sha256,
    locale: "en",
    via: "provision",
  });
  const okStatus = consent.consentStatus();
  equal("valid acceptance is ok", okStatus.ok, true);
  equal("valid acceptance reason", okStatus.reason, null);
  equal("recorded via", recorded.via, "provision");

  store.saveBotSetting(consent.KEY, validRecord({ sha256: "b".repeat(64) }));
  equal("changed sha256", consent.consentStatus().reason, "terms_changed");

  store.saveBotSetting(consent.KEY, validRecord({ termsVersion: "2020-01-01" }));
  equal("changed termsVersion", consent.consentStatus().reason, "terms_changed");

  store.saveBotSetting(consent.KEY, validRecord({ locale: "en" }));
  const originalDocumentFor = terms.documentFor;
  try {
    terms.documentFor = (locale) => (locale === "en" ? null : originalDocumentFor(locale));
    equal("locale the release lacks", consent.consentStatus().reason, "terms_changed");
  } finally {
    terms.documentFor = originalDocumentFor;
  }

  store.saveBotSetting(consent.KEY, validRecord({ appVersion: "0.0.1" }));
  equal("another appVersion", consent.consentStatus().reason, "app_updated");

  store.saveBotSetting(consent.KEY, validRecord({ schema: 2 }));
  equal("wrong schema", consent.consentStatus().reason, "terms_not_accepted");

  store.saveBotSetting(consent.KEY, validRecord({ via: "hack" }));
  equal("bad via in the record", consent.consentStatus().reason, "terms_not_accepted");

  store.saveBotSetting(consent.KEY, validRecord({ extra: "x" }));
  equal("extra key in the record", consent.consentStatus().reason, "terms_not_accepted");

  store.saveBotSetting(consent.KEY, validRecord({ acceptedAt: "2026-11-02" }));
  equal("date-only acceptedAt", consent.consentStatus().reason, "terms_not_accepted");

  store.saveBotSetting(consent.KEY, validRecord({ acceptedAt: "not-a-date" }));
  equal("bad date in the record", consent.consentStatus().reason, "terms_not_accepted");

  const originalGet = store.getBotSetting;
  store.getBotSetting = () => {
    throw new Error("store down");
  };
  try {
    const unread = consent.consentStatus();
    equal("store throw ok", unread.ok, false);
    equal("store throw reason", unread.reason, "consent_unreadable");
  } finally {
    store.getBotSetting = originalGet;
  }

  const badVia = throws("unknown via is refused", () =>
    consent.recordAcceptance({
      version: current.version,
      sha256: current.sha256,
      locale: "en",
      via: "tty",
    }),
  );
  equal("unknown via code", badVia?.code, "CONSENT_BAD_REQUEST");

  const badLocale = throws("unknown locale is refused", () =>
    consent.recordAcceptance({
      version: current.version,
      sha256: current.sha256,
      locale: "xx",
      via: "provision",
    }),
  );
  equal("unknown locale code", badLocale?.code, "CONSENT_BAD_LOCALE");

  const inheritedLocale = throws("locale toString is refused", () =>
    consent.recordAcceptance({
      version: current.version,
      sha256: current.sha256,
      locale: "toString",
      via: "provision",
    }),
  );
  equal("locale toString code", inheritedLocale?.code, "CONSENT_BAD_LOCALE");
}

// --- e. Q-17 lifecycle ---------------------------------------------------

section("Q-17 lifecycle");

{
  const current = terms.documentFor("en");
  consent.recordAcceptance({
    version: current.version,
    sha256: current.sha256,
    locale: "en",
    via: "cli",
  });
  const before = JSON.stringify(store.getBotSetting(consent.KEY));
  store.saveBotSetting("auth:password", "not-a-real-hash");
  store.deleteBotSetting("auth:password");
  equal(
    "the record survives deleting auth:password",
    JSON.stringify(store.getBotSetting(consent.KEY)),
    before,
  );
  equal("password reset keeps a valid acceptance", consent.consentStatus().ok, true);

  const { WhatsAppSession } = await import("../src/core/session.js");
  const silent = {
    info() {},
    warn() {},
    error() {},
    debug() {},
    trace() {},
  };
  const session = new WhatsAppSession({
    checkConsent: () => ({ ok: true }),
    log: silent,
    debugLog: silent,
    createSocket: async () => {
      throw new Error("logout must not create a socket");
    },
  });
  await session.logout();
  equal(
    "the record survives the real unlink cleanup",
    JSON.stringify(store.getBotSetting(consent.KEY)),
    before,
  );
  equal("unlink keeps a valid acceptance", consent.consentStatus().ok, true);
}

// --- f. the record never leaves the device -------------------------------

section("the record never leaves the device");

{
  const current = terms.documentFor("en");
  consent.recordAcceptance({
    version: current.version,
    sha256: current.sha256,
    locale: "en",
    via: "provision",
  });
  checkpoint();

  const exported = transfer.exportSettings();
  const exportedJson = JSON.stringify(exported);
  ok("settings export has no legal: key", !exportedJson.includes("legal:"));
  ok("settings export has no terms hash", !exportedJson.includes(current.sha256));

  ok(
    "RESTORABLE_BOT_KEYS excludes legal:acceptance",
    !RESTORABLE_BOT_KEYS.includes("legal:acceptance"),
  );
  ok(
    "restorable rows omit legal:acceptance",
    restorableRows(db).every((row) => row.key !== "legal:acceptance"),
  );
  ok(
    "restore planner digests omit legal:acceptance",
    !Object.hasOwn(currentDigests().settings, "legal:acceptance"),
  );

  const { createBackup } = require("./src/backup/create.cjs");
  const { openBackup } = require("./src/backup/format.cjs");
  const password = "backup-create-password-123";
  const kdf = { N: 32768, r: 8, p: 1 };
  const file = await createBackup({ password, kdf });
  const opened = await openBackup({ path: file.path, password });
  const dest = mkdtempSync(join(dataDir, "extract-"));
  chmodSync(dest, 0o700);
  await opened.extract({ dest });

  const hashUtf8 = Buffer.from(current.sha256, "utf8");
  const leaked = [];
  for (const path of filesUnder(dest)) {
    const bytes = readFileSync(path);
    if (bytes.includes(hashUtf8) || bytes.includes(Buffer.from("legal:"))) leaked.push(path);
  }
  ok(
    "decrypted backup content has neither the hash nor legal:",
    leaked.length === 0,
    leaked.join(", "),
  );

  const copy = new DatabaseSync(join(dest, "db", "levix.db"), { readOnly: true });
  equal(
    "backup db has no legal:acceptance row",
    copy.prepare("SELECT count(*) AS n FROM bot_settings WHERE key = 'legal:acceptance'").get().n,
    0,
  );
  copy.close();

  ok(
    "manifest digests omit legal:acceptance",
    !Object.hasOwn(opened.manifest.digests.settings, "legal:acceptance"),
  );
}

// --- g. no network -------------------------------------------------------

section("no network");

{
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (...args) => {
    calls.push(args);
    return Promise.reject(new Error("network forbidden in legal tests"));
  };
  try {
    consent.revokeAcceptance();
    consent.consentStatus();
    const current = terms.documentFor("en");
    consent.recordAcceptance({
      version: current.version,
      sha256: current.sha256,
      locale: "en",
      via: "provision",
    });
    consent.revokeAcceptance();
    equal("consentStatus/record/revoke make zero fetch calls", calls.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const legalRoot = join(ROOT, "src", "legal");
  for (const file of filesUnder(legalRoot)) {
    if (!statSync(file).isFile()) continue;
    const text = readFileSync(file, "utf8");
    const rel = file.slice(ROOT.length).replace(/^\//, "");
    ok(`${rel} has no fetch(`, !text.includes("fetch("));
    ok(`${rel} has no node:http`, !text.includes('require("node:http'));
    ok(`${rel} has no node:https`, !text.includes('require("node:https'));
    ok(`${rel} has no node:net`, !text.includes('require("node:net'));
  }
}

// --- h. release identity ---------------------------------------------------

section("release identity");

function runConsentProbe(assetDir, mode) {
  const data = mkdtempSync(join(tmpdir(), "levix-consent-identity-"));
  const probeDir = mkdtempSync(join(tmpdir(), "levix-consent-probe-"));
  const file = join(probeDir, "probe.cjs");
  const paths = JSON.stringify(join(ROOT, "src/config/paths.cjs"));
  const consentPath = JSON.stringify(join(ROOT, "src/legal/consent.cjs"));
  const termsPath = JSON.stringify(join(ROOT, "src/legal/terms.cjs"));
  const storePath = JSON.stringify(join(ROOT, "src/db/store.cjs"));
  writeFileSync(
    file,
    `process.env.LEVIX_DATA_DIR = process.argv[2];
const { setAssetRoot } = require(${paths});
setAssetRoot(process.argv[3]);
const consent = require(${consentPath});
const terms = require(${termsPath});
const store = require(${storePath});
function stored() {
  return store.getBotSetting(consent.KEY, null);
}
function emit(payload) {
  process.stdout.write("\\nLEVIX_PROBE " + JSON.stringify(payload) + "\\n");
}
if (process.argv[4] === "status") {
  const status = consent.consentStatus();
  emit({ ok: status.ok, reason: status.reason, stored: stored() });
  process.exit(0);
}
const current = terms.documentFor("en");
try {
  consent.recordAcceptance({
    version: current.version,
    sha256: current.sha256,
    locale: "en",
    via: "provision",
  });
  emit({ threw: false, stored: stored() });
} catch (error) {
  emit({ threw: true, code: error.code || null, stored: stored() });
}
process.exit(0);
`,
  );
  const run = spawnSync(process.execPath, [file, data, assetDir, mode], { encoding: "utf8" });
  rmSync(data, { recursive: true, force: true });
  rmSync(probeDir, { recursive: true, force: true });
  return run;
}

function probeBody(assetDir, mode) {
  const run = runConsentProbe(assetDir, mode);
  const marker = "LEVIX_PROBE ";
  const line = String(run.stdout ?? "")
    .split("\n")
    .find((entry) => entry.startsWith(marker));
  let body = null;
  if (line) {
    try {
      body = JSON.parse(line.slice(marker.length));
    } catch {
      body = null;
    }
  }
  return { run, body };
}

function childDetail(run) {
  return `status=${run.status} stdout=${JSON.stringify(run.stdout)} stderr=${JSON.stringify(run.stderr)}`;
}

{
  const current = terms.documentFor("en");
  const invalidRoot = mkdtempSync(join(tmpdir(), "levix-build-invalid-"));
  const unreadRoot = mkdtempSync(join(tmpdir(), "levix-build-unread-"));
  try {
    function acceptAs(identity) {
      consent._setAppVersionForTests(identity);
      const record = consent.recordAcceptance({
        version: current.version,
        sha256: current.sha256,
        locale: "en",
        via: "provision",
      });
      equal(`recorded ${identity}`, record.appVersion, identity);
      return record;
    }

    acceptAs("4.9.2");
    equal("npm restart keeps a matching identity", consent.consentStatus().reason, null);
    equal("npm restart is ok", consent.consentStatus().ok, true);
    equal("ordinary restart keeps acceptance", consent.consentStatus().ok, true);

    consent._setAppVersionForTests("5.0.0");
    equal("desktop package update is app_updated", consent.consentStatus().reason, "app_updated");

    acceptAs("4.9.2");
    consent._setAppVersionForTests("4.9.2+android.69");
    equal(
      "plain record read by an android build is app_updated",
      consent.consentStatus().reason,
      "app_updated",
    );

    acceptAs("4.9.2+android.69");
    equal("android restart keeps the same versionCode", consent.consentStatus().reason, null);
    consent._setAppVersionForTests("4.9.2+android.70");
    equal("android versionCode bump is app_updated", consent.consentStatus().reason, "app_updated");
    equal(
      "a versionCode bump does not rewrite the record",
      store.getBotSetting(consent.KEY).appVersion,
      "4.9.2+android.69",
    );

    acceptAs("4.9.2+android.70");
    consent._setAppVersionForTests("4.9.2+android.69");
    equal("android versionCode downgrade is app_updated", consent.consentStatus().reason, "app_updated");

    writeFileSync(join(invalidRoot, "levix-build.json"), "{");
    const invalidStatus = probeBody(invalidRoot, "status");
    ok(
      "invalid build file is consent_unreadable",
      invalidStatus.run.status === 0 &&
        invalidStatus.body?.ok === false &&
        invalidStatus.body?.reason === "consent_unreadable" &&
        invalidStatus.body?.stored === null,
      childDetail(invalidStatus.run),
    );
    const invalidRecord = probeBody(invalidRoot, "record");
    ok(
      "invalid build file records nothing",
      invalidRecord.run.status === 0 &&
        invalidRecord.body?.threw === true &&
        invalidRecord.body?.code === "BUILD_INFO_INVALID" &&
        invalidRecord.body?.stored === null,
      childDetail(invalidRecord.run),
    );

    mkdirSync(join(unreadRoot, "levix-build.json"));
    const unreadStatus = probeBody(unreadRoot, "status");
    ok(
      "unreadable build file is consent_unreadable",
      unreadStatus.run.status === 0 &&
        unreadStatus.body?.ok === false &&
        unreadStatus.body?.reason === "consent_unreadable" &&
        unreadStatus.body?.stored === null,
      childDetail(unreadStatus.run),
    );
    const unreadRecord = probeBody(unreadRoot, "record");
    ok(
      "unreadable build file records nothing",
      unreadRecord.run.status === 0 &&
        unreadRecord.body?.threw === true &&
        unreadRecord.body?.stored === null,
      childDetail(unreadRecord.run),
    );
  } finally {
    consent._setAppVersionForTests(undefined);
    rmSync(invalidRoot, { recursive: true, force: true });
    rmSync(unreadRoot, { recursive: true, force: true });
  }
}

finish();

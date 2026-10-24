// Local crash reports (contract sections 4 and 5).
//
// A report is one JSON file in `<data>/crash-reports/`. It is written and read
// only on this device; it leaves only when the operator presses Send on one
// report, and then only as the sanitized upload object below. Nothing here
// contacts the network by itself and nothing is ever retried automatically.
//
// The store is bounded three ways: at most 20 pending files, files older than
// 7 days are swept, and a send record keeps the last 20 ids. Every write is
// atomic — a `.tmp` file, then a rename — so a crash mid-write cannot leave a
// half-written report for the list to trip over.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { dataPath } = require("../config/paths.cjs");
const { sanitizeText } = require("./sanitize.cjs");
const { sanitizeClientFields } = require("./device.cjs");
const { readDebugTail, readDebugSnapshot, storeDebugSnapshot } = require("./debugLog.cjs");

const CRASH_DIR = dataPath("crash-reports");
const SENT_FILE = path.join(CRASH_DIR, "sent.json");

const MAX_FILES = 20;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SENT_MAX = 20;

const CATEGORIES = Object.freeze([
  "android-crash",
  "android-anr",
  "android-native",
  "web-error",
  "web-rejection",
  "react-render",
  "node-uncaught",
  "node-rejection",
]);
const CRUMB_KINDS = Object.freeze(["nav", "lifecycle", "action"]);

const TYPE_MAX = 120;
const MESSAGE_MAX = 300;
const FRAME_MAX = 200;
const FRAMES_MAX = 20;
const NAME_MAX = 60;
const SCREEN_MAX = 40;
const APP_CAPS = Object.freeze({ levix: 32, nativeApp: 40, node: 32, platform: 32 });

const ID_PATTERN = /^[0-9a-f]{16}$/;
const FILE_PATTERN = /^([0-9a-f]{16})\.json$/;

const DEFAULT_ENDPOINT = "https://levix.leviro.net/api/crash-reports";
const SEND_TIMEOUT_MS = 30000;

// POST /crash-reports: 10 per 10 minutes per process. The panel's own error
// hooks are the only caller; the limit is so a render loop cannot fill the disk.
const POST_MAX = 10;
const POST_WINDOW_MS = 10 * 60 * 1000;
let postAttempts = [];

function crashReportRetryAfter() {
  const now = Date.now();
  postAttempts = postAttempts.filter((at) => now - at < POST_WINDOW_MS);
  if (postAttempts.length < POST_MAX) return 0;
  return Math.max(1, Math.ceil((postAttempts[0] + POST_WINDOW_MS - now) / 1000));
}

function recordCrashReportAttempt() {
  postAttempts.push(Date.now());
}

/** Test hook only: forget the in-memory POST window. */
function resetCrashReportThrottle() {
  postAttempts = [];
}

// --- files ----------------------------------------------------------------

function ensureDir() {
  fs.mkdirSync(CRASH_DIR, { recursive: true });
}

function reportFile(id) {
  return path.join(CRASH_DIR, `${id}.json`);
}

function newId() {
  return crypto.randomBytes(8).toString("hex");
}

/** 16 hex from category + type + the first three frames. Grouping only. */
function fingerprintOf(category, type, stack) {
  const frames = Array.isArray(stack) ? stack.slice(0, 3).join("\n") : "";
  return crypto
    .createHash("sha256")
    .update(`${category}|${type}|${frames}`)
    .digest("hex")
    .slice(0, 16);
}

function clip(value, max) {
  return sanitizeText(value, max);
}

function normalizeStack(stack) {
  let frames = [];
  if (Array.isArray(stack)) frames = stack;
  else if (typeof stack === "string") frames = stack.split(/\r?\n/);
  return frames
    .filter((frame) => typeof frame === "string" && frame.trim() !== "")
    .slice(0, FRAMES_MAX)
    .map((frame) => sanitizeText(frame, FRAME_MAX));
}

function normalizeBreadcrumbs(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list.slice(-20)) {
    if (!item || typeof item !== "object") continue;
    const name = sanitizeText(item.name, NAME_MAX);
    if (!name) continue;
    const kind = CRUMB_KINDS.includes(item.kind) ? item.kind : "action";
    const at =
      typeof item.at === "string" && item.at ? item.at.slice(0, 40) : new Date().toISOString();
    out.push({ at, kind, name });
  }
  return out;
}

/** A route id only: no URL, no scheme, no query, no hash. */
function normalizeScreen(value) {
  if (typeof value !== "string") return null;
  let text = value.trim().split("?")[0].split("#")[0];
  if (text.includes("://")) {
    const parts = text.split("/");
    text = parts[parts.length - 1] || "";
  }
  text = text.replace(/^[#/]+/, "");
  text = sanitizeText(text, SCREEN_MAX);
  return text || null;
}

function runtimeFacts() {
  try {
    const { describeRuntime } = require("../panel/feedback.cjs");
    const runtime = describeRuntime();
    return { version: runtime?.version || "unknown", platform: runtime?.platform || "unknown" };
  } catch {
    return { version: "unknown", platform: "unknown" };
  }
}

/** The server's own facts, plus nativeApp only when a native capture knew it. */
function buildApp(extra) {
  const runtime = runtimeFacts();
  const app = {
    levix: clip(runtime.version, APP_CAPS.levix) || "unknown",
    node: clip(process.version, APP_CAPS.node) || "unknown",
    platform: clip(runtime.platform, APP_CAPS.platform) || "unknown",
  };
  const nativeApp = clip(extra?.nativeApp, APP_CAPS.nativeApp);
  if (nativeApp) app.nativeApp = nativeApp;
  return app;
}

function sanitizeApp(app) {
  const out = {};
  if (!app || typeof app !== "object") return out;
  for (const [key, cap] of Object.entries(APP_CAPS)) {
    const text = clip(app[key], cap);
    if (text) out[key] = text;
  }
  return out;
}

/** Keep the newest MAX_FILES, delete the oldest. */
function enforceCap() {
  let names;
  try {
    names = fs.readdirSync(CRASH_DIR);
  } catch {
    return;
  }
  const files = [];
  for (const name of names) {
    if (!FILE_PATTERN.test(name)) continue;
    const full = path.join(CRASH_DIR, name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    files.push({ full, mtimeMs: stat.mtimeMs });
  }
  files.sort((a, b) => a.mtimeMs - b.mtimeMs);
  while (files.length > MAX_FILES) {
    const oldest = files.shift();
    try {
      fs.unlinkSync(oldest.full);
    } catch {}
  }
}

/** Drop reports older than seven days, then enforce the count cap. */
function sweep() {
  ensureDir();
  const now = Date.now();
  let names;
  try {
    names = fs.readdirSync(CRASH_DIR);
  } catch {
    return;
  }
  for (const name of names) {
    if (!FILE_PATTERN.test(name)) continue;
    const full = path.join(CRASH_DIR, name);
    try {
      if (now - fs.statSync(full).mtimeMs > MAX_AGE_MS) fs.unlinkSync(full);
    } catch {}
  }
  enforceCap();
}

function writeReport(report) {
  ensureDir();
  const file = reportFile(report.id);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(report));
  fs.renameSync(tmp, file);
  enforceCap();
}

function readReport(id) {
  if (!ID_PATTERN.test(String(id || ""))) return null;
  try {
    return JSON.parse(fs.readFileSync(reportFile(id), "utf8"));
  } catch {
    return null;
  }
}

function listReports() {
  sweep();
  let names;
  try {
    names = fs.readdirSync(CRASH_DIR);
  } catch {
    return [];
  }
  const reports = [];
  for (const name of names) {
    const match = FILE_PATTERN.exec(name);
    if (!match) continue;
    const report = readReport(match[1]);
    if (report) reports.push(report);
  }
  reports.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return reports;
}

function deleteReport(id) {
  if (!ID_PATTERN.test(String(id || ""))) return false;
  try {
    fs.unlinkSync(reportFile(id));
    return true;
  } catch {
    return false;
  }
}

function deleteAllReports() {
  let names;
  try {
    names = fs.readdirSync(CRASH_DIR);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!FILE_PATTERN.test(name)) continue;
    try {
      fs.unlinkSync(path.join(CRASH_DIR, name));
      removed += 1;
    } catch {}
  }
  return removed;
}

// --- sent record ----------------------------------------------------------

function readSent() {
  try {
    const data = JSON.parse(fs.readFileSync(SENT_FILE, "utf8"));
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.sent)) return data.sent;
    return [];
  } catch {
    return [];
  }
}

function recordSent(entry) {
  ensureDir();
  const list = [entry, ...readSent()].slice(0, SENT_MAX);
  const tmp = `${SENT_FILE}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ sent: list }));
    fs.renameSync(tmp, SENT_FILE);
  } catch {}
}

// --- building and uploading ----------------------------------------------

function buildReport(input = {}) {
  const category = CATEGORIES.includes(input.category) ? input.category : null;
  if (!category) {
    const error = new Error("Unknown crash category");
    error.status = 400;
    throw error;
  }

  const errorInput = input.error && typeof input.error === "object" ? input.error : {};
  const type = sanitizeText(errorInput.type, TYPE_MAX) || "Error";
  const stack = normalizeStack(errorInput.stack);

  return {
    schema: 1,
    id: newId(),
    fingerprint: fingerprintOf(category, type, stack),
    createdAt: new Date().toISOString(),
    category,
    error: { type, message: sanitizeText(errorInput.message, MESSAGE_MAX), stack },
    screen: normalizeScreen(input.screen),
    app: buildApp(input.app),
    device: sanitizeClientFields(input.device),
    breadcrumbs: normalizeBreadcrumbs(input.breadcrumbs),
    status: "pending",
    lastError: null,
  };
}

/** Persist one new report. Returns it. Throws a 400 for an unknown category. */
function createReport(input = {}) {
  const report = buildReport(input);
  writeReport(report);
  return report;
}

/**
 * The report part of the object that would be sent: no local-only keys,
 * re-sanitized. `forwardReport()` adds the technical debug log beside it.
 * This is also what GET /crash-reports previews (with status/lastError added
 * back).
 */
function uploadObject(report) {
  const errorInput = report?.error && typeof report.error === "object" ? report.error : {};
  const category = CATEGORIES.includes(report?.category) ? report.category : "web-error";
  return {
    schema: 1,
    id: typeof report?.id === "string" ? report.id : "",
    fingerprint: typeof report?.fingerprint === "string" ? report.fingerprint : "",
    createdAt: typeof report?.createdAt === "string" ? report.createdAt : "",
    category,
    error: {
      type: sanitizeText(errorInput.type, TYPE_MAX) || "Error",
      message: sanitizeText(errorInput.message, MESSAGE_MAX),
      stack: normalizeStack(errorInput.stack),
    },
    screen: normalizeScreen(report?.screen),
    app: sanitizeApp(report?.app),
    device: sanitizeClientFields(report?.device),
    breadcrumbs: normalizeBreadcrumbs(report?.breadcrumbs),
  };
}

function endpoint() {
  return process.env.LEVIX_CRASH_REPORT_URL || DEFAULT_ENDPOINT;
}

/** The debug tail, or "" when it cannot be read. Never fails a send. */
function safeDebugLog() {
  try {
    return readDebugTail();
  } catch {
    return "";
  }
}

/**
 * The upload object plus a debug log only when the caller already has the
 * exact string. A missing string omits the key — send must not invent one.
 */
function uploadWithDebugLog(report, debugLog) {
  if (typeof debugLog !== "string") return uploadObject(report);
  return { ...uploadObject(report), debugLog };
}

/**
 * Forward one report. Never retried here; the caller decides. `debugLogId` is
 * the snapshot `list()` returned. Missing or expired attaches no debug log.
 * Resolves with `{ ok: true }` or `{ ok: false, status, error }`.
 */
async function forwardReport(report, debugLogId) {
  const payload = uploadWithDebugLog(report, readDebugSnapshot(debugLogId));
  const runtime = runtimeFacts();
  let response;
  let data = null;
  try {
    response = await fetch(endpoint(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": `Levix/${runtime.version} (${runtime.platform})`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    data = await response.json().catch(() => null);
  } catch {
    return {
      ok: false,
      status: 502,
      error: "Could not reach the Levix server. Check the bot's internet connection and try again.",
    };
  }

  if (response.ok && data?.ok) return { ok: true, id: data.id ?? payload.id };

  const remote = typeof data?.error === "string" ? sanitizeText(data.error, 200) : "";
  const status = response.status === 429 ? 429 : 502;
  return {
    ok: false,
    status,
    error: remote || `The crash-report service refused the report (HTTP ${response.status}).`,
  };
}

/** Send one stored report. Success deletes it and records the send. */
async function sendReport(id, debugLogId) {
  const report = readReport(id);
  if (!report) return { ok: false, status: 404, error: "Crash report not found" };

  const result = await forwardReport(report, debugLogId);
  if (result.ok) {
    deleteReport(report.id);
    recordSent({
      id: report.id,
      sentAt: new Date().toISOString(),
      category: uploadObject(report).category,
      type: uploadObject(report).error.type,
    });
    return { ok: true };
  }

  report.status = "failed";
  report.lastError = result.error;
  try {
    writeReport(report);
  } catch {}
  return { ok: false, status: result.status, error: result.error };
}

/** What GET /crash-reports returns: previews plus the send history. */
function list() {
  // One frozen tail for every report in this response. Send redeems the id.
  const debugLog = safeDebugLog();
  const debugLogId = storeDebugSnapshot(debugLog);
  const reports = listReports().map((report) => ({
    ...uploadWithDebugLog(report, debugLog),
    debugLogId,
    status: report.status || "pending",
    lastError: report.lastError ?? null,
  }));
  return { reports, sent: readSent() };
}

/**
 * Write a report from a Node fatal handler. Synchronous and wrapped so a
 * failure to write can never throw out of a process that is already dying.
 */
function captureNodeFatal(kind, error) {
  try {
    const category = kind === "node-rejection" ? "node-rejection" : "node-uncaught";
    const type = error?.name || (typeof error === "string" ? "Error" : "UnknownError");
    const message = error?.message || (typeof error === "string" ? error : "");
    const stack = typeof error?.stack === "string" ? error.stack : "";
    return createReport({ category, error: { type, message, stack } });
  } catch {
    return null;
  }
}

module.exports = {
  CRASH_DIR,
  CATEGORIES,
  MAX_FILES,
  MAX_AGE_MS,
  SENT_MAX,
  POST_MAX,
  POST_WINDOW_MS,
  createReport,
  uploadObject,
  list,
  listReports,
  readReport,
  deleteReport,
  deleteAllReports,
  sweep,
  forwardReport,
  sendReport,
  recordSent,
  readSent,
  captureNodeFatal,
  crashReportRetryAfter,
  recordCrashReportAttempt,
  resetCrashReportThrottle,
};

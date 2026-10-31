import { createReadStream } from "node:fs";
import { Router } from "express";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { CODES, validatePassword, openBackup } = require("../backup/format.cjs");
const { describeBackupContents } = require("../backup/create.cjs");
const jobs = require("../backup/jobs.cjs");
const uploads = require("../backup/uploads.cjs");
const restore = require("../backup/restore.cjs");
const { readLastActivation } = require("../backup/activation.cjs");
const { readPairedAccount, maskAccount, accountsMatch } = require("../backup/account.cjs");
const { buildPlan, publicPlan } = require("../backup/plan.cjs");
const secrets = require("../config/secrets.cjs");
const { blockedFor, recordFailure, clearAttempts } = require("../panel/login-throttle.cjs");
const { clientAddress } = require("../utils/requestOrigin.cjs");

const router = Router();
const tokenRe = /^[0-9a-f]{64}$/;
const jobRe = /^[0-9a-f]{32}$/;
const errorCodes = new Set([...CODES, "NO_SPACE", "UNCLASSIFIED_TABLE", "SECRET_FOUND", "SCHEMA_NEWER", "SCHEMA_MISMATCH", "NOT_FOUND", "BAD_LENGTH", "LENGTH_REQUIRED", "too_many_attempts", "RESTORE_INCOMPLETE", "CONFIRM_REQUIRED"]);

export function jsonUnlessBackupUpload(jsonParser) {
  return (req, res, next) => {
    const urlPath = (req.originalUrl || "").split("?")[0];
    if (req.method === "POST" && urlPath.endsWith("/backup/restore/uploads")) return next();
    return jsonParser(req, res, next);
  };
}

function respondError(res, error) {
  const code = errorCodes.has(error?.code) ? error.code : "IO";
  const status = code === "BUSY" || code === "CONFIRM_REQUIRED" || code === "UNCLASSIFIED_TABLE" || code === "SCHEMA_NEWER" || code === "SCHEMA_MISMATCH" ? 409 :
    code === "LENGTH_REQUIRED" ? 411 : code === "LIMIT" ? 413 :
    code === "NO_SPACE" ? 507 : code === "NOT_FOUND" ? 404 :
    ["BAD_PASSWORD", "BAD_LENGTH", "WRONG_PASSWORD", "DAMAGED", "too_many_attempts"].includes(code) ? 400 : 500;
  return res.status(status).json({ success: false, code });
}

function requireCurrent(req, res) {
  const peer = clientAddress(req);
  const retryAfter = blockedFor(peer);
  if (retryAfter) {
    res.set("Retry-After", String(retryAfter));
    res.status(429).json({ success: false, code: "throttled", retryAfter });
    return false;
  }
  if (!secrets.verifyDashboardPassword(req.body?.current)) {
    recordFailure(peer);
    res.status(403).json({ success: false, code: "wrong_password" });
    return false;
  }
  clearAttempts(peer);
  return true;
}

router.post("/backup/restore/uploads", async (req, res) => {
  try {
    if (req.headers["content-type"]?.split(";")[0] !== "application/octet-stream")
      return res.status(415).json({ success: false, code: "UNSUPPORTED_MEDIA_TYPE" });
    return res.json(await uploads.receiveUpload(req));
  } catch (error) { return respondError(res, error); }
});

router.post("/backup/restore/uploads/:id/preview", async (req, res) => {
  const id = req.params.id;
  if (!uploads.idRe.test(id)) return res.status(404).json({ success: false, code: "NOT_FOUND" });
  if (uploads.lockedOut(id)) return respondError(res, { code: "too_many_attempts" });
  const pin = uploads.pinUpload(id);
  if (!pin) return res.status(404).json({ success: false, code: "NOT_FOUND" });
  try {
    const opened = await openBackup({ path: pin.path, password: req.body?.password });
    restore.schemaCheck(opened.manifest);
    const m = opened.manifest;
    const paired = readPairedAccount();
    const status = !m.account ? "none" : !paired ? "target-unpaired" :
      accountsMatch(m.account, paired) ? "match" : "different";
    const plan = buildPlan({ digests: m.digests ?? null, apiKeyNames: m.apiKeys, account: m.account,
      personaSha: m.entries.find((entry) => entry.kind === "persona")?.sha256 ?? null });
    return res.json({ created: m.created, app: m.app, schema: m.schema, platform: m.platform,
      counts: m.counts, apiKeys: m.apiKeys, account: { masked: maskAccount(m.account), status },
      accountData: m.account ? "waits" : "none", plan: publicPlan(plan) });
  } catch (error) {
    if (error.code === "WRONG_PASSWORD" && uploads.wrongPassword(id))
      return respondError(res, { code: "too_many_attempts" });
    return respondError(res, error);
  } finally { pin.release(); }
});

router.post("/backup/restore/uploads/:id/restore", (req, res) => {
  const id = req.params.id;
  if (uploads.idRe.test(id) && uploads.lockedOut(id)) return respondError(res, { code: "too_many_attempts" });
  if (!uploads.idRe.test(id) || !uploads.getUpload(id))
    return res.status(404).json({ success: false, code: "NOT_FOUND" });
  if (!requireCurrent(req, res)) return;
  try {
    return res.json({ jobId: jobs.startRestore(id, req.body?.password,
      { confirmDestructive: req.body?.confirmDestructive === true }) });
  }
  catch (error) { return respondError(res, error); }
});

router.get("/backup/pending", (_req, res) => {
  try { return res.json({ ...restore.pendingStatus(), lastActivation: readLastActivation() }); }
  catch (error) { return respondError(res, error); }
});

router.delete("/backup/pending", (req, res) => {
  if (!requireCurrent(req, res)) return;
  try { restore.discardPending(); return res.json({ success: true }); }
  catch (error) { return respondError(res, error); }
});

router.get("/backup/contents", (_req, res) => {
  try { res.json(describeBackupContents()); }
  catch (error) { respondError(res, error); }
});

router.post("/backup/exports", (req, res) => {
  const { password, confirm, current } = req.body || {};
  if (password !== confirm) return res.status(400).json({ success: false, code: "BAD_PASSWORD" });
  try { validatePassword(password); }
  catch (error) { return respondError(res, error); }
  const peer = clientAddress(req);
  const retryAfter = blockedFor(peer);
  if (retryAfter) {
    res.set("Retry-After", String(retryAfter));
    return res.status(429).json({ success: false, code: "throttled", retryAfter });
  }
  if (!secrets.verifyDashboardPassword(current)) {
    recordFailure(peer);
    return res.status(403).json({ success: false, code: "wrong_password" });
  }
  clearAttempts(peer);
  try { return res.json({ jobId: jobs.startExport(password) }); }
  catch (error) { return respondError(res, error); }
});

router.get("/backup/jobs/:id", (req, res) => {
  const job = jobRe.test(req.params.id) && jobs.getJob(req.params.id);
  if (!job) return res.status(404).json({ success: false, code: "NOT_FOUND" });
  return res.json(job);
});

router.get("/backup/exports/:token", (req, res) => {
  if (!tokenRe.test(req.params.token)) return res.status(404).json({ success: false, code: "NOT_FOUND" });
  const file = jobs.getExport(req.params.token);
  if (!file) return res.status(404).json({ success: false, code: "NOT_FOUND" });
  const stream = createReadStream(file.path);
  stream.once("open", () => {
    res.set({ "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${file.fileName}"`,
      "Content-Length": String(file.size), "Cache-Control": "no-store" });
    stream.pipe(res);
  });
  stream.on("error", () => {
    if (!res.headersSent) {
      res.removeHeader("Content-Disposition");
      res.removeHeader("Content-Length");
      res.removeHeader("Content-Type");
      res.status(404).json({ success: false, code: "NOT_FOUND" });
    }
    else res.destroy();
  });
  res.on("close", () => stream.destroy());
});

router.delete("/backup/exports/:token", (req, res) => {
  if (!tokenRe.test(req.params.token) || !jobs.removeExport(req.params.token))
    return res.status(404).json({ success: false, code: "NOT_FOUND" });
  return res.json({ success: true });
});

export default router;

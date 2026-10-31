import { createReadStream } from "node:fs";
import { Router } from "express";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { CODES, validatePassword } = require("../backup/format.cjs");
const { describeBackupContents } = require("../backup/create.cjs");
const jobs = require("../backup/jobs.cjs");
const secrets = require("../config/secrets.cjs");
const { blockedFor, recordFailure, clearAttempts } = require("../panel/login-throttle.cjs");
const { clientAddress } = require("../utils/requestOrigin.cjs");

const router = Router();
const tokenRe = /^[0-9a-f]{64}$/;
const jobRe = /^[0-9a-f]{32}$/;
const errorCodes = new Set([...CODES, "NO_SPACE", "UNCLASSIFIED_TABLE", "SECRET_FOUND"]);

function respondError(res, error) {
  const code = errorCodes.has(error?.code) ? error.code : "IO";
  const status = code === "BUSY" ? 409 : code === "BAD_PASSWORD" ? 400 :
    code === "NO_SPACE" ? 507 : code === "UNCLASSIFIED_TABLE" ? 409 : 500;
  return res.status(status).json({ success: false, code });
}

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

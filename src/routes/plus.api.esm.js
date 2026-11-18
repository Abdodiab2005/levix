// Panel routes for Levix Plus. Mounted by the panel bootstrap under
// `/dashboard/api`. Responses carry state only: no token, installation id,
// sequence, or purchase token.

import { Router } from "express";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { TRUSTED_KEYS } = require("../extensions/entitlement/keys.cjs");
const { validateClaimBody } = require("../extensions/entitlement/client.cjs");

const CLAIM_BODY_MAX = 4096;
const REFRESH_INTERVAL_MS = 30_000;
const STATES = new Set([
  "none",
  "active",
  "grace",
  "canceled",
  "inactive",
  "expired",
  "clock",
  "unverified",
]);
const UNTIL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const REASON_RE = /^[a-z0-9_]{1,32}$/;
const INSTALLATION_RE = /^[A-Za-z0-9_-]{43}$/;
const CODE_RE = /^[A-Z0-9_]{1,64}$/;

function pickStatus(value) {
  const state = STATES.has(value?.state) ? value.state : "none";
  const until = typeof value?.until === "string" && UNTIL_RE.test(value.until) ? value.until : null;
  const reason =
    typeof value?.reason === "string" && REASON_RE.test(value.reason) ? value.reason : null;
  return { state, until, reason };
}

function readStatus(entitlement) {
  try {
    return pickStatus(entitlement.status());
  } catch {
    return { state: "unverified", until: null, reason: null };
  }
}

function publicResult(result, entitlement) {
  const body = {
    ok: result?.ok === true,
    entitlement: pickStatus(result?.entitlement ?? readStatus(entitlement)),
  };
  if (!body.ok && typeof result?.code === "string" && CODE_RE.test(result.code))
    body.code = result.code;
  if (
    Number.isSafeInteger(result?.retryAfter) &&
    result.retryAfter >= 0 &&
    result.retryAfter <= 86400
  ) {
    body.retryAfter = result.retryAfter;
  }
  return body;
}

function claimTooLarge(req) {
  const header = req.headers?.["content-length"];
  if (header != null && /^\d+$/.test(String(header).trim()) && Number(header) > CLAIM_BODY_MAX)
    return true;
  if (req.body == null) return false;
  try {
    return Buffer.byteLength(JSON.stringify(req.body)) > CLAIM_BODY_MAX;
  } catch {
    return true;
  }
}

/**
 * @param {{ entitlement: object, extensionStatus?: () => unknown, keys?: Array<unknown>, now?: () => number, clock?: () => number }} options
 */
export function createPlusRouter(options = {}) {
  const { entitlement, extensionStatus = () => ({ state: "absent" }), keys } = options;
  const now = options.now ?? options.clock ?? (() => Date.now());
  if (!entitlement || typeof extensionStatus !== "function") {
    throw new Error("createPlusRouter requires entitlement and extensionStatus");
  }
  const router = Router();
  let lastRefreshAt = null;

  function isConfigured() {
    if (Array.isArray(keys)) return keys.length > 0;
    if (typeof entitlement.isConfigured === "function") return Boolean(entitlement.isConfigured());
    return TRUSTED_KEYS.length > 0;
  }

  router.get("/plus/status", (_req, res) => {
    try {
      return res.json({
        configured: isConfigured(),
        entitlement: readStatus(entitlement),
        extension: extensionStatus(),
      });
    } catch {
      return res.status(500).json({ ok: false, code: "UNAVAILABLE" });
    }
  });

  router.post("/plus/prepare", async (_req, res) => {
    try {
      const result = await entitlement.prepare();
      if (
        typeof result?.installationId !== "string" ||
        !INSTALLATION_RE.test(result.installationId)
      ) {
        return res.status(500).json({ ok: false, code: "UNAVAILABLE" });
      }
      return res.json({ installationId: result.installationId });
    } catch {
      return res.status(500).json({ ok: false, code: "UNAVAILABLE" });
    }
  });

  router.post("/plus/claim", async (req, res) => {
    const entitlementStatus = readStatus(entitlement);
    if (claimTooLarge(req)) {
      return res
        .status(413)
        .json({ ok: false, code: "BAD_REQUEST", entitlement: entitlementStatus });
    }
    if (!validateClaimBody(req.body)) {
      return res
        .status(400)
        .json({ ok: false, code: "BAD_REQUEST", entitlement: entitlementStatus });
    }
    try {
      const result = await entitlement.claim({
        purchaseToken: req.body.purchaseToken,
        productId: req.body.productId,
        packageName: req.body.packageName,
      });
      return res.status(200).json(publicResult(result, entitlement));
    } catch {
      return res
        .status(500)
        .json({ ok: false, code: "UNAVAILABLE", entitlement: entitlementStatus });
    }
  });

  router.post("/plus/refresh", async (_req, res) => {
    const current = now();
    if (lastRefreshAt != null && current - lastRefreshAt < REFRESH_INTERVAL_MS) {
      const retryAfter = Math.max(
        1,
        Math.ceil((REFRESH_INTERVAL_MS - (current - lastRefreshAt)) / 1000),
      );
      res.set("Retry-After", String(retryAfter));
      return res.status(429).json({
        ok: false,
        code: "RATE_LIMITED",
        retryAfter,
        entitlement: readStatus(entitlement),
      });
    }
    lastRefreshAt = current;
    try {
      const result = await entitlement.refresh({ force: true });
      return res.status(200).json(publicResult(result, entitlement));
    } catch {
      return res
        .status(500)
        .json({ ok: false, code: "UNAVAILABLE", entitlement: readStatus(entitlement) });
    }
  });

  return router;
}

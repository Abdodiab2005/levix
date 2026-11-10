// Panel routes for Levix Plus (/plus/status, /plus/prepare, /plus/claim, /plus/refresh).

import crypto from "node:crypto";
import { equal, finish, ok, require, section, useTempDataDir } from "./harness.mjs";
import { createPlusRouter } from "../src/routes/plus.api.esm.js";

useTempDataDir("levix-entitlement-routes");

const keys = require("./src/extensions/entitlement/keys.cjs");
const { createEntitlement } = require("./src/extensions/entitlement/index.cjs");

function makeSigner() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const raw = keys.rawFromKeyObject(publicKey);
  const keyId = keys.keyIdFor(raw);
  return {
    privateKey,
    keyId,
    entry: Object.freeze({ keyId, publicKey: raw.toString("base64") }),
  };
}

function makeToken(signer, installationId, seq = 1, iat = 1_762_780_000) {
  const header = Buffer.from(
    JSON.stringify({ alg: "EdDSA", kid: signer.keyId, typ: "levix-ent+jwt" }),
    "utf8",
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      aud: "levix-core",
      ent: ["plus"],
      exp: iat + 259_200,
      iat,
      iss: "levix-plus-verifier",
      jti: Buffer.alloc(16, seq).toString("base64url"),
      pexp: iat + 2_592_000,
      rsn: null,
      seq,
      st: "active",
      sub: installationId,
    }),
    "utf8",
  ).toString("base64url");
  const sig = crypto
    .sign(null, Buffer.from(`${header}.${payload}`, "utf8"), signer.privateKey)
    .toString("base64url");
  return `${header}.${payload}.${sig}`;
}

function invokeRouter(router, method, url, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const resHeaders = {};
    const req = {
      method,
      url,
      originalUrl: url,
      headers: Object.fromEntries(
        Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]),
      ),
      body,
    };
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      set(name, value) {
        resHeaders[name.toLowerCase()] = String(value);
        return this;
      },
      json(payload) {
        resolve({ status: this.statusCode, headers: resHeaders, body: payload });
        return this;
      },
    };
    router(req, res, (err) => {
      if (err) reject(err);
      else resolve({ status: 404, headers: resHeaders, body: null });
    });
  });
}

const signer = makeSigner();
const SECRET_PURCHASE_TOKEN = "pt_route_secret_never_return_or_log_999";
const validClaim = {
  purchaseToken: SECRET_PURCHASE_TOKEN,
  productId: "levix_plus_monthly",
  packageName: "net.leviro.levix",
};

section("GET /plus/status and POST /plus/prepare when unconfigured");

{
  const entUnconf = createEntitlement({ keys: [], storage: new Map() });
  const routerUnconf = createPlusRouter({
    entitlement: entUnconf,
    extensionStatus: () => ({ state: "absent", version: null }),
  });

  const st = await invokeRouter(routerUnconf, "GET", "/plus/status");
  equal("status HTTP 200", st.status, 200);
  equal("configured is false when TRUSTED_KEYS is empty", st.body.configured, false);
  equal("entitlement state is none", st.body.entitlement?.state, "none");
  equal("extension state is absent", st.body.extension?.state, "absent");

  const prep = await invokeRouter(routerUnconf, "POST", "/plus/prepare");
  equal("prepare HTTP 200", prep.status, 200);
  ok(
    "prepare returns 43-char base64url installationId",
    typeof prep.body?.installationId === "string" &&
      /^[A-Za-z0-9_-]{43}$/.test(prep.body.installationId),
  );
  equal("prepare exposes only installationId", Object.keys(prep.body).join(","), "installationId");
}

section("POST /plus/claim validation, 4 KiB cap, and zero secret leakage");

{
  let nowMs = 1_762_780_000_000;
  let seq = 1;
  let lastCompactToken = null;
  const ent = createEntitlement({
    keys: [signer.entry],
    storage: new Map(),
    now: () => nowMs,
    fetch: async () => {
      const id = ent.prepare().installationId;
      lastCompactToken = makeToken(signer, id, seq, Math.floor(nowMs / 1000));
      seq += 1;
      return new Response(JSON.stringify({ token: lastCompactToken }), { status: 200 });
    },
  });

  const router = createPlusRouter({
    entitlement: ent,
    extensionStatus: () => ({ state: "active", version: "1.0.0" }),
    now: () => nowMs,
  });

  const invalidBody = await invokeRouter(router, "POST", "/plus/claim", {
    body: { purchaseToken: "bad token!", productId: "x", packageName: "net.leviro.levix" },
  });
  equal("invalid claim body returns HTTP 400", invalidBody.status, 400);
  equal("invalid claim body code is BAD_REQUEST", invalidBody.body?.code, "BAD_REQUEST");

  const oversizedHeader = await invokeRouter(router, "POST", "/plus/claim", {
    headers: { "content-length": "4097" },
    body: validClaim,
  });
  equal("oversized content-length returns HTTP 413", oversizedHeader.status, 413);
  equal("oversized content-length code is BAD_REQUEST", oversizedHeader.body?.code, "BAD_REQUEST");

  const oversizedPayload = await invokeRouter(router, "POST", "/plus/claim", {
    body: {
      purchaseToken: "a".repeat(2048),
      productId: "b".repeat(64),
      packageName: `net.leviro.${"c".repeat(2100)}`,
    },
  });
  equal("oversized JSON body > 4 KiB returns HTTP 413", oversizedPayload.status, 413);

  const okClaim = await invokeRouter(router, "POST", "/plus/claim", { body: validClaim });
  equal("valid claim returns HTTP 200", okClaim.status, 200);
  equal("valid claim ok is true", okClaim.body?.ok, true);
  equal("valid claim entitlement state is active", okClaim.body?.entitlement?.state, "active");

  const claimJson = JSON.stringify(okClaim.body);
  ok("claim response never contains purchaseToken", !claimJson.includes(SECRET_PURCHASE_TOKEN));
  ok(
    "claim response never contains JWS token",
    Boolean(lastCompactToken) && !claimJson.includes(lastCompactToken),
  );
  ok(
    "claim response never contains installationId",
    !claimJson.includes(ent.prepare().installationId),
  );

  const statusAfter = await invokeRouter(router, "GET", "/plus/status");
  equal("status configured is true", statusAfter.body?.configured, true);
  equal("status entitlement state is active", statusAfter.body?.entitlement?.state, "active");
  equal(
    "status entitlement keys are exactly state, until, reason",
    Object.keys(statusAfter.body.entitlement).sort().join(","),
    "reason,state,until",
  );
  const statusJson = JSON.stringify(statusAfter.body);
  ok("status response has no JWS token", !statusJson.includes(lastCompactToken));
  ok("status response has no installationId", !statusJson.includes(ent.prepare().installationId));
  ok(
    "status response has no seq field",
    !Object.hasOwn(statusAfter.body, "seq") && !Object.hasOwn(statusAfter.body.entitlement, "seq"),
  );

  section("POST /plus/refresh 30s rate limit");

  const r1 = await invokeRouter(router, "POST", "/plus/refresh");
  equal("first refresh returns HTTP 200", r1.status, 200);
  equal("first refresh ok is true", r1.body?.ok, true);

  nowMs += 10_000;
  const r2 = await invokeRouter(router, "POST", "/plus/refresh");
  equal("second refresh within 30s returns HTTP 429", r2.status, 429);
  equal("second refresh code is RATE_LIMITED", r2.body?.code, "RATE_LIMITED");
  equal("second refresh retryAfter is 20s", r2.body?.retryAfter, 20);
  equal("second refresh Retry-After header is 20", r2.headers["retry-after"], "20");

  nowMs += 20_000;
  const r3 = await invokeRouter(router, "POST", "/plus/refresh");
  equal("refresh after 30s window returns HTTP 200", r3.status, 200);
  equal("refresh after 30s window ok is true", r3.body?.ok, true);
}

finish();

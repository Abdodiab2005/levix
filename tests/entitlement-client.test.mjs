// Signed verifier client, error mapping, response caps, refresh schedule,
// backoff ladder, single-flight deduplication, and zero secret leakage in logs.

import crypto from "node:crypto";
import { equal, finish, ok, require, section, useTempDataDir } from "./harness.mjs";

useTempDataDir("levix-entitlement-client");

const keys = require("./src/extensions/entitlement/keys.cjs");
const installationMod = require("./src/extensions/entitlement/installation.cjs");
const client = require("./src/extensions/entitlement/client.cjs");
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

function makeToken(signer, installationId, overrides = {}) {
  const iat = overrides.iat ?? 1_762_780_000;
  const header = Buffer.from(
    JSON.stringify({ alg: "EdDSA", kid: signer.keyId, typ: "levix-ent+jwt" }),
    "utf8",
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      aud: "levix-core",
      ent: ["plus"],
      exp: overrides.exp ?? iat + 259_200,
      iat,
      iss: "levix-plus-verifier",
      jti: overrides.jti ?? Buffer.alloc(16, overrides.seq ?? 1).toString("base64url"),
      pexp: iat + 2_592_000,
      rsn: null,
      seq: overrides.seq ?? 1,
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

const signer = makeSigner();
const inst = installationMod.createInstallation({ storage: new Map() }).getOrCreateInstallation();
const SECRET_PURCHASE_TOKEN = "pt_super_secret_do_not_log_987654321";
const validInput = {
  purchaseToken: SECRET_PURCHASE_TOKEN,
  productId: "levix_plus_monthly",
  packageName: "net.leviro.levix",
};

section("empty TRUSTED_KEYS and claim body validation make zero network calls");

{
  let calls = 0;
  const noFetch = async () => {
    calls += 1;
    throw new Error("network must not be called");
  };

  const c1 = await client.claim(validInput, { keys: [], installation: inst, fetch: noFetch });
  equal("claim with empty keys returns UNCONFIGURED", c1.code, "UNCONFIGURED");
  const r1 = await client.refresh({ keys: [], installation: inst, seq: 0, fetch: noFetch });
  equal("refresh with empty keys returns UNCONFIGURED", r1.code, "UNCONFIGURED");
  equal("zero fetch calls when unconfigured", calls, 0);

  const badInputs = [
    null,
    {},
    { ...validInput, extra: 1 },
    { ...validInput, purchaseToken: "" },
    { ...validInput, purchaseToken: "bad space" },
    { ...validInput, purchaseToken: "a".repeat(2049) },
    { ...validInput, productId: "UPPERCASE" },
    { ...validInput, productId: "_leading_underscore" },
    { ...validInput, packageName: "nodot" },
    { ...validInput, packageName: "1bad.pkg" },
  ];

  for (const [idx, bad] of badInputs.entries()) {
    const res = await client.claim(bad, {
      keys: [signer.entry],
      installation: inst,
      fetch: noFetch,
    });
    equal(`invalid claim input #${idx} returns BAD_REQUEST`, res.code, "BAD_REQUEST");
  }
  equal("invalid claim inputs made zero fetch calls", calls, 0);
}

section("3xx redirects, oversized responses, error mapping, and log redaction");

{
  const logEntries = [];
  const captureLogger = {
    info: (...args) => logEntries.push(args),
    warn: (...args) => logEntries.push(args),
    error: (...args) => logEntries.push(args),
    debug: (...args) => logEntries.push(args),
  };

  for (const status of [301, 302, 307, 308]) {
    const redir = await client.claim(validInput, {
      keys: [signer.entry],
      installation: inst,
      logger: captureLogger,
      fetch: async () =>
        new Response("", { status, headers: { location: "https://evil.example" } }),
    });
    equal(`${status} redirect is refused with REDIRECT`, redir.code, "REDIRECT");
    equal(`${status} redirect is not retryable`, redir.retryable, false);
  }

  let streamCancelled = false;
  const bigStream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(client.MAX_RESPONSE_BYTES + 100));
    },
    cancel() {
      streamCancelled = true;
    },
  });
  const overStream = await client.claim(validInput, {
    keys: [signer.entry],
    installation: inst,
    logger: captureLogger,
    fetch: async () => new Response(bigStream, { status: 200 }),
  });
  equal("oversized stream returns OVERSIZED", overStream.code, "OVERSIZED");
  ok("oversized stream cancels reader", streamCancelled);

  const overHeader = await client.claim(validInput, {
    keys: [signer.entry],
    installation: inst,
    logger: captureLogger,
    fetch: async () =>
      new Response("{}", {
        status: 200,
        headers: { "content-length": String(client.MAX_RESPONSE_BYTES + 1) },
      }),
  });
  equal("oversized content-length returns OVERSIZED", overHeader.code, "OVERSIZED");

  const errorCases = [
    [400, "BAD_REQUEST", false],
    [401, "BAD_SIGNATURE", false],
    [401, "STALE_TIMESTAMP", true],
    [401, "REPLAY", false],
    [404, "UNKNOWN_INSTALLATION", false],
    [422, "PURCHASE_INVALID", false],
    [422, "TEST_PURCHASE_REFUSED", false],
    [409, "ACCOUNT_MISMATCH", false],
    [409, "REBIND_LIMIT", false],
    [429, "RATE_LIMITED", true],
    [503, "UNAVAILABLE", true],
  ];
  for (const [status, code, retryable] of errorCases) {
    const out = await client.claim(validInput, {
      keys: [signer.entry],
      installation: inst,
      logger: captureLogger,
      fetch: async () =>
        new Response(JSON.stringify({ error: { code, retryable } }), {
          status,
          headers: status === 429 ? { "retry-after": "120" } : {},
        }),
    });
    equal(`verifier ${status} ${code} mapped`, out.code, code);
    equal(`verifier ${status} ${code} retryable`, out.retryable, retryable);
    if (status === 429) equal("429 retryAfter parsed", out.retryAfter, 120);
  }

  let capturedSig = null;
  const netErr = await client.claim(validInput, {
    keys: [signer.entry],
    installation: inst,
    logger: captureLogger,
    fetch: async (_url, init) => {
      capturedSig = init.headers["x-levix-signature"];
      throw new Error(`network failed for ${SECRET_PURCHASE_TOKEN} sig=${capturedSig}`);
    },
  });
  equal("network error returns UNAVAILABLE", netErr.code, "UNAVAILABLE");
  equal("network error is retryable", netErr.retryable, true);

  const serializedLogs = JSON.stringify(logEntries);
  ok("purchase token never appears in logs", !serializedLogs.includes(SECRET_PURCHASE_TOKEN));
  ok(
    "request signature never appears in logs",
    Boolean(capturedSig) && !serializedLogs.includes(capturedSig),
  );
}

section(
  "refresh scheduler: 60s minimum floor, 5xx/timeout backoff, 429 Retry-After, and single flight",
);

{
  const iat = 1_762_780_000;
  let nowMs = iat * 1000;
  const scheduledDelays = [];
  let pendingRefreshFn = null;
  let nextOutcome = null;

  const ent = createEntitlement({
    keys: [signer.entry],
    storage: new Map(),
    now: () => nowMs,
    random: () => 0.9,
    setTimer: (fn, ms) => {
      scheduledDelays.push(ms);
      pendingRefreshFn = fn;
      return { ms };
    },
    clearTimer: () => {},
    fetch: async () => nextOutcome(),
  });

  const id = ent.prepare().installationId;
  // Claim a token whose exp - 6h is ALREADY in the past (exp = iat + 1h, so exp - 6h = iat - 5h).
  nextOutcome = async () =>
    new Response(
      JSON.stringify({ token: makeToken(signer, id, { seq: 1, iat, exp: iat + 3600 }) }),
      { status: 200 },
    );

  ent.start();
  await ent.claim(validInput);
  equal("active after claim", ent.isActive("plus"), true);
  ok(
    "refresh delay when exp - 6h is already past is never below 60s",
    scheduledDelays[0] >= 60_000,
    `got ${scheduledDelays[0]}`,
  );

  // Test 5xx / timeout backoff ladder: 1 min, 5 min, 15 min, 1 h, 6 h (cap), keeping current token active.
  const expectedBackoff = [60_000, 300_000, 900_000, 3_600_000, 21_600_000, 21_600_000];
  for (const [idx, expectedMs] of expectedBackoff.entries()) {
    scheduledDelays.length = 0;
    nextOutcome = async () => {
      if (idx % 2 === 0)
        return new Response(JSON.stringify({ error: { code: "UNAVAILABLE", retryable: true } }), {
          status: 503,
        });
      throw new Error("AbortError: timeout");
    };
    const res = await ent.refresh({ force: true });
    equal(`failure #${idx + 1} returns UNAVAILABLE`, res.code, "UNAVAILABLE");
    equal(`failure #${idx + 1} keeps current token active`, ent.isActive("plus"), true);
    equal(`failure #${idx + 1} backs off ${expectedMs} ms`, scheduledDelays.at(-1), expectedMs);
  }

  // Successful refresh resets backoff counter and schedules min(iat + 12h, exp - 6h).
  scheduledDelays.length = 0;
  nextOutcome = async () =>
    new Response(
      JSON.stringify({ token: makeToken(signer, id, { seq: 2, iat, exp: iat + 259_200 }) }),
      { status: 200 },
    );
  const okRefresh = await ent.refresh({ force: true });
  equal("refresh succeeds with seq 2", okRefresh.ok, true);
  // First timer armed in scheduleSuccess is refresh (12h + jitter), second is expiry (72h).
  ok("refresh scheduled at >= 12h", scheduledDelays[0] >= 12 * 3600 * 1000);

  // Next failure after success starts back at 1 min (60_000 ms), unless 429 Retry-After is larger.
  scheduledDelays.length = 0;
  nextOutcome = async () =>
    new Response(JSON.stringify({ error: { code: "RATE_LIMITED", retryable: true } }), {
      status: 429,
      headers: { "retry-after": "180" },
    });
  const rateRes = await ent.refresh({ force: true });
  equal("429 returns RATE_LIMITED", rateRes.code, "RATE_LIMITED");
  equal("429 Retry-After (180s) honoured over 60s step", scheduledDelays.at(-1), 180_000);

  // Single flight: concurrent refresh calls share one fetch.
  let fetchCount = 0;
  let resolveFetch;
  nextOutcome = () => {
    fetchCount += 1;
    return new Promise((resolve) => {
      resolveFetch = () =>
        resolve(
          new Response(
            JSON.stringify({ token: makeToken(signer, id, { seq: 3, iat, exp: iat + 259_200 }) }),
            { status: 200 },
          ),
        );
    });
  };

  const p1 = ent.refresh({ force: true });
  const p2 = ent.refresh({ force: true });
  const p3 = ent.refresh({ force: true });
  equal("concurrent refresh calls trigger only one fetch", fetchCount, 1);
  resolveFetch();
  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
  equal("all concurrent callers receive ok", r1.ok && r2.ok && r3.ok, true);
  equal("still only one fetch after completion", fetchCount, 1);
  ok("unused variable check", typeof pendingRefreshFn === "function");
  ent.stop();
}

finish();

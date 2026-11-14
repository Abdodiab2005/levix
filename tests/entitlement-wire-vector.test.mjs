// Deterministic wire vector for the Levix Plus signed request and JWS token.

import crypto from "node:crypto";
import { equal, finish, ok, require, section, useTempDataDir } from "./harness.mjs";

useTempDataDir("levix-entitlement-wire-vector");

const { keyIdFor, rawFromKeyObject } = require("./src/extensions/entitlement/keys.cjs");
const { verifyToken } = require("./src/extensions/entitlement/token.cjs");
const client = require("./src/extensions/entitlement/client.cjs");

const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SEED = Buffer.alloc(32, 0);
const PRIVATE_KEY = crypto.createPrivateKey({
  key: Buffer.concat([PKCS8_PREFIX, SEED]),
  format: "der",
  type: "pkcs8",
});
const PUBLIC_KEY = crypto.createPublicKey(PRIVATE_KEY);
const PUBLIC_RAW = rawFromKeyObject(PUBLIC_KEY);
const INSTALLATION_ID = crypto.createHash("sha256").update(PUBLIC_RAW).digest("base64url");
const KEY_ID = keyIdFor(PUBLIC_RAW);
const TRUSTED_ENTRY = Object.freeze({
  keyId: KEY_ID,
  publicKey: PUBLIC_RAW.toString("base64"),
});

const FIXED_NONCE_BYTES = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");
const FIXED_NONCE = "AAECAwQFBgcICQoLDA0ODw";
const FIXED_TS = 1_762_780_800_000;

const installation = Object.freeze({
  installationId: INSTALLATION_ID,
  publicKeyRaw: Buffer.from(PUBLIC_RAW),
  sign(bytes) {
    return crypto.sign(null, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes), PRIVATE_KEY);
  },
});

section("fixed Ed25519 key derivation");

{
  equal(
    "RFC 8032 zero-seed public key hex",
    PUBLIC_RAW.toString("hex"),
    "3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29",
  );
  equal("installationId length is 43 base64url chars", INSTALLATION_ID.length, 43);
  ok("installationId matches base64url alphabet", /^[A-Za-z0-9_-]{43}$/.test(INSTALLATION_ID));
  equal("fixed nonce base64url", FIXED_NONCE_BYTES.toString("base64url"), FIXED_NONCE);
}

section("claim signed bytes and signature vector");

{
  const claimInput = {
    purchaseToken: "purchase_token_vector_01",
    productId: "levix_plus_monthly",
    packageName: "net.leviro.levix",
  };
  const expectedBody =
    '{"purchaseToken":"purchase_token_vector_01","productId":"levix_plus_monthly","packageName":"net.leviro.levix"}';
  const expectedBodySha256 = crypto
    .createHash("sha256")
    .update(expectedBody, "utf8")
    .digest("base64url");
  const expectedSigned =
    `{"aud":"levix-plus-verifier","bodySha256":"${expectedBodySha256}",` +
    `"installation":"${INSTALLATION_ID}","method":"POST",` +
    `"nonce":"${FIXED_NONCE}","path":"/v1/claim","ts":${FIXED_TS}}`;

  equal(
    "buildSignedBytes produces exact canonical JSON string for claim",
    client.buildSignedBytes({
      installationId: INSTALLATION_ID,
      path: "/v1/claim",
      nonce: FIXED_NONCE,
      ts: FIXED_TS,
      rawBody: expectedBody,
    }),
    expectedSigned,
  );

  const expectedSignature = crypto
    .sign(null, Buffer.from(expectedSigned, "utf8"), PRIVATE_KEY)
    .toString("base64url");

  let captured = null;
  const responseHeader = Buffer.from(
    JSON.stringify({ alg: "EdDSA", kid: KEY_ID, typ: "levix-ent+jwt" }),
    "utf8",
  ).toString("base64url");
  const responsePayload = Buffer.from(
    JSON.stringify({
      aud: "levix-core",
      ent: ["plus"],
      exp: 1_762_780_800 + 259_200,
      iat: 1_762_780_800,
      iss: "levix-plus-verifier",
      jti: FIXED_NONCE,
      pexp: 1_762_780_800 + 2_592_000,
      rsn: null,
      seq: 1,
      st: "active",
      sub: INSTALLATION_ID,
    }),
    "utf8",
  ).toString("base64url");
  const tokenSig = crypto
    .sign(null, Buffer.from(`${responseHeader}.${responsePayload}`, "utf8"), PRIVATE_KEY)
    .toString("base64url");
  const compactToken = `${responseHeader}.${responsePayload}.${tokenSig}`;

  const outcome = await client.claim(claimInput, {
    keys: [TRUSTED_ENTRY],
    installation,
    now: () => FIXED_TS,
    randomBytes: () => FIXED_NONCE_BYTES,
    fetch: async (url, init) => {
      captured = { url, init };
      return new Response(JSON.stringify({ token: compactToken }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  equal("claim outcome is ok", outcome.ok, true);
  equal("claim request URL", captured?.url, "https://levix-plus.leviro.net/v1/claim");
  equal("claim request body", captured?.init?.body, expectedBody);
  equal(
    "claim header x-levix-installation",
    captured?.init?.headers["x-levix-installation"],
    INSTALLATION_ID,
  );
  equal(
    "claim header x-levix-key",
    captured?.init?.headers["x-levix-key"],
    PUBLIC_RAW.toString("base64url"),
  );
  equal("claim header x-levix-nonce", captured?.init?.headers["x-levix-nonce"], FIXED_NONCE);
  equal(
    "claim header x-levix-timestamp",
    captured?.init?.headers["x-levix-timestamp"],
    String(FIXED_TS),
  );
  equal(
    "claim header x-levix-signature matches deterministic Ed25519 signature",
    captured?.init?.headers["x-levix-signature"],
    expectedSignature,
  );

  const verifiedSig = crypto.verify(
    null,
    Buffer.from(expectedSigned, "utf8"),
    PUBLIC_KEY,
    Buffer.from(captured.init.headers["x-levix-signature"], "base64url"),
  );
  ok("request signature verifies against canonical signed bytes", verifiedSig);

  const verifiedToken = verifyToken(outcome.token, {
    keys: [TRUSTED_ENTRY],
    installationId: INSTALLATION_ID,
    storedSeq: null,
    storedJti: null,
  });
  ok("returned compact JWS verifies", verifiedToken.ok);
  equal("verified token seq", verifiedToken.claims?.seq, 1);
  equal("verified token state", verifiedToken.claims?.st, "active");
}

section("refresh signed bytes and signature vector");

{
  const expectedBody = '{"seq":7}';
  const expectedBodySha256 = crypto
    .createHash("sha256")
    .update(expectedBody, "utf8")
    .digest("base64url");
  const expectedSigned =
    `{"aud":"levix-plus-verifier","bodySha256":"${expectedBodySha256}",` +
    `"installation":"${INSTALLATION_ID}","method":"POST",` +
    `"nonce":"${FIXED_NONCE}","path":"/v1/refresh","ts":${FIXED_TS}}`;

  equal(
    "buildSignedBytes produces exact canonical JSON string for refresh",
    client.buildSignedBytes({
      installationId: INSTALLATION_ID,
      path: "/v1/refresh",
      nonce: FIXED_NONCE,
      ts: FIXED_TS,
      rawBody: expectedBody,
    }),
    expectedSigned,
  );

  let captured = null;
  await client.refresh({
    keys: [TRUSTED_ENTRY],
    installation,
    seq: 7,
    now: () => FIXED_TS,
    randomBytes: () => FIXED_NONCE_BYTES,
    fetch: async (url, init) => {
      captured = { url, init };
      return new Response(JSON.stringify({ token: "a.b.c" }), { status: 200 });
    },
  });

  equal("refresh request URL", captured?.url, "https://levix-plus.leviro.net/v1/refresh");
  equal("refresh request body", captured?.init?.body, expectedBody);
  equal(
    "refresh omits x-levix-key header",
    Object.hasOwn(captured?.init?.headers ?? {}, "x-levix-key"),
    false,
  );
  const verifiedSig = crypto.verify(
    null,
    Buffer.from(expectedSigned, "utf8"),
    PUBLIC_KEY,
    Buffer.from(captured.init.headers["x-levix-signature"], "base64url"),
  );
  ok("refresh signature verifies against canonical signed bytes", verifiedSig);
}

finish();

// Entitlement keys, installation identity, and compact JWS token verification.

import crypto from "node:crypto";
import { equal, finish, ok, require, section, throws, useTempDataDir } from "./harness.mjs";

useTempDataDir("levix-entitlement-token");

const store = require("./src/db/store.cjs");
const vault = require("./src/config/vault.cjs");
const keys = require("./src/extensions/entitlement/keys.cjs");
const installationMod = require("./src/extensions/entitlement/installation.cjs");
const { MAX_TOKEN_BYTES, verifyToken } = require("./src/extensions/entitlement/token.cjs");

function makeSigner() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const raw = keys.rawFromKeyObject(publicKey);
  const keyId = keys.keyIdFor(raw);
  return {
    publicKey,
    privateKey,
    raw,
    keyId,
    entry: Object.freeze({ keyId, publicKey: raw.toString("base64") }),
  };
}

function makeJti(seedByte = 1) {
  return Buffer.alloc(16, seedByte).toString("base64url");
}

function signCompact(headerObj, payloadObj, privateKey) {
  const h = Buffer.from(JSON.stringify(headerObj), "utf8").toString("base64url");
  const p = Buffer.from(JSON.stringify(payloadObj), "utf8").toString("base64url");
  const sig = crypto.sign(null, Buffer.from(`${h}.${p}`, "utf8"), privateKey).toString("base64url");
  return `${h}.${p}.${sig}`;
}

const signer = makeSigner();
const otherSigner = makeSigner();

section("shipped TRUSTED_KEYS and key helpers");

{
  equal("TRUSTED_KEYS is empty by default", keys.TRUSTED_KEYS.length, 0);
  ok("TRUSTED_KEYS is frozen", Object.isFrozen(keys.TRUSTED_KEYS));
  equal("keys module has no setter", typeof keys.setTrustedKeys, "undefined");
  equal("keyIdFor returns 16 lowercase hex chars", /^[0-9a-f]{16}$/.test(signer.keyId), true);
  throws("keyIdFor rejects short buffer", () => keys.keyIdFor(Buffer.alloc(31)));
  throws("keyIdFor rejects string input", () => keys.keyIdFor("a".repeat(32)));

  const loaded = keys.loadTrustedKey(signer.entry);
  equal("loadTrustedKey keyId", loaded.keyId, signer.keyId);
  ok("loadTrustedKey result is frozen", Object.isFrozen(loaded));
  equal(
    "findTrustedKey finds matching kid",
    keys.findTrustedKey([signer.entry], signer.keyId)?.keyId,
    signer.keyId,
  );
  equal(
    "findTrustedKey returns null for unknown kid",
    keys.findTrustedKey([signer.entry], "0000000000000000"),
    null,
  );
  equal(
    "findTrustedKey returns null on duplicate kid",
    keys.findTrustedKey([signer.entry, signer.entry], signer.keyId),
    null,
  );
}

section("installation identity lifecycle and vault sealing");

{
  equal(
    "no installation row before first call",
    store.getBotSetting(installationMod.INSTALLATION_KEY, null),
    null,
  );
  equal("getInstallation is null before creation", installationMod.getInstallation(), null);

  const created = installationMod.getOrCreateInstallation();
  ok(
    "installationId is 43 base64url chars",
    typeof created?.installationId === "string" &&
      /^[A-Za-z0-9_-]{43}$/.test(created.installationId),
  );
  equal(
    "publicKeyRaw is 32-byte Buffer",
    Buffer.isBuffer(created.publicKeyRaw) && created.publicKeyRaw.length,
    32,
  );
  equal(
    "installationId equals base64url SHA-256 of raw public key",
    created.installationId,
    crypto.createHash("sha256").update(created.publicKeyRaw).digest("base64url"),
  );
  equal(
    "returned view exposes only installationId, publicKeyRaw, sign",
    Object.keys(created).sort().join(","),
    "installationId,publicKeyRaw,sign",
  );

  const rawStored = store.getBotSetting(installationMod.INSTALLATION_KEY, null);
  ok("stored installation key is sealed with vault", vault.isSealed(rawStored));

  const again = installationMod.getOrCreateInstallation();
  equal(
    "subsequent call returns same installationId",
    again.installationId,
    created.installationId,
  );

  const otherInst = installationMod
    .createInstallation({
      storage: new Map(),
      vault,
    })
    .getOrCreateInstallation();
  ok(
    "another installation has a distinct installationId",
    otherInst.installationId !== created.installationId,
  );

  const badStorage = new Map([[installationMod.INSTALLATION_KEY, "not-sealed-plaintext"]]);
  const brokenInst = installationMod.createInstallation({ storage: badStorage, vault });
  const err = throws("unsealed installation key is rejected", () => brokenInst.getInstallation());
  equal("unsealed installation error code", err?.code, "INSTALLATION_UNREADABLE");
}

const localInstallationId = installationMod.getInstallation().installationId;
const baseIat = 1_762_780_000;

function validHeader(overrides = {}) {
  return {
    alg: "EdDSA",
    kid: signer.keyId,
    typ: "levix-ent+jwt",
    ...overrides,
  };
}

function validPayload(overrides = {}) {
  return {
    aud: "levix-core",
    ent: ["plus"],
    exp: baseIat + 259_200,
    iat: baseIat,
    iss: "levix-plus-verifier",
    jti: makeJti(1),
    pexp: baseIat + 2_592_000,
    rsn: null,
    seq: 1,
    st: "active",
    sub: localInstallationId,
    ...overrides,
  };
}

section("verifyToken valid states and verifier lifetime rules");

{
  const activeToken = signCompact(
    validHeader(),
    validPayload({
      st: "active",
      pexp: baseIat + 3600,
      exp: Math.min(baseIat + 259_200, baseIat + 3600 + 7200),
    }),
    signer.privateKey,
  );
  const resActive = verifyToken(activeToken, {
    keys: [signer.entry],
    installationId: localInstallationId,
  });
  equal("valid active token verifies", resActive.ok, true);
  equal("active token state", resActive.claims?.st, "active");
  equal("active token ent", resActive.claims?.ent?.[0], "plus");

  const canceledToken = signCompact(
    validHeader(),
    validPayload({
      st: "canceled",
      pexp: baseIat + 50_000,
      exp: Math.min(baseIat + 259_200, baseIat + 50_000),
    }),
    signer.privateKey,
  );
  const resCanceled = verifyToken(canceledToken, {
    keys: [signer.entry],
    installationId: localInstallationId,
  });
  equal("valid canceled token with exp = min(iat+72h, pexp) verifies", resCanceled.ok, true);
  equal("canceled token state", resCanceled.claims?.st, "canceled");

  const graceToken = signCompact(
    validHeader(),
    validPayload({
      st: "grace",
      pexp: baseIat + 40_000,
      exp: Math.min(baseIat + 86_400, baseIat + 40_000),
    }),
    signer.privateKey,
  );
  const resGrace = verifyToken(graceToken, {
    keys: [signer.entry],
    installationId: localInstallationId,
  });
  equal("valid grace token with exp = min(iat+24h, pexp) verifies", resGrace.ok, true);
  equal("grace token state", resGrace.claims?.st, "grace");

  const inactiveToken = signCompact(
    validHeader(),
    validPayload({
      st: "inactive",
      ent: [],
      rsn: "expired",
      pexp: baseIat - 100,
      exp: baseIat + 86_400,
    }),
    signer.privateKey,
  );
  const resInactive = verifyToken(inactiveToken, {
    keys: [signer.entry],
    installationId: localInstallationId,
  });
  equal("valid inactive token with exp = iat + 24h verifies", resInactive.ok, true);
  equal("inactive token reason", resInactive.claims?.rsn, "expired");
}

section("verifyToken rejections: keys, signature, header, claims, sub, seq, exp, size");

{
  const good = signCompact(validHeader(), validPayload(), signer.privateKey);

  const emptyKeys = verifyToken(good, {
    keys: [],
    installationId: localInstallationId,
  });
  equal("empty TRUSTED_KEYS rejects", emptyKeys.ok, false);
  equal("empty TRUSTED_KEYS reason", emptyKeys.reason, "unknown_kid");

  const defaultKeys = verifyToken(good, {
    installationId: localInstallationId,
  });
  equal("default shipped TRUSTED_KEYS rejects", defaultKeys.ok, false);
  equal("default shipped TRUSTED_KEYS reason", defaultKeys.reason, "unknown_kid");

  const unknownKid = verifyToken(good, {
    keys: [otherSigner.entry],
    installationId: localInstallationId,
  });
  equal("unknown kid rejects", unknownKid.ok, false);
  equal("unknown kid reason", unknownKid.reason, "unknown_kid");

  const wrongKeySig = signCompact(
    validHeader({ kid: signer.keyId }),
    validPayload(),
    otherSigner.privateKey,
  );
  const badSig = verifyToken(wrongKeySig, {
    keys: [signer.entry],
    installationId: localInstallationId,
  });
  equal("signature by wrong key rejects", badSig.ok, false);
  equal("signature by wrong key reason", badSig.reason, "bad_signature");

  const parts = good.split(".");
  const tamperedPayload = Buffer.from(JSON.stringify(validPayload({ seq: 99 })), "utf8").toString(
    "base64url",
  );
  const tampered = verifyToken(`${parts[0]}.${tamperedPayload}.${parts[2]}`, {
    keys: [signer.entry],
    installationId: localInstallationId,
  });
  equal("tampered payload rejects with bad_signature", tampered.reason, "bad_signature");

  const wrongAlg = signCompact(validHeader({ alg: "HS256" }), validPayload(), signer.privateKey);
  equal(
    "wrong alg rejects",
    verifyToken(wrongAlg, { keys: [signer.entry], installationId: localInstallationId }).reason,
    "bad_header",
  );

  const wrongTyp = signCompact(validHeader({ typ: "JWT" }), validPayload(), signer.privateKey);
  equal(
    "wrong typ rejects",
    verifyToken(wrongTyp, { keys: [signer.entry], installationId: localInstallationId }).reason,
    "bad_header",
  );

  const wrongAud = signCompact(
    validHeader(),
    validPayload({ aud: "other-aud" }),
    signer.privateKey,
  );
  equal(
    "wrong aud rejects",
    verifyToken(wrongAud, { keys: [signer.entry], installationId: localInstallationId }).reason,
    "bad_aud",
  );

  const wrongIss = signCompact(
    validHeader(),
    validPayload({ iss: "other-iss" }),
    signer.privateKey,
  );
  equal(
    "wrong iss rejects",
    verifyToken(wrongIss, { keys: [signer.entry], installationId: localInstallationId }).reason,
    "bad_iss",
  );

  const otherSub = crypto.createHash("sha256").update(Buffer.alloc(32, 9)).digest("base64url");
  const wrongSub = signCompact(validHeader(), validPayload({ sub: otherSub }), signer.privateKey);
  const resWrongSub = verifyToken(wrongSub, {
    keys: [signer.entry],
    installationId: localInstallationId,
  });
  equal("token for another installation rejects", resWrongSub.ok, false);
  equal("wrong sub reason", resWrongSub.reason, "bad_sub");

  const lowerSeq = signCompact(
    validHeader(),
    validPayload({ seq: 4, jti: makeJti(2) }),
    signer.privateKey,
  );
  const resLowerSeq = verifyToken(lowerSeq, {
    keys: [signer.entry],
    installationId: localInstallationId,
    storedSeq: 5,
    storedJti: makeJti(1),
  });
  equal("lower seq rejects as replay", resLowerSeq.ok, false);
  equal("lower seq reason", resLowerSeq.reason, "replay");

  const equalSeqDiffJti = signCompact(
    validHeader(),
    validPayload({ seq: 5, jti: makeJti(2) }),
    signer.privateKey,
  );
  const resEqualDiff = verifyToken(equalSeqDiffJti, {
    keys: [signer.entry],
    installationId: localInstallationId,
    storedSeq: 5,
    storedJti: makeJti(1),
  });
  equal("equal seq with different jti rejects as replay", resEqualDiff.ok, false);
  equal("equal seq different jti reason", resEqualDiff.reason, "replay");

  const equalSeqSameJti = signCompact(
    validHeader(),
    validPayload({ seq: 5, jti: makeJti(1) }),
    signer.privateKey,
  );
  const resEqualSame = verifyToken(equalSeqSameJti, {
    keys: [signer.entry],
    installationId: localInstallationId,
    storedSeq: 5,
    storedJti: makeJti(1),
  });
  equal("equal seq with identical jti is accepted", resEqualSame.ok, true);

  const over72h = signCompact(
    validHeader(),
    validPayload({ exp: baseIat + 259_201 }),
    signer.privateKey,
  );
  equal(
    "exp - iat > 72h rejects",
    verifyToken(over72h, { keys: [signer.entry], installationId: localInstallationId }).reason,
    "bad_exp",
  );

  const graceOver24h = signCompact(
    validHeader(),
    validPayload({ st: "grace", exp: baseIat + 86_401 }),
    signer.privateKey,
  );
  equal(
    "grace exp - iat > 24h rejects",
    verifyToken(graceOver24h, { keys: [signer.entry], installationId: localInstallationId }).reason,
    "bad_exp",
  );

  const canceledPastPexp = signCompact(
    validHeader(),
    validPayload({ st: "canceled", pexp: baseIat + 3600, exp: baseIat + 3601 }),
    signer.privateKey,
  );
  equal(
    "canceled exp > pexp rejects",
    verifyToken(canceledPastPexp, { keys: [signer.entry], installationId: localInstallationId })
      .reason,
    "bad_exp",
  );

  const expNotAfterIat = signCompact(
    validHeader(),
    validPayload({ exp: baseIat }),
    signer.privateKey,
  );
  equal(
    "exp == iat rejects",
    verifyToken(expNotAfterIat, { keys: [signer.entry], installationId: localInstallationId })
      .reason,
    "bad_exp",
  );

  const oversized = "a".repeat(MAX_TOKEN_BYTES + 1);
  equal(
    "oversized token > 4096 bytes rejects",
    verifyToken(oversized, { keys: [signer.entry], installationId: localInstallationId }).reason,
    "oversized",
  );
}

finish();

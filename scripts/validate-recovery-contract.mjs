// Exercise this client against the production relay implementation, with real
// temporary SQLite stores and fake SMTP. No HTTP socket or email is used.
// Requires a clean levix-ui checkout at PRODUCTION_REVISION and its dependencies.
//   npm run validate:recovery -- [path/to/levix-ui]

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PRODUCTION_REVISION = "5c77ee460750f65776172d582fd705612305038e";
const script = fileURLToPath(import.meta.url);
const root = resolve(dirname(script), "..");
const worker = process.argv[2] === "--isolated-worker";
const sibling = resolve(worker ? process.argv[3] : process.argv[2] || join(root, "../levix-ui"));

if (!worker) {
  const revision = spawnSync("git", ["-C", sibling, "rev-parse", "HEAD"], { encoding: "utf8" });
  assert.equal(
    revision.stdout?.trim(),
    PRODUCTION_REVISION,
    "The relay checkout must be at the documented production revision",
  );
  for (const args of [
    ["diff", "--quiet"],
    ["diff", "--cached", "--quiet"],
  ]) {
    const clean = spawnSync("git", ["-C", sibling, ...args]);
    assert.equal(clean.status, 0, "The relay checkout must have no tracked modifications");
  }
  const work = mkdtempSync(join(tmpdir(), "levix-recovery-contract-"));
  try {
    // Close every database/log handle before deleting files, including Windows.
    const result = spawnSync(
      process.execPath,
      [...process.execArgv, script, "--isolated-worker", sibling, work],
      {
        stdio: "inherit",
        env: { ...process.env, LEVIX_DATA_DIR: join(work, "client") },
        timeout: 60_000,
      },
    );
    assert.equal(result.status, 0, "Production recovery contract validation failed");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
} else {
  await validate(process.argv[4]);
}

async function validate(work) {
  const require = createRequire(join(root, "package.json"));
  const { handleRecoveryRequest } = await import(
    pathToFileURL(join(sibling, "src/lib/recovery-relay.ts"))
  );
  const { createRecoveryStore } = await import(
    pathToFileURL(join(sibling, "src/lib/recovery-store.ts"))
  );
  const { TOKEN_TTL_MS } = await import(pathToFileURL(join(sibling, "src/lib/recovery-email.ts")));
  const relayStore = createRecoveryStore(join(work, "relay"));
  const mailed = [];
  let clock = Date.now();
  let failSmtp = false;
  let ip = 1;
  const deps = {
    env: {
      SMTP_HOST: "smtp.invalid",
      SMTP_PORT: "587",
      SMTP_USER: "test",
      SMTP_PASS: "test",
      SMTP_FROM: "test@example.com",
      RECOVERY_SECRET: "isolated-test-secret-never-production-123456789",
    },
    store: () => relayStore,
    createTransport: () => ({
      async sendMail(message) {
        if (failSmtp) throw new Error("Isolated SMTP unavailable");
        mailed.push(message);
      },
    }),
    now: () => clock,
  };
  const isolatedUrl = "http://isolated-relay.invalid/api/recovery-email";
  process.env.LEVIX_RECOVERY_URL = isolatedUrl;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, isolatedUrl, "No external HTTP request is permitted");
    return handleRecoveryRequest(
      new Request(url, {
        ...options,
        headers: { ...options.headers, "x-forwarded-for": `192.0.2.${ip++}` },
      }),
      deps,
    );
  };
  require("./src/utils/logger.cjs").level = "silent";
  const recovery = require("./src/panel/recovery-email.cjs");
  const reset = require("./src/panel/password-reset.cjs");
  const secrets = require("./src/config/secrets.cjs");
  const password = "proof-original-password";
  const nextPassword = "proof-replacement-password";
  const owner = "owner@example.com";

  function code() {
    const match = /\b\d{6}\b/.exec(mailed.at(-1)?.text || "");
    assert.ok(match, "Fake SMTP receives a six-digit code");
    return match[0];
  }

  async function verify() {
    recovery._resetForTests();
    assert.equal((await recovery.startVerification(owner, "ar", "proof")).ok, true);
    const correct = code();
    const wrong = correct === "000000" ? "000001" : "000000";
    const bad = await recovery.confirmVerification(wrong);
    assert.equal(bad.reason, "wrong_code");
    assert.equal(bad.attemptsLeft, 4);
    assert.equal((await recovery.confirmVerification(correct)).ok, true);
  }

  async function resetEmail() {
    reset._resetForTests();
    return reset.requestResetCode("proof", { channel: "email", lang: "en" });
  }

  async function relay(body) {
    return handleRecoveryRequest(
      new Request(isolatedUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${ip++}` },
        body: JSON.stringify(body),
      }),
      deps,
    );
  }

  try {
    secrets.setDashboardPassword(password);
    await verify();
    const firstRecord = secrets.getRecoveryRecord();
    const sealed = require("./src/db/store.cjs").getBotSetting("auth:recovery-email");
    assert.ok(
      typeof sealed === "string" && sealed.startsWith("enc:v1:"),
      "Recovery record is sealed",
    );
    assert.ok(
      !sealed.includes(owner) && !sealed.includes(firstRecord.token),
      "Sealed record hides credentials",
    );
    assert.ok(/^v1\.[A-Za-z0-9_-]{43}$/.test(firstRecord.token), "Token uses the expected format");
    assert.equal((await recovery.confirmVerification(code())).reason, "no_pending");
    assert.equal((await resetEmail()).ok, true);
    const firstResetCode = code();
    const epoch = secrets.getPasswordUpdatedAt();
    assert.equal(reset.completeReset(firstResetCode, nextPassword, nextPassword).ok, true);
    assert.equal(secrets.verifyDashboardPassword(nextPassword), true);
    assert.ok(secrets.getPasswordUpdatedAt() > epoch);
    assert.equal(
      reset.completeReset(firstResetCode, nextPassword, nextPassword).reason,
      "no_pending",
    );
    console.log(
      "PASS verification, attempts, sealed token, reset completion, session epoch, single use",
    );

    // Compare inside the child so credentials can never appear in test output.
    const restarted = spawnSync(
      process.execPath,
      [
        "-e",
        `const s=require(${JSON.stringify(join(root, "src/config/secrets.cjs"))});
         const r=s.getRecoveryRecord();
         if(!r?.token||r.email!==${JSON.stringify(owner)}||r.needsVerification)process.exit(1);`,
      ],
      { env: process.env, encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(restarted.status, 0, "A fresh Node process restores the authorization");
    console.log("PASS address/token persistence after an application restart");

    const day = 24 * 60 * 60 * 1000;
    for (let i = 0; i < 2; i += 1) {
      clock += TOKEN_TTL_MS - day;
      assert.equal((await resetEmail()).ok, true);
      assert.ok(
        secrets.getRecoveryRecord().token === firstRecord.token,
        "Renewal retains the token",
      );
    }
    console.log("PASS token renewal across two nearly year-long intervals");
    clock += TOKEN_TTL_MS + 1;
    assert.equal((await resetEmail()).reason, "unverified");
    assert.equal(recovery.publicStatus().needsVerification, true);
    console.log("PASS inactive token expiration requests re-verification");

    await verify();
    const secondRecord = secrets.getRecoveryRecord();
    assert.ok(secondRecord.token !== firstRecord.token, "Re-verification replaces authorization");
    // A second installation proves ownership of the same inbox directly.
    const started = await relay({ kind: "verify", to: owner, lang: "en" });
    assert.equal(started.status, 200);
    const { verification } = await started.json();
    const confirmed = await relay({ kind: "confirm", verification, code: code() });
    assert.equal(confirmed.status, 200);
    assert.ok(
      (await confirmed.json()).token !== secondRecord.token,
      "The second token is different",
    );
    assert.equal((await resetEmail()).reason, "unverified");
    assert.equal(recovery.publicStatus().needsVerification, true);
    console.log("PASS second-installation verification revokes the first installation's token");

    await verify();
    const stable = secrets.getRecoveryRecord();
    failSmtp = true;
    assert.equal((await resetEmail()).reason, "unavailable");
    assert.ok(secrets.getRecoveryRecord().token === stable.token, "An outage retains the token");
    assert.equal(recovery.publicStatus().verified, true);
    console.log("PASS SMTP outage preserves saved authorization");
  } finally {
    globalThis.fetch = realFetch;
    relayStore.close();
    require("./src/db/db.cjs").close();
  }
}

// Malformed JSON to Plus claim route and shared dashboard routes must never
// leak raw body or SyntaxError excerpts into operational logs.
// Also verifies stopExtensions stops both host and entitlement during shutdown.

import fs from "node:fs";
import path from "node:path";
import { equal, finish, httpClient, ok, require, section, useTempDataDir } from "./harness.mjs";

const dataDir = useTempDataDir("levix-plus-malformed");

const store = require("./src/db/store.cjs");
const entitlement = require("./src/extensions/entitlement/index.cjs");
const { bootstrapCore } = await import("../src/bootstrap/core.js");
const { bootstrapPanel } = await import("../src/bootstrap/panel.js");

// Ephemeral port to avoid conflicts
store.saveBotSetting("setting:port", 0);

let entitlementStopped = false;
const origEntStop = entitlement.stop;
entitlement.stop = () => {
  entitlementStopped = true;
  return origEntStop();
};

let core;
let panel;

try {
  core = await bootstrapCore({ autoStart: false });
  panel = await bootstrapPanel({ core });

  const boundPort = panel.server.address().port;
  const base = `http://127.0.0.1:${boundPort}`;
  const http = httpClient(base);

  section("panel claim and authenticated session");
  const setupRes = await http.form("/setup", {
    password: "test-admin-password-42",
    confirm: "test-admin-password-42",
  });
  equal("panel setup signs in", setupRes.status, 303);

  section("POST malformed JSON to /dashboard/api/plus/claim");
  const purchaseSecret = "SUPER_SECRET_PURCHASE_TOKEN_xyz98765";
  const malformedClaim = `{"purchaseToken": "${purchaseSecret}", broken json`;

  const claimRes = await http.call("/dashboard/api/plus/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: malformedClaim,
  });

  equal("claim route status is 400", claimRes.status, 400);
  const claimBody = await claimRes.json();
  equal("claim response ok is false", claimBody.ok, false);
  equal("claim response code is BAD_REQUEST", claimBody.code, "BAD_REQUEST");

  const combinedLog = path.join(dataDir, "logs", "combined.log");
  const errorLog = path.join(dataDir, "logs", "error.log");
  const combined1 = fs.existsSync(combinedLog) ? fs.readFileSync(combinedLog, "utf8") : "";
  const error1 = fs.existsSync(errorLog) ? fs.readFileSync(errorLog, "utf8") : "";

  ok("combined.log does not leak claim purchase token", !combined1.includes(purchaseSecret));
  ok("error.log does not leak claim purchase token", !error1.includes(purchaseSecret));

  section("POST malformed JSON to shared parser route (/dashboard/api/settings)");
  const otherSecret = "SECRET_PAYLOAD_TOKEN_abc12345";
  const malformedOther = `{"key": "${otherSecret}", invalid syntax`;

  const otherRes = await http.call("/dashboard/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: malformedOther,
  });

  equal("shared parser error status is 400", otherRes.status, 400);

  const combined2 = fs.existsSync(combinedLog) ? fs.readFileSync(combinedLog, "utf8") : "";
  const error2 = fs.existsSync(errorLog) ? fs.readFileSync(errorLog, "utf8") : "";

  ok("combined.log does not leak general malformed body", !combined2.includes(otherSecret));
  ok("error.log does not leak general malformed body", !error2.includes(otherSecret));

  section("stopExtensions stops the host and disarms entitlement timers");
  await core.stopExtensions();
  ok("entitlement.stop() called during stopExtensions", entitlementStopped);
} finally {
  entitlement.stop = origEntStop;
  if (core?.stopRemoteTerms) core.stopRemoteTerms();
  require("./scheduler.cjs").stopAllScheduledJobs();
  if (panel?.server) {
    await new Promise((resolve) => panel.server.close(resolve));
  }
}

finish();

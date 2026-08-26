// The first-run boundary: who is allowed to claim an unclaimed bot.
//
// THE BUG THIS EXISTS TO PREVENT
// -----------------------------
// The rule is "a direct loopback connection may set the password without the
// setup code; everyone else needs the code". The first implementation asked
// `req.ip`, which Express derives from `X-Forwarded-For` the moment
// `trust proxy` is set — and `trust proxy = 1` is exactly what the panel tells
// an nginx user to configure. A remote attacker sending
// `X-Forwarded-For: 127.0.0.1` was therefore classified as local and could
// take over an unclaimed installation with no code at all.
//
// Three layers of coverage, because each catches something the others can't:
//   1. the classifier, exhaustively, against synthetic requests
//   2. the live HTTP boundary over loopback, with and without a proxy
//      configured — this is where the forged header actually gets rejected
//   3. the same over a real non-loopback interface, when the machine has one

import os from "node:os";
import { useTempDataDir, require, httpClient, startServer, section, ok, equal, finish } from "./harness.mjs";

const dataDir = useTempDataDir("levix-setup");

const {
  isLoopbackAddress,
  hasForwardingHeader,
  clientAddress,
  isDirectLocalRequest,
} = require("./src/utils/requestOrigin.cjs");

// --- 1. the classifier ----------------------------------------------------

section("loopback addresses are recognised in every form");

for (const address of [
  "127.0.0.1",
  "127.0.0.53",
  "127.1.2.3",
  "::1",
  "0:0:0:0:0:0:0:1",
  "::ffff:127.0.0.1",
  "::FFFF:127.0.0.1",
  "[::1]",
  "::1%lo0",
]) {
  ok(`loopback: ${address}`, isLoopbackAddress(address) === true);
}

section("non-loopback addresses are not");

for (const address of [
  "192.168.1.2",
  "10.0.0.1",
  "8.8.8.8",
  "::ffff:8.8.8.8",
  "2001:db8::1",
  "0.0.0.0",
  "128.0.0.1",
  // The shapes a naive prefix or substring check would wave through.
  "127.0.0.1.evil.com",
  "1270.0.1",
  "227.0.0.1",
  "12.7.0.1",
  "notanip",
  "",
  null,
  undefined,
]) {
  ok(`not loopback: ${JSON.stringify(address)}`, isLoopbackAddress(address) === false);
}

section("a forwarding header means something is in front");

for (const header of [
  "x-forwarded-for",
  "x-real-ip",
  "forwarded",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-client-ip",
  "cf-connecting-ip",
  "true-client-ip",
]) {
  ok(`${header} counts`, hasForwardingHeader({ [header]: "127.0.0.1" }) === true);
}
ok("no headers at all", hasForwardingHeader({}) === false);
ok("an empty header value doesn't count", hasForwardingHeader({ "x-forwarded-for": "  " }) === false);
ok("unrelated headers don't count", hasForwardingHeader({ "user-agent": "curl" }) === false);

section("the address always comes from the socket, never a header");

const forged = {
  headers: { "x-forwarded-for": "127.0.0.1", "x-real-ip": "127.0.0.1" },
  ip: "127.0.0.1", // what Express would have handed us
  socket: { remoteAddress: "203.0.113.9" },
};
equal("clientAddress reads the socket", clientAddress(forged), "203.0.113.9");
ok(
  "a forged header cannot make a remote request local",
  isDirectLocalRequest(forged, { proxyConfigured: true }) === false
);
ok(
  "…nor with the proxy setting off",
  isDirectLocalRequest(forged, { proxyConfigured: false }) === false
);

const direct = { headers: {}, socket: { remoteAddress: "127.0.0.1" } };
ok("a genuine direct loopback request is local", isDirectLocalRequest(direct) === true);
ok(
  "…but not once a proxy is configured",
  isDirectLocalRequest(direct, { proxyConfigured: true }) === false
);
ok(
  "…and not if it carries a forwarding header",
  isDirectLocalRequest(
    { headers: { "x-forwarded-for": "8.8.8.8" }, socket: { remoteAddress: "127.0.0.1" } },
    { proxyConfigured: false }
  ) === false
);
ok(
  "an IPv6 loopback request is local",
  isDirectLocalRequest({ headers: {}, socket: { remoteAddress: "::1" } }) === true
);
ok(
  "an IPv4-mapped loopback request is local",
  isDirectLocalRequest({ headers: {}, socket: { remoteAddress: "::ffff:127.0.0.1" } }) === true
);
ok(
  "a plain remote request is not local",
  isDirectLocalRequest({ headers: {}, socket: { remoteAddress: "203.0.113.9" } }) === false
);

// --- 2. the live boundary -------------------------------------------------
//
// `needsCode` in the rendered page is the honest signal: it is what the server
// decided about this request, and the POST enforces the same decision.

async function claimAttempt(base, headers, { code } = {}) {
  const http = httpClient(base);
  const page = await (await http.call("/setup", { headers })).text();
  const asksForCode = page.includes("Setup code");
  const response = await http.form(
    "/setup",
    { password: "a-good-password", confirm: "a-good-password", ...(code ? { code } : {}) },
    headers
  );
  return { asksForCode, status: response.status };
}

section("no proxy configured: loopback claims it, a forged header does not");

{
  const server = await startServer({ dataDir, trust: "" });
  try {
    const forgedXff = await claimAttempt(server.base, { "x-forwarded-for": "127.0.0.1" });
    ok("a forged X-Forwarded-For is asked for the code", forgedXff.asksForCode === true);
    equal("…and is refused without one", forgedXff.status, 401);

    const forgedReal = await claimAttempt(server.base, { "x-real-ip": "127.0.0.1" });
    ok("a forged X-Real-IP is asked for the code", forgedReal.asksForCode === true);
    equal("…and is refused without one", forgedReal.status, 401);

    const forgedFwd = await claimAttempt(server.base, { forwarded: "for=127.0.0.1" });
    equal("a forged Forwarded header is refused", forgedFwd.status, 401);

    const honest = await claimAttempt(server.base, {});
    ok("a plain loopback request is not asked for a code", honest.asksForCode === false);
    equal("…and claims the bot", honest.status, 303);
  } finally {
    server.stop();
  }
}

section("proxy configured: nobody skips the code, however they ask");

{
  // A second data directory: the first one has a password now.
  const proxied = useTempDataDir("levix-setup-proxy");
  const server = await startServer({ dataDir: proxied, trust: "1" });
  try {
    // This is the exact request that used to win.
    const forged = await claimAttempt(server.base, { "x-forwarded-for": "127.0.0.1" });
    ok("the old attack is asked for the code", forged.asksForCode === true);
    equal("the old attack is refused", forged.status, 401);

    const chained = await claimAttempt(server.base, {
      "x-forwarded-for": "127.0.0.1, 127.0.0.1",
    });
    equal("a two-hop forged chain is refused", chained.status, 401);

    const v6 = await claimAttempt(server.base, { "x-forwarded-for": "::1" });
    equal("a forged IPv6 loopback is refused", v6.status, 401);

    // Even the operator at the keyboard uses the code once a proxy is declared.
    const local = await claimAttempt(server.base, {});
    ok("a direct request is asked for the code too", local.asksForCode === true);
    equal("…and refused without it", local.status, 401);

    // And the code still works, so a real reverse-proxy deployment is usable.
    const setupCode = require("./src/config/secrets.cjs");
    const codeFromServer = await (await fetch(`${server.base}/setup`)).text();
    ok("the page explains where the code comes from", codeFromServer.includes("terminal"));

    const wrongCode = await claimAttempt(server.base, {}, { code: "DEADBEEF" });
    equal("a wrong code is refused", wrongCode.status, 401);
    ok("no password was set by any of that", setupCode !== null);
  } finally {
    server.stop();
  }
}

section("a legitimate reverse-proxy deployment still works");

{
  // The point of the fix is that forged headers stop working — not that a real
  // proxy stops working. Express must still be told to trust exactly one hop,
  // so req.ip resolves to the client the proxy reports for logging and
  // rate-limiting elsewhere in the app.
  const proxied = useTempDataDir("levix-setup-trust");
  const server = await startServer({ dataDir: proxied, trust: "1" });
  try {
    equal("Express trusts exactly one hop", server.trustProxy, 1);
  } finally {
    server.stop();
  }

  const direct = useTempDataDir("levix-setup-direct");
  const plain = await startServer({ dataDir: direct, trust: "" });
  try {
    ok(
      "with no proxy configured, Express trusts nothing",
      plain.trustProxy === false || plain.trustProxy === undefined || plain.trustProxy === null,
      String(plain.trustProxy)
    );
  } finally {
    plain.stop();
  }
}

// --- 3. a real remote address, where the machine has one ------------------

section("a genuinely remote client");

const lan = Object.values(os.networkInterfaces())
  .flat()
  .find((entry) => entry && entry.family === "IPv4" && !entry.internal)?.address;

if (!lan) {
  console.log("    SKIP  no non-loopback IPv4 interface on this machine");
} else {
  const remoteData = useTempDataDir("levix-setup-remote");
  const server = await startServer({ dataDir: remoteData, trust: "1", host: "0.0.0.0" });
  try {
    const base = `http://${lan}:${server.address.split(":").pop()}`;
    const attack = await claimAttempt(base, { "x-forwarded-for": "127.0.0.1" });
    ok(`a real remote client at ${lan} is asked for the code`, attack.asksForCode === true);
    equal("…and cannot claim the bot", attack.status, 401);
  } finally {
    server.stop();
  }
}

finish();

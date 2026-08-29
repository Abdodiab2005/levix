// The control panel, end to end, against a real database.
//
// Everything up to the pairing boundary: first run, password, session, the
// dashboard API, the recovery paths through the UI. WhatsApp itself is NOT
// exercised here — no socket is opened — so a green run here means "the panel
// works", not "pairing works". Pairing is verified by hand and by
// scripts/validate-sea.mjs starting a real process.

import { useTempDataDir, httpClient, startServer, section, ok, equal, finish } from "./harness.mjs";

const dataDir = useTempDataDir("levix-panel");
const server = await startServer({ dataDir, trust: "", routes: true });
const http = httpClient(server.base);

try {
  section("first run: there is nothing to log into yet");

  let res = await http.call("/");
  ok("the root redirects to setup", res.status === 302 && res.headers.get("location") === "/setup");

  res = await http.call("/setup");
  equal("the setup page renders", res.status, 200);
  ok("a local first run is not asked for a code", !(await res.text()).includes("Setup code"));

  res = await http.call("/dashboard/api/stats");
  equal("the API is locked before there is a password", res.status, 401);

  section("browser origin boundary");

  res = await http.form(
    "/setup",
    { password: "a-good-password", confirm: "different-one" },
    { origin: "null", "sec-fetch-site": "same-origin" },
  );
  equal("Chrome's same-origin Origin:null form reaches validation", res.status, 400);

  res = await http.form(
    "/setup",
    { password: "a-good-password", confirm: "different-one" },
    { origin: "null", "sec-fetch-site": "cross-site" },
  );
  equal("Origin:null from a cross-site navigation is rejected", res.status, 403);

  res = await http.form(
    "/setup",
    { password: "a-good-password", confirm: "different-one" },
    { origin: server.base },
  );
  equal("an exact same-origin Origin header reaches validation", res.status, 400);

  res = await http.form(
    "/setup",
    { password: "a-good-password", confirm: "different-one" },
    { origin: "https://example.invalid", "sec-fetch-site": "cross-site" },
  );
  equal("a foreign browser origin is rejected", res.status, 403);

  section("password validation");

  res = await http.form("/setup", { password: "short", confirm: "short" });
  equal("a short password is refused", res.status, 400);

  res = await http.form("/setup", { password: "a-good-password", confirm: "different-one" });
  equal("a mismatched confirmation is refused", res.status, 400);

  res = await http.form("/setup", { password: "a-good-password", confirm: "a-good-password" });
  equal("a good password is accepted and signs us in", res.status, 303);

  res = await http.call("/setup");
  ok("setup closes once claimed", res.status === 302 && res.headers.get("location") === "/");

  section("signed in");

  res = await http.call("/dashboard/api/stats");
  const { stats, success } = await res.json();
  ok("stats answer", res.status === 200 && success);
  ok("counters are numbers", typeof stats.totalGroups === "number");
  ok("every command is loaded", stats.commandCount > 30);
  ok("the data directory is reported", typeof stats.dataDir === "string");

  const { commands } = await (await http.call("/dashboard/api/commands")).json();
  ok("the command catalog is served", commands.length > 30);

  const { settings } = await (await http.call("/dashboard/api/settings")).json();
  ok("settings are listed", settings.length > 10);
  ok("the removed REST API key is gone", !settings.some((s) => s.key === "secret_api_key"));
  ok(
    "the port is marked restart-required",
    settings.some((s) => s.key === "port" && s.restart === true)
  );
  ok("no setting still claims to come from .env", !settings.some((s) => s.source === "env"));

  res = await http.json("/dashboard/api/settings", { key: "gemini_model", value: "gemini-x" }, "PATCH");
  equal("a setting can be changed", res.status, 200);

  ok("schedules are listed", (await (await http.call("/dashboard/api/schedules")).json()).success);

  section("changing the panel password");

  res = await http.json("/dashboard/api/security/password", {
    current: "wrong",
    next: "another-good-one",
  });
  equal("the wrong current password is refused", res.status, 401);

  res = await http.json("/dashboard/api/security/password", {
    current: "a-good-password",
    next: "tiny",
  });
  equal("a short new password is refused", res.status, 400);

  res = await http.json("/dashboard/api/security/password", {
    current: "a-good-password",
    next: "another-good-one",
  });
  equal("the password changes", res.status, 200);

  section("sessions");

  equal("logout succeeds", (await http.call("/logout", { method: "POST" })).status, 303);
  equal("the API is locked again", (await http.call("/dashboard/api/stats")).status, 401);

  equal("the old password no longer works", (await http.form("/login", { password: "a-good-password" })).status, 401);
  equal("the new password does", (await http.form("/login", { password: "another-good-one" })).status, 303);
  equal("the QR page is reachable", (await http.call("/qr")).status, 200);

  section("guessing is throttled");

  for (let i = 0; i < 6; i += 1) await http.form("/login", { password: "nope" });
  equal(
    "the right password is refused once the limit is hit",
    (await http.form("/login", { password: "another-good-one" })).status,
    429
  );

  section("everything else");

  equal("an unknown path is a JSON 404", (await http.call("/nothing-here")).status, 404);
} finally {
  server.stop();
}

finish();

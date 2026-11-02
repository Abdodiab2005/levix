import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { join } from "node:path";
import { equal, finish, httpClient, ok, section, startServer, useTempDataDir } from "./harness.mjs";

const dataDir = useTempDataDir("levix-legal-panel");
const require = createRequire(import.meta.url);
const { documentFor, LINKS } = require("../src/legal/terms.cjs");
const server = await startServer({ dataDir, trust: "", routes: true });
const http = httpClient(server.base);
const expected = documentFor("en");
const valid = { version: expected.version, sha256: expected.sha256, locale: "en" };

function acceptanceRow() {
  const db = new DatabaseSync(join(dataDir, "levix.db"), { readOnly: true });
  try {
    const row = db.prepare("SELECT value FROM bot_settings WHERE key = ?").get("legal:acceptance");
    return row ? JSON.parse(row.value) : null;
  } finally {
    db.close();
  }
}

try {
  section("panel authentication and origin checks");
  let res = await http.call("/dashboard/api/legal/terms");
  equal("GET requires login", res.status, 401);
  res = await http.json("/dashboard/api/legal/accept", valid);
  equal("POST requires login", res.status, 401);

  res = await http.form("/setup", { password: "a-good-password", confirm: "a-good-password" });
  equal("setup signs in", res.status, 303);

  for (const origin of ["https://foreign.example", "null"]) {
    res = await http.call("/dashboard/api/legal/accept", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify(valid),
    });
    equal(`${origin} is refused`, res.status, 403);
  }
  equal("origin refusals wrote nothing", acceptanceRow(), null);

  section("document and locale fallback");
  res = await http.call("/dashboard/api/legal/terms?locale=en");
  equal("GET succeeds", res.status, 200);
  const english = await res.json();
  equal("English locale", english.locale, "en");
  equal("requested locale", english.requestedLocale, "en");
  equal("English hash", english.sha256, expected.sha256);
  equal("English Terms", JSON.stringify(english.terms), JSON.stringify(expected.document.terms));
  equal("English Privacy", JSON.stringify(english.privacy), JSON.stringify(expected.document.privacy));
  equal("links are code owned", JSON.stringify(english.links), JSON.stringify(LINKS));
  equal("consent starts invalid", english.consent.ok, false);
  equal("nothing accepted yet", english.consent.accepted, null);

  res = await http.call("/dashboard/api/legal/terms?locale=xx");
  const fallback = await res.json();
  equal("unknown locale falls back", fallback.locale, "en");
  equal("unknown request is reported", fallback.requestedLocale, "xx");

  section("acceptance validates current bytes");
  res = await http.json("/dashboard/api/legal/accept", { ...valid, sha256: "0".repeat(64) });
  equal("wrong hash is conflict", res.status, 409);
  const changed = await res.json();
  equal("conflict code", changed.code, "TERMS_CHANGED");
  equal("conflict returns current hash", changed.sha256, expected.sha256);
  equal(
    "conflict returns current Terms",
    JSON.stringify(changed.terms),
    JSON.stringify(expected.document.terms),
  );
  equal("wrong hash wrote nothing", acceptanceRow(), null);

  res = await http.json("/dashboard/api/legal/accept", { version: valid.version, locale: "en" });
  equal("missing hash is bad request", res.status, 400);
  res = await http.json("/dashboard/api/legal/accept", { ...valid, locale: "xx" });
  equal("unknown locale is bad request", res.status, 400);

  res = await http.json("/dashboard/api/legal/accept", valid);
  equal("current document is accepted", res.status, 200);
  const accepted = await res.json();
  equal("success is reported", accepted.success, true);
  ok("session state is returned", accepted.session && typeof accepted.session.state === "string");
  const stored = acceptanceRow();
  equal("stored channel is panel", stored.via, "panel");
  equal("stored hash is current", stored.sha256, expected.sha256);

  res = await http.call("/dashboard/api/legal/terms?locale=en");
  const after = await res.json();
  equal("consent is valid", after.consent.ok, true);
  equal("accepted version is returned", after.consent.accepted.termsVersion, expected.version);
  ok("GET does not expose via", !("via" in after.consent.accepted));
} finally {
  await server.stop();
}

finish();

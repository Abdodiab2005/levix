// Real authenticated panel routes, with isolated storage and no WhatsApp/network.
import { join } from "node:path";
import { equal, ok, finish, startServer, httpClient, useTempDataDir, ROOT } from "./harness.mjs";
// Keep the fixture offline even when this file is run directly, outside run.mjs.
const previousOptions = process.env.NODE_OPTIONS;
process.env.NODE_OPTIONS = `${previousOptions || ""} --require=${JSON.stringify(join(ROOT, "tests/fixtures/no-external-network.cjs"))}`;
const dataDir = useTempDataDir("levix-update-panel");
const server = await startServer({ dataDir, routes: true });
const http = httpClient(server.base);
try {
  equal("metadata needs login", (await http.call("/dashboard/api/updates")).status, 401);
  equal(
    "check needs login",
    (await http.call("/dashboard/api/updates/check", { method: "POST" })).status,
    401,
  );
  await http.form(
    "/setup",
    { password: "isolated-update-password", confirm: "isolated-update-password" },
    { origin: server.base },
  );
  const meta = await http.call("/dashboard/api/updates");
  equal("metadata available after setup", meta.status, 200);
  const body = await meta.json();
  equal("reading About does not check", body.update.status, "idle");
  equal("desktop channel github", body.update.channel, "github");
  ok("only official links returned", body.links.docs === "https://levix.leviro.net/docs");
  equal(
    "foreign origin cannot trigger check",
    (
      await http.call("/dashboard/api/updates/check", {
        method: "POST",
        headers: { Origin: "https://attacker.example", "Content-Type": "application/json" },
        body: "{}",
      })
    ).status,
    403,
  );
  // tests/run.mjs preloads no-external-network.cjs; this explicit action fails
  // safely offline and cannot contact the public GitHub API.
  const check = await http.call("/dashboard/api/updates/check", {
    method: "POST",
    headers: { Origin: server.base, "Content-Type": "application/json" },
    body: "{}",
  });
  equal("offline check is nonfatal", check.status, 200);
  const checked = await check.json();
  equal("offline state localized by clients", checked.update.status, "unavailable");
  equal("offline preserves version", checked.update.currentVersion, body.update.currentVersion);
  ok("metadata response never cacheable", /no-store/.test(meta.headers.get("cache-control")));
} finally {
  await server.stop();
  if (previousOptions === undefined) delete process.env.NODE_OPTIONS;
  else process.env.NODE_OPTIONS = previousOptions;
}
finish();

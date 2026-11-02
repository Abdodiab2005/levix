import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { equal, finish, httpClient, ok, ROOT, section, startServer, useTempDataDir } from "./harness.mjs";
import { gatewayAssets } from "./fixtures/gateway-assets.mjs";

const require = createRequire(import.meta.url);
const { renderFallbackPage } = require("../src/panel/fallback-page.cjs");
const read = (path) => readFileSync(join(ROOT, path), "utf8");
const assets = gatewayAssets();
assets.fallback();
const dataDir = useTempDataDir("levix-static-fallback");

section("no frontend build");
const server = await startServer({ dataDir, assetRoot: assets.root });
const http = httpClient(server.base);
try {
  equal("unclaimed root redirects to setup", (await http.call("/")).status, 302);
  let response = await http.call("/setup");
  equal("setup status", response.status, 200);
  let html = await response.text();
  ok("setup has no React state", !html.includes('id="levix-gateway-state"'));
  ok("setup has missing-files guidance", html.includes("npm run build:frontend"));
  ok("setup posts to setup", html.includes('<form action="/setup" method="post">'));
  for (const field of ["password", "confirm"]) ok(`setup ${field} field`, html.includes(`name="${field}"`));
  ok("local setup has no code field", !html.includes('name="code"'));
  response = await http.form("/setup", { password: "valid-password", confirm: "different-password" });
  equal("setup mismatch status", response.status, 400);
  ok("setup error shown", (await response.text()).includes("The two passwords don&#39;t match."));
  response = await http.form("/setup", { password: "valid-password", confirm: "valid-password" });
  equal("setup success redirects", response.status, 303);

  response = await http.call("/qr");
  equal("QR status", response.status, 200);
  html = await response.text();
  ok("QR page has missing-files guidance", html.includes("npm run build:frontend"));
  ok("QR page has no state or QR data", !html.includes('id="levix-gateway-state"') && !html.includes("CURRENT-QR"));
  response = await http.call("/");
  equal("authenticated root status", response.status, 200);
  html = await response.text();
  ok("panel has missing-files guidance", html.includes("npm run build:frontend"));
  ok("panel can sign out", html.includes('<form action="/logout" method="post">'));
  equal("logout redirects", (await http.call("/logout", { method: "POST" })).status, 303);

  for (const url of ["/", "/login"]) {
    response = await http.call(url);
    equal(`${url} login status`, response.status, 200);
    html = await response.text();
    ok(`${url} posts to login`, html.includes('<form action="/login" method="post">'));
    ok(`${url} has password field`, html.includes('name="password"'));
    ok(`${url} has no React state`, !html.includes('id="levix-gateway-state"'));
  }
} finally {
  server.stop();
}

section("remote setup still requires the setup code");
const remoteData = useTempDataDir("levix-static-fallback-remote");
const remoteServer = await startServer({ dataDir: remoteData, assetRoot: assets.root, trust: "1" });
try {
  const remoteHttp = httpClient(remoteServer.base);
  let response = await remoteHttp.call("/setup");
  equal("remote setup status", response.status, 200);
  ok("remote setup has code field", (await response.text()).includes('name="code" autocomplete="off"'));
  response = await remoteHttp.form("/setup", { password: "valid-password", confirm: "valid-password" });
  equal("missing setup code status", response.status, 401);
  ok("wrong code error shown", (await response.text()).includes("Wrong setup code."));
} finally {
  remoteServer.stop();
}

section("static page boundaries");
const attack = `<script>alert("x")</script>'&`;
const escaped = renderFallbackPage({ page: "login", brandName: attack, error: attack });
ok(
  "dynamic text and attributes are escaped",
  !escaped.includes(attack) && escaped.includes("&lt;script&gt;") && escaped.includes("&quot;") &&
    escaped.includes("&#39;") && escaped.includes("&amp;"),
);
ok("no inline handlers or remote resources", !/\son[a-z]+=|https?:\/\//i.test(escaped));
ok("fallback declares English", escaped.includes('<html lang="en">'));
const code = renderFallbackPage({ page: "setup", needsCode: true });
ok("remote setup has a code field", code.includes('name="code" autocomplete="off"'));
ok("local setup has no code field", !renderFallbackPage({ page: "setup", needsCode: false }).includes('name="code"'));
ok(
  "QR data is not an input to the fallback",
  !renderFallbackPage({ page: "qr", qr: "SECRET-QR" }).includes("SECRET-QR"),
);

section("removed EJS and assets");
ok("app has no render call", !read("app.cjs").includes("res.render("));
ok("manifest has no EJS dependency", !("ejs" in JSON.parse(read("package.json")).dependencies));
ok("manifest files excludes views", !JSON.parse(read("package.json")).files.some((entry) => entry.includes("views")));
for (const path of [
  "Dockerfile", "scripts/build-sea.mjs", "android/scripts/stage-levix-app.sh", "android/app/build.gradle.kts",
]) {
  ok(`${path} excludes views path`, !read(path).includes('"views"') && !read(path).includes("views/"));
}
ok("old gateway dictionary is absent", !existsSync(join(ROOT, "public/gateway-i18n.js")));
ok("generator does not output old dictionary", !read("scripts/i18n.mjs").includes('files["public/gateway-i18n.js"]'));
finish();

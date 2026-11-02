import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  equal,
  finish,
  httpClient,
  ok,
  require,
  ROOT,
  section,
  startServer,
  useTempDataDir,
} from "./harness.mjs";

const dataDir = useTempDataDir("gateway-react");
const assetRoot = mkdtempSync(join(tmpdir(), "levix-gateway-assets-"));
process.on("exit", () => rmSync(assetRoot, { recursive: true, force: true }));
mkdirSync(join(assetRoot, "public", "dashboard"), { recursive: true });
writeFileSync(
  join(assetRoot, "public", "dashboard", "gateway.html"),
  '<!doctype html><html><head><title>Gateway</title></head><body><div id="root"></div></body></html>',
);

function state(html) {
  const match = /<script id="levix-gateway-state" type="application\/json">([^<]*)<\/script>/.exec(
    html,
  );
  return match ? JSON.parse(match[1]) : null;
}

const secrets = require("./src/config/secrets.cjs");
const storage = require("./src/utils/storage.cjs");
storage.saveQrCode("CURRENT-QR");

section("React shell and first run");
let server = await startServer({ dataDir, assetRoot, routes: true });
let http = httpClient(server.base);
let response = await http.call("/");
equal("root before setup redirects", response.status, 302);
response = await http.call("/setup");
equal("setup shell status", response.status, 200);
equal("setup shell no-store", response.headers.get("cache-control"), "no-store");
let page = state(await response.text());
equal("setup shell state", page?.page, "setup");
equal("local setup needs no code", page?.needsCode, false);
equal(
  "setup state has only allowed fields and no setup code",
  Object.keys(page).sort().join(","),
  "brand,error,minLength,needsCode,page,recoveryEmail,recoveryEmailVerified",
);
for (const url of ["/setup", "/login", "/reset/request", "/reset/confirm", "/logout"]) {
  const res = await http.call(url, {
    method: "POST",
    headers: { origin: "https://evil.invalid", "sec-fetch-site": "cross-site" },
  });
  equal(`cross-origin ${url}`, res.status, 403);
}
for (const url of ["/setup", "/login", "/reset/request", "/reset/confirm", "/logout"]) {
  const res = await http.call(url, {
    method: "POST",
    headers: { origin: "null", "sec-fetch-site": "cross-site" },
  });
  equal(`opaque cross-site ${url}`, res.status, 403);
}
response = await http.form("/setup", { password: "valid-password", confirm: "different-password" });
equal("setup mismatch status", response.status, 400);
equal("setup mismatch error", state(await response.text())?.error?.code, "passwordMismatch");
response = await http.form("/setup", { password: "short", confirm: "short" });
equal("setup short status", response.status, 400);
equal("setup short error", state(await response.text())?.error?.code, "invalidPassword");
response = await http.call("/qr");
equal("signed-out QR redirects", response.status, 302);
const engine = await fetch(`${server.base}/socket.io/?EIO=4&transport=polling`);
const opening = await engine.text();
const sid = JSON.parse(opening.slice(1)).sid;
await fetch(`${server.base}/socket.io/?EIO=4&transport=polling&sid=${encodeURIComponent(sid)}`, {
  method: "POST",
  headers: { "content-type": "text/plain;charset=UTF-8" },
  body: "40",
});
const refused = await fetch(
  `${server.base}/socket.io/?EIO=4&transport=polling&sid=${encodeURIComponent(sid)}`,
);
ok("unauthenticated Socket.IO namespace refused", (await refused.text()).includes("unauthorized"));
equal("signed-out bot session API", (await http.call("/dashboard/api/bot/session")).status, 401);
equal("signed-out legal terms API", (await http.call("/dashboard/api/legal/terms")).status, 401);
response = await http.form("/setup", { password: "valid-password", confirm: "valid-password" });
equal("setup success redirects", response.status, 303);
equal("setup redirect destination", response.headers.get("location"), "/");
const setupCookie = response.headers.get("set-cookie")?.split(";")[0];
equal("claimed GET setup redirects", (await http.call("/setup")).status, 302);
equal("claimed POST setup redirects", (await http.form("/setup", {})).status, 302);
response = await http.call("/qr");
equal("signed-in QR status", response.status, 200);
page = state(await response.text());
equal("signed-in QR current value", page?.qr, "CURRENT-QR");
equal(
  "QR state has only allowed fields",
  Object.keys(page).sort().join(","),
  "brand,error,minLength,needsCode,page,qr,recoveryEmail,recoveryEmailVerified",
);
response = await http.form("/login", { password: "valid-password" });
equal("login from an existing session redirects", response.status, 303);
ok(
  "login regenerates the session id",
  Boolean(setupCookie) && response.headers.get("set-cookie")?.split(";")[0] !== setupCookie,
);
response = await http.call("/logout", { method: "POST" });
equal("logout redirects", response.status, 303);
await server.stop();

section("login and lockout");
server = await startServer({ dataDir, assetRoot, routes: true });
http = httpClient(server.base);
for (const url of ["/", "/login"]) {
  response = await http.call(url);
  equal(`${url} login status`, response.status, 200);
  equal(`${url} login no-store`, response.headers.get("cache-control"), "no-store");
  page = state(await response.text());
  equal(`${url} login state`, page?.page, "login");
  equal(
    `${url} login state has only allowed fields`,
    Object.keys(page).sort().join(","),
    "brand,error,minLength,needsCode,page,recoveryEmail,recoveryEmailVerified",
  );
}
for (let i = 0; i < 5; i++) {
  response = await http.form("/login", { password: "wrong-password" });
  equal(`wrong password ${i + 1} status`, response.status, 401);
  equal(
    `wrong password ${i + 1} error`,
    state(await response.text())?.error?.code,
    "incorrectPassword",
  );
}
response = await http.form("/login", { password: "wrong-password" });
equal("login lockout status", response.status, 429);
ok("login lockout Retry-After", Number(response.headers.get("retry-after")) > 0);
equal("login lockout error", state(await response.text())?.error?.code, "tooManyAttempts");
response = await http.json("/reset/confirm", {
  code: "000000",
  password: "new-password",
  confirm: "new-password",
});
equal("login lockout also blocks reset confirm", response.status, 429);
equal("reset confirm lockout reason", (await response.json()).reason, "throttled");
await server.stop();

section("login success and session regeneration");
server = await startServer({ dataDir, assetRoot });
http = httpClient(server.base);
response = await http.form("/login", { password: "valid-password" });
equal("login success status", response.status, 303);
equal("login success location", response.headers.get("location"), "/");
ok("login assigns a session cookie", Boolean(response.headers.get("set-cookie")));
await server.stop();

section("static fallback");
rmSync(join(assetRoot, "public", "dashboard", "gateway.html"));
server = await startServer({ dataDir, assetRoot });
http = httpClient(server.base);
for (const url of ["/", "/login"]) {
  response = await http.call(url);
  const html = await response.text();
  equal(`${url} fallback status`, response.status, 200);
  ok(
    `${url} static fallback`,
    html.includes("The panel files are missing") && html.includes('action="/login"') && !state(html),
  );
}
await server.stop();

const fallbackData = useTempDataDir("gateway-fallback-setup");
server = await startServer({ dataDir: fallbackData, assetRoot });
http = httpClient(server.base);
response = await http.call("/setup");
ok(
  "setup static fallback",
  response.status === 200 && (await response.text()).includes('action="/setup"'),
);
await server.stop();

section("remote setup and escape boundary");
const remoteData = useTempDataDir("gateway-remote");
writeFileSync(
  join(assetRoot, "public", "dashboard", "gateway.html"),
  "<!doctype html><html><head></head><body></body></html>",
);
server = await startServer({ dataDir: remoteData, assetRoot, trust: "1" });
http = httpClient(server.base);
response = await http.call("/setup");
equal("proxied setup needs code", state(await response.text())?.needsCode, true);
response = await http.form("/setup", { password: "valid-password", confirm: "valid-password" });
equal("missing remote setup code status", response.status, 401);
equal(
  "missing remote setup code error",
  state(await response.text())?.error?.code,
  "wrongSetupCode",
);
await server.stop();

const paths = require("./src/config/paths.cjs");
paths.setAssetRoot(assetRoot);
const { app, renderGateway } = require("./app.cjs");
let output = "";
const fakeResponse = {
  status() {
    return this;
  },
  type() {
    return this;
  },
  send(html) {
    output = html;
    return this;
  },
};
const attack = "</script><img onerror=alert(1)>\u2028&";
renderGateway({}, fakeResponse, "login", { error: attack, errorCode: "unknown" });
ok(
  "injected error cannot close script",
  !output.includes(attack) && !output.includes("<img onerror"),
);
equal("escaped error round trips", state(output)?.error?.message, attack);
ok("U+2028 is escaped", output.includes("\\u2028"));
const dollars = "one $' two $& three $` four $1 </script>&\u2028";
renderGateway({}, fakeResponse, "login", { error: dollars, errorCode: "unknown" });
const injected = /<script id="levix-gateway-state" type="application\/json">([^<]*)<\/script>/.exec(
  output,
)?.[1];
const expected = JSON.stringify({
  page: "login",
  error: { code: "unknown", message: dollars },
  minLength: secrets.MIN_PASSWORD_LENGTH,
  needsCode: false,
  recoveryEmail: null,
  recoveryEmailVerified: false,
  brand: app.locals.brand,
})
  .replaceAll("<", "\\u003c")
  .replaceAll(">", "\\u003e")
  .replaceAll("&", "\\u0026")
  .replaceAll("\u2028", "\\u2028")
  .replaceAll("\u2029", "\\u2029");
equal("dollar replacement tokens preserve exact JSON bytes", injected, expected);

section("static React boundaries");
const source = ["main.tsx", "login.tsx", "qr.tsx", "inline-markup.ts"].map((name) =>
  readFileSync(join(ROOT, "frontend", "src", "gateway", name), "utf8"),
);
ok(
  "no gateway innerHTML escape hatch",
  source.every((text) => !text.includes("dangerouslySetInnerHTML")),
);
ok(
  "no gateway dashboard API fetch",
  source.every((text) => !text.includes('fetch("/dashboard/api')),
);
ok("login opens no socket", !source[1].includes("io(") && !source[1].includes("socket.io"));
ok(
  "React reset requests abort after 20000 ms",
  source[1].includes("new AbortController()") &&
    source[1].includes("controller.abort(), 20000") &&
    source[1].includes("signal: controller.signal") &&
    source[1].includes("window.clearTimeout(timeout)") &&
    source[1].includes('showError("resetErrServer")') &&
    source[1].includes("setBusy(false)"),
);
ok(
  "React reset confirmation reads submitted form fields",
  source[1].includes("new FormData(event.currentTarget)") &&
    ["code", "password", "confirm"].every((name) => source[1].includes(`fields.get("${name}")`)),
);
const shell = readFileSync(join(ROOT, "frontend", "gateway.html"), "utf8");
ok("ui boot is first in head", /<head>\s*<script src="\/ui-boot\.js"><\/script>/.test(shell));
ok("gateway has no remote font", !shell.includes("fonts.googleapis.com"));
const css = readFileSync(join(ROOT, "frontend", "src", "gateway", "style.css"), "utf8");
ok("password blur and print rules", css.includes("screen-guard") && css.includes("@media print"));
finish();

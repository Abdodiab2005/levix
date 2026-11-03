import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  equal,
  finish,
  httpClient,
  ok,
  ROOT,
  section,
  startServer,
  useTempDataDir,
} from "./harness.mjs";
import { gatewayAssets } from "./fixtures/gateway-assets.mjs";

const dataDir = useTempDataDir("screen-capture");
const assets = gatewayAssets();
assets.ejs();

const HEADER = "x-levix-screen-capture";

async function read(response) {
  return {
    status: response.status,
    header: response.headers.get(HEADER),
    location: response.headers.get("location"),
    body: await response.text(),
  };
}

section("absent until a signed-in document");
let server = await startServer({ dataDir, assetRoot: assets.root });
let http = httpClient(server.base);
try {
  let page = await read(await http.call("/"));
  equal("root before setup redirects", page.status, 302);
  equal("root before setup has no capture header", page.header, null);

  page = await read(await http.call("/setup"));
  equal("setup status", page.status, 200);
  equal("setup has no capture header", page.header, null);

  page = await read(await http.form("/setup", { password: "valid-password", confirm: "nope" }));
  equal("setup mismatch status", page.status, 400);
  equal("setup mismatch has no capture header", page.header, null);

  page = await read(await http.form("/setup", { password: "short", confirm: "short" }));
  equal("setup short status", page.status, 400);
  equal("setup short has no capture header", page.header, null);

  page = await read(
    await http.form("/setup", { password: "valid-password", confirm: "valid-password" }),
  );
  equal("setup success redirects", page.status, 303);
  equal("setup success has no capture header", page.header, null);

  page = await read(await http.call("/"));
  equal("signed-in fallback dashboard status", page.status, 200);
  equal("signed-in fallback dashboard allows capture", page.header, "allow");
  ok("signed-in fallback is the panel document", page.body.includes("dashboard-page"));

  page = await read(await http.call("/qr"));
  equal("signed-in qr status", page.status, 200);
  equal("signed-in qr allows capture", page.header, "allow");

  page = await read(await http.call("/login"));
  equal("signed-in login redirects", page.status, 302);
  equal("signed-in login redirect has no capture header", page.header, null);

  page = await read(await http.call("/logout", { method: "POST" }));
  equal("logout redirects", page.status, 303);
  equal("logout has no capture header", page.header, null);

  page = await read(await http.call("/"));
  equal("signed-out root is login", page.status, 200);
  equal("signed-out root has no capture header", page.header, null);
  ok("signed-out root is the login document", page.body.includes("gateway-page"));

  page = await read(await http.call("/login"));
  equal("login status", page.status, 200);
  equal("login has no capture header", page.header, null);

  page = await read(await http.call("/qr"));
  equal("signed-out qr redirects", page.status, 302);
  equal("signed-out qr has no capture header", page.header, null);

  page = await read(await http.form("/login", { password: "wrong-password" }));
  equal("wrong password status", page.status, 401);
  equal("wrong password has no capture header", page.header, null);

  page = await read(await http.call("/no-such-page"));
  equal("unknown path has no capture header", page.header, null);
} finally {
  await server.stop();
}

section("signed-in index.html");
mkdirSync(join(assets.root, "public", "dashboard"), { recursive: true });
writeFileSync(
  join(assets.root, "public", "dashboard", "index.html"),
  "<!doctype html><html><head></head><body>panel-index</body></html>",
);
server = await startServer({ dataDir, assetRoot: assets.root });
http = httpClient(server.base);
try {
  let page = await read(await http.form("/login", { password: "valid-password" }));
  equal("login success redirects", page.status, 303);
  equal("login success has no capture header", page.header, null);

  page = await read(await http.call("/"));
  equal("signed-in index status", page.status, 200);
  equal("signed-in index allows capture", page.header, "allow");
  ok("signed-in index is index.html", page.body.includes("panel-index"));

  page = await read(await http.call("/qr"));
  equal("signed-in qr still allows capture", page.header, "allow");
} finally {
  await server.stop();
}

section("host source");
const panel = readFileSync(
  join(ROOT, "android/app/src/main/java/net/leviro/levix/PanelActivity.kt"),
  "utf8",
);
const guardSrc = readFileSync(
  join(ROOT, "android/app/src/main/java/net/leviro/levix/ScreenCaptureGuard.kt"),
  "utf8",
);
const startAt = panel.indexOf("guard.start()");
const contentAt = panel.indexOf("setContentView(container)");
ok("start() runs before setContentView", startAt !== -1 && contentAt !== -1 && startAt < contentAt);
ok("PanelActivity no longer keys the guard on /login", !panel.includes('"/login"'));
ok("PanelActivity no longer keys the guard on /setup", !panel.includes('"/setup"'));
ok("the old URL guard is gone", !panel.includes("applyScreenCaptureGuard"));
ok("the guard imports no Android API", !guardSrc.includes("import android."));

finish();

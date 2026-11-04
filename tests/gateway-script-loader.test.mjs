import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadScript } from "../frontend/src/gateway/script-loader.mjs";
import { equal, finish, ok, ROOT, section } from "./harness.mjs";

section("gateway scripts fail visibly and can be requested again");
let script;
let requests = 0;
let removed = 0;
let ready = false;
globalThis.document = {
  createElement: () => ({ remove: () => { removed += 1; } }),
  body: { appendChild: (element) => { script = element; requests += 1; } },
};

for (const src of ["/qrcode.min.js", "/socket.io.min.js"]) {
  ready = false;
  const failed = loadScript(src, () => ready);
  equal(`${src} is requested`, script.src, src);
  script.onerror();
  ok(`${src} load error rejects`, await failed.then(() => false, () => true));
  const missingGlobal = loadScript(src, () => ready);
  script.onload();
  ok(`${src} missing global rejects`, await missingGlobal.then(() => false, () => true));
  const retry = loadScript(src, () => ready);
  ready = true;
  script.onload();
  ok(`${src} retry resolves`, await retry.then(() => true, () => false));
  await loadScript(src, () => ready);
}
equal("settled scripts are removed", removed, 6);
equal("already loaded scripts do not reload", requests, 6);

const source = readFileSync(join(ROOT, "frontend/src/gateway/qr.tsx"), "utf8");
ok("failure shows an alert", /loadError\s*&&[\s\S]*?role="alert"/.test(source));
ok("Retry starts a fresh attempt", /setAttempt\(\(value\) => value \+ 1\)/.test(source));
ok("stale errors do not update an unmounted screen", /if \(active\) setLoadError\(true\)/.test(source));
ok("cleanup disconnects the socket", /socket\?\.disconnect\(\)/.test(source));
delete globalThis.document;
finish();

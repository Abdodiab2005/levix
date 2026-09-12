import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { androidPanelSocketPath, panelUrl, resolveBindAddress } from "../src/bootstrap/panel.js";
import { equal, finish, ok } from "./harness.mjs";

const require = createRequire(import.meta.url);
const previous = process.env.LEVIX_ANDROID;
const settings = require("../src/config/settings.cjs");

settings.set("bind_address", "");

process.env.LEVIX_ANDROID = "1";
equal(
  "empty bind is every interface on desktop and unused on Android TCP",
  resolveBindAddress(),
  "0.0.0.0",
);
equal(
  "Android panel URL uses 127.0.0.1, not localhost",
  panelUrl({ port: 3001 }),
  "http://127.0.0.1:3001",
);
ok(
  "Android panel listens on panel.sock",
  androidPanelSocketPath().replaceAll("\\", "/").endsWith("/panel.sock"),
);

settings.set("bind_address", "0.0.0.0");
equal("an explicit bind still wins on Android", resolveBindAddress(), "0.0.0.0");

settings.set("bind_address", "");
if (previous === undefined) delete process.env.LEVIX_ANDROID;
else process.env.LEVIX_ANDROID = previous;

equal("without the Android marker, empty bind is every interface", resolveBindAddress(), "0.0.0.0");

const indexSrc = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
ok(
  "Android panel bind failure keeps the process up",
  /Panel failed/.test(indexSrc) &&
    /LEVIX_ANDROID === "1"[\s\S]{0,400}Levix ready/.test(indexSrc),
);
ok("desktop panel bind failure still exits", /process\.exit\(1\)/.test(indexSrc));

const panelSrc = readFileSync(new URL("../src/bootstrap/panel.js", import.meta.url), "utf8");
ok("Android listen uses the unix socket path", /server\.listen\(androidSock/.test(panelSrc));

finish();

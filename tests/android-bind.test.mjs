import { createRequire } from "node:module";
import { panelUrl, resolveBindAddress } from "../src/bootstrap/panel.js";
import { equal, finish } from "./harness.mjs";

const require = createRequire(import.meta.url);
const previous = process.env.LEVIX_ANDROID;
const settings = require("../src/config/settings.cjs");

settings.set("bind_address", "");

process.env.LEVIX_ANDROID = "1";
equal("Android with an empty bind uses loopback", resolveBindAddress(), "127.0.0.1");
equal(
  "Android panel URL uses 127.0.0.1, not localhost",
  panelUrl({ port: 3001 }),
  "http://127.0.0.1:3001",
);

settings.set("bind_address", "0.0.0.0");
equal("an explicit bind still wins on Android", resolveBindAddress(), "0.0.0.0");

settings.set("bind_address", "");
if (previous === undefined) delete process.env.LEVIX_ANDROID;
else process.env.LEVIX_ANDROID = previous;

equal("without the Android marker, empty bind is every interface", resolveBindAddress(), "0.0.0.0");

finish();

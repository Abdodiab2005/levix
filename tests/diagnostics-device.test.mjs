// The device diagnostics object (contract section 1).
//
// The server builds this from a client object it does not trust. The tests pin
// the allowlist: only the contract's keys survive, the server owns
// levix/node/platform, enums are enforced, lengths are capped and the whole
// thing stays under 2 KB.

import { equal, finish, ok, require, section, useTempDataDir } from "./harness.mjs";

useTempDataDir("levix-device");

const {
  buildDiagnostics,
  sanitizeClientFields,
  DIAGNOSTICS_MAX_BYTES,
} = require("./src/diagnostics/device.cjs");
const feedback = require("./src/panel/feedback.cjs");

const runtime = feedback.describeRuntime();

section("the server fills its own keys");

const full = {
  levix: "9.9.9",
  node: "v0.0.0",
  platform: "hacker",
  nativeApp: "4.7.0 (65)",
  android: "15 (API 35)",
  device: "samsung SM-A556E",
  abi: "arm64-v8a",
  webview: "131.0.6778.135",
  screen: "412x915@2.63",
  language: "ar",
  theme: "dark",
  connectivity: "wifi",
  memory: "ok",
  storage: "ok",
  evil: "must not survive",
};

const built = buildDiagnostics(full);

equal("the schema is 1", built.schema, 1);
equal("a client levix value is ignored", built.levix, runtime.version);
equal("a client node value is ignored", built.node, process.version);
equal("a client platform value is ignored", built.platform, runtime.platform);
equal("nativeApp survives", built.nativeApp, "4.7.0 (65)");
equal("android survives", built.android, "15 (API 35)");
equal("device survives", built.device, "samsung SM-A556E");
equal("abi survives", built.abi, "arm64-v8a");
equal("webview survives", built.webview, "131.0.6778.135");
equal("screen survives", built.screen, "412x915@2.63");
equal("language survives", built.language, "ar");
equal("theme survives", built.theme, "dark");
equal("connectivity survives", built.connectivity, "wifi");
equal("memory survives", built.memory, "ok");
equal("storage survives", built.storage, "ok");
ok("an unknown key is dropped", !("evil" in built));
equal(
  "the key set is exactly the contract",
  Object.keys(built).sort().join(","),
  "abi,android,connectivity,device,language,levix,memory,nativeApp,node,platform,schema,screen,storage,theme,webview",
);

section("a client cannot invent native facts");

equal(
  "an empty client yields server keys only",
  Object.keys(buildDiagnostics({})).sort().join(","),
  "levix,node,platform,schema",
);
equal(
  "a malformed client yields server keys only",
  Object.keys(buildDiagnostics("not an object")).sort().join(","),
  "levix,node,platform,schema",
);
equal(
  "an array client yields server keys only",
  Object.keys(buildDiagnostics(["nope"]))
    .sort()
    .join(","),
  "levix,node,platform,schema",
);

section("unknown enum values are dropped, not guessed");

const badEnums = buildDiagnostics({
  language: "fr",
  theme: "blue",
  connectivity: "5g",
  memory: "maybe",
  storage: "plenty",
});
ok("an unknown language is dropped", !("language" in badEnums));
ok("an unknown theme is dropped", !("theme" in badEnums));
ok("an unknown connectivity is dropped", !("connectivity" in badEnums));
ok("an unknown memory is dropped", !("memory" in badEnums));
ok("an unknown storage is dropped", !("storage" in badEnums));

const enums = buildDiagnostics({
  language: "EN",
  theme: "Light",
  connectivity: "UNKNOWN",
  memory: "low",
  storage: "low",
});
equal("an enum is lowercased", enums.language, "en");
equal("a mixed-case enum is normalized", enums.theme, "light");
equal("a valid unknown enum value is kept", enums.connectivity, "unknown");

section("length caps and the 2 KB ceiling");

const capped = buildDiagnostics({
  nativeApp: "x".repeat(500),
  android: "x".repeat(500),
  device: "x".repeat(500),
  abi: "x".repeat(500),
  webview: "x".repeat(500),
  screen: "x".repeat(500),
});
equal("nativeApp is capped", capped.nativeApp.length, 40);
equal("android is capped", capped.android.length, 40);
equal("device is capped", capped.device.length, 80);
equal("abi is capped", capped.abi.length, 24);
equal("webview is capped", capped.webview.length, 40);
equal("screen is capped", capped.screen.length, 24);
ok(
  "the serialized object stays under 2 KB",
  Buffer.byteLength(JSON.stringify(built), "utf8") <= DIAGNOSTICS_MAX_BYTES,
  `${Buffer.byteLength(JSON.stringify(built), "utf8")} bytes`,
);

section("the client-field helper covers section 1 only");

const fields = sanitizeClientFields({
  nativeApp: "4.7.0 (65)",
  device: " samsung SM-A556E ",
  levix: "9.9.9",
  node: "v0",
  platform: "hacker",
  schema: 99,
});
equal("values are trimmed", fields.device, "samsung SM-A556E");
ok("the helper does not add levix", !("levix" in fields));
ok("the helper does not add node", !("node" in fields));
ok("the helper does not add platform", !("platform" in fields));
ok("the helper does not add schema", !("schema" in fields));

finish();

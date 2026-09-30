import {
  equal,
  finish,
  require as harnessRequire,
  httpClient,
  ok,
  section,
  startServer,
  useTempDataDir,
} from "./harness.mjs";

// Settings export/import: the shareable JSON file. What must hold forever is
// that a shared file carries no secret and an import can't plant one.

useTempDataDir("levix-settings-transfer");
const settings = harnessRequire("./src/config/settings.cjs");
const runtimeConfig = harnessRequire("./src/config/runtime-config.cjs");
const transfer = harnessRequire("./src/services/settingsTransfer.cjs");

section("an export of a customised install");

settings.set("bot_language", "en");
settings.set("bot_min_delay_ms", 1234);
settings.set("port", 3005);
settings.set("gemini_api_key", "sk-secret-do-not-share");
runtimeConfig.setPrefix(">");
runtimeConfig.setPermission("ping", "ADMINS_ONLY");
runtimeConfig.setPermission("group:kick", "OWNER_ONLY");
runtimeConfig.setAliases("ping", ["p", "بنج"]);
runtimeConfig.setEnabled("qr", false);

const exported = transfer.exportSettings();
equal("the file announces its format", exported.format, "levix-settings");
equal("and its version", exported.version, 1);
ok("exportedAt is an ISO date", !Number.isNaN(Date.parse(exported.exportedAt)));
equal("changed settings ride along", exported.settings.bot_language, "en");
equal("including numbers", exported.settings.bot_min_delay_ms, 1234);
equal("including restart-flagged ones", exported.settings.port, 3005);
equal("the prefix is there", exported.commands.prefix, ">");
equal("permission overrides export", exported.commands.permissions.ping, "ADMINS_ONLY");
equal("group sub-command overrides too", exported.commands.permissions["group:kick"], "OWNER_ONLY");
equal("aliases export", exported.commands.aliases.ping.join(","), "p,بنج");
ok("disabled commands export", exported.commands.disabled.includes("qr"));

section("secrets never leave");

for (const key of settings.SECRET_SETTING_KEYS) {
  ok(`${key} is not in the file`, !(key in exported.settings));
}
ok(
  "the gemini key value appears nowhere in the JSON",
  !JSON.stringify(exported).includes("sk-secret-do-not-share"),
);

section("untouched settings stay out");

ok("gemini_model was never changed, so it is not exported", !("gemini_model" in exported.settings));

section("an import restores what a reset wiped");

settings.set("bot_language", "");
settings.set("bot_min_delay_ms", "");
settings.set("port", "");
runtimeConfig.setPrefix("!");
runtimeConfig.setPermission("ping", null);
runtimeConfig.setAliases("ping", null);
runtimeConfig.setEnabled("qr", true);

const report = transfer.applyImport(exported);
ok("the import reports success", report.applied.includes("bot_language"));
equal("bot_language is back", settings.get("bot_language"), "en");
equal("bot_min_delay_ms is back", settings.get("bot_min_delay_ms"), 1234);
equal("port is back, and flagged for restart", settings.get("port"), 3005);
ok("port lands in restartNeeded", report.restartNeeded.includes("port"));
equal("the prefix is back", runtimeConfig.getPrefix(), ">");
equal("the permission is back", runtimeConfig.getPermission("ping"), "ADMINS_ONLY");
equal(
  "the group sub-command permission is back",
  runtimeConfig.getPermission("group:kick"),
  "OWNER_ONLY",
);
equal("aliases are back", runtimeConfig.getAliases("ping", []).join(","), "p,بنج");
ok("qr is disabled again", runtimeConfig.isDisabled("qr"));

section("an import cannot plant a secret");

settings.set("gemini_api_key", "");
const wasConfigured = settings.describe().find((s) => s.key === "gemini_api_key").configured;
equal("the key is really gone first", wasConfigured, false);
const smuggled = transfer.applyImport({
  format: "levix-settings",
  version: 1,
  settings: { gemini_api_key: "evil-key" },
  commands: {},
});
equal(
  "the secret key is skipped",
  smuggled.skipped.find((s) => s.key === "gemini_api_key")?.reason,
  "Secret — set it in the panel",
);
equal(
  "and nothing got stored",
  settings.describe().find((s) => s.key === "gemini_api_key").configured,
  false,
);

section("junk in the file is refused or reported");

equal(
  "unknown settings are skipped, not applied",
  transfer.applyImport({
    format: "levix-settings",
    version: 1,
    settings: { not_a_setting: 1 },
    commands: {},
  }).skipped[0].reason,
  "Unknown setting",
);
equal(
  "invalid values are skipped with the real reason",
  transfer
    .applyImport({
      format: "levix-settings",
      version: 1,
      settings: { bot_min_delay_ms: 999999 },
      commands: {},
    })
    .skipped[0].reason.includes("10000"),
  true,
);
let threw = "";
try {
  transfer.applyImport({ format: "something-else", version: 1 });
} catch (error) {
  threw = error.message;
}
ok("a foreign file is refused outright", threw.includes("isn't a Levix settings export"));

section("the HTTP surface");

const webDir = useTempDataDir("levix-settings-transfer-http");
const server = await startServer({ dataDir: webDir, trust: "", routes: true });
const http = httpClient(server.base);

try {
  let res = await http.call("/dashboard/api/settings/export");
  equal("export behind login is 401 first", res.status, 401);

  res = await http.form("/setup", { password: "a-good-password", confirm: "a-good-password" });
  equal("setup completes (and signs in)", res.status, 303);

  res = await http.json("/dashboard/api/settings", { key: "bot_language", value: "en" }, "PATCH");
  equal("a setting is changed through the API", res.status, 200);

  res = await http.call("/dashboard/api/settings/export");
  equal("export is 200", res.status, 200);
  const payload = await res.json();
  equal("it carries the format marker", payload.format, "levix-settings");
  equal("it carries the changed setting", payload.settings.bot_language, "en");
  ok(
    "no secret key appears in it",
    settings.SECRET_SETTING_KEYS.every((key) => !(key in payload.settings)),
  );

  res = await http.json("/dashboard/api/settings/import", { format: "nope", version: 1 });
  equal("a foreign file is 400", res.status, 400);

  await http.json("/dashboard/api/settings", { key: "bot_language", value: "ar" }, "PATCH");
  res = await http.json("/dashboard/api/settings/import", payload);
  equal("round-trip import is 200", res.status, 200);
  const report = await res.json();
  ok("the setting was re-applied", report.applied.includes("bot_language"));

  res = await http.call("/dashboard/api/settings");
  const view = await res.json();
  equal("and the API agrees", view.settings.find((s) => s.key === "bot_language").value, "en");
} finally {
  server.stop();
}

finish();

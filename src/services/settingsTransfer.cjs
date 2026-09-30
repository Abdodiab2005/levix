// Share settings as a file: export what the operator changed, import it back
// on another install — the "my friend set their bot up like mine" flow.
//
// Two rules make the file safe to pass around:
//
//   * Secrets never leave. API keys, the proxy password, the panel password —
//     every `type: "secret"` setting is skipped on export AND refused on
//     import, so a shared file can't carry a credential and can't overwrite
//     the importer's own. Everyone fills their own keys in the panel.
//   * Only overrides are exported. A setting the operator never touched stays
//     out of the file, so the importer keeps following their own shipped
//     defaults wherever the sharer also hadn't changed anything.
//
// What is covered: every non-secret `setting:*` row (AI provider and models,
// language, delays, thumbnails, port and proxy shape, …) plus the command
// table — prefix, permission overrides, alias overrides, disabled commands.
// Not covered on purpose: per-group config and the memory files (they are
// personal data, not settings) and the AI persona (a behaviour file the
// operator authors, shared by copy-paste if wanted).

const settings = require("../config/settings.cjs");
const runtimeConfig = require("../config/runtime-config.cjs");
const logger = require("../utils/logger.cjs");
const {
  invalidateDiscoveryCache,
  applyCapabilityGuards,
  resolveCapabilities,
} = require("./modelRegistry.cjs");

const FORMAT = "levix-settings";
const VERSION = 1;

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * The file a friend shares. Hand the JSON straight to the importer UI.
 */
function exportSettings() {
  const exported = {};
  for (const key of settings.SETTING_KEYS) {
    if (settings.SECRET_SETTING_KEYS.includes(key)) continue;
    if (settings.sourceOf(key) !== "dashboard") continue;
    exported[key] = settings.get(key);
  }

  // Hand-edited rows can't happen through the panel, but a copy that passed
  // through someone's editor might — export only the levels the code acts on.
  const permissions = {};
  for (const [command, level] of Object.entries(runtimeConfig.permissionOverrides())) {
    if (runtimeConfig.PERMISSION_LEVELS.includes(level)) permissions[command] = level;
  }
  const aliases = {};
  for (const [command, list] of Object.entries(runtimeConfig.aliasOverrides())) {
    if (Array.isArray(list)) aliases[command] = list.map(String);
  }

  return {
    format: FORMAT,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    settings: exported,
    commands: {
      prefix: runtimeConfig.getPrefix(),
      permissions,
      aliases,
      disabled: runtimeConfig.disabledCommands(),
    },
  };
}

/**
 * Apply one non-secret setting exactly the way PATCH /dashboard/api/settings
 * does: model-capability guards around vision/STT, discovery-cache drops when
 * a credential or endpoint moves. The PATCH route calls this too, so a hand
 * edit and an import can't drift apart.
 *
 * @returns the value actually in force afterwards
 */
function applySettingChange(key, value) {
  if (key === "ai_vision_enabled" || key === "ai_stt_enabled") {
    const provider = String(settings.get("ai_provider") || "gemini");
    const modelKey =
      provider === "gemini"
        ? "gemini_model"
        : provider === "anthropic"
          ? "anthropic_model"
          : "openai_model";
    const resolved = resolveCapabilities(provider, settings.get(modelKey));
    const next = applyCapabilityGuards({
      visionEnabled: key === "ai_vision_enabled" ? value : settings.get("ai_vision_enabled"),
      sttEnabled: key === "ai_stt_enabled" ? value : settings.get("ai_stt_enabled"),
      capabilities: resolved.capabilities,
      capabilitySource: resolved.capabilitySource,
      autoDetect: settings.get("ai_auto_detect_capabilities"),
    });
    if (key === "ai_vision_enabled") value = next.visionEnabled;
    if (key === "ai_stt_enabled") value = next.sttEnabled;
  }

  settings.set(key, value);

  if (key.includes("api_key") || key.includes("base_url")) {
    const prov = key.startsWith("gemini")
      ? "gemini"
      : key.startsWith("anthropic")
        ? "anthropic"
        : key.startsWith("openai")
          ? "openai"
          : null;
    if (prov) invalidateDiscoveryCache(prov);
    else invalidateDiscoveryCache();
  }
  if (
    key === "ai_provider" ||
    key === "gemini_model" ||
    key === "openai_model" ||
    key === "anthropic_model"
  ) {
    const provider = key === "ai_provider" ? String(value || "gemini") : key.split("_")[0];
    const modelKey =
      provider === "gemini"
        ? "gemini_model"
        : provider === "anthropic"
          ? "anthropic_model"
          : "openai_model";
    const modelId = key.endsWith("_model") ? value : settings.get(modelKey);
    const resolved = resolveCapabilities(provider, modelId);
    const next = applyCapabilityGuards({
      visionEnabled: settings.get("ai_vision_enabled"),
      sttEnabled: settings.get("ai_stt_enabled"),
      capabilities: resolved.capabilities,
      capabilitySource: resolved.capabilitySource,
      autoDetect: settings.get("ai_auto_detect_capabilities"),
    });
    if (Boolean(settings.get("ai_vision_enabled")) !== next.visionEnabled) {
      settings.set("ai_vision_enabled", next.visionEnabled);
    }
    if (Boolean(settings.get("ai_stt_enabled")) !== next.sttEnabled) {
      settings.set("ai_stt_enabled", next.sttEnabled);
    }
  }
  return settings.get(key);
}

/**
 * Apply a shared file to this install. One bad value never stops the rest —
 * it is reported and the import carries on.
 *
 * @returns {object} a report the panel shows: what landed, what didn't, and
 *   which keys wait for a restart.
 */
function applyImport(payload) {
  if (!isPlainObject(payload) || payload.format !== FORMAT) {
    throw new Error("That file isn't a Levix settings export");
  }
  if (payload.version !== VERSION) {
    throw new Error(`Unsupported export version: ${String(payload.version)}`);
  }

  const report = { applied: [], skipped: [], restartNeeded: [], counts: {} };

  for (const [key, value] of Object.entries(
    isPlainObject(payload.settings) ? payload.settings : {},
  )) {
    if (!settings.SETTING_KEYS.includes(key)) {
      report.skipped.push({ key, reason: "Unknown setting" });
      continue;
    }
    if (settings.SECRET_SETTING_KEYS.includes(key)) {
      // A hand-crafted file doesn't get to plant a credential.
      report.skipped.push({ key, reason: "Secret — set it in the panel" });
      continue;
    }
    try {
      applySettingChange(key, value);
      report.applied.push(key);
      if (settings.RESTART_SETTING_KEYS.includes(key)) report.restartNeeded.push(key);
    } catch (error) {
      report.skipped.push({ key, reason: error.message });
    }
  }

  const commands = isPlainObject(payload.commands) ? payload.commands : {};
  const commandReport = { permissions: 0, aliases: 0, disabled: 0 };

  if (typeof commands.prefix === "string" && commands.prefix.trim()) {
    try {
      runtimeConfig.setPrefix(commands.prefix);
      report.applied.push("prefix");
    } catch (error) {
      report.skipped.push({ key: "prefix", reason: error.message });
    }
  }

  for (const [command, level] of Object.entries(
    isPlainObject(commands.permissions) ? commands.permissions : {},
  )) {
    try {
      runtimeConfig.setPermission(command, level);
      commandReport.permissions += 1;
    } catch (error) {
      report.skipped.push({ key: `permission:${command}`, reason: error.message });
    }
  }

  for (const [command, list] of Object.entries(
    isPlainObject(commands.aliases) ? commands.aliases : {},
  )) {
    try {
      runtimeConfig.setAliases(command, Array.isArray(list) ? list : null);
      commandReport.aliases += 1;
    } catch (error) {
      report.skipped.push({ key: `aliases:${command}`, reason: error.message });
    }
  }

  // The disabled list replaces the local one, so the two installs actually end
  // up alike: everything the file doesn't name runs again.
  const disabledWanted = Array.isArray(commands.disabled) ? commands.disabled.map(String) : [];
  const currentlyDisabled = runtimeConfig.disabledCommands();
  for (const command of currentlyDisabled) {
    if (!disabledWanted.includes(command)) runtimeConfig.setEnabled(command, true);
  }
  for (const command of disabledWanted) {
    runtimeConfig.setEnabled(command, false);
    commandReport.disabled += 1;
  }
  if (commands.disabled !== undefined) report.applied.push("disabled_commands");

  report.counts = commandReport;
  logger.info(
    { applied: report.applied.length, skipped: report.skipped.length },
    "[settings] import applied",
  );
  return report;
}

module.exports = {
  FORMAT,
  VERSION,
  exportSettings,
  applyImport,
  applySettingChange,
};

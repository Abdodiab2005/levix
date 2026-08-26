// The command table, changeable at runtime.
//
// src/config/defaults.cjs holds the DEFAULTS that ship with the bot. Whatever
// the operator changes from the dashboard is stored as an override in the
// `bot_settings` table and layered on top, so:
//
//   * an update that adds a new command still gets its default permission,
//   * nothing has to rewrite a file that is checked into the repo,
//   * a change is live on the very next message.
//
// Override keys in bot_settings:
//   prefix               string
//   command_permissions  { "<command>": "<LEVEL>", "group:<sub>": "<LEVEL>" }
//   command_aliases      { "<command>": ["alias", ...] }
//   disabled_commands    ["<command>", ...]

const defaults = require("./defaults.cjs");
const logger = require("../utils/logger.cjs");

const PERMISSION_LEVELS = Object.freeze([
  "MEMBERS",
  "ADMINS_ONLY",
  "ADMINS_OWNER",
  "OWNER_ONLY",
]);

const KEY_PERMISSIONS = "command_permissions";
const KEY_ALIASES = "command_aliases";
const KEY_DISABLED = "disabled_commands";
const KEY_PREFIX = "prefix";

// Lazy require: runtime-config is pulled in by modules that load very early,
// and this keeps the database open exactly once, from db.cjs.
function store() {
  return require("../utils/storage.cjs");
}

// A read that somehow lands before the database is open falls back to the
// shipped defaults instead of throwing — the alternative is a boot-order crash
// for a value we have a perfectly good default for.
function readSetting(key, fallback) {
  try {
    const value = store().getBotSetting(key, undefined);
    return value === undefined || value === null ? fallback : value;
  } catch {
    return fallback;
  }
}

function writeSetting(key, value) {
  store().saveBotSetting(key, value);
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// --- prefix ---------------------------------------------------------------

function getPrefix() {
  const value = readSetting(KEY_PREFIX, defaults.prefix || "!");
  return typeof value === "string" && value.trim() ? value : "!";
}

/** @throws {Error} when the prefix is empty, too long, or has whitespace. */
function setPrefix(value) {
  const prefix = String(value ?? "").trim();
  if (!prefix) throw new Error("Prefix can't be empty");
  if (prefix.length > 3) throw new Error("Prefix can't be longer than 3 characters");
  if (/\s/.test(prefix)) throw new Error("Prefix can't contain whitespace");
  writeSetting(KEY_PREFIX, prefix);
  logger.info(`[config] prefix -> ${prefix}`);
  return prefix;
}

// --- permissions ----------------------------------------------------------

// Sub-commands of `group` are addressed as "group:kick" so one flat map can
// hold both levels without nesting.
function defaultPermission(commandKey) {
  const [head, sub] = String(commandKey).split(":");
  const table = defaults.command_permissions || {};

  if (sub) {
    const groupEntry = table[head];
    if (isPlainObject(groupEntry)) {
      return (
        groupEntry.sub_commands?.[sub] ||
        groupEntry.default_permission ||
        "MEMBERS"
      );
    }
    return "MEMBERS";
  }

  const entry = table[head];
  if (typeof entry === "string") return entry;
  if (isPlainObject(entry)) return entry.default_permission || "MEMBERS";
  return "MEMBERS";
}

function permissionOverrides() {
  const raw = readSetting(KEY_PERMISSIONS, {});
  return isPlainObject(raw) ? raw : {};
}

function getPermission(commandKey) {
  const override = permissionOverrides()[commandKey];
  if (typeof override === "string" && PERMISSION_LEVELS.includes(override)) {
    return override;
  }
  return defaultPermission(commandKey);
}

/**
 * Set (or clear, with `level === null`) the permission of one command.
 * @throws {Error} on an unknown level.
 */
function setPermission(commandKey, level) {
  const overrides = { ...permissionOverrides() };

  if (level === null || level === undefined || level === "") {
    delete overrides[commandKey];
  } else {
    if (!PERMISSION_LEVELS.includes(level)) {
      throw new Error(`Unknown permission level: ${level}`);
    }
    // Storing a value identical to the default would pin the command to
    // today's default forever; drop it instead so it keeps following defaults.cjs.
    if (level === defaultPermission(commandKey)) delete overrides[commandKey];
    else overrides[commandKey] = level;
  }

  writeSetting(KEY_PERMISSIONS, overrides);
  logger.info(`[config] permission ${commandKey} -> ${level || "(default)"}`);
  return getPermission(commandKey);
}

// --- aliases --------------------------------------------------------------

function aliasOverrides() {
  const raw = readSetting(KEY_ALIASES, {});
  return isPlainObject(raw) ? raw : {};
}

/** The effective aliases: the override if there is one, else what the command file declares. */
function getAliases(commandName, declared = []) {
  const override = aliasOverrides()[commandName];
  return Array.isArray(override) ? override : declared;
}

function hasAliasOverride(commandName) {
  return Array.isArray(aliasOverrides()[commandName]);
}

/**
 * Replace a command's aliases. `null` restores whatever the command file declares.
 * @throws {Error} on a malformed alias.
 */
function setAliases(commandName, aliases) {
  const overrides = { ...aliasOverrides() };

  if (aliases === null || aliases === undefined) {
    delete overrides[commandName];
  } else {
    if (!Array.isArray(aliases)) throw new Error("Aliases must be a list");
    const cleaned = [];
    for (const raw of aliases) {
      const alias = String(raw ?? "").trim().toLowerCase();
      if (!alias) continue;
      if (/\s/.test(alias)) throw new Error(`Alias "${alias}" can't contain spaces`);
      if (alias.length > 20) throw new Error(`Alias "${alias}" is too long`);
      if (!cleaned.includes(alias)) cleaned.push(alias);
    }
    if (cleaned.length > 10) throw new Error("At most 10 aliases per command");
    overrides[commandName] = cleaned;
  }

  writeSetting(KEY_ALIASES, overrides);
  logger.info(`[config] aliases ${commandName} -> ${JSON.stringify(overrides[commandName] ?? "(default)")}`);
  return getAliases(commandName);
}

// --- enable / disable -----------------------------------------------------

function disabledCommands() {
  const raw = readSetting(KEY_DISABLED, []);
  return Array.isArray(raw) ? raw.map(String) : [];
}

function isDisabled(commandName) {
  return disabledCommands().includes(commandName);
}

function setEnabled(commandName, enabled) {
  const current = new Set(disabledCommands());
  if (enabled) current.delete(commandName);
  else current.add(commandName);
  writeSetting(KEY_DISABLED, [...current]);
  logger.info(`[config] command ${commandName} -> ${enabled ? "enabled" : "disabled"}`);
  return !current.has(commandName);
}

module.exports = {
  PERMISSION_LEVELS,
  getPrefix,
  setPrefix,
  defaultPermission,
  permissionOverrides,
  getPermission,
  setPermission,
  aliasOverrides,
  getAliases,
  hasAliasOverride,
  setAliases,
  disabledCommands,
  isDisabled,
  setEnabled,
};

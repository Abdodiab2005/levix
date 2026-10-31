// Shared creation/restore classification. A new table must be classified before export.
const { SETTING_KEYS, SECRET_SETTING_KEYS } = require("../config/settings.cjs");
const { BackupError } = require("./format.cjs");

const ACCOUNT_TABLES = Object.freeze([
  "user_metadata", "lid_mapping", "group_directory", "group_settings", "warnings",
  "todos", "notes", "debts", "ai_history", "schedules", "moderation_flags",
  "auto_delete_rules", "auto_delete_log", "sticker_owners", "stickers",
  "sticker_packs", "sticker_pack_items",
]);
const EXCLUDED_TABLES = Object.freeze(["baileys_auth", "qr_codes", "moderation_applied", "forward_scores"]);
const DEVICE_SETTING_KEYS = Object.freeze([
  "port", "bind_address", "trust_proxy", "public_domain", "dashboard_origin", "ffmpeg_path",
]);
const COMMAND_TABLE_KEYS = Object.freeze([
  "prefix", "command_permissions", "command_aliases", "disabled_commands",
]);
const RESTORABLE_SETTING_KEYS = Object.freeze(SETTING_KEYS.filter(
  (key) => !SECRET_SETTING_KEYS.includes(key) && !DEVICE_SETTING_KEYS.includes(key),
));
const RESTORABLE_BOT_KEYS = Object.freeze([
  ...RESTORABLE_SETTING_KEYS.map((key) => `setting:${key}`), ...COMMAND_TABLE_KEYS,
]);

function classifyTables(db) {
  const known = new Set(["bot_settings", ...ACCOUNT_TABLES, ...EXCLUDED_TABLES]);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
  const unknown = tables.map((row) => row.name).filter((name) => !known.has(name));
  if (unknown.length) {
    throw new BackupError("UNCLASSIFIED_TABLE", `Unclassified backup table: ${unknown.join(", ")}`);
  }
  return tables.map((row) => row.name);
}

module.exports = { ACCOUNT_TABLES, EXCLUDED_TABLES, DEVICE_SETTING_KEYS,
  COMMAND_TABLE_KEYS, RESTORABLE_SETTING_KEYS, RESTORABLE_BOT_KEYS, classifyTables };

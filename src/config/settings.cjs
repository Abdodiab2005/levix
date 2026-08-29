// Runtime settings — everything that used to live in a .env file.
//
// There is no .env file any more. A setting resolves in exactly two steps:
//
//   1. the value the operator saved from the dashboard (`setting:*` in the
//      bot_settings table)
//   2. the default baked in here
//
// So a fresh install runs with no configuration at all, and the control panel
// is the only place a value is ever changed. Consumers must read through
// `get()` at CALL time (not once at import) or a change wouldn't take effect
// until a restart — the few settings that genuinely can't apply live are
// marked `restart: true` and the dashboard says so next to the field.
//
// Secrets (API keys) are stored the same way but never leave the server: the
// dashboard only ever learns whether one is configured.

const logger = require("../utils/logger.cjs");

const SETTINGS = [
  // --- General -----------------------------------------------------------
  {
    key: "bot_timezone",
    type: "string",
    default: "Africa/Cairo",
    group: "general",
    label: "Timezone",
    hint: "IANA name, e.g. Africa/Cairo. Used by the AI, !prayer and the scheduler.",
  },
  {
    key: "bot_min_delay_ms",
    type: "int",
    default: 400,
    min: 0,
    max: 10000,
    group: "general",
    label: "Min reply delay (ms)",
    hint: "Small human-looking pause before the bot answers.",
  },
  {
    key: "bot_max_delay_ms",
    type: "int",
    default: 900,
    min: 0,
    max: 30000,
    group: "general",
    label: "Max reply delay (ms)",
  },

  // --- AI ----------------------------------------------------------------
  {
    key: "gemini_api_key",
    type: "secret",
    default: "",
    group: "ai",
    label: "Gemini API key",
    hint: "Free key from aistudio.google.com/apikey — without it the AI commands stay off.",
  },
  {
    key: "gemini_model",
    type: "string",
    default: "gemini-2.5-flash",
    group: "ai",
    label: "Gemini model",
  },
  {
    key: "ai_agent",
    type: "bool",
    default: true,
    group: "ai",
    label: "Tool use (agent mode)",
    hint: "Off = the AI answers from the prompt only, no search / page reading / memory writes.",
  },
  {
    key: "ai_max_tool_steps",
    type: "int",
    default: 6,
    min: 1,
    max: 20,
    group: "ai",
    label: "Max tool rounds",
  },
  {
    key: "ai_tool_timeout_ms",
    type: "int",
    default: 30000,
    min: 1000,
    max: 120000,
    group: "ai",
    label: "Tool timeout (ms)",
  },
  {
    key: "ai_max_history",
    type: "int",
    default: 24,
    min: 2,
    max: 200,
    group: "ai",
    label: "Conversation turns kept",
  },
  {
    key: "memory_context_chars",
    type: "int",
    default: 6000,
    min: 500,
    max: 40000,
    group: "ai",
    label: "Memory injected (chars)",
    hint: "How much of the long-term memory files goes into every prompt.",
  },
  {
    key: "ai_google_search",
    type: "bool",
    default: true,
    group: "ai",
    label: "Gemini Google Search",
    hint: "Lets Gemini use Google's own search grounding when a question needs current information. Gemini only — the Groq fallback is unaffected.",
  },
  {
    key: "groq_api_key",
    type: "secret",
    default: "",
    group: "ai",
    label: "Groq API key (fallback)",
    hint: "Used only when Gemini is out of quota.",
  },
  {
    key: "groq_model",
    type: "string",
    default: "llama-3.3-70b-versatile",
    group: "ai",
    label: "Groq model",
  },
  {
    key: "google_search_api_key",
    type: "secret",
    default: "",
    group: "ai",
    label: "Google Search API key",
    hint: "Optional. Without it the search tool uses DuckDuckGo.",
  },
  {
    key: "google_search_cx",
    type: "string",
    default: "",
    group: "ai",
    label: "Google Search engine ID (cx)",
  },

  // --- Integrations ------------------------------------------------------
  {
    key: "openweathermap_api_key",
    type: "secret",
    default: "",
    group: "integrations",
    label: "OpenWeatherMap API key",
    hint: "Needed by !weather.",
  },

  // --- Media -------------------------------------------------------------
  {
    key: "thumbnail_remote",
    type: "bool",
    default: true,
    group: "media",
    label: "Previews for remote media",
    hint: "Download media sent by URL to build a thumbnail before forwarding it.",
  },
  {
    key: "thumbnail_remote_max_mb",
    type: "int",
    default: 20,
    min: 1,
    max: 200,
    group: "media",
    label: "Max remote media (MB)",
  },
  {
    key: "thumbnail_remote_timeout_ms",
    type: "int",
    default: 20000,
    min: 1000,
    max: 120000,
    group: "media",
    label: "Remote media timeout (ms)",
  },
  {
    key: "ffmpeg_path",
    type: "string",
    default: "",
    group: "media",
    label: "ffmpeg path",
    hint: "Only if the bundled ffmpeg-static binary can't run on this machine.",
  },

  // --- WhatsApp proxy ----------------------------------------------------
  //
  // Applies to the WhatsApp connection ONLY: the session manager hands these
  // to the one makeWASocket() call (src/core/proxy.js). The control panel, the
  // AI providers and every other outbound request are untouched.
  //
  // None of these apply to a socket that is already open — the Connection
  // screen offers "Reconnect to apply" instead of dropping a healthy session
  // the moment somebody opens Settings.
  {
    key: "whatsapp_proxy_enabled",
    type: "bool",
    default: false,
    group: "whatsapp",
    label: "Route WhatsApp through a proxy",
    hint: "Off means WhatsApp connects directly, exactly as before.",
  },
  {
    key: "whatsapp_proxy_protocol",
    type: "string",
    default: "http",
    choices: ["http", "https", "socks5"],
    group: "whatsapp",
    label: "Proxy protocol",
  },
  {
    key: "whatsapp_proxy_host",
    type: "string",
    default: "",
    group: "whatsapp",
    label: "Proxy host",
    hint: "Hostname or IP of the proxy server. Required when the proxy is on.",
  },
  {
    key: "whatsapp_proxy_port",
    type: "int",
    default: 0,
    min: 0,
    max: 65535,
    group: "whatsapp",
    label: "Proxy port",
  },
  {
    key: "whatsapp_proxy_username",
    type: "string",
    default: "",
    group: "whatsapp",
    label: "Proxy username",
    hint: "Leave empty for a proxy that needs no authentication.",
  },
  {
    key: "whatsapp_proxy_password",
    type: "secret",
    default: "",
    group: "whatsapp",
    label: "Proxy password",
    hint: "Stored like an API key: never sent back to this page, never logged.",
  },

  // --- Server ------------------------------------------------------------
  {
    key: "port",
    type: "int",
    default: 3001,
    min: 1,
    max: 65535,
    group: "server",
    label: "Control panel port",
    hint: "Takes effect on the next start — and only inside the bot. Under Docker or behind a reverse proxy, change the mapping there instead.",
    restart: true,
  },
  {
    key: "trust_proxy",
    type: "string",
    default: "",
    group: "server",
    label: "Proxy hops in front",
    hint: 'Number of proxies (nginx = "1"). Leave empty when the panel is reachable directly — a wrong value lets a client forge its address.',
    restart: true,
  },
  {
    key: "public_domain",
    type: "string",
    default: "",
    group: "server",
    label: "Public domain",
    hint: "Set by `levix domain`. When present it is the address the bot prints and the panel calls home.",
  },
  {
    key: "bind_address",
    type: "string",
    default: "",
    group: "server",
    label: "Bind address",
    hint: "Empty = every interface. `levix domain` sets 127.0.0.1 once a reverse proxy is in front, so nobody can reach the panel past the certificate.",
    restart: true,
  },
  {
    key: "dashboard_origin",
    type: "string",
    default: "",
    group: "server",
    label: "Extra allowed origin",
    hint: "Only if you open the panel from a different domain, e.g. https://bot.example.com.",
  },
  {
    key: "forward_score_ttl_days",
    type: "int",
    default: 30,
    min: 1,
    max: 365,
    group: "server",
    label: "Forward counters kept (days)",
    hint: "How long the !score counters survive. They gain a row per forwarded message.",
  },
];

const BY_KEY = new Map(SETTINGS.map((definition) => [definition.key, definition]));

const GROUP_LABELS = {
  general: "General",
  ai: "AI",
  integrations: "Integrations",
  media: "Media",
  server: "Server",
  whatsapp: "WhatsApp proxy",
};

// This module is required by files that load before the database is opened in
// a few edge paths (a command file pulled in by a script, say), so a read that
// comes too early falls back to the default instead of throwing.
function storedValue(key) {
  try {
    const value = require("../utils/storage.cjs").getBotSetting(
      `setting:${key}`,
      undefined
    );
    return value === undefined || value === null ? undefined : value;
  } catch {
    return undefined;
  }
}

function coerce(definition, raw) {
  switch (definition.type) {
    case "int": {
      const number = Number(raw);
      if (!Number.isFinite(number)) return definition.default;
      return Math.trunc(number);
    }
    case "bool": {
      if (typeof raw === "boolean") return raw;
      const text = String(raw).trim().toLowerCase();
      if (["false", "off", "0", "no"].includes(text)) return false;
      if (["true", "on", "1", "yes"].includes(text)) return true;
      return definition.default;
    }
    default:
      return String(raw);
  }
}

/** The value in force for `key`: what the dashboard saved, else the default. */
function get(key) {
  const definition = BY_KEY.get(key);
  if (!definition) throw new Error(`Unknown setting: ${key}`);

  const stored = storedValue(key);
  if (stored !== undefined && stored !== "") return coerce(definition, stored);

  return definition.default;
}

/** Where the value in force came from — shown next to each field in the UI. */
function sourceOf(key) {
  const stored = storedValue(key);
  return stored !== undefined && stored !== "" ? "dashboard" : "default";
}

function validate(definition, value) {
  if (definition.type === "int") {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`${definition.label} must be a number`);
    if (definition.min !== undefined && number < definition.min) {
      throw new Error(`${definition.label} must be ${definition.min} or more`);
    }
    if (definition.max !== undefined && number > definition.max) {
      throw new Error(`${definition.label} must be ${definition.max} or less`);
    }
    return Math.trunc(number);
  }

  if (definition.type === "bool") return coerce(definition, value);

  const text = String(value ?? "").trim();

  // A fixed set of values (the proxy protocol) is still a string setting; the
  // list is what makes the dashboard render a dropdown and what stops a
  // hand-crafted PATCH from storing something the code cannot act on.
  if (definition.choices && text && !definition.choices.includes(text)) {
    throw new Error(`${definition.label} must be one of: ${definition.choices.join(", ")}`);
  }

  if (text.length > 500) throw new Error(`${definition.label} is too long`);
  if (definition.key === "bot_timezone" && text) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: text });
    } catch {
      throw new Error(`"${text}" is not a valid timezone`);
    }
  }
  return text;
}

/**
 * Save one setting. An empty string clears the override, so the value falls
 * back to the default again.
 * @throws {Error} on an unknown key or a value that fails validation.
 */
function set(key, value) {
  const definition = BY_KEY.get(key);
  if (!definition) throw new Error(`Unknown setting: ${key}`);

  const storage = require("../utils/storage.cjs");

  if (value === null || value === "" || value === undefined) {
    storage.deleteBotSetting(`setting:${key}`);
    logger.info(`[settings] ${key} cleared (back to the default)`);
    return get(key);
  }

  const clean = validate(definition, value);
  storage.saveBotSetting(`setting:${key}`, clean);
  // Never log the value of a secret.
  logger.info(
    `[settings] ${key} -> ${definition.type === "secret" ? "(updated)" : clean}`
  );
  return get(key);
}

/**
 * Everything the settings screen renders. Secrets report only whether they are
 * configured and where they came from — the value itself never goes out.
 */
function describe() {
  return SETTINGS.map((definition) => {
    const base = {
      key: definition.key,
      type: definition.type,
      group: definition.group,
      groupLabel: GROUP_LABELS[definition.group] || definition.group,
      label: definition.label,
      hint: definition.hint || null,
      min: definition.min ?? null,
      max: definition.max ?? null,
      choices: definition.choices ?? null,
      restart: definition.restart === true,
      source: sourceOf(definition.key),
    };

    if (definition.type === "secret") {
      return { ...base, configured: !!get(definition.key), value: null };
    }
    return { ...base, value: get(definition.key), default: definition.default };
  });
}

module.exports = { get, set, describe, sourceOf, SETTING_KEYS: [...BY_KEY.keys()] };

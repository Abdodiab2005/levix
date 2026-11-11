// The one message envelope. Routes, the panel and a future Plus pack address
// a reply by `messageKey` (the i18n catalog key). They do not pass a finished
// string through a second interpreter.
//
// Sensitivity and category decide what a route is allowed to carry. A render
// hook may replace eligible text. It cannot change the destination: the
// router never reads the hook.

const settings = require("../config/settings.cjs");
const { t } = require("../utils/i18n.cjs");
const { escapeParam } = require("./escape.cjs");

const CATEGORIES = Object.freeze(["progress", "result", "error", "security", "system"]);
const SENSITIVITIES = Object.freeze(["operational", "source", "secret"]);

// Exact-output commands must not gain a watermark or a rewritten sentence.
const EXACT_OUTPUT = new Set([
  "calc",
  "rand",
  "translate",
  "md",
  "digit",
  "qr",
  "loop",
  "poll",
  "ping",
  "stt",
  "send",
  "shortlink",
]);

const CATEGORY_DEFAULTS = Object.freeze({
  progress: { sensitivity: "operational", hideable: true },
  result: { sensitivity: "source", hideable: false },
  error: { sensitivity: "operational", hideable: false },
  security: { sensitivity: "secret", hideable: false },
  system: { sensitivity: "operational", hideable: false },
});

const WATERMARK_LIMIT = 4096;
const hooks = { renderText: null };

function setRenderHook(fn) {
  hooks.renderText = typeof fn === "function" ? fn : null;
}

/**
 * @param {object} fields
 * @returns {Readonly<object>}
 */
function createMessage(fields = {}) {
  const category = CATEGORIES.includes(fields.category) ? fields.category : "result";
  const defaults = CATEGORY_DEFAULTS[category];
  const sensitivity = SENSITIVITIES.includes(fields.sensitivity)
    ? fields.sensitivity
    : defaults.sensitivity;
  const context = fields.context || {};
  return Object.freeze({
    messageKey: typeof fields.messageKey === "string" ? fields.messageKey : "",
    category,
    parameters: Object.freeze({ ...(fields.parameters || {}) }),
    context: Object.freeze({
      sourceChat: context.sourceChat || null,
      requester: context.requester || null,
      command: context.command || null,
    }),
    sensitivity,
    deliveryPolicy: Object.freeze({
      hideable: fields.deliveryPolicy?.hideable === true && defaults.hideable,
      terminal: fields.deliveryPolicy?.terminal === true,
      exact: fields.deliveryPolicy?.exact === true,
      exception: fields.deliveryPolicy?.exception || null,
    }),
  });
}

function renderMessage(message) {
  const params = {};
  for (const [key, value] of Object.entries(message?.parameters || {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    params[key] = escapeParam(value);
  }
  let text = t(message.messageKey, params);
  if (hooks.renderText) {
    try {
      const next = hooks.renderText(message, text);
      if (typeof next === "string" && next.length <= WATERMARK_LIMIT) text = next;
    } catch {
      // A hook that throws leaves the catalog text in place.
    }
  }
  return stampWatermark(text, {
    commandName: message.context?.command,
    category: message.category,
    exact: message.deliveryPolicy?.exact === true || message.sensitivity === "secret",
  });
}

/**
 * The only watermark call site. Eligible result text gains one short line
 * when the operator turns `message_watermark` on. Security, errors, files
 * and exact-output commands stay as they are.
 */
function stampWatermark(text, { commandName, category = "result", exact = false } = {}) {
  if (typeof text !== "string" || !text) return text;
  if (exact || category !== "result") return text;
  if (commandName && EXACT_OUTPUT.has(commandName)) return text;
  try {
    if (require("../extensions/host.cjs").host.hideWatermark({ command: commandName, category })) {
      return text;
    }
  } catch {}
  if (!settings.get("message_watermark")) return text;
  const mark = t("bot.core.message.watermark");
  if (!mark || text.includes(mark)) return text;
  const next = `${text}\n${mark}`;
  if (next.length > WATERMARK_LIMIT) return text;
  return next;
}

function categoryDefaults(category) {
  return CATEGORY_DEFAULTS[category] || CATEGORY_DEFAULTS.result;
}

module.exports = {
  CATEGORIES,
  SENSITIVITIES,
  EXACT_OUTPUT,
  CATEGORY_DEFAULTS,
  createMessage,
  renderMessage,
  stampWatermark,
  escapeParam,
  setRenderHook,
  categoryDefaults,
};

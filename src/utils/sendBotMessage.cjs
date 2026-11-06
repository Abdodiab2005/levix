// CommonJS shim around sendBotMessage.esm.js so .cjs commands can use it.
// We lazy-import the ESM module on first call and cache the resolved exports.

const { t } = require("./i18n.cjs");

let cached = null;

async function getModule() {
  if (cached) return cached;
  cached = await import("./sendBotMessage.esm.js");
  return cached;
}

async function sendBotMessage(sock, jid, content, options = {}) {
  // Import, cancellation, routing and send errors must propagate. A raw retry
  // could duplicate delivery or bypass the failed helper's safety checks.
  const mod = await getModule();
  return mod.sendBotMessage(sock, jid, content, options);
}

async function sendBotError(
  sock,
  jid,
  err,
  lead = t("bot.core.sendBotMessage.defaultLead"),
  options = {},
) {
  const mod = await getModule();
  return mod.sendBotError(sock, jid, err, lead, options);
}

module.exports = { sendBotMessage, sendBotError };

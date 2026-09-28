// CommonJS shim around sendBotMessage.esm.js so .cjs commands can use it.
// We lazy-import the ESM module on first call and cache the resolved exports.

const logger = require("./logger.cjs");
const { tr } = require("./i18n.cjs");

let cached = null;

async function getModule() {
  if (cached) return cached;
  cached = await import("./sendBotMessage.esm.js");
  return cached;
}

async function sendBotMessage(sock, jid, content, options = {}) {
  try {
    const mod = await getModule();
    return await mod.sendBotMessage(sock, jid, content, options);
  } catch (err) {
    logger.error({ err }, "[sendBotMessage.cjs] fell back to raw sendMessage");
    const opts = {};
    if (options?.quote !== false) {
      const quoted = options?.quoted || options?.replyTo;
      if (quoted) opts.quoted = quoted;
    }
    return sock.sendMessage(jid, content, opts);
  }
}

async function sendBotError(sock, jid, err, lead = tr("Something went wrong", "حدث خطأ"), options = {}) {
  try {
    const mod = await getModule();
    return await mod.sendBotError(sock, jid, err, lead, options);
  } catch (innerErr) {
    logger.error({ err: innerErr }, "[sendBotMessage.cjs] error helper failed");
    const name = err?.name || "Error";
    const message = err?.message || String(err);
    return sock.sendMessage(jid, {
      text: tr(
        `❌ *${lead}*\n\n*Type:* \`${name}\`\n*Details:* ${message}`,
        `❌ *${lead}*\n\n*النوع:* \`${name}\`\n*التفاصيل:* ${message}`,
      ),
    });
  }
}

module.exports = { sendBotMessage, sendBotError };

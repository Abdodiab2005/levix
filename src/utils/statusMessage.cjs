// One live message per command, edited in place.
//
// Commands used to narrate their work with a stream of separate messages
// ("🔍 جاري التحليل...", "🎬 جاري التحميل...", "📦 الملف كبير..."), which buries
// the chat. WhatsApp supports editing a message you sent, so a command can
// instead post ONE line and rewrite it as it progresses:
//
//   const status = await createStatus(sock, jid, "🔍 بحلل الرابط...", { replyTo: msg });
//   await status.update("🎬 بنزّل الفيديو...");
//   await status.finish("✅ اتبعت — 12.3 MB");
//
// Everything here is best-effort: a failed edit never breaks the command. If
// the message is too old to edit (WhatsApp only allows it for a while) or the
// edit is rejected, we fall back to a normal send and keep going.

const logger = require("./logger.cjs");
const { sendBotMessage } = require("./sendBotMessage.cjs");

// WhatsApp tolerates a few edits per message; spacing them out keeps the
// server happy and the animation readable.
const MIN_EDIT_GAP_MS = 600;

function sleep(ms) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class StatusMessage {
  constructor(sock, jid, options = {}) {
    this.sock = sock;
    this.jid = jid;
    this.replyTo = options.replyTo || null;
    this.quote = options.quote !== false;
    this.key = null;
    this.text = "";
    this.lastEditAt = 0;
    this.closed = false;
  }

  async start(text) {
    this.text = text;
    try {
      const sent = await sendBotMessage(
        this.sock,
        this.jid,
        { text },
        { replyTo: this.replyTo, quote: this.quote, typing: false, delayMs: 0 }
      );
      this.key = sent?.key || null;
      this.lastEditAt = Date.now();
    } catch (err) {
      logger.warn({ err: err?.message }, "[status] initial send failed");
      this.key = null;
    }
    return this;
  }

  /** Rewrite the line. Identical text is skipped so we don't burn an edit. */
  async update(text, { force = false } = {}) {
    if (this.closed && !force) return false;
    const next = String(text || "").trim();
    if (!next || next === this.text) return false;

    // No message to edit (initial send failed) — send one and adopt it.
    if (!this.key) return this._sendFresh(next);

    const wait = MIN_EDIT_GAP_MS - (Date.now() - this.lastEditAt);
    if (wait > 0) await sleep(wait);

    try {
      // `quoted: null` on purpose: the command handler wraps sock.sendMessage
      // and auto-quotes anything that doesn't set it, and an edit/delete is a
      // protocolMessage — there is nowhere to hang a contextInfo.
      await this.sock.sendMessage(
        this.jid,
        { text: next, edit: this.key },
        { quoted: null }
      );
      this.text = next;
      this.lastEditAt = Date.now();
      return true;
    } catch (err) {
      logger.debug({ err: err?.message }, "[status] edit failed — sending instead");
      return this._sendFresh(next);
    }
  }

  async _sendFresh(text) {
    try {
      const sent = await sendBotMessage(
        this.sock,
        this.jid,
        { text },
        { replyTo: this.replyTo, quote: this.quote, typing: false, delayMs: 0 }
      );
      this.key = sent?.key || null;
      this.text = text;
      this.lastEditAt = Date.now();
      return true;
    } catch (err) {
      logger.warn({ err: err?.message }, "[status] fallback send failed");
      return false;
    }
  }

  /** Last update for this run. Always delivered, even if an edit is refused. */
  async finish(text) {
    const ok = await this.update(text, { force: true });
    this.closed = true;
    return ok;
  }

  /** Turn the line into the standard error card. */
  async fail(err, arabicLead = "حصلت مشكلة") {
    const name = err?.name || "Error";
    const message = err?.message || String(err || "غير معروف");
    return this.finish(
      `❌ *${arabicLead}*\n\n*النوع:* \`${name}\`\n*التفاصيل:* ${message}`.slice(0, 1500)
    );
  }

  /** Remove the status line entirely (used when the result speaks for itself). */
  async remove() {
    this.closed = true;
    if (!this.key) return false;
    try {
      await this.sock.sendMessage(
        this.jid,
        { delete: this.key },
        { quoted: null }
      );
      this.key = null;
      return true;
    } catch (err) {
      logger.debug({ err: err?.message }, "[status] delete failed");
      return false;
    }
  }
}

/**
 * Post the first status line and hand back the handle used to rewrite it.
 *
 * @param {object} sock
 * @param {string} jid
 * @param {string} text                initial line
 * @param {object} [options]
 * @param {object} [options.replyTo]   message to quote
 * @param {boolean}[options.quote]     set false to not quote anything
 * @returns {Promise<StatusMessage>}
 */
async function createStatus(sock, jid, text, options = {}) {
  return new StatusMessage(sock, jid, options).start(text);
}

/**
 * A status handle that does nothing — lets helpers take an optional status
 * without every call site guarding for null.
 */
function nullStatus() {
  return {
    key: null,
    text: "",
    async update() {
      return false;
    },
    async finish() {
      return false;
    },
    async fail() {
      return false;
    },
    async remove() {
      return false;
    },
  };
}

module.exports = { createStatus, nullStatus, StatusMessage };

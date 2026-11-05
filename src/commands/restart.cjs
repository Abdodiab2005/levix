// Restarts the WhatsApp connection — not the process.
//
// It used to SIGTERM the whole bot and lean on the supervisor to bring it
// back, which took the control panel down with the socket. What people mean
// by restart here is the connection: session.reconnect() is the same
// stop()+start() the panel's Connection screen uses, so the state machine
// stays the only socket owner and a restart never kicks whoever is watching
// the panel out.
const { getSession } = require("../core/session-holder.cjs");
const logger = require("../utils/logger.cjs");
const { t } = require("../utils/i18n.cjs");
const { createStatus } = require("../utils/statusMessage.cjs");

module.exports = {
  name: "restart",
  chat: "all",

  async execute(sock, msg) {
    const chatId = msg.key.remoteJid;
    const session = getSession();
    if (!session) {
      return await sock.sendMessage(chatId, {
        text: t("bot.core.restart.notReady"),
      });
    }

    // Goes out while the current socket is still alive. This line is the
    // result of asking for a restart, so hiding progress cannot swallow it.
    const status = await createStatus(sock, chatId, t("bot.core.restart.reconnecting"), {
      replyTo: msg,
      category: "system",
    });

    let state = null;
    try {
      state = await session.reconnect({ reason: "command" });
      logger.info("[commands] WhatsApp connection restarted by !restart");
    } catch (error) {
      logger.error({ err: error, command: "restart" }, "Failed to reconnect WhatsApp");
    }

    const done = state?.connected
      ? t("bot.core.restart.backOnline")
      : t("bot.core.restart.stateNow", {
          status: state?.status || t("bot.core.restart.unknownState"),
        });
    // The socket may already be gone. The edit is best-effort.
    await status.finish(done).catch(() => {});
  },
};

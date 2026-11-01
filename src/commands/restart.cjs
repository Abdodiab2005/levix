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

    // Goes out while the current socket is still alive.
    await sock.sendMessage(chatId, {
      text: t("bot.core.restart.reconnecting"),
    });

    let state = null;
    try {
      state = await session.reconnect({ reason: "command" });
      logger.info("[commands] WhatsApp connection restarted by !restart");
    } catch (error) {
      logger.error({ err: error, command: "restart" }, "Failed to reconnect WhatsApp");
    }

    if (state?.connected) {
      await sock.sendMessage(chatId, {
        text: t("bot.core.restart.backOnline"),
      });
    } else {
      // Not connected (a QR wait, a retry, a failure) — say where things
      // stand instead of claiming success. The old socket is gone either way,
      // so this send is best-effort.
      await sock
        .sendMessage(chatId, {
          text: t("bot.core.restart.stateNow", {
            status: state?.status || t("bot.core.restart.unknownState"),
          }),
        })
        .catch(() => {});
    }
  },
};

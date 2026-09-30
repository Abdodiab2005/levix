// Pauses the WhatsApp connection without touching the process.
//
// It replaced `!shutdown`, which shelled out to `pm2 stop` — a command from an
// install shape Levix outgrew, and one that took the control panel down with
// the bot. This is the panel's own "Stop" from inside a chat: the same state
// machine call, pairing kept, panel up, no retry afterwards. Resuming is the
// Connection screen — once the socket is down no message can arrive, so there
// is no way to type a start command.
const { getSession } = require("../core/session-holder.cjs");
const logger = require("../utils/logger.cjs");
const { tr } = require("../utils/i18n.cjs");

module.exports = {
  name: "stopbot",
  aliases: ["stop", "pause"],
  description: {
    en: "Pauses the WhatsApp connection (the bot process and panel keep running).",
    ar: "يوقف اتصال واتساب مؤقتًا (مع استمرار تشغيل البوت ولوحة التحكم).",
  },
  usage: {
    en: "stopbot",
    ar: "stopbot",
  },
  chat: "all",

  async execute(sock, msg) {
    const chatId = msg.key.remoteJid;
    const session = getSession();
    if (!session) {
      return await sock.sendMessage(chatId, {
        text: tr("The session manager isn't ready yet.", "مدير الجلسة غير جاهز بعد."),
      });
    }

    const state = session.getState();
    if (!state.connected && !state.canStop) {
      return await sock.sendMessage(chatId, {
        text: tr(
          "The WhatsApp connection isn't up — nothing to pause.",
          "اتصال واتساب متوقف بالفعل.",
        ),
      });
    }

    // The goodbye goes out before the socket comes down: once stop() runs,
    // nothing can be sent through this chat until the session starts again.
    await sock.sendMessage(chatId, {
      text: tr(
        "⏸️ Pausing the WhatsApp connection. The bot and the control panel stay up — resume from the Connection screen in the panel.",
        "⏸️ جارٍ إيقاف اتصال واتساب مؤقتًا. سيستمر تشغيل البوت ولوحة التحكم. يمكنك استئناف الاتصال من صفحة الاتصال في لوحة التحكم.",
      ),
    });

    try {
      await session.stop({ reason: "command" });
      logger.warn("[commands] WhatsApp connection paused by !stopbot");
    } catch (error) {
      logger.error({ err: error, command: "stopbot" }, "Failed to pause the WhatsApp connection");
      // The socket may still be up, so the operator can actually read this.
      await sock.sendMessage(chatId, {
        text: tr(
          "Couldn't pause the connection. Try the panel's Connection screen.",
          "تعذّر إيقاف الاتصال. حاول من صفحة الاتصال في لوحة التحكم.",
        ),
      });
    }
  },
};

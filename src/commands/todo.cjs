// file: /commands/todo.cjs (Corrected Reply Logic)
const { getUserTodos, saveUserTodos } = require("../utils/storage.cjs");
const logger = require("../utils/logger.cjs");
const { t } = require("../utils/i18n.cjs");
const normalizeJid = require("../utils/normalizeJid.esm.js").default;

module.exports = {
  name: "todo",
  chat: "all",

  async execute(sock, msg, args) {
    try {
      const senderId = normalizeJid(msg.key.participant || msg.key.remoteJid);
      const remoteJid = msg.key.remoteJid; // The chat where the command was sent
      const subCommand = args[0] ? args[0].toLowerCase() : "list";

      const userTasks = getUserTodos(senderId);

      switch (subCommand) {
        case "add": {
          const taskToAdd = args.slice(1).join(" ");
          if (!taskToAdd) {
            return await sock.sendMessage(remoteJid, {
              text: t("bot.tools.todo.writeTask"),
            });
          }
          userTasks.push(taskToAdd);
          saveUserTodos(senderId, userTasks);
          await sock.sendMessage(remoteJid, {
            text: t("bot.tools.todo.added", { user: senderId.split("@")[0] }),
            mentions: [senderId],
          });
          break;
        }

        case "remove":
        case "del": {
          const taskNumber = parseInt(args[1], 10);
          if (isNaN(taskNumber) || taskNumber <= 0 || taskNumber > userTasks.length) {
            return await sock.sendMessage(remoteJid, {
              text: t("bot.tools.todo.invalidNumber"),
            });
          }
          const removedTask = userTasks.splice(taskNumber - 1, 1);
          saveUserTodos(senderId, userTasks);
          await sock.sendMessage(remoteJid, {
            text: t("bot.tools.todo.removed", {
              user: senderId.split("@")[0],
              task: removedTask[0],
            }),
            mentions: [senderId],
          });
          break;
        }

        case "list":
        default: {
          if (userTasks.length === 0) {
            return await sock.sendMessage(remoteJid, {
              text: t("bot.tools.todo.empty", { user: senderId.split("@")[0] }),
              mentions: [senderId],
            });
          }

          let reply = t("bot.tools.todo.listHeader", { user: senderId.split("@")[0] });
          userTasks.forEach((task, index) => {
            reply += `${index + 1}. ${task}\n`;
          });

          await sock.sendMessage(remoteJid, {
            text: reply,
            mentions: [senderId],
          });
          break;
        }
      }
    } catch (error) {
      logger.error({ err: error, command: "todo" }, "An error occurred in the todo command");
      await sock.sendMessage(msg.key.remoteJid, {
        text: t("bot.tools.todo.error"),
      });
    }
  },
};

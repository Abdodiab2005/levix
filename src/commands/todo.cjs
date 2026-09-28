// file: /commands/todo.cjs (Corrected Reply Logic)
const { getUserTodos, saveUserTodos } = require("../utils/storage.cjs");
const logger = require("../utils/logger.cjs");
const { tr } = require("../utils/i18n.cjs");
const normalizeJid = require("../utils/normalizeJid.esm.js").default;

module.exports = {
  name: "todo",
  description: {
    en: "Manages your personal to-do list.",
    ar: "يدير قائمة مهامك الشخصية.",
  },
  usage: {
    en: "todo list\ntodo add <task>\ntodo del <task number>",
    ar: "todo list\ntodo add <المهمة>\ntodo del <رقم المهمة>",
  },
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
              text: tr("Write the task you want to add.", "يرجى كتابة المهمة التي تريد إضافتها."),
            });
          }
          userTasks.push(taskToAdd);
          saveUserTodos(senderId, userTasks);
          await sock.sendMessage(remoteJid, {
            text: tr(
              `✅ @${senderId.split("@")[0]}, the task was added to your list.`,
              `✅ يا @${senderId.split("@")[0]}، تمت إضافة المهمة لقائمتك.`,
            ),
            mentions: [senderId],
          });
          break;
        }

        case "remove":
        case "del": {
          const taskNumber = parseInt(args[1], 10);
          if (isNaN(taskNumber) || taskNumber <= 0 || taskNumber > userTasks.length) {
            return await sock.sendMessage(remoteJid, {
              text: tr("That task number isn't valid.", "رقم المهمة غير صالح."),
            });
          }
          const removedTask = userTasks.splice(taskNumber - 1, 1);
          saveUserTodos(senderId, userTasks);
          await sock.sendMessage(remoteJid, {
            text: tr(
              `☑️ @${senderId.split("@")[0]}, removed the task: *${removedTask[0]}*`,
              `☑️ يا @${senderId.split("@")[0]}، تم حذف المهمة: *${removedTask[0]}*`,
            ),
            mentions: [senderId],
          });
          break;
        }

        case "list":
        default: {
          if (userTasks.length === 0) {
            return await sock.sendMessage(remoteJid, {
              text: tr(
                `Your to-do list is empty, @${senderId.split("@")[0]}.`,
                `قائمة مهامك فارغة يا @${senderId.split("@")[0]}.`,
              ),
              mentions: [senderId],
            });
          }

          let reply = tr(
            `*📋 Your to-do list, @${senderId.split("@")[0]}:*\n\n`,
            `*📋 قائمة مهامك يا @${senderId.split("@")[0]}:*\n\n`,
          );
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
        text: tr(
          "Something went wrong with the to-do list.",
          "حدث خطأ أثناء معالجة قائمة المهام.",
        ),
      });
    }
  },
};

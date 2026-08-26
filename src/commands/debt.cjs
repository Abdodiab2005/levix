// file: /commands/debt.cjs
// Aliased on import: the command's own helpers below are named addDebt /
// listDebts / deleteDebt too.
const {
  addDebt: storeAddDebt,
  getDebt: storeGetDebt,
  deleteDebt: storeDeleteDebt,
  listDebts: storeListDebts,
} = require("../utils/storage.cjs");
const logger = require("../utils/logger.cjs");
const normalizeJid = require("../utils/normalizeJid.esm.js").default;

module.exports = {
  name: "debt",
  aliases: ["دين", "owes"],
  description: "Private debt tracking system",
  usage: "debt add <المبلغ> [الوصف]\ndebt del <id>\ndebt list",
  chat: "private",

  async execute(sock, msg, args) {
    const remote = msg.key.remoteJid;
    const senderId = normalizeJid(msg.key.participant || remote);

    // private chat: the person you're talking to
    const targetId = normalizeJid(msg.key.remoteJidAlt);
    const chatKey = "private-" + targetId;

    const sub = (args[0] || "").toLowerCase();

    switch (sub) {
      case "add":
      case "اضافة":
        await addDebt(sock, msg, args.slice(1), senderId, targetId, chatKey);
        break;

      case "del":
      case "حذف":
        await deleteDebt(sock, msg, args.slice(1), senderId, targetId, chatKey);
        break;

      case "list":
      case "قائمة":
        await listDebts(sock, msg, senderId, targetId, chatKey);
        break;

      default:
        await sock.sendMessage(remote, {
          text:
            `📊 *نظام الديون (خاص فقط)*\n\n` +
            `الأوامر:\n\n` +
            `• \`!debt add <amount> [description]\` — إضافة دين\n` +
            `• \`!debt list\` — عرض الديون\n` +
            `• \`!debt del <id>\` — حذف دين\n\n` +
            `مثال:\n\`!debt add 50 غداء\``,
        });
    }
  },
};

async function addDebt(sock, msg, args, creditorId, debtorId, chatKey) {
  const remote = msg.key.remoteJid;

  if (args.length < 1) {
    return sock.sendMessage(remote, {
      text: "❌ الاستخدام: `!debt add <amount> [description]`",
    });
  }

  const amount = parseFloat(args[0]);
  const description = args.slice(1).join(" ") || "بدون وصف";

  if (isNaN(amount) || amount <= 0) {
    return sock.sendMessage(remote, {
      text: "❌ المبلغ يجب أن يكون رقم موجب",
    });
  }

  try {
    const debt = storeAddDebt({
      groupId: chatKey,
      debtorId,
      creditorId,
      amount,
      description,
    });

    await sock.sendMessage(remote, {
      text:
        `✅ *تم إضافة الدين*\n\n` +
        `المدين: ${debtorId.split("@")[0]}\n` +
        `الدائن: ${creditorId.split("@")[0]}\n` +
        `المبلغ: ${amount}\n` +
        `الوصف: ${description}\n` +
        `رقم السجل: #${debt.id}`,
    });
  } catch (err) {
    logger.error(err, "[Debt] Add error:");
    await sock.sendMessage(remote, {
      text: "❌ حدث خطأ أثناء تسجيل الدين",
    });
  }
}

async function listDebts(sock, msg, creditorId, debtorId, chatKey) {
  const remote = msg.key.remoteJid;

  try {
    const debts = storeListDebts(chatKey, { settled: false });

    if (debts.length === 0) {
      return sock.sendMessage(remote, { text: "لا توجد ديون حالياً ✅" });
    }

    let text = "📋 *قائمة الديون:*\n\n";

    debts.forEach((d) => {
      const date = new Date(d.created_at).toLocaleDateString("ar-EG");
      text += `*#${d.id}*\n`;
      text += `المدين: ${d.debtor_id.split("@")[0]}\n`;
      text += `الدائن: ${d.creditor_id.split("@")[0]}\n`;
      text += `المبلغ: ${d.amount}\n`;
      text += `الوصف: ${d.description}\n`;
      text += `التاريخ: ${date}\n\n`;
    });

    await sock.sendMessage(remote, { text });
  } catch (err) {
    logger.error(err, "[Debt] List error:");
    await sock.sendMessage(remote, {
      text: "❌ حدث خطأ أثناء عرض الديون",
    });
  }
}

async function deleteDebt(sock, msg, args, creditorId, debtorId, chatKey) {
  const remote = msg.key.remoteJid;

  if (args.length < 1) {
    return sock.sendMessage(remote, {
      text: "❌ الاستخدام: `!debt del <id>`",
    });
  }

  const id = parseInt(args[0]);
  if (isNaN(id)) {
    return sock.sendMessage(remote, {
      text: "❌ رقم السجل غير صحيح",
    });
  }

  try {
    const debt = storeGetDebt(id);

    if (!debt) {
      return sock.sendMessage(remote, { text: "❌ لم يتم العثور على الدين" });
    }

    if (debt.group_id !== chatKey) {
      return sock.sendMessage(remote, {
        text: "❌ هذا الدين لا يخص هذه المحادثة",
      });
    }

    storeDeleteDebt(id);

    await sock.sendMessage(remote, {
      text: `🗑️ تم حذف الدين رقم #${id} بنجاح`,
    });
  } catch (err) {
    logger.error(err, "[Debt] Del error:");
    await sock.sendMessage(remote, {
      text: "❌ حدث خطأ أثناء حذف الدين",
    });
  }
}

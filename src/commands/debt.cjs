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
const { t, tr } = require("../utils/i18n.cjs");
const normalizeJid = require("../utils/normalizeJid.esm.js").default;

module.exports = {
  name: "debt",
  aliases: ["دين", "owes"],
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
          text: tr(
            `📊 *Debt tracker (private chats only)*\n\n` +
              `Commands:\n\n` +
              `• \`!debt add <amount> [description]\` — add a debt\n` +
              `• \`!debt list\` — list debts\n` +
              `• \`!debt del <id>\` — delete a debt\n\n` +
              `Example:\n\`!debt add 50 lunch\``,
            `📊 *نظام الديون (خاص فقط)*\n\n` +
              `الأوامر:\n\n` +
              `• \`!debt add <amount> [description]\` — إضافة دين\n` +
              `• \`!debt list\` — عرض الديون\n` +
              `• \`!debt del <id>\` — حذف دين\n\n` +
              `مثال:\n\`!debt add 50 غداء\``,
          ),
        });
    }
  },
};

async function addDebt(sock, msg, args, creditorId, debtorId, chatKey) {
  const remote = msg.key.remoteJid;

  if (args.length < 1) {
    return sock.sendMessage(remote, {
      text: tr(
        "❌ Usage: `!debt add <amount> [description]`",
        "❌ الاستخدام: `!debt add <amount> [description]`",
      ),
    });
  }

  const amount = parseFloat(args[0]);
  const description = args.slice(1).join(" ") || t("bot.tools.debt.noDescription");

  if (isNaN(amount) || amount <= 0) {
    return sock.sendMessage(remote, {
      text: t("bot.tools.debt.amountInvalid"),
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
      text: t("bot.tools.debt.added", {
        debtor: debtorId.split("@")[0],
        creditor: creditorId.split("@")[0],
        amount,
        description,
        id: debt.id,
      }),
    });
  } catch (err) {
    logger.error(err, "[Debt] Add error:");
    await sock.sendMessage(remote, {
      text: t("bot.tools.debt.saveError"),
    });
  }
}

async function listDebts(sock, msg, creditorId, debtorId, chatKey) {
  const remote = msg.key.remoteJid;

  try {
    const debts = storeListDebts(chatKey, { settled: false });

    if (debts.length === 0) {
      return sock.sendMessage(remote, { text: t("bot.tools.debt.listEmpty") });
    }

    let text = t("bot.tools.debt.listHeader");

    debts.forEach((d) => {
      const date = new Date(d.created_at).toLocaleDateString(tr("en-GB", "ar-EG"));
      text += `*#${d.id}*\n`;
      text += `${t("bot.tools.debt.debtorLabel")}: ${d.debtor_id.split("@")[0]}\n`;
      text += `${t("bot.tools.debt.creditorLabel")}: ${d.creditor_id.split("@")[0]}\n`;
      text += `${t("bot.tools.debt.amountLabel")}: ${d.amount}\n`;
      text += `${t("bot.tools.debt.descriptionLabel")}: ${d.description}\n`;
      text += `${t("bot.tools.debt.dateLabel")}: ${date}\n\n`;
    });

    await sock.sendMessage(remote, { text });
  } catch (err) {
    logger.error(err, "[Debt] List error:");
    await sock.sendMessage(remote, {
      text: t("bot.tools.debt.listError"),
    });
  }
}

async function deleteDebt(sock, msg, args, creditorId, debtorId, chatKey) {
  const remote = msg.key.remoteJid;

  if (args.length < 1) {
    return sock.sendMessage(remote, {
      text: tr("❌ Usage: `!debt del <id>`", "❌ الاستخدام: `!debt del <id>`"),
    });
  }

  const id = parseInt(args[0]);
  if (isNaN(id)) {
    return sock.sendMessage(remote, {
      text: t("bot.tools.debt.invalidRecord"),
    });
  }

  try {
    const debt = storeGetDebt(id);

    if (!debt) {
      return sock.sendMessage(remote, {
        text: t("bot.tools.debt.notFound"),
      });
    }

    if (debt.group_id !== chatKey) {
      return sock.sendMessage(remote, {
        text: t("bot.tools.debt.wrongChat"),
      });
    }

    storeDeleteDebt(id);

    await sock.sendMessage(remote, {
      text: t("bot.tools.debt.deleted", { id }),
    });
  } catch (err) {
    logger.error(err, "[Debt] Del error:");
    await sock.sendMessage(remote, {
      text: t("bot.tools.debt.deleteError"),
    });
  }
}

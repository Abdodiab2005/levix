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
const { t, currentLang } = require("../utils/i18n.cjs");
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
          text: t("bot.tools.debt.help"),
        });
    }
  },
};

async function addDebt(sock, msg, args, creditorId, debtorId, chatKey) {
  const remote = msg.key.remoteJid;

  if (args.length < 1) {
    return sock.sendMessage(remote, {
      text: t("bot.tools.debt.addUsage"),
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
      // No intlTag helper. en and ar keep the tags tr() used.
      const dateLocales = { en: "en-GB", ar: "ar-EG", "pt-BR": "pt-BR", "es-419": "es-419" };
      const date = new Date(d.created_at).toLocaleDateString(dateLocales[currentLang()] || "en-GB");
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
      text: t("bot.tools.debt.delUsage"),
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

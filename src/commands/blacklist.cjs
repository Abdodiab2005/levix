// file: /commands/blacklist.js (Corrected Logic)
const { getGroupSettings, saveGroupSettings } = require("../utils/storage.cjs");
const logger = require("../utils/logger.cjs");
const normalizeJid = require("../utils/normalizeJid.esm.js").default;
const { isAdminInGroupSync, sameUserSync } = require("../utils/permissions.cjs");
const { tr } = require("../utils/i18n.cjs");

function sameIdentity(a, b) {
  return normalizeJid(a) === normalizeJid(b) || sameUserSync(a, b);
}

module.exports = {
  name: "blacklist",
  aliases: ["unblacklist", "block", "unblock"], // We keep aliases here for a reason
  description: {
    en: "Manages the group's user blacklist.",
    ar: "يدير القائمة السوداء لأعضاء المجموعة.",
  },
  usage: {
    en: "blacklist [add|remove|list] [@member|number]",
    ar: "blacklist [add|remove|list] [@عضو|رقم]",
  },
  chat: "group",
  userAdminRequired: true,

  async execute(sock, msg, args, body, groupMetadata) {
    const groupId = msg.key.remoteJid;
    const command = body.slice(1).trim().split(/ +/)[0].toLowerCase();

    // --- New, smarter action parser ---
    let action;
    // Explicit sub-command like !blacklist list
    if (args[0] && ["add", "remove", "list"].includes(args[0].toLowerCase())) {
      action = args[0].toLowerCase();
      args.shift(); // Remove the action from args, so the rest are the target
    }
    // Action inferred from alias like !block or !unblock
    else if (["blacklist", "block"].includes(command)) {
      action = "add";
    } else if (["unblacklist", "unblock"].includes(command)) {
      action = "remove";
    } else {
      action = "list"; // Default action is to list
    }

    try {
      const settings = getGroupSettings(groupId);
      if (!settings.blacklist) settings.blacklist = [];

      // For list action, no target is needed
      if (action === "list") {
        if (settings.blacklist.length === 0)
          return await sock.sendMessage(groupId, {
            text: tr("The blacklist is empty.", "القائمة السوداء فارغة حاليًا."),
          });

        let listReply = tr(
          "*🚫 Users blocked from the bot:*\n\n",
          "*🚫 قائمة المستخدمين المحظورين من البوت:*\n\n",
        );
        settings.blacklist.forEach((jid) => {
          listReply += `» @${jid.split("@")[0]}\n`;
        });
        return await sock.sendMessage(groupId, {
          text: listReply,
          mentions: settings.blacklist,
        });
      }

      // For add/remove actions, a target is required
      const targetJid =
        msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] ||
        (args[0] ? `${args[0].replace(/\D/g, "")}@s.whatsapp.net` : null);

      if (!targetJid)
        return await sock.sendMessage(groupId, {
          text: tr(
            "Mention the member or type their number to do that.",
            "لتنفيذ هذا الإجراء، قم بعمل منشن للعضو أو كتابة رقمه.",
          ),
        });

      const normalizedTargetJid = normalizeJid(targetJid);

      if (action === "add") {
        const targetIsAdmin =
          isAdminInGroupSync(groupMetadata, normalizedTargetJid) ||
          groupMetadata.participants.some(
            (participant) =>
              participant.admin &&
              [participant.id, participant.lid, participant.phoneNumber, participant.jid]
                .filter(Boolean)
                .some((id) => sameIdentity(id, normalizedTargetJid)),
          );
        if (targetIsAdmin)
          return await sock.sendMessage(groupId, {
            text: tr("Admins can't be blacklisted.", "لا يمكن حظر المشرفين."),
          });
        if (settings.blacklist.some((jid) => sameIdentity(jid, normalizedTargetJid)))
          return await sock.sendMessage(groupId, {
            text: tr(
              `@${normalizedTargetJid.split("@")[0]} is already blacklisted.`,
              `العضو @${normalizedTargetJid.split("@")[0]} محظور بالفعل.`,
            ),
            mentions: [normalizedTargetJid],
          });

        settings.blacklist.push(normalizedTargetJid);
        await sock.sendMessage(groupId, {
          text: tr(
            `🚫 @${normalizedTargetJid.split("@")[0]} was added to the blacklist.`,
            `🚫 تم إضافة @${normalizedTargetJid.split("@")[0]} إلى القائمة السوداء بنجاح.`,
          ),
          mentions: [normalizedTargetJid],
        });
      } else if (action === "remove") {
        if (!settings.blacklist.some((jid) => sameIdentity(jid, normalizedTargetJid)))
          return await sock.sendMessage(groupId, {
            text: tr(
              `@${normalizedTargetJid.split("@")[0]} isn't on the blacklist.`,
              `العضو @${normalizedTargetJid.split("@")[0]} ليس في القائمة السوداء بالفعل.`,
            ),
            mentions: [normalizedTargetJid],
          });

        settings.blacklist = settings.blacklist.filter(
          (jid) => !sameIdentity(jid, normalizedTargetJid),
        );
        await sock.sendMessage(groupId, {
          text: tr(
            `✅ @${normalizedTargetJid.split("@")[0]} was removed from the blacklist.`,
            `✅ تم إزالة @${normalizedTargetJid.split("@")[0]} من القائمة السوداء.`,
          ),
          mentions: [normalizedTargetJid],
        });
      }

      saveGroupSettings(groupId, settings);
    } catch (error) {
      logger.error({ err: error, command: "blacklist" }, "Error in !blacklist command");
    }
  },
};

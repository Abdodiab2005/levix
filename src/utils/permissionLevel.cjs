// What each permission level lets through — the one copy of that rule.
//
// The command dispatcher (middleware/permissions.middleware.js) and the AI
// agent's tools (services/aiToolAuth.cjs) both ask this function, so a command
// and the tool that stands in for it (`!schedule` and create_reminder, say)
// can never drift apart. The level itself comes from runtime-config, which
// means a dashboard change to a command's permission moves both doors at once.
//
// Pure on purpose: who the sender is gets resolved elsewhere (resolveSender()),
// and this only answers "may that sender use something gated at `level`".
// The refusal is worded in the language of the message being answered.

const { tr } = require("./i18n.cjs");

/**
 * @param {string} level - MEMBERS | ALL | OWNER_ONLY | ADMINS_ONLY | ADMINS_OWNER
 * @param {object} subject
 * @param {boolean} subject.isGroup       - the message came from a group
 * @param {boolean} subject.isOwner       - bot owner
 * @param {boolean} subject.isBotAdmin    - bot-level admin (a role, valid in every chat)
 * @param {boolean} subject.isSenderAdmin - bot admin, or admin of this WhatsApp group
 * @returns {{hasPermission: boolean, reason: string, unknownLevel: boolean}}
 */
function evaluatePermissionLevel(level, { isGroup, isOwner, isBotAdmin, isSenderAdmin } = {}) {
  switch (level) {
    case "MEMBERS":
    case "ALL":
      return verdict(true, "");

    case "OWNER_ONLY":
      return verdict(
        Boolean(isOwner),
        tr("🚫 Only the bot owner can use this command.", "🚫 هذا الأمر متاح للمالك فقط."),
      );

    case "ADMINS_ONLY":
      // Owners and bot-admins can run admin-only commands from anywhere —
      // useful for the operator pinging the bot privately to manage a group.
      return isGroup
        ? verdict(
            Boolean(isSenderAdmin || isOwner),
            tr("🚫 Only group admins can use this command.", "🚫 هذا الأمر متاح للمشرفين فقط."),
          )
        : verdict(
            Boolean(isOwner || isBotAdmin),
            tr(
              "⚠️ This command only works in groups (or for the owner in private).",
              "⚠️ هذا الأمر يعمل في المجموعات فقط (أو للمالك في الخاص).",
            ),
          );

    case "ADMINS_OWNER":
      return isGroup
        ? verdict(
            Boolean(isOwner || isSenderAdmin),
            tr(
              "🚫 Only group admins and the owner can use this command.",
              "🚫 هذا الأمر متاح للمشرفين والمالك فقط.",
            ),
          )
        : verdict(
            Boolean(isOwner || isBotAdmin),
            tr(
              "⚠️ This command only works in groups, or for the owner.",
              "⚠️ هذا الأمر يعمل في المجموعات أو للمالك فقط.",
            ),
          );

    default:
      // Fail closed: a level nobody knows how to evaluate lets nobody through.
      return {
        hasPermission: false,
        reason: tr("🚫 Unknown permission level.", "🚫 مستوى الصلاحية غير معروف."),
        unknownLevel: true,
      };
  }
}

function verdict(hasPermission, reason) {
  return { hasPermission, reason, unknownLevel: false };
}

module.exports = { evaluatePermissionLevel };

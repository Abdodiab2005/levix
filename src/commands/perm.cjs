// Bot-level roles: owner and admin.
//
// Two ways to hand out privileges, as the operator asked:
//   * manually — `!perm add admin @حد` (or a reply, or a bare number),
//   * by asking the AI — the agent exposes grant_role/revoke_role and calls
//     into the very same module (utils/permissions.esm.js).
//
// owner : everything, including OWNER_ONLY commands.
// admin : counts as an admin in every chat (group admin OR this role satisfies
//         ADMINS_ONLY / ADMINS_OWNER) — but never OWNER_ONLY.
//
// Roles live in `user_metadata` (is_owner / is_admin) and in the in-memory
// roster, so a grant is effective on the very next message — no restart.

const {
  grantRole,
  revokeRole,
  listRoles,
  isOwnerJidSync,
} = require("../utils/permissions.cjs");
const { sendBotMessage } = require("../utils/sendBotMessage.cjs");
const normalizeJid = require("../utils/normalizeJid.cjs");
const logger = require("../utils/logger.cjs");

const ROLE_WORDS = {
  owner: "owner",
  owners: "owner",
  مالك: "owner",
  المالك: "owner",
  admin: "admin",
  admins: "admin",
  مشرف: "admin",
  ادمن: "admin",
  أدمن: "admin",
};

const ADD_WORDS = new Set(["add", "grant", "set", "give", "اضف", "أضف", "ضيف"]);
const DEL_WORDS = new Set([
  "remove",
  "revoke",
  "del",
  "delete",
  "drop",
  "شيل",
  "احذف",
  "امسح",
]);
const LIST_WORDS = new Set(["list", "ls", "show", "قائمة", "عرض", "الكل"]);

function senderOf(msg) {
  return msg.key.remoteJid?.endsWith("@g.us")
    ? msg.key.participant || msg.key.participantAlt
    : msg.key.remoteJid;
}

/**
 * Work out who the command is about: a mention, a reply, a bare number, or
 * "me". Returns a normalized JID/LID or null.
 */
function resolveTarget(msg, args) {
  const contextInfo =
    msg.message?.extendedTextMessage?.contextInfo ||
    msg.message?.imageMessage?.contextInfo ||
    msg.message?.videoMessage?.contextInfo ||
    null;

  const mentioned = contextInfo?.mentionedJid?.[0];
  if (mentioned) return normalizeJid(mentioned);

  const quotedParticipant =
    contextInfo?.participant || contextInfo?.participantAlt;
  if (quotedParticipant) return normalizeJid(quotedParticipant);

  for (const arg of args) {
    const value = String(arg);
    if (/^(me|انا|أنا|نفسي)$/i.test(value)) return normalizeJid(senderOf(msg));
    if (value.includes("@")) return normalizeJid(value);
    const digits = (value.match(/\d{6,}/) || [])[0];
    if (digits) return `${digits}@s.whatsapp.net`;
  }
  return null;
}

function labelFor(user) {
  const name = user.displayName ? `${user.displayName} — ` : "";
  return `${name}${user.phone || user.jid || user.lid}`;
}

// permissions.cjs bridges to an ESM module, so every non-`Sync` helper here
// is async — awaiting them is not optional.
async function rolesReport() {
  const { owners, admins, bootstrapOwners, bootstrapAdmins } = await listRoles();
  const lines = ["*🔑 صلاحيات البوت*", ""];

  lines.push(`*👑 المالكين (${owners.length}):*`);
  lines.push(
    owners.length ? owners.map((o) => `• ${labelFor(o)}`).join("\n") : "• (مفيش)"
  );

  lines.push("", `*🛡️ الأدمنز (${admins.length}):*`);
  lines.push(
    admins.length ? admins.map((a) => `• ${labelFor(a)}`).join("\n") : "• (مفيش)"
  );

  const envOnly = [
    ...bootstrapOwners.filter(
      (jid) => !owners.some((o) => o.jid === jid || o.lid === jid)
    ),
    ...bootstrapAdmins.filter(
      (jid) => !admins.some((a) => a.jid === jid || a.lid === jid)
    ),
  ];
  if (envOnly.length) {
    lines.push(
      "",
      `_من الإعدادات (env/config): ${[...new Set(envOnly)].length} إدخال._`
    );
  }

  return lines.join("\n");
}

module.exports = {
  name: "perm",
  aliases: ["perms", "owner", "admin", "role", "roles", "صلاحيات"],
  description:
    "إدارة صلاحيات البوت: إضافة/إزالة مالك أو أدمن، وعرض القائمة الحالية.",
  usage:
    "perm list\nperm add admin @عضو\nperm add owner <رقم>\nperm remove admin @عضو",
  chat: "all",

  async execute(sock, msg, args) {
    const jid = msg.key.remoteJid;
    const action = String(args[0] || "").toLowerCase();

    if (!action || LIST_WORDS.has(action)) {
      return sendBotMessage(
        sock,
        jid,
        { text: await rolesReport() },
        { replyTo: msg }
      );
    }

    const isAdd = ADD_WORDS.has(action);
    const isRemove = DEL_WORDS.has(action);
    if (!isAdd && !isRemove) {
      return sendBotMessage(
        sock,
        jid,
        {
          text:
            "استخدام غير صحيح.\n\n" +
            "`!perm list` — القائمة الحالية\n" +
            "`!perm add admin @عضو` — تعيين أدمن\n" +
            "`!perm add owner <رقم>` — تعيين مالك\n" +
            "`!perm remove admin @عضو` — سحب الصلاحية",
        },
        { replyTo: msg }
      );
    }

    // Role word is optional and can sit anywhere; default to admin (the safer
    // of the two) so `!perm add @حد` doesn't hand out ownership by accident.
    let role = "admin";
    for (const arg of args.slice(1)) {
      const word = ROLE_WORDS[String(arg).toLowerCase()];
      if (word) {
        role = word;
        break;
      }
    }

    const target = resolveTarget(msg, args.slice(1));
    if (!target) {
      return sendBotMessage(
        sock,
        jid,
        {
          text:
            "محتاج تحدد الشخص: منشن (@) أو رد على رسالته أو اكتب رقمه.\n" +
            "مثال: `!perm add admin @عضو`",
        },
        { replyTo: msg }
      );
    }

    // Only an owner may create another owner. (Reaching this command at all
    // already requires OWNER_ONLY by default — this is the belt to that
    // brace, and it also guards direct calls from elsewhere.)
    const sender = senderOf(msg);
    if (role === "owner" && !msg.key.fromMe && !isOwnerJidSync(sender)) {
      return sendBotMessage(
        sock,
        jid,
        { text: "🚫 تعيين مالك جديد للمالك فقط." },
        { replyTo: msg }
      );
    }

    try {
      const record = isAdd
        ? await grantRole(target, role)
        : await revokeRole(target, role);
      const who = record ? labelFor(record) : target;
      const roleLabel = role === "owner" ? "مالك 👑" : "أدمن 🛡️";

      logger.info(
        { target, role, granted: isAdd, by: sender },
        "[perm] role change"
      );

      return sendBotMessage(
        sock,
        jid,
        {
          text: isAdd
            ? `✅ تم تعيين *${who}* كـ *${roleLabel}*.`
            : `✅ تم سحب صلاحية *${roleLabel}* من *${who}*.`,
          mentions: target.includes("@") ? [target] : undefined,
        },
        { replyTo: msg }
      );
    } catch (error) {
      logger.error({ err: error }, "[perm] role change failed");
      return sendBotMessage(
        sock,
        jid,
        {
          text: `❌ *مقدرتش أعدّل الصلاحية*\n\n*التفاصيل:* ${error.message}`,
        },
        { replyTo: msg }
      );
    }
  },
};

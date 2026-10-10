const { tr } = require("../utils/i18n.cjs");
const logger = require("../utils/logger.cjs");
const autoDelete = require("../services/autoDelete.cjs");

const LIST_WORDS = new Set(["list", "ls", "show", "قائمة", "عرض"]);
const ADD_WORDS = new Set(["add", "اضف", "أضف", "ضيف"]);
const REMOVE_WORDS = new Set(["remove", "del", "delete", "rm", "احذف", "شيل", "امسح"]);
const ON_WORDS = new Set(["on", "enable", "تشغيل", "تفعيل"]);
const OFF_WORDS = new Set(["off", "disable", "ايقاف", "إيقاف", "تعطيل"]);
const STATS_WORDS = new Set(["stats", "stat", "counter", "احصائيات", "إحصائيات", "عداد"]);
const RESET_WORDS = new Set(["reset", "صفر", "صفّر", "اعادة", "إعادة"]);

function parseKeywords(args) {
  return args
    .join(" ")
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseIdArg(value) {
  const raw = String(value ?? "")
    .trim()
    .replace(/^#/, "");
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

function formatRule(rule) {
  const state = rule.enabled ? tr("on", "تشغيل") : tr("off", "إيقاف");
  const label = rule.name ? ` "${rule.name}"` : "";
  const keywords = rule.keywords.join(", ");
  return tr(
    `#${rule.id}${label} · ${state} · ${rule.match} · ${rule.keywords.length} keyword(s) · deleted ${rule.deletedCount}\n  ${keywords}`,
    `#${rule.id}${label} · ${state} · ${rule.match} · ${rule.keywords.length} كلمة · حُذف ${rule.deletedCount}\n  ${keywords}`,
  );
}

function formatWhen(ts) {
  if (!ts) return tr("never", "أبداً");
  return new Date(ts).toISOString();
}

module.exports = {
  name: "autodelete",
  aliases: [...autoDelete.DECLARED_ALIASES],
  description: {
    en: "Manages keyword auto-delete rules: add, remove, enable, disable, and counters.",
    ar: "يدير قواعد الحذف التلقائي حسب الكلمات: إضافة وإزالة وتشغيل وإيقاف والعداد.",
  },
  usage: {
    en: "autodelete list\nautodelete add <word> [| <word> ...]\nautodelete remove <id>\nautodelete on <id>\nautodelete off <id>\nautodelete stats [id]\nautodelete reset <id>",
    ar: "autodelete list\nautodelete add <كلمة> [| <كلمة> ...]\nautodelete remove <id>\nautodelete on <id>\nautodelete off <id>\nautodelete stats [id]\nautodelete reset <id>",
  },
  chat: "all",
  keywords: [
    ...LIST_WORDS,
    ...ADD_WORDS,
    ...REMOVE_WORDS,
    ...ON_WORDS,
    ...OFF_WORDS,
    ...STATS_WORDS,
    ...RESET_WORDS,
  ],

  async execute(sock, msg, args) {
    const jid = msg.key.remoteJid;
    const action = String(args[0] || "").toLowerCase();

    try {
      if (!action || LIST_WORDS.has(action)) {
        const rules = autoDelete.listRules();
        if (!rules.length) {
          return sock.sendMessage(jid, {
            text: tr("No auto-delete rules yet.", "لا توجد قواعد حذف تلقائي بعد."),
          });
        }
        const header = tr(
          `*Auto-delete rules (${rules.length}):*\n\n`,
          `*قواعد الحذف التلقائي (${rules.length}):*\n\n`,
        );
        return sock.sendMessage(jid, {
          text: header + rules.map(formatRule).join("\n"),
        });
      }

      if (ADD_WORDS.has(action)) {
        const keywords = parseKeywords(args.slice(1));
        if (!keywords.length) {
          return sock.sendMessage(jid, {
            text: tr(
              "Write one or more words to auto-delete, separated by |.",
              "اكتب كلمة أو أكثر للحذف التلقائي، مفصولة بـ |.",
            ),
          });
        }
        const rule = autoDelete.createRule({
          keywords,
          match: "contains",
          chatScope: "all",
          senders: { mode: "everyone", list: [] },
          includeOwn: false,
          forEveryone: true,
          keepCopy: false,
          enabled: true,
        });
        return sock.sendMessage(jid, {
          text: tr(
            `Added auto-delete rule #${rule.id} (${rule.keywords.join(", ")}).`,
            `تمت إضافة قاعدة الحذف التلقائي #${rule.id} (${rule.keywords.join(", ")}).`,
          ),
        });
      }

      if (REMOVE_WORDS.has(action)) {
        const id = parseIdArg(args[1]);
        if (!id) {
          return sock.sendMessage(jid, {
            text: tr("Give a rule id to remove.", "أدخل رقم القاعدة للحذف."),
          });
        }
        autoDelete.deleteRule(id);
        return sock.sendMessage(jid, {
          text: tr(`Removed auto-delete rule #${id}.`, `تم حذف قاعدة الحذف التلقائي #${id}.`),
        });
      }

      if (ON_WORDS.has(action) || OFF_WORDS.has(action)) {
        const id = parseIdArg(args[1]);
        if (!id) {
          return sock.sendMessage(jid, {
            text: tr("Give a rule id.", "أدخل رقم القاعدة."),
          });
        }
        const enabled = ON_WORDS.has(action);
        autoDelete.updateRule(id, { enabled });
        return sock.sendMessage(jid, {
          text: enabled
            ? tr(`Auto-delete rule #${id} is on.`, `قاعدة الحذف التلقائي #${id} مفعّلة.`)
            : tr(`Auto-delete rule #${id} is off.`, `قاعدة الحذف التلقائي #${id} موقوفة.`),
        });
      }

      if (STATS_WORDS.has(action)) {
        if (args[1]) {
          const id = parseIdArg(args[1]);
          if (!id) {
            return sock.sendMessage(jid, {
              text: tr("Give a rule id.", "أدخل رقم القاعدة."),
            });
          }
          const rule = autoDelete.getRule(id);
          return sock.sendMessage(jid, {
            text: tr(
              `*Rule #${rule.id}*${rule.name ? ` ${rule.name}` : ""}\nDeleted: ${rule.deletedCount}\nLast: ${formatWhen(rule.lastDeletedAt)}`,
              `*القاعدة #${rule.id}*${rule.name ? ` ${rule.name}` : ""}\nحُذف: ${rule.deletedCount}\nآخر مرة: ${formatWhen(rule.lastDeletedAt)}`,
            ),
          });
        }
        const rules = autoDelete.listRules();
        const total = rules.reduce((sum, rule) => sum + (rule.deletedCount || 0), 0);
        return sock.sendMessage(jid, {
          text: tr(
            `*Auto-delete counters*\nRules: ${rules.length}\nDeleted: ${total}`,
            `*عدادات الحذف التلقائي*\nالقواعد: ${rules.length}\nحُذف: ${total}`,
          ),
        });
      }

      if (RESET_WORDS.has(action)) {
        const id = parseIdArg(args[1]);
        if (!id) {
          return sock.sendMessage(jid, {
            text: tr("Give a rule id to reset.", "أدخل رقم القاعدة لتصفير العداد."),
          });
        }
        autoDelete.resetCounter(id);
        return sock.sendMessage(jid, {
          text: tr(
            `Reset the counter for auto-delete rule #${id}.`,
            `تم تصفير عداد قاعدة الحذف التلقائي #${id}.`,
          ),
        });
      }

      return sock.sendMessage(jid, {
        text: tr(
          "Unknown sub-command. Try list, add, remove, on, off, stats, reset.",
          "أمر فرعي غير معروف. جرّب list أو add أو remove أو on أو off أو stats أو reset.",
        ),
      });
    } catch (error) {
      if (error?.status === 404) {
        return sock.sendMessage(jid, {
          text: tr("No auto-delete rule with that id.", "لا توجد قاعدة حذف تلقائي بهذا الرقم."),
        });
      }
      if (error?.name === "AutoDeleteError" || error?.status === 400) {
        return sock.sendMessage(jid, {
          text: tr(
            `Could not update that rule: ${error.message}`,
            `تعذر تحديث القاعدة: ${error.message}`,
          ),
        });
      }
      logger.error({ err: error, command: "autodelete" }, "auto-delete command failed");
      return sock.sendMessage(jid, {
        text: tr("Something went wrong with auto-delete.", "حدث خطأ أثناء معالجة الحذف التلقائي."),
      });
    }
  },
};

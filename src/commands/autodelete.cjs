const { t } = require("../utils/i18n.cjs");
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
  const state = rule.enabled ? t("bot.moderation.autodelete.on") : t("bot.moderation.autodelete.off");
  const label = rule.name ? ` "${rule.name}"` : "";
  const keywords = rule.keywords.join(", ");
  return t("bot.moderation.autodelete.ruleListLine", {
    id: rule.id,
    label,
    state,
    match: rule.match,
    keywordCount: rule.keywords.length,
    deletedCount: rule.deletedCount,
    keywords,
  });
}

function formatWhen(ts) {
  if (!ts) return t("bot.moderation.autodelete.never");
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
            text: t("bot.moderation.autodelete.noAutoDeleteRulesYet"),
          });
        }
        const header = t("bot.moderation.autodelete.autoDeleteRules", { count: rules.length });
        return sock.sendMessage(jid, {
          text: header + rules.map(formatRule).join("\n"),
        });
      }

      if (ADD_WORDS.has(action)) {
        const keywords = parseKeywords(args.slice(1));
        if (!keywords.length) {
          return sock.sendMessage(jid, {
            text: t("bot.moderation.autodelete.writeOneOrMoreWords"),
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
          text: t("bot.moderation.autodelete.addedAutoDeleteRule", {
            id: rule.id,
            keywords: rule.keywords.join(", "),
          }),
        });
      }

      if (REMOVE_WORDS.has(action)) {
        const id = parseIdArg(args[1]);
        if (!id) {
          return sock.sendMessage(jid, {
            text: t("bot.moderation.autodelete.ruleIdToRemoveRequired"),
          });
        }
        autoDelete.deleteRule(id);
        return sock.sendMessage(jid, {
          text: t("bot.moderation.autodelete.removedAutoDeleteRule", { id }),
        });
      }

      if (ON_WORDS.has(action) || OFF_WORDS.has(action)) {
        const id = parseIdArg(args[1]);
        if (!id) {
          return sock.sendMessage(jid, {
            text: t("bot.moderation.autodelete.giveARuleId"),
          });
        }
        const enabled = ON_WORDS.has(action);
        autoDelete.updateRule(id, { enabled });
        return sock.sendMessage(jid, {
          text: enabled
            ? t("bot.moderation.autodelete.autoDeleteRuleIsOn", { id })
            : t("bot.moderation.autodelete.autoDeleteRuleIsOff", { id }),
        });
      }

      if (STATS_WORDS.has(action)) {
        if (args[1]) {
          const id = parseIdArg(args[1]);
          if (!id) {
            return sock.sendMessage(jid, {
              text: t("bot.moderation.autodelete.giveARuleId"),
            });
          }
          const rule = autoDelete.getRule(id);
          return sock.sendMessage(jid, {
            text: t("bot.moderation.autodelete.ruleStats", {
              id: rule.id,
              name: rule.name ? ` ${rule.name}` : "",
              deletedCount: rule.deletedCount,
              last: formatWhen(rule.lastDeletedAt),
            }),
          });
        }
        const rules = autoDelete.listRules();
        const total = rules.reduce((sum, rule) => sum + (rule.deletedCount || 0), 0);
        return sock.sendMessage(jid, {
          text: t("bot.moderation.autodelete.autoDeleteCountersRulesDeleted", {
            count: rules.length,
            total,
          }),
        });
      }

      if (RESET_WORDS.has(action)) {
        const id = parseIdArg(args[1]);
        if (!id) {
          return sock.sendMessage(jid, {
            text: t("bot.moderation.autodelete.ruleIdToResetRequired"),
          });
        }
        autoDelete.resetCounter(id);
        return sock.sendMessage(jid, {
          text: t("bot.moderation.autodelete.resetTheCounterForAuto", { id }),
        });
      }

      return sock.sendMessage(jid, {
        text: t("bot.moderation.autodelete.unknownSubCommandTryList"),
      });
    } catch (error) {
      if (error?.status === 404) {
        return sock.sendMessage(jid, {
          text: t("bot.moderation.autodelete.noAutoDeleteRuleWith"),
        });
      }
      if (error?.name === "AutoDeleteError" || error?.status === 400) {
        return sock.sendMessage(jid, {
          text: t("bot.moderation.autodelete.couldNotUpdateThatRule", { message: error.message }),
        });
      }
      logger.error({ err: error, command: "autodelete" }, "auto-delete command failed");
      return sock.sendMessage(jid, {
        text: t("bot.moderation.autodelete.somethingWentWrongWithAuto"),
      });
    }
  },
};

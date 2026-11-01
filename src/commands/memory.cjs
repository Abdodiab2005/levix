// Long-term memory, straight from WhatsApp.
//
// The AI can save/forget things by itself (see services/aiTools.cjs) — this
// command is the manual door to the same Markdown files:
//
//   memory/global.md                 shared by every chat
//   memory/chats/<chat-id>.md        this conversation only
//
// Anyone can add a fact to the chat they're in; touching the global memory,
// deleting entries or exporting a file is for admins/owners.

const fs = require("fs");

const memory = require("../utils/memory.cjs");
const { sendBotMessage } = require("../utils/sendBotMessage.cjs");
const {
  isOwnerJidSync,
  isBotAdminUserSync,
  isAdminInGroupSync,
} = require("../utils/permissions.cjs");
const logger = require("../utils/logger.cjs");
const { t } = require("../utils/i18n.cjs");

const GLOBAL_WORDS = new Set(["global", "-g", "--global", "عام", "العام", "الكل"]);

function isGlobalFlag(value) {
  return GLOBAL_WORDS.has(String(value || "").toLowerCase());
}

/** Pull a `global` flag out of the args wherever the user put it. */
function extractScope(args) {
  const rest = [];
  let scope = "chat";
  for (const arg of args) {
    if (isGlobalFlag(arg)) scope = "global";
    else rest.push(arg);
  }
  return { scope, rest };
}

// "the global memory" / "this chat's memory", in the reply language.
function scopeName(scope) {
  return scope === "global" ? t("bot.ai.memory.scopeGlobal") : t("bot.ai.memory.scopeChat");
}

function formatEntries(entries, { limit = 30 } = {}) {
  if (!entries.length) return t("bot.ai.memory.empty");
  const shown = entries.slice(-limit);
  const lines = shown.map((entry, index) => {
    const number = entries.length - shown.length + index + 1;
    const when = entry.at ? entry.at.slice(0, 10) : "";
    const who = entry.by ? ` · ${entry.by}` : "";
    const meta = when || who ? `\n   _${when}${who}_` : "";
    return `*${number}.* ${entry.content}${meta}`;
  });
  const skipped = entries.length - shown.length;
  return (
    (skipped > 0 ? t("bot.ai.memory.olderSkipped", { skipped }) : "") + lines.join("\n")
  );
}

module.exports = {
  name: "memory",
  aliases: ["mem", "ذاكرة", "remember"],
  chat: "all",

  async execute(sock, msg, args, body, groupMetadata) {
    const chatId = msg.key.remoteJid;
    const isGroup = chatId.endsWith("@g.us");
    const senderId = isGroup ? msg.key.participant : msg.key.remoteJid;

    const isOwner = msg.key.fromMe || isOwnerJidSync(senderId);
    const botPrivileged = isOwner || isBotAdminUserSync(senderId);
    const groupAdmin = Boolean(isGroup && isAdminInGroupSync(groupMetadata, senderId));

    const action = String(args[0] || "").toLowerCase();
    const { scope, rest } = extractScope(args.slice(1));

    const reply = (text, extra = {}) =>
      sendBotMessage(sock, chatId, { text, ...extra }, { replyTo: msg });

    const denied = () =>
      reply(t("bot.ai.memory.denied"));

    try {
      // ---------------------------------------------------------------- add
      if (["add", "save", "احفظ", "ضيف", "اضف"].includes(action)) {
        const content = rest.join(" ").trim();
        if (!content) {
          return reply(t("bot.ai.memory.addUsage"));
        }
        if (scope === "global" && !botPrivileged) return denied();

        const entry = memory.addMemory({
          scope,
          chatId,
          content,
          by: msg.pushName || senderId,
          chatName: groupMetadata?.subject || null,
        });

        return reply(
          t("bot.ai.memory.saved", { scope: scopeName(scope) }) +
            `\`${entry.id}\` — ${content.length > 80 ? content.slice(0, 80) + "…" : content}`,
        );
      }

      // ------------------------------------------------------------- search
      if (["search", "find", "بحث", "دور"].includes(action)) {
        const query = rest.join(" ").trim();
        if (!query) {
          return reply(t("bot.ai.memory.searchPrompt"));
        }
        const chatHits = memory.searchMemory(query, { scope: "chat", chatId });
        const globalHits = memory.searchMemory(query, { scope: "global" });

        if (!chatHits.length && !globalHits.length) {
          return reply(t("bot.ai.memory.searchNone", { query }));
        }
        return reply(
          t("bot.ai.memory.searchResults", { query }) +
            t("bot.ai.memory.searchChatHeader", { count: chatHits.length }) +
            `${formatEntries(chatHits, { limit: 10 })}\n\n` +
            t("bot.ai.memory.searchGlobalHeader", { count: globalHits.length }) +
            formatEntries(globalHits, { limit: 10 }),
        );
      }

      // ------------------------------------------------------------- forget
      if (["forget", "del", "delete", "remove", "امسح", "انسى"].includes(action)) {
        if (scope === "global" ? !botPrivileged : !botPrivileged && !groupAdmin) return denied();
        const ref = rest.join(" ").trim();
        if (!ref) {
          return reply(t("bot.ai.memory.forgetUsage"));
        }
        const removed = memory.removeMemory({ scope, chatId, ref });
        return reply(
          removed
            ? t("bot.ai.memory.forgotten", { content: removed.content.slice(0, 120) })
            : t("bot.ai.memory.noMatch", { scope: scopeName(scope), ref }),
        );
      }

      // -------------------------------------------------------------- clear
      if (["clear", "reset", "wipe", "تصفير"].includes(action)) {
        if (scope === "global" ? !botPrivileged : !botPrivileged && !groupAdmin) return denied();
        const count = memory.clearMemory({ scope, chatId });
        return reply(
          count
            ? t("bot.ai.memory.cleared", { count, scope: scopeName(scope) })
            : t("bot.ai.memory.alreadyEmpty"),
        );
      }

      // --------------------------------------------------------------- file
      if (["file", "export", "md", "ملف"].includes(action)) {
        if (scope === "global" ? !botPrivileged : !botPrivileged && !groupAdmin) return denied();
        const filePath = memory.memoryFilePath(scope, chatId);
        if (!fs.existsSync(filePath)) {
          return reply(t("bot.ai.memory.noFile"));
        }
        return sendBotMessage(
          sock,
          chatId,
          {
            document: fs.readFileSync(filePath),
            mimetype: "text/markdown",
            fileName: scope === "global" ? "global.md" : `${chatId}.md`,
            caption: t("bot.ai.memory.fileCaption", { scope: scopeName(scope) }),
          },
          { replyTo: msg },
        );
      }

      // --------------------------------------------------------------- list
      const stats = memory.memoryStats(chatId);
      const target = scope === "global" ? "global" : "chat";
      const entries = memory.listMemory({ scope: target, chatId });

      return reply(
        t("bot.ai.memory.list", {
          title:
            target === "global"
              ? t("bot.ai.memory.listTitleGlobal")
              : t("bot.ai.memory.listTitleChat"),
          count: entries.length,
          entries: formatEntries(entries),
          chatCount: stats.chatCount,
          globalCount: stats.globalCount,
        }),
      );
    } catch (error) {
      logger.error({ err: error }, "[memory] command failed");
      return reply(t("bot.ai.memory.failed", { details: error.message || error }));
    }
  },
};

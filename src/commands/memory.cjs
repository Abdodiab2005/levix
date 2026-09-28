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
const { tr } = require("../utils/i18n.cjs");

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
  return scope === "global"
    ? tr("the global memory", "الذاكرة العامة")
    : tr("this chat's memory", "ذاكرة الشات");
}

function formatEntries(entries, { limit = 30 } = {}) {
  if (!entries.length) return tr("_(empty)_", "_(فاضية)_");
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
    (skipped > 0
      ? tr(`_(+${skipped} older ones not shown)_\n\n`, `_(+${skipped} أقدم مش معروضين)_\n\n`)
      : "") + lines.join("\n")
  );
}

module.exports = {
  name: "memory",
  aliases: ["mem", "ذاكرة", "remember"],
  description: {
    en: "The bot's long-term memory (.md files): add, list, search, forget, or export the file.",
    ar: "الذاكرة الدائمة للبوت (ملفات .md): إضافة، أو عرض، أو بحث، أو حذف، أو تصدير الملف.",
  },
  usage: {
    en: "memory\nmemory add <fact>\nmemory add global <fact>\nmemory search <word>\nmemory forget <number|part of the text>\nmemory clear [global]\nmemory file [global]",
    ar: "memory\nmemory add <المعلومة>\nmemory add global <المعلومة>\nmemory search <كلمة>\nmemory forget <رقم|جزء من النص>\nmemory clear [global]\nmemory file [global]",
  },
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
      reply(
        tr(
          "🚫 That's for admins and the owner only. Anyone can add to this chat's memory.",
          "🚫 ده للمشرفين والمالك بس. تقدر تضيف معلومة لذاكرة الشات عادي.",
        ),
      );

    try {
      // ---------------------------------------------------------------- add
      if (["add", "save", "احفظ", "ضيف", "اضف"].includes(action)) {
        const content = rest.join(" ").trim();
        if (!content) {
          return reply(
            tr(
              "Write the fact after the command.\nExample: `!memory add the meeting is every Tuesday at 9`",
              "اكتب المعلومة بعد الأمر.\nمثال: `!memory add الاجتماع كل تلات الساعة ٩`",
            ),
          );
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
          tr(`🧠 Saved to *${scopeName(scope)}*.\n`, `🧠 اتحفظت في *${scopeName(scope)}*.\n`) +
            `\`${entry.id}\` — ${content.length > 80 ? content.slice(0, 80) + "…" : content}`,
        );
      }

      // ------------------------------------------------------------- search
      if (["search", "find", "بحث", "دور"].includes(action)) {
        const query = rest.join(" ").trim();
        if (!query) {
          return reply(tr("Write the word you're looking for.", "اكتب الكلمة اللي بتدور عليها."));
        }
        const chatHits = memory.searchMemory(query, { scope: "chat", chatId });
        const globalHits = memory.searchMemory(query, { scope: "global" });

        if (!chatHits.length && !globalHits.length) {
          return reply(
            tr(`🔍 Nothing is saved about "${query}".`, `🔍 مفيش حاجة متسجلة عن "${query}".`),
          );
        }
        return reply(
          tr(`🔍 *Results for* "${query}"\n\n`, `🔍 *نتايج البحث عن* "${query}"\n\n`) +
            tr(`*This chat (${chatHits.length}):*\n`, `*ذاكرة الشات (${chatHits.length}):*\n`) +
            `${formatEntries(chatHits, { limit: 10 })}\n\n` +
            tr(`*Global (${globalHits.length}):*\n`, `*الذاكرة العامة (${globalHits.length}):*\n`) +
            formatEntries(globalHits, { limit: 10 }),
        );
      }

      // ------------------------------------------------------------- forget
      if (["forget", "del", "delete", "remove", "امسح", "انسى"].includes(action)) {
        if (scope === "global" ? !botPrivileged : !botPrivileged && !groupAdmin) return denied();
        const ref = rest.join(" ").trim();
        if (!ref) {
          return reply(
            tr(
              "Say what to forget: its number from `!memory`, or part of its text.\nExample: `!memory forget 3`",
              "حدد اللي عايز تمسحه: رقمه من `!memory` أو جزء من نصه.\n" +
                "مثال: `!memory forget 3`",
            ),
          );
        }
        const removed = memory.removeMemory({ scope, chatId, ref });
        return reply(
          removed
            ? tr(
                `🗑️ Forgotten: ${removed.content.slice(0, 120)}`,
                `🗑️ اتمسحت: ${removed.content.slice(0, 120)}`,
              )
            : tr(
                `Nothing in ${scopeName(scope)} matches "${ref}".`,
                `مالقيتش حاجة تطابق "${ref}" في ${scopeName(scope)}.`,
              ),
        );
      }

      // -------------------------------------------------------------- clear
      if (["clear", "reset", "wipe", "تصفير"].includes(action)) {
        if (scope === "global" ? !botPrivileged : !botPrivileged && !groupAdmin) return denied();
        const count = memory.clearMemory({ scope, chatId });
        return reply(
          count
            ? tr(
                `🧹 Cleared *${count}* facts from ${scopeName(scope)}.`,
                `🧹 اتمسحت *${count}* معلومة من ${scopeName(scope)}.`,
              )
            : tr("The memory was already empty.", "الذاكرة كانت فاضية أصلاً."),
        );
      }

      // --------------------------------------------------------------- file
      if (["file", "export", "md", "ملف"].includes(action)) {
        if (scope === "global" ? !botPrivileged : !botPrivileged && !groupAdmin) return denied();
        const filePath = memory.memoryFilePath(scope, chatId);
        if (!fs.existsSync(filePath)) {
          return reply(
            tr(
              "There is no memory file yet — start with `!memory add ...`.",
              "مفيش ملف ذاكرة لسه — ابدأ بـ `!memory add ...`.",
            ),
          );
        }
        return sendBotMessage(
          sock,
          chatId,
          {
            document: fs.readFileSync(filePath),
            mimetype: "text/markdown",
            fileName: scope === "global" ? "global.md" : `${chatId}.md`,
            caption: tr(`🧠 The file for ${scopeName(scope)}`, `🧠 ملف ${scopeName(scope)}`),
          },
          { replyTo: msg },
        );
      }

      // --------------------------------------------------------------- list
      const stats = memory.memoryStats(chatId);
      const target = scope === "global" ? "global" : "chat";
      const entries = memory.listMemory({ scope: target, chatId });

      return reply(
        tr(
          `🧠 *${target === "global" ? "Global memory" : "This chat's memory"}* ` +
            `(${entries.length} facts)\n\n` +
            `${formatEntries(entries)}\n\n` +
            `_Chat: ${stats.chatCount} · Global: ${stats.globalCount}_\n` +
            "`!memory add <fact>` · `!memory add global <fact>` · `!memory forget <number>` · `!memory file`",
          `🧠 *${target === "global" ? "الذاكرة العامة" : "ذاكرة المحادثة دي"}* ` +
            `(${entries.length} معلومة)\n\n` +
            `${formatEntries(entries)}\n\n` +
            `_الشات: ${stats.chatCount} · العام: ${stats.globalCount}_\n` +
            "`!memory add <معلومة>` · `!memory add global <معلومة>` · `!memory forget <رقم>` · `!memory file`",
        ),
      );
    } catch (error) {
      logger.error({ err: error }, "[memory] command failed");
      return reply(
        tr(
          `❌ *Memory problem*\n\n*Details:* ${error.message || error}`,
          `❌ *مشكلة في الذاكرة*\n\n*التفاصيل:* ${error.message || error}`,
        ),
      );
    }
  },
};

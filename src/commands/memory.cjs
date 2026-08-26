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

function formatEntries(entries, { limit = 30 } = {}) {
  if (!entries.length) return "_(فاضية)_";
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
    (skipped > 0 ? `_(+${skipped} أقدم مش معروضين)_\n\n` : "") + lines.join("\n")
  );
}

module.exports = {
  name: "memory",
  aliases: ["mem", "ذاكرة", "remember"],
  description:
    "الذاكرة الدائمة للبوت (ملفات .md): إضافة، عرض، بحث، حذف، أو تصدير الملف.",
  usage:
    "memory\nmemory add <المعلومة>\nmemory add global <المعلومة>\nmemory search <كلمة>\nmemory forget <رقم|جزء من النص>\nmemory clear [global]\nmemory file [global]",
  chat: "all",

  async execute(sock, msg, args, body, groupMetadata) {
    const chatId = msg.key.remoteJid;
    const isGroup = chatId.endsWith("@g.us");
    const senderId = isGroup ? msg.key.participant : msg.key.remoteJid;

    const isOwner = msg.key.fromMe || isOwnerJidSync(senderId);
    const privileged =
      isOwner ||
      isBotAdminUserSync(senderId) ||
      (isGroup && isAdminInGroupSync(groupMetadata, senderId));

    const action = String(args[0] || "").toLowerCase();
    const { scope, rest } = extractScope(args.slice(1));

    const reply = (text, extra = {}) =>
      sendBotMessage(sock, chatId, { text, ...extra }, { replyTo: msg });

    const denied = () =>
      reply("🚫 ده للمشرفين والمالك بس. تقدر تضيف معلومة لذاكرة الشات عادي.");

    try {
      // ---------------------------------------------------------------- add
      if (["add", "save", "احفظ", "ضيف", "اضف"].includes(action)) {
        const content = rest.join(" ").trim();
        if (!content) {
          return reply(
            "اكتب المعلومة بعد الأمر.\nمثال: `!memory add الاجتماع كل تلات الساعة ٩`"
          );
        }
        if (scope === "global" && !privileged) return denied();

        const entry = memory.addMemory({
          scope,
          chatId,
          content,
          by: msg.pushName || senderId,
          chatName: groupMetadata?.subject || null,
        });

        return reply(
          `🧠 اتحفظت في *${scope === "global" ? "الذاكرة العامة" : "ذاكرة الشات"}*.\n` +
            `\`${entry.id}\` — ${content.length > 80 ? content.slice(0, 80) + "…" : content}`
        );
      }

      // ------------------------------------------------------------- search
      if (["search", "find", "بحث", "دور"].includes(action)) {
        const query = rest.join(" ").trim();
        if (!query) return reply("اكتب الكلمة اللي بتدور عليها.");
        const chatHits = memory.searchMemory(query, { scope: "chat", chatId });
        const globalHits = memory.searchMemory(query, { scope: "global" });

        if (!chatHits.length && !globalHits.length) {
          return reply(`🔍 مفيش حاجة متسجلة عن "${query}".`);
        }
        return reply(
          `🔍 *نتايج البحث عن* "${query}"\n\n` +
            `*ذاكرة الشات (${chatHits.length}):*\n${formatEntries(chatHits, { limit: 10 })}\n\n` +
            `*الذاكرة العامة (${globalHits.length}):*\n${formatEntries(globalHits, { limit: 10 })}`
        );
      }

      // ------------------------------------------------------------- forget
      if (["forget", "del", "delete", "remove", "امسح", "انسى"].includes(action)) {
        if (!privileged) return denied();
        const ref = rest.join(" ").trim();
        if (!ref) {
          return reply(
            "حدد اللي عايز تمسحه: رقمه من `!memory` أو جزء من نصه.\n" +
              "مثال: `!memory forget 3`"
          );
        }
        const removed = memory.removeMemory({ scope, chatId, ref });
        return reply(
          removed
            ? `🗑️ اتمسحت: ${removed.content.slice(0, 120)}`
            : `مالقيتش حاجة تطابق "${ref}" في ${
                scope === "global" ? "الذاكرة العامة" : "ذاكرة الشات"
              }.`
        );
      }

      // -------------------------------------------------------------- clear
      if (["clear", "reset", "wipe", "تصفير"].includes(action)) {
        if (!privileged) return denied();
        const count = memory.clearMemory({ scope, chatId });
        return reply(
          count
            ? `🧹 اتمسحت *${count}* معلومة من ${
                scope === "global" ? "الذاكرة العامة" : "ذاكرة الشات"
              }.`
            : "الذاكرة كانت فاضية أصلاً."
        );
      }

      // --------------------------------------------------------------- file
      if (["file", "export", "md", "ملف"].includes(action)) {
        if (!privileged) return denied();
        const filePath = memory.memoryFilePath(scope, chatId);
        if (!fs.existsSync(filePath)) {
          return reply("مفيش ملف ذاكرة لسه — ابدأ بـ `!memory add ...`.");
        }
        return sendBotMessage(
          sock,
          chatId,
          {
            document: fs.readFileSync(filePath),
            mimetype: "text/markdown",
            fileName: scope === "global" ? "global.md" : `${chatId}.md`,
            caption: `🧠 ملف ${
              scope === "global" ? "الذاكرة العامة" : "ذاكرة الشات"
            }`,
          },
          { replyTo: msg }
        );
      }

      // --------------------------------------------------------------- list
      const stats = memory.memoryStats(chatId);
      const target = scope === "global" ? "global" : "chat";
      const entries = memory.listMemory({ scope: target, chatId });

      return reply(
        `🧠 *${target === "global" ? "الذاكرة العامة" : "ذاكرة المحادثة دي"}* ` +
          `(${entries.length} معلومة)\n\n` +
          `${formatEntries(entries)}\n\n` +
          `_الشات: ${stats.chatCount} · العام: ${stats.globalCount}_\n` +
          "`!memory add <معلومة>` · `!memory add global <معلومة>` · `!memory forget <رقم>` · `!memory file`"
      );
    } catch (error) {
      logger.error({ err: error }, "[memory] command failed");
      return reply(
        `❌ *مشكلة في الذاكرة*\n\n*التفاصيل:* ${error.message || error}`
      );
    }
  },
};

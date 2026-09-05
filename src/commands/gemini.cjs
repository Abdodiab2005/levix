// Gemini-powered chat command — now an agent, not a single API call.
//
// What this file still owns:
//   * turning a WhatsApp message (text / image / video / audio / document /
//     quoted message) into Gemini `parts`,
//   * the multi-message context buffer (`!gemini add` ... `!gemini send`),
//   * image generation (`!generate`),
//   * memory management shortcuts (`!del`, `!delall`),
//   * the fallback: sanitize-and-retry when an uploaded file URI expired.
//
// The active provider itself (gemini / openai / anthropic) is a setting, and
// the loop it dispatches to lives in services/aiAgent.cjs +
// services/aiProviders.cjs. Media and !generate/!stt stay Gemini-only — the
// other providers have no Files API to upload to.
//
// What moved out:
//   * the system prompt          -> config/ai-persona.md (editable, hot-reloaded)
//   * the model loop + tools     -> services/aiAgent.cjs + services/aiTools.cjs
//   * long-term memory           -> utils/memory.cjs (Markdown files)
//
// One status message is posted at the start and edited all the way through
// ("🤖 بفكر..." -> "🔍 ببحث عن ..." -> the final answer), so a single answer
// never costs four messages.

const { GoogleGenAI } = require("@google/genai");

const logger = require("../utils/logger.cjs");
const settings = require("../config/settings.cjs");
const {
  getChatHistoryAsync,
  saveChatHistoryAsync,
  deleteChatHistoryAsync,
  deleteAllChatHistoriesAsync,
} = require("../utils/storage-hub.cjs");
const { sendBotMessage, sendBotError } = require("../utils/sendBotMessage.cjs");
const { createStatus } = require("../utils/statusMessage.cjs");
const {
  isOwnerJidSync,
  isBotAdminUserSync,
  isAdminInGroupSync,
} = require("../utils/permissions.cjs");
const {
  runAgent,
  formatSources,
  isFileReferenceError,
  sanitizeHistoryForFiles,
  activeProviderKeySetting,
} = require("../services/aiAgent.cjs");
const { downloadContentFromMessage } = require("@whiskeysockets/baileys");
const fs = require("fs").promises;
const path = require("path");

// Per-(chat, sender) explicit context buffer for the multi-message workflow.
// Entries accumulate until `!gemini send` flushes them into a single call.
// Lives in memory only — short-lived by design.
const contextBuffers = new Map(); // key: "<chatJid>::<senderJid>" -> Entry[]

function bufferKey(msg) {
  return `${msg.key.remoteJid}::${msg.key.participant || msg.key.remoteJid}`;
}
function getBuffer(msg) {
  return contextBuffers.get(bufferKey(msg)) || [];
}
function setBuffer(msg, entries) {
  if (!entries?.length) contextBuffers.delete(bufferKey(msg));
  else contextBuffers.set(bufferKey(msg), entries);
}

// Keys come from config/settings.cjs (what the dashboard saved, else the default)
// and are read per call: a key pasted into the dashboard has to work without a
// restart. The clients are cached per key so we don't rebuild them per message.
//
// One client does everything now: @google/genai folded the separate
// GoogleAIFileManager into `ai.files`, and the model is named per request
// instead of being baked into a model object.
let geminiCache = { key: null, genAI: null };

function geminiClients() {
  const key = settings.get("gemini_api_key");
  if (!key) return { genAI: null };
  if (geminiCache.key !== key) {
    geminiCache = { key, genAI: new GoogleGenAI({ apiKey: key }) };
  }
  return geminiCache;
}

async function processIncomingMedia(parts, mediaMessage, mimeOverride = null) {
  // Reading media is a Gemini capability: the Files API it uploads to does not
  // exist on the openai/anthropic paths. There the turn carries a note and the
  // caption/question text still reaches the model.
  if (settings.get("ai_provider") !== "gemini") {
    const mime = mimeOverride || mediaMessage.mimetype || "ملف";
    parts.push({
      text: `[تم إرفاق وسائط (${mime}) — المزود الحالي لا يستطيع قراءة الوسائط]`,
    });
    return null;
  }

  const { genAI } = geminiClients();
  if (!genAI) throw new Error("Gemini client unavailable");
  const tempFilePath = path.join(__dirname, `temp_media_${Date.now()}`);
  const stream = await downloadContentFromMessage(
    mediaMessage,
    mediaMessage.mimetype?.startsWith("image/")
      ? "image"
      : mediaMessage.mimetype?.startsWith("video/")
      ? "video"
      : mediaMessage.mimetype?.startsWith("audio/")
      ? "audio"
      : "document"
  );
  let buffer = Buffer.from([]);
  for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
  if (!buffer.length) throw new Error("Empty media buffer");

  await fs.writeFile(tempFilePath, buffer);
  try {
    // ai.files.upload returns the File itself, where the old fileManager
    // wrapped it in { file }. The fileData part shape is unchanged, so history
    // written by an older Levix still loads.
    const uploaded = await genAI.files.upload({
      file: tempFilePath,
      config: {
        mimeType: mimeOverride || mediaMessage.mimetype,
        displayName: `media-${Date.now()}`,
      },
    });
    parts.push({
      fileData: {
        mimeType: mimeOverride || mediaMessage.mimetype,
        fileUri: uploaded.uri,
      },
    });
    return uploaded.uri;
  } finally {
    try {
      await fs.unlink(tempFilePath);
    } catch {}
  }
}

// === Multi-message context buffer helpers ===
// Each entry is { text, quotedText, mediaParts, quotedMediaParts }. Media is
// uploaded eagerly (on `add`) so the URIs are ready when `send` fires; Gemini
// file URIs are valid for ~48 h, plenty for any real workflow.

async function captureContextEntry(msg, args) {
  const entry = {
    text: "",
    quotedText: "",
    mediaParts: [],
    quotedMediaParts: [],
  };

  // args[0] is the sub-command name itself (`add` / `send`); the rest is the
  // user's actual text.
  const cleanedText = args.slice(1).join(" ").trim();
  if (cleanedText) entry.text = cleanedText;

  const m = msg.message || {};

  const directMedia =
    m.imageMessage || m.videoMessage || m.audioMessage || m.documentMessage;
  if (directMedia) {
    try {
      await processIncomingMedia(entry.mediaParts, directMedia);
    } catch (err) {
      logger.warn(
        { err: err?.message },
        "[Gemini Context] direct media upload failed; entry will be text-only"
      );
    }
  }

  const quoted = m.extendedTextMessage?.contextInfo?.quotedMessage;
  if (quoted) {
    entry.quotedText =
      quoted.conversation ||
      quoted.extendedTextMessage?.text ||
      quoted.imageMessage?.caption ||
      quoted.videoMessage?.caption ||
      quoted.documentMessage?.caption ||
      "";
    const quotedMedia =
      quoted.imageMessage ||
      quoted.videoMessage ||
      quoted.audioMessage ||
      quoted.documentMessage;
    if (quotedMedia) {
      try {
        await processIncomingMedia(entry.quotedMediaParts, quotedMedia);
      } catch (err) {
        logger.warn(
          { err: err?.message },
          "[Gemini Context] quoted media upload failed; entry will continue without it"
        );
      }
    }
  }

  return entry;
}

function entryHasContent(e) {
  return Boolean(
    e.text || e.quotedText || e.mediaParts?.length || e.quotedMediaParts?.length
  );
}

function buildPartsFromBuffer(entries) {
  const parts = [];
  for (const e of entries) {
    if (e.quotedText) parts.push({ text: `(مرجع: "${e.quotedText}")` });
    if (e.quotedMediaParts?.length) parts.push(...e.quotedMediaParts);
    if (e.mediaParts?.length) parts.push(...e.mediaParts);
    if (e.text) parts.push({ text: e.text });
  }
  return parts;
}

function summarizeEntry(e, idx) {
  const bits = [];
  if (e.text) {
    const preview = e.text.length > 60 ? e.text.slice(0, 60) + "…" : e.text;
    bits.push(`📝 ${preview}`);
  }
  if (e.quotedText) {
    const preview =
      e.quotedText.length > 40 ? e.quotedText.slice(0, 40) + "…" : e.quotedText;
    bits.push(`↩️ "${preview}"`);
  }
  if (e.mediaParts?.length) bits.push(`🖼️ ميديا (${e.mediaParts.length})`);
  if (e.quotedMediaParts?.length)
    bits.push(`🖼️↩️ ميديا مقتبسة (${e.quotedMediaParts.length})`);
  return `${idx + 1}. ${bits.join(" · ") || "(فارغة)"}`;
}

module.exports = {
  name: "gemini",
  aliases: ["ask", "ai", "resetai", "del", "delall", "generate"],
  description:
    "مساعد ذكي بأدوات (بحث، فتح روابط، ذاكرة دائمة). sub-commands: add/send/clear/show للسياق، generate للصور، del/delall لمسح المحادثة.",
  usage:
    "gemini <النص>\ngemini add <النص>\ngemini send\ngemini show\ngemini clear\ngenerate <وصف الصورة>\ndel   (مسح ذاكرة المحادثة)\ndelall   (مسح كل المحادثات)",
  chat: "all",

  async execute(sock, msg, args, body, groupMetadata, ctx = {}) {
    const chatId = msg.key.remoteJid;
    const userName = msg.pushName;
    const isGroup = chatId.endsWith("@g.us");

    const senderId = msg.key.fromMe
      ? null
      : isGroup
      ? msg.key.participant
      : msg.key.remoteJid;
    const isOwner = msg.key.fromMe || isOwnerJidSync(senderId);
    // نفس تعريف "privileged" في أمر !memory: أدمن البوت أو أدمن الجروب —
    // عشان أدوات الوكيل تطبّق نفس القاعدة اللي الأوامر بتطبّقها.
    const isAdmin =
      isOwner ||
      isBotAdminUserSync(senderId) ||
      (isGroup && isAdminInGroupSync(groupMetadata, senderId));

    // Resolve sub-command. Aliases like !del arrive via ctx.invokedName, while
    // `!gemini del ...` arrives as args[0].
    const invoked = (ctx?.invokedName || "").toLowerCase();
    const aliasSubCmds = new Set(["del", "resetai", "delall", "generate"]);
    const inlineSubCmds = new Set([
      "add",
      "send",
      "clear",
      "show",
      "del",
      "resetai",
      "delall",
      "generate",
    ]);
    const candidateInline = args[0]?.toLowerCase();
    const subCommand = aliasSubCmds.has(invoked)
      ? invoked
      : inlineSubCmds.has(candidateInline)
      ? candidateInline
      : null;

    // --- conversation history management (owner only) ---
    if (subCommand === "del" || subCommand === "resetai") {
      if (!isOwner)
        return sendBotMessage(
          sock,
          chatId,
          { text: "🚫 هذا الأمر مخصص للمالك فقط." },
          { replyTo: msg }
        );
      await deleteChatHistoryAsync(chatId);
      return sendBotMessage(
        sock,
        chatId,
        {
          text:
            "✅ تم مسح سجل المحادثة.\n" +
            "_(الذاكرة الدائمة مش بتتمسح كده — استخدم `!memory clear` لو ده اللي تقصده.)_",
        },
        { replyTo: msg }
      );
    }
    if (subCommand === "delall") {
      if (!isOwner)
        return sendBotMessage(
          sock,
          chatId,
          { text: "🚫 هذا الأمر مخصص للمالك فقط." },
          { replyTo: msg }
        );
      await deleteAllChatHistoriesAsync();
      return sendBotMessage(
        sock,
        chatId,
        { text: "✅ تم مسح كل سجلات المحادثات بنجاح." },
        { replyTo: msg }
      );
    }

    // --- image generation ---
    if (subCommand === "generate") {
      const quotedMsg =
        msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.conversation;
      const imagePromptArgs = invoked === "generate" ? args : args.slice(1);
      const imagePrompt = imagePromptArgs.join(" ");
      if (!imagePrompt && !quotedMsg) {
        return sendBotMessage(
          sock,
          chatId,
          {
            text: "اكتب وصف للصورة اللي عايزها بعد الأمر. مثال: !generate قطة ترتدي قبعة",
          },
          { replyTo: msg }
        );
      }

      const status = await createStatus(
        sock,
        chatId,
        "🎨 بجهّز الصورة...",
        { replyTo: msg }
      );

      try {
        // Image generation needs a model that returns image bytes, which only
        // the Gemini image models do — it stays on Gemini whatever the chat
        // provider is.
        if (!geminiClients().genAI) {
          throw new Error(
            "مفتاح Gemini API غير معرف — توليد الصور يعمل على Gemini فقط"
          );
        }
        const fullPrompt =
          imagePrompt && quotedMsg
            ? `Prompt: ${imagePrompt} ,using quote: ${quotedMsg}`
            : imagePrompt
            ? `Prompt: ${imagePrompt}`
            : `Prompt: ${quotedMsg}`;
        const response = await geminiClients().genAI.models.generateContent({
          model: settings.get("gemini_image_model"),
          contents: `Generate an image using this prompt: ${fullPrompt}`,
        });

        // The bytes come back as an inlineData part. (The previous code read
        // `fileData.data`, which is not a field that exists on either SDK —
        // this path could never have produced an image.)
        const image = (response.candidates?.[0]?.content?.parts || []).find(
          (part) => part?.inlineData?.data
        );
        if (!image) throw new Error("الموديل رجّع رد من غير صورة");
        const imageBuffer = Buffer.from(image.inlineData.data, "base64");

        await status.remove();
        await sendBotMessage(
          sock,
          chatId,
          {
            image: imageBuffer,
            caption: `🖼️ تفضل، صورة لـ: "${imagePrompt}"`,
          },
          { replyTo: msg }
        );
      } catch (error) {
        logger.error({ err: error }, `Error in !generate command`);
        await status.fail(error, "للأسف معرفتش أعمل الصورة");
      }
      return;
    }

    // --- multi-message context buffer ---
    if (subCommand === "add") {
      const entry = await captureContextEntry(msg, args);
      if (!entryHasContent(entry)) {
        return sendBotMessage(
          sock,
          chatId,
          {
            text:
              "📭 مفيش حاجة أضيفها للـ context.\n\n" +
              "اكتب نص بعد الأمر، أو رد على رسالة، أو ابعت ميديا مع كابشن `!gemini add`.",
          },
          { replyTo: msg }
        );
      }
      const buf = getBuffer(msg);
      buf.push(entry);
      setBuffer(msg, buf);
      return sendBotMessage(
        sock,
        chatId,
        {
          text:
            `✅ اتضافت للـ context. (إجمالي الآن: *${buf.length}*)\n\n` +
            "كمل بـ `!gemini add ...` ، أو ابعت كله بـ `!gemini send`.",
        },
        { replyTo: msg }
      );
    }

    if (subCommand === "clear") {
      const had = getBuffer(msg).length;
      setBuffer(msg, []);
      return sendBotMessage(
        sock,
        chatId,
        {
          text: had
            ? `🗑️ تم مسح *${had}* رسالة من الـ context.`
            : "📭 الـ context كان فاضي أصلاً.",
        },
        { replyTo: msg }
      );
    }

    if (subCommand === "show") {
      const buf = getBuffer(msg);
      if (!buf.length) {
        return sendBotMessage(
          sock,
          chatId,
          { text: "📭 الـ context فاضي. ابدأ بـ `!gemini add ...`." },
          { replyTo: msg }
        );
      }
      return sendBotMessage(
        sock,
        chatId,
        {
          text:
            `📋 *الـ context الحالي:* (${buf.length} رسالة)\n\n` +
            buf.map((e, i) => summarizeEntry(e, i)).join("\n") +
            "\n\nابعت كله بـ `!gemini send` أو امسحه بـ `!gemini clear`.",
        },
        { replyTo: msg }
      );
    }

    // === build the parts for this turn ===
    const prompt = args.join(" ");
    let parts = [];

    if (subCommand === "send") {
      const buf = getBuffer(msg);
      const finalEntry = await captureContextEntry(msg, args);
      const allEntries = [...buf];
      if (entryHasContent(finalEntry)) allEntries.push(finalEntry);
      if (!allEntries.length) {
        return sendBotMessage(
          sock,
          chatId,
          {
            text:
              "📭 الـ context فاضي ومفيش نص في `!gemini send`.\n\n" +
              "ابدأ بـ `!gemini add ...` الأول، أو اكتب نص مع `!gemini send ...`.",
          },
          { replyTo: msg }
        );
      }
      setBuffer(msg, []);
      parts = buildPartsFromBuffer(allEntries);
    }

    // Direct media. The text we attach is the CLEANED prompt (command name and
    // prefix already stripped); the raw caption is only a fallback.
    if (!parts.length && (msg.message?.imageMessage || msg.message?.videoMessage)) {
      const mediaMessage = msg.message.imageMessage || msg.message.videoMessage;
      try {
        await processIncomingMedia(parts, mediaMessage);
        parts.push({
          text:
            prompt || mediaMessage.caption || "ماذا يوجد في هذه الصورة/الفيديو؟",
        });
      } catch (error) {
        logger.error({ err: error }, "Failed to upload media to Gemini.");
        return sendBotError(
          sock,
          chatId,
          error,
          "حصلت مشكلة في رفع الصورة/الفيديو",
          { replyTo: msg }
        );
      }
    } else if (!parts.length && msg.message?.audioMessage) {
      try {
        await processIncomingMedia(parts, msg.message.audioMessage);
        parts.push({ text: prompt || "حلل لي هذا التسجيل الصوتي." });
      } catch (error) {
        logger.error({ err: error }, "Failed to upload audio to Gemini.");
        return sendBotError(
          sock,
          chatId,
          error,
          "حصلت مشكلة في رفع التسجيل الصوتي",
          { replyTo: msg }
        );
      }
    } else if (!parts.length && msg.message?.documentMessage) {
      try {
        await processIncomingMedia(parts, msg.message.documentMessage);
        const fileName = msg.message.documentMessage.fileName || "document";
        const text = prompt || msg.message.documentMessage.caption || "";
        parts.push({
          text: text
            ? `${text}\n(الملف: ${fileName})`
            : `حلل/لخّص الملف: ${fileName}`,
        });
      } catch (error) {
        logger.error({ err: error }, "Failed to upload document to Gemini.");
        return sendBotError(sock, chatId, error, "حصلت مشكلة في رفع الملف", {
          replyTo: msg,
        });
      }
    } else if (!parts.length && prompt) {
      parts.push({ text: prompt });
    }

    if (parts.length === 0) {
      return sendBotMessage(
        sock,
        chatId,
        { text: "يرجى كتابة سؤال أو إرسال صورة/فيديو/تسجيل صوتي/ملف مع الأمر." },
        { replyTo: msg }
      );
    }

    // Quoted message context. Skipped for `!gemini send` — those entries
    // captured their own quotes at `add` time.
    const quotedMsg =
      subCommand === "send"
        ? null
        : msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;

    if (quotedMsg) {
      let quotedMediaPart = null;
      const quotedText =
        quotedMsg.conversation ||
        quotedMsg.extendedTextMessage?.text ||
        quotedMsg.documentMessage?.caption;

      const mediaInQuote =
        quotedMsg.imageMessage ||
        quotedMsg.videoMessage ||
        quotedMsg.audioMessage ||
        quotedMsg.documentMessage;

      if (mediaInQuote) {
        try {
          const probeParts = [];
          await processIncomingMedia(probeParts, mediaInQuote);
          quotedMediaPart = probeParts[0];
        } catch (mediaError) {
          logger.error({ err: mediaError }, "Failed to process quoted media");
          await sendBotError(
            sock,
            chatId,
            mediaError,
            "حصلت مشكلة في الرسالة المقتبسة",
            { replyTo: msg }
          );
        }
      }

      if (quotedMediaPart) {
        parts.unshift(quotedMediaPart);
        if (quotedText) {
          parts.unshift({
            text: `بالاعتماد على هذه الرسالة كمرجع:\n"""\n${quotedText}\n"""\n\n`,
          });
        }
      } else if (quotedText) {
        parts.unshift({
          text: `بالاعتماد على هذه الرسالة كمرجع:\n"""\n${quotedText}\n"""\n\nأجب على التالي:`,
        });
      }
    }

    // Provider-aware, on purpose: when the panel picked openai or anthropic,
    // the bot answers with that key and a missing Gemini key is irrelevant.
    if (!settings.get(activeProviderKeySetting())) {
      const provider = settings.get("ai_provider");
      return sendBotMessage(
        sock,
        chatId,
        {
          text: `خطأ في الإعدادات: مفتاح مزود الذكاء الاصطناعي الحالي (${provider}) غير معرف — عدّله من لوحة التحكم.`,
        },
        { replyTo: msg }
      );
    }

    // Everyone the agent needs to know about, plus the ids its role tools act
    // on (a mention/reply is how "خلي فلان أدمن" gets resolved).
    const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
    const agentContext = {
      chatId,
      senderId,
      senderName: userName,
      isOwner,
      isAdmin,
      isGroup,
      chatName: groupMetadata?.subject || null,
      mentionedJids: contextInfo?.mentionedJid || [],
      quotedParticipant: contextInfo?.participant || null,
    };

    // Mentions/replies are ids the model can't invent — hand them over so
    // "اعمل الراجل ده أدمن" has something concrete to act on.
    const targets = [
      ...(agentContext.mentionedJids || []),
      agentContext.quotedParticipant,
    ].filter(Boolean);
    if (targets.length) {
      parts.unshift({
        text: `(معرفات مذكورة في الرسالة: ${[...new Set(targets)].join(", ")})`,
      });
    }

    // The one message that will carry the whole run.
    const status = await createStatus(sock, chatId, "🤖 بفكر...", {
      replyTo: msg,
    });

    async function attempt(historyOverride) {
      const history = historyOverride ?? ((await getChatHistoryAsync(chatId)) || []);
      const result = await runAgent({
        parts,
        history,
        status,
        context: agentContext,
      });
      if (result.history?.length) {
        await saveChatHistoryAsync(chatId, result.history);
      }
      return result;
    }

    try {
      let result;
      try {
        result = await attempt();
      } catch (firstErr) {
        // A dead fileData URI in the history poisons every later call — scrub
        // it once and retry so the user never sees the expiry.
        if (!isFileReferenceError(firstErr)) throw firstErr;

        const oldHistory = (await getChatHistoryAsync(chatId)) || [];
        const cleaned = sanitizeHistoryForFiles(oldHistory);
        await saveChatHistoryAsync(chatId, cleaned);
        logger.info(
          `[Gemini] sanitized history for chat ${chatId}: ${oldHistory.length} -> ${cleaned.length}; retrying once`
        );
        result = await attempt(cleaned);
      }

      const text =
        result.text?.trim() ||
        "مفيش رد جه من الموديل. جرّب تصيغ السؤال بشكل تاني.";
      // Appended only when Gemini really grounded the answer on a search —
      // formatSources() returns "" for an answer the model gave from its own
      // knowledge, so there is never a Sources block with nothing behind it.
      await status.finish(`${text}${formatSources(result.sources)}`);
    } catch (error) {
      logger.error({ err: error }, "Error in !gemini command");
      await status.fail(error, "حصلت مشكلة وأنا بكلم الذكاء الاصطناعي");
    }
  },
};

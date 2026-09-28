// Focused tests for the AI feature tools added in this round:
//
//   speak          — voice-note replies, reusing !tts's synthesizer
//   create_poll    — native WhatsApp polls, reusing !poll's builder
//   summarize_chat — transcript -> one-shot summary -> explicit memory save
//
// Plus the !help bidi layout contract (command line ends with ':', the Arabic
// description starts the NEXT line) and the conversation-inspector store views.
//
// Every side-effect path here is gated through aiToolAuth against a caller
// minted from a real-looking message, so the tests also pin that tool
// arguments cannot carry an identity.

import { equal, finish, ok, require, section, useTempDataDir } from "./harness.mjs";

useTempDataDir("ai-features");

const permissions = require("./src/utils/permissions.cjs");
await permissions.primePermissions();

const runtimeConfig = require("./src/config/runtime-config.cjs");
const memory = require("./src/utils/memory.cjs");
const { runTool, TOOLS, transcriptFromHistory, factsFromSummary } = require("./src/services/aiTools.cjs");
const { resolveCaller } = require("./src/services/aiToolAuth.cjs");
const { saveChatHistoryAsync, getChatHistoryWithMetaAsync, listChatHistoriesAsync } = require("./src/utils/storage-hub.cjs");

const OWNER = "201000000001@s.whatsapp.net";
const MEMBER = "201000000004@s.whatsapp.net";
const GROUP = "120363000000000001@g.us";
const DM = "201000000004@s.whatsapp.net";

await permissions.grantRole(OWNER, "owner");

const groupMetadata = {
  id: GROUP,
  subject: "Test group",
  participants: [
    { id: OWNER, admin: null },
    { id: MEMBER, admin: null },
  ],
};

const sock = { user: { id: "201999999999:7@s.whatsapp.net" }, async sendMessage() {} };

function msgFrom(jid, { fromMe = false, text = "!ai hi" } = {}) {
  return {
    key: { remoteJid: jid, fromMe, participant: jid.endsWith("@g.us") ? MEMBER : jid },
    pushName: "Tester",
    message: { conversation: text },
  };
}

async function callerFor(jid, opts = {}) {
  return resolveCaller({ msg: msgFrom(jid, opts), sock, groupMetadata, text: opts.text || "!ai hi" });
}

// Capturing socket: records every sendMessage payload.
function capturingSock() {
  const sent = [];
  return {
    sent,
    user: sock.user,
    async sendMessage(jid, content) {
      sent.push({ jid, content });
      return {};
    },
    async sendPresenceUpdate() {},
  };
}

section("tool declarations");

for (const name of ["speak", "create_poll", "summarize_chat"]) {
  ok(`${name} is declared to the model`, Boolean(TOOLS[name]?.declaration));
}

section("speak tool");

{
  const tts = require("./src/commands/tts.cjs");
  const caller = await callerFor(DM);

  const noSock = await runTool("speak", { text: "مرحبا" }, { caller });
  ok("speak refuses without a socket", noSock.error?.includes("no WhatsApp connection"));

  const sentSock = capturingSock();
  // Stub the synthesizer: the tool must reuse it, not call Google here.
  const original = tts._synthesizeVoice;
  tts._synthesizeVoice = async (text, lang) => {
    tts.lastCall = { text, lang };
    return { audio: Buffer.from("ogg-bytes"), mimetype: "audio/ogg; codecs=opus", ptt: true };
  };
  try {
    const result = await runTool("speak", { text: "مرحبا بيك", language: "ar" }, { caller, sock: sentSock });
    equal("speak reports the voice-note format", result.format, "voice-note (ogg/opus)");
    equal("speak sent exactly one message", sentSock.sent.length, 1);
    ok("voice note went to the caller's chat", sentSock.sent[0]?.jid === DM);
    ok("content carries the opus mimetype", sentSock.sent[0]?.content?.mimetype === "audio/ogg; codecs=opus");
    ok("content is PTT", sentSock.sent[0]?.content?.ptt === true);
    equal("synthesizer received the text", tts.lastCall.text, "مرحبا بيك");
    equal("synthesizer received the language", tts.lastCall.lang, "ar");

    const tooLong = await runTool("speak", { text: "x".repeat(3001) }, { caller, sock: sentSock });
    ok("speak caps text length", Boolean(tooLong.error));

    // The tool stands in for !tts: raising that command's level in the
    // dashboard must move this door too.
    runtimeConfig.setPermission("tts", "OWNER_ONLY");
    const refused = await runTool("speak", { text: "مرحبا" }, { caller, sock: sentSock });
    ok("member is refused when !tts becomes owner-only", refused.denied === true);
    runtimeConfig.setPermission("tts", null);
  } finally {
    tts._synthesizeVoice = original;
  }
}

section("create_poll tool");

{
  const poll = require("./src/commands/poll.cjs");

  // The shared builder enforces WhatsApp's limits for BOTH doors.
  let threw = "";
  try {
    poll._buildPollContent("سؤال", ["واحد"]);
  } catch (err) {
    threw = err.message;
  }
  ok("builder demands two options", threw.includes("خيارين"));

  const deduped = poll._buildPollContent("سؤال", ["a", "a", "b"]);
  equal("builder dedupes options", deduped.poll.values.length, 2);
  equal("single answer by default", deduped.poll.selectableCount, 1);

  const multi = poll._buildPollContent("q", ["a", "b", "c"], { multi: true });
  equal("multi allows picking all", multi.poll.selectableCount, 3);

  const caller = await callerFor(GROUP);
  const sentSock = capturingSock();
  const result = await runTool(
    "create_poll",
    { question: "نروح فين؟", options: ["السينما", "البحر", "السينما"], multi: true },
    { caller, sock: sentSock },
  );
  equal("poll sent to the caller's chat", sentSock.sent[0]?.jid, GROUP);
  ok("content is a native poll", Array.isArray(sentSock.sent[0]?.content?.poll?.values));
  ok("model args went through the same caps", sentSock.sent[0]?.content?.poll?.values.length === 2);
  equal("tool reports the question", result.question, "نروح فين؟");

  runtimeConfig.setPermission("poll", "OWNER_ONLY");
  const refused = await runTool(
    "create_poll",
    { question: "q", options: ["a", "b"] },
    { caller, sock: sentSock },
  );
  ok("member is refused when !poll becomes owner-only", refused.denied === true);
  runtimeConfig.setPermission("poll", null);
}

section("summarize_chat tool");

{
  // Pure helpers: transcript flattening and fact extraction.
  const history = [
    { role: "user", parts: [{ text: "أنا اسمي أحمد" }] },
    { role: "model", parts: [{ text: "اتشرفنا يا أحمد" }] },
    { role: "user", parts: [{ fileData: { mimeType: "image/jpeg" } }, { text: "شوف الصورة دي" }] },
    { role: "model", parts: [{ functionCall: { name: "web_search" } }] },
  ];
  const transcript = transcriptFromHistory(history);
  ok("transcript names the roles", transcript.includes("User: أنا اسمي أحمد") && transcript.includes("Assistant: اتشرفنا يا أحمد"));
  ok("transcript skips media parts", !transcript.includes("image/jpeg"));
  ok("transcript skips tool calls", !transcript.includes("web_search"));

  const facts = factsFromSummary("1. الاسم أحمد\n- بيحب القهوة\n\nثالث سطر");
  equal("facts strip numbering and bullets", facts.length, 3);
  equal("facts are capped", factsFromSummary("a\nb\nc\nd\ne\nf\ng\nh\ni\nj").length, 8);

  // End to end with a stubbed provider one-shot.
  const chatId = DM;
  await saveChatHistoryAsync(chatId, history);

  const { getProvider } = require("./src/services/aiRouter.cjs");
  const originalGetProvider = getProvider;
  require("./src/services/aiRouter.cjs").getProvider = () => ({
    async runTurn(options) {
      summarizeRunOptions = options;
      return { text: "- الاسم أحمد\n- بيحب القهوة", history: [] };
    },
  });
  let summarizeRunOptions = null;

  try {
    const caller = await callerFor(chatId);
    const result = await runTool("summarize_chat", {}, { caller, sock });
    equal("two facts saved", result.saved, 2);
    const entries = memory.listMemory({ scope: "chat", chatId });
    ok("facts landed in the chat memory file", entries.some((e) => e.content === "الاسم أحمد"));

    // The one-shot summarizer runs WITHOUT tools or search.
    ok("summarizer has no tools", summarizeRunOptions?.useTools === false);
    ok("summarizer has no search", summarizeRunOptions?.search === false);
    ok("summarizer carries the transcript", summarizeRunOptions?.parts?.[0]?.text?.includes("أنا اسمي أحمد"));

    // Explicit control: the model cannot push memory content through args —
    // only `scope` is declared, and the facts come from the transcript.
    const before = memory.listMemory({ scope: "chat", chatId }).length;
    const noHistory = await runTool("summarize_chat", { content: "hack" }, {
      caller: await callerFor("209999999999@s.whatsapp.net"),
      sock,
    });
    ok("unknown chat has nothing to summarize", noHistory.error?.includes("no stored conversation"));
    equal("args did not become memory", memory.listMemory({ scope: "chat", chatId }).length, before);

    // Global scope is owner/admin only — same rule as save_memory.
    const memberCaller = await callerFor(DM);
    runtimeConfig.setPermission("memory", "MEMBERS");
    const denied = await runTool("summarize_chat", { scope: "global" }, { caller: memberCaller, sock });
    ok("member is refused global scope", denied.denied === true);
  } finally {
    require("./src/services/aiRouter.cjs").getProvider = originalGetProvider;
  }
}

section("conversation inspector store");

{
  await saveChatHistoryAsync("201111111111@s.whatsapp.net", [
    { role: "user", parts: [{ text: "مرحبا" }] },
    { role: "model", parts: [{ text: "أهلاً!" }] },
  ]);
  await saveChatHistoryAsync("201222222222@s.whatsapp.net", [
    { role: "user", parts: [{ text: "hi" }] },
  ]);

  const list = await listChatHistoriesAsync();
  ok(
    "inspector lists the seeded chats",
    list.some((r) => r.chatId === "201111111111@s.whatsapp.net") &&
      list.some((r) => r.chatId === "201222222222@s.whatsapp.net"),
  );
  const row222 = list.find((r) => r.chatId === "201222222222@s.whatsapp.net");
  equal("turn count comes from the store", row222.turns, 1);
  ok(
    "sorted newest first",
    list.every((r, i) => i === 0 || list[i - 1].updatedAt >= r.updatedAt),
  );

  const meta = await getChatHistoryWithMetaAsync("201111111111@s.whatsapp.net");
  equal("meta returns the stored turns", meta.history.length, 2);
  ok("meta carries updatedAt", typeof meta.updatedAt === "number");
  ok("unknown chat returns null", (await getChatHistoryWithMetaAsync("209999999999@s.whatsapp.net")) === null);
}

section("help bidi layout");

{
  const help = require("./src/commands/help.cjs");
  let captured = null;
  const helpSock = {
    async sendMessage(jid, content) {
      captured = content?.text;
      return {};
    },
    async sendPresenceUpdate() {},
  };

  await help.execute(helpSock, { key: { remoteJid: DM } }, []);
  ok("list keeps the box layout", captured.includes("│  ◦"));
  ok("command line ends with a colon", /│  ◦ \*!help\*[^:]*:\n/.test(captured));
  ok(
    "description starts its own line under the command",
    /│  ◦ \*!help\*[^:]*:\n│     Shows a list of all commands/.test(captured),
  );

  await help.execute(helpSock, { key: { remoteJid: DM } }, ["help"]);
  ok(
    "detail view puts the Arabic label on its own line",
    captured.includes("├─ *الوصف:*\n│     Shows a list of all commands"),
  );
  ok(
    "detail view puts the command under its label",
    captured.includes("├─ *الأمر:*\n│     !help"),
  );
}

finish();

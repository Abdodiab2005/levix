import { readFileSync } from "node:fs";
import { equal, finish, ok, require, section, useTempDataDir } from "./harness.mjs";

useTempDataDir("levix-extensions-tools");

const settings = require("./src/config/settings.cjs");
// This file tests tool roles and cancellation with Free global writes enabled.
settings.set("ai_global_memory_write", "owner");
settings.set("bot_min_delay_ms", 0);
settings.set("bot_max_delay_ms", 0);
const { timing } = await import("../src/utils/sendBotMessage.esm.js");
timing.sleep = async () => {};
const { runTool, TOOLS } = require("./src/services/aiTools.cjs");
const { resolveCaller } = require("./src/services/aiToolAuth.cjs");
const memory = require("./src/utils/memory.cjs");
const config = require("./src/config/runtime-config.cjs");
const scheduler = require("./scheduler.cjs");
const tts = require("./src/commands/tts.cjs");
const image = require("./src/services/aiImage.cjs");
const router = require("./src/services/aiRouter.cjs");
const store = require("./src/db/store.cjs");
const permissions = await import("../src/utils/permissions.esm.js");

let serial = 0;
const TARGET = "201555555555@s.whatsapp.net";
async function callerFor(sock, fromMe = true) {
  const jid = `20100000${String(++serial).padStart(4, "0")}@s.whatsapp.net`;
  sock.user = { id: jid };
  return resolveCaller({
    sock,
    msg: {
      key: { remoteJid: jid, fromMe, id: `tool-${serial}` },
      message: { conversation: "hello" },
    },
    text: TARGET,
  });
}

section("chat-only memory cannot read, write or delete global scope");
{
  const caller = await callerFor({});
  const saved = await runTool(
    "save_memory",
    { scope: "global", content: "global secret" },
    { caller },
  );
  equal("ordinary global save unchanged", saved.saved, true);
  for (const scope of ["global", "all", "GLOBAL", "ALL", "shared", "SHARED", "عام", "عالمي"]) {
    for (const [tool, args] of [
      ["search_memory", {}],
      ["save_memory", { content: "must not be saved" }],
      ["forget_memory", { ref: saved.id }],
    ]) {
      const result = await runTool(tool, { ...args, scope }, { caller, memoryScope: "chat" });
      equal(`${tool}/${scope}: denied`, result.denied, true);
      equal(
        `${tool}/${scope}: scope error`,
        result.error,
        "global memory is not available in this turn",
      );
      equal(
        `${tool}/${scope}: only error fields, no global data or count`,
        JSON.stringify(Object.keys(result).sort()),
        JSON.stringify(["denied", "error"]),
      );
      equal(
        `${tool}/${scope}: no global payload`,
        JSON.stringify(result).includes("global secret"),
        false,
      );
    }
  }
  const chat = await runTool(
    "save_memory",
    { content: "chat fact" },
    { caller, memoryScope: "chat" },
  );
  equal("chat write still allowed", chat.saved, true);
  equal(
    "chat search still allowed",
    (await runTool("search_memory", {}, { caller, memoryScope: "chat" })).chat.length,
    1,
  );
  equal(
    "chat delete still allowed",
    (await runTool("forget_memory", { ref: chat.id }, { caller, memoryScope: "chat" })).removed,
    true,
  );

  const globalBefore = JSON.stringify(memory.listMemory({ scope: "global" }));
  for (const [name, args] of [
    ["omitted", {}],
    ["undefined", { scope: undefined }],
    ["null", { scope: null }],
    ["empty", { scope: "" }],
  ]) {
    const context = { caller, memoryScope: "chat" };
    const savedChat = await runTool(
      "save_memory",
      { ...args, content: "default chat fact" },
      context,
    );
    equal(`${name}: save defaults to chat`, savedChat.scope, "chat");
    const found = await runTool("search_memory", args, context);
    equal(
      `${name}: search returns only chat data, no global data or count`,
      JSON.stringify(Object.keys(found)),
      JSON.stringify(["chat"]),
    );
    equal(`${name}: search returns the chat fact`, found.chat?.[0]?.content, "default chat fact");
    equal(
      `${name}: global id cannot delete global memory`,
      (await runTool("forget_memory", { ...args, ref: saved.id }, context)).removed,
      false,
    );
    equal(
      `${name}: global entries stay unchanged`,
      JSON.stringify(memory.listMemory({ scope: "global" })),
      globalBefore,
    );
    equal(
      `${name}: delete defaults to chat`,
      (await runTool("forget_memory", { ...args, ref: savedChat.id }, context)).removed,
      true,
    );
  }
  const ordinary = await runTool("search_memory", { scope: "all" }, { caller });
  equal("flag absent preserves global reads", ordinary.global[0]?.content, "global secret");
  equal(
    "flag absent preserves global deletes",
    (await runTool("forget_memory", { scope: "global", ref: saved.id }, { caller })).removed,
    true,
  );

  const member = await callerFor({}, false);
  config.setPermission("memory", "MEMBERS");
  try {
    equal(
      "member cannot search all memory",
      (await runTool("search_memory", { scope: "all" }, { caller: member, memoryScope: "chat" }))
        .denied,
      true,
    );
  } finally {
    config.setPermission("memory", null);
  }
}

section("chat-only memory tools refuse a missing or empty chat ID");
{
  const entry = memory.addMemory({ scope: "global", content: "global fallback secret" });
  const before = readFileSync(entry.file, "utf8");
  try {
    for (const chatId of [undefined, null, ""]) {
      for (const scope of [undefined, "chat"]) {
        for (const [tool, args] of [
          ["save_memory", { content: "must not reach global memory" }],
          ["search_memory", {}],
          ["forget_memory", { ref: entry.id }],
        ]) {
          // resolveCaller cannot mint an empty chat ID. Call the handlers
          // directly so generic caller authentication cannot mask this guard.
          const result = await TOOLS[tool].run(
            { ...args, scope },
            { caller: { chatId }, memoryScope: "chat" },
          );
          equal(
            `${tool}/${String(chatId)}/${String(scope)}: normal refusal without global data`,
            JSON.stringify(result),
            JSON.stringify({ error: "only chat memory is available", denied: true }),
          );
          equal(
            `${tool}/${String(chatId)}/${String(scope)}: global.md stays unchanged`,
            readFileSync(entry.file, "utf8"),
            before,
          );
        }
      }
    }
  } finally {
    memory.removeMemory({ scope: "global", ref: entry.id });
  }
}

section("chat-only turns cannot summarize stored explicit-command history");
{
  const caller = await callerFor({});
  const historyHub = require("./src/utils/storage-hub.cjs");
  const marker = "AUTOREPLY_PRIVATE_GLOBAL_SECRET_08A";
  store.saveChatHistory(caller.chatId, [
    { role: "user", parts: [{ text: "!ai recall my global memory" }] },
    { role: "model", parts: [{ text: `Your global memory says: ${marker}` }] },
  ]);
  const chatBefore = JSON.stringify(memory.listMemory({ chatId: caller.chatId }));
  const globalBefore = JSON.stringify(memory.listMemory({ scope: "global" }));
  const originalGetHistory = historyHub.getChatHistoryAsync;
  const originalGetProvider = router.getProvider;
  const originalAddMemory = memory.addMemory;
  let historyReads = 0;
  let summaries = 0;
  let writes = 0;
  let transcript = "";
  let explicit;
  historyHub.getChatHistoryAsync = async (...args) => {
    historyReads += 1;
    return originalGetHistory(...args);
  };
  router.getProvider = () => ({
    async runTurn(options) {
      summaries += 1;
      transcript = options.parts[0].text;
      return { text: `- ${marker}` };
    },
  });
  memory.addMemory = (...args) => {
    writes += 1;
    return originalAddMemory(...args);
  };
  try {
    for (const args of [
      {},
      { scope: undefined },
      { scope: null },
      { scope: "" },
      ...["chat", "global", "all", "GLOBAL", "ALL", "shared", "SHARED", "عام", "عالمي"].map(
        (scope) => ({ scope }),
      ),
    ]) {
      const result = await runTool("summarize_chat", args, { caller, memoryScope: "chat" });
      equal(
        `${String(args.scope)}: normal refusal without leaked facts`,
        JSON.stringify(result),
        JSON.stringify({ error: "stored chat history is unavailable in this turn", denied: true }),
      );
      equal(`${String(args.scope)}: history is not read`, historyReads, 0);
      equal(`${String(args.scope)}: summarizer is not called`, summaries, 0);
      equal(`${String(args.scope)}: memory is not written`, writes, 0);
    }
    equal(
      "chat memory stays unchanged",
      JSON.stringify(memory.listMemory({ chatId: caller.chatId })),
      chatBefore,
    );
    equal(
      "global memory stays unchanged",
      JSON.stringify(memory.listMemory({ scope: "global" })),
      globalBefore,
    );

    explicit = await runTool("summarize_chat", {}, { caller });
    equal("explicit owner turn still reads history", historyReads, 1);
    equal("explicit owner turn still calls the summarizer", summaries, 1);
    ok("explicit transcript still contains the stored answer", transcript.includes(marker));
    equal("explicit summary still defaults to chat memory", explicit.scope, "chat");
    equal("explicit summary still saves its fact", explicit.saved, 1);
    equal("explicit summary writes once", writes, 1);
    equal("explicit summary returns the fact", explicit.facts?.[0], marker);
    equal(
      "explicit summary stores the fact",
      memory.listMemory({ chatId: caller.chatId })[0]?.content,
      marker,
    );
  } finally {
    historyHub.getChatHistoryAsync = originalGetHistory;
    router.getProvider = originalGetProvider;
    memory.addMemory = originalAddMemory;
    store.deleteChatHistory(caller.chatId);
    for (const ref of explicit?.ids || []) memory.removeMemory({ chatId: caller.chatId, ref });
  }
}

section("slow sends retain the turn guard and cancellation signal");
{
  const originalVoice = tts._synthesizeVoice;
  const originalImage = image.generateImage;
  tts._synthesizeVoice = async () => ({
    audio: Buffer.from("OggS-test"),
    mimetype: "audio/ogg",
    ptt: true,
  });
  image.generateImage = async () => ({ image: Buffer.from("image"), mimetype: "image/png" });
  try {
    for (const cancellation of ["guard", "signal"]) {
      for (const [tool, args] of [
        ["speak", { text: "hello" }],
        ["generate_image", { prompt: "cat" }],
        ["create_poll", { question: "Which?", options: ["A", "B"] }],
      ]) {
        const controller = new AbortController();
        let active = true;
        let sent = 0;
        let refreshes = 0;
        const sock = {
          async sendMessage(_jid, _content, options) {
            // Same boundary as the Phase 07.5 socket: async preparation, then
            // refresh/assert immediately before the wire side effect.
            await Promise.resolve();
            if (cancellation === "signal") controller.abort();
            else active = false;
            await options.deliveryGuard.refresh();
            options.deliveryGuard.assert();
            sent += 1;
            return { key: { id: "sent" } };
          },
        };
        const caller = await callerFor(sock);
        const result = await runTool(tool, args, {
          caller,
          sock,
          signal: controller.signal,
          deliveryGuard: {
            async refresh() {
              refreshes += 1;
            },
            assert() {
              if (!active)
                throw Object.assign(new Error("turn no longer active"), { code: "DENIED" });
            },
          },
        });
        equal(`${tool}/${cancellation}: no send`, sent, 0);
        ok(`${tool}/${cancellation}: tool reports an error`, Boolean(result.error));
        ok(`${tool}/${cancellation}: turn refresh reaches delivery`, refreshes >= 2);
      }
    }
  } finally {
    tts._synthesizeVoice = originalVoice;
    image.generateImage = originalImage;
  }
}

section("every tool write asserts the turn guard after admission");
{
  const caller = await callerFor({});
  const original = {
    add: memory.addMemory,
    remove: memory.removeMemory,
    schedule: scheduler.scheduleJobNow,
    jobs: scheduler.getScheduledJobs,
    cancel: scheduler.deleteScheduledJob,
    provider: router.getProvider,
  };
  let writes = 0;
  memory.addMemory = () => {
    writes += 1;
    return { id: "saved" };
  };
  memory.removeMemory = () => {
    writes += 1;
    return { content: "removed" };
  };
  scheduler.scheduleJobNow = () => {
    writes += 1;
    return { ok: true };
  };
  scheduler.getScheduledJobs = () => [{ id: "reminder", targetJid: caller.chatId }];
  scheduler.deleteScheduledJob = () => {
    writes += 1;
  };
  router.getProvider = () => ({ runTurn: async () => ({ text: "- a fact" }) });
  store.saveChatHistory(caller.chatId, [{ role: "user", parts: [{ text: "remember this" }] }]);
  try {
    for (const [tool, args] of [
      ["save_memory", { content: "fact" }],
      ["forget_memory", { ref: "saved" }],
      ["grant_role", { target: TARGET }],
      ["revoke_role", { target: TARGET }],
      ["create_reminder", { message: "hi", in_minutes: 5 }],
      ["cancel_reminder", { id: "reminder" }],
      ["summarize_chat", {}],
    ]) {
      let checks = 0;
      const rolesBefore = JSON.stringify(permissions.listRoles());
      const result = await runTool(tool, args, {
        caller,
        deliveryGuard: {
          async refresh() {},
          assert() {
            if (++checks > 1)
              throw Object.assign(new Error("entitlement expired"), { code: "DENIED" });
          },
        },
      });
      equal(`${tool}: write refused`, result.denied, true);
      equal(`${tool}: guarded at write boundary`, checks, 2);
      equal(`${tool}: no memory or schedule mutation`, writes, 0);
      equal(`${tool}: no role mutation`, JSON.stringify(permissions.listRoles()), rolesBefore);
    }
  } finally {
    memory.addMemory = original.add;
    memory.removeMemory = original.remove;
    scheduler.scheduleJobNow = original.schedule;
    scheduler.getScheduledJobs = original.jobs;
    scheduler.deleteScheduledJob = original.cancel;
    router.getProvider = original.provider;
  }
}

finish();

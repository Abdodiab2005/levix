import { equal, finish, ok, require, section, useTempDataDir } from "./harness.mjs";

useTempDataDir("levix-extensions-tools");

const settings = require("./src/config/settings.cjs");
settings.set("bot_min_delay_ms", 0);
settings.set("bot_max_delay_ms", 0);
const { timing } = await import("../src/utils/sendBotMessage.esm.js");
timing.sleep = async () => {};
const { runTool } = require("./src/services/aiTools.cjs");
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

section("chat-only memory cannot read, write, delete or summarize global scope");
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
      ["summarize_chat", {}],
    ]) {
      const result = await runTool(tool, { ...args, scope }, { caller, memoryScope: "chat" });
      equal(`${tool}/${scope}: denied`, result.denied, true);
      equal(`${tool}/${scope}: scope error`, result.error, "only chat memory is available");
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
  const originalGetProvider = router.getProvider;
  router.getProvider = () => ({ runTurn: async () => ({ text: "- chat summary fact" }) });
  store.saveChatHistory(caller.chatId, [
    { role: "user", parts: [{ text: "remember a fact from this chat" }] },
  ]);
  try {
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
      const summary = await runTool("summarize_chat", args, context);
      equal(`${name}: summary defaults to chat`, summary.scope, "chat");
      equal(`${name}: summary saves a chat fact`, summary.saved, 1);
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
      for (const ref of summary.ids || []) {
        await runTool("forget_memory", { ...args, ref }, context);
      }
    }
  } finally {
    router.getProvider = originalGetProvider;
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

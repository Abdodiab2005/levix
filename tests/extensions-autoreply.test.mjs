import { join } from "node:path";
import { equal, finish, ok, require, ROOT, section, throws, useTempDataDir } from "./harness.mjs";

useTempDataDir("levix-extensions-autoreply");

const settings = require("./src/config/settings.cjs");
settings.set("bot_min_delay_ms", 0);
settings.set("bot_max_delay_ms", 0);

const { timing } = await import(join(ROOT, "src/utils/sendBotMessage.esm.js"));
timing.sleep = async () => {};

const autoReply = require("./src/extensions/autoReply.cjs");
const { host } = require("./src/extensions/host.cjs");
const { processMessage } = await import("../src/handlers/message.handler.js");

const CHAT = "201111111111@s.whatsapp.net";
const GROUP = "120363000000000001@g.us";
const SENDER = "201222222222@s.whatsapp.net";

const sock = {
  user: { id: "201999999999:7@s.whatsapp.net" },
  async sendMessage(jid, _content) {
    return { key: { id: "sent", remoteJid: jid } };
  },
  async sendPresenceUpdate() {},
};

function dm(text, extra = {}) {
  return {
    key: { remoteJid: CHAT, fromMe: false, id: extra.id || "m1", ...extra.key },
    pushName: "n",
    messageTimestamp: 1,
    message: extra.message || { conversation: text },
    ...extra.rest,
  };
}

function groupMsg(text, extra = {}) {
  return {
    key: {
      remoteJid: GROUP,
      participant: SENDER,
      fromMe: false,
      id: extra.id || "g1",
    },
    pushName: "n",
    messageTimestamp: 1,
    message: extra.message || { conversation: text },
  };
}

function runtime(overrides = {}) {
  const ac = new AbortController();
  return {
    isActive: () => true,
    generation: () => 1,
    signal: () => ac.signal,
    getScope: () => new Set([CHAT, GROUP]),
    consider: async () => ({ reply: true, instructions: "be brief", quote: true }),
    considerTimeoutMs: () => 2000,
    recordFailure() {},
    log: { error() {}, warn() {}, debug() {} },
    now: () => Date.now(),
    abort: () => ac.abort(),
    ...overrides,
  };
}

function reset() {
  autoReply.resetAutoReplyDeps();
  autoReply.abortAccountJobs();
}

section("no forward for commands");
{
  let calls = 0;
  const orig = host.dispatchAutoReply;
  host.dispatchAutoReply = async () => {
    calls += 1;
  };
  await processMessage(sock, dm("!ping"), "!ping", 0);
  equal("command skipped", calls, 0);
  await processMessage(sock, dm("hello there"), "hello there", 0);
  equal("plain text dispatched", calls, 1);
  host.dispatchAutoReply = orig;
}

section("intake filters");
{
  const sent = [];
  reset();
  autoReply.setAutoReplyDeps({
    getMessageFromRecent: async () => undefined,
    accountEpoch: () => 1,
    runAgent: async () => ({ text: "answer" }),
    resolveCaller: async (opts) =>
      Object.freeze({
        chatId: opts.msg.key.remoteJid,
        isGroup: opts.msg.key.remoteJid.endsWith("@g.us"),
        senderId: opts.msg.key.participant || opts.msg.key.remoteJid,
        senderName: "n",
        isOwner: false,
        isBotAdmin: false,
        chatName: null,
      }),
    sendBotMessage: async (_sock, jid, content, opts) => {
      await opts?.deliveryGuard?.refresh?.();
      opts?.deliveryGuard?.assert?.();
      sent.push({ jid, content, opts });
      return { key: { id: "s", remoteJid: jid } };
    },
    groupMetadataCache: {
      resolveGroupMetadata: async () => ({ id: GROUP, participants: [] }),
      getRosterVersion: () => "0:0",
      isRosterStale: () => false,
    },
    settingsGet: (key) => (key === "ai_tool_timeout_ms" ? 5000 : true),
  });

  sent.length = 0;
  await autoReply.dispatch(runtime({ isActive: () => false }), sock, dm("hi", { id: "off" }), 1);
  equal("inactive host", sent.length, 0);

  sent.length = 0;
  await autoReply.dispatch(
    runtime(),
    sock,
    dm("hi", { key: { fromMe: true, remoteJid: CHAT, id: "me" } }),
    1,
  );
  equal("fromMe", sent.length, 0);

  autoReply.setAutoReplyDeps({ getMessageFromRecent: async () => ({ conversation: "own" }) });
  sent.length = 0;
  await autoReply.dispatch(runtime(), sock, dm("hi", { id: "recent" }), 1);
  equal("own recent send", sent.length, 0);
  autoReply.setAutoReplyDeps({ getMessageFromRecent: async () => undefined });

  autoReply.setAutoReplyDeps({ isLinkedSelf: () => true });
  sent.length = 0;
  await autoReply.dispatch(runtime(), sock, dm("hi", { id: "self" }), 1);
  equal("linked self", sent.length, 0);
  autoReply.setAutoReplyDeps({ isLinkedSelf: () => false });

  sent.length = 0;
  await autoReply.dispatch(
    runtime(),
    sock,
    dm("hi", {
      id: "bot",
      message: { conversation: "hi", messageContextInfo: { botMetadata: {} } },
    }),
    1,
  );
  equal("botMetadata", sent.length, 0);

  sent.length = 0;
  await autoReply.dispatch(
    runtime({ getScope: () => new Set(["other@s.whatsapp.net"]) }),
    sock,
    dm("hi", { id: "scope" }),
    1,
  );
  equal("out of scope", sent.length, 0);

  sent.length = 0;
  await autoReply.dispatch(runtime(), sock, dm("hi", { id: "epoch" }), 9);
  equal("changed epoch", sent.length, 0);
}

section("reply sent once to the source chat only");
{
  const sent = [];
  let callerOpts = null;
  let agentOpts = null;
  reset();
  autoReply.setAutoReplyDeps({
    getMessageFromRecent: async () => undefined,
    accountEpoch: () => 1,
    isLinkedSelf: () => false,
    runAgent: async (opts) => {
      agentOpts = opts;
      return { text: "answer" };
    },
    resolveCaller: async (opts) => {
      callerOpts = opts;
      return Object.freeze({
        chatId: opts.msg.key.remoteJid,
        isGroup: false,
        senderId: CHAT,
        senderName: "n",
        isOwner: false,
        isBotAdmin: false,
        chatName: null,
      });
    },
    sendBotMessage: async (_sock, jid, content, opts) => {
      opts?.signal?.throwIfAborted?.();
      await opts.deliveryGuard.refresh();
      opts.deliveryGuard.assert();
      sent.push({ jid, content, quote: opts.quote });
      return { key: { id: "s", remoteJid: jid } };
    },
    groupMetadataCache: {
      resolveGroupMetadata: async () => null,
      getRosterVersion: () => "0:0",
      isRosterStale: () => false,
    },
    settingsGet: () => 5000,
  });
  const msg = dm("hello world", { id: "ok1" });
  await autoReply.dispatch(runtime(), sock, msg, 1);
  equal("one send", sent.length, 1);
  equal("source chat", sent[0].jid, CHAT);
  equal("quoted when asked", sent[0].quote, true);
  equal("caller uses the real message", callerOpts.msg, msg);
  equal("global memory excluded for non-owner", agentOpts.context.includeGlobalMemory, false);
  equal("memory tools restricted to chat", agentOpts.context.memoryScope, "chat");
  equal("tools share the turn signal", agentOpts.context.signal, agentOpts.signal);
  ok(
    "tools receive the delivery guard",
    typeof agentOpts.context.deliveryGuard.assert === "function",
  );
}

section("entitlement revoked during the turn: no send");
{
  const sent = [];
  let active = true;
  const ac = new AbortController();
  reset();
  autoReply.setAutoReplyDeps({
    getMessageFromRecent: async () => undefined,
    accountEpoch: () => 1,
    isLinkedSelf: () => false,
    runAgent: async () => {
      active = false;
      ac.abort();
      return { text: "late" };
    },
    resolveCaller: async (opts) =>
      Object.freeze({
        chatId: opts.msg.key.remoteJid,
        isGroup: false,
        senderId: CHAT,
        isOwner: false,
        isBotAdmin: false,
        senderName: "n",
        chatName: null,
      }),
    sendBotMessage: async (_sock, _jid, content, opts) => {
      opts?.signal?.throwIfAborted?.();
      await opts.deliveryGuard.refresh();
      opts.deliveryGuard.assert();
      sent.push(content);
    },
    groupMetadataCache: {
      resolveGroupMetadata: async () => null,
      getRosterVersion: () => "0:0",
      isRosterStale: () => false,
    },
    settingsGet: () => 5000,
  });
  await autoReply.dispatch(
    runtime({ isActive: () => active, signal: () => ac.signal }),
    sock,
    dm("hi", { id: "revoked" }),
    1,
  );
  equal("no send after revoke", sent.length, 0);
}

section("accountReset during the turn: no send");
{
  const sent = [];
  reset();
  autoReply.setAutoReplyDeps({
    getMessageFromRecent: async () => undefined,
    accountEpoch: () => 1,
    isLinkedSelf: () => false,
    runAgent: async () => {
      autoReply.abortAccountJobs();
      return { text: "late" };
    },
    resolveCaller: async (opts) =>
      Object.freeze({
        chatId: opts.msg.key.remoteJid,
        isGroup: false,
        senderId: CHAT,
        isOwner: false,
        isBotAdmin: false,
        senderName: "n",
        chatName: null,
      }),
    sendBotMessage: async (_sock, _jid, content, opts) => {
      opts?.signal?.throwIfAborted?.();
      await opts.deliveryGuard.refresh();
      opts.deliveryGuard.assert();
      sent.push(content);
    },
    groupMetadataCache: {
      resolveGroupMetadata: async () => null,
      getRosterVersion: () => "0:0",
      isRosterStale: () => false,
    },
    settingsGet: () => 5000,
  });
  await autoReply.dispatch(runtime(), sock, dm("hi", { id: "reset" }), 1);
  equal("no send after accountReset", sent.length, 0);
}

section("generation change: no send");
{
  const sent = [];
  let gen = 1;
  reset();
  autoReply.setAutoReplyDeps({
    getMessageFromRecent: async () => undefined,
    accountEpoch: () => 1,
    isLinkedSelf: () => false,
    runAgent: async () => {
      gen = 2;
      return { text: "late" };
    },
    resolveCaller: async (opts) =>
      Object.freeze({
        chatId: opts.msg.key.remoteJid,
        isGroup: false,
        senderId: CHAT,
        isOwner: false,
        isBotAdmin: false,
        senderName: "n",
        chatName: null,
      }),
    sendBotMessage: async (_sock, _jid, content, opts) => {
      opts?.signal?.throwIfAborted?.();
      await opts.deliveryGuard.refresh();
      opts.deliveryGuard.assert();
      sent.push(content);
    },
    groupMetadataCache: {
      resolveGroupMetadata: async () => null,
      getRosterVersion: () => "0:0",
      isRosterStale: () => false,
    },
    settingsGet: () => 5000,
  });
  await autoReply.dispatch(runtime({ generation: () => gen }), sock, dm("hi", { id: "gen" }), 1);
  equal("no send after generation change", sent.length, 0);
}

section("backstop rate limits");
{
  const sent = [];
  reset();
  autoReply.setAutoReplyDeps({
    getMessageFromRecent: async () => undefined,
    accountEpoch: () => 1,
    isLinkedSelf: () => false,
    runAgent: async () => ({ text: "answer" }),
    resolveCaller: async (opts) =>
      Object.freeze({
        chatId: opts.msg.key.remoteJid,
        isGroup: false,
        senderId: CHAT,
        isOwner: false,
        isBotAdmin: false,
        senderName: "n",
        chatName: null,
      }),
    sendBotMessage: async (_sock, jid, _content, opts) => {
      await opts.deliveryGuard.refresh();
      opts.deliveryGuard.assert();
      sent.push(jid);
    },
    groupMetadataCache: {
      resolveGroupMetadata: async () => null,
      getRosterVersion: () => "0:0",
      isRosterStale: () => false,
    },
    settingsGet: () => 5000,
  });
  const rt = runtime();
  for (let i = 0; i < 7; i++) {
    await autoReply.dispatch(rt, sock, dm("hi", { id: `rate${i}` }), 1);
  }
  equal("six per chat per minute", sent.length, 6);
}

section("one per chat in flight");
{
  const sent = [];
  let release;
  let entered = 0;
  reset();
  autoReply.setAutoReplyDeps({
    getMessageFromRecent: async () => undefined,
    accountEpoch: () => 1,
    isLinkedSelf: () => false,
    runAgent: () => {
      entered += 1;
      if (entered > 1) return Promise.resolve({ text: "second" });
      return new Promise((resolve) => {
        release = () => resolve({ text: "first" });
      });
    },
    resolveCaller: async (opts) =>
      Object.freeze({
        chatId: opts.msg.key.remoteJid,
        isGroup: false,
        senderId: CHAT,
        isOwner: false,
        isBotAdmin: false,
        senderName: "n",
        chatName: null,
      }),
    sendBotMessage: async (_sock, _jid, content, opts) => {
      await opts.deliveryGuard.refresh();
      opts.deliveryGuard.assert();
      sent.push(content.text);
    },
    groupMetadataCache: {
      resolveGroupMetadata: async () => null,
      getRosterVersion: () => "0:0",
      isRosterStale: () => false,
    },
    settingsGet: () => 5000,
  });
  const rt = runtime();
  const first = autoReply.dispatch(rt, sock, dm("hi", { id: "fly1" }), 1);
  const deadline = Date.now() + 1000;
  while (entered < 1 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const second = autoReply.dispatch(rt, sock, dm("hi", { id: "fly2" }), 1);
  await second;
  equal("second never started a turn", entered, 1);
  equal("second dropped while in flight", sent.length, 0);
  release();
  await first;
  equal("first sent after release", sent.length, 1);
  equal("first text", sent[0], "first");
}

section("global memory excluded option and owner chat");
{
  const seen = [];
  reset();
  autoReply.setAutoReplyDeps({
    getMessageFromRecent: async () => undefined,
    accountEpoch: () => 1,
    isLinkedSelf: () => false,
    runAgent: async (opts) => {
      seen.push(opts.context);
      return { text: "ok" };
    },
    resolveCaller: async (opts) =>
      Object.freeze({
        chatId: opts.msg.key.remoteJid,
        isGroup: opts.msg.key.remoteJid.endsWith("@g.us"),
        senderId: opts.msg.key.participant || opts.msg.key.remoteJid,
        senderName: "n",
        isOwner: !opts.msg.key.remoteJid.endsWith("@g.us"),
        isBotAdmin: false,
        chatName: null,
      }),
    sendBotMessage: async (_sock, _jid, _content, opts) => {
      await opts.deliveryGuard.refresh();
      opts.deliveryGuard.assert();
    },
    groupMetadataCache: {
      resolveGroupMetadata: async () => ({ id: GROUP, participants: [] }),
      getRosterVersion: () => "0:0",
      isRosterStale: () => false,
    },
    settingsGet: () => 5000,
  });
  await autoReply.dispatch(runtime(), sock, groupMsg("hi", { id: "gmem" }), 1);
  await autoReply.dispatch(runtime(), sock, dm("hi", { id: "omem" }), 1);
  equal("group excludes global", seen[0].includeGlobalMemory, false);
  equal("group memory tools restricted", seen[0].memoryScope, "chat");
  equal("owner private includes global", seen[1].includeGlobalMemory, true);
  equal("owner private memory tools unchanged", seen[1].memoryScope, undefined);
}

section("tool authorization uses the real sender caller");
{
  let callerMsg = null;
  reset();
  autoReply.setAutoReplyDeps({
    getMessageFromRecent: async () => undefined,
    accountEpoch: () => 1,
    isLinkedSelf: () => false,
    runAgent: async (opts) => {
      callerMsg = opts.context.caller;
      return { text: "ok" };
    },
    resolveCaller: async (opts) =>
      Object.freeze({
        chatId: opts.msg.key.remoteJid,
        isGroup: false,
        senderId: "real-sender",
        senderName: "n",
        isOwner: false,
        isBotAdmin: false,
        chatName: null,
        fromMessage: opts.msg,
      }),
    sendBotMessage: async (_sock, _jid, _content, opts) => {
      await opts.deliveryGuard.refresh();
      opts.deliveryGuard.assert();
    },
    groupMetadataCache: {
      resolveGroupMetadata: async () => null,
      getRosterVersion: () => "0:0",
      isRosterStale: () => false,
    },
    settingsGet: () => 5000,
  });
  const msg = dm("please remind me", { id: "authz" });
  await autoReply.dispatch(runtime(), sock, msg, 1);
  equal("caller senderId", callerMsg.senderId, "real-sender");
  equal("caller from the original message", callerMsg.fromMessage, msg);
}

function stubTurn(overrides = {}) {
  reset();
  const sent = [];
  autoReply.setAutoReplyDeps({
    getMessageFromRecent: async () => undefined,
    accountEpoch: () => 1,
    isLinkedSelf: () => false,
    resolveCaller: async ({ msg }) => ({
      chatId: msg.key.remoteJid,
      senderId: msg.key.remoteJid,
      isGroup: false,
      isOwner: false,
    }),
    runAgent: async () => ({ text: "answer" }),
    sendBotMessage: async (_sock, jid, content, options) => {
      await options.deliveryGuard.refresh();
      options.deliveryGuard.assert();
      sent.push({ jid, content });
    },
    settingsGet: () => 5000,
    ...overrides,
  });
  return sent;
}

section("replay claims cover concurrent and completed redeliveries");
{
  const sent = stubTurn();
  let considered = 0;
  const rt = runtime({
    consider: async () => {
      considered += 1;
      return { reply: true };
    },
  });
  const msg = dm("hi", { id: "replay" });
  await Promise.all([autoReply.dispatch(rt, sock, msg, 1), autoReply.dispatch(rt, sock, msg, 1)]);
  await autoReply.dispatch(rt, sock, msg, 1);
  equal("forwarded once", considered, 1);
  equal("AI reply sent once", sent.length, 1);
}

section("pending capability keys include chat and account epoch");
{
  let epoch = 1;
  const sent = stubTurn({ accountEpoch: () => epoch });
  const other = "201333333333@s.whatsapp.net";
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let both;
  const ready = new Promise((resolve) => {
    both = resolve;
  });
  let count = 0;
  const rt = runtime({
    getScope: () => new Set([CHAT, other]),
    consider: () => {
      if (++count === 2) both();
      return gate;
    },
  });
  const first = autoReply.dispatch(rt, sock, dm("first", { id: "same" }), epoch);
  const second = autoReply.dispatch(
    rt,
    sock,
    dm("second", { key: { remoteJid: other, id: "same" } }),
    epoch,
  );
  await ready;
  equal(
    "message id alone cannot claim a pending turn",
    (await autoReply.runAiReply(rt, { messageId: "same" })).sent,
    false,
  );
  equal(
    "first chat claims its own entry",
    (await autoReply.runAiReply(rt, { chatJid: CHAT, messageId: "same" })).sent,
    true,
  );
  equal(
    "other chat entry was not overwritten",
    (await autoReply.runAiReply(rt, { chatJid: other, messageId: "same" })).sent,
    true,
  );
  equal("destinations stay separate", sent.map((entry) => entry.jid).join(","), `${CHAT},${other}`);
  release({ reply: false });
  await Promise.all([first, second]);
  epoch = 2;
  await autoReply.dispatch(runtime(), sock, dm("new account", { id: "same" }), epoch);
  equal("same id can belong to a new account", sent.length, 3);
}

section("seen claims are bounded and expire after 24 hours");
{
  let now = 1000;
  stubTurn({ now: () => now });
  let count = 0;
  const rt = runtime({
    consider: async () => {
      count += 1;
      return { reply: false };
    },
  });
  for (let i = 0; i < 2001; i++) {
    await autoReply.dispatch(rt, sock, dm("hi", { id: `seen-${i}` }), 1);
  }
  equal("no more than 2000 live claims", count, 2000);
  await autoReply.dispatch(rt, sock, dm("hi", { id: "seen-0" }), 1);
  equal("capacity does not evict a live replay claim", count, 2000);
  now += 24 * 60 * 60 * 1000;
  await autoReply.dispatch(rt, sock, dm("hi", { id: "seen-0" }), 1);
  equal("expired claims allow work again", count, 2001);
}

section("scope removal fences tools and final delivery without an abort event");
{
  const scope = new Set([CHAT]);
  const sent = stubTurn({
    runAgent: async ({ context }) => {
      scope.delete(CHAT);
      throws("tool guard checks live chat scope", () => context.deliveryGuard.assert());
      return { text: "late" };
    },
  });
  await autoReply.dispatch(
    runtime({ getScope: () => scope }),
    sock,
    dm("hi", { id: "removed" }),
    1,
  );
  equal("final answer also dropped", sent.length, 0);
}

reset();
finish();

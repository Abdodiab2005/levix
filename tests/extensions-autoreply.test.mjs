import { join } from "node:path";
import { equal, finish, require, ROOT, section, useTempDataDir } from "./harness.mjs";

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
      seen.push(opts.context.includeGlobalMemory);
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
  equal("group excludes global", seen[0], false);
  equal("owner private includes global", seen[1], true);
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

reset();
finish();

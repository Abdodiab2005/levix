// Auto Reply decisions (PR-4): deterministic acknowledgements, forced-tool
// classification across Gemini / OpenAI-compatible / Anthropic, decision
// validation, presence discipline, command throw isolation (A-3), and
// disconnect cancellation (A-4). Fake sockets and local/mocked providers only;
// no network.

import { EventEmitter } from "node:events";
import { join } from "node:path";
import { DisconnectReason } from "@whiskeysockets/baileys";
import {
  errorReply,
  functionCallReply,
  startGenaiServer,
  textReply,
} from "./fixtures/genai-server.mjs";
import {
  ANTHROPIC_PATH,
  anthropicText,
  anthropicToolCall,
  OPENAI_PATH,
  openaiText,
  openaiToolCall,
  providerError,
  startProviderServer,
} from "./fixtures/provider-server.mjs";
import { equal, finish, ok, ROOT, require, section, useTempDataDir } from "./harness.mjs";

useTempDataDir("levix-autoreply-decisions");

const settings = require("./src/config/settings.cjs");
settings.set("bot_min_delay_ms", 0);
settings.set("bot_max_delay_ms", 0);

const { timing } = await import(join(ROOT, "src/utils/sendBotMessage.esm.js"));
timing.sleep = async () => {};

const autoReply = require("./src/extensions/autoReply.cjs");
const {
  classifyAcknowledgement,
  THANKS_EMOJI,
  LAUGHTER_EMOJI,
} = require("./src/extensions/autoReplyAck.cjs");
const { host } = require("./src/extensions/host.cjs");
const aiAgent = require("./src/services/aiAgent.cjs");
const aiProviders = require("./src/services/aiProviders.cjs");
const { processMessage } = await import("../src/handlers/message.handler.js");
const { getLoadedCommands, loadCommands } = await import("../src/handlers/command.handler.js");
const { WhatsAppSession } = await import("../src/core/session.js");

const CHAT = "201111111111@s.whatsapp.net";
const GROUP = "120363000000000001@g.us";
const SENDER = "201222222222@s.whatsapp.net";

function makeSock(overrides = {}) {
  const sent = [];
  const presence = [];
  const events = [];
  return {
    user: { id: "201999999999:7@s.whatsapp.net" },
    sent,
    presence,
    events,
    async sendMessage(jid, content, opts) {
      events.push({ kind: "send", jid, content, opts });
      sent.push({ jid, content, opts });
      return { key: { id: "sent", remoteJid: jid } };
    },
    async sendPresenceUpdate(state, jid) {
      events.push({ kind: "presence", state, jid });
      presence.push({ state, jid });
    },
    ...overrides,
  };
}

function dm(text, extra = {}) {
  return {
    key: { remoteJid: CHAT, fromMe: false, id: extra.id || "m1", ...extra.key },
    pushName: "Tester",
    messageTimestamp: 1,
    message: extra.message || { conversation: text },
    ...extra.rest,
  };
}

function runtime(overrides = {}) {
  const ac = new AbortController();
  const warnings = [];
  return {
    isActive: () => true,
    generation: () => 1,
    signal: () => ac.signal,
    getScope: () => new Set([CHAT, GROUP]),
    consider: async () => ({ reply: true, instructions: "be concise", quote: true }),
    considerTimeoutMs: () => 2000,
    recordFailure() {},
    warnings,
    log: {
      error() {},
      warn(meta, msg) {
        warnings.push({ meta, msg });
      },
      debug() {},
    },
    now: () => Date.now(),
    abort: () => ac.abort(),
    ...overrides,
  };
}

function reset() {
  autoReply.resetAutoReplyDeps();
  autoReply.abortAccountJobs();
}

function wireBaseDeps(sock, extra = {}) {
  autoReply.setAutoReplyDeps({
    getMessageFromRecent: async () => undefined,
    accountEpoch: () => 1,
    isLinkedSelf: () => false,
    resolveCaller: async (opts) =>
      Object.freeze({
        chatId: opts.msg.key.remoteJid,
        isGroup: opts.msg.key.remoteJid.endsWith("@g.us"),
        senderId: opts.msg.key.participant || opts.msg.key.remoteJid,
        senderName: "Tester",
        isOwner: false,
        isBotAdmin: false,
        chatName: null,
      }),
    sendBotMessage: async (targetSock, jid, content, opts) => {
      opts?.signal?.throwIfAborted?.();
      await opts?.deliveryGuard?.refresh?.();
      opts?.deliveryGuard?.assert?.();
      return targetSock.sendMessage(jid, content, opts);
    },
    groupMetadataCache: {
      resolveGroupMetadata: async () => ({ id: GROUP, participants: [] }),
      getRosterVersion: () => "0:0",
      isRosterStale: () => false,
    },
    settingsGet: (key) => (key === "ai_tool_timeout_ms" ? 5000 : true),
    ...extra,
  });
}

// ---------------------------------------------------------------------------

section("deterministic acknowledgements: thanks and laughter in 4 locales and emoji");
{
  const cases = [
    ["شكراً", THANKS_EMOJI],
    ["thanks!!", THANKS_EMOJI],
    ["obrigado", THANKS_EMOJI],
    ["gracias", THANKS_EMOJI],
    ["😂😂", LAUGHTER_EMOJI],
    ["ههههه", LAUGHTER_EMOJI],
    ["lol", LAUGHTER_EMOJI],
    ["❤️❤️", THANKS_EMOJI],
    ["thaaaanks!!!", THANKS_EMOJI],
    ["شكرررراً جزيلاً", THANKS_EMOJI],
    ["muito obrigada!", THANKS_EMOJI],
    ["¡muchas gracias!", THANKS_EMOJI],
    ["jajajaja", LAUGHTER_EMOJI],
    ["rsrsrs", LAUGHTER_EMOJI],
    ["kkkkkk", LAUGHTER_EMOJI],
  ];

  for (const [index, [text, expectedEmoji]] of cases.entries()) {
    reset();
    const sock = makeSock();
    let classifyCalls = 0;
    let agentCalls = 0;
    wireBaseDeps(sock, {
      classifyAutoReply: async () => {
        classifyCalls += 1;
        return { action: "reply", text: "should not be called" };
      },
      runAgent: async () => {
        agentCalls += 1;
        return { text: "should not be called" };
      },
    });
    const msg = dm(text, { id: `ack-${index}` });
    await autoReply.dispatch(runtime(), sock, msg, 1);

    equal(`${text}: zero classification calls`, classifyCalls, 0);
    equal(`${text}: zero agent calls`, agentCalls, 0);
    equal(`${text}: zero presence updates`, sock.presence.length, 0);
    equal(`${text}: exactly one send`, sock.sent.length, 1);
    equal(`${text}: sent to source chat`, sock.sent[0].jid, CHAT);
    equal(
      `${text}: react payload uses expected emoji`,
      sock.sent[0].content?.react?.text,
      expectedEmoji,
    );
    equal(
      `${text}: react payload carries incoming message key`,
      sock.sent[0].content?.react?.key,
      msg.key,
    );
    equal(`${text}: no text field in payload`, sock.sent[0].content?.text, undefined);
    equal(`${text}: typing disabled on react`, sock.sent[0].opts?.typing, false);
    equal(`${text}: quote disabled on react`, sock.sent[0].opts?.quote, false);
  }

  // Non-deterministic messages with requests, questions, or commands
  for (const nonAck of [
    "thanks, can you check the weather?",
    "thanks, now do X",
    "شكراً، ممكن تشوف الطقس؟",
    "gracias, ¿qué hora es?",
    "obrigado, pode verificar isso",
    "!thanks",
    "lol what is 2+2?",
  ]) {
    equal(`${nonAck}: not deterministic`, classifyAcknowledgement(nonAck), null);
  }

  // Verify "thanks, can you check the weather?" goes to classification, not deterministic ack
  reset();
  const sock = makeSock();
  let classifyCalls = 0;
  wireBaseDeps(sock, {
    classifyAutoReply: async () => {
      classifyCalls += 1;
      return { action: "silent" };
    },
  });
  await autoReply.dispatch(
    runtime(),
    sock,
    dm("thanks, can you check the weather?", { id: "non-ack-dispatch" }),
    1,
  );
  equal("request with thanks reaches model classification", classifyCalls, 1);
  equal("no deterministic reaction sent", sock.sent.length, 0);
}

// ---------------------------------------------------------------------------

section("dispatch branches: reply, react, silent, task and presence order");
{
  // 1. reply -> composing, one text send, paused
  {
    reset();
    const sock = makeSock();
    let agentCalls = 0;
    wireBaseDeps(sock, {
      classifyAutoReply: async () => ({ action: "reply", text: "Direct answer here" }),
      runAgent: async () => {
        agentCalls += 1;
        return { text: "unused" };
      },
    });
    const msg = dm("what is your name", { id: "branch-reply" });
    await autoReply.dispatch(runtime(), sock, msg, 1);

    equal("reply: runAgent not called", agentCalls, 0);
    equal("reply: one message sent", sock.sent.length, 1);
    equal("reply: text content sent", sock.sent[0].content.text, "Direct answer here");
    equal("reply: quote flag passed from decision", sock.sent[0].opts.quote, true);
    equal(
      "reply: event sequence is composing -> send -> paused",
      sock.events.map((e) => (e.kind === "presence" ? `presence:${e.state}` : "send")).join(","),
      "presence:composing,send,presence:paused",
    );
  }

  // 2. react -> one reaction, no presence
  {
    reset();
    const sock = makeSock();
    let agentCalls = 0;
    wireBaseDeps(sock, {
      classifyAutoReply: async () => ({ action: "react", emoji: "👍" }),
      runAgent: async () => {
        agentCalls += 1;
        return { text: "unused" };
      },
    });
    const msg = dm("sounds good to me", { id: "branch-react" });
    await autoReply.dispatch(runtime(), sock, msg, 1);

    equal("react: runAgent not called", agentCalls, 0);
    equal("react: no presence updates", sock.presence.length, 0);
    equal("react: one reaction sent", sock.sent.length, 1);
    equal("react: emoji payload", sock.sent[0].content?.react?.text, "👍");
    equal("react: incoming key", sock.sent[0].content?.react?.key, msg.key);
    equal("react: quote false", sock.sent[0].opts?.quote, false);
    equal("react: typing false", sock.sent[0].opts?.typing, false);
  }

  // 3. silent -> nothing sent, no presence
  {
    reset();
    const sock = makeSock();
    let agentCalls = 0;
    wireBaseDeps(sock, {
      classifyAutoReply: async () => ({ action: "silent" }),
      runAgent: async () => {
        agentCalls += 1;
        return { text: "unused" };
      },
    });
    await autoReply.dispatch(runtime(), sock, dm("ok bye", { id: "branch-silent" }), 1);

    equal("silent: runAgent not called", agentCalls, 0);
    equal("silent: no presence updates", sock.presence.length, 0);
    equal("silent: nothing sent", sock.sent.length, 0);
  }

  // 4. task -> presence composing, runAgent with tools and status: null, one send, paused
  {
    reset();
    const sock = makeSock();
    let agentOpts = null;
    let presenceDuringAgent = [];
    wireBaseDeps(sock, {
      classifyAutoReply: async () => ({ action: "task" }),
      runAgent: async (opts) => {
        agentOpts = opts;
        presenceDuringAgent = sock.presence.map((p) => p.state);
        return { text: "Weather is sunny, 25C" };
      },
    });
    const msg = dm("check the weather in Cairo", { id: "branch-task" });
    await autoReply.dispatch(runtime(), sock, msg, 1);

    ok("task: runAgent called", agentOpts !== null);
    equal("task: status is null", agentOpts.status, null);
    equal("task: composing started before runAgent", presenceDuringAgent.join(","), "composing");
    equal("task: one text send", sock.sent.length, 1);
    equal("task: text from runAgent", sock.sent[0].content.text, "Weather is sunny, 25C");
    equal(
      "task: event sequence is composing -> send -> paused",
      sock.events.map((e) => (e.kind === "presence" ? `presence:${e.state}` : "send")).join(","),
      "presence:composing,send,presence:paused",
    );
  }

  // 5. task error / abort clears presence with paused
  {
    reset();
    const sock = makeSock();
    wireBaseDeps(sock, {
      classifyAutoReply: async () => ({ action: "task" }),
      runAgent: async () => {
        throw new Error("tool failed");
      },
    });
    await autoReply.dispatch(
      runtime(),
      sock,
      dm("run a failing tool", { id: "branch-task-err" }),
      1,
    );
    equal("task error: nothing sent", sock.sent.length, 0);
    equal(
      "task error: composing cleared with paused",
      sock.presence.map((p) => p.state).join(","),
      "composing,paused",
    );
  }
}

// ---------------------------------------------------------------------------

section("invalid decisions fail closed to silent");
{
  const invalidCases = [
    ["wrong function", { name: "web_search", args: { query: "test" } }],
    [
      "two calls",
      [
        { name: "auto_reply_decision", args: { action: "reply", text: "one" } },
        { name: "auto_reply_decision", args: { action: "reply", text: "two" } },
      ],
    ],
    ["extra keys on reply", { action: "reply", text: "hello", extra: "forbidden" }],
    ["extra keys on react", { action: "react", emoji: "👍", text: "extra" }],
    ["extra keys on silent", { action: "silent", text: "extra" }],
    ["extra keys on task", { action: "task", emoji: "👍" }],
    ["target JID injection key", { action: "reply", text: "hi", chatJid: "other@s.whatsapp.net" }],
    ["single-emoji reply text", { action: "reply", text: "👍" }],
    ["single heart emoji reply text", { action: "reply", text: "❤️" }],
    ["empty reply text", { action: "reply", text: "   " }],
    ["bad emoji (word)", { action: "react", emoji: "smile" }],
    ["bad emoji (two emojis)", { action: "react", emoji: "😂😂" }],
    ["bad emoji (empty)", { action: "react", emoji: "" }],
    ["no call (empty array)", []],
    ["null decision", null],
  ];

  for (const [index, [label, badDecision]] of invalidCases.entries()) {
    reset();
    const sock = makeSock();
    const rt = runtime();
    let agentCalls = 0;
    wireBaseDeps(sock, {
      classifyAutoReply: async () => badDecision,
      runAgent: async () => {
        agentCalls += 1;
        return { text: "must not run" };
      },
    });
    await autoReply.dispatch(rt, sock, dm("tell me something", { id: `invalid-${index}` }), 1);
    equal(`${label}: nothing sent`, sock.sent.length, 0);
    equal(`${label}: no presence`, sock.presence.length, 0);
    equal(`${label}: runAgent not called`, agentCalls, 0);
    if (badDecision !== null) {
      ok(
        `${label}: sanitized reason logged`,
        rt.warnings.length === 1 && Boolean(rt.warnings[0].meta?.reason),
      );
    }
  }
}

// ---------------------------------------------------------------------------

section("provider classification wire format: Gemini, OpenAI-compatible, Anthropic");
{
  // 1. Gemini: one generateContent request, single tool declaration, mode ANY,
  // allowedFunctionNames ["auto_reply_decision"], no googleSearch.
  {
    const fake = await startGenaiServer([
      functionCallReply([
        { name: "auto_reply_decision", args: { action: "reply", text: "Gemini direct" } },
      ]),
      functionCallReply([{ name: "auto_reply_decision", args: { action: "react", emoji: "🔥" } }]),
      functionCallReply([
        { name: "auto_reply_decision", args: { action: "reply", text: "one" } },
        { name: "auto_reply_decision", args: { action: "reply", text: "two" } },
      ]),
      functionCallReply([{ name: "wrong_tool", args: { action: "reply", text: "no" } }]),
      textReply("plain text without tool call"),
      errorReply(400, "Forced tool choice unsupported"),
    ]);
    settings.set("ai_provider", "gemini");
    settings.set("gemini_api_key", `key-${Math.random().toString(36).slice(2)}`);
    settings.set("gemini_base_url", fake.baseUrl);
    settings.set("gemini_model", "gemini-3.7-flash");
    settings.set("ai_google_search", true);

    try {
      const replyDecision = await aiAgent.classifyAutoReply({
        parts: [{ text: "hello gemini" }],
        context: { chatId: CHAT, isGroup: false },
      });
      equal(
        "gemini: parsed reply decision",
        JSON.stringify(replyDecision),
        JSON.stringify({ action: "reply", text: "Gemini direct" }),
      );
      equal("gemini: one request made", fake.requests.length, 1);
      equal(
        "gemini: uses generateContent",
        fake.requests[0].url,
        "/v1beta/models/gemini-3.7-flash:generateContent",
      );
      const body = fake.body(0);
      equal("gemini: exactly one tool entry", body.tools?.length, 1);
      equal(
        "gemini: no googleSearch tool even when ai_google_search is true",
        JSON.stringify(body.tools).includes("googleSearch"),
        false,
      );
      const decls = body.tools[0]?.functionDeclarations || [];
      equal("gemini: single function declaration", decls.length, 1);
      equal("gemini: declaration is auto_reply_decision", decls[0]?.name, "auto_reply_decision");
      equal(
        "gemini: functionCallingConfig mode is ANY",
        body.toolConfig?.functionCallingConfig?.mode,
        "ANY",
      );
      equal(
        "gemini: allowedFunctionNames is [auto_reply_decision]",
        JSON.stringify(body.toolConfig?.functionCallingConfig?.allowedFunctionNames),
        JSON.stringify(["auto_reply_decision"]),
      );
      ok(
        "gemini: systemInstruction includes Auto Reply decision directive",
        JSON.stringify(body.systemInstruction).includes("Auto Reply decision"),
      );

      const reactDecision = await aiAgent.classifyAutoReply({
        parts: [{ text: "nice" }],
        context: { chatId: CHAT, isGroup: false },
      });
      equal(
        "gemini: parsed react decision",
        JSON.stringify(reactDecision),
        JSON.stringify({ action: "react", emoji: "🔥" }),
      );

      const twoCalls = await aiAgent.classifyAutoReply({
        parts: [{ text: "two" }],
        context: { chatId: CHAT, isGroup: false },
      });
      equal("gemini: two calls rejected as null", twoCalls, null);

      const wrongTool = await aiAgent.classifyAutoReply({
        parts: [{ text: "wrong" }],
        context: { chatId: CHAT, isGroup: false },
      });
      equal("gemini: wrong tool rejected as null", wrongTool, null);

      const noCall = await aiAgent.classifyAutoReply({
        parts: [{ text: "no call" }],
        context: { chatId: CHAT, isGroup: false },
      });
      equal("gemini: missing call rejected as null", noCall, null);

      const rejectedChoice = await aiAgent.classifyAutoReply({
        parts: [{ text: "400" }],
        context: { chatId: CHAT, isGroup: false },
      });
      equal("gemini: provider error rejected as null", rejectedChoice, null);
    } finally {
      settings.set("gemini_base_url", "");
      settings.set("gemini_api_key", "");
      await fake.stop();
    }
  }

  // 2. OpenAI-compatible: one request, tools = [auto_reply_decision],
  // tool_choice = { type: "function", function: { name: "auto_reply_decision" } }, no search tool.
  {
    const fake = await startProviderServer({
      [OPENAI_PATH]: [
        openaiToolCall([{ name: "auto_reply_decision", args: { action: "task" } }]),
        {
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "bad_json",
                    type: "function",
                    function: { name: "auto_reply_decision", arguments: "{malformed" },
                  },
                ],
              },
            },
          ],
        },
        openaiText("no tool call"),
        providerError(400, "tool_choice not supported"),
      ],
    });
    settings.set("ai_provider", "openai");
    settings.set("openai_api_key", "sk-test-openai");
    settings.set("openai_base_url", fake.baseUrl);
    settings.set("openai_model", "gpt-test");

    try {
      const decision = await aiAgent.classifyAutoReply({
        parts: [{ text: "search the web for X" }],
        context: { chatId: CHAT, isGroup: false },
      });
      equal(
        "openai: parsed task decision",
        JSON.stringify(decision),
        JSON.stringify({ action: "task" }),
      );
      equal("openai: one request made", fake.requests.length, 1);
      const body = fake.body(OPENAI_PATH, 0);
      equal("openai: exactly one tool", body.tools?.length, 1);
      equal(
        "openai: tool name is auto_reply_decision",
        body.tools[0]?.function?.name,
        "auto_reply_decision",
      );
      equal(
        "openai: no search tool in tools",
        JSON.stringify(body.tools).includes("search"),
        false,
      );
      equal(
        "openai: forced tool_choice",
        JSON.stringify(body.tool_choice),
        JSON.stringify({ type: "function", function: { name: "auto_reply_decision" } }),
      );
      equal("openai: body has no temperature", "temperature" in body, false);
      ok(
        "openai: system message carries Auto Reply directive",
        body.messages?.[0]?.content?.includes("Auto Reply decision"),
      );

      const malformed = await aiAgent.classifyAutoReply({
        parts: [{ text: "bad json" }],
        context: { chatId: CHAT, isGroup: false },
      });
      equal("openai: malformed JSON rejected as null", malformed, null);

      const noCall = await aiAgent.classifyAutoReply({
        parts: [{ text: "no call" }],
        context: { chatId: CHAT, isGroup: false },
      });
      equal("openai: missing call rejected as null", noCall, null);

      const errChoice = await aiAgent.classifyAutoReply({
        parts: [{ text: "400" }],
        context: { chatId: CHAT, isGroup: false },
      });
      equal("openai: provider error rejected as null", errChoice, null);
    } finally {
      settings.set("openai_base_url", "");
      settings.set("openai_api_key", "");
      await fake.stop();
    }
  }

  // 3. Anthropic: one request, tools = [auto_reply_decision],
  // tool_choice = { type: "tool", name: "auto_reply_decision" }, no search tool.
  {
    const fake = await startProviderServer({
      [ANTHROPIC_PATH]: [
        anthropicToolCall([{ name: "auto_reply_decision", args: { action: "silent" } }]),
        anthropicToolCall([{ name: "auto_reply_decision", args: { action: "reply", text: "👍" } }]),
        anthropicText("no tool call"),
        providerError(400, "tool_choice rejected"),
      ],
    });
    settings.set("ai_provider", "anthropic");
    settings.set("anthropic_api_key", "sk-ant-test");
    settings.set("anthropic_base_url", fake.baseUrl);
    settings.set("anthropic_model", "claude-test");

    try {
      const decision = await aiAgent.classifyAutoReply({
        parts: [{ text: "ok" }],
        context: { chatId: CHAT, isGroup: false },
      });
      equal(
        "anthropic: parsed silent decision",
        JSON.stringify(decision),
        JSON.stringify({ action: "silent" }),
      );
      equal("anthropic: one request made", fake.requests.length, 1);
      const body = fake.body(ANTHROPIC_PATH, 0);
      equal("anthropic: exactly one tool", body.tools?.length, 1);
      equal(
        "anthropic: tool name is auto_reply_decision",
        body.tools[0]?.name,
        "auto_reply_decision",
      );
      equal(
        "anthropic: no search tool in tools",
        JSON.stringify(body.tools).includes("search"),
        false,
      );
      equal(
        "anthropic: forced tool_choice",
        JSON.stringify(body.tool_choice),
        JSON.stringify({ type: "tool", name: "auto_reply_decision" }),
      );
      equal("anthropic: body has no temperature", "temperature" in body, false);
      ok(
        "anthropic: system field carries Auto Reply directive",
        body.system?.includes("Auto Reply decision"),
      );

      const singleEmojiReply = await aiAgent.classifyAutoReply({
        parts: [{ text: "emoji reply" }],
        context: { chatId: CHAT, isGroup: false },
      });
      equal("anthropic: single-emoji reply rejected as null", singleEmojiReply, null);

      const noCall = await aiAgent.classifyAutoReply({
        parts: [{ text: "no call" }],
        context: { chatId: CHAT, isGroup: false },
      });
      equal("anthropic: missing call rejected as null", noCall, null);

      const errChoice = await aiAgent.classifyAutoReply({
        parts: [{ text: "400" }],
        context: { chatId: CHAT, isGroup: false },
      });
      equal("anthropic: provider error rejected as null", errChoice, null);
    } finally {
      settings.set("anthropic_base_url", "");
      settings.set("anthropic_api_key", "");
      settings.set("ai_provider", "gemini");
      await fake.stop();
    }
  }
}

// ---------------------------------------------------------------------------

section(
  "abort during classification, epoch change, entitlement loss, scope change -> nothing sent",
);
{
  for (const mutation of ["abort", "epoch", "entitlement", "scope"]) {
    for (const action of ["reply", "react", "task"]) {
      reset();
      const sock = makeSock();
      let epoch = 1;
      let active = true;
      const scope = new Set([CHAT]);
      const ac = new AbortController();
      const rt = runtime({
        isActive: () => active,
        getScope: () => scope,
        signal: () => ac.signal,
      });

      wireBaseDeps(sock, {
        accountEpoch: () => epoch,
        classifyAutoReply: async () => {
          if (mutation === "abort") ac.abort();
          if (mutation === "epoch") epoch = 2;
          if (mutation === "entitlement") active = false;
          if (mutation === "scope") scope.delete(CHAT);
          if (action === "reply") return { action: "reply", text: "late reply" };
          if (action === "react") return { action: "react", emoji: "👍" };
          return { action: "task" };
        },
        runAgent: async () => ({ text: "late task answer" }),
      });

      await autoReply.dispatch(rt, sock, dm("hello there", { id: `mut-${mutation}-${action}` }), 1);
      equal(`${mutation}/${action}: nothing sent`, sock.sent.length, 0);
      equal(`${mutation}/${action}: no presence sent after guard fails`, sock.presence.length, 0);
    }
  }
}

// ---------------------------------------------------------------------------

section(
  "reaction send throws -> no fallback text, no exception escapes, outcome logged without message content",
);
{
  const secretText = "SENSITIVE_USER_MESSAGE_9912";
  for (const mode of ["deterministic", "classified"]) {
    reset();
    const rt = runtime();
    const sock = makeSock({
      async sendMessage() {
        throw new Error(`socket failed while reacting to ${secretText}`);
      },
    });
    wireBaseDeps(sock, {
      classifyAutoReply: async () => ({ action: "react", emoji: "❤️" }),
    });

    const msgText = mode === "deterministic" ? "thanks!!" : secretText;
    await autoReply.dispatch(rt, sock, dm(msgText, { id: `react-fail-${mode}` }), 1);

    equal(`${mode}: no fallback text or retry sent`, sock.sent.length, 0);
    equal(`${mode}: no presence updates`, sock.presence.length, 0);
    equal(`${mode}: outcome logged once`, rt.warnings.length, 1);
    equal(`${mode}: logged action is react`, rt.warnings[0].meta?.action, "react");
    equal(`${mode}: logged reason is send_failed`, rt.warnings[0].meta?.reason, "send_failed");
    const serializedLog = JSON.stringify(rt.warnings);
    equal(
      `${mode}: log contains no message content`,
      serializedLog.includes(secretText) || serializedLog.includes("thanks!!"),
      false,
    );
  }
}

// ---------------------------------------------------------------------------

section("A-3: a thrown command does not reach Auto Reply");
{
  if (getLoadedCommands().size === 0) {
    await loadCommands();
  }
  const commands = getLoadedCommands();
  const ping = commands.get("ping");
  const originalExecute = ping.execute;
  let autoReplyCalls = 0;
  const origDispatch = host.dispatchAutoReply;
  host.dispatchAutoReply = async () => {
    autoReplyCalls += 1;
  };
  ping.execute = async () => {
    throw new Error("simulated command crash");
  };

  try {
    const sock = makeSock();
    await processMessage(sock, dm("!ping", { id: "cmd-throw-1" }), "!ping", 0);
    equal("thrown command does not fall through to Auto Reply", autoReplyCalls, 0);

    await processMessage(
      sock,
      dm("ordinary message", { id: "plain-after-throw" }),
      "ordinary message",
      0,
    );
    equal("non-command message still reaches Auto Reply", autoReplyCalls, 1);

    // In a group, a thrown command skips only Auto Reply: group moderation still runs.
    const store = require("./src/db/store.cjs");
    store.saveGroupSettings(GROUP, {
      moderation: { forbiddenWords: { enabled: true, list: ["badword"] } },
    });
    const groupSock = {
      ...makeSock(),
      groupMetadata: async () => ({
        id: GROUP,
        participants: [
          { id: SENDER, admin: null },
          { id: "201999999999@s.whatsapp.net", admin: "admin" },
        ],
      }),
    };
    const groupCmdMsg = {
      key: { remoteJid: GROUP, participant: SENDER, fromMe: false, id: "cmd-throw-group" },
      pushName: "Tester",
      messageTimestamp: 1,
      message: { conversation: "!ping badword" },
    };
    await processMessage(groupSock, groupCmdMsg, "!ping badword", 0);
    equal("thrown command in group does not fall through to Auto Reply", autoReplyCalls, 1);
    const warnings = store.getUserWarnings(GROUP, SENDER);
    equal("group moderation still ran and recorded warning for thrown command", warnings.length, 1);
    equal("recorded warning is for forbidden words", warnings[0].rules.includes("forbidden"), true);
  } finally {
    ping.execute = originalExecute;
    host.dispatchAutoReply = origDispatch;
  }
}

// ---------------------------------------------------------------------------

section("A-4: a plain disconnect aborts in-flight and pending Auto Reply turns");
{
  reset();
  const sockets = [];
  const session = new WhatsAppSession({
    createSocket: async () => {
      const sock = {
        ...makeSock(),
        ev: new EventEmitter(),
        updates: null,
        async end() {},
        async logout() {},
      };
      sockets.push(sock);
      return {
        sock,
        saveCreds: async () => {},
        clearAll: async () => {},
        fence: () => {},
        isPaired: true,
      };
    },
    attachListeners: (sock, { onConnectionUpdate }) => {
      sock.updates = onConnectionUpdate;
    },
    onOpen: async () => {},
    checkConsent: () => ({ ok: true }),
    retryDelaysMs: [60_000],
    log: { info() {}, warn() {}, error() {}, debug() {}, trace() {} },
    isLinked: () => true,
  });

  await session.start();
  const liveSock = sockets[0];
  liveSock.user = { id: "201999999999:7@s.whatsapp.net" };
  await liveSock.updates({ connection: "open" });
  equal("session connected", session.state, "connected");

  let classifyEntered;
  const enteredPromise = new Promise((resolve) => {
    classifyEntered = resolve;
  });
  let releaseClassify;
  const classifyGate = new Promise((resolve) => {
    releaseClassify = resolve;
  });
  let observedSignal = null;

  let considerEntered;
  const considerEnteredPromise = new Promise((resolve) => {
    considerEntered = resolve;
  });
  let releaseConsider;
  const considerGate = new Promise((resolve) => {
    releaseConsider = resolve;
  });
  let observedPendingSignal = null;

  const PENDING_CHAT = "201333333333@s.whatsapp.net";

  const customRuntime = runtime({
    getScope: () => new Set([CHAT, PENDING_CHAT, GROUP]),
    consider: async (event, { signal } = {}) => {
      if (event.chatJid === PENDING_CHAT) {
        observedPendingSignal = signal;
        considerEntered();
        await considerGate;
        return { reply: true, instructions: "pending after disconnect", quote: true };
      }
      return { reply: true, instructions: "be concise", quote: true };
    },
  });

  wireBaseDeps(liveSock, {
    classifyAutoReply: async ({ signal }) => {
      observedSignal = signal;
      classifyEntered();
      await classifyGate;
      return { action: "reply", text: "after disconnect" };
    },
  });

  const inflightDispatchPromise = autoReply.dispatch(
    customRuntime,
    liveSock,
    dm("hello while connected", { id: "disconnect-inflight" }),
    1,
  );
  await enteredPromise;
  equal("turn signal is live before disconnect", observedSignal.aborted, false);

  const pendingDispatchPromise = autoReply.dispatch(
    customRuntime,
    liveSock,
    dm("hello while pending", {
      id: "disconnect-pending",
      key: { remoteJid: PENDING_CHAT },
    }),
    1,
  );
  await considerEnteredPromise;
  equal("pending consider signal is live before disconnect", observedPendingSignal.aborted, false);

  // Trigger a plain recoverable disconnect (no account change / no logout).
  await liveSock.updates({
    connection: "close",
    lastDisconnect: {
      error: {
        message: "Connection Lost",
        output: {
          statusCode: DisconnectReason.connectionLost,
          payload: { error: "Connection Lost" },
        },
      },
    },
  });

  equal("plain disconnect aborts in-flight Auto Reply turn signal", observedSignal.aborted, true);
  equal("plain disconnect aborts pending consider signal", observedPendingSignal.aborted, true);
  releaseClassify();
  releaseConsider();
  await Promise.all([inflightDispatchPromise, pendingDispatchPromise]);
  equal("aborted turns send nothing", liveSock.sent.length, 0);
  equal("aborted turns send no presence", liveSock.presence.length, 0);

  await session.shutdown();
}

reset();
finish();

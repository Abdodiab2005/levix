// One command engine: a reaction runs the same command a typed message runs.
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { registerHooks } from "node:module";
import { equal, finish, ok, require, section, throws, useTempDataDir } from "./harness.mjs";

const data = useTempDataDir("levix-reaction-commands");
const store = require("./src/db/store.cjs");
const database = require("./src/db/db.cjs");
const { db } = database;
const settings = require("./src/config/settings.cjs");
const runtime = require("./src/config/runtime-config.cjs");
const groupMetadataCache = require("./src/utils/groupMetadataCache.cjs");
const media = require("./src/utils/geminiMedia.cjs");
const stt = require("./src/commands/stt.cjs");
const kick = require("./src/commands/group/kick.cjs");
const ping = require("./src/commands/ping.cjs");
const thumbnail = require("./src/utils/thumbnail.cjs");
const perms = require("./src/utils/permissions.cjs");
const { classify, validateArgs } = require("./src/automation/commandEligibility.cjs");
const status = require("./src/automation/status.cjs");
const { timing } = await import("../src/utils/sendBotMessage.esm.js");
const { createReactionAutomation } = await import("../src/automation/engine.js");
const { rememberMessage, rememberOutboundId, clearRecentMessages } = await import(
  "../src/utils/recentMessageCache.esm.js"
);
const {
  executeCommandInvocation,
  getCommandCatalog,
  getLoadedCommands,
  handleCommand,
  loadCommands,
} = await import("../src/handlers/command.handler.js");
const manage = await import("../src/automation/manage.js");

const saved = {
  download: media.downloadMedia,
  transcribe: stt.transcribe,
  ping: ping.execute,
  stt: stt.execute,
  kick: kick.execute,
  thumbnail: thumbnail.withMediaThumbnail,
  sleep: timing.sleep,
  get: settings.get,
};
let prepare = async (content) => content;
thumbnail.withMediaThumbnail = (...args) => prepare(...args);
const socketUrl = new URL("../src/core/socket.js", import.meta.url).href;
const slot = Symbol.for("levix-reaction-commands-test-socket");
const hook = registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url !== socketUrl) return result;
    const needle = 'import { makeWASocket } from "@whiskeysockets/baileys";';
    if (!String(result.source).includes(needle)) throw new Error("socket interception failed");
    return {
      ...result,
      source: String(result.source).replace(
        needle,
        'const makeWASocket = () => globalThis[Symbol.for("levix-reaction-commands-test-socket")];',
      ),
    };
  },
});
const { createWhatsAppSocket } = await import("../src/core/socket.js");
hook.deregister();
await perms.primePermissions();
await loadCommands();

const calls = [];
ping.execute = async function (...args) {
  calls.push({
    command: "ping",
    source: args[5]?.source || "text",
    msg: args[1],
    args: args[2],
    ctx: args[5],
  });
  return saved.ping.apply(this, args);
};
stt.execute = async function (...args) {
  const ctx = args[5];
  calls.push({ command: "stt", source: ctx?.source || "text", msg: args[1], args: args[2] });
  // The typed branch captured downloadMedia at load time. Stop before that
  // network call. The reaction branch reads the mock at call time.
  if (ctx?.source !== "reaction") return;
  return saved.stt.apply(this, args);
};
kick.execute = async function (...args) {
  calls.push({ command: "kick", source: args[5]?.source || "text", msg: args[1], args: args[2] });
  return saved.kick.apply(this, args);
};

const group = "120363700000001@g.us";
const dm = "201070000050@s.whatsapp.net";
const author = "201070000001@s.whatsapp.net";
const reactor = "201070000002@s.whatsapp.net";
const admin2 = "201070000003@s.whatsapp.net";
const memberB = "201070000012@s.whatsapp.net";
const ownerUser = "201070000021@s.whatsapp.net";
const bot = "201070000099@s.whatsapp.net";
const audioBytes = Buffer.from("OggS-deterministic-voice");
const TYPES = ["text", "voice", "audio", "image", "video", "document", "sticker"];
let clock = 1_800_000_000_000;
let sequence = 0;
let fixtureSequence = 0;
let current = null;
let deadline = 30_000;
let downloaded = 0;
let transcribed = 0;
settings.get = (key) => (key === "ai_tool_timeout_ms" ? deadline : saved.get(key));
timing.sleep = async () => {};

const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const prefix = () => runtime.getPrefix();

function commandDefinition(name, patch = {}) {
  const spec = classify(name);
  const narrow = spec.originalTypes?.length && spec.originalTypes.length < TYPES.length;
  return {
    version: 2,
    emoji: "🏓",
    transitions: spec.destructive ? ["add"] : ["add"],
    originalTypes: narrow ? [...spec.originalTypes] : [...TYPES],
    senders: { role: "any", ids: [] },
    command: { name, args: [] },
    destination: { mode: "same_chat" },
    ...patch,
  };
}
async function fixture({
  rules = [{ id: "rule", definition: commandDefinition("ping", { emoji: "🏓" }) }],
  chat = group,
  enabled = true,
  globalEnabled = true,
} = {}) {
  if (current) {
    current.engine.close();
    await current.engine.settled();
  }
  db.exec(
    "DELETE FROM reaction_rules; DELETE FROM reaction_events; DELETE FROM reaction_state; DELETE FROM reaction_invalidations; DELETE FROM reaction_executions; DELETE FROM reaction_budgets; DELETE FROM user_metadata; DELETE FROM lid_mapping; DELETE FROM group_settings;",
  );
  store.saveBotSetting("command_permissions", {});
  store.saveBotSetting("disabled_commands", []);
  store.authRemove("creds");
  groupMetadataCache.flushAll();
  clearRecentMessages();
  calls.length = 0;
  clock = 1_800_000_000_000 + ++fixtureSequence * 1_000_000;
  deadline = 30_000;
  downloaded = 0;
  transcribed = 0;
  settings.set("bot_language", "en");
  settings.set("bot_min_delay_ms", 0);
  settings.set("bot_max_delay_ms", 0);
  settings.set("ai_stt_enabled", true);
  settings.set("ai_stt_provider", "gemini");
  settings.set("gemini_api_key", "isolated-test-key");
  settings.set("openai_api_key", "");
  media.downloadMedia = async (_download, audio, kind, options) => {
    downloaded += 1;
    equal("reaction STT downloads audio", kind, "audio");
    equal("reaction STT caps the download", options.maxBytes, 8 * 1024 * 1024);
    return audioBytes;
  };
  stt.transcribe = async () => {
    transcribed += 1;
    return "verified transcript";
  };
  const state = {
    participants: [{ id: author }, { id: reactor }, { id: bot }],
    metadataCalls: 0,
    updates: [],
    attempts: [],
    sent: [],
    onMetadata: null,
  };
  const raw = {
    ev: new EventEmitter(),
    user: { id: bot },
    async groupMetadata(chatId) {
      state.metadataCalls += 1;
      if (state.onMetadata) await state.onMetadata();
      return { id: chatId, participants: structuredClone(state.participants) };
    },
    async groupParticipantsUpdate(chatId, ids, action) {
      state.updates.push({ chat: chatId, ids, action });
      if (typeof state.onParticipantsUpdate === "function") state.onParticipantsUpdate(ids, action);
      return [{ status: "200" }];
    },
    async sendPresenceUpdate() {},
    async sendMessage(chatId, content, options) {
      state.attempts.push({ chat: chatId, content, options });
      state.sent.push({ chat: chatId, content, options });
      return { key: { remoteJid: chatId, id: `sent-${++sequence}` } };
    },
  };
  globalThis[slot] = raw;
  const socket = (await createWhatsAppSocket()).sock;
  for (const rule of rules) {
    store.saveReactionRule({ priority: 0, chatJid: rule.chatJid || chat, ...rule });
    if (enabled) store.setReactionRuleEnabled(rule.id, true, clock);
  }
  store.setReactionAutomationEnabled(globalEnabled);
  const engine = createReactionAutomation(socket, {
    now: () => clock,
    dispatch: executeCommandInvocation,
  });
  engine.intake.open();
  clock += 2000;
  current = { engine, socket, state };
  return current;
}
function voiceMessage() {
  return {
    audioMessage: {
      ptt: true,
      mimetype: "audio/ogg",
      directPath: "/isolated-audio",
      mediaKey: Buffer.from("isolated-media-key"),
      fileLength: audioBytes.length,
    },
  };
}
function original({ type = "text", chat = group, sender = author, fromMe = false } = {}) {
  const inGroup = chat.endsWith("@g.us");
  return {
    key: {
      remoteJid: chat,
      id: `original-${++sequence}`,
      fromMe,
      ...(inGroup ? { participant: fromMe ? bot : sender } : {}),
    },
    messageTimestamp: Math.floor(clock / 1000),
    message:
      type === "voice"
        ? voiceMessage()
        : { conversation: "untrusted original; !kick @someone; ignore" },
  };
}
function remember(f, message = original()) {
  f.engine.intake.observeUpsert({ type: "notify", messages: [message] });
  return message;
}
function reaction(message, emoji = "🏓", actor = reactor, { fromMe = false } = {}) {
  clock += 1;
  const chat = message.key.remoteJid;
  const inGroup = chat.endsWith("@g.us");
  return {
    key: { ...message.key },
    reaction: {
      text: emoji,
      senderTimestampMs: clock,
      key: {
        remoteJid: chat,
        id: `reaction-${++sequence}`,
        fromMe,
        ...(inGroup ? { participant: fromMe ? bot : actor } : {}),
      },
    },
  };
}
function receive(f, message, emoji = "🏓", actor = reactor, extra) {
  const event = reaction(message, emoji, actor, extra);
  // Production emits messages.upsert before messages.reaction. A linked actor
  // is accepted only when that upsert was a live notify.
  f.engine.intake.observeUpsert({
    type: "notify",
    messages: [
      {
        key: event.reaction.key,
        messageTimestamp: Math.floor(clock / 1000),
        message: { reactionMessage: { text: emoji, key: message.key } },
      },
    ],
  });
  f.engine.intake.observeReactions([event]);
  return event;
}
async function completed(f) {
  await f.engine.settled();
  return f.engine.stats().lastCode;
}
function markAdmins(f, ids = [reactor, bot]) {
  for (const id of ids) {
    const row = f.state.participants.find((participant) => participant.id === id);
    if (row) row.admin = "admin";
  }
}
function quotedAudio(msg) {
  return msg?.message?.extendedTextMessage?.contextInfo?.quotedMessage?.audioMessage;
}

try {
  section("typed !ping and a ping reaction run the loaded ping command");
  {
    equal("loader holds the ping module", getLoadedCommands().get("ping"), ping);
    const f = await fixture();
    const typed = {
      key: { remoteJid: group, id: "typed-ping", fromMe: false, participant: reactor },
      message: { conversation: `${prefix()}ping` },
    };
    equal(
      "typed ping is handled",
      await handleCommand(f.socket, typed, `${prefix()}ping`, store.accountEpoch()),
      true,
    );
    equal(
      "typed ping entered ping.execute",
      calls.filter((call) => call.command === "ping").length,
      1,
    );
    equal("typed ping source is text", calls[0].source, "text");
    equal("typed ping has no args", calls[0].args.length, 0);
    equal("typed ping sends one reply", f.state.sent.length, 1);
    ok("typed ping answers Pong", f.state.sent[0].content.text.includes("Pong!"));
    equal("typed ping does not edit", f.state.sent[0].content.edit, undefined);

    f.state.sent.length = 0;
    f.state.attempts.length = 0;
    const message = remember(f);
    const event = receive(f, message, "🏓");
    equal("ping reaction delivers", await completed(f), "DELIVERED");
    const reactionCall = calls.find(
      (call) => call.command === "ping" && call.source === "reaction",
    );
    ok("reaction entered the same ping.execute", Boolean(reactionCall));
    equal("reaction ping has no args", reactionCall.args.length, 0);
    equal(
      "reaction text is the configured command",
      reactionCall.msg.message.extendedTextMessage.text,
      `${prefix()}ping`,
    );
    equal(
      "original text is not parsed as syntax",
      reactionCall.msg.message.extendedTextMessage.text.includes("!kick"),
      false,
    );
    equal(
      "reaction quotes the original id",
      reactionCall.msg.message.extendedTextMessage.contextInfo.stanzaId,
      message.key.id,
    );
    equal(
      "original author is the quote participant",
      reactionCall.msg.message.extendedTextMessage.contextInfo.participant,
      author,
    );
    equal(
      "reaction message has no mentions",
      reactionCall.msg.message.extendedTextMessage.contextInfo.mentionedJid,
      undefined,
    );
    equal("reaction key id is the stanza id", reactionCall.msg.key.id, event.reaction.key.id);
    equal("reactor is not the linked account", reactionCall.msg.key.fromMe, false);
    equal("reactor is the participant", reactionCall.msg.key.participant, reactor);
    equal("synthetic key drops the internal author", reactionCall.msg.key.author, undefined);
    equal("ping reaction sends one reply", f.state.sent.length, 1);
    ok("ping reaction answers Pong", f.state.sent[0].content.text.includes("Pong!"));
    equal("ping reaction does not edit", f.state.sent[0].content.edit, undefined);
    equal("ping reaction stays in the source chat", f.state.sent[0].chat, group);
    equal(
      "ping reaction quotes the original",
      f.state.sent[0].options.quoted.key.id,
      message.key.id,
    );
  }

  section("typed !stt and a voice reaction run the loaded stt command");
  {
    equal("loader holds the stt module", getLoadedCommands().get("stt"), stt);
    const f = await fixture({
      rules: [{ id: "stt", definition: commandDefinition("stt", { emoji: "🗿" }) }],
    });
    const voice = original({ type: "voice" });
    const typed = {
      key: { remoteJid: group, id: "typed-stt", fromMe: false, participant: reactor },
      message: {
        extendedTextMessage: {
          text: `${prefix()}stt`,
          contextInfo: {
            stanzaId: voice.key.id,
            participant: author,
            quotedMessage: voice.message,
          },
        },
      },
    };
    equal(
      "typed stt is handled",
      await handleCommand(f.socket, typed, `${prefix()}stt`, store.accountEpoch()),
      true,
    );
    equal("typed stt entered stt.execute", calls[0].command, "stt");
    equal("typed stt source is text", calls[0].source, "text");
    equal("typed stt quotes the voice note", quotedAudio(calls[0].msg)?.ptt, true);
    equal("typed stt stops before the captured downloader", downloaded, 0);

    const message = remember(f, voice);
    const event = receive(f, message, "🗿");
    equal("stt reaction delivers", await completed(f), "DELIVERED");
    const reactionCall = calls.find((call) => call.command === "stt" && call.source === "reaction");
    ok("reaction entered the same stt.execute", Boolean(reactionCall));
    equal("stt reaction quotes the voice note", quotedAudio(reactionCall.msg)?.ptt, true);
    equal("stt reaction key is the stanza", reactionCall.msg.key.id, event.reaction.key.id);
    equal(
      "stt reaction has no mentions",
      reactionCall.msg.message.extendedTextMessage.contextInfo.mentionedJid,
      undefined,
    );
    equal("stt reaction downloaded once", downloaded, 1);
    equal("stt reaction transcribed once", transcribed, 1);
    ok(
      "stt reaction sends the transcript",
      f.state.sent.some((row) => row.content?.text?.includes("verified transcript")),
    );
    equal(
      "stt reaction quotes the voice message",
      f.state.sent.at(-1).options.quoted.key.id,
      message.key.id,
    );
  }

  section("typed !kick and a kick reaction run the loaded kick command");
  {
    equal("loader holds the kick module", getLoadedCommands().get("kick"), kick);
    equal("kick stays a group command", kick.__category, "group");
    const f = await fixture({
      rules: [{ id: "kick", definition: commandDefinition("group:kick", { emoji: "🫰" }) }],
    });
    f.state.participants.push({ id: memberB });
    markAdmins(f);
    const typed = {
      key: { remoteJid: group, id: "typed-kick", fromMe: false, participant: reactor },
      message: {
        extendedTextMessage: {
          text: `${prefix()}kick`,
          contextInfo: {
            stanzaId: "quoted-a",
            participant: author,
            quotedMessage: { conversation: "hello" },
          },
        },
      },
    };
    equal(
      "typed kick is handled",
      await handleCommand(f.socket, typed, `${prefix()}kick`, store.accountEpoch()),
      true,
    );
    const voice = remember(f, original({ sender: memberB }));
    receive(f, voice, "🫰");
    equal("kick reaction delivers", await completed(f), "DELIVERED");
    const sources = calls.filter((call) => call.command === "kick").map((call) => call.source);
    equal("kick ran for text and reaction", sources.join(","), "text,reaction");
    equal(
      "reaction kick has no args",
      calls.find((call) => call.source === "reaction").args.length,
      0,
    );
    equal(
      "reaction kick text is the command",
      calls.find((call) => call.source === "reaction").msg.message.extendedTextMessage.text,
      `${prefix()}kick`,
    );
    equal(
      "reaction kick has no mentions",
      calls.find((call) => call.source === "reaction").msg.message.extendedTextMessage.contextInfo
        .mentionedJid,
      undefined,
    );
    equal("two kicks remove two members", f.state.updates.length, 2);
    equal("typed kick removes the quoted member", f.state.updates[0].ids[0], author);
    equal("reaction kick removes the other member", f.state.updates[1].ids[0], memberB);
    equal(
      "both removals are group removals",
      f.state.updates.every((row) => row.action === "remove" && row.chat === group),
      true,
    );
  }

  section("owner phone reaction executes; Levix-sent reaction and original do not");
  {
    const f = await fixture();
    const message = remember(f);
    const event = receive(f, message, "🏓", bot, { fromMe: true });
    equal("owner phone reaction delivers", await completed(f), "DELIVERED");
    const reactionCall = calls.find((call) => call.source === "reaction");
    equal("owner reaction is fromMe", reactionCall.msg.key.fromMe, true);
    equal(
      "owner reaction participant is the linked account",
      reactionCall.msg.key.participant,
      bot,
    );
    equal("owner reaction stanza id is preserved", reactionCall.msg.key.id, event.reaction.key.id);
    equal("owner reaction sends a reply", f.state.sent.length, 1);
    equal("owner reaction requester is the linked account", reactionCall.ctx.requester.jid, bot);
    equal("owner reaction requester is linked", reactionCall.ctx.requester.isLinked, true);

    const sentReaction = reaction(remember(f), "🏓", bot, { fromMe: true });
    ok(
      "Levix reaction id is registered before the echo",
      rememberOutboundId(sentReaction.reaction.key.id),
    );
    f.engine.intake.observeUpsert({
      type: "notify",
      messages: [
        {
          key: sentReaction.reaction.key,
          messageTimestamp: Math.floor(clock / 1000),
          message: { reactionMessage: { text: "🏓", key: sentReaction.key } },
        },
      ],
    });
    const before = f.engine.stats().completed;
    f.engine.intake.observeReactions([sentReaction]);
    await f.engine.settled();
    equal("Levix-sent reaction starts no job", f.engine.stats().completed, before);
    equal("Levix-sent reaction sends nothing", f.state.sent.length, 1);
    equal("two originals are retained before the outbound one", f.engine.intake.stats().items, 2);

    const sentOriginal = original({ fromMe: true });
    ok("Levix original id is registered before the echo", rememberOutboundId(sentOriginal.key.id));
    f.engine.intake.observeUpsert({ type: "notify", messages: [sentOriginal] });
    equal("Levix-sent original is not retained", f.engine.intake.stats().items, 2);
    const owned = original({ fromMe: true });
    f.engine.intake.observeUpsert({ type: "append", messages: [owned] });
    equal("owner append echo is not retained", f.engine.intake.stats().items, 2);
    const otherAppend = original();
    f.engine.intake.observeUpsert({ type: "append", messages: [otherAppend] });
    equal("someone else's append is not retained", f.engine.intake.stats().items, 2);
    const echoed = original({ fromMe: true });
    rememberMessage(echoed.key.remoteJid, echoed.key.id, { conversation: "levix-echo" });
    f.engine.intake.observeUpsert({ type: "append", messages: [echoed] });
    equal("content-cache append echo is not retained", f.engine.intake.stats().items, 2);
    const cached = original({ fromMe: true });
    rememberMessage(cached.key.remoteJid, cached.key.id, { conversation: "cache-only" });
    f.engine.intake.observeUpsert({ type: "notify", messages: [cached] });
    equal("content cache alone retains a linked notify", f.engine.intake.stats().items, 3);
  }

  section("a DM reaction keeps the requester off the peer key");
  {
    const f = await fixture({
      rules: [{ id: "dm", chatJid: dm, definition: commandDefinition("ping", { emoji: "🏓" }) }],
      chat: dm,
    });
    store.authWrite("creds", JSON.stringify({ me: { id: bot }, registered: true }));
    const message = remember(f, original({ chat: dm }));
    receive(f, message, "🏓", bot, { fromMe: true });
    equal("DM owner reaction delivers", await completed(f), "DELIVERED");
    const reactionCall = calls.find((call) => call.source === "reaction");
    equal("DM synthetic key stays on the peer chat", reactionCall.msg.key.remoteJid, dm);
    equal("DM synthetic key has no participant", reactionCall.msg.key.participant, undefined);
    equal(
      "DM quote names the original author",
      reactionCall.msg.message.extendedTextMessage.contextInfo.participant,
      dm,
    );
    equal("DM requester is the linked account", reactionCall.ctx.requester.jid, bot);
    equal("DM requester is linked", reactionCall.ctx.requester.isLinked, true);
    equal("DM reply stays in the source chat", f.state.sent[0].chat, dm);
  }

  section("a reaction never edits or deletes the original");
  {
    const f = await fixture();
    const message = remember(f, original({ fromMe: true }));
    receive(f, message, "🏓", bot, { fromMe: true });
    equal("owner ping on their own message delivers", await completed(f), "DELIVERED");
    equal(
      "no edit payload was sent",
      f.state.attempts.some((row) => row.content?.edit),
      false,
    );
    equal("reply is a normal message", f.state.sent.length, 1);
    ok("reply text is Pong", f.state.sent[0].content.text.includes("Pong!"));
    equal("reply quotes the original", f.state.sent[0].options.quoted.key.id, message.key.id);
    equal("reply is not an edit of the original", f.state.sent[0].content.edit, undefined);

    f.state.attempts.length = 0;
    f.state.sent.length = 0;
    const anchor = {
      key: { remoteJid: dm, id: "anchor-delete", fromMe: true },
      message: { conversation: "own" },
    };
    const synthetic = {
      key: { remoteJid: dm, id: "reaction-delete", fromMe: true },
      message: { extendedTextMessage: { text: `${prefix()}ping` } },
    };
    let editResult;
    let deleteResult;
    const outcome = await executeCommandInvocation(f.socket, {
      command: {
        name: "ping",
        chat: "all",
        async execute(sock, msg) {
          editResult = await sock.sendMessage(msg.key.remoteJid, {
            text: "rewritten",
            edit: anchor.key,
          });
          deleteResult = await sock.sendMessage(msg.key.remoteJid, { delete: anchor.key });
          await sock.sendMessage(msg.key.remoteJid, { text: "kept" });
        },
      },
      invokedName: "ping",
      args: [],
      body: `${prefix()}ping`,
      msg: synthetic,
      isGroup: false,
      rawRemainder: "",
      accountEpoch: store.accountEpoch(),
      options: {
        source: "reaction",
        editInPlace: true,
        replyAnchor: anchor,
        protectedKeys: [anchor.key],
        silentDenials: true,
        neutralFailure: true,
      },
    });
    equal("refused protocol sends do not fail the command", outcome.status, "executed");
    equal("edit of the original is refused", editResult?.refused, true);
    equal("edit refusal has no key", editResult?.key, null);
    equal("delete of the original is refused", deleteResult?.refused, true);
    equal("delete refusal has no key", deleteResult?.key, null);
    equal(
      "protocol edit never reached the socket",
      f.state.attempts.some((row) => row.content?.edit),
      false,
    );
    equal(
      "protocol delete never reached the socket",
      f.state.attempts.some((row) => row.content?.delete),
      false,
    );
    equal("the ordinary reply was sent", f.state.sent.length, 1);
    ok("ordinary reply text is kept", f.state.sent[0].content.text.includes("kept"));
    equal("ordinary reply quotes the anchor", f.state.sent[0].options.quoted.key.id, anchor.key.id);

    f.state.attempts.length = 0;
    f.state.sent.length = 0;
    store.storeLidPnMapping("201070000050@lid", dm);
    const aliasAnchor = {
      key: { remoteJid: dm, id: "anchor-alias", fromMe: true },
      message: { conversation: "own" },
    };
    let aliasDelete;
    await executeCommandInvocation(f.socket, {
      command: {
        name: "ping",
        chat: "all",
        async execute(sock, msg) {
          aliasDelete = await sock.sendMessage(msg.key.remoteJid, {
            delete: { remoteJid: "201070000050@lid", id: aliasAnchor.key.id, fromMe: true },
          });
        },
      },
      invokedName: "ping",
      args: [],
      body: `${prefix()}ping`,
      msg: {
        key: { remoteJid: dm, id: "reaction-alias", fromMe: true },
        message: { extendedTextMessage: { text: `${prefix()}ping` } },
      },
      isGroup: false,
      rawRemainder: "",
      accountEpoch: store.accountEpoch(),
      options: {
        source: "reaction",
        editInPlace: false,
        replyAnchor: aliasAnchor,
        protectedKeys: [aliasAnchor.key],
        silentDenials: true,
        neutralFailure: true,
      },
    });
    equal("alternate jid of the original is refused", aliasDelete?.refused, true);
    equal(
      "alternate delete never reached the socket",
      f.state.attempts.some((row) => row.content?.delete),
      false,
    );

    f.state.attempts.length = 0;
    f.state.sent.length = 0;
    let protocolCalls = 0;
    const guarded = await executeCommandInvocation(f.socket, {
      command: {
        name: "ping",
        chat: "all",
        async execute(sock, msg) {
          const first = await sock.sendMessage(msg.key.remoteJid, { text: "own" });
          await sock.sendMessage(msg.key.remoteJid, { delete: first.key });
        },
      },
      invokedName: "ping",
      args: [],
      body: `${prefix()}ping`,
      msg: {
        key: { remoteJid: dm, id: "reaction-protocol", fromMe: true },
        message: { extendedTextMessage: { text: `${prefix()}ping` } },
      },
      isGroup: false,
      rawRemainder: "",
      accountEpoch: store.accountEpoch(),
      options: {
        source: "reaction",
        silentDenials: true,
        neutralFailure: true,
        deliveryGuard: {
          async refresh() {},
          assert() {
            protocolCalls += 1;
            if (protocolCalls > 1) {
              const error = new Error("REACTION_CANCELLED");
              error.code = "REACTION_CANCELLED";
              throw error;
            }
          },
        },
      },
    });
    equal("protocol guard refusal is the control code", guarded.reason, "REACTION_CANCELLED");
    equal(
      "protocol delete after the guard does not land",
      f.state.attempts.some((row) => row.content?.delete),
      false,
    );

    f.state.attempts.length = 0;
    f.state.sent.length = 0;
    let failureGuarded = 0;
    const neutral = await executeCommandInvocation(f.socket, {
      command: {
        name: "ping",
        chat: "all",
        async execute() {
          throw new Error("boom");
        },
      },
      invokedName: "ping",
      args: [],
      body: `${prefix()}ping`,
      msg: {
        key: { remoteJid: dm, id: "reaction-neutral", fromMe: true },
        message: { extendedTextMessage: { text: `${prefix()}ping` } },
      },
      isGroup: false,
      rawRemainder: "",
      accountEpoch: store.accountEpoch(),
      options: {
        source: "reaction",
        silentDenials: true,
        neutralFailure: true,
        deliveryGuard: {
          async refresh() {},
          assert() {
            failureGuarded += 1;
          },
        },
      },
    });
    equal("neutral failure stays a command failure", neutral.reason, "REACTION_COMMAND_FAILED");
    equal("neutral failure uses the delivery guard", failureGuarded > 0, true);
    equal("neutral failure sends one notice", f.state.sent.length, 1);

    f.state.attempts.length = 0;
    f.state.sent.length = 0;
    const commandMsg = {
      key: { remoteJid: dm, id: "typed-edit", fromMe: true },
      message: { conversation: `${prefix()}ping` },
    };
    await executeCommandInvocation(f.socket, {
      command: {
        name: "ping",
        chat: "all",
        async execute(sock, msg) {
          await sock.sendMessage(msg.key.remoteJid, { text: "edited" });
        },
      },
      invokedName: "ping",
      args: [],
      body: `${prefix()}ping`,
      msg: commandMsg,
      isGroup: false,
      rawRemainder: "",
      accountEpoch: store.accountEpoch(),
      options: { source: "text", editInPlace: true },
    });
    equal(
      "text path can still edit its own command",
      f.state.sent[0].content.edit?.id,
      commandMsg.key.id,
    );
  }

  section("command gates deny silently when the sender filter already passed");
  {
    const f = await fixture();
    runtime.setPermission("ping", "OWNER_ONLY");
    const message = remember(f);
    receive(f, message, "🏓");
    equal("permission failure is a silent denial", await completed(f), "REACTION_COMMAND_DENIED");
    equal(
      "permission failure does not run ping",
      calls.some((call) => call.command === "ping"),
      false,
    );
    equal("permission failure sends nothing", f.state.sent.length, 0);
    equal("permission failure does not claim", count("reaction_executions"), 0);
    equal(
      "permission failure is recorded on the rule",
      status.get("rule")?.lastCode,
      "REACTION_COMMAND_DENIED",
    );

    const disabled = await fixture();
    runtime.setEnabled("ping", false);
    receive(disabled, remember(disabled), "🏓");
    equal(
      "disabled command is a silent denial",
      await completed(disabled),
      "REACTION_COMMAND_DENIED",
    );
    equal(
      "disabled command does not run",
      calls.some((call) => call.command === "ping"),
      false,
    );
    equal("disabled command sends nothing", disabled.state.sent.length, 0);
    equal("disabled command does not claim", count("reaction_executions"), 0);

    const direct = await fixture({
      rules: [
        {
          id: "members",
          chatJid: dm,
          definition: commandDefinition("group:members", { emoji: "🏓" }),
        },
      ],
      chat: dm,
    });
    const members = getLoadedCommands().get("members");
    const realMembers = members.execute;
    let membersCalled = false;
    members.execute = async () => {
      membersCalled = true;
    };
    try {
      receive(direct, remember(direct, original({ chat: dm })), "🏓");
      equal("group command in a DM is denied", await completed(direct), "REACTION_COMMAND_DENIED");
      equal("group command in a DM does not run", membersCalled, false);
      equal("group command in a DM sends nothing", direct.state.sent.length, 0);
      equal("group command in a DM does not claim", count("reaction_executions"), 0);
    } finally {
      members.execute = realMembers;
    }

    const memberKick = await fixture({
      rules: [{ id: "kick", definition: commandDefinition("group:kick", { emoji: "🫰" }) }],
    });
    markAdmins(memberKick, [bot]);
    receive(memberKick, remember(memberKick), "🫰");
    equal("non-admin kick is denied", await completed(memberKick), "REACTION_COMMAND_DENIED");
    equal(
      "non-admin kick does not run",
      calls.some((call) => call.command === "kick"),
      false,
    );
    equal("non-admin kick sends nothing", memberKick.state.sent.length, 0);
    equal("non-admin kick does not update participants", memberKick.state.updates.length, 0);
    equal("non-admin kick does not claim", count("reaction_executions"), 0);
    equal(
      "non-admin kick is recorded on the rule",
      status.get("kick")?.lastCode,
      "REACTION_COMMAND_DENIED",
    );

    const botMember = await fixture({
      rules: [{ id: "kick", definition: commandDefinition("group:kick", { emoji: "🫰" }) }],
    });
    markAdmins(botMember, [reactor]);
    receive(botMember, remember(botMember), "🫰");
    equal(
      "kick without bot admin is denied",
      await completed(botMember),
      "REACTION_COMMAND_DENIED",
    );
    equal(
      "kick without bot admin does not run",
      calls.some((call) => call.command === "kick"),
      false,
    );
    equal("kick without bot admin sends nothing", botMember.state.sent.length, 0);
    equal("kick without bot admin does not update participants", botMember.state.updates.length, 0);
    equal("kick without bot admin does not claim", count("reaction_executions"), 0);
    equal(
      "kick without bot admin is recorded on the rule",
      status.get("kick")?.lastCode,
      "REACTION_COMMAND_DENIED",
    );
  }

  section("protected kick targets are refused before removal");
  {
    const privileged = await fixture({
      rules: [{ id: "kick", definition: commandDefinition("group:kick", { emoji: "🫰" }) }],
    });
    markAdmins(privileged);
    store.saveUserMetadata({ jid: ownerUser, isOwner: true, isAdmin: false });
    privileged.state.participants.push({ id: ownerUser });
    receive(privileged, remember(privileged, original({ sender: ownerUser })), "🫰");
    equal("kick of a bot owner is denied", await completed(privileged), "REACTION_COMMAND_DENIED");
    equal("kick of a bot owner does not remove anyone", privileged.state.updates.length, 0);

    const adminTarget = await fixture({
      rules: [{ id: "kick", definition: commandDefinition("group:kick", { emoji: "🫰" }) }],
    });
    markAdmins(adminTarget);
    adminTarget.state.participants.find((row) => row.id === author).admin = "admin";
    receive(adminTarget, remember(adminTarget), "🫰");
    equal(
      "kick of a group admin is denied",
      await completed(adminTarget),
      "REACTION_COMMAND_DENIED",
    );
    equal("kick of a group admin does not remove anyone", adminTarget.state.updates.length, 0);

    const self = await fixture({
      rules: [
        {
          id: "kick",
          definition: commandDefinition("group:kick", {
            emoji: "🫰",
            allowOthersOnLinkedMessages: true,
          }),
        },
      ],
    });
    markAdmins(self);
    receive(self, remember(self, original({ fromMe: true })), "🫰");
    equal("kick of the bot is denied", await completed(self), "REACTION_COMMAND_DENIED");
    equal("kick of the bot does not remove anyone", self.state.updates.length, 0);
    equal(
      "protected kicks send no announcement",
      self.state.sent.length + privileged.state.sent.length + adminTarget.state.sent.length,
      0,
    );
  }

  section("a destructive kick runs once across remove, re-add, and a second admin");
  {
    const f = await fixture({
      rules: [{ id: "kick", definition: commandDefinition("group:kick", { emoji: "🫰" }) }],
    });
    markAdmins(f);
    f.state.participants.push({ id: admin2, admin: "admin" });
    const message = remember(f);
    receive(f, message, "🫰", reactor);
    equal("first kick delivers", await completed(f), "DELIVERED");
    equal("first kick removes once", f.state.updates.length, 1);
    receive(f, message, "", reactor);
    equal("remove does not match an add-only kick", await completed(f), "NO_MATCH");
    receive(f, message, "🫰", reactor);
    equal("re-add does not run the kick again", await completed(f), "DUPLICATE");
    receive(f, message, "🫰", admin2);
    equal("second admin does not run the kick again", await completed(f), "DUPLICATE");
    equal("groupParticipantsUpdate ran once", f.state.updates.length, 1);
    equal("the one removal is the original author", f.state.updates[0].ids[0], author);
    equal("a second admin does not announce again", f.state.sent.length, 1);
  }

  section("a kick cancelled during the final roster read removes nobody");
  {
    async function cancelled(mutate) {
      const f = await fixture({
        rules: [{ id: "kick", definition: commandDefinition("group:kick", { emoji: "🫰" }) }],
      });
      markAdmins(f);
      const message = remember(f);
      f.state.onMetadata = () => {
        if (f.state.metadataCalls < 2) return;
        mutate(f, message);
      };
      receive(f, message, "🫰");
      await completed(f);
      equal("cancelled kick removes nobody", f.state.updates.length, 0);
      equal("cancelled kick does not claim", count("reaction_executions"), 0);
      return f;
    }
    await cancelled(() => {
      store.saveBotSetting("reaction:enabled", false);
    });
    await cancelled(() => {
      runtime.setEnabled("kick", false);
    });
    await cancelled((f, message) => {
      f.engine.intake.observeDeletes({ keys: [{ remoteJid: group, id: message.key.id }] });
    });
    await cancelled((f) => {
      const row = f.state.participants.find((participant) => participant.id === reactor);
      if (row) delete row.admin;
    });
    await cancelled(() => {
      store.advanceAccountEpoch();
    });
    runtime.setEnabled("kick", true);
  }

  section("kick claim stays on the cached author after a phone mapping");
  {
    const lid = "201070000777@lid";
    const phone = "201070000777@s.whatsapp.net";
    const f = await fixture({
      rules: [{ id: "kick", definition: commandDefinition("group:kick", { emoji: "🫰" }) }],
    });
    f.state.participants = [
      { id: lid },
      { id: reactor, admin: "admin" },
      { id: bot, admin: "admin" },
      { id: admin2, admin: "admin" },
    ];
    const message = remember(f, original({ sender: lid }));
    receive(f, message, "🫰", reactor);
    equal("lid kick delivers", await completed(f), "DELIVERED");
    equal("lid kick removes once", f.state.updates.length, 1);
    equal("lid kick removes the cached author", f.state.updates[0].ids[0], lid);
    store.storeLidPnMapping(lid, phone);
    f.state.participants = f.state.participants.filter((row) => row.id !== lid);
    f.state.participants.push({ id: phone });
    receive(f, message, "🫰", admin2);
    equal("mapping does not open a second removal", await completed(f), "DUPLICATE");
    equal("one removal after the target rejoins", f.state.updates.length, 1);
  }

  section("an evicted stanza redelivered under a phone jid cannot kick twice");
  {
    const lid = "201070000888@lid";
    const phone = "201070000888@s.whatsapp.net";
    const f = await fixture({
      rules: [{ id: "kick", definition: commandDefinition("group:kick", { emoji: "🫰" }) }],
    });
    f.state.participants = [
      { id: lid },
      { id: reactor, admin: "admin" },
      { id: bot, admin: "admin" },
      { id: admin2, admin: "admin" },
    ];
    const message = remember(f, original({ sender: lid }));
    equal("lid original is cached", f.engine.intake.stats().items, 1);
    receive(f, message, "🫰", reactor);
    equal("lid removal delivers", await completed(f), "DELIVERED");
    equal("lid removal runs once", f.state.updates.length, 1);
    f.engine.intake.resetLookup();
    equal("eviction drops the cached original", f.engine.intake.stats().items, 0);
    const redelivered = {
      key: { ...message.key, participant: phone },
      messageTimestamp: Math.floor(clock / 1000),
      message: message.message,
    };
    f.engine.intake.observeUpsert({ type: "notify", messages: [redelivered] });
    equal("phone redelivery caches the same stanza", f.engine.intake.stats().items, 1);
    f.state.participants = f.state.participants.filter((row) => row.id !== lid);
    f.state.participants.push({ id: phone });
    receive(f, redelivered, "🫰", admin2);
    equal("phone redelivery does not remove again", await completed(f), "DUPLICATE");
    equal("one removal after eviction and rejoin", f.state.updates.length, 1);
  }

  section("a confirmed reaction kick announces once after the member is gone");
  {
    const f = await fixture({
      rules: [{ id: "kick", definition: commandDefinition("group:kick", { emoji: "🫰" }) }],
    });
    markAdmins(f);
    f.state.participants.push({ id: admin2, admin: "admin" });
    f.state.onParticipantsUpdate = (ids, action) => {
      if (action !== "remove") return;
      const gone = new Set(ids);
      f.state.participants = f.state.participants.filter((row) => !gone.has(row.id));
    };
    const message = remember(f);
    receive(f, message, "🫰", reactor);
    const announcements = () =>
      f.state.sent.filter((row) => String(row.content?.text || "").includes("*Action:* kick"))
        .length;
    equal("removal delivers", await completed(f), "DELIVERED");
    equal("removal runs once", f.state.updates.length, 1);
    equal(
      "the removed author is gone",
      f.state.participants.some((row) => row.id === author),
      false,
    );
    equal("the removal posts one announcement", announcements(), 1);
    equal("the announcement stays in the group", f.state.sent[0].chat, group);
    f.state.participants.push({ id: author });
    receive(f, message, "🫰", admin2);
    equal("a second admin does not remove again", await completed(f), "DUPLICATE");
    equal("a second admin does not remove", f.state.updates.length, 1);
    equal("a second admin posts no announcement", announcements(), 1);
  }

  section("a kick receipt follows the removal notification and still rechecks");
  {
    const { setupEventListeners } = await import("../src/core/events.js");
    const wire = (f) =>
      setupEventListeners(f.socket, {
        automation: f.engine,
        saveCreds() {},
        onConnectionUpdate() {},
      });
    const announcements = (f) =>
      f.state.sent.filter((row) => String(row.content?.text || "").includes("*Action:* kick"))
        .length;
    const kickRule = {
      rules: [{ id: "kick", definition: commandDefinition("group:kick", { emoji: "🫰" }) }],
    };

    {
      const f = await fixture(kickRule);
      markAdmins(f);
      const dispose = wire(f);
      f.state.onMetadata = () => {
        if (f.state.metadataCalls < 2) return;
        f.socket.ev.emit("group-participants.update", {
          id: group,
          action: "demote",
          participants: [{ id: reactor }],
        });
      };
      try {
        receive(f, remember(f), "🫰");
        // The demotion either aborts the job or fails the final permission
        // gate, depending on which roster read sees it first. Both refuse.
        const code = await completed(f);
        ok(
          "demotion before the removal refuses the kick",
          code === "REACTION_CANCELLED" || code === "REACTION_COMMAND_DENIED",
        );
        equal("demotion before the removal removes nobody", f.state.updates.length, 0);
        equal("demotion before the removal sends no receipt", announcements(f), 0);
      } finally {
        dispose();
      }
    }

    {
      const f = await fixture(kickRule);
      markAdmins(f);
      const dispose = wire(f);
      let during = -1;
      f.state.onParticipantsUpdate = (ids, action) => {
        if (action !== "remove") return;
        const gone = new Set(ids);
        f.state.participants = f.state.participants.filter((row) => !gone.has(row.id));
        during = announcements(f);
        f.socket.ev.emit("group-participants.update", {
          id: group,
          action: "remove",
          participants: ids.map((id) => ({ id })),
        });
      };
      try {
        receive(f, remember(f), "🫰");
        equal("target removal still delivers", await completed(f), "DELIVERED");
        equal("target removal runs once", f.state.updates.length, 1);
        equal("the receipt waits until the target is gone", during, 0);
        equal("the receipt is sent once", announcements(f), 1);
        equal("the receipt is the only send", f.state.sent.length, 1);
        equal("the receipt stays in the group", f.state.sent[0].chat, group);
      } finally {
        dispose();
      }
    }

    {
      const f = await fixture(kickRule);
      markAdmins(f);
      const dispose = wire(f);
      f.state.onParticipantsUpdate = (ids, action) => {
        if (action !== "remove") return;
        const gone = new Set(ids);
        f.state.participants = f.state.participants.filter((row) => !gone.has(row.id));
        const requester = f.state.participants.find((row) => row.id === reactor);
        if (requester) delete requester.admin;
        f.socket.ev.emit("group-participants.update", {
          id: group,
          action: "remove",
          participants: ids.map((id) => ({ id })),
        });
      };
      try {
        receive(f, remember(f), "🫰");
        equal(
          "a demoted requester is refused on the live roster",
          await completed(f),
          "REACTION_COMMAND_DENIED",
        );
        equal("the demoted requester was still removed", f.state.updates.length, 1);
        equal("a demoted requester gets no receipt", announcements(f), 0);
      } finally {
        dispose();
      }
    }

    {
      const f = await fixture(kickRule);
      markAdmins(f);
      const dispose = wire(f);
      f.state.onParticipantsUpdate = (ids, action) => {
        if (action !== "remove") return;
        const gone = new Set(ids);
        f.state.participants = f.state.participants.filter((row) => !gone.has(row.id));
        f.socket.ev.emit("group-participants.update", {
          id: group,
          action: "remove",
          participants: ids.map((id) => ({ id })),
        });
        f.socket.ev.emit("group-participants.update", {
          id: group,
          action: "remove",
          participants: [reactor],
        });
      };
      try {
        receive(f, remember(f), "🫰");
        equal("requester removal aborts the receipt", await completed(f), "REACTION_CANCELLED");
        equal("requester removal still removes the target", f.state.updates.length, 1);
        equal("requester removal sends no receipt", announcements(f), 0);
      } finally {
        dispose();
      }
    }

    {
      const f = await fixture(kickRule);
      markAdmins(f);
      const dispose = wire(f);
      let during = -1;
      f.state.onParticipantsUpdate = (ids) => {
        during = announcements(f);
        f.socket.ev.emit("group-participants.update", {
          id: group,
          action: "remove",
          participants: ids.map((id) => ({ id })),
        });
      };
      const quoted = {
        stanzaId: "typed-kick-target",
        participant: author,
        quotedMessage: { conversation: "hello" },
      };
      const typed = {
        key: { remoteJid: group, id: "typed-kick-receipt", fromMe: false, participant: reactor },
        message: {
          extendedTextMessage: { text: `${prefix()}kick`, contextInfo: quoted },
        },
      };
      try {
        await handleCommand(f.socket, typed, `${prefix()}kick`, store.accountEpoch());
        equal("typed !kick still announces before the removal notice", during, 1);
        equal("typed !kick still removes once", f.state.updates.length, 1);
        equal("typed !kick still announces once", announcements(f), 1);
        equal("typed !kick removes the quoted author", f.state.updates[0].ids[0], author);
      } finally {
        dispose();
      }
    }
  }

  section("disabling group refuses !group kick and leaves !kick alone");
  {
    const f = await fixture({
      rules: [{ id: "kick", definition: commandDefinition("group:kick", { emoji: "🫰" }) }],
    });
    markAdmins(f);
    f.state.participants.push({ id: memberB });
    runtime.setEnabled("group", false);
    const quoted = {
      stanzaId: "quoted-group",
      participant: author,
      quotedMessage: { conversation: "hello" },
    };
    const grouped = {
      key: { remoteJid: group, id: "typed-group-kick", fromMe: false, participant: reactor },
      message: {
        extendedTextMessage: { text: `${prefix()}group kick`, contextInfo: quoted },
      },
    };
    await handleCommand(f.socket, grouped, `${prefix()}group kick`, store.accountEpoch());
    equal("disabled group wrapper does not remove", f.state.updates.length, 0);
    const typed = {
      key: { remoteJid: group, id: "typed-direct-kick", fromMe: false, participant: reactor },
      message: {
        extendedTextMessage: { text: `${prefix()}kick`, contextInfo: quoted },
      },
    };
    await handleCommand(f.socket, typed, `${prefix()}kick`, store.accountEpoch());
    equal("direct kick still removes while group is disabled", f.state.updates.length, 1);
    equal("direct kick removes the quoted author", f.state.updates[0].ids[0], author);
    runtime.setEnabled("group", true);
  }

  section("a superseded reaction or an account change does not execute");
  {
    const stale = await fixture();
    stale.state.onMetadata = () => {
      db.exec("UPDATE reaction_state SET emoji = '💤'");
    };
    receive(stale, remember(stale), "🏓");
    equal("superseded reaction is stale", await completed(stale), "REACTION_STALE");
    equal(
      "superseded reaction does not run",
      calls.some((call) => call.command === "ping"),
      false,
    );
    equal("superseded reaction sends nothing", stale.state.sent.length, 0);
    equal("superseded reaction does not claim", count("reaction_executions"), 0);

    const moved = await fixture();
    moved.state.onMetadata = () => {
      store.advanceAccountEpoch();
    };
    receive(moved, remember(moved), "🏓");
    equal("account change is stale", await completed(moved), "REACTION_STALE");
    equal(
      "account change does not run",
      calls.some((call) => call.command === "ping"),
      false,
    );
    equal("account change sends nothing", moved.state.sent.length, 0);
    equal("account change does not claim", count("reaction_executions"), 0);
  }

  section("lid-mapping.update stores real pairs and skips garbage");
  {
    if (current) {
      current.engine.close();
      await current.engine.settled();
      current = null;
    }
    db.exec("DELETE FROM lid_mapping");
    const { setupEventListeners } = await import("../src/core/events.js");
    const ev = new EventEmitter();
    const dispose = setupEventListeners({ ev, user: { id: bot }, ws: new EventEmitter() }, {});
    ev.emit("lid-mapping.update", {
      lid: "201111111111@lid",
      pn: "201222222222@s.whatsapp.net",
    });
    equal(
      "rc14 pair stores the lid",
      store.getPnForLid("201111111111@lid"),
      "201222222222@s.whatsapp.net",
    );
    equal(
      "rc14 pair stores the phone",
      store.getLidForPn("201222222222@s.whatsapp.net"),
      "201111111111@lid",
    );
    ev.emit("lid-mapping.update", {
      lid: "201111111111:bad@lid",
      pn: "201999999999@s.whatsapp.net",
    });
    equal(
      "malformed device suffix does not replace the stored pair",
      store.getPnForLid("201111111111@lid"),
      "201222222222@s.whatsapp.net",
    );
    ev.emit("lid-mapping.update", { lid: "201555555556@lid", pn: "201666666662" });
    equal("bare phone is not a mapping pn", store.getPnForLid("201555555556@lid"), null);
    ev.emit("lid-mapping.update", { lid: "lid", pn: "pn" });
    equal(
      "garbage pair is not stored",
      db.prepare("SELECT COUNT(*) AS n FROM lid_mapping WHERE lid = 'lid' OR pn = 'pn'").get().n,
      0,
    );
    equal("direct garbage write is refused", store.storeLidPnMapping("lid", "pn"), false);
    ev.emit("lid-mapping.update", [
      { lid: "201333333333:9@lid", pn: "201444444444:4@s.whatsapp.net" },
    ]);
    equal(
      "array pair is canonical",
      store.getPnForLid("201333333333@lid"),
      "201444444444@s.whatsapp.net",
    );
    equal("device suffix is not a stored lid", store.getPnForLid("201333333333:9@lid"), null);
    ev.emit("lid-mapping.update", { "201666666666@lid": "201777777777@s.whatsapp.net" });
    equal(
      "legacy map still stores a real pair",
      store.getLidForPn("201777777777@s.whatsapp.net"),
      "201666666666@lid",
    );
    db.prepare(
      "INSERT INTO lid_mapping (lid, pn, device_index, updated_at) VALUES ('not-a-jid', '201222222222@s.whatsapp.net', 0, 1)",
    ).run();
    db.prepare(
      "INSERT INTO lid_mapping (lid, pn, device_index, updated_at) VALUES ('201888888888@lid', 'pn', 0, 1)",
    ).run();
    equal("malformed lid lookup is ignored", store.getPnForLid("not-a-jid"), null);
    equal("malformed phone counterpart is ignored", store.getPnForLid("201888888888@lid"), null);
    const aliases = store.reactionIdentityAliases("201222222222@s.whatsapp.net");
    ok("alias read keeps the real phone", aliases.includes("201222222222@s.whatsapp.net"));
    ok("alias read keeps the real lid", aliases.includes("201111111111@lid"));
    equal("alias read skips the malformed lid", aliases.includes("not-a-jid"), false);
    equal("alias read skips the garbage phone", aliases.includes("pn"), false);
    dispose();
  }

  section("sender role, selected participants, and linked originals");
  {
    const blocked = await fixture({
      rules: [
        {
          id: "role",
          definition: commandDefinition("ping", {
            senders: { role: "owner_group_admin", ids: [] },
          }),
        },
      ],
    });
    blocked.state.participants.push({ id: memberB });
    store.saveUserMetadata({ jid: memberB, isOwner: false, isAdmin: true });
    receive(blocked, remember(blocked), "🏓", memberB);
    equal("bot admin is not owner or group admin", await completed(blocked), "NO_MATCH");
    equal(
      "bot admin does not run ping",
      calls.some((call) => call.command === "ping"),
      false,
    );
    equal("bot admin sends nothing", blocked.state.sent.length, 0);

    const admin = await fixture({
      rules: [
        {
          id: "role",
          definition: commandDefinition("ping", {
            senders: { role: "owner_group_admin", ids: [] },
          }),
        },
      ],
    });
    markAdmins(admin, [reactor]);
    receive(admin, remember(admin), "🏓");
    equal("group admin matches owner_group_admin", await completed(admin), "DELIVERED");

    const owner = await fixture({
      rules: [
        {
          id: "role",
          definition: commandDefinition("ping", {
            senders: { role: "owner_group_admin", ids: [] },
          }),
        },
      ],
    });
    owner.state.participants.push({ id: ownerUser });
    store.saveUserMetadata({ jid: ownerUser, isOwner: true, isAdmin: false });
    receive(owner, remember(owner), "🏓", ownerUser);
    equal("bot owner matches owner_group_admin", await completed(owner), "DELIVERED");

    const picked = await fixture({
      rules: [
        {
          id: "picked",
          definition: commandDefinition("ping", { senders: { role: "any", ids: [reactor] } }),
        },
      ],
    });
    picked.state.participants.push({ id: memberB });
    const message = remember(picked);
    receive(picked, message, "🏓", memberB);
    equal("unlisted participant does not match", await completed(picked), "NO_MATCH");
    equal("unlisted participant sends nothing", picked.state.sent.length, 0);
    receive(picked, message, "🏓", reactor);
    equal("listed participant matches", await completed(picked), "DELIVERED");

    const closed = await fixture();
    const own = remember(closed, original({ fromMe: true }));
    receive(closed, own, "🏓");
    equal("someone else on a linked message is ignored", await completed(closed), "NO_MATCH");
    equal("ignored linked message sends nothing", closed.state.sent.length, 0);
    equal("ignored linked message does not claim", count("reaction_executions"), 0);

    const opened = await fixture({
      rules: [
        {
          id: "open",
          definition: commandDefinition("ping", { allowOthersOnLinkedMessages: true }),
        },
      ],
    });
    receive(opened, remember(opened, original({ fromMe: true })), "🏓");
    equal("flag admits someone else on a linked message", await completed(opened), "DELIVERED");

    const selfFilter = await fixture({
      rules: [
        {
          id: "self",
          definition: commandDefinition("ping", { senders: { role: "member", ids: [] } }),
        },
      ],
    });
    receive(selfFilter, remember(selfFilter, original({ fromMe: true })), "🏓", bot, {
      fromMe: true,
    });
    equal(
      "linked account still has to match the sender filter",
      await completed(selfFilter),
      "NO_MATCH",
    );
    equal("filtered linked account sends nothing", selfFilter.state.sent.length, 0);
  }

  section("a denied reactor leaves the kick claim for a later admin");
  {
    const f = await fixture({
      rules: [{ id: "kick", definition: commandDefinition("group:kick", { emoji: "🫰" }) }],
    });
    f.state.participants.push({ id: admin2, admin: "admin" }, { id: memberB });
    markAdmins(f, [bot, admin2]);
    const message = remember(f);
    receive(f, message, "🫰", memberB);
    equal("member kick is denied", await completed(f), "REACTION_COMMAND_DENIED");
    equal("denied member sends nothing", f.state.sent.length, 0);
    equal("denied member does not remove", f.state.updates.length, 0);
    equal("denied member does not claim", count("reaction_executions"), 0);
    equal(
      "denied member is recorded on the rule",
      status.get("kick")?.lastCode,
      "REACTION_COMMAND_DENIED",
    );
    receive(f, message, "🫰", admin2);
    equal("later admin kick delivers", await completed(f), "DELIVERED");
    equal("later admin removes once", f.state.updates.length, 1);
    equal("later admin removes the author", f.state.updates[0].ids[0], author);
    equal("later admin claims once", count("reaction_executions"), 1);
  }

  section("remove and re-add of the same emoji cancels the earlier kick");
  {
    const f = await fixture({
      rules: [{ id: "kick", definition: commandDefinition("group:kick", { emoji: "🫰" }) }],
    });
    markAdmins(f);
    const message = remember(f);
    let waits = 0;
    f.state.onMetadata = async () => {
      if (waits++) return;
      receive(f, message, "", reactor);
      receive(f, message, "🫰", reactor);
    };
    receive(f, message, "🫰", reactor);
    equal("earlier kick is stale", await completed(f), "REACTION_STALE");
    equal("cancelled kick removes nobody", f.state.updates.length, 0);
    equal("cancelled kick claims nothing", count("reaction_executions"), 0);
    equal("cancelled kick sends nothing", f.state.sent.length, 0);
  }

  section("gemini management verbs are rejected before a reaction can run them");
  {
    for (const verb of [
      "add",
      "send",
      "show",
      "clear",
      "del",
      "delall",
      "resetai",
      "generate",
      "Add",
    ]) {
      equal(`${verb} is rejected`, validateArgs("gemini", [`${verb} hello`]).ok, false);
    }
    const plain = validateArgs("gemini", ["hello there"]);
    equal("a plain prompt is unsupported", plain.ok, false);
    equal("a plain prompt is not in 5.0.1", plain.errors[0]?.code, "NOT_IN_5_0_1");
    const ask = validateArgs("gemini", ["ask what time is it"]);
    equal("ask is unsupported", ask.ok, false);
    equal("ask is not in 5.0.1", ask.errors[0]?.code, "NOT_IN_5_0_1");
    equal("note keyword is one hash token", validateArgs("group:note", ["#hello_1"]).ok, true);
    equal("note keyword must be hashed", validateArgs("group:note", ["hello"]).ok, false);
    const reasons = {
      gemini: "NOT_IN_5_0_1",
      sticker: "NOT_IN_5_0_1",
      "group:promote": "NOT_IN_5_0_1",
      "group:demote": "NOT_IN_5_0_1",
      "group:clearwarns": "NOT_IN_5_0_1",
      "group:antilink": "SETTINGS_CHANGE",
      "group:media": "SETTINGS_CHANGE",
      "group:welcome": "SETTINGS_CHANGE",
      todo: "REQUESTER_SCOPE",
      packs: "REQUESTER_SCOPE",
      stickers: "REQUESTER_SCOPE",
      memory: "REQUESTER_SCOPE",
    };
    for (const [key, reason] of Object.entries(reasons)) {
      equal(`${key} mode`, classify(key).mode, "unsupported");
      equal(`${key} reason`, classify(key).reason, reason);
    }
    equal("group note is args", classify("group:note").mode, "args");
    equal("kick stays destructive", classify("group:kick").destructive, true);

    const f = await fixture({ rules: [] });
    db.prepare(
      `INSERT INTO reaction_rules (id, chat_jid, enabled, definition, revision, enabled_at, priority)
       VALUES ('badgemini', ?, 1, ?, 'rev', ?, 0)`,
    ).run(
      group,
      JSON.stringify({
        version: 2,
        emoji: "🏓",
        transitions: ["add"],
        originalTypes: ["text"],
        senders: { role: "any", ids: [] },
        command: { name: "gemini", args: ["del"] },
        destination: { mode: "same_chat" },
      }),
      clock - 1000,
    );
    const message = remember(f);
    equal("planted row still opts the chat in", f.engine.intake.stats().items, 1);
    receive(f, message, "🏓");
    equal("planted gemini verb matches nothing", await completed(f), "NO_MATCH");
    equal("planted gemini verb sends nothing", f.state.sent.length, 0);
  }

  section("reaction STT guards stay inside the command");
  {
    const quote = (ptt) => ({
      key: { remoteJid: group, id: `stt-${++sequence}`, fromMe: false, participant: reactor },
      message: {
        extendedTextMessage: {
          text: `${prefix()}stt`,
          contextInfo: {
            quotedMessage: {
              ...voiceMessage(),
              audioMessage: { ...voiceMessage().audioMessage, ptt },
            },
          },
        },
      },
    });
    const f = await fixture();
    let error = null;
    try {
      await saved.stt(f.socket, quote(false), [], `${prefix()}stt`, null, { source: "reaction" });
    } catch (caught) {
      error = caught;
    }
    equal("non-voice audio is refused", error?.message, "REACTION_VOICE_REQUIRED");
    equal("non-voice audio is not downloaded", downloaded, 0);

    settings.set("ai_stt_enabled", false);
    error = null;
    try {
      await saved.stt(f.socket, quote(true), [], `${prefix()}stt`, null, { source: "reaction" });
    } catch (caught) {
      error = caught;
    }
    equal("live STT switch is enforced", error?.message, "REACTION_STT_DISABLED");
    settings.set("ai_stt_enabled", true);
    settings.set("gemini_api_key", "");
    error = null;
    try {
      await saved.stt(f.socket, quote(true), [], `${prefix()}stt`, null, { source: "reaction" });
    } catch (caught) {
      error = caught;
    }
    equal("missing provider key is enforced", error?.message, "STT_KEY_REQUIRED");
    settings.set("gemini_api_key", "isolated-test-key");

    media.downloadMedia = async () => Buffer.from("nope");
    error = null;
    try {
      await saved.stt(f.socket, quote(true), [], `${prefix()}stt`, null, { source: "reaction" });
    } catch (caught) {
      error = caught;
    }
    equal("bad audio bytes are refused", error?.message, "MEDIA_AUDIO_INVALID");

    const order = [];
    media.downloadMedia = async () => {
      settings.set("gemini_api_key", "");
      order.push("download");
      return audioBytes;
    };
    stt.transcribe = async () => {
      order.push("upload");
      return "late";
    };
    error = null;
    try {
      await saved.stt(f.socket, quote(true), [], `${prefix()}stt`, null, {
        source: "reaction",
        beforeEffect: async () => order.push("auth"),
      });
    } catch (caught) {
      error = caught;
    }
    equal("key is checked again before upload", error?.message, "STT_KEY_REQUIRED");
    equal("re-check happens after authorization", order.join(","), "download,auth");
    settings.set("gemini_api_key", "isolated-test-key");

    order.length = 0;
    let blockedUploads = 0;
    media.downloadMedia = async () => {
      order.push("download");
      return audioBytes;
    };
    stt.transcribe = async () => {
      blockedUploads += 1;
      order.push("upload");
      return "late";
    };
    error = null;
    try {
      await saved.stt(f.socket, quote(true), [], `${prefix()}stt`, null, {
        source: "reaction",
        beforeEffect: async () => {
          order.push("auth");
          settings.set("ai_stt_enabled", false);
        },
      });
    } catch (caught) {
      error = caught;
    }
    equal(
      "switch flipped during authorization stops the upload",
      error?.message,
      "REACTION_STT_DISABLED",
    );
    equal("switch re-check is after authorization", order.join(","), "download,auth");
    equal("switch re-check does not upload", blockedUploads, 0);
    settings.set("ai_stt_enabled", true);

    order.length = 0;
    media.downloadMedia = async () => {
      order.push("download");
      return audioBytes;
    };
    stt.transcribe = async () => {
      order.push("upload");
      return "verified transcript";
    };
    await saved.stt(f.socket, quote(true), [], `${prefix()}stt`, null, {
      source: "reaction",
      beforeEffect: async () => order.push("auth"),
    });
    equal("authorization is rechecked before upload", order.join(","), "download,auth,upload");

    const ac = new AbortController();
    ac.abort(new Error("REACTION_CANCELLED"));
    let uploads = 0;
    stt.transcribe = async () => {
      uploads += 1;
      return "nope";
    };
    error = null;
    try {
      await saved.stt(f.socket, quote(true), [], `${prefix()}stt`, null, {
        source: "reaction",
        signal: ac.signal,
      });
    } catch (caught) {
      error = caught;
    }
    equal("abort is a control error", error?.message, "REACTION_CANCELLED");
    equal("abort does not upload", uploads, 0);

    f.state.sent.length = 0;
    stt.transcribe = async () => {
      throw new Error("SECRET_PROVIDER_BOOM");
    };
    media.downloadMedia = async () => audioBytes;
    error = null;
    try {
      await saved.stt(f.socket, quote(true), [], `${prefix()}stt`, null, { source: "reaction" });
    } catch (caught) {
      error = caught;
    }
    const failure = f.state.sent.map((row) => row.content?.text || "").join("\n");
    equal("provider failure is not delivered", error?.message, "REACTION_COMMAND_FAILED");
    ok("provider failure uses the translated STT error", failure.includes("Transcription failed"));
    ok("provider failure details stay generic", failure.includes("unknown"));
    equal("provider failure hides raw error text", failure.includes("SECRET_PROVIDER_BOOM"), false);

    const engine = await fixture({
      rules: [{ id: "stt", definition: commandDefinition("stt", { emoji: "🗿" }) }],
    });
    settings.set("ai_stt_enabled", false);
    receive(engine, remember(engine, original({ type: "voice" })), "🗿");
    equal(
      "engine STT switch denies before download",
      await completed(engine),
      "REACTION_STT_DISABLED",
    );
    equal("engine STT switch sends nothing", engine.state.sent.length, 0);
    equal("engine STT switch does not download", downloaded, 0);
    equal("engine STT switch does not claim", count("reaction_executions"), 0);
  }

  section("reaction STT re-checks the switch while endpoint validation is pending");
  {
    const providerUrl = require("./src/utils/providerUrl.cjs");
    const realAssert = providerUrl.assertProviderRequestUrl;
    const uploads = { n: 0 };
    let release = () => {};
    let server;
    try {
      server = createServer((req, res) => {
        uploads.n += 1;
        req.resume();
        req.on("end", () => {
          if (res.writableEnded) return;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              candidates: [
                {
                  content: { parts: [{ text: "typed transcript" }], role: "model" },
                  finishReason: "STOP",
                },
              ],
            }),
          );
        });
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      const f = await fixture();
      settings.set("gemini_base_url", `http://127.0.0.1:${address.port}`);
      settings.set("gemini_api_key", "isolated-validation-key");
      settings.set("ai_stt_enabled", true);
      settings.set("ai_stt_provider", "gemini");
      stt.transcribe = saved.transcribe;
      const started = new Promise((resolve) => {
        providerUrl.assertProviderRequestUrl = async (...args) => {
          resolve("entered");
          await new Promise((done) => {
            release = done;
          });
          return realAssert.apply(providerUrl, args);
        };
      });
      const quote = {
        key: {
          remoteJid: group,
          id: `stt-admit-${++sequence}`,
          fromMe: false,
          participant: reactor,
        },
        message: {
          extendedTextMessage: {
            text: `${prefix()}stt`,
            contextInfo: { quotedMessage: voiceMessage() },
          },
        },
      };
      const pending = saved
        .stt(f.socket, quote, [], `${prefix()}stt`, null, { source: "reaction" })
        .then(
          () => ({ error: null }),
          (error) => ({ error }),
        );
      const saw = await Promise.race([
        started,
        new Promise((resolve) => setTimeout(() => resolve("timeout"), 1000)),
      ]);
      equal("endpoint validation started", saw, "entered");
      settings.set("ai_stt_enabled", false);
      release();
      const outcome = await Promise.race([
        pending,
        new Promise((resolve) =>
          setTimeout(() => resolve({ error: new Error("TEST_TIMEOUT") }), 5000),
        ),
      ]);
      equal(
        "switch flipped during validation stops the upload",
        outcome.error?.message,
        "REACTION_STT_DISABLED",
      );
      equal("validation re-check does not upload", uploads.n, 0);

      providerUrl.assertProviderRequestUrl = realAssert;
      let typedError = null;
      try {
        await saved.transcribe(audioBytes, "audio/ogg");
      } catch (error) {
        typedError = error;
      }
      ok("typed transcription still reaches the endpoint", uploads.n >= 1);
      const reactionSwitch =
        typedError?.message === "REACTION_STT_DISABLED" ||
        typedError?.code === "REACTION_STT_DISABLED";
      equal("typed transcription ignores the reaction switch", reactionSwitch, false);
    } finally {
      release();
      providerUrl.assertProviderRequestUrl = realAssert;
      settings.set("gemini_base_url", "");
      settings.set("ai_stt_enabled", true);
      settings.set("gemini_api_key", "isolated-test-key");
      if (server) await new Promise((resolve) => server.close(resolve));
    }
  }

  section("reaction STT reads the key after DNS and uploads that key");
  {
    const dnsPromises = require("node:dns").promises;
    const realLookup = dnsPromises.lookup;
    const hits = [];
    let server;
    let lookedUp = false;
    let mocked = null;
    const restoreLookup = () => {
      dnsPromises.lookup = realLookup;
    };
    const installLookup = (mutate) => {
      lookedUp = false;
      dnsPromises.lookup = async (hostname, options) => {
        if (!lookedUp && hostname === "localhost") {
          lookedUp = true;
          mutate();
        }
        return realLookup(hostname, options);
      };
    };
    try {
      server = createServer((req, res) => {
        hits.push({
          authorization: req.headers.authorization || "",
          apiKey: req.headers["x-goog-api-key"] || "",
        });
        req.resume();
        req.on("end", () => {
          if (res.writableEnded) return;
          res.writeHead(200, { "content-type": "application/json" });
          const body = String(req.url || "").includes("transcriptions")
            ? { text: "sealed transcript" }
            : {
                candidates: [
                  {
                    content: { parts: [{ text: "sealed transcript" }], role: "model" },
                    finishReason: "STOP",
                  },
                ],
              };
          res.end(JSON.stringify(body));
        });
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = server.address().port;
      const f = await fixture();
      mocked = stt.transcribe;
      stt.transcribe = saved.transcribe;
      const quote = () => ({
        key: {
          remoteJid: group,
          id: `stt-dns-${++sequence}`,
          fromMe: false,
          participant: reactor,
        },
        message: {
          extendedTextMessage: {
            text: `${prefix()}stt`,
            contextInfo: { quotedMessage: voiceMessage() },
          },
        },
      });
      const react = async (mutate) => {
        hits.length = 0;
        installLookup(mutate);
        try {
          return await saved
            .stt(f.socket, quote(), [], `${prefix()}stt`, null, { source: "reaction" })
            .then(
              () => ({ error: null }),
              (error) => ({ error }),
            );
        } finally {
          restoreLookup();
        }
      };

      settings.set("ai_stt_provider", "openai");
      settings.set("openai_api_key", "openai-before-dns");
      settings.set("openai_base_url", `http://localhost:${port}/v1`);
      settings.set("ai_stt_enabled", true);
      let outcome = await react(() => settings.set("ai_stt_enabled", false));
      equal("DNS saw the OpenAI host", lookedUp, true);
      equal("STT disabled during DNS uploads nothing", hits.length, 0);
      equal(
        "STT disabled during DNS is cancelled",
        outcome.error?.message,
        "REACTION_STT_DISABLED",
      );

      settings.set("ai_stt_enabled", true);
      settings.set("openai_api_key", "openai-before-dns");
      outcome = await react(() => settings.set("openai_api_key", ""));
      equal("a key cleared during DNS uploads nothing", hits.length, 0);
      equal("a key cleared during DNS is refused", outcome.error?.message, "STT_KEY_REQUIRED");

      settings.set("openai_api_key", "openai-before-dns");
      settings.set("gemini_api_key", "gemini-still-present");
      outcome = await react(() => settings.set("ai_stt_provider", "gemini"));
      equal("a provider switch during DNS uploads nothing", hits.length, 0);
      equal("a provider switch during DNS is refused", outcome.error?.message, "STT_KEY_REQUIRED");

      settings.set("ai_stt_provider", "openai");
      settings.set("openai_api_key", "openai-before-dns");
      outcome = await react(() => runtime.setEnabled("stt", false));
      equal("disabling !stt during DNS uploads nothing", hits.length, 0);
      equal(
        "disabling !stt during DNS is cancelled",
        outcome.error?.message,
        "REACTION_COMMAND_DENIED",
      );
      runtime.setEnabled("stt", true);

      settings.set("openai_api_key", "openai-before-dns");
      outcome = await react(() => settings.set("openai_api_key", "openai-after-dns"));
      equal("a rotated OpenAI key is the uploaded key", hits.length, 1);
      equal(
        "the OpenAI request uses the key read after DNS",
        hits[0].authorization,
        "Bearer openai-after-dns",
      );
      equal("a rotated OpenAI key still transcribes", outcome.error, null);

      settings.set("ai_stt_provider", "gemini");
      settings.set("gemini_api_key", "gemini-before-dns");
      settings.set("gemini_base_url", `http://localhost:${port}`);
      settings.set("openai_api_key", "");
      outcome = await react(() => settings.set("gemini_api_key", "gemini-after-dns"));
      equal("a rotated Gemini key is the uploaded key", hits.length, 1);
      equal("the Gemini request uses the key read after DNS", hits[0].apiKey, "gemini-after-dns");
      equal("a rotated Gemini key still transcribes", outcome.error, null);

      settings.set("ai_stt_provider", "openai");
      settings.set("openai_api_key", "typed-before-dns");
      settings.set("openai_base_url", `http://localhost:${port}/v1`);
      hits.length = 0;
      installLookup(() => settings.set("openai_api_key", "typed-after-dns"));
      let typed = null;
      try {
        typed = await saved.transcribe(audioBytes, "audio/ogg");
      } finally {
        restoreLookup();
      }
      equal("typed !stt still uploads once", hits.length, 1);
      equal(
        "typed !stt keeps the key captured before DNS",
        hits[0].authorization,
        "Bearer typed-before-dns",
      );
      equal("typed !stt still returns the transcript", typed, "sealed transcript");
    } finally {
      restoreLookup();
      if (mocked) stt.transcribe = mocked;
      runtime.setEnabled("stt", true);
      settings.set("ai_stt_enabled", true);
      settings.set("ai_stt_provider", "gemini");
      settings.set("gemini_api_key", "isolated-test-key");
      settings.set("gemini_base_url", "");
      settings.set("openai_api_key", "");
      settings.set("openai_base_url", "");
      if (server) await new Promise((resolve) => server.close(resolve));
    }
  }

  section("rule destination overrides the global route");
  {
    settings.set("reply_route", "same_chat");
    settings.set("reply_route_overrides", JSON.stringify({ commands: { ping: "same_chat" } }));
    const f = await fixture({
      rules: [
        {
          id: "priv",
          definition: commandDefinition("ping", { destination: { mode: "owner_private" } }),
        },
      ],
    });
    store.authWrite("creds", JSON.stringify({ me: { id: bot }, registered: true }));
    receive(f, remember(f), "🏓");
    equal("owner_private delivers", await completed(f), "DELIVERED");
    equal("owner_private uses the linked phone", f.state.sent[0].chat, bot);
    equal("owner_private sends once", f.state.sent.length, 1);

    const kick = await fixture({
      rules: [
        {
          id: "kick",
          definition: commandDefinition("group:kick", {
            emoji: "🫰",
            destination: { mode: "owner_private" },
          }),
        },
      ],
    });
    markAdmins(kick);
    receive(kick, remember(kick), "🫰");
    equal("destructive kick delivers", await completed(kick), "DELIVERED");
    equal("destructive announcement stays in the group", kick.state.sent[0].chat, group);
    equal("destructive kick removes once", kick.state.updates.length, 1);

    store.authRemove("creds");
    const refused = await fixture({
      rules: [
        {
          id: "priv",
          definition: commandDefinition("ping", { destination: { mode: "owner_private" } }),
        },
      ],
    });
    receive(refused, remember(refused), "🏓");
    equal(
      "missing owner route is a delivery refusal",
      await completed(refused),
      "REACTION_DELIVERY_REFUSED",
    );
    equal("delivery refusal sends nothing", refused.state.sent.length, 0);
    equal("delivery refusal does not claim", count("reaction_executions"), 0);
    equal(
      "delivery refusal is recorded on the rule",
      status.get("priv")?.lastCode,
      "REACTION_DELIVERY_REFUSED",
    );
    settings.set("reply_route", "same_chat");
    settings.set("reply_route_overrides", "");
  }

  section("every live command is classified and unsupported commands are rejected");
  {
    const catalog = getCommandCatalog();
    ok("catalog is loaded", catalog.length > 0);
    for (const entry of catalog) {
      ok(`${entry.key} is classified`, classify(entry.key).reason !== "UNCLASSIFIED");
    }
    equal("an unknown key is unclassified", classify("notacommand").reason, "UNCLASSIFIED");
    for (const entry of catalog) {
      const spec = classify(entry.key);
      if (spec.mode !== "unsupported") continue;
      const error = throws(`${entry.key} is rejected`, () =>
        manage.createRule({
          chatJid: group,
          priority: 0,
          definition: {
            version: 2,
            emoji: "🏓",
            transitions: ["add"],
            originalTypes: ["text"],
            senders: { role: "any", ids: [] },
            command: { name: entry.key, args: [] },
            destination: { mode: "same_chat" },
          },
        }),
      );
      if (!error) continue;
      equal(`${entry.key} status`, error.status, 400);
      equal(`${entry.key} code`, error.code, "REACTION_RULE_INVALID");
      ok(
        `${entry.key} reason ${spec.reason}`,
        error.issues.some(
          (issue) => issue.field === "definition.command.name" && issue.code === spec.reason,
        ),
      );
    }

    store.saveReactionRule({
      id: "v1ping",
      chatJid: group,
      priority: 0,
      definition: {
        version: 1,
        emoji: "🏓",
        transitions: ["add"],
        originalTypes: ["text"],
        senders: { role: "any", ids: [] },
        action: "ping",
        destination: { mode: "same_chat" },
      },
    });
    store.saveReactionRule({
      id: "v1stt",
      chatJid: group,
      priority: 0,
      definition: {
        version: 1,
        emoji: "🗿",
        transitions: ["add"],
        originalTypes: ["voice"],
        senders: { role: "any", ids: [] },
        action: "stt",
        destination: { mode: "same_chat" },
      },
    });
    const rawPing = JSON.parse(store.getReactionRule("v1ping").definition);
    equal("stored v1 ping is not rewritten", rawPing.action, "ping");
    const shownPing = manage.overview().rules.find((rule) => rule.id === "v1ping").definition;
    const shownStt = manage.overview().rules.find((rule) => rule.id === "v1stt").definition;
    equal("v1 ping loads as version 2", shownPing.version, 2);
    equal("v1 ping loads as command ping", shownPing.command.name, "ping");
    equal("v1 ping args are empty", shownPing.command.args.length, 0);
    equal("v1 ping drops action", shownPing.action, undefined);
    equal("v1 stt loads as command stt", shownStt.command.name, "stt");
    equal("v1 stt drops action", shownStt.action, undefined);
    equal("stored v1 ping keeps its sender role", rawPing.senders.role, "any");
    equal("stored v1 ping keeps an empty id list", rawPing.senders.ids.length, 0);
    equal(
      "stored v1 ping has no linked-message flag",
      rawPing.allowOthersOnLinkedMessages,
      undefined,
    );
    equal("shown v1 ping closes linked messages", shownPing.allowOthersOnLinkedMessages, false);
    equal("shown v1 ping keeps the sender role", shownPing.senders.role, "any");
    store.saveReactionRule({
      id: "v1owner",
      chatJid: group,
      priority: 0,
      definition: {
        version: 1,
        emoji: "🏓",
        transitions: ["add"],
        originalTypes: ["text"],
        senders: { role: "owner", ids: [reactor] },
        action: "ping",
        destination: { mode: "same_chat" },
      },
    });
    const rawOwner = JSON.parse(store.getReactionRule("v1owner").definition);
    const shownOwner = manage.overview().rules.find((rule) => rule.id === "v1owner").definition;
    equal("stored v1 owner role is kept", rawOwner.senders.role, "owner");
    equal("stored v1 owner id is kept", rawOwner.senders.ids[0], reactor);
    equal("stored v1 owner row has no flag", rawOwner.allowOthersOnLinkedMessages, undefined);
    equal("shown v1 owner role is kept", shownOwner.senders.role, "owner");
    equal("shown v1 owner id is kept", shownOwner.senders.ids[0], reactor);
    equal("shown v1 owner closes linked messages", shownOwner.allowOthersOnLinkedMessages, false);
    equal("schema stays 12", db.prepare("PRAGMA user_version").get().user_version, 12);

    const created = manage.createRule({
      chatJid: group,
      priority: 4,
      definition: {
        version: 2,
        emoji: "🏓",
        originalTypes: [...TYPES],
        senders: { role: "any", ids: [] },
        command: { name: "ping", args: [] },
        destination: { mode: "same_chat" },
      },
    });
    equal("omitted transitions default to add", created.definition.transitions.length, 1);
    equal("omitted transitions use add", created.definition.transitions[0], "add");
    equal("saved rule is version 2", created.definition.version, 2);
    equal("new rules close linked messages", created.definition.allowOthersOnLinkedMessages, false);
    const flaggedV1 = throws("v1 payload cannot carry the linked-message flag", () =>
      manage.createRule({
        chatJid: group,
        priority: 5,
        definition: {
          version: 1,
          emoji: "🏓",
          transitions: ["add"],
          originalTypes: ["text"],
          senders: { role: "owner", ids: [reactor] },
          action: "ping",
          destination: { mode: "same_chat" },
          allowOthersOnLinkedMessages: true,
        },
      }),
    );
    ok(
      "v1 flag is an unknown field",
      flaggedV1?.issues?.some(
        (issue) =>
          issue.field === "definition.allowOthersOnLinkedMessages" &&
          issue.code === "unknown_field",
      ),
    );

    const { default: router } = await import("../src/routes/reactions.api.esm.js");
    const layer = router.stack.find(
      (entry) => entry.route?.path === "/reactions/commands" && entry.route.methods.get,
    );
    ok("commands route exists", Boolean(layer));
    const response = {
      statusCode: 0,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.body = body;
        return this;
      },
    };
    layer.route.stack.at(-1).handle({ query: { lang: "ar" } }, response);
    equal("commands route succeeds", response.body.success, true);
    const arabicPing = response.body.commands.find((command) => command.key === "ping");
    equal("Arabic ping description", arabicPing.description, "يتحقق من أن البوت يستجيب.");
    equal("ping mode is none", arabicPing.mode, "none");
    const arabicKick = response.body.commands.find((command) => command.key === "group:kick");
    equal("kick is destructive", arabicKick.destructive, true);
    const arabicGemini = response.body.commands.find((command) => command.key === "gemini");
    equal("gemini is unsupported", arabicGemini.mode, "unsupported");
    equal("gemini is not in 5.0.1", arabicGemini.reason, "NOT_IN_5_0_1");
    equal("kick transitions are add only", arabicKick.transitions.length, 1);

    for (const locale of ["en", "ar", "pt-BR", "es-419"]) {
      const dashboard = JSON.parse(
        readFileSync(new URL(`../i18n/${locale}/dashboard.json`, import.meta.url), "utf8"),
      );
      ok(
        `${locale} labels denied`,
        typeof dashboard.reactionOutcomeReactionCommandDenied === "string",
      );
      ok(
        `${locale} labels unsupported`,
        typeof dashboard.reactionOutcomeReactionCommandUnsupported === "string",
      );
      ok(
        `${locale} labels failed`,
        typeof dashboard.reactionOutcomeReactionCommandFailed === "string",
      );
    }
  }
} finally {
  ping.execute = saved.ping;
  stt.execute = saved.stt;
  kick.execute = saved.kick;
  media.downloadMedia = saved.download;
  stt.transcribe = saved.transcribe;
  thumbnail.withMediaThumbnail = saved.thumbnail;
  timing.sleep = saved.sleep;
  settings.get = saved.get;
  if (current?.engine) {
    current.engine.close();
    await current.engine.settled();
  }
  finish();
}

// Outgoing retry message cache and getMessage recovery (Phase 07.5 L2: C-3, C-4).
//
// Verifies that:
// - getMessage returns undefined on a miss (never { conversation: "" });
// - outbound sends through socket.js withOutboundSavers cache result.message
//   under (remoteJid, id);
// - lookup is chat-scoped (exact group match; 1:1 LID <-> PN fallback only via
//   lid_mapping);
// - text, media (with thumbnail), quoted/mentions, edit, revoke, reaction and
//   poll messages round-trip unchanged;
// - 1 MiB single-message cap, 8 MiB total byte budget, 500-entry cap, and TTL
//   evict oldest first;
// - clearRecentMessages() and WhatsAppSession unlink clear the cache;
// - message.handler no longer caches incoming notify fromMe messages.

import { registerHooks } from "node:module";
import { proto } from "@whiskeysockets/baileys";
import { equal, finish, ok, require, section, useTempDataDir } from "./harness.mjs";

useTempDataDir("levix-retry-message-cache");

const store = require("./src/db/store.cjs");
const { getBaileysConfig } = await import("../src/config/baileys.config.js");
const recentCache = await import("../src/utils/recentMessageCache.esm.js");
const { getMessageFromRecent } = recentCache;

// Intercept makeWASocket in socket.js so createWhatsAppSocket can also run in
// environments where withOutboundSavers was not yet exported (e.g. baseline commit).
const socketUrl = new URL("../src/core/socket.js", import.meta.url).href;
const slot = Symbol.for("levix-retry-cache-test-socket");
const hook = registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url !== socketUrl) return result;
    const source = String(result.source);
    const needle = 'import { makeWASocket } from "@whiskeysockets/baileys";';
    if (!source.includes(needle)) throw new Error("socket constructor interception failed");
    return {
      ...result,
      source: source.replace(
        needle,
        'const makeWASocket = () => globalThis[Symbol.for("levix-retry-cache-test-socket")];',
      ),
    };
  },
});
const socketModule = await import("../src/core/socket.js");
hook.deregister();

const { handleIncomingMessage } = await import("../src/handlers/message.handler.js");
const { WhatsAppSession } = await import("../src/core/session.js");

const GROUP_A = "120363000000000001@g.us";
const GROUP_B = "120363000000000002@g.us";
const USER_PN = "201333333333@s.whatsapp.net";
const USER_LID = "333@lid";
const OTHER_PN = "201222222222@s.whatsapp.net";
const OTHER_LID = "222@lid";

let seq = 0;

function buildProtoMessage(content, options = {}) {
  if (content?.protoMessage) {
    return proto.Message.fromObject(content.protoMessage);
  }
  if (content?.delete) {
    return proto.Message.fromObject({
      protocolMessage: {
        key: content.delete,
        type: proto.Message.ProtocolMessage.Type.REVOKE,
      },
    });
  }
  if (content?.edit) {
    return proto.Message.fromObject({
      protocolMessage: {
        key: content.edit,
        type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT,
        editedMessage: { conversation: content.text || "" },
        timestampMs: 1_700_000_000_000,
      },
    });
  }
  if (content?.react) {
    return proto.Message.fromObject({
      reactionMessage: {
        key: content.react.key,
        text: content.react.text,
        senderTimestampMs: content.react.senderTimestampMs || 1_700_000_000_000,
      },
    });
  }
  if (content?.poll) {
    return proto.Message.fromObject({
      pollCreationMessageV3: {
        name: content.poll.name,
        options: (content.poll.values || []).map((optionName) => ({ optionName })),
        selectableOptionsCount: content.poll.selectableCount ?? 1,
      },
      messageContextInfo: {
        messageSecret: content.poll.messageSecret || new Uint8Array(32).fill(9),
      },
    });
  }
  if (content?.image) {
    return proto.Message.fromObject({
      imageMessage: {
        url: "https://mmg.whatsapp.net/v/t62.7118-24/fake-image",
        directPath: "/v/t62.7118-24/fake-image",
        mediaKey: new Uint8Array(32).fill(3),
        mimetype: content.mimetype || "image/jpeg",
        caption: content.caption || "",
        jpegThumbnail: content.jpegThumbnail || new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      },
    });
  }
  const hasContext = Boolean(options?.quoted || content?.mentions?.length);
  if (hasContext) {
    const contextInfo = {};
    if (options?.quoted?.key) {
      contextInfo.stanzaId = options.quoted.key.id;
      contextInfo.participant = options.quoted.key.participant || options.quoted.key.remoteJid;
      contextInfo.quotedMessage = options.quoted.message || { conversation: "" };
    }
    if (content?.mentions?.length) {
      contextInfo.mentionedJid = content.mentions;
    }
    return proto.Message.fromObject({
      extendedTextMessage: {
        text: content?.text || "",
        contextInfo,
      },
    });
  }
  return proto.Message.fromObject({
    conversation: String(content?.text ?? ""),
  });
}

async function makeWrappedSocket() {
  const relayed = [];
  const raw = {
    relayed,
    async sendMessage(jid, content, options = {}) {
      if (content && Object.hasOwn(content, "rawResult")) {
        return content.rawResult;
      }
      const id = options.messageId || `3EB0${String(++seq).padStart(6, "0")}`;
      const message = buildProtoMessage(content, options);
      const fullMsg = proto.WebMessageInfo.fromObject({
        key: {
          remoteJid: jid,
          fromMe: true,
          id,
        },
        message,
        messageTimestamp: 1_700_000_000,
        status: proto.WebMessageInfo.Status.PENDING,
      });
      relayed.push({ jid, content, options, fullMsg });
      return fullMsg;
    },
  };
  if (typeof socketModule.withOutboundSavers === "function") {
    return socketModule.withOutboundSavers(raw);
  }
  globalThis[slot] = raw;
  return (await socketModule.createWhatsAppSocket()).sock;
}

const config = getBaileysConfig(() => undefined);
const sock = await makeWrappedSocket();

section("getMessage returns undefined on a miss (never an empty conversation)");
{
  recentCache.clearRecentMessages?.();
  const groupMiss = await config.getMessage({ remoteJid: GROUP_A, id: "nonexistent-group-msg" });
  equal("group cache miss returns undefined", groupMiss, undefined);

  const dmMiss = await config.getMessage({ remoteJid: USER_PN, id: "nonexistent-dm-msg" });
  equal("1:1 cache miss returns undefined", dmMiss, undefined);

  equal(
    "missing id returns undefined",
    await getMessageFromRecent({ remoteJid: GROUP_A }),
    undefined,
  );
  equal(
    "missing remoteJid returns undefined",
    await getMessageFromRecent({ id: "only-id" }),
    undefined,
  );
}

section("send through withOutboundSavers caches result.message for getMessage");
{
  recentCache.clearRecentMessages?.();
  equal(
    "withOutboundSavers is exported by src/core/socket.js",
    typeof socketModule.withOutboundSavers,
    "function",
  );

  const sent = await sock.sendMessage(
    GROUP_A,
    { text: "hello group retry" },
    { messageId: "send-wrapper-1" },
  );
  equal("wrapper returns WAMessage key.id unchanged", sent?.key?.id, "send-wrapper-1");
  equal("wrapper returns WAMessage key.remoteJid unchanged", sent?.key?.remoteJid, GROUP_A);

  const recovered = await config.getMessage({ remoteJid: GROUP_A, id: "send-wrapper-1" });
  equal("getMessage returns the exact relayed proto.IMessage", recovered, sent.message);
  equal("recovered text matches sent message", recovered?.conversation, "hello group retry");

  // Non-message return values (e.g. disappearingMessagesInChat toggle) pass through safely.
  const emptyResult = await sock.sendMessage(GROUP_A, { rawResult: undefined });
  equal("undefined send result passes through unchanged", emptyResult, undefined);

  // Caching errors never throw from sendMessage or rememberMessage.
  const badMessage = {
    rawResult: {
      key: { remoteJid: GROUP_A, id: "bad-encode-1" },
      message: {
        get conversation() {
          throw new Error("encode boom");
        },
      },
    },
  };
  const badResult = await sock.sendMessage(GROUP_A, badMessage);
  equal(
    "sendMessage returns result even when message encoding throws",
    badResult,
    badMessage.rawResult,
  );
  equal(
    "rememberMessage never throws on invalid input",
    recentCache.rememberMessage(null, null),
    false,
  );
}

section("chat-scoped lookup: same id in a different chat returns undefined; group matches exactly");
{
  recentCache.clearRecentMessages?.();
  const sentA = await sock.sendMessage(
    GROUP_A,
    { text: "secret to group A" },
    { messageId: "shared-id-1" },
  );

  equal(
    "same group and id returns the cached message",
    await config.getMessage({ remoteJid: GROUP_A, id: "shared-id-1" }),
    sentA.message,
  );
  equal(
    "different group with the same id returns undefined",
    await config.getMessage({ remoteJid: GROUP_B, id: "shared-id-1" }),
    undefined,
  );
  equal(
    "getMessageFromRecent for different group returns undefined",
    await getMessageFromRecent({ remoteJid: GROUP_B, id: "shared-id-1" }),
    undefined,
  );
  equal(
    "1:1 chat with the same id returns undefined",
    await config.getMessage({ remoteJid: USER_PN, id: "shared-id-1" }),
    undefined,
  );
  equal(
    "group JID with a device suffix returns undefined",
    await config.getMessage({ remoteJid: "120363000000000001:3@g.us", id: "shared-id-1" }),
    undefined,
  );
}

section("1:1 retry with device-suffixed LID remoteJid resolves via lid_mapping only when known");
{
  recentCache.clearRecentMessages?.();
  store.clearLidMappings();

  const dmSent = await sock.sendMessage(
    USER_PN,
    { text: "direct message to PN" },
    { messageId: "dm-retry-1" },
  );

  equal(
    "exact PN remoteJid finds the 1:1 message",
    await config.getMessage({ remoteJid: USER_PN, id: "dm-retry-1" }),
    dmSent.message,
  );
  equal(
    "device-suffixed PN remoteJid finds the 1:1 message",
    await config.getMessage({ remoteJid: "201333333333:9@s.whatsapp.net", id: "dm-retry-1" }),
    dmSent.message,
  );
  equal(
    "device-suffixed LID misses when lid_mapping is unknown",
    await config.getMessage({ remoteJid: "333:14@lid", id: "dm-retry-1" }),
    undefined,
  );
  equal(
    "unmapped LID with same digits as PN still misses",
    await config.getMessage({ remoteJid: "201333333333:14@lid", id: "dm-retry-1" }),
    undefined,
  );

  // Seed Levix's lid_mapping table in the temp DB.
  store.storeLidPnMapping(USER_LID, USER_PN);
  store.storeLidPnMapping(OTHER_LID, OTHER_PN);

  equal(
    "device-suffixed LID finds message sent to PN once lid_mapping is seeded",
    await config.getMessage({ remoteJid: "333:14@lid", id: "dm-retry-1" }),
    dmSent.message,
  );
  equal(
    "bare LID also finds message sent to PN",
    await config.getMessage({ remoteJid: USER_LID, id: "dm-retry-1" }),
    dmSent.message,
  );
  equal(
    "different mapped user's device-suffixed LID returns undefined",
    await config.getMessage({ remoteJid: "222:4@lid", id: "dm-retry-1" }),
    undefined,
  );

  // Reverse direction: sent to LID, retried from device-suffixed PN.
  const lidSent = await sock.sendMessage(
    USER_LID,
    { text: "direct message to LID" },
    { messageId: "dm-retry-2" },
  );
  equal(
    "device-suffixed PN finds message sent to LID when lid_mapping is known",
    await config.getMessage({ remoteJid: "201333333333:7@s.whatsapp.net", id: "dm-retry-2" }),
    lidSent.message,
  );
}

section("text, quoted/mentions, image with thumbnail, edit, revoke, reaction and poll round-trip");
{
  recentCache.clearRecentMessages?.();
  const thumbBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);
  const pollSecret = new Uint8Array(32).fill(0x5a);

  const cases = [
    {
      label: "plain text",
      id: "kind-text",
      content: { text: "plain text payload" },
      check: (msg) => msg?.conversation === "plain text payload",
    },
    {
      label: "quoted text with mentions",
      id: "kind-quoted-mention",
      content: { text: "reply @333", mentions: [USER_LID] },
      options: {
        quoted: {
          key: { remoteJid: GROUP_A, id: "quoted-in-1", participant: USER_LID },
          message: { conversation: "original question" },
        },
      },
      check: (msg) =>
        msg?.extendedTextMessage?.text === "reply @333" &&
        msg?.extendedTextMessage?.contextInfo?.stanzaId === "quoted-in-1" &&
        msg?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] === USER_LID,
    },
    {
      label: "image with jpegThumbnail",
      id: "kind-image",
      content: {
        image: Buffer.from("fake-jpeg"),
        caption: "image caption",
        jpegThumbnail: thumbBytes,
      },
      check: (msg) =>
        msg?.imageMessage?.caption === "image caption" &&
        Buffer.compare(
          Buffer.from(msg?.imageMessage?.jpegThumbnail || []),
          Buffer.from(thumbBytes),
        ) === 0,
    },
    {
      label: "protocolMessage edit",
      id: "kind-edit",
      content: {
        edit: { remoteJid: GROUP_A, fromMe: true, id: "kind-text" },
        text: "edited text payload",
      },
      check: (msg) =>
        msg?.protocolMessage?.type === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT &&
        msg?.protocolMessage?.key?.id === "kind-text" &&
        msg?.protocolMessage?.editedMessage?.conversation === "edited text payload",
    },
    {
      label: "protocolMessage revoke",
      id: "kind-revoke",
      content: {
        delete: {
          remoteJid: GROUP_A,
          fromMe: false,
          id: "offending-msg-1",
          participant: USER_LID,
        },
      },
      check: (msg) =>
        msg?.protocolMessage?.type === proto.Message.ProtocolMessage.Type.REVOKE &&
        msg?.protocolMessage?.key?.id === "offending-msg-1",
    },
    {
      label: "reactionMessage",
      id: "kind-reaction",
      content: {
        react: {
          key: { remoteJid: GROUP_A, fromMe: false, id: "target-msg-1", participant: USER_LID },
          text: "👍",
          senderTimestampMs: 1_700_000_005_000,
        },
      },
      check: (msg) =>
        msg?.reactionMessage?.text === "👍" && msg?.reactionMessage?.key?.id === "target-msg-1",
    },
    {
      label: "pollCreationMessageV3",
      id: "kind-poll",
      content: {
        poll: {
          name: "Best time?",
          values: ["Morning", "Evening"],
          selectableCount: 1,
          messageSecret: pollSecret,
        },
      },
      check: (msg) =>
        msg?.pollCreationMessageV3?.name === "Best time?" &&
        msg?.pollCreationMessageV3?.options?.length === 2 &&
        Buffer.compare(
          Buffer.from(msg?.messageContextInfo?.messageSecret || []),
          Buffer.from(pollSecret),
        ) === 0,
    },
  ];

  for (const item of cases) {
    const sent = await sock.sendMessage(GROUP_A, item.content, {
      ...(item.options || {}),
      messageId: item.id,
    });
    const got = await config.getMessage({ remoteJid: GROUP_A, id: item.id });
    equal(`${item.label}: returns exact message reference`, got, sent.message);
    ok(`${item.label}: payload fields preserved`, Boolean(got && item.check(got)));
    const expectedBytes = Buffer.from(proto.Message.encode(sent.message).finish());
    const actualBytes = Buffer.from(proto.Message.encode(got || {}).finish());
    equal(
      `${item.label}: protobuf encoding round-trips identically`,
      Buffer.compare(actualBytes, expectedBytes),
      0,
    );
  }
}

section("bounds: 1 MiB single-message limit, 8 MiB byte budget, 500-entry cap, and TTL expiry");
{
  recentCache.clearRecentMessages?.();

  // 1. Single message above 1 MiB is skipped without evicting existing entries.
  const seed = await sock.sendMessage(
    GROUP_A,
    { text: "survives oversize skip" },
    { messageId: "before-oversize" },
  );
  const oversizeThumb = new Uint8Array(1024 * 1024 + 256);
  const oversizeSent = await sock.sendMessage(
    GROUP_A,
    { image: Buffer.from("x"), jpegThumbnail: oversizeThumb },
    { messageId: "oversize-msg" },
  );
  ok(
    "oversize fixture exceeds 1 MiB when encoded",
    proto.Message.encode(oversizeSent.message).finish().length > 1024 * 1024,
  );
  equal(
    "oversize message is skipped",
    await config.getMessage({ remoteJid: GROUP_A, id: "oversize-msg" }),
    undefined,
  );
  equal(
    "existing message remains cached when oversize message is skipped",
    await config.getMessage({ remoteJid: GROUP_A, id: "before-oversize" }),
    seed.message,
  );

  // 2. 8 MiB total byte budget evicts oldest first.
  recentCache.clearRecentMessages?.();
  const chunk950k = new Uint8Array(950 * 1024);
  for (let i = 1; i <= 9; i += 1) {
    await sock.sendMessage(
      GROUP_A,
      { image: Buffer.from("x"), jpegThumbnail: chunk950k },
      { messageId: `byte-budget-${i}` },
    );
  }
  // 9 * ~950 KiB = ~8.55 MiB > 8 MiB, so byte-budget-1 (oldest) must be evicted
  // while byte-budget-2 .. byte-budget-9 (8 * ~950 KiB = ~7.6 MiB <= 8 MiB) stay.
  equal(
    "8 MiB byte budget evicts oldest entry first",
    await config.getMessage({ remoteJid: GROUP_A, id: "byte-budget-1" }),
    undefined,
  );
  ok(
    "second-oldest entry within 8 MiB budget remains",
    Boolean(await config.getMessage({ remoteJid: GROUP_A, id: "byte-budget-2" })),
  );
  ok(
    "newest entry within 8 MiB budget remains",
    Boolean(await config.getMessage({ remoteJid: GROUP_A, id: "byte-budget-9" })),
  );

  // 3. 500-entry cap evicts oldest first.
  recentCache.clearRecentMessages?.();
  for (let i = 1; i <= 505; i += 1) {
    await sock.sendMessage(GROUP_A, { text: `msg-${i}` }, { messageId: `cap-${i}` });
  }
  equal(
    "500-entry cap evicts entry 1",
    await config.getMessage({ remoteJid: GROUP_A, id: "cap-1" }),
    undefined,
  );
  equal(
    "500-entry cap evicts entry 5",
    await config.getMessage({ remoteJid: GROUP_A, id: "cap-5" }),
    undefined,
  );
  equal(
    "entry 6 (500th newest) is retained",
    (await config.getMessage({ remoteJid: GROUP_A, id: "cap-6" }))?.conversation,
    "msg-6",
  );
  equal(
    "entry 505 (newest) is retained",
    (await config.getMessage({ remoteJid: GROUP_A, id: "cap-505" }))?.conversation,
    "msg-505",
  );

  // 4. TTL expiry evicts expired entries.
  recentCache.clearRecentMessages?.();
  recentCache.configureRecentCache({ ttlMs: 40 });
  try {
    const ttlSent = await sock.sendMessage(
      GROUP_A,
      { text: "short-lived" },
      { messageId: "ttl-msg-1" },
    );
    equal(
      "message is available before TTL expires",
      await config.getMessage({ remoteJid: GROUP_A, id: "ttl-msg-1" }),
      ttlSent.message,
    );
    await new Promise((resolve) => setTimeout(resolve, 65));
    equal(
      "message is evicted after TTL expires",
      await config.getMessage({ remoteJid: GROUP_A, id: "ttl-msg-1" }),
      undefined,
    );
  } finally {
    recentCache.configureRecentCache({ ttlMs: 60 * 60 * 1000 });
  }
}

section("clearRecentMessages() and WhatsAppSession unlink clear the cache");
{
  recentCache.clearRecentMessages?.();
  equal("clearRecentMessages is exported", typeof recentCache.clearRecentMessages, "function");

  const sent1 = await sock.sendMessage(
    GROUP_A,
    { text: "before manual clear" },
    { messageId: "clear-1" },
  );
  equal(
    "cached before clearRecentMessages()",
    await config.getMessage({ remoteJid: GROUP_A, id: "clear-1" }),
    sent1.message,
  );
  recentCache.clearRecentMessages?.();
  equal(
    "empty after clearRecentMessages()",
    await config.getMessage({ remoteJid: GROUP_A, id: "clear-1" }),
    undefined,
  );

  const sent2 = await sock.sendMessage(
    GROUP_A,
    { text: "before session unlink" },
    { messageId: "unlink-clear-1" },
  );
  equal(
    "cached before session.logout()",
    await config.getMessage({ remoteJid: GROUP_A, id: "unlink-clear-1" }),
    sent2.message,
  );
  const session = new WhatsAppSession({
    clearCredentials: async () => store.authClearAll(),
    isLinked: () => false,
    log: { info() {}, warn() {}, error() {}, debug() {} },
  });
  await session.logout();
  equal(
    "session.logout() clears recent messages via clearAccountScopedState",
    await config.getMessage({ remoteJid: GROUP_A, id: "unlink-clear-1" }),
    undefined,
  );
}

section("message.handler no longer stores incoming notify fromMe messages");
{
  recentCache.clearRecentMessages?.();
  await handleIncomingMessage(sock, {
    type: "notify",
    messages: [
      {
        key: {
          remoteJid: GROUP_A,
          id: "primary-phone-notify-1",
          fromMe: true,
        },
        message: { conversation: "typed on primary phone" },
      },
    ],
  });

  equal(
    "getMessageFromRecent does not hold notify fromMe message",
    await getMessageFromRecent({ remoteJid: GROUP_A, id: "primary-phone-notify-1" }),
    undefined,
  );
  equal(
    "getMessage does not return notify fromMe message",
    await config.getMessage({ remoteJid: GROUP_A, id: "primary-phone-notify-1" }),
    undefined,
  );
}

section("in-flight send resolving after clearRecentMessages or session.logout is not cached");
{
  recentCache.clearRecentMessages?.();
  const epochBefore = recentCache.getRecentCacheEpoch?.();
  equal("getRecentCacheEpoch returns a number", typeof epochBefore, "number");

  let resolveSlowSend;
  let notifyEnteredOriginal;
  let enteredOriginal = new Promise((resolve) => {
    notifyEnteredOriginal = resolve;
  });
  const slowRaw = {
    user: { id: "15550001111:1@s.whatsapp.net", lid: "100000000000001:1@lid" },
    sendMessage: async (jid, content, options = {}) => {
      const id = options.messageId || `slow-${++seq}`;
      const message = buildProtoMessage(content, options);
      if (options.slow) {
        notifyEnteredOriginal?.();
        await new Promise((resolve) => {
          resolveSlowSend = resolve;
        });
      }
      return proto.WebMessageInfo.fromObject({
        key: { remoteJid: jid, fromMe: true, id },
        message,
        messageTimestamp: 1_700_000_000,
        status: proto.WebMessageInfo.Status.PENDING,
      });
    },
  };
  const slowSock = socketModule.withOutboundSavers(slowRaw);

  // 1. Send starts before clearRecentMessages(), resolves after.
  const pendingSend = slowSock.sendMessage(
    GROUP_A,
    { text: "in-flight before clear" },
    { messageId: "inflight-clear-1", slow: true },
  );
  await enteredOriginal;
  ok("slow send is waiting in original()", typeof resolveSlowSend === "function");

  recentCache.clearRecentMessages();
  const epochAfter = recentCache.getRecentCacheEpoch?.();
  equal("clearRecentMessages bumps account epoch", epochAfter, epochBefore + 1);

  resolveSlowSend();
  const lateResult = await pendingSend;
  equal("late send still returns its WAMessage to caller", lateResult?.key?.id, "inflight-clear-1");
  equal(
    "late send resolving after clearRecentMessages is not cached",
    await config.getMessage({ remoteJid: GROUP_A, id: "inflight-clear-1" }),
    undefined,
  );

  // 2. Send starts before session.logout(), resolves after unlink.
  resolveSlowSend = null;
  enteredOriginal = new Promise((resolve) => {
    notifyEnteredOriginal = resolve;
  });
  const pendingUnlinkSend = slowSock.sendMessage(
    GROUP_A,
    { text: "in-flight before logout" },
    { messageId: "inflight-unlink-1", slow: true },
  );
  await enteredOriginal;
  ok("second slow send is waiting in original()", typeof resolveSlowSend === "function");

  const session = new WhatsAppSession({
    clearCredentials: async () => store.authClearAll(),
    isLinked: () => false,
    log: { info() {}, warn() {}, error() {}, debug() {} },
  });
  await session.logout();

  resolveSlowSend();
  await pendingUnlinkSend;
  equal(
    "late send resolving after session.logout() is not cached",
    await config.getMessage({ remoteJid: GROUP_A, id: "inflight-unlink-1" }),
    undefined,
  );

  // 3. A new send started in the new epoch caches normally.
  const freshSent = await slowSock.sendMessage(
    GROUP_A,
    { text: "fresh epoch send" },
    { messageId: "fresh-epoch-1" },
  );
  equal(
    "send started after clearRecentMessages is cached in the new epoch",
    await config.getMessage({ remoteJid: GROUP_A, id: "fresh-epoch-1" }),
    freshSent.message,
  );
}

finish();

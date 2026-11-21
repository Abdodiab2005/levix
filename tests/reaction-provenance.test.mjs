// Outbound ids are recorded before send. Linked intake trusts only inbound notify.
import { equal, finish, ok, require, section, useTempDataDir } from "./harness.mjs";

const data = useTempDataDir("levix-reaction-provenance");
const store = require("./src/db/store.cjs");
const { db } = require("./src/db/db.cjs");
const thumbnail = require("./src/utils/thumbnail.cjs");
thumbnail.withMediaThumbnail = async (content) => content;
const { timing, sendBotMessage } = await import("../src/utils/sendBotMessage.esm.js");
timing.sleep = async () => {};
const { withOutboundSavers } = await import("../src/core/socket.js");
const {
  clearOutboundIds,
  clearRecentMessages,
  configureOutboundIds,
  configureRecentCache,
  getMessageFromRecent,
  isOutboundId,
  outboundIdsSaturated,
  rememberMessage,
  rememberOutboundId,
} = await import("../src/utils/recentMessageCache.esm.js");
const { createReactionIntake } = await import("../src/automation/reactions.js");

const group = "120363700000001@g.us";
const dm = "201070000050@s.whatsapp.net";
const author = "201070000001@s.whatsapp.net";
const bot = "201070000099@s.whatsapp.net";
const idShape = /^3EB0[0-9A-F]{18}$/;
let clock = 1_800_000_000_000;
let sequence = 0;
let mode = "ok";
let seen = null;
let sends = 0;
let release = () => {};
let held = Promise.resolve();
let recordedDuringHold = false;

function enable(chat) {
  const id = `rule-${chat.split("@")[0]}`;
  store.saveReactionRule({
    id,
    chatJid: chat,
    priority: 0,
    definition: {
      version: 1,
      emoji: "😀",
      transitions: ["add", "change", "remove"],
      originalTypes: ["text", "voice", "audio", "image", "video", "document", "sticker"],
      senders: { role: "any", ids: [] },
      action: "ping",
      destination: { mode: "same_chat" },
    },
  });
  store.setReactionRuleEnabled(id, true, 1);
}

const raw = {
  user: { id: bot },
  async sendPresenceUpdate() {},
  async sendMessage(_jid, content, options) {
    sends += 1;
    seen = options?.messageId;
    if (mode === "hold") {
      recordedDuringHold = isOutboundId(options.messageId);
      await held;
    }
    if (mode === "throw") throw new Error("relay failed");
    return {
      key: { remoteJid: _jid, id: options.messageId, fromMe: true },
      message: content,
    };
  },
};
const sock = withOutboundSavers(raw);

async function rejects(label, fn) {
  try {
    await fn();
    ok(label, false, "expected it to throw");
    return null;
  } catch (error) {
    ok(label, true);
    return error;
  }
}
async function flush() {
  for (let i = 0; i < 20 && !recordedDuringHold; i += 1) {
    await new Promise((done) => setImmediate(done));
  }
}
function hold() {
  recordedDuringHold = false;
  held = new Promise((done) => {
    release = done;
  });
  mode = "hold";
}
function text(id, extra = {}) {
  return {
    key: {
      remoteJid: group,
      id,
      fromMe: true,
      participant: bot,
      ...extra.key,
    },
    messageTimestamp: extra.messageTimestamp ?? Math.floor(clock / 1000),
    message: extra.message || { conversation: "linked" },
  };
}

db.exec(
  "DELETE FROM reaction_rules; DELETE FROM reaction_events; DELETE FROM reaction_state; DELETE FROM reaction_invalidations;",
);
clearRecentMessages();
enable(group);
enable(dm);

try {
  section("both send paths record the id before the send resolves");
  {
    hold();
    const pending = sock.sendMessage(group, { text: "raw" });
    await flush();
    equal("raw send recorded the id before resolve", recordedDuringHold, true);
    ok("raw send uses a Baileys id", idShape.test(seen));
    release();
    const sent = await pending;
    equal("raw send keeps that id", sent.key.id, seen);
    equal("raw send id stays recorded", isOutboundId(seen), true);

    hold();
    const helper = sendBotMessage(sock, group, { text: "helper" }, { typing: false, delayMs: 0 });
    await flush();
    equal("helper recorded the id before resolve", recordedDuringHold, true);
    ok("helper uses a Baileys id", idShape.test(seen));
    const helperId = seen;
    release();
    await helper;
    equal("helper id stays recorded", isOutboundId(helperId), true);

    mode = "ok";
    await sock.sendMessage(group, { text: "caller" }, { messageId: "CALLERID1" });
    equal("caller id is kept", seen, "CALLERID1");
    equal("caller id is recorded", isOutboundId("CALLERID1"), true);
  }

  section("a refused guard or an abort records nothing; a failed relay keeps the id");
  {
    sends = 0;
    await rejects("guard refusal throws", () =>
      sock.sendMessage(group, { text: "no" }, {
        messageId: "GUARD1",
        deliveryGuard: {
          async refresh() {},
          assert() {
            throw new Error("refused");
          },
        },
      }),
    );
    equal("guard refusal does not send", sends, 0);
    equal("guard refusal records no id", isOutboundId("GUARD1"), false);

    const aborted = new AbortController();
    aborted.abort();
    await rejects("abort throws", () =>
      sock.sendMessage(group, { text: "no" }, { messageId: "ABORT1", signal: aborted.signal }),
    );
    equal("abort records no id", isOutboundId("ABORT1"), false);

    mode = "throw";
    await rejects("relay failure throws", () => sock.sendMessage(group, { text: "no" }));
    equal("relay failure keeps the id", isOutboundId(seen), true);
    mode = "ok";
  }

  section("outbound ids stay while they can matter and fail closed when full");
  {
    clearOutboundIds();
    configureOutboundIds({ maxItems: 2, ttlMs: 1000 });
    const now = 5_000_000;
    rememberOutboundId("old", now);
    rememberOutboundId("mid", now);
    equal("a full id store rejects another young id", rememberOutboundId("new", now), false);
    equal("oldest young id is retained", isOutboundId("old", now), true);
    equal("saturation fails closed", outboundIdsSaturated(now), true);
    clearOutboundIds();
    configureOutboundIds({ maxItems: 10, ttlMs: 1000 });
    rememberOutboundId("ttl", now);
    equal("id is live before the ttl", isOutboundId("ttl", now + 999), true);
    equal("id expires at the ttl", isOutboundId("ttl", now + 1000), false);
    equal("an id expiry does not saturate the store", outboundIdsSaturated(now + 1000), false);
    configureOutboundIds({ maxItems: 100_000, ttlMs: 60 * 60 * 1000 });
    clearOutboundIds();
    rememberOutboundId("gone");
    clearRecentMessages();
    equal("clearing the content cache clears outbound ids", isOutboundId("gone"), false);
  }

  section("evicted content keeps its outbound id and rejects the notify echo");
  {
    clearOutboundIds();
    configureRecentCache({ maxItems: 1 });
    const kept = text(`kept-${++sequence}`);
    rememberOutboundId(kept.key.id);
    rememberMessage(kept.key, kept.message);
    rememberMessage(text(`other-${++sequence}`).key, { conversation: "other" });
    equal("content cache dropped the body", await getMessageFromRecent(kept.key), undefined);
    equal("outbound id survived the content eviction", isOutboundId(kept.key.id), true);
    const intake = createReactionIntake({ user: { id: bot } }, { now: () => clock });
    intake.open();
    clock += 2000;
    kept.messageTimestamp = Math.floor(clock / 1000);
    intake.observeUpsert({ type: "notify", messages: [kept] });
    equal("retained outbound id is not an original", intake.stats().items, 0);
    intake.close();
    configureRecentCache({ maxItems: 500, maxBytes: 8 * 1024 * 1024 });
    clearOutboundIds();
  }

  section("linked originals need inbound notify provenance");
  {
    const intake = createReactionIntake({ user: { id: bot } }, { now: () => clock });
    intake.open();
    clock += 2000;
    const append = text(`append-${++sequence}`);
    intake.observeUpsert({ type: "append", messages: [append] });
    equal("append is not an original", intake.stats().items, 0);
    const other = text(`other-${++sequence}`, {
      key: { remoteJid: group, fromMe: false, participant: author },
    });
    intake.observeUpsert({ type: "append", messages: [other] });
    equal("someone else's append is not an original", intake.stats().items, 0);

    const forged = text(`forged-${++sequence}`, {
      key: { remoteJid: group, fromMe: false, participant: bot },
    });
    intake.observeUpsert({ type: "notify", messages: [forged] });
    equal("fromMe false naming the linked account is rejected", intake.stats().items, 0);

    const cached = text(`cached-${++sequence}`);
    rememberMessage(cached.key, { conversation: "cache-only" });
    intake.observeUpsert({ type: "notify", messages: [cached] });
    equal("content cache alone does not reject a linked notify", intake.stats().items, 1);

    const outbound = text(`out-${++sequence}`);
    rememberOutboundId(outbound.key.id);
    intake.observeUpsert({ type: "notify", messages: [outbound] });
    equal("an outbound id is not an original", intake.stats().items, 1);

    const ambiguous = {
      key: { remoteJid: dm, id: `amb-${++sequence}`, fromMe: false, remoteJidAlt: "not-a-jid" },
      messageTimestamp: Math.floor(clock / 1000),
      message: { conversation: "dm" },
    };
    intake.observeUpsert({ type: "notify", messages: [ambiguous] });
    equal("unresolved DM alt is rejected", intake.stats().items, 1);
    const paired = {
      key: {
        remoteJid: dm,
        id: `lid-${++sequence}`,
        fromMe: false,
        remoteJidAlt: "201070009999@lid",
      },
      messageTimestamp: Math.floor(clock / 1000),
      message: { conversation: "dm" },
    };
    intake.observeUpsert({ type: "notify", messages: [paired] });
    equal("a phone and lid pair is retained", intake.stats().items, 2);

    const original = text(`peer-${++sequence}`, {
      key: { remoteJid: group, fromMe: false, participant: author },
    });
    intake.observeUpsert({ type: "notify", messages: [original] });
    clock += 1;
    const reactionKey = {
      remoteJid: group,
      id: `reaction-${++sequence}`,
      fromMe: true,
      participant: bot,
    };
    const reaction = {
      key: original.key,
      reaction: { text: "😀", senderTimestampMs: clock, key: reactionKey },
    };
    intake.observeUpsert({
      type: "append",
      messages: [
        {
          key: reactionKey,
          messageTimestamp: Math.floor(clock / 1000),
          message: { reactionMessage: { text: "😀", key: original.key } },
        },
      ],
    });
    equal("append echo reaction is ignored", intake.observeReactions([reaction]).length, 0);
    const notified = {
      ...reaction,
      reaction: {
        ...reaction.reaction,
        key: { ...reactionKey, id: `reaction-${++sequence}` },
        senderTimestampMs: (clock += 1),
      },
    };
    rememberOutboundId(notified.reaction.key.id);
    intake.observeUpsert({
      type: "notify",
      messages: [
        {
          key: notified.reaction.key,
          messageTimestamp: Math.floor(clock / 1000),
          message: { reactionMessage: { text: "😀", key: original.key } },
        },
      ],
    });
    equal("outbound notify reaction is ignored", intake.observeReactions([notified]).length, 0);
    const live = {
      ...reaction,
      reaction: {
        ...reaction.reaction,
        key: { ...reactionKey, id: `reaction-${++sequence}` },
        senderTimestampMs: (clock += 1),
      },
    };
    intake.observeUpsert({
      type: "notify",
      messages: [
        {
          key: live.reaction.key,
          messageTimestamp: Math.floor(clock / 1000),
          message: { reactionMessage: { text: "😀", key: original.key } },
        },
      ],
    });
    equal("inbound notify reaction is accepted", intake.observeReactions([live]).length, 1);

    const foldedId = `folded-${++sequence}`;
    const folded = text(`folded-original-${++sequence}`, {
      key: { remoteJid: group, fromMe: false, participant: author },
    });
    clock += 1;
    const foldedResult = intake.observeUpsert({
      type: "notify",
      messages: [
        {
          ...folded,
          reactions: [
            {
              text: "😀",
              senderTimestampMs: clock,
              key: { remoteJid: group, id: foldedId, fromMe: true, participant: bot },
            },
          ],
        },
      ],
    });
    equal("folded reaction without its own notify is rejected", foldedResult.length, 0);

    const lidOnly = "201070000051@lid";
    enable(lidOnly);
    const lidBefore = intake.stats().items;
    intake.observeUpsert({
      type: "notify",
      messages: [
        {
          key: { remoteJid: lidOnly, id: `lid-dm-${++sequence}`, fromMe: false },
          messageTimestamp: Math.floor(clock / 1000),
          message: { conversation: "no-pn" },
        },
      ],
    });
    equal("LID DM without identity evidence is rejected", intake.stats().items, lidBefore);
    intake.close();
  }

  section("a restart replay older than socket open is rejected");
  {
    clearOutboundIds();
    clock = 1_800_000_000_000;
    const replay = createReactionIntake({ user: { id: bot } }, { now: () => clock });
    replay.open();
    const stale = text("replayed", { messageTimestamp: Math.floor((clock - 5000) / 1000) });
    replay.observeUpsert({ type: "notify", messages: [stale] });
    equal("replay older than open is rejected", replay.stats().items, 0);
    clock += 2000;
    const after = text("after-open", {
      key: { remoteJid: group, fromMe: false, participant: author },
    });
    replay.observeUpsert({ type: "notify", messages: [after] });
    equal("a notify after open is retained", replay.stats().items, 1);
    const lateId = `late-${++sequence}`;
    const openedAt = 1_800_000_000_000;
    replay.observeUpsert({
      type: "notify",
      messages: [
        {
          key: { remoteJid: group, id: lateId, fromMe: true, participant: bot },
          messageTimestamp: Math.floor(clock / 1000),
          message: { reactionMessage: { text: "😀", key: after.key } },
        },
      ],
    });
    equal(
      "delayed reaction envelope after restart is rejected",
      replay.observeReactions([
        {
          key: after.key,
          reaction: {
            text: "😀",
            senderTimestampMs: openedAt - 1000,
            key: { remoteJid: group, id: lateId, fromMe: true, participant: bot },
          },
        },
      ]).length,
      0,
    );
    replay.close();
  }

  section("a saturated id store rejects a linked reaction");
  {
    clearOutboundIds();
    configureOutboundIds({ maxItems: 1, ttlMs: 60 * 60 * 1000 });
    rememberOutboundId("held", clock);
    equal("overflow does not evict the held id", rememberOutboundId("overflow", clock), false);
    equal("overflow sets the saturated flag", outboundIdsSaturated(clock), true);
    const saturated = createReactionIntake({ user: { id: bot } }, { now: () => clock });
    saturated.open();
    clock += 2000;
    const peer = text(`peer-sat-${++sequence}`, {
      key: { remoteJid: group, fromMe: false, participant: author },
    });
    saturated.observeUpsert({ type: "notify", messages: [peer] });
    equal("a peer original is still cached while saturated", saturated.stats().items, 1);
    clock += 1;
    const reactionId = `sat-${++sequence}`;
    saturated.observeUpsert({
      type: "notify",
      messages: [
        {
          key: { remoteJid: group, id: reactionId, fromMe: true, participant: bot },
          messageTimestamp: Math.floor(clock / 1000),
          message: { reactionMessage: { text: "😀", key: peer.key } },
        },
      ],
    });
    equal(
      "saturation rejects the linked reaction",
      saturated.observeReactions([
        {
          key: peer.key,
          reaction: {
            text: "😀",
            senderTimestampMs: clock,
            key: { remoteJid: group, id: reactionId, fromMe: true, participant: bot },
          },
        },
      ]).length,
      0,
    );
    saturated.close();
    configureOutboundIds({ maxItems: 100_000, ttlMs: 60 * 60 * 1000 });
    clearOutboundIds();
  }

  section("saturation stays shut until one ttl after the last refusal");
  {
    clearOutboundIds();
    const ttl = 1_000;
    const base = 1_900_000_000_000;
    configureOutboundIds({ maxItems: 2, ttlMs: ttl });
    rememberOutboundId("old-id", base);
    rememberOutboundId("mid-id", base + 10);
    const refusedAt = base + 20;
    const refused = `refused-${++sequence}`;
    equal("the full store refuses the id", rememberOutboundId(refused, refusedAt), false);
    equal("refusal arms the window", outboundIdsSaturated(refusedAt), true);
    const expired = base + ttl;
    equal("the older id expires", isOutboundId("old-id", expired), false);
    equal("the newer id is still tracked", isOutboundId("mid-id", expired), true);
    equal("expiry does not clear the refusal window", outboundIdsSaturated(expired), true);
    const another = `another-${++sequence}`;
    equal("a free slot accepts another id", rememberOutboundId(another, expired), true);
    equal("a later accept does not clear the window", outboundIdsSaturated(expired), true);
    equal(
      "a later accept does not extend the window",
      outboundIdsSaturated(refusedAt + ttl),
      false,
    );

    clock = base;
    const intake = createReactionIntake({ user: { id: bot } }, { now: () => clock });
    intake.open();
    clock = expired;
    const before = intake.stats().items;
    const notify = (id) =>
      intake.observeUpsert({
        type: "notify",
        messages: [text(id, { messageTimestamp: Math.floor(clock / 1000) })],
      });
    notify(refused);
    equal("refused id stays rejected inside the window", intake.stats().items, before);
    clock = refusedAt + ttl;
    notify(refused);
    equal("the refused id is accepted after the window", intake.stats().items, before + 1);
    notify(another);
    equal("a tracked id stays rejected after the window", intake.stats().items, before + 1);
    intake.close();

    clearOutboundIds();
    configureOutboundIds({ maxItems: 1, ttlMs: ttl });
    rememberOutboundId("only", base);
    equal("the first refusal is refused", rememberOutboundId("no-1", base), false);
    equal("the first window is still shut", outboundIdsSaturated(base + ttl - 1), true);
    equal("a later refusal is refused", rememberOutboundId("no-2", base + 50), false);
    equal(
      "the later refusal keeps the earlier boundary shut",
      outboundIdsSaturated(base + ttl),
      true,
    );
    equal(
      "the window opens one ttl after the last refusal",
      outboundIdsSaturated(base + 50 + ttl),
      false,
    );
    configureOutboundIds({ maxItems: 100_000, ttlMs: 60 * 60 * 1000 });
    clearOutboundIds();
  }
} finally {
  finish();
}

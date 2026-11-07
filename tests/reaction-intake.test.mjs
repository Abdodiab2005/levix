import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { registerHooks } from "node:module";
import { equal, finish, ok, require, section, useTempDataDir } from "./harness.mjs";

const data = useTempDataDir("levix-reactions");
const store = require("./src/db/store.cjs");
const { db } = require("./src/db/db.cjs");
const { makeEventBuffer } = await import("@whiskeysockets/baileys");
const { createReactionIntake, REACTION_LIMITS, attachReactionIntake, disposeReactionIntake,
  invalidateReactionMessage } = await import("../src/automation/reactions.js");
const socketUrl = new URL("../src/core/socket.js", import.meta.url).href;
const hook = registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url !== socketUrl) return result;
    const needle = 'import { makeWASocket } from "@whiskeysockets/baileys";';
    if (!String(result.source).includes(needle)) throw new Error("socket constructor interception failed");
    return { ...result, source: String(result.source).replace(needle,
      'const makeWASocket = () => globalThis[Symbol.for("levix-reaction-test-socket")];') };
  },
});
const { setupEventListeners } = await import("../src/core/events.js");
const { createWhatsAppSocket } = await import("../src/core/socket.js");
hook.deregister();
const group = "120363000000001@g.us";
const otherGroup = "120363000000002@g.us";
const author = "201000000001@s.whatsapp.net";
const reactor = "201000000002@s.whatsapp.net";
const bot = "201000000099@s.whatsapp.net";
const sock = { user: { id: bot }, sendMessage() { throw new Error("intake must never send"); } };
let clock = Date.now();
let sequence = 0;
const now = () => clock;
function enable(chat = group) {
  db.prepare("INSERT OR REPLACE INTO reaction_rules (id,chat_jid,enabled) VALUES (?, ?, 1)").run(chat, chat);
}
function original(id = `original-${++sequence}`, overrides = {}) {
  return { key: { remoteJid: group, id, participant: author, fromMe: false },
    message: { audioMessage: { ptt: true, mimetype: "audio/ogg", directPath: "/fake", mediaKey: Buffer.from("mock-key") } },
    messageTimestamp: Math.floor(clock / 1000), ...overrides };
}
function event(msg, emoji = "😀", overrides = {}) {
  clock += 1;
  return { key: { ...msg.key }, reaction: {
    key: { remoteJid: msg.key.remoteJid, id: `reaction-${++sequence}`, fromMe: false,
      ...(msg.key.remoteJid.endsWith("@g.us") ? { participant: reactor } : {}) },
    text: emoji, senderTimestampMs: clock, ...overrides } };
}
function fresh(options) {
  const intake = createReactionIntake(sock, { now, ...options });
  intake.open();
  return intake;
}
function remember(intake, msg) { intake.observeUpsert({ type: "notify", messages: [msg] }); }
function receive(intake, value) { return intake.observeReactions([value]); }

section("disabled-by-default scope and exact original identity");
const intake = fresh();
let msg = original();
remember(intake, msg);
equal("no enabled rules means no capture", intake.stats().items, 0);
db.prepare("INSERT INTO reaction_rules (id, chat_jid) VALUES ('disabled', ?)").run(group);
equal("new rules default disabled", db.prepare("SELECT enabled FROM reaction_rules WHERE id='disabled'").get().enabled, 0);
remember(intake, msg);
equal("disabled rules do not opt in", intake.stats().items, 0);
enable();
remember(intake, msg);
equal("enabled chat captures original", intake.stats().items, 1);
const added = receive(intake, event(msg));
equal("first nonempty reaction is add", added[0]?.type, "add");
equal("reactor comes from transport key", added[0]?.actorKey.participant, reactor);
equal("original author never becomes actor", added[0]?.original.key.participant, author);
equal("verified voice flag retained", added[0]?.original.message.audioMessage.ptt, true);
equal("original bytes are preserved only in RAM", Buffer.from(added[0]?.original.message.audioMessage.mediaKey || []).toString(), "mock-key");
equal("no rule engine or provider is invoked", added.length, 1);
for (const alter of [
  { isViewOnce: true },
  { id: "unknown" }, { remoteJid: otherGroup }, { participant: reactor }, { fromMe: true },
  { remoteJid: "status@broadcast" }, { remoteJid: "1@newsletter" }, { remoteJid: "1:0@lid@evil" },
  { remoteJid: `${group.split("@")[0]}:7@g.us` },
  { participant: group }, { id: 123 }, { fromMe: undefined },
]) {
  const value = event(msg); Object.assign(value.key, alter);
  equal(`reject invalid target ${JSON.stringify(alter)}`, receive(intake, value).length, 0);
}
for (const alter of [
  { fromMe: true }, { participant: bot }, { participant: undefined }, { remoteJid: otherGroup },
  { id: "" }, { fromMe: undefined },
]) {
  const value = event(msg); Object.assign(value.reaction.key, alter);
  equal(`reject invalid actor ${JSON.stringify(alter)}`, receive(intake, value).length, 0);
}
for (const text of ["run !stt", "😀 hello", "😀😀", "1", 42, "x".repeat(100)]) {
  equal(`reject non-emoji argument ${text}`, receive(intake, event(msg, text)).length, 0);
}
for (const emoji of ["👍🏽", "👨‍👩‍👧", "🇧🇷", "1️⃣"]) {
  equal(`support single grapheme ${emoji}`, receive(intake, event(msg, emoji)).length, 1);
}
equal("malformed input is ignored", intake.observeReactions({}).length, 0);
equal("null input is ignored", receive(intake, null).length, 0);

section("add, change, remove, ties, redelivery and durable restart");
msg = original(); remember(intake, msg);
const first = event(msg);
equal("add", receive(intake, first)[0]?.type, "add");
equal("same transport event ignored", receive(intake, first).length, 0);
equal("same emoji new event has no transition", receive(intake, event(msg)).length, 0);
equal("different emoji means change", receive(intake, event(msg, "👍"))[0]?.type, "change");
const removed = event(msg, "");
equal("empty string means remove", receive(intake, removed)[0]?.type, "remove");
equal("redelivered removal ignored", receive(intake, removed).length, 0);
equal("already removed has no transition", receive(intake, event(msg, "")).length, 0);
const afterRemove = event(msg);
equal("add after remove", receive(intake, afterRemove)[0]?.type, "add");
equal("tied timestamp fails closed", receive(intake, event(msg, "👍", { senderTimestampMs: afterRemove.reaction.senderTimestampMs })).length, 0);
equal("older event cannot undo state", receive(intake, event(msg, "", { senderTimestampMs: first.reaction.senderTimestampMs })).length, 0);
const deleteLastRule = original(); remember(intake, deleteLastRule);
db.prepare("DELETE FROM reaction_rules WHERE chat_jid=?").run(group);
intake.observeDeletes({ keys: [deleteLastRule.key] });
enable(); remember(intake, deleteLastRule);
equal("delete last rule/delete/recreate cannot revive", receive(intake, event(deleteLastRule)).length, 0);
const restarted = fresh();
equal("restart begins with empty original lookup", receive(restarted, afterRemove).length, 0);
remember(restarted, msg);
equal("ledger suppresses replay after new lookup", receive(restarted, afterRemove).length, 0);
const restartedCode = `
  import { createRequire } from 'node:module';
  import { createReactionIntake } from './src/automation/reactions.js';
  const require=createRequire(import.meta.url);
  const store=require('./src/db/store.cjs');
  const input=JSON.parse(process.argv[1]);
  const intake=createReactionIntake({user:{id:${JSON.stringify(bot)}}},{now:()=>input.clock});
  intake.open(); intake.observeUpsert({type:'notify',messages:[input.msg]});
  console.log('RESULT '+JSON.stringify(intake.observeReactions([input.event]).length));
  intake.close(); require('./src/db/db.cjs').close();
`;
const child = spawnSync(process.execPath, ["--input-type=module", "-e", restartedCode,
  JSON.stringify({ msg, event: afterRemove, clock })], { encoding: "utf8", env: { ...process.env, LEVIX_DATA_DIR: data } });
equal("fresh process exits cleanly", child.status, 0);
equal("fresh process suppresses durable replay", /^RESULT (.*)$/m.exec(child.stdout)?.[1], "0");
remember(intake, msg);
equal("long timestamp accepted", receive(intake, event(msg, "❤️", { senderTimestampMs: { toString: () => String(clock + 10) } }))[0]?.type, "change");
for (const timestamp of [0, NaN, Infinity, "oops", clock - REACTION_LIMITS.ttlMs, clock + REACTION_LIMITS.futureSkewMs + 100]) {
  equal(`reject timestamp ${timestamp}`, receive(intake, event(msg, "👍", { senderTimestampMs: timestamp })).length, 0);
}
restarted.close();

section("private chat and trusted PN/LID mapping");
const privateMsg = original("private-original", { key: { remoteJid: reactor, id: "private-original", fromMe: false } });
enable(reactor); remember(intake, privateMsg);
equal("private transport sender is source chat", receive(intake, event(privateMsg))[0]?.actorKey.remoteJid, reactor);
const forgedPrivate = event(privateMsg); forgedPrivate.reaction.key.participant = author;
equal("private foreign participant refused", receive(intake, forgedPrivate).length, 0);
store.storeLidPnMapping("1001@lid", author); store.storeLidPnMapping("1002@lid", reactor);
const alias = original(); alias.key.participant = "1001:7@lid";
remember(intake, alias);
const aliasReaction = event(alias); aliasReaction.key.participant = author;
aliasReaction.reaction.key.participant = "1002:9@lid";
equal("known mapping resolves target while preserving transport actor", receive(intake, aliasReaction)[0]?.actorKey.participant, "1002@lid");
const privateAliasEvent = event(privateMsg, "👍");
equal("private event claimed", receive(intake, privateAliasEvent).length, 1);
privateAliasEvent.key.remoteJid = "1002@lid";
privateAliasEvent.reaction.key.remoteJid = "1002@lid";
equal("same transport id via alias still duplicate", receive(intake, privateAliasEvent).length, 0);

section("stale, unsupported and unrelated originals");
for (const message of [
  { viewOnceMessage: { message: { audioMessage: { ptt: true } } } },
  { ephemeralMessage: { message: { conversation: "private" } } },
  { audioMessage: { viewOnce: true } }, { audioMessage: { contextInfo: { expiration: 60 } } },
  { editedMessage: { message: { conversation: "edited" } } },
  { reactionMessage: { text: "😀" } }, { conversation: "x", audioMessage: {} },
]) {
  const hidden = original(undefined, { message }); remember(intake, hidden);
  equal(`unsupported envelope ${Object.keys(message)[0]}`, receive(intake, event(hidden)).length, 0);
}
for (const change of [
  { messageTimestamp: Math.floor((clock - REACTION_LIMITS.ttlMs) / 1000) },
  { messageStubType: 1 }, { messageTimestamp: undefined },
  { ephemeralStartTimestamp: 1 }, { ephemeralDuration: 60 },
  { key: { remoteJid: otherGroup, id: "not-opted-in", participant: author, fromMe: false } },
  { key: { remoteJid: group, id: "self-original", participant: bot, fromMe: false } },
]) {
  const rejected = original(undefined, change); remember(intake, rejected);
  equal("unavailable original fails closed", receive(intake, event(rejected)).length, 0);
}
const history = original();
intake.observeUpsert({ type: "append", messages: [history] });
equal("history never populates lookup", receive(intake, event(history)).length, 0);
intake.observeUpsert({ type: "notify", requestId: "phone-request", messages: [history] });
equal("phone recovery never populates lookup", receive(intake, event(history)).length, 0);
msg = original(); msg.message.audioMessage.contextInfo = { quotedMessage: { conversation: "do not retain" } };
msg.message.audioMessage.jpegThumbnail = Buffer.alloc(2048);
remember(intake, msg);
const sanitized = receive(intake, event(msg))[0]?.original;
equal("quoted payload stripped", sanitized?.message.audioMessage.contextInfo, undefined);
equal("thumbnail stripped", sanitized?.message.audioMessage.jpegThumbnail, undefined);
sanitized.message.audioMessage.ptt = false;
equal("consumer cannot mutate cached original", receive(intake, event(msg, "👍"))[0]?.original.message.audioMessage.ptt, true);

section("delete/edit invalidation and anti-revival");
for (const invalidate of [
  (target) => intake.observeDeletes({ keys: [target.key] }),
  (target) => intake.observeUpdates([{ key: target.key, update: { message: null } }]),
  (target) => intake.observeUpdates([{ key: target.key, update: { message: { editedMessage: {} } } }]),
  (target) => intake.observeUpsert({ type: "notify", messages: [original(undefined, {
    message: { protocolMessage: { key: target.key, type: 0 } },
  })] }),
]) {
  const target = original(); remember(intake, target); invalidate(target);
  equal("observed delete/edit invalidates", receive(intake, event(target)).length, 0);
  remember(intake, target);
  equal("late original redelivery cannot revive", receive(intake, event(target)).length, 0);
}
for (const update of [false, true]) {
  const target = original(); remember(intake, target);
  db.prepare("UPDATE reaction_rules SET enabled=0").run();
  if (update) intake.observeUpdates([{ key: target.key, update: { message: null } }]);
  else intake.observeDeletes({ keys: [target.key] });
  enable(); remember(intake, target);
  equal("disable/delete/re-enable cannot revive", receive(intake, event(target)).length, 0);
  const freshSocket = fresh(); remember(freshSocket, target);
  equal("new socket retains deletion knowledge", receive(freshSocket, event(target)).length, 0);
  freshSocket.close();
  const unseen = event(target);
  const deletedChild = spawnSync(process.execPath, ["--input-type=module", "-e", restartedCode,
    JSON.stringify({ msg: target, event: unseen, clock })], { encoding: "utf8", env: { ...process.env, LEVIX_DATA_DIR: data } });
  equal("deleted restart fixture exits", deletedChild.status, 0);
  equal("fresh process refuses deleted original and unseen reaction", /^RESULT (.*)$/m.exec(deletedChild.stdout)?.[1], "0");
}

section("alias mappings learned after capture and claim");
const lateAlias = original(); lateAlias.key.participant = "2001@lid";
remember(intake, lateAlias);
const lateEvent = event(lateAlias); lateEvent.reaction.key.participant = "2002@lid";
equal("unmapped transport identities supported", receive(intake, lateEvent)[0]?.type, "add");
store.storeLidPnMapping("2001@lid", "201000000011@s.whatsapp.net");
store.storeLidPnMapping("2002@lid", "201000000012@s.whatsapp.net");
const mapped = { ...lateAlias, key: { ...lateAlias.key, participant: "201000000011@s.whatsapp.net" } };
const mappedRepeat = event(mapped); mappedRepeat.reaction.key.participant = "201000000012@s.whatsapp.net";
equal("learned alias preserves unchanged emoji", receive(intake, mappedRepeat).length, 0);
const mappedChange = event(mapped, "👍"); mappedChange.reaction.key.participant = "201000000012@s.whatsapp.net";
equal("learned alias preserves change type", receive(intake, mappedChange)[0]?.type, "change");
const mappedRestart = fresh(); remember(mappedRestart, mapped);
const mappedAfterRestart = event(mapped, "👍"); mappedAfterRestart.reaction.key.participant = "201000000012@s.whatsapp.net";
equal("learned alias state survives restart", receive(mappedRestart, mappedAfterRestart).length, 0);
mappedRestart.close();
const deletedAlias = original("deleted-alias", { key: { remoteJid: "3001@lid", id: "deleted-alias", fromMe: false } });
enable("3001@lid"); remember(intake, deletedAlias);
intake.observeDeletes({ keys: [deletedAlias.key] });
store.storeLidPnMapping("3001@lid", "201000000031@s.whatsapp.net");
const deletedPn = { ...deletedAlias, key: { ...deletedAlias.key, remoteJid: "201000000031@s.whatsapp.net" } };
remember(intake, deletedPn);
equal("learned chat alias cannot bypass deletion marker", receive(intake, event(deletedPn)).length, 0);
const numericCollision = original(); numericCollision.key.participant = "201000000001@lid";
remember(intake, numericCollision);
const unrelated = event(numericCollision); unrelated.key.participant = author;
equal("matching LID/PN digits alone never prove identity", receive(intake, unrelated).length, 0);

section("real Baileys event buffer folding and ordering");
const bufferedIntake = fresh();
const buffer = makeEventBuffer({ debug() {}, trace() {}, warn() {} });
buffer.on("messages.upsert", (payload) => bufferedIntake.observeUpsert(payload));
buffer.on("messages.reaction", (payload) => bufferedIntake.observeReactions(payload));
const beforeBuffer = db.prepare("SELECT COUNT(*) AS n FROM reaction_events").get().n;
const foldedOriginal = original(); const foldedReaction = event(foldedOriginal);
buffer.buffer();
buffer.emit("messages.upsert", { type: "notify", messages: [foldedOriginal] });
buffer.emit("messages.reaction", [foldedReaction]);
buffer.flush();
equal("folded reaction claimed synchronously", db.prepare("SELECT COUNT(*) AS n FROM reaction_events").get().n, beforeBuffer + 1);
buffer.emit("messages.reaction", [foldedReaction]);
equal("folded/dedicated redelivery deduplicated", db.prepare("SELECT COUNT(*) AS n FROM reaction_events").get().n, beforeBuffer + 1);
const reversedOriginal = original(); const reversedReaction = event(reversedOriginal);
buffer.buffer();
buffer.emit("messages.reaction", [reversedReaction]);
buffer.emit("messages.upsert", { type: "notify", messages: [reversedOriginal] });
buffer.flush();
equal("reaction before original in buffer handled", db.prepare("SELECT COUNT(*) AS n FROM reaction_events").get().n, beforeBuffer + 2);
bufferedIntake.close();
const all = original(); remember(intake, all);
intake.observeDeletes({ jid: group, all: true });
equal("chat clear invalidates all originals", receive(intake, event(all)).length, 0);
intake.close();

section("resource bounds, disabled scopes and disposal");
db.exec("DELETE FROM reaction_invalidations"); // independent isolated-data scenario
const small = fresh({ limits: { ...REACTION_LIMITS, maxItems: 2, maxBytes: 1000, maxEntryBytes: 500 } });
const one = original(), two = original(), three = original();
for (const target of [one, two, three]) remember(small, target);
equal("lookup item cap", small.stats().items, 2);
equal("evicted original cannot trigger", receive(small, event(one)).length, 0);
ok("byte cap", small.stats().bytes <= 1000);
const huge = original(undefined, { message: { conversation: "x".repeat(1000) } });
remember(small, huge);
equal("oversize original skipped", receive(small, event(huge)).length, 0);
for (const id of ["deleted-one", "deleted-two", "deleted-three"]) small.observeDeletes({ keys: [{ remoteJid: group, id }] });
equal("tombstone pressure clears lookup", small.stats().items, 0);
remember(small, three);
equal("saturated tombstones fail closed", small.stats().items, 0);
clock += REACTION_LIMITS.ttlMs + REACTION_LIMITS.futureSkewMs + 1;
const later = original(); remember(small, later);
equal("fresh content works after block expires", small.stats().items, 1);
db.prepare("UPDATE reaction_rules SET enabled=0").run();
equal("live disable clears originals", small.stats().items, 0);
equal("disabled scope cannot trigger", receive(small, event(later)).length, 0);
enable();
remember(small, later); clock += REACTION_LIMITS.ttlMs + 1;
equal("TTL clears idle lookup on sweep", small.stats().items, 0);
remember(small, original()); small.close(); small.open();
remember(small, original()); equal("disposed socket cannot reopen", small.stats().items, 0);
const batched = fresh({ limits: { ...REACTION_LIMITS, maxBatch: 2 } });
const batch = [original(), original()]; batched.observeUpsert({ type: "notify", messages: batch });
equal("all supported originals in batch captured", batched.stats().items, 2);
batched.observeDeletes({ keys: [batch[0].key, batch[1].key, batch[0].key] });
equal("overlarge delete batch fails closed", batched.stats().items, 0);
remember(batched, original()); equal("overlarge delete cannot leave unsafe entries", batched.stats().items, 0);
batched.close();

section("real event wiring, no double consumption and no WhatsApp send");
clock = Date.now();
db.exec("DELETE FROM reaction_invalidations"); // independent real-clock fixture
enable();
const ev = new EventEmitter();
let sends = 0;
const wiredSock = { ev, user: { id: bot }, sendMessage() { sends++; return {}; } };
setupEventListeners(wiredSock);
const tick = () => new Promise((resolve) => setImmediate(resolve));
ev.emit("connection.update", { connection: "open" }); await tick();
const wiredOriginal = original(undefined, { message: { conversation: "ordinary message" } });
ev.emit("messages.upsert", { type: "notify", messages: [wiredOriginal] }); await tick();
const wiredEvent = event(wiredOriginal);
const beforeWired = db.prepare("SELECT COUNT(*) AS n FROM reaction_events").get().n;
ev.emit("messages.reaction", [wiredEvent]); await tick();
const claimCount = db.prepare("SELECT COUNT(*) AS n FROM reaction_events").get().n;
equal("real listeners admit the reaction", claimCount, beforeWired + 1);
const immediateEvent = event(wiredOriginal, "👍");
ev.emit("messages.reaction", [immediateEvent]);
equal("reaction intake does not queue a microtask", db.prepare("SELECT COUNT(*) AS n FROM reaction_events").get().n, claimCount + 1);
// Reset this scenario's count; the original event remains a duplicate.
const nextClaimCount = claimCount + 1;
ev.emit("messages.reaction", [wiredEvent]); await tick();
equal("dedicated reaction redelivery is once", db.prepare("SELECT COUNT(*) AS n FROM reaction_events").get().n, nextClaimCount);
ev.emit("messages.upsert", { type: "notify", messages: [{ key: wiredEvent.reaction.key,
  message: { reactionMessage: { ...wiredEvent.reaction, key: wiredEvent.key } } }] }); await tick();
equal("reaction upsert never double-consumed", db.prepare("SELECT COUNT(*) AS n FROM reaction_events").get().n, nextClaimCount);
equal("intake sends nothing", sends, 0);
ev.emit("messages.delete", { keys: [wiredOriginal.key] }); await tick();
ev.emit("messages.reaction", [event(wiredOriginal, "👍")]); await tick();
equal("dedicated delete listener invalidates", db.prepare("SELECT COUNT(*) AS n FROM reaction_events").get().n, nextClaimCount);
ev.emit("connection.update", { connection: "close" }); await tick();
ev.emit("messages.upsert", { type: "notify", messages: [original()] }); await tick();
ev.emit("messages.reaction", [event(wiredOriginal, "❤️")]); await tick();
equal("closed socket cannot consume", db.prepare("SELECT COUNT(*) AS n FROM reaction_events").get().n, nextClaimCount);
disposeReactionIntake(wiredSock);

section("outbound local deletes invalidate before send");
db.exec("DELETE FROM reaction_invalidations"); // return from injected future clock
const localSock = { user: { id: bot }, sendMessage() { return {}; } };
const local = attachReactionIntake(localSock); local.open();
const localMsg = original(undefined, { messageTimestamp: Math.floor(Date.now() / 1000) });
local.observeUpsert({ type: "notify", messages: [localMsg] });
equal("local delete fixture cached", local.stats().items, 1);
globalThis[Symbol.for("levix-reaction-test-socket")] = localSock;
await createWhatsAppSocket();
await localSock.sendMessage(group, { delete: localMsg.key });
equal("socket delete invalidates", local.stats().items, 0);
invalidateReactionMessage(localSock, localMsg.key);
disposeReactionIntake(localSock);

section("periodic lookup failure is contained and discards originals");
db.exec("DELETE FROM reaction_invalidations");
const realInterval = globalThis.setInterval;
let sweepTimer;
globalThis.setInterval = (callback) => { sweepTimer = callback; return { unref() {} }; };
const failingSweep = fresh();
globalThis.setInterval = realInterval;
remember(failingSweep, original());
equal("failure fixture cached", failingSweep.stats().items, 1);
const enabledQuery = store.isReactionChatEnabled;
store.isReactionChatEnabled = () => { throw new Error("isolated database failure"); };
try { sweepTimer(); ok("periodic failure does not escape", true); }
catch { ok("periodic failure does not escape", false); }
finally { store.isReactionChatEnabled = enabledQuery; }
equal("failed periodic sweep discarded private cache", failingSweep.stats().items, 0);
remember(failingSweep, original());
equal("failed sweep cannot silently retry capture", failingSweep.stats().items, 0);
failingSweep.close();

section("persistent ledger cap never evicts live claims; unlink disables all rules");
db.exec("DELETE FROM reaction_invalidations");
store.invalidateReactionLookup(["long-lived"], clock + 10000, clock, 1);
store.invalidateReactionLookup(["overflow"], clock + 1000, clock - 1000, 1);
equal("global invalidation never shortens a live expiry", db.prepare("SELECT expires_at FROM reaction_invalidations WHERE invalidation_key='*'").get().expires_at, clock + 10000);
db.exec("DELETE FROM reaction_events; DELETE FROM reaction_state");
const expiresAt = clock + REACTION_LIMITS.ttlMs;
store.withImmediateTransaction(() => {
  const insert = db.prepare("INSERT INTO reaction_events VALUES (?,?)");
  for (let index = 0; index < store.REACTION_LEDGER_CAP; index++) insert.run(`cap-${index}`, expiresAt);
});
const next = { eventKey: "overflow", slotKeys: ["slot"], timestampMs: clock, emoji: "😀", expiresAt };
equal("event cap refuses work", store.claimReactionEvent(next, clock), null);
equal("live event claim retained", db.prepare("SELECT COUNT(*) AS n FROM reaction_events").get().n, store.REACTION_LEDGER_CAP);
db.exec("DELETE FROM reaction_events");
store.withImmediateTransaction(() => {
  const insert = db.prepare("INSERT INTO reaction_state VALUES (?,?,?,?)");
  for (let index = 0; index < store.REACTION_LEDGER_CAP; index++) insert.run(`state-${index}`, clock, "😀", expiresAt);
});
equal("state cap refuses work", store.claimReactionEvent(next, clock), null);
equal("live state retained", db.prepare("SELECT COUNT(*) AS n FROM reaction_state").get().n, store.REACTION_LEDGER_CAP);
equal("expiry frees capacity", store.claimReactionEvent({ ...next, timestampMs: expiresAt + 1, expiresAt: expiresAt + 100 }, expiresAt + 1), "add");
store.clearWhatsAppDirectory();
equal("unlink clears event claims", db.prepare("SELECT COUNT(*) AS n FROM reaction_events").get().n, 0);
equal("unlink clears transitions", db.prepare("SELECT COUNT(*) AS n FROM reaction_state").get().n, 0);
equal("unlink clears invalidation hashes", db.prepare("SELECT COUNT(*) AS n FROM reaction_invalidations").get().n, 0);
equal("unlink retains configuration disabled", db.prepare("SELECT COUNT(*) AS n FROM reaction_rules WHERE enabled=1").get().n, 0);
ok("unlink retains rules", db.prepare("SELECT COUNT(*) AS n FROM reaction_rules").get().n > 0);
finish();

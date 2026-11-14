// Reaction actions use real routing/cancellation boundaries, fake transport and providers.
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { registerHooks } from "node:module";
import { mock } from "node:test";
import { equal, finish, ok, require, section, throws, useTempDataDir } from "./harness.mjs";

const data = useTempDataDir("levix-reaction-engine");
const store = require("./src/db/store.cjs");
const database = require("./src/db/db.cjs");
const { db } = database;
const settings = require("./src/config/settings.cjs");
const runtime = require("./src/config/runtime-config.cjs");
const groupMetadataCache = require("./src/utils/groupMetadataCache.cjs");
const media = require("./src/utils/geminiMedia.cjs");
const stt = require("./src/commands/stt.cjs");
const thumbnail = require("./src/utils/thumbnail.cjs");
const { timing } = await import("../src/utils/sendBotMessage.esm.js");
const { createReactionAutomation } = await import("../src/automation/engine.js");
const { resolveVerifiedSender } = await import("../src/middleware/permissions.middleware.js");
const { validateDefinition } = require("./src/automation/rules.cjs");

const saved = { download: media.downloadMedia, transcribe: stt.transcribe,
  thumbnail: thumbnail.withMediaThumbnail, sleep: timing.sleep, get: settings.get };
let prepare = async (content) => content;
thumbnail.withMediaThumbnail = (...args) => prepare(...args);
const socketUrl = new URL("../src/core/socket.js", import.meta.url).href;
const slot = Symbol.for("levix-reaction-engine-test-socket");
const hook = registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url !== socketUrl) return result;
    const needle = 'import { makeWASocket } from "@whiskeysockets/baileys";';
    if (!String(result.source).includes(needle)) throw new Error("socket interception failed");
    return { ...result, source: String(result.source).replace(needle,
      'const makeWASocket = () => globalThis[Symbol.for("levix-reaction-engine-test-socket")];') };
  },
});
const { createWhatsAppSocket } = await import("../src/core/socket.js");
hook.deregister();

const group = "120363700000001@g.us";
const otherGroup = "120363700000002@g.us";
const author = "201070000001@s.whatsapp.net";
const reactor = "201070000002@s.whatsapp.net";
const bot = "201070000099@s.whatsapp.net";
const audioBytes = Buffer.from("OggS-deterministic-voice");
let clock = 1_800_000_000_000;
let sequence = 0;
let fixtureSequence = 0;
let current = null;
let deadline = 30_000;
let downloaded = 0;
let transcribed = 0;
let observedAudio;
let observedSignal;
settings.get = (key) => key === "ai_tool_timeout_ms" ? deadline : saved.get(key);

function definition(patch = {}) {
  return { version: 1, emoji: "😀", transitions: ["add", "change", "remove"],
    originalTypes: ["text"], senders: { role: "any", ids: [] }, action: "ping",
    destination: { mode: "same_chat" }, ...patch };
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
async function reached(label, predicate) {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise((done) => setImmediate(done));
  ok(label, predicate());
}
async function fixture({ rules = [{ id: "rule", definition: definition() }], enabled = true,
  globalEnabled = true, participants = [] } = {}) {
  if (current) { current.engine.close(); await current.engine.settled(); }
  db.exec("DELETE FROM reaction_rules; DELETE FROM reaction_events; DELETE FROM reaction_state; DELETE FROM reaction_invalidations; DELETE FROM reaction_executions; DELETE FROM reaction_budgets; DELETE FROM user_metadata; DELETE FROM lid_mapping; DELETE FROM group_settings;");
  store.saveBotSetting("command_permissions", {});
  store.saveBotSetting("disabled_commands", []);
  store.authRemove("creds");
  clock = 1_800_000_000_000 + ++fixtureSequence * 1_000_000;
  deadline = 30_000;
  downloaded = 0; transcribed = 0; observedAudio = null; observedSignal = null;
  settings.set("bot_language", "en");
  settings.set("bot_min_delay_ms", 0);
  settings.set("bot_max_delay_ms", 0);
  settings.set("ai_stt_enabled", true);
  settings.set("ai_stt_provider", "gemini");
  settings.set("gemini_api_key", "isolated-test-key");
  settings.set("openai_api_key", "");
  media.downloadMedia = async (_download, audio, kind, options) => {
    downloaded++; observedAudio = audio; observedSignal = options.signal;
    equal("STT downloads audio only", kind, "audio");
    equal("STT download has 8 MiB cap", options.maxBytes, 8 * 1024 * 1024);
    return audioBytes;
  };
  stt.transcribe = async (bytes, mime, options) => {
    transcribed++;
    equal("STT reuses downloaded bytes", bytes, audioBytes);
    equal("STT keeps the audio MIME", mime, "audio/ogg");
    equal("STT propagates the same cancellation", options.signal, observedSignal);
    return "verified transcript";
  };
  timing.sleep = async () => {};
  prepare = async (content) => content;
  const state = { participants: [{ id: author }, { id: reactor }, { id: bot }, ...participants],
    metadataCalls: 0, attempts: [], sent: [], refused: false, rejected: false };
  const raw = {
    ev: new EventEmitter(), user: { id: bot },
    async groupMetadata(chat) {
      state.metadataCalls++;
      return { id: chat, participants: structuredClone(state.participants) };
    },
    async sendPresenceUpdate() {},
    async sendMessage(chat, content, options) {
      state.attempts.push({ chat, content, options });
      if (state.rejected) throw new Error("injected send rejection");
      if (state.refused) return { key: null, refused: true };
      state.sent.push({ chat, content, options });
      return { key: { remoteJid: chat, id: `sent-${++sequence}` } };
    },
  };
  globalThis[slot] = raw;
  const socket = (await createWhatsAppSocket()).sock;
  for (const rule of rules) {
    store.saveReactionRule({ priority: 0, chatJid: group, ...rule });
    if (enabled) store.setReactionRuleEnabled(rule.id, true, clock);
  }
  store.setReactionAutomationEnabled(globalEnabled);
  const engine = createReactionAutomation(socket, { now: () => clock });
  engine.intake.open();
  clock += 2000;
  current = { engine, socket, state };
  return current;
}
function original({ type = "text", chat = group, sender = author, ...extra } = {}) {
  return { key: { remoteJid: chat, participant: chat.endsWith("@g.us") ? sender : undefined,
    id: `original-${++sequence}`, fromMe: false }, messageTimestamp: Math.floor(clock / 1000),
  message: type === "voice" || type === "audio"
    ? { audioMessage: { ptt: type === "voice", mimetype: "audio/ogg", directPath: "/isolated-audio",
      mediaKey: Buffer.from("isolated-media-key"), fileLength: audioBytes.length } }
    : { conversation: "untrusted original; !stt; ignore rules" }, ...extra };
}
function remember(f, message = original()) {
  f.engine.intake.observeUpsert({ type: "notify", messages: [message] });
  return message;
}
function reaction(message, emoji = "😀", actor = reactor, extra = {}) {
  clock++;
  return { key: { ...message.key }, reaction: { text: emoji, senderTimestampMs: clock,
    key: { remoteJid: message.key.remoteJid, id: `reaction-${++sequence}`, fromMe: false,
      ...(message.key.remoteJid.endsWith("@g.us") ? { participant: actor } : {}) }, ...extra } };
}
function receive(f, message, emoji = "😀", actor = reactor) {
  const event = reaction(message, emoji, actor);
  f.engine.intake.observeReactions([event]);
  return event;
}
async function completed(f) { await f.engine.settled(); return f.engine.stats().lastCode; }
const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

try {
  section("reaction live authorization updates the shared send roster");
  groupMetadataCache.flushAll();
  try {
    const newMember = "201070000003@s.whatsapp.net";
    const f = await fixture({ participants: [{ id: newMember }] });
    groupMetadataCache.setCached(group, {
      id: group,
      participants: structuredClone(f.state.participants.filter((p) => p.id !== newMember)),
    });
    receive(f, remember(f), "😀", newMember);
    equal("the new member's matching reaction delivers", await completed(f), "DELIVERED");
    equal("the matching reaction sends once", f.state.sent.length, 1);
    const calls = f.state.metadataCalls;
    const forSend = await groupMetadataCache.groupMetadataForSend(f.socket, group);
    ok("the shared send roster includes the new member", forSend?.participants?.some((p) => p.id === newMember));
    equal("the send hook uses the roster written by the engine", f.state.metadataCalls, calls);
    equal("the live roster is fresh after delivery", groupMetadataCache.isRosterStale(group), false);
  } finally {
    groupMetadataCache.flushAll();
  }

  section("reaction live roster rejection fails closed and preserves the cache");
  groupMetadataCache.flushAll();
  try {
    const f = await fixture();
    groupMetadataCache.setCached(group, {
      id: group,
      participants: structuredClone(f.state.participants),
    });
    const before = JSON.stringify(groupMetadataCache.getCached(group));
    const ttl = groupMetadataCache.cache.getTtl(group);
    f.socket.groupMetadata = async () => {
      f.state.metadataCalls++;
      throw new Error("injected roster rejection");
    };
    receive(f, remember(f));
    equal("a rejected live roster is inaccessible", await completed(f), "REACTION_INACCESSIBLE");
    equal("a rejected live roster makes one request", f.state.metadataCalls, 1);
    equal("a rejected live roster initiates no send", f.state.attempts.length, 0);
    equal("a rejected live roster delivers nothing", f.state.sent.length, 0);
    equal("a rejected live roster leaves the cached entry unchanged", JSON.stringify(groupMetadataCache.getCached(group)), before);
    equal("a rejected live roster keeps the cached TTL", groupMetadataCache.cache.getTtl(group), ttl);
    equal("a rejected live roster keeps the fresh flag", groupMetadataCache.isRosterStale(group), false);
  } finally {
    groupMetadataCache.flushAll();
  }

  section("strict declarative configuration and disabled defaults");
  const valid = definition();
  for (const patch of [
    { version: 2 }, { emoji: "hello" }, { emoji: "😀😀" }, { transitions: [] },
    { transitions: ["add", "add"] }, { transitions: ["execute"] },
    { originalTypes: ["unknown"] }, { action: "shell" }, { action: "gemini" },
    { action: "stt" }, { destination: { mode: "authorized_chat", jid: otherGroup } },
    { destination: { mode: "same_chat", url: "https://example.invalid" } },
    { senders: { role: "owner", ids: ["201070000002"] } },
    { senders: { role: "any", ids: [group] } }, { senders: { role: "root", ids: [] } },
    { code: "process.exit()" }, { arguments: "!kick @all" },
  ]) throws(`reject definition ${JSON.stringify(patch)}`, () => validateDefinition({ ...valid, ...patch }));
  let f = await fixture({ enabled: false });
  equal("saved rule is disabled", store.getReactionRule("rule").enabled, 0);
  receive(f, remember(f)); await completed(f);
  equal("disabled rule captures no original", f.engine.intake.stats().items, 0);
  equal("disabled rule sends nothing", f.state.attempts.length, 0);

  section("add/change/remove, one winner and deterministic priority");
  f = await fixture({ rules: [
    { id: "z", priority: 10, definition: definition({ destination: { mode: "owner_private" } }) },
    { id: "b", priority: 1, definition: definition() },
    { id: "a", priority: 1, definition: definition() },
  ] });
  let message = remember(f);
  receive(f, message); equal("add delivers", await completed(f), "DELIVERED");
  const winningRuleKey = db.prepare("SELECT rule_key FROM reaction_executions").get().rule_key;
  ok("one durable execution for multiple matching rules", Boolean(winningRuleKey) && count("reaction_executions") === 1);
  equal("one message for multiple rules", f.state.sent.length, 1);
  equal("result stays in source chat", f.state.sent[0].chat, group);
  equal("same-chat result quotes exact verified original", f.state.sent[0].options.quoted.key.id, message.key.id);
  equal("internal guard removed before Baileys", "deliveryGuard" in f.state.sent[0].options, false);
  equal("signal removed before Baileys", "signal" in f.state.sent[0].options, false);
  receive(f, message, "👍"); equal("unconfigured change has no match", await completed(f), "NO_MATCH");
  receive(f, message, "😀"); equal("change back matches configured emoji", await completed(f), "DELIVERED");
  receive(f, message, ""); equal("removal matches previous emoji", await completed(f), "DELIVERED");
  equal("three qualifying transitions send three results", f.state.sent.length, 3);
  f = await fixture({ rules: [
    { id: "a", priority: 0, definition: definition({ destination: { mode: "owner_private" } }) },
    { id: "b", priority: 0, definition: definition() },
  ] });
  receive(f, remember(f));
  equal("lexically first failed winner does not fall through", await completed(f), "REACTION_DELIVERY_REFUSED");
  equal("failed winner sends no fallback", f.state.attempts.length, 0);

  section("candidate work is bounded without a Free rule-count limit");
  f = await fixture({ rules: [
    ...Array.from({ length: 150 }, (_, i) => ({ id: `other-${i}`, definition: definition({ emoji: "👍" }) })),
    { id: "matching", definition: definition() },
  ] });
  receive(f, remember(f));
  equal("more than 100 enabled rules can execute a selected trigger", await completed(f), "DELIVERED");
  equal("all Free rules retained", count("reaction_rules"), 151);
  f = await fixture({ rules: Array.from({ length: 101 }, (_, i) => ({ id: `same-${i}`, definition: definition() })) });
  receive(f, remember(f));
  equal("ambiguous matching candidate overload fails closed", await completed(f), "REACTION_CAPACITY");
  equal("candidate overload makes no metadata request", f.state.metadataCalls, 0);
  equal("candidate overload has no action", f.state.sent.length, 0);

  section("epochs, rule changes and source scope");
  f = await fixture();
  message = original({ messageTimestamp: Math.floor((clock - 3000) / 1000) });
  receive(f, remember(f, message)); equal("pre-enable original rejected", await completed(f), "NO_MATCH");
  message = remember(f);
  store.setReactionRuleEnabled("rule", false, clock);
  const revision = store.getReactionRule("rule").revision;
  store.setReactionRuleEnabled("rule", true, clock);
  ok("same-ms re-enable rotates revision", revision !== store.getReactionRule("rule").revision);
  equal("rule lifecycle immediately clears originals", f.engine.intake.stats().items, 0);
  receive(f, message); await completed(f);
  equal("old original cannot execute after re-enable", f.state.sent.length, 0);
  remember(f, message); receive(f, message);
  equal("redelivery from before enable epoch stays ineligible", await completed(f), "NO_MATCH");
  clock += 2000;
  receive(f, remember(f)); equal("fresh post-enable original executes", await completed(f), "DELIVERED");
  receive(f, remember(f, original({ chat: otherGroup })));
  await completed(f);
  equal("other chat cannot use scoped rule", f.state.sent.length, 1);
  message = remember(f);
  const forgedCrossChat = reaction(message); forgedCrossChat.reaction.key.remoteJid = otherGroup;
  f.engine.intake.observeReactions([forgedCrossChat]); await completed(f);
  equal("cross-chat transport identity rejected", f.state.sent.length, 1);

  section("real reactor roles and live command permissions");
  for (const [role, level, allowed, groupAdmin] of [
    ["member", "MEMBERS", true, false], ["member", "OWNER_ONLY", false, false],
    ["bot_admin", "ADMINS_ONLY", true, false], ["bot_admin", "OWNER_ONLY", false, false],
    ["owner", "OWNER_ONLY", true, false], ["group_admin", "ADMINS_ONLY", true, true],
    ["group_admin", "OWNER_ONLY", false, true],
  ]) {
    f = await fixture();
    if (role === "owner" || role === "bot_admin") store.saveUserMetadata({ jid: reactor, isOwner: role === "owner", isAdmin: role === "bot_admin" });
    if (groupAdmin) f.state.participants.find((p) => p.id === reactor).admin = "admin";
    runtime.setPermission("ping", level);
    receive(f, remember(f)); await completed(f);
    equal(`${role} obeys ${level}`, f.state.sent.length, allowed ? 1 : 0);
  }
  f = await fixture();
  store.saveUserMetadata({ jid: author, isOwner: true });
  runtime.setPermission("ping", "OWNER_ONLY");
  receive(f, remember(f));
  equal("original author grants no reactor authority", await completed(f), "REACTION_FORBIDDEN");
  equal("author-owner cannot authorize ordinary reactor", f.state.sent.length, 0);
  f = await fixture({ rules: [{ id: "rule", definition: definition({ senders: { role: "member", ids: [reactor] } }) }] });
  const otherActor = "201070000003@s.whatsapp.net";
  f.state.participants.push({ id: otherActor });
  receive(f, remember(f), "😀", otherActor);
  equal("sender allowlist filters other participant", await completed(f), "NO_MATCH");
  runtime.setEnabled("ping", false);
  receive(f, remember(f)); equal("disabled backing command fails closed", await completed(f), "REACTION_FORBIDDEN");

  section("unmatched storms do no remote work; unauthorized matching attempts are bounded");
  const stormVoiceDefinition = definition({ action: "stt", originalTypes: ["voice"] });
  f = await fixture({ rules: [{ id: "rule", definition: stormVoiceDefinition }] });
  for (let i = 0; i < 20; i++) {
    receive(f, remember(f, original({ type: "voice" })), "👍");
    receive(f, remember(f));
    receive(f, remember(f, original({ type: "voice", messageTimestamp: Math.floor((clock - 3000) / 1000) })));
  }
  await completed(f);
  equal("unmatched emoji/type/epoch storm performs zero metadata RPC", f.state.metadataCalls, 0);
  equal("unmatched storm starts no action", f.engine.stats().active, 0);
  equal("unmatched storm spends no remote-work budgets", count("reaction_budgets"), 0);
  equal("unmatched storm downloads nothing", downloaded, 0);
  equal("unmatched storm starts no provider", transcribed, 0);
  equal("unmatched storm claims no action", count("reaction_executions"), 0);
  f = await fixture();
  runtime.setPermission("ping", "OWNER_ONLY");
  for (let i = 0; i < 3; i++) {
    receive(f, remember(f));
    equal(`unauthorized matching attempt ${i + 1} refuses permission`, await completed(f), "REACTION_FORBIDDEN");
  }
  equal("first three unauthorized matches each perform one metadata RPC", f.state.metadataCalls, 3);
  for (let i = 0; i < 20; i++) { receive(f, remember(f)); await completed(f); }
  equal("unauthorized matching spam is rate limited", f.engine.stats().lastCode, "RATE_LIMIT");
  equal("rate-limited spam cannot amplify metadata RPC", f.state.metadataCalls, 3);
  equal("unauthorized matches claim no action", count("reaction_executions"), 0);
  equal("unauthorized matches never send", f.state.attempts.length, 0);

  section("LID/PN aliases require proof, not numeric coincidence");
  const lid = "700000123@lid";
  const pn = "201070000123@s.whatsapp.net";
  const collision = "700000123@s.whatsapp.net";
  f = await fixture({ participants: [{ id: lid }] });
  store.saveUserMetadata({ jid: collision, isOwner: true, isAdmin: true });
  runtime.setPermission("ping", "OWNER_ONLY");
  const senderKey = { key: { remoteJid: group, participant: lid, fromMe: false } };
  equal("numeric LID is not coincident phone owner", resolveVerifiedSender(senderKey, { participants: f.state.participants }, f.socket).isOwner, false);
  receive(f, remember(f), "😀", lid);
  equal("numeric LID collision cannot execute owner action", await completed(f), "REACTION_FORBIDDEN");
  // New contact writes must not recreate the old numeric merge. Inject a
  // pre-existing contaminated column to retain coverage of legacy databases.
  store.saveUserMetadata({ jid: lid, phone: "700000123" });
  equal("normal-message write leaves privileged row separate",
    db.prepare("SELECT user_lid FROM user_metadata WHERE user_jid=?").get(collision).user_lid, null);
  db.prepare("UPDATE user_metadata SET user_lid=? WHERE user_jid=?").run(lid, collision);
  equal("contaminated user_lid cannot confer owner authority",
    resolveVerifiedSender(senderKey, { participants: f.state.participants }, f.socket).isOwner, false);
  equal("contaminated user_lid cannot confer bot-admin authority",
    resolveVerifiedSender(senderKey, { participants: f.state.participants }, f.socket).isBotAdmin, false);
  receive(f, remember(f), "😀", lid);
  equal("legacy contact merge cannot authorize an owner action", await completed(f), "REACTION_FORBIDDEN");
  store.storeLidPnMapping(lid, collision);
  equal("authoritative LID mapping grants the actual owner role",
    resolveVerifiedSender(senderKey, { participants: f.state.participants }, f.socket).isOwner, true);
  receive(f, remember(f), "😀", lid);
  equal("trusted mapping resolves owner permission", await completed(f), "DELIVERED");

  section("verified voice uses existing STT, explicit failures and bounded output");
  const voiceDefinition = definition({ action: "stt", originalTypes: ["voice"] });
  f = await fixture({ rules: [{ id: "rule", definition: voiceDefinition }] });
  message = remember(f, original({ type: "voice" }));
  receive(f, message); equal("voice STT delivers", await completed(f), "DELIVERED");
  equal("one bounded media download", downloaded, 1);
  equal("one existing STT call", transcribed, 1);
  equal("media came from exact original", observedAudio.directPath, message.message.audioMessage.directPath);
  ok("transcript delivered", f.state.sent[0].content.text.includes("verified transcript"));
  receive(f, remember(f, original({ type: "audio" })));
  equal("non-voice audio does not match voice rule", await completed(f), "NO_MATCH");
  receive(f, remember(f)); equal("text cannot choose quoted or historical audio", await completed(f), "NO_MATCH");
  f = await fixture({ rules: [{ id: "rule", definition: voiceDefinition }] });
  settings.set("gemini_api_key", "");
  receive(f, remember(f, original({ type: "voice" })));
  equal("missing selected-provider key is explicit", await completed(f), "STT_KEY_REQUIRED");
  equal("missing key downloads nothing", downloaded, 0);
  equal("missing key sends no success", f.state.sent.length, 0);
  for (const output of ["", " ", "x".repeat(12001), null]) {
    f = await fixture({ rules: [{ id: "rule", definition: voiceDefinition }] });
    stt.transcribe = async () => output;
    receive(f, remember(f, original({ type: "voice" })));
    equal(`invalid STT output ${typeof output}/${output?.length || 0}`, await completed(f), "STT_OUTPUT_INVALID");
    equal("invalid output sends nothing", f.state.sent.length, 0);
  }
  f = await fixture({ rules: [{ id: "rule", definition: voiceDefinition }] });
  message = original({ type: "voice" }); delete message.message.audioMessage.directPath;
  receive(f, remember(f, message));
  equal("missing media fails explicitly", await completed(f), "MEDIA_NOT_AVAILABLE");
  equal("missing media does not download", downloaded, 0);

  section("duplicate events and durable event/rule/action claims across restart");
  f = await fixture(); message = remember(f);
  const duplicate = receive(f, message); await completed(f);
  f.engine.intake.observeReactions([duplicate, duplicate]); await completed(f);
  equal("duplicate transport event sends once", f.state.sent.length, 1);
  equal("all three claim dimensions stored", Object.keys(db.prepare("SELECT * FROM reaction_executions").get()).sort().join(","), "action_key,event_key,expires_at,rule_key");
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { createRequire } from 'node:module';
    const require = createRequire(process.cwd() + '/package.json');
    const { db } = require('./src/db/db.cjs');
    const store = require('./src/db/store.cjs');
    const row = db.prepare('SELECT * FROM reaction_executions').get();
    const status = store.claimReactionExecution({ eventKey: row.event_key, ruleKey: row.rule_key,
      actionKey: row.action_key, expiresAt: row.expires_at, budgets: [] }, ${clock});
    process.stdout.write('RESULT ' + status);
  `], { cwd: process.cwd(), env: { ...process.env, LEVIX_DATA_DIR: data }, encoding: "utf8" });
  equal("fresh-process claim check succeeds", child.status, 0);
  ok("fresh-process execution remains duplicate", child.stdout.includes("RESULT DUPLICATE"));
  f.engine.close();
  f.engine = createReactionAutomation(f.socket, { now: () => clock });
  f.engine.intake.open(); clock += 2000;
  remember(f, message); f.engine.intake.observeReactions([duplicate]); await completed(f);
  equal("restart replay does not send again", f.state.sent.length, 1);
  equal("persistent execution remains singular", count("reaction_executions"), 1);

  section("reactor, rule and chat budgets with bounded concurrency");
  f = await fixture();
  for (let i = 0; i < 4; i++) { receive(f, remember(f)); await completed(f); }
  equal("reactor gets three attempts per minute", f.state.sent.length, 3);
  equal("fourth reactor attempt is rate limited", f.engine.stats().lastCode, "RATE_LIMIT");
  const budgetLid = "700000777@lid";
  store.storeLidPnMapping(budgetLid, reactor);
  receive(f, remember(f), "😀", budgetLid);
  equal("learning LID alias cannot reset reactor budget", await completed(f), "RATE_LIMIT");
  clock += 60_001;
  receive(f, remember(f)); equal("reactor budget expires", await completed(f), "DELIVERED");
  f = await fixture();
  for (let i = 0; i < 6; i++) {
    const actor = `20107100000${i}@s.whatsapp.net`; f.state.participants.push({ id: actor });
    receive(f, remember(f), "😀", actor); await completed(f);
  }
  equal("rule budget bounds many reactors", f.state.sent.length, 5);
  equal("rule budget reports rate limit", f.engine.stats().lastCode, "RATE_LIMIT");
  const emojis = ["😀", "😃", "😄", "😁", "😆", "😅", "😂", "🙂", "🙃", "😉", "😊"];
  f = await fixture({ rules: emojis.map((emoji, i) => ({ id: `rule-${i}`, definition: definition({ emoji }) })) });
  for (let i = 0; i < emojis.length; i++) {
    const actor = `20107200000${i}@s.whatsapp.net`; f.state.participants.push({ id: actor });
    receive(f, remember(f), emojis[i], actor); await completed(f);
  }
  equal("chat budget bounds many actors and rules", f.state.sent.length, 10);
  equal("chat budget reports rate limit", f.engine.stats().lastCode, "RATE_LIMIT");
  f = await fixture({ rules: [{ id: "rule", definition: voiceDefinition }], participants: [{ id: otherActor }, { id: pn }] });
  const wait = deferred();
  stt.transcribe = async () => { transcribed++; return wait.promise; };
  receive(f, remember(f, original({ type: "voice" })));
  await reached("first provider entered", () => transcribed === 1);
  receive(f, remember(f, original({ type: "voice" })));
  equal("same reactor cannot occupy another slot", f.engine.stats().lastCode, "BUSY");
  receive(f, remember(f, original({ type: "voice" })), "😀", otherActor);
  await reached("second reactor provider entered", () => transcribed === 2);
  receive(f, remember(f, original({ type: "voice" })), "😀", pn);
  equal("third concurrent reactor is refused", f.engine.stats().lastCode, "BUSY");
  equal("maximum active actions is two", f.engine.stats().active, 2);
  wait.resolve("concurrent transcript"); await completed(f);
  equal("only admitted actions deliver", f.state.sent.length, 2);

  f = await fixture({ rules: [{ id: "rule", definition: voiceDefinition }], participants: [{ id: otherActor }, { id: pn }] });
  const oldProvider = deferred();
  let providerEntries = 0;
  stt.transcribe = async () => { providerEntries++; return oldProvider.promise; };
  receive(f, remember(f, original({ type: "voice" })));
  await reached("old socket provider entered", () => providerEntries === 1);
  const oldEngine = f.engine;
  oldEngine.close();
  f.engine = createReactionAutomation(f.socket, { now: () => clock });
  f.engine.intake.open(); clock += 2000;
  receive(f, remember(f, original({ type: "voice" })), "😀", otherActor);
  await reached("new generation admits one additional provider", () => providerEntries === 2);
  receive(f, remember(f, original({ type: "voice" })), "😀", pn);
  equal("reconnect does not free occupied provider capacity", f.engine.stats().lastCode, "BUSY");
  oldProvider.resolve("generation transcript");
  await oldEngine.settled(); await completed(f);
  equal("old generation cannot deliver after reconnect", oldEngine.stats().lastCode, "REACTION_CANCELLED");
  equal("only current generation delivers", f.state.sent.length, 1);

  section("cancel provider work on kill, rule disable, deletion, edit and disconnect");
  for (const reason of ["kill", "disable", "delete", "edit", "disconnect"]) {
    f = await fixture({ rules: [{ id: "rule", definition: voiceDefinition }] });
    const blocked = deferred();
    let entered = false;
    stt.transcribe = async () => { entered = true; return blocked.promise; };
    message = remember(f, original({ type: "voice" })); receive(f, message);
    await reached(`${reason}: provider entered`, () => entered);
    if (reason === "kill") store.setReactionAutomationEnabled(false);
    if (reason === "disable") store.setReactionRuleEnabled("rule", false, clock);
    if (reason === "delete") f.engine.intake.observeDeletes({ keys: [message.key] });
    if (reason === "edit") f.engine.intake.observeUpdates([{ key: message.key, update: { message: { conversation: "edited" } } }]);
    if (reason === "disconnect") f.engine.intake.close();
    equal(`${reason}: signal aborted immediately`, observedSignal.aborted, true);
    equal(`${reason}: ignored cancellation retains slot`, f.engine.stats().active, 1);
    blocked.resolve("late untrusted transcript");
    equal(`${reason}: late completion fails`, await completed(f), "REACTION_CANCELLED");
    equal(`${reason}: late completion cannot send`, f.state.attempts.length, 0);
    equal(`${reason}: claim is retained`, count("reaction_executions"), 1);
  }

  section("deadline, cooldown, thumbnail preparation and final live authorization");
  f = await fixture({ rules: [{ id: "rule", definition: voiceDefinition }] });
  let blocked = deferred(); let entered = false;
  deadline = 50;
  stt.transcribe = async () => { entered = true; return blocked.promise; };
  mock.timers.enable({ apis: ["setTimeout"] });
  receive(f, remember(f, original({ type: "voice" })));
  await reached("deadline: provider entered", () => entered);
  mock.timers.tick(50);
  equal("deadline aborts signal", observedSignal.aborted, true);
  equal("non-cancellable provider stays active after timeout", f.engine.stats().active, 1);
  blocked.resolve("late transcript"); equal("deadline is explicit failure", await completed(f), "REACTION_TIMEOUT");
  equal("deadline sends nothing", f.state.sent.length, 0);
  mock.timers.reset();
  for (const stage of ["cooldown", "preparation"]) {
    f = await fixture();
    if (stage === "cooldown") { receive(f, remember(f)); await completed(f); settings.set("bot_min_delay_ms", 10000); settings.set("bot_max_delay_ms", 10000); }
    blocked = deferred(); entered = false;
    if (stage === "cooldown") timing.sleep = async () => { entered = true; await blocked.promise; };
    else prepare = async (content) => { entered = true; await blocked.promise; return content; };
    const before = f.state.sent.length;
    receive(f, remember(f)); await reached(`${stage}: send reached delay`, () => entered);
    store.setReactionAutomationEnabled(false);
    blocked.resolve(); await completed(f);
    equal(`${stage}: killed action initiates no new send`, f.state.sent.length, before);
  }
  f = await fixture();
  f.state.participants.find((p) => p.id === reactor).admin = "admin";
  runtime.setPermission("ping", "ADMINS_ONLY");
  prepare = async (content) => {
    delete f.state.participants.find((p) => p.id === reactor).admin;
    return content;
  };
  receive(f, remember(f));
  equal("demotion during preparation rechecked at actual send", await completed(f), "REACTION_FORBIDDEN");
  equal("revoked group admin cannot send", f.state.attempts.length, 0);
  ok("source membership refreshed after preparation", f.state.metadataCalls >= 3);
  f = await fixture({ rules: [{ id: "rule", definition: voiceDefinition }] });
  f.state.participants.find((p) => p.id === reactor).admin = "admin";
  runtime.setPermission("stt", "ADMINS_ONLY");
  media.downloadMedia = async () => {
    delete f.state.participants.find((p) => p.id === reactor).admin;
    return audioBytes;
  };
  stt.transcribe = async () => { transcribed++; return "must not reach provider"; };
  receive(f, remember(f, original({ type: "voice" })));
  equal("demotion during download prevents paid provider work", await completed(f), "REACTION_FORBIDDEN");
  equal("demoted reactor never starts transcription", transcribed, 0);
  f = await fixture();
  prepare = async (content) => { runtime.setEnabled("ping", false); return content; };
  receive(f, remember(f)); await completed(f);
  equal("command disable during preparation prevents send", f.state.attempts.length, 0);

  section("refused/rejected delivery never retries or reports success");
  for (const failure of ["refused", "rejected"]) {
    f = await fixture(); f.state[failure] = true;
    receive(f, remember(f)); const code = await completed(f);
    equal(`${failure}: only one send attempt`, f.state.attempts.length, 1);
    equal(`${failure}: no successful delivery`, f.state.sent.length, 0);
    equal(`${failure}: explicit failure`, code, failure === "refused" ? "REACTION_DELIVERY_REFUSED" : "ACTION_FAILED");
    equal(`${failure}: no retry claim`, count("reaction_executions"), 1);
  }
  f = await fixture({ rules: [{ id: "rule", definition: definition({ destination: { mode: "owner_private" } }) }] });
  store.authWrite("creds", JSON.stringify({ me: { id: bot }, registered: true }));
  message = remember(f); receive(f, message);
  equal("validated linked-owner route delivers", await completed(f), "DELIVERED");
  equal("owner route uses linked identity", f.state.sent[0].chat, bot);
  equal("cross-chat route has no original quote", "quoted" in f.state.sent[0].options, false);

  section("unknown, edited/deleted originals and loops fail closed");
  f = await fixture();
  receive(f, original()); await completed(f);
  equal("unknown original has no action", f.state.attempts.length, 0);
  message = remember(f); f.engine.intake.observeDeletes({ keys: [message.key] });
  receive(f, message); await completed(f);
  equal("deleted original has no action", f.state.attempts.length, 0);
  message = remember(f); f.engine.intake.observeUpdates([{ key: message.key, update: { message: null } }]);
  receive(f, message); await completed(f);
  equal("edited original has no action", f.state.attempts.length, 0);
  for (const patch of [
    { message: { conversation: "bot", messageContextInfo: { botMetadata: {} } } },
    { message: { extendedTextMessage: { text: "bot", contextInfo: { botMessageInvokerJid: bot } } } },
    { message: { viewOnceMessage: { message: { conversation: "private" } } } },
    { message: { ephemeralMessage: { message: { conversation: "private" } } } },
    { key: { remoteJid: group, id: `self-${++sequence}`, participant: bot, fromMe: true } },
  ]) {
    const before = f.engine.intake.stats().items;
    receive(f, remember(f, original(patch))); await completed(f);
    equal("hidden/self/bot-origin input not retained", f.engine.intake.stats().items, before);
  }
  message = remember(f); receive(f, message, "😀", bot); await completed(f);
  equal("self reaction cannot trigger a loop", f.state.attempts.length, 0);
  message = remember(f); clock += 30 * 60_000 + 1;
  receive(f, message); await completed(f);
  equal("stale original cannot trigger", f.state.attempts.length, 0);
} finally {
  mock.timers.reset();
  if (current) { current.engine.close(); await current.engine.settled(); }
  media.downloadMedia = saved.download;
  stt.transcribe = saved.transcribe;
  thumbnail.withMediaThumbnail = saved.thumbnail;
  timing.sleep = saved.sleep;
  settings.get = saved.get;
  delete globalThis[slot];
}
finish();

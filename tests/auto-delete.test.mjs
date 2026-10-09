// Keyword auto-delete: matching, revoke vs delete-for-me, command, unlink, API.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  equal,
  finish,
  httpClient,
  ok,
  require,
  section,
  startServer,
  useTempDataDir,
} from "./harness.mjs";

useTempDataDir("levix-autodelete");

const store = require("./src/db/store.cjs");
const settings = require("./src/config/settings.cjs");
const runtimeConfig = require("./src/config/runtime-config.cjs");
const autoDelete = require("./src/services/autoDelete.cjs");
const { sweepExpired } = require("./src/db/db.cjs");
const { withLang } = require("./src/utils/i18n.cjs");
const { setCached, flushAll } = require("./src/utils/groupMetadataCache.cjs");
const command = require("./src/commands/autodelete.cjs");
const { sameUser, getSenderCandidates, isBotAdminInGroup } = await import(
  "../src/utils/permissions.esm.js"
);
const { handleIncomingMessage } = await import("../src/handlers/message.handler.js");
const { loadCommands, handleCommand } = await import("../src/handlers/command.handler.js");
await loadCommands();

settings.set("bot_min_delay_ms", 0);
settings.set("bot_max_delay_ms", 0);

const helpers = { sameUser, getSenderCandidates, isBotAdminInGroup };
const DM = "201111111111@s.whatsapp.net";
const LID = "111@lid";
const BOT = "209999999999@s.whatsapp.net";
const GROUP = "120363000000000001@g.us";
const ARABIC_LETTERS = /[ء-ي]/;

store.storeLidPnMapping(LID, DM);

function wipeRules() {
  for (const rule of autoDelete.listRules()) autoDelete.deleteRule(rule.id);
}

function fakeSock() {
  return {
    user: { id: BOT, lid: "999@lid" },
    sent: [],
    modified: [],
    async sendMessage(jid, content) {
      this.sent.push({ jid, content });
      return { key: { id: `out-${this.sent.length}`, remoteJid: jid, fromMe: true } };
    },
    async chatModify(mod, jid) {
      this.modified.push({ mod, jid });
    },
    async sendPresenceUpdate() {},
    async groupMetadata() {
      throw new Error("live sock.groupMetadata() is forbidden on the hot path");
    },
  };
}

function makeMsg({
  chat = DM,
  text = "",
  fromMe = false,
  participant,
  participantAlt,
  caption,
  timestamp = 1_700_000_000,
} = {}) {
  const message = caption ? { imageMessage: { caption } } : { conversation: text };
  return {
    key: {
      remoteJid: chat,
      fromMe,
      id: `in-${Math.random().toString(16).slice(2)}`,
      participant: chat.endsWith("@g.us") ? participant : undefined,
      participantAlt: chat.endsWith("@g.us") ? participantAlt : undefined,
      remoteJidAlt: chat.endsWith("@g.us") ? undefined : participantAlt,
    },
    messageTimestamp: timestamp,
    message,
  };
}

async function runHook(sock, msg, body) {
  return autoDelete.handleIncoming(sock, msg, body, helpers);
}

async function runCommand(args, lang = "en") {
  const sock = fakeSock();
  await withLang(lang, () => command.execute(sock, { key: { remoteJid: DM, fromMe: true } }, args));
  return sock.sent.map((row) => row.content?.text || "").join("\n");
}

// ---------------------------------------------------------------------------

section("normalization");

equal("ASCII case", autoDelete.normalizeMatchText("HeLLo"), "hello");
equal("Arabic tashkeel stripped", autoDelete.normalizeMatchText("مَرْحَبًا"), "مرحبا");
equal(
  "alef variants unify",
  autoDelete.normalizeMatchText("أحمد إسلام آمين ٱل"),
  "احمد اسلام امين ال",
);
equal("alef maksura becomes ya", autoDelete.normalizeMatchText("على"), "علي");
ok(
  "teh marbuta stays distinct from heh",
  autoDelete.normalizeMatchText("فاطمة") !== autoDelete.normalizeMatchText("فاطمه"),
);
equal("tatweel stripped", autoDelete.normalizeMatchText("مـــرحبا"), "مرحبا");
equal("whitespace collapsed", autoDelete.normalizeMatchText("  hello   world\n"), "hello world");

section("match modes");

{
  const text = autoDelete.normalizeMatchText("say hello world please");
  ok("contains substring", autoDelete.keywordMatches(text, "hello", "contains"));
  ok("contains misses absent", !autoDelete.keywordMatches(text, "xyz", "contains"));
  ok("word matches whole word", autoDelete.keywordMatches(text, "hello", "word"));
  ok(
    "word misses substring inside a word",
    !autoDelete.keywordMatches(autoDelete.normalizeMatchText("helloworld"), "hello", "word"),
  );
  ok("word matches a phrase", autoDelete.keywordMatches(text, "hello world", "word"));
  ok(
    "exact equals whole message",
    autoDelete.keywordMatches(autoDelete.normalizeMatchText("hello"), "hello", "exact"),
  );
  ok("exact rejects extra words", !autoDelete.keywordMatches(text, "hello", "exact"));
}

{
  const arabic = autoDelete.normalizeMatchText("قال مرحبا يا صديقي");
  ok("Arabic contains", autoDelete.keywordMatches(arabic, "مرحبا", "contains"));
  ok("Arabic whole word", autoDelete.keywordMatches(arabic, "مرحبا", "word"));
  ok(
    "Arabic word misses a longer token",
    !autoDelete.keywordMatches(autoDelete.normalizeMatchText("مرحباا يا"), "مرحبا", "word"),
  );
  const phrase = autoDelete.normalizeMatchText("قال عبد الله مرحبا");
  ok(
    "Arabic phrase is a whole-word match",
    autoDelete.keywordMatches(phrase, autoDelete.normalizeMatchText("عبد الله"), "word"),
  );
}

{
  wipeRules();
  const rule = autoDelete.createRule({ keywords: ["alpha"], match: "word" });
  const sock = fakeSock();
  ok(
    "word rule matches before update",
    await runHook(sock, makeMsg({ chat: DM, text: "say alpha now" }), "say alpha now"),
  );
  autoDelete.updateRule(rule.id, { keywords: ["beta"] });
  const sock2 = fakeSock();
  ok(
    "word rule update drops the old keyword immediately",
    !(await runHook(sock2, makeMsg({ chat: DM, text: "say alpha now" }), "say alpha now")),
  );
  ok(
    "word rule update matches the new keyword immediately",
    await runHook(sock2, makeMsg({ chat: DM, text: "say beta now" }), "say beta now"),
  );
}

section("scope, senders, includeOwn");

{
  const base = {
    enabled: true,
    keywords: ["spam"],
    match: "contains",
    chatScope: "all",
    senders: { mode: "everyone", list: [] },
    includeOwn: false,
    forEveryone: true,
    keepCopy: false,
  };
  const ctx = {
    normalizedText: "this is spam",
    isGroup: false,
    fromMe: false,
    senderCandidates: [DM],
    sameUser,
  };
  ok("everyone in private", autoDelete.ruleMatches({ ...base }, ctx));
  ok("groups-only skips private", !autoDelete.ruleMatches({ ...base, chatScope: "groups" }, ctx));
  ok(
    "groups-only hits a group",
    autoDelete.ruleMatches({ ...base, chatScope: "groups" }, { ...ctx, isGroup: true }),
  );
  ok(
    "private-only skips a group",
    !autoDelete.ruleMatches({ ...base, chatScope: "private" }, { ...ctx, isGroup: true }),
  );
  ok("fromMe skipped without includeOwn", !autoDelete.ruleMatches(base, { ...ctx, fromMe: true }));
  ok(
    "fromMe kept with includeOwn",
    autoDelete.ruleMatches({ ...base, includeOwn: true }, { ...ctx, fromMe: true }),
  );
  ok(
    "selected sender matches LID vs phone JID",
    autoDelete.ruleMatches(
      { ...base, senders: { mode: "selected", list: [DM] } },
      { ...ctx, isGroup: true, senderCandidates: [LID] },
    ),
  );
  ok(
    "selected sender rejects a stranger",
    !autoDelete.ruleMatches(
      { ...base, senders: { mode: "selected", list: [DM] } },
      { ...ctx, senderCandidates: ["201000000000@s.whatsapp.net"] },
    ),
  );
}

section("revoke vs delete-for-me");

equal(
  "forEveryone false is always delete-for-me",
  autoDelete.chooseDeleteMode({
    forEveryone: false,
    fromMe: true,
    isGroup: true,
    botIsAdmin: true,
  }),
  "deleteForMe",
);
equal(
  "own message revokes",
  autoDelete.chooseDeleteMode({
    forEveryone: true,
    fromMe: true,
    isGroup: false,
    botIsAdmin: false,
  }),
  "revoke",
);
equal(
  "group admin revokes others",
  autoDelete.chooseDeleteMode({
    forEveryone: true,
    fromMe: false,
    isGroup: true,
    botIsAdmin: true,
  }),
  "revoke",
);
equal(
  "group non-admin deletes for me",
  autoDelete.chooseDeleteMode({
    forEveryone: true,
    fromMe: false,
    isGroup: true,
    botIsAdmin: false,
  }),
  "deleteForMe",
);
equal(
  "private others delete for me",
  autoDelete.chooseDeleteMode({
    forEveryone: true,
    fromMe: false,
    isGroup: false,
    botIsAdmin: false,
  }),
  "deleteForMe",
);

section("hook: mode used, keepCopy, counters, command skip");

wipeRules();
flushAll();

{
  const rule = autoDelete.createRule({ keywords: ["spam"], keepCopy: true, forEveryone: true });
  setCached(GROUP, {
    id: GROUP,
    participants: [
      { id: BOT, admin: "admin" },
      { id: LID, phoneNumber: DM, admin: null },
    ],
  });
  const sock = fakeSock();
  const msg = makeMsg({ chat: GROUP, text: "buy spam now", participant: LID });
  ok("deleted in a group where the bot is admin", await runHook(sock, msg, "buy spam now"));
  ok(
    "used revoke",
    sock.sent.some((row) => row.content?.delete),
  );
  equal("no delete-for-me", sock.modified.length, 0);
  const after = autoDelete.getRule(rule.id);
  equal("counter incremented", after.deletedCount, 1);
  ok("lastDeletedAt set", typeof after.lastDeletedAt === "number");
  const log = store.listAutoDeleteLog({ ruleId: rule.id, limit: 5 });
  equal("keepCopy stored the text", log[0]?.text, "buy spam now");
  equal("keepCopy stored the mode", log[0]?.mode, "revoke");
  ok("no media bytes field beyond type", log[0].mediaType === "");
}

{
  wipeRules();
  autoDelete.createRule({ keywords: ["secret"], keepCopy: false });
  setCached(GROUP, {
    id: GROUP,
    participants: [
      { id: BOT, admin: null },
      { id: LID, admin: null },
    ],
  });
  const sock = fakeSock();
  const msg = makeMsg({ chat: GROUP, text: "secret plans", participant: LID });
  ok("deleted when the bot is not admin", await runHook(sock, msg, "secret plans"));
  equal("no revoke", sock.sent.length, 0);
  ok("used delete-for-me", sock.modified[0]?.mod?.deleteForMe);
  equal("deleteForMe has no media wipe", sock.modified[0].mod.deleteForMe.deleteMedia, false);
  equal("keepCopy off stores nothing", store.listAutoDeleteLog({ limit: 20 }).length, 0);
}

{
  wipeRules();
  autoDelete.createRule({ keywords: ["nope"], forEveryone: false });
  const sock = fakeSock();
  const msg = makeMsg({ chat: DM, text: "nope", fromMe: true });
  ok("fromMe is skipped without includeOwn", !(await runHook(sock, msg, "nope")));
  equal("no delete attempted", sock.sent.length + sock.modified.length, 0);
  autoDelete.createRule({ keywords: ["nope"], includeOwn: true, forEveryone: false });
  ok("fromMe is deleted with includeOwn", await runHook(sock, msg, "nope"));
  ok("includeOwn + forEveryone false uses delete-for-me", sock.modified.length >= 1);
}

{
  wipeRules();
  const rule = autoDelete.createRule({ keywords: ["failme"] });
  const sock = fakeSock();
  sock.chatModify = async () => {
    throw new Error("network");
  };
  sock.sendMessage = async () => {
    throw new Error("network");
  };
  const msg = makeMsg({ chat: DM, text: "failme" });
  ok("failed delete does not stop the pipeline", !(await runHook(sock, msg, "failme")));
  equal("failed delete does not count", autoDelete.getRule(rule.id).deletedCount, 0);
}

{
  wipeRules();
  autoDelete.createRule({ keywords: ["spam"], includeOwn: true });
  const sock = fakeSock();
  const body = "!autodelete add spam";
  const msg = makeMsg({ chat: DM, text: body, fromMe: true });
  ok("owner/fromMe !autodelete add x is not deleted", !(await runHook(sock, msg, body)));
  equal("command message was not deleted", sock.sent.length + sock.modified.length, 0);
}

{
  wipeRules();
  autoDelete.createRule({ keywords: ["x"] });
  const sock = fakeSock();
  const body = "!autodelete x";
  const msg = makeMsg({ chat: DM, text: body, fromMe: false });
  ok(
    "non-permitted member !autodelete x with a matching keyword is deleted",
    await runHook(sock, msg, body),
  );
}

{
  wipeRules();
  autoDelete.createRule({ keywords: ["spam"], includeOwn: true });
  const sock = fakeSock();
  const body = "!autodelete add spam";
  const msg = makeMsg({ chat: DM, text: body, fromMe: true });
  runtimeConfig.setEnabled("autodelete", false);
  try {
    ok("disabled command gets no exemption", await runHook(sock, msg, body));
  } finally {
    runtimeConfig.setEnabled("autodelete", true);
  }
}

{
  wipeRules();
  autoDelete.createRule({ keywords: ["captionkw"] });
  const sock = fakeSock();
  const msg = makeMsg({ chat: DM, caption: "photo captionkw here" });
  ok("media captions are matched", await runHook(sock, msg, "photo captionkw here"));
}

section("pipeline stops after a successful delete");

{
  wipeRules();
  autoDelete.createRule({ keywords: ["ping"] });
  const sock = fakeSock();
  await handleIncomingMessage(sock, {
    type: "notify",
    messages: [makeMsg({ chat: DM, text: "!ping" })],
  });
  ok("a matching !ping is deleted", sock.modified.length + sock.sent.length >= 1);
  ok(
    "the ping command does not run",
    !sock.sent.some((row) => /pong/i.test(row.content?.text || "")),
  );
}

section("retention sweep, cap, unlink");

{
  wipeRules();
  const rule = autoDelete.createRule({ keywords: ["keep"], keepCopy: true });
  store.insertAutoDeleteLog({
    ruleId: rule.id,
    chatJid: DM,
    sender: DM,
    text: "old",
    mediaType: "",
    mode: "revoke",
    createdAt: Date.now() - 40 * 24 * 60 * 60 * 1000,
  });
  store.insertAutoDeleteLog({
    ruleId: rule.id,
    chatJid: DM,
    sender: DM,
    text: "fresh",
    mediaType: "",
    mode: "revoke",
    createdAt: Date.now(),
  });
  sweepExpired();
  const rows = store.listAutoDeleteLog({ ruleId: rule.id, limit: 10 });
  equal("expired copy swept", rows.length, 1);
  equal("recent copy kept", rows[0].text, "fresh");

  for (let i = 0; i < 4; i += 1) {
    store.insertAutoDeleteLog({
      ruleId: rule.id,
      chatJid: DM,
      sender: DM,
      text: `n${i}`,
      mediaType: "",
      mode: "revoke",
      createdAt: Date.now() + i,
    });
  }
  store.capAutoDeleteLog(2);
  equal(
    "cap keeps the newest rows",
    store.listAutoDeleteLog({ ruleId: rule.id, limit: 20 }).length,
    2,
  );

  store.incrementAutoDeleteCounter(rule.id);
  store.clearAutoDeleteOnUnlink();
  equal("unlink wipes copies", store.listAutoDeleteLog({ limit: 20 }).length, 0);
  equal("unlink resets the counter", autoDelete.getRule(rule.id).deletedCount, 0);
  ok("unlink keeps the rule", autoDelete.getRule(rule.id)?.keywords[0] === "keep");
}

{
  wipeRules();
  const rule = autoDelete.createRule({ keywords: ["session"] });
  store.insertAutoDeleteLog({
    ruleId: rule.id,
    chatJid: DM,
    sender: DM,
    text: "copied",
    mediaType: "image",
    mode: "deleteForMe",
  });
  store.incrementAutoDeleteCounter(rule.id);
  const { WhatsAppSession } = await import("../src/core/session.js");
  const session = new WhatsAppSession({
    clearCredentials: async () => store.authClearAll(),
    isLinked: () => false,
    log: { info() {}, warn() {}, error() {}, debug() {} },
  });
  await session.logout();
  equal("session unlink wipes copies", store.listAutoDeleteLog({ limit: 5 }).length, 0);
  equal("session unlink resets counters", autoDelete.getRule(rule.id).deletedCount, 0);
  ok("session unlink keeps rules", Boolean(autoDelete.getRule(rule.id)));
}

section("command replies in both languages");

{
  wipeRules();
  const emptyEn = await runCommand(["list"], "en");
  ok("list empty English", /No auto-delete rules/.test(emptyEn));
  ok("list empty English has no Arabic", !ARABIC_LETTERS.test(emptyEn));
  const emptyAr = await runCommand(["list"], "ar");
  ok("list empty Arabic", ARABIC_LETTERS.test(emptyAr));

  const addedEn = await runCommand(["add", "spam", "|", "scam"], "en");
  ok("add English", /Added auto-delete rule/.test(addedEn));
  const addedAr = await runCommand(["اضف", "كلمة"], "ar");
  ok("add Arabic keyword", ARABIC_LETTERS.test(addedAr));

  const listed = autoDelete.listRules();
  ok("add created rules", listed.length >= 2);
  const id = listed[0].id;
  const statsEn = await runCommand(["stats", String(id)], "en");
  ok("stats English", /Deleted:/.test(statsEn));
  const offEn = await runCommand(["off", String(id)], "en");
  ok("off English", /is off/.test(offEn));
  equal("off persisted", autoDelete.getRule(id).enabled, false);
  await runCommand(["on", String(id)], "en");
  equal("on persisted", autoDelete.getRule(id).enabled, true);
  await runCommand(["reset", String(id)], "en");
  equal("reset persisted", autoDelete.getRule(id).deletedCount, 0);
  const removed = await runCommand(["remove", String(id)], "en");
  ok("remove English", /Removed auto-delete rule/.test(removed));
}

{
  settings.set("bot_language", "en");
  wipeRules();
  const sock = fakeSock();
  const msg = makeMsg({ chat: DM, text: "!autodelete add hello", fromMe: true });
  await handleCommand(sock, msg, "!autodelete add hello");
  ok(
    "dispatcher add is English",
    sock.sent.some((row) => /Added auto-delete rule/.test(row.content?.text || "")),
  );
}

section("keyword display form");

{
  wipeRules();
  const created = autoDelete.createRule({
    keywords: ["  اشترك   الآن  ", "Promo Code"],
  });
  equal("create keeps the typed spelling", created.keywords.join("|"), "اشترك الآن|Promo Code");
  const updated = autoDelete.updateRule(created.id, { keywords: ["  Hello   World  "] });
  equal("update keeps the typed spelling", updated.keywords.join("|"), "Hello World");
  equal("get keeps the typed spelling", autoDelete.getRule(created.id).keywords[0], "Hello World");
  equal(
    "list keeps the typed spelling",
    autoDelete.listRules().find((rule) => rule.id === created.id)?.keywords[0],
    "Hello World",
  );

  const dup = autoDelete.createRule({
    keywords: ["الآن", "الان", "الْآن", "Promo Code", "promo   code", "PROMO CODE"],
  });
  equal("duplicate spellings collapse to the first", dup.keywords.join("|"), "الآن|Promo Code");

  wipeRules();
  autoDelete.createRule({ keywords: ["الآن"] });
  ok("keyword الآن deletes الان", await runHook(fakeSock(), makeMsg({ text: "الان" }), "الان"));
  ok("keyword الآن deletes الْآن", await runHook(fakeSock(), makeMsg({ text: "الْآن" }), "الْآن"));
  ok(
    "keyword الآن misses an unrelated word",
    !(await runHook(fakeSock(), makeMsg({ text: "مرحبا" }), "مرحبا")),
  );

  wipeRules();
  autoDelete.createRule({ keywords: ["الآن"], match: "word" });
  ok(
    "word keyword الآن deletes الان",
    await runHook(fakeSock(), makeMsg({ text: "قل الان" }), "قل الان"),
  );
  ok(
    "word keyword الآن deletes الْآن",
    await runHook(fakeSock(), makeMsg({ text: "قل الْآن" }), "قل الْآن"),
  );
  ok(
    "word keyword الآن misses a longer token",
    !(await runHook(fakeSock(), makeMsg({ text: "قلالان" }), "قلالان")),
  );

  wipeRules();
  autoDelete.createRule({ keywords: ["Promo Code"], match: "word" });
  ok(
    "Promo Code still matches promo code",
    await runHook(fakeSock(), makeMsg({ text: "see PROMO code" }), "see PROMO code"),
  );

  wipeRules();
  const legacy = store.insertAutoDeleteRule({
    keywords: ["الان"],
    match: "contains",
    enabled: true,
  });
  equal("legacy normalized row is not rewritten", legacy.keywords[0], "الان");
  ok(
    "legacy normalized row still deletes الْآن",
    await runHook(fakeSock(), makeMsg({ text: "الْآن" }), "الْآن"),
  );

  wipeRules();
  const added = await runCommand(["add", "اشترك", "الآن", "|", "Promo", "Code"], "en");
  ok("command add keeps the typed spelling", added.includes("اشترك الآن, Promo Code"));
  ok("command add does not fold the alef", !added.includes("اشترك الان"));
  ok("command add does not lowercase", !added.includes("promo code"));
  const listed = await runCommand(["list"], "en");
  ok("command list keeps Arabic spelling", listed.includes("اشترك الآن"));
  ok("command list keeps Promo Code", listed.includes("Promo Code"));
  ok("command list does not lowercase", !listed.includes("promo code"));
}

section("validation");

{
  const err = (() => {
    try {
      autoDelete.createRule({ keywords: [] });
      return null;
    } catch (error) {
      return error;
    }
  })();
  ok("empty keywords throw", err?.status === 400);
  const long = "x".repeat(101);
  const err2 = (() => {
    try {
      autoDelete.createRule({ keywords: [long] });
      return null;
    } catch (error) {
      return error;
    }
  })();
  ok("overlong keyword throws", err2?.status === 400);
  const err3 = (() => {
    try {
      autoDelete.createRule({ keywords: ["ok"], match: "regex" });
      return null;
    } catch (error) {
      return error;
    }
  })();
  ok("bad match throws", err3?.status === 400);
}

section("API validation");

{
  const apiDir = mkdtempSync(join(tmpdir(), "levix-ad-api-"));
  const server = await startServer({ dataDir: apiDir, routes: true });
  const http = httpClient(server.base);
  try {
    let res = await http.call("/dashboard/api/auto-delete/rules");
    equal("API is session-gated", res.status, 401);

    res = await http.form("/setup", { password: "a-good-password", confirm: "a-good-password" });
    equal("setup signs in", res.status, 303);

    res = await http.json("/dashboard/api/auto-delete/rules", { keywords: [] });
    equal("empty keywords -> 400", res.status, 400);
    ok("empty keywords error is clear", /keyword/i.test((await res.json()).error || ""));

    res = await http.json("/dashboard/api/auto-delete/rules", { keywords: ["ok"], match: "regex" });
    equal("bad match -> 400", res.status, 400);

    res = await http.json("/dashboard/api/auto-delete/rules", {
      keywords: ["ok"],
      chatScope: "nowhere",
    });
    equal("bad chatScope -> 400", res.status, 400);

    res = await http.json("/dashboard/api/auto-delete/rules", {
      keywords: ["ok"],
      senders: { mode: "selected", list: [] },
    });
    equal("selected without senders -> 400", res.status, 400);

    res = await http.json("/dashboard/api/auto-delete/rules", {
      keywords: ["hello"],
      name: "n".repeat(61),
    });
    equal("name too long -> 400", res.status, 400);

    res = await http.json("/dashboard/api/auto-delete/rules", {
      keywords: ["Hello", "hello", "  HELLO  "],
      match: "word",
      keepCopy: true,
    });
    equal("create succeeds", res.status, 200);
    const created = await res.json();
    equal("keywords de-duplicated", created.rule.keywords.length, 1);
    equal("API create keeps the first spelling", created.rule.keywords[0], "Hello");
    ok("API create does not return the match form", created.rule.matchKeywords === undefined);
    const id = created.rule.id;

    res = await http.json(
      `/dashboard/api/auto-delete/rules/${id}`,
      { keywords: ["  اشترك   الآن  ", "Promo Code", "promo code"] },
      "PATCH",
    );
    equal("update keywords", res.status, 200);
    const updated = await res.json();
    equal(
      "API update keeps display form",
      updated.rule.keywords.join("|"),
      "اشترك الآن|Promo Code",
    );

    res = await http.call("/dashboard/api/auto-delete/rules");
    equal("list rules", res.status, 200);
    const listed = await res.json();
    equal(
      "API list keeps display form",
      listed.rules.find((rule) => rule.id === id)?.keywords?.join("|"),
      "اشترك الآن|Promo Code",
    );

    res = await http.json(`/dashboard/api/auto-delete/rules/${id}`, { enabled: false }, "PATCH");
    equal("patch toggle", res.status, 200);
    equal("enabled off", (await res.json()).rule.enabled, false);

    res = await http.call(`/dashboard/api/auto-delete/rules/${id}/reset`, { method: "POST" });
    equal("reset", res.status, 200);

    res = await http.call("/dashboard/api/auto-delete/log?limit=10");
    equal("log lists", res.status, 200);

    res = await http.call("/dashboard/api/auto-delete/log", { method: "DELETE" });
    equal("clear log", res.status, 200);

    res = await http.call(`/dashboard/api/auto-delete/rules/${id}`, { method: "DELETE" });
    equal("delete rule", res.status, 200);

    res = await http.json(`/dashboard/api/auto-delete/rules/${id}`, { enabled: true }, "PATCH");
    equal("missing rule -> 404", res.status, 404);
  } finally {
    server.stop();
  }
}

ok("auto_delete_keep_days setting exists", settings.get("auto_delete_keep_days") === 30);

finish();

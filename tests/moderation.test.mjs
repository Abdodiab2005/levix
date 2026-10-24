// Group moderation pipeline: identity-stable warnings, roster kicks, bot-admin
// gating, rule notices, and the shared Active-moderation summary.

import { readFileSync } from "node:fs";
import { equal, finish, ok, require, section, useTempDataDir } from "./harness.mjs";

useTempDataDir("levix-moderation");

const store = require("./src/db/store.cjs");
const permissions = require("./src/utils/permissions.cjs");
await permissions.primePermissions();

const groupMetadataCache = require("./src/utils/groupMetadataCache.cjs");
const { withLang } = require("./src/utils/i18n.cjs");
const {
  buildModerationSummary,
  buildModerationSummaryBoth,
  warnConfigOf,
  featureActionOf,
  policyFromFeatureAction,
} = require("./src/utils/moderationSummary.cjs");
const antilinkCommand = require("./src/commands/group/antilink.cjs");
const { handleAntiLink } = antilinkCommand;
const mediaCommand = require("./src/commands/group/media.cjs");
const { handleMediaControl } = mediaCommand;
const modCommand = require("./src/commands/mod.cjs");
const { handleForbiddenWords } = modCommand;
const kickCommand = require("./src/commands/group/kick.cjs");
const warnCommand = require("./src/commands/group/warn.cjs");
const rulesCommand = require("./src/commands/group/rules.cjs");
const promoteCommand = require("./src/commands/group/promote.cjs");
const demoteCommand = require("./src/commands/group/demote.cjs");
const setwarnCommand = require("./src/commands/group/setwarn.cjs");
const flaggedCommand = require("./src/commands/group/flagged.cjs");
const clearwarnsCommand = require("./src/commands/group/clearwarns.cjs");
const antispamCommand = require("./src/commands/group/antispam.cjs");
const { handleAntiSpam } = await import("../src/middleware/antispam.middleware.js");
const { handleGroupParticipantsUpdate } = await import("../src/handlers/group.handler.js");

const BOT_PN = "209999999999@s.whatsapp.net";
const BOT_LID = "999@lid";
const USER_PN = "201333333333@s.whatsapp.net";
const USER_LID = "333@lid";
const ADMIN_PN = "201111111111@s.whatsapp.net";
const ADMIN_LID = "111@lid";
const OTHER_PN = "201222222222@s.whatsapp.net";
const OTHER_LID = "222@lid";

store.storeLidPnMapping(USER_LID, USER_PN);
store.storeLidPnMapping(BOT_LID, BOT_PN);
store.storeLidPnMapping(ADMIN_LID, ADMIN_PN);
store.storeLidPnMapping(OTHER_LID, OTHER_PN);

function memberRoster(botAdmin = true) {
  return {
    subject: "Moderation group",
    participants: [
      { id: USER_LID, phoneNumber: USER_PN, admin: null },
      { id: ADMIN_LID, phoneNumber: ADMIN_PN, admin: "admin" },
      { id: BOT_LID, phoneNumber: BOT_PN, admin: botAdmin ? "admin" : null },
    ],
  };
}

function makeSock({ botAdmin = true, metadata, user } = {}) {
  const sent = [];
  const kicks = [];
  const meta = metadata || memberRoster(botAdmin);
  const sock = {
    user: user || { id: `${BOT_PN.split("@")[0]}:12@s.whatsapp.net`, lid: `${BOT_LID.split("@")[0]}:12@lid` },
    sent,
    kicks,
    async sendMessage(_jid, payload) {
      sent.push(payload);
      return { key: { id: `out-${sent.length}` } };
    },
    async groupParticipantsUpdate(_jid, users, action) {
      kicks.push({ users: [...users], action });
    },
    async groupMetadata() {
      return meta;
    },
  };
  return { sock, meta, sent, kicks };
}

function groupMsg(groupId, { text, image, participant = USER_LID, participantAlt = USER_PN } = {}) {
  const message = image
    ? { imageMessage: { caption: text || "" } }
    : { conversation: text || "hello" };
  return {
    key: {
      remoteJid: groupId,
      participant,
      participantAlt,
      fromMe: false,
    },
    message,
    pushName: "Member",
  };
}

function cache(groupId, meta) {
  groupMetadataCache.setCached(groupId, meta);
}

function texts(sent) {
  return sent.filter((payload) => typeof payload.text === "string").map((payload) => payload.text);
}

function hasDelete(sent) {
  return sent.some((payload) => payload.delete);
}

function mentionsOf(sent) {
  return sent.flatMap((payload) => payload.mentions || []);
}

function commandMsg(groupId, { participant = ADMIN_LID, mentioned } = {}) {
  return {
    key: { remoteJid: groupId, participant, fromMe: false },
    message: mentioned
      ? { extendedTextMessage: { contextInfo: { mentionedJid: mentioned } } }
      : { conversation: "cmd" },
    pushName: "Admin",
  };
}

section("summary builder");
{
  const both = buildModerationSummaryBoth({
    antilink: { enabled: true, mode: "ALL" },
    antispam: { enabled: true, time_window: 10, message_count: 5, action: "WARN" },
    media_control: { enabled: true, blocked_types: ["image", "sticker"] },
    warn_system: { max_warnings: 3, action: "KICK" },
    moderation: { forbiddenWords: { enabled: true, list: ["x", "y"] } },
  });
  ok("English names anti-link and its action", both.en.includes("Anti-link") && both.en.includes("delete and warn"));
  ok("English names anti-spam", both.en.includes("Anti-spam") && both.en.includes("warn"));
  ok("English names media", both.en.includes("photos") && both.en.includes("stickers"));
  ok("English names forbidden-word count", both.en.includes("Forbidden words: 2"));
  ok("English names warn limit and kick", both.en.includes("Warn limit: 3") && both.en.includes("remove the member"));
  ok("Arabic block is Arabic", /[\u0621-\u064A]/.test(both.ar) && both.ar.includes("الإشراف المفعّل"));
  ok("Arabic has no English feature labels", !both.ar.includes("Anti-link") && !both.ar.includes("Warn limit"));
  const unset = buildModerationSummary({}, "en");
  ok(
    "unset warn action is shown as kick at the default limit",
    unset.includes("Warn limit: 3") && unset.includes("remove the member"),
  );
  ok(
    "unset membership says leaving clears warnings",
    unset.includes("Leaving or being removed clears warnings."),
  );
  const keptSummary = buildModerationSummary({ moderationPolicy: { membership: "keep" } }, "en");
  ok(
    "explicit keep says leaving keeps warnings",
    keptSummary.includes("Leaving or being removed keeps warnings."),
  );
  equal("unset warnConfigOf action is KICK", warnConfigOf({}).action, "KICK");
  equal("unset warnConfigOf max stays 3", warnConfigOf({}).max_warnings, 3);
  const noneSummary = buildModerationSummary({ warn_system: { max_warnings: 4, action: "NONE" } }, "en");
  ok(
    "explicit NONE is shown as flag for admin review",
    noneSummary.includes("Warn limit: 4") && noneSummary.includes("flag for admin review"),
  );
  equal("explicit NONE reads as FLAG", warnConfigOf({ warn_system: { action: "NONE" } }).action, "FLAG");
  equal("explicit FLAG is kept", warnConfigOf({ warn_system: { action: "FLAG" } }).action, "FLAG");
  const flagSummary = buildModerationSummary(
    {
      antilink: { enabled: true, mode: "ALL", action: "DELETE" },
      antispam: { enabled: true, action: "KICK", time_window: 8, message_count: 4 },
      media_control: { enabled: true, blocked_types: ["image"], action: "KICK" },
      moderation: { forbiddenWords: { enabled: true, list: ["x"], action: "DELETE" } },
      warn_system: { max_warnings: 5, action: "FLAG" },
    },
    "en",
  );
  ok("summary names anti-link delete only", flagSummary.includes("Action: delete only"));
  ok("summary names anti-spam kick", flagSummary.includes("Action: remove the member"));
  ok("summary names media delete-and-remove", flagSummary.includes("Action: delete and remove the member"));
  ok("summary names warn-limit flag", flagSummary.includes("flag for admin review"));
  equal("unset antilink action is WARN", featureActionOf({}, "antilink"), "WARN");
  equal("unset antispam action is WARN", featureActionOf({}, "antispam"), "WARN");
  equal("DELETE policy does not warn", policyFromFeatureAction("DELETE").recordWarning, false);
  equal("WARN policy records a warning", policyFromFeatureAction("WARN").recordWarning, true);
  equal("KICK policy kicks immediately", policyFromFeatureAction("KICK").kickImmediately, true);
}

section("!kick uses the roster id, not the mention form");
{
  const groupId = "120363-kick@g.us";
  const { sock, meta, kicks } = makeSock();
  cache(groupId, meta);
  await kickCommand.execute(
    sock,
    {
      key: { remoteJid: groupId, participant: "201111111111@s.whatsapp.net" },
      message: { extendedTextMessage: { contextInfo: { mentionedJid: [USER_PN] } } },
      pushName: "Admin",
    },
    ["@member", "spam"],
    "",
    meta,
  );
  equal("kick is sent", kicks.length, 1);
  equal("kick JID is the roster LID", kicks[0].users[0], USER_LID);
}

section("!promote and !demote use the roster id, not the mention form");
{
  const groupId = "120363-promote@g.us";
  const { sock, meta, kicks } = makeSock();
  cache(groupId, meta);
  const mention = {
    key: { remoteJid: groupId, participant: "201111111111@s.whatsapp.net" },
    message: { extendedTextMessage: { contextInfo: { mentionedJid: [USER_PN] } } },
    pushName: "Admin",
  };
  await promoteCommand.execute(sock, mention, ["@member"], "", meta);
  equal("promote is sent", kicks.length, 1);
  equal("promote JID is the roster LID", kicks[0].users[0], USER_LID);
  equal("action is promote", kicks[0].action, "promote");

  kicks.length = 0;
  const adminMeta = {
    subject: "Moderation group",
    participants: [
      { id: USER_LID, phoneNumber: USER_PN, admin: "admin" },
      { id: BOT_LID, phoneNumber: BOT_PN, admin: "admin" },
    ],
  };
  cache(groupId, adminMeta);
  await demoteCommand.execute(sock, mention, ["@member"], "", adminMeta);
  equal("demote is sent", kicks.length, 1);
  equal("demote JID is the roster LID", kicks[0].users[0], USER_LID);
  equal("action is demote", kicks[0].action, "demote");

  kicks.length = 0;
  await promoteCommand.execute(sock, mention, ["@member"], "", adminMeta);
  equal("already-admin promote is skipped across LID/PN", kicks.length, 0);
}

section("!warn counts LID and PN as one person, then kicks on the roster id");
{
  const groupId = "120363-warn@g.us";
  const { sock, meta, kicks, sent } = makeSock();
  cache(groupId, meta);
  store.saveGroupSettings(groupId, { warn_system: { max_warnings: 2, action: "KICK" } });
  await withLang("en", () =>
    warnCommand.execute(
      sock,
      {
        key: { remoteJid: groupId, participant: BOT_PN },
        message: { extendedTextMessage: { contextInfo: { mentionedJid: [USER_LID] } } },
      },
      ["@u", "first"],
      "",
      meta,
    ),
  );
  equal("first warn stored under either form", store.getUserWarnings(groupId, USER_PN).length, 1);
  equal("no kick yet", kicks.length, 0);
  await withLang("en", () =>
    warnCommand.execute(
      sock,
      {
        key: { remoteJid: groupId, participant: BOT_PN },
        message: { extendedTextMessage: { contextInfo: { mentionedJid: [USER_PN] } } },
      },
      ["@u", "second"],
      "",
      meta,
    ),
  );
  equal("second warn via PN reaches the limit", kicks.length, 1);
  equal("auto-kick uses roster LID", kicks[0].users[0], USER_LID);
  equal("warnings cleared after kick", store.getUserWarnings(groupId, USER_LID).length, 0);
  ok(
    "warn notice includes count",
    texts(sent).some((text) => text.includes("Warnings: 2/2")),
  );
}

section("anti-link deletes, warns, and kicks at the group limit");
{
  const groupId = "120363-link@g.us";
  const { sock, meta, kicks, sent } = makeSock();
  cache(groupId, meta);
  store.saveGroupSettings(groupId, {
    antilink: { enabled: true, mode: "ALL", allowed_domains: [], blocked_domains: [] },
    warn_system: { max_warnings: 2, action: "KICK" },
  });
  const msg = groupMsg(groupId, { text: "see https://spam.example/now" });
  ok("first link is acted on", await withLang("en", () => handleAntiLink(sock, msg)));
  ok("message is deleted", hasDelete(sent));
  ok(
    "notice names the link rule",
    texts(sent).some((text) => text.includes("Links are not allowed in this group.")),
  );
  ok("notice shows 1/2", texts(sent).some((text) => text.includes("Warnings: 1/2")));
  equal("no kick on the first link", kicks.length, 0);
  sent.length = 0;
  ok("second link is acted on", await withLang("en", () => handleAntiLink(sock, msg)));
  equal("second link kicks", kicks.length, 1);
  equal("link kick uses roster LID", kicks[0].users[0], USER_LID);
  equal("link warnings cleared after kick", store.getUserWarnings(groupId, USER_PN).length, 0);
}

section("media control and forbidden words share the same warn/kick path");
{
  const groupId = "120363-media@g.us";
  const { sock, meta, kicks, sent } = makeSock();
  cache(groupId, meta);
  store.saveGroupSettings(groupId, {
    media_control: { enabled: true, blocked_types: ["image"] },
    moderation: { forbiddenWords: { enabled: true, list: ["forbidden"] } },
    warn_system: { max_warnings: 1, action: "KICK" },
  });
  const image = groupMsg(groupId, { image: true, text: "pic" });
  ok("blocked image is acted on", await withLang("en", () => handleMediaControl(sock, image)));
  equal("media kick at limit 1", kicks.length, 1);
  ok(
    "media notice names the type",
    texts(sent).some((text) => text.includes("photos are not allowed in this group.")),
  );

  const groupId2 = "120363-words@g.us";
  const second = makeSock();
  cache(groupId2, second.meta);
  store.saveGroupSettings(groupId2, {
    moderation: { forbiddenWords: { enabled: true, list: ["forbidden"] } },
    warn_system: { max_warnings: 1, action: "KICK" },
  });
  const wordMsg = groupMsg(groupId2, { text: "this is forbidden here" });
  ok("forbidden word is acted on", await withLang("en", () => handleForbiddenWords(second.sock, wordMsg)));
  equal("forbidden-word kick at limit 1", second.kicks.length, 1);
  ok(
    "forbidden-word notice names the rule",
    texts(second.sent).some((text) => text.includes("Forbidden words are not allowed in this group.")),
  );
}

section("anti-spam WARN counts toward the warn limit; KICK uses the roster id");
{
  const groupId = "120363-spam-warn@g.us";
  const { sock, meta, kicks, sent } = makeSock();
  cache(groupId, meta);
  store.saveGroupSettings(groupId, {
    antispam: { enabled: true, message_count: 2, time_window: 10, action: "WARN" },
    warn_system: { max_warnings: 1, action: "KICK" },
  });
  const msg = groupMsg(groupId, { text: "flood" });
  await handleAntiSpam(sock, msg);
  await handleAntiSpam(sock, msg);
  equal("under the spam window, no action yet", kicks.length, 0);
  await withLang("en", () => handleAntiSpam(sock, msg));
  equal("spam WARN at warn-limit 1 kicks", kicks.length, 1);
  equal("spam kick uses roster LID", kicks[0].users[0], USER_LID);
  ok(
    "spam notice names the rule",
    texts(sent).some((text) => text.includes("Spam is not allowed in this group.")),
  );

  const groupId2 = "120363-spam-kick@g.us";
  const immediate = makeSock();
  cache(groupId2, immediate.meta);
  store.saveGroupSettings(groupId2, {
    antispam: { enabled: true, message_count: 2, time_window: 10, action: "KICK" },
    warn_system: { max_warnings: 9, action: "FLAG" },
  });
  const flood = groupMsg(groupId2, { text: "flood" });
  await handleAntiSpam(immediate.sock, flood);
  await handleAntiSpam(immediate.sock, flood);
  await handleAntiSpam(immediate.sock, flood);
  equal("spam action KICK removes immediately", immediate.kicks.length, 1);
  equal("immediate spam kick uses roster LID", immediate.kicks[0].users[0], USER_LID);
}

section("anti-spam timestamps survive LID then PN on the same person");
{
  const groupId = "120363-spam-id@g.us";
  const unmappedLid = "777@lid";
  const unmappedPn = "201777777777@s.whatsapp.net";
  const metadata = {
    participants: [
      { id: unmappedLid, phoneNumber: unmappedPn, admin: null },
      { id: BOT_LID, phoneNumber: BOT_PN, admin: "admin" },
    ],
  };
  const { sock, kicks } = makeSock({ metadata });
  cache(groupId, metadata);
  store.saveGroupSettings(groupId, {
    antispam: { enabled: true, message_count: 2, time_window: 10, action: "KICK" },
  });
  const lidOnly = groupMsg(groupId, {
    text: "hi",
    participant: unmappedLid,
    participantAlt: undefined,
  });
  delete lidOnly.key.participantAlt;
  await handleAntiSpam(sock, lidOnly);
  await handleAntiSpam(sock, lidOnly);
  equal("two LID messages do not yet kick", kicks.length, 0);
  const withPn = groupMsg(groupId, {
    text: "hi",
    participant: unmappedLid,
    participantAlt: unmappedPn,
  });
  await handleAntiSpam(sock, withPn);
  equal("the PN follow-up shares the LID bucket and kicks", kicks.length, 1);
}

section("bot-admin check: skip WhatsApp actions when the bot is not admin");
{
  const groupId = "120363-noadmin@g.us";
  const { sock, meta, kicks, sent } = makeSock({ botAdmin: false });
  cache(groupId, meta);
  store.saveGroupSettings(groupId, {
    antilink: { enabled: true, mode: "ALL", allowed_domains: [], blocked_domains: [] },
    warn_system: { max_warnings: 1, action: "KICK" },
  });
  const msg = groupMsg(groupId, { text: "https://nope.example" });
  ok("link is still flagged", await withLang("en", () => handleAntiLink(sock, msg)));
  ok("delete is not attempted", !hasDelete(sent));
  equal("kick is not attempted", kicks.length, 0);
  equal("the warning is still recorded", store.getUserWarnings(groupId, USER_LID).length, 1);
  ok("KICK without bot admin records a flag", Boolean(store.getModerationFlag(groupId, USER_PN)));
  ok(
    "the group is told an admin must act",
    texts(sent).some((text) => text.includes("I am not a group admin, so an admin must act.")),
  );
  ok("the group's admins are mentioned", mentionsOf(sent).includes(ADMIN_LID));
}

section("bot-admin check: PN-only sock.user still sees a LID roster admin");
{
  const groupId = "120363-botpn@g.us";
  const metadata = {
    participants: [
      { id: USER_LID, admin: null },
      { id: BOT_LID, admin: "admin" },
    ],
  };
  const { sock, kicks } = makeSock({
    metadata,
    user: { id: `${BOT_PN.split("@")[0]}:7@s.whatsapp.net` },
  });
  cache(groupId, metadata);
  store.saveGroupSettings(groupId, {
    antilink: { enabled: true, mode: "ALL", allowed_domains: [], blocked_domains: [] },
    warn_system: { max_warnings: 1, action: "KICK" },
  });
  const msg = groupMsg(groupId, { text: "https://nope.example" });
  ok("acted with mapped bot admin", await withLang("en", () => handleAntiLink(sock, msg)));
  equal("kick proceeds when the bot is admin via mapping", kicks.length, 1);
}

section("unset warn action kicks at the limit; explicit NONE flags");
{
  const groupId = "120363-default-kick@g.us";
  const { sock, meta, kicks } = makeSock();
  cache(groupId, meta);
  store.saveGroupSettings(groupId, {
    antilink: { enabled: true, mode: "ALL", allowed_domains: [], blocked_domains: [] },
    warn_system: { max_warnings: 1 },
  });
  const msg = groupMsg(groupId, { text: "https://spam.example/now" });
  ok("unset action still flags the link", await withLang("en", () => handleAntiLink(sock, msg)));
  equal("unset action kicks at the warn limit", kicks.length, 1);

  const noneId = "120363-explicit-none@g.us";
  const none = makeSock();
  cache(noneId, none.meta);
  store.saveGroupSettings(noneId, {
    antilink: { enabled: true, mode: "ALL", allowed_domains: [], blocked_domains: [] },
    warn_system: { max_warnings: 1, action: "NONE" },
  });
  ok(
    "explicit NONE still acts on the link",
    await withLang("en", () =>
      handleAntiLink(none.sock, groupMsg(noneId, { text: "https://spam.example/now" })),
    ),
  );
  equal("explicit NONE does not kick", none.kicks.length, 0);
  ok("explicit NONE records a flag", Boolean(store.getModerationFlag(noneId, USER_PN)));

  const setId = "120363-setwarn-none@g.us";
  const set = makeSock();
  cache(setId, set.meta);
  store.saveGroupSettings(setId, {});
  const setMsg = { key: { remoteJid: setId } };
  await withLang("en", () => setwarnCommand.execute(set.sock, setMsg, ["max", "2"]));
  equal("setwarn max does not stamp an action", store.getGroupSettings(setId).warn_system.action, undefined);
  equal("setwarn max keeps the default kick", warnConfigOf(store.getGroupSettings(setId)).action, "KICK");
  equal("setwarn max keeps the chosen limit", store.getGroupSettings(setId).warn_system.max_warnings, 2);
  await withLang("en", () => setwarnCommand.execute(set.sock, setMsg, ["action", "NONE"]));
  equal("setwarn NONE persists as FLAG", store.getGroupSettings(setId).warn_system.action, "FLAG");
  equal("reader treats the stored value as FLAG", warnConfigOf(store.getGroupSettings(setId)).action, "FLAG");
  await withLang("en", () => setwarnCommand.execute(set.sock, setMsg, ["action", "FLAG"]));
  equal("setwarn can persist FLAG", store.getGroupSettings(setId).warn_system.action, "FLAG");
}

section("!rules and welcome append the same Active moderation block");
{
  const groupId = "120363-rules@g.us";
  const { sock, meta, sent } = makeSock();
  cache(groupId, meta);
  store.saveGroupSettings(groupId, {
    rules: "Be kind.",
    antilink: { enabled: true, mode: "WHITELIST", allowed_domains: ["example.com"] },
    warn_system: { max_warnings: 4, action: "FLAG" },
    welcome_system: { enabled: true, messages: ["Hi ${user}"] },
  });
  const summary = buildModerationSummary(
    store.getGroupSettings(groupId),
    "en",
  );
  await withLang("en", () =>
    rulesCommand.execute(sock, { key: { remoteJid: groupId }, pushName: "G" }, [], "", meta),
  );
  ok("rules include the custom text", texts(sent).some((text) => text.includes("Be kind.")));
  ok("rules append the summary", texts(sent).some((text) => text.includes(summary)));
  sent.length = 0;
  await withLang("en", () =>
    handleGroupParticipantsUpdate(sock, { id: groupId, participants: [USER_LID], action: "add" }),
  );
  ok("welcome keeps the greeting", texts(sent).some((text) => text.includes(`Hi @${USER_LID.split("@")[0]}`)));
  ok("welcome appends the same summary", texts(sent).some((text) => text.includes(summary)));
}

section("FLAG at the warn limit records and mentions admins without kicking");
{
  const groupId = "120363-flag-limit@g.us";
  const { sock, meta, kicks, sent } = makeSock();
  cache(groupId, meta);
  store.saveGroupSettings(groupId, {
    antilink: { enabled: true, mode: "ALL", allowed_domains: [], blocked_domains: [] },
    warn_system: { max_warnings: 1, action: "FLAG" },
  });
  ok(
    "link at FLAG limit is acted on",
    await withLang("en", () => handleAntiLink(sock, groupMsg(groupId, { text: "https://spam.example/now" }))),
  );
  equal("FLAG does not kick", kicks.length, 0);
  const flag = store.getModerationFlag(groupId, USER_PN);
  ok("a flag row is stored", Boolean(flag));
  equal("flag warn count matches", flag.warn_count, 1);
  equal("flag last rule is the feature", flag.last_rule, "link");
  ok("flag reasons include the domain", flag.reasons.some((reason) => String(reason).includes("antilink")));
  ok(
    "the group is told admins were notified",
    texts(sent).some((text) =>
      text.includes("The member reached the warning limit. Admins have been notified."),
    ),
  );
  ok("the group's admins are mentioned", mentionsOf(sent).includes(ADMIN_LID));
  ok("the bot is not mentioned as an admin", !mentionsOf(sent).includes(BOT_LID));
  equal("warnings stay on the member", store.getUserWarnings(groupId, USER_PN).length, 1);
}

section("each feature action option reaches the pipeline");
{
  const deleteId = "120363-feat-delete@g.us";
  const deleteSock = makeSock();
  cache(deleteId, deleteSock.meta);
  store.saveGroupSettings(deleteId, {
    antilink: { enabled: true, mode: "ALL", allowed_domains: [], blocked_domains: [], action: "DELETE" },
    warn_system: { max_warnings: 1, action: "KICK" },
  });
  ok(
    "DELETE still removes the link",
    await withLang("en", () =>
      handleAntiLink(deleteSock.sock, groupMsg(deleteId, { text: "https://spam.example/now" })),
    ),
  );
  ok("DELETE deletes the message", hasDelete(deleteSock.sent));
  equal("DELETE does not warn", store.getUserWarnings(deleteId, USER_PN).length, 0);
  equal("DELETE does not kick even at limit 1", deleteSock.kicks.length, 0);
  equal("DELETE does not flag", store.listModerationFlags(deleteId).length, 0);

  const kickNowId = "120363-feat-kick@g.us";
  const kickNow = makeSock();
  cache(kickNowId, kickNow.meta);
  store.saveGroupSettings(kickNowId, {
    antilink: { enabled: true, mode: "ALL", allowed_domains: [], blocked_domains: [], action: "KICK" },
    warn_system: { max_warnings: 9, action: "FLAG" },
  });
  ok(
    "feature KICK acts on the first link",
    await withLang("en", () =>
      handleAntiLink(kickNow.sock, groupMsg(kickNowId, { text: "https://spam.example/now" })),
    ),
  );
  equal("feature KICK removes immediately", kickNow.kicks.length, 1);
  equal("feature KICK uses the roster LID", kickNow.kicks[0].users[0], USER_LID);
  equal("a successful kick clears warnings", store.getUserWarnings(kickNowId, USER_PN).length, 0);
  equal("a successful kick clears the flag", store.listModerationFlags(kickNowId).length, 0);

  const mediaDeleteId = "120363-media-delete@g.us";
  const mediaDelete = makeSock();
  cache(mediaDeleteId, mediaDelete.meta);
  store.saveGroupSettings(mediaDeleteId, {
    media_control: { enabled: true, blocked_types: ["image"], action: "DELETE" },
    warn_system: { max_warnings: 1, action: "KICK" },
  });
  ok(
    "media DELETE acts",
    await withLang("en", () => handleMediaControl(mediaDelete.sock, groupMsg(mediaDeleteId, { image: true }))),
  );
  equal("media DELETE does not kick", mediaDelete.kicks.length, 0);
  equal("media DELETE does not warn", store.getUserWarnings(mediaDeleteId, USER_PN).length, 0);

  const mediaKickId = "120363-media-kick@g.us";
  const mediaKick = makeSock();
  cache(mediaKickId, mediaKick.meta);
  store.saveGroupSettings(mediaKickId, {
    media_control: { enabled: true, blocked_types: ["image"], action: "KICK" },
    warn_system: { max_warnings: 9, action: "FLAG" },
  });
  ok(
    "media KICK acts",
    await withLang("en", () => handleMediaControl(mediaKick.sock, groupMsg(mediaKickId, { image: true }))),
  );
  equal("media KICK removes immediately", mediaKick.kicks.length, 1);

  const wordsDeleteId = "120363-words-delete@g.us";
  const wordsDelete = makeSock();
  cache(wordsDeleteId, wordsDelete.meta);
  store.saveGroupSettings(wordsDeleteId, {
    moderation: { forbiddenWords: { enabled: true, list: ["forbidden"], action: "DELETE" } },
    warn_system: { max_warnings: 1, action: "KICK" },
  });
  ok(
    "forbidden DELETE acts",
    await withLang("en", () =>
      handleForbiddenWords(wordsDelete.sock, groupMsg(wordsDeleteId, { text: "this is forbidden here" })),
    ),
  );
  equal("forbidden DELETE does not kick", wordsDelete.kicks.length, 0);
  equal("forbidden DELETE does not warn", store.getUserWarnings(wordsDeleteId, USER_PN).length, 0);

  const wordsKickId = "120363-words-kick@g.us";
  const wordsKick = makeSock();
  cache(wordsKickId, wordsKick.meta);
  store.saveGroupSettings(wordsKickId, {
    moderation: { forbiddenWords: { enabled: true, list: ["forbidden"], action: "KICK" } },
    warn_system: { max_warnings: 9, action: "FLAG" },
  });
  ok(
    "forbidden KICK acts",
    await withLang("en", () =>
      handleForbiddenWords(wordsKick.sock, groupMsg(wordsKickId, { text: "this is forbidden here" })),
    ),
  );
  equal("forbidden KICK removes immediately", wordsKick.kicks.length, 1);
}

section("commands persist feature and warn-limit actions");
{
  const groupId = "120363-cmd-action@g.us";
  const { sock, meta } = makeSock();
  cache(groupId, meta);
  store.saveGroupSettings(groupId, {
    antilink: { enabled: true, mode: "ALL", allowed_domains: [], blocked_domains: [] },
    media_control: { enabled: true, blocked_types: ["image"] },
    antispam: { enabled: true, message_count: 5, time_window: 10 },
    moderation: { forbiddenWords: { enabled: true, list: ["x"] } },
  });
  const msg = commandMsg(groupId);
  await withLang("en", () => antilinkCommand.execute(sock, msg, ["action", "DELETE"]));
  equal("antilink action DELETE is stored", store.getGroupSettings(groupId).antilink.action, "DELETE");
  await withLang("en", () => mediaCommand.execute(sock, msg, ["action", "KICK"]));
  equal("media action KICK is stored", store.getGroupSettings(groupId).media_control.action, "KICK");
  await withLang("en", () => antispamCommand.execute(sock, msg, ["action", "KICK"]));
  equal("antispam action KICK is stored", store.getGroupSettings(groupId).antispam.action, "KICK");
  await withLang("en", () =>
    modCommand.execute(sock, msg, ["action", "forbiddenWords", "DELETE"], "", meta),
  );
  equal(
    "mod action stores forbidden DELETE",
    store.getGroupSettings(groupId).moderation.forbiddenWords.action,
    "DELETE",
  );
  await withLang("en", () =>
    modCommand.execute(sock, msg, ["action", "antiLink", "KICK"], "", meta),
  );
  equal("mod action stores antilink KICK", store.getGroupSettings(groupId).antilink.action, "KICK");
}

section("flagged list and clear paths from commands");
{
  const groupId = "120363-flagged-cmd@g.us";
  const { sock, meta, kicks, sent } = makeSock();
  cache(groupId, meta);
  store.saveGroupSettings(groupId, {
    antilink: { enabled: true, mode: "ALL", allowed_domains: [], blocked_domains: [] },
    warn_system: { max_warnings: 1, action: "FLAG" },
  });
  await withLang("en", () => handleAntiLink(sock, groupMsg(groupId, { text: "https://spam.example/now" })));
  equal("the member is flagged", store.listModerationFlags(groupId).length, 1);

  sent.length = 0;
  await withLang("en", () => flaggedCommand.execute(sock, commandMsg(groupId)));
  ok(
    "flagged list names the member",
    texts(sent).some((text) => text.includes("*Flagged members*") && text.includes("@")),
  );
  ok("flagged list mentions the member", mentionsOf(sent).includes(USER_PN) || mentionsOf(sent).includes(USER_LID));

  await withLang("en", () =>
    clearwarnsCommand.execute(sock, commandMsg(groupId, { mentioned: [USER_PN] })),
  );
  equal("clearwarns drops the flag", store.listModerationFlags(groupId).length, 0);
  equal("clearwarns drops warnings", store.getUserWarnings(groupId, USER_PN).length, 0);

  store.saveGroupSettings(groupId, {
    antilink: { enabled: true, mode: "ALL", allowed_domains: [], blocked_domains: [] },
    warn_system: { max_warnings: 1, action: "FLAG" },
  });
  await withLang("en", () => handleAntiLink(sock, groupMsg(groupId, { text: "https://spam.example/now" })));
  equal("the member is flagged again", store.listModerationFlags(groupId).length, 1);
  kicks.length = 0;
  await withLang("en", () =>
    kickCommand.execute(sock, commandMsg(groupId, { mentioned: [USER_PN] }), ["@member", "review"], "", meta),
  );
  equal("kick of a flagged member is sent", kicks.length, 1);
  equal("kick of a flagged member clears the flag", store.listModerationFlags(groupId).length, 0);
  equal("kick of a flagged member clears warnings", store.getUserWarnings(groupId, USER_PN).length, 0);
}

function withId(groupId, id, options = {}) {
  const msg = groupMsg(groupId, options);
  msg.key.id = id;
  return msg;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const policyService = require("./src/services/moderationPolicy.cjs");
const { enforceHits, clearMemberModeration, dismissMemberFlag } = require("./src/utils/moderationAction.cjs");
const defaults = require("./src/config/defaults.cjs");
const policyCommand = require("./src/commands/group/policy.cjs");
const { handleGroupModeration } = await import("../src/handlers/message.handler.js");

section("moderation policy resolve, validate, presets, and points");
{
  equal(
    "policy command is admins only",
    defaults.command_permissions.group.sub_commands.policy,
    "ADMINS_ONLY",
  );
  const legacy = policyService.resolveModerationPolicy({
    warn_system: { action: "FLAG", max_warnings: 4 },
    antilink: { action: "DELETE" },
  });
  equal("legacy FLAG is the effective limit action", legacy.limitAction, "FLAG");
  equal("legacy max is the effective limit", legacy.limit, 4);
  equal("legacy antilink DELETE is the effective feature action", legacy.features.antilink, "DELETE");
  const override = policyService.resolveModerationPolicy({
    warn_system: { action: "FLAG", max_warnings: 4 },
    antilink: { action: "DELETE" },
    moderationPolicy: { limitAction: "KICK", features: { antilink: null } },
  });
  equal("a policy field overrides the legacy action", override.limitAction, "KICK");
  equal("explicit null overrides a legacy feature action", override.features.antilink, null);

  const unknown = policyService.validateModerationPolicy({ nope: true }, {});
  ok("unknown key is rejected", unknown.errors.some((item) => item.code === "unknown"));
  const spamDelete = policyService.validateModerationPolicy({ features: { antispam: "DELETE" } }, {});
  ok("antispam DELETE is an enum error", spamDelete.errors.some((item) => item.field === "features.antispam" && item.code === "enum"));
  const order = policyService.validateModerationPolicy({ mode: "severity", kickAt: 3, flagAt: 3 }, {});
  ok("kickAt <= flagAt is a conflict", order.errors.some((item) => item.code === "conflict"));
  const escalate = policyService.validateModerationPolicy(
    { mode: "severity", flag: { whileFlagged: "escalate" }, kickAt: 5, flagAt: 3 },
    {},
  );
  ok("escalate in severity is a conflict", escalate.errors.some((item) => item.field === "flag.whileFlagged" && item.code === "conflict"));
  const silentKick = policyService.validateModerationPolicy({ flag: { notify: "silent" } }, {});
  ok("flag.notify on simple KICK is a conflict", silentKick.errors.some((item) => item.code === "conflict"));
  ok("limit 0 is a range error", policyService.validateModerationPolicy({ limit: 0 }, {}).errors.some((item) => item.field === "limit" && item.code === "range"));
  ok("limit 51 is a range error", policyService.validateModerationPolicy({ limit: 51 }, {}).errors.some((item) => item.field === "limit" && item.code === "range"));
  ok("limit 1.5 is a type error", policyService.validateModerationPolicy({ limit: 1.5 }, {}).errors.some((item) => item.field === "limit" && item.code === "type"));
  ok("limit string is a type error", policyService.validateModerationPolicy({ limit: "3" }, {}).errors.some((item) => item.field === "limit" && item.code === "type"));

  const presetId = "120363-preset-standard@g.us";
  store.saveGroupSettings(presetId, {
    warn_system: { max_warnings: 9, action: "FLAG" },
    antilink: { enabled: true, mode: "ALL", action: "DELETE", allowed_domains: [], blocked_domains: [] },
  });
  policyService.applyModerationPreset(presetId, "standard");
  const standard = store.getGroupSettings(presetId);
  equal("standard preset removes the stored action", standard.warn_system.action, undefined);
  equal("standard preset removes the stored limit", standard.warn_system.max_warnings, undefined);
  equal("standard preset removes a legacy feature action", standard.antilink.action, undefined);
  equal("standard preset removes moderationPolicy", standard.moderationPolicy, undefined);
  equal("standard preset reads as KICK", warnConfigOf(standard).action, "KICK");
  equal("standard preset reads as limit 3", warnConfigOf(standard).max_warnings, 3);
  equal("standard preset keeps the antilink toggle", standard.antilink.enabled, true);
  equal(
    "standard preset membership is clear",
    policyService.resolveModerationPolicy(standard).membership,
    "clear",
  );

  for (const name of ["relaxed", "strict"]) {
    const presetGroup = `120363-preset-${name}@g.us`;
    store.saveGroupSettings(presetGroup, {
      moderationPolicy: { membership: "keep", limit: 9 },
      antilink: { enabled: true, action: "DELETE" },
    });
    policyService.applyModerationPreset(presetGroup, name);
    const applied = store.getGroupSettings(presetGroup);
    equal(`${name} does not store membership`, applied.moderationPolicy.membership, undefined);
    equal(
      `${name} inherits clear`,
      policyService.resolveModerationPolicy(applied).membership,
      "clear",
    );
  }

  const now = Date.parse("2026-10-24T00:00:00.000Z");
  const expire = policyService.resolveModerationPolicy({
    moderationPolicy: { decay: { mode: "expire", days: 30 } },
  });
  const at = (days) => new Date(now - days * DAY_MS).toISOString();
  equal("a 31-day-old event expires", policyService.effectivePoints([{ points: 1, date: at(31) }], expire, now), 0);
  equal("a 29-day-old event still counts", policyService.effectivePoints([{ points: 1, date: at(29) }], expire, now), 1);
  const step = policyService.resolveModerationPolicy({
    moderationPolicy: { decay: { mode: "step", days: 7 } },
  });
  const stepped = (days) =>
    policyService.effectivePoints([{ points: 3, date: at(days) }], step, now);
  equal("step day 0 keeps 3", stepped(0), 3);
  equal("step day 7 keeps 2", stepped(7), 2);
  equal("step day 14 keeps 1", stepped(14), 1);
  equal("step day 21 keeps 0", stepped(21), 0);
  equal("a dateless event does not decay", policyService.effectivePoints([{ reason: "legacy" }], step, now), 1);
}

section("one message with two hits is one ledger event");
{
  const groupId = "120363-combo-hit@g.us";
  const { sock, meta, sent, kicks } = makeSock();
  cache(groupId, meta);
  store.saveGroupSettings(groupId, {
    antilink: { enabled: true, mode: "ALL", action: "KICK", allowed_domains: [], blocked_domains: [] },
    moderation: { forbiddenWords: { enabled: true, list: ["secret"] } },
  });
  let during = null;
  sock.groupParticipantsUpdate = async (_jid, users, action) => {
    during = store.getUserWarnings(groupId, USER_PN).map((event) => ({
      ...event,
      rules: Array.isArray(event.rules) ? event.rules.slice() : event.rules,
    }));
    kicks.push({ users: [...users], action });
  };
  const result = await withLang("en", () =>
    handleGroupModeration(sock, withId(groupId, "combo-1", { text: "secret https://bad.example/x" })),
  );
  equal("combined hit last rule is the link", result.lastRule, "link");
  equal("the ledger has one event during the kick", during.length, 1);
  ok("the event reason is the link", String(during[0].reason).startsWith("antilink:"));
  ok("the event lists both rules", during[0].rules.includes("forbidden") && during[0].rules.includes("link"));
  equal("simple mode stores one point", during[0].points, 1);
  equal("a successful kick clears the ledger", store.getUserWarnings(groupId, USER_PN).length, 0);
  equal("one kick is sent", kicks.length, 1);
  equal("the message is deleted once", sent.filter((payload) => payload.delete).length, 1);
}

section("the same message id is applied once");
{
  const groupId = "120363-dedup-id@g.us";
  const { sock, meta, sent } = makeSock();
  cache(groupId, meta);
  store.saveGroupSettings(groupId, {
    antilink: { enabled: true, mode: "ALL", allowed_domains: [], blocked_domains: [] },
  });
  const msg = withId(groupId, "same-id", { text: "https://spam.example/once" });
  await withLang("en", () => handleGroupModeration(sock, msg));
  await withLang("en", () => handleGroupModeration(sock, msg));
  equal("a redelivery adds one warning", store.getUserWarnings(groupId, USER_PN).length, 1);
  equal(
    "a redelivery sends one notice",
    texts(sent).filter((text) => text.includes("Warnings:")).length,
    1,
  );
  equal("the claim row exists", store.getModerationApplied(groupId, "same-id").outcome, "warn");
}

section("two message ids reach two points");
{
  const groupId = "120363-two-ids@g.us";
  const { sock, meta } = makeSock();
  cache(groupId, meta);
  store.saveGroupSettings(groupId, {
    antilink: { enabled: true, mode: "ALL", allowed_domains: [], blocked_domains: [] },
  });
  await withLang("en", () =>
    handleGroupModeration(sock, withId(groupId, "id-a", { text: "https://spam.example/a" })),
  );
  await withLang("en", () =>
    handleGroupModeration(sock, withId(groupId, "id-b", { text: "https://spam.example/b" })),
  );
  const rows = store.getUserWarnings(groupId, USER_PN);
  equal("two commits store two events", rows.length, 2);
  equal("two commits store two points", rows.reduce((sum, event) => sum + event.points, 0), 2);
}

section("severity weights cap the points added by one message");
{
  const maxId = "120363-weight-max@g.us";
  const { sock, meta } = makeSock();
  cache(maxId, meta);
  store.saveGroupSettings(maxId, {
    moderationPolicy: {
      mode: "severity",
      hitMerge: "max",
      weights: { forbidden: 2, antilink: 3 },
      flagAt: 40,
      kickAt: 50,
    },
  });
  await enforceHits(sock, {
    msg: withId(maxId, "max-1"),
    groupMetadata: meta,
    hits: [
      { rule: "forbidden", reason: "forbidden-word" },
      { rule: "link", reason: "antilink:a.example" },
    ],
  });
  equal("hitMerge max stores the larger weight", store.getUserWarnings(maxId, USER_PN)[0].points, 3);

  const sumId = "120363-weight-sum@g.us";
  store.saveGroupSettings(sumId, {
    moderationPolicy: {
      mode: "severity",
      hitMerge: "sum",
      weights: { forbidden: 2, antilink: 3 },
      flagAt: 40,
      kickAt: 50,
    },
  });
  await enforceHits(sock, {
    msg: withId(sumId, "sum-1"),
    groupMetadata: meta,
    hits: [
      { rule: "forbidden", reason: "forbidden-word" },
      { rule: "link", reason: "antilink:a.example" },
    ],
  });
  equal("hitMerge sum stores both weights", store.getUserWarnings(sumId, USER_PN)[0].points, 5);

  const capId = "120363-weight-cap@g.us";
  const capped = makeSock({ botAdmin: false });
  cache(capId, capped.meta);
  store.saveGroupSettings(capId, {
    moderationPolicy: {
      mode: "severity",
      hitMerge: "sum",
      weights: { antispam: 10 },
      flagAt: 49,
      kickAt: 50,
    },
  });
  await enforceHits(capped.sock, {
    msg: withId(capId, "cap-1"),
    groupMetadata: capped.meta,
    hits: Array.from({ length: 6 }, () => ({ rule: "spam", reason: "antispam" })),
  });
  equal("sum past 50 stores 50", store.getUserWarnings(capId, USER_PN)[0].points, 50);
}

section("membership defaults to clear; keep is explicit");
{
  const clearId = "120363-member-clear@g.us";
  const keepId = "120363-member-keep@g.us";
  const addId = "120363-member-add@g.us";
  const leaveId = "120363-member-leave@g.us";
  const seed = (groupId) => {
    store.saveUserWarnings(groupId, USER_PN, [
      { reason: "antilink:x", by: "system", date: new Date().toISOString() },
    ]);
    store.upsertModerationFlag(groupId, USER_PN, {
      warnCount: 1,
      lastRule: "link",
      reasons: ["antilink:x"],
    });
  };
  store.saveGroupSettings(clearId, {});
  store.saveGroupSettings(keepId, { moderationPolicy: { membership: "keep" } });
  store.saveGroupSettings(addId, {});
  store.saveGroupSettings(leaveId, {});
  for (const groupId of [clearId, keepId, addId, leaveId]) seed(groupId);
  equal("unset membership resolves to clear", policyService.resolveModerationPolicy({}).membership, "clear");

  await handleGroupParticipantsUpdate({}, { id: clearId, participants: [USER_LID], action: "remove" });
  equal("leaving the group clears the count", store.getUserWarnings(clearId, USER_PN).length, 0);
  equal("leaving the group clears the flag", store.getModerationFlag(clearId, USER_PN), null);
  await handleGroupParticipantsUpdate({}, { id: clearId, participants: [USER_LID], action: "remove" });
  equal("a second clear is a no-op", store.getUserWarnings(clearId, USER_PN).length, 0);
  await handleGroupParticipantsUpdate({}, { id: clearId, participants: [USER_LID], action: "add" });
  equal("rejoin starts at 0", store.getUserWarnings(clearId, USER_PN).length, 0);

  await handleGroupParticipantsUpdate({}, { id: keepId, participants: [USER_LID], action: "remove" });
  equal("leaving the group keeps the count", store.getUserWarnings(keepId, USER_PN).length, 1);
  equal("explicit keep leaves the flag", store.getModerationFlag(keepId, USER_PN).last_rule, "link");

  await handleGroupParticipantsUpdate({}, { id: addId, participants: [USER_LID], action: "add" });
  equal("add does not clear warnings", store.getUserWarnings(addId, USER_PN).length, 1);
  equal("add does not clear the flag", store.getModerationFlag(addId, USER_PN).warn_count, 1);

  await handleGroupParticipantsUpdate({}, { id: leaveId, participants: [USER_PN], action: "leave" });
  equal("a leave event clears warnings", store.getUserWarnings(leaveId, USER_PN).length, 0);
  equal("a leave event clears the flag", store.getModerationFlag(leaveId, USER_PN), null);
}

section("clear drops the ledger and dismiss drops only the flag");
{
  const groupId = "120363-clear-dismiss@g.us";
  const { sock, meta } = makeSock();
  cache(groupId, meta);
  store.saveGroupSettings(groupId, {
    antilink: { enabled: true, mode: "ALL", allowed_domains: [], blocked_domains: [] },
    warn_system: { max_warnings: 1, action: "FLAG" },
  });
  await withLang("en", () => handleAntiLink(sock, groupMsg(groupId, { text: "https://spam.example/flag" })));
  equal("the limit flags the member", store.listModerationFlags(groupId).length, 1);
  dismissMemberFlag(groupId, USER_PN);
  equal("dismiss removes the flag", store.listModerationFlags(groupId).length, 0);
  equal("dismiss keeps warnings", store.getUserWarnings(groupId, USER_PN).length, 1);
  equal("dismiss does not flag on its own", store.listModerationFlags(groupId).length, 0);
  await withLang("en", () => handleAntiLink(sock, groupMsg(groupId, { text: "https://spam.example/again" })));
  equal("the next hit at the limit flags again", store.listModerationFlags(groupId).length, 1);
  clearMemberModeration(groupId, USER_PN);
  equal("clear removes the flag", store.listModerationFlags(groupId).length, 0);
  equal("clear removes warnings", store.getUserWarnings(groupId, USER_PN).length, 0);
}

section("hold leaves points unchanged and escalate kicks on the extra points");
{
  const holdId = "120363-flag-hold@g.us";
  const { sock, meta, sent } = makeSock();
  cache(holdId, meta);
  store.saveGroupSettings(holdId, {
    antilink: { enabled: true, mode: "ALL", allowed_domains: [], blocked_domains: [] },
  });
  policyService.applyModerationPolicy(holdId, {
    limit: 1,
    limitAction: "FLAG",
    flag: { whileFlagged: "hold" },
  });
  await withLang("en", () =>
    handleGroupModeration(sock, withId(holdId, "hold-1", { text: "https://spam.example/hold" })),
  );
  equal("the opening hit stores one warning", store.getUserWarnings(holdId, USER_PN).length, 1);
  sent.length = 0;
  await withLang("en", () =>
    handleGroupModeration(sock, withId(holdId, "hold-2", { text: "https://spam.example/hold2" })),
  );
  equal("hold does not append a point", store.getUserWarnings(holdId, USER_PN).length, 1);
  equal("hold still deletes the message", sent.filter((payload) => payload.delete).length, 1);

  const escId = "120363-flag-escalate@g.us";
  const esc = makeSock();
  cache(escId, esc.meta);
  store.saveGroupSettings(escId, {
    antilink: { enabled: true, mode: "ALL", allowed_domains: [], blocked_domains: [] },
  });
  policyService.applyModerationPolicy(escId, {
    limit: 1,
    limitAction: "FLAG",
    flag: { whileFlagged: "escalate", escalateAfter: 2 },
  });
  await withLang("en", () =>
    handleGroupModeration(esc.sock, withId(escId, "esc-1", { text: "https://spam.example/e1" })),
  );
  equal("the opening flag stores zero repeat points", store.getModerationFlag(escId, USER_PN).repeat_points, 0);
  equal("the opening flag does not kick", esc.kicks.length, 0);
  await withLang("en", () =>
    handleGroupModeration(esc.sock, withId(escId, "esc-2", { text: "https://spam.example/e2" })),
  );
  equal("the first extra point does not kick", esc.kicks.length, 0);
  equal("repeat points follow the extra point", store.getModerationFlag(escId, USER_PN).repeat_points, 1);
  await withLang("en", () =>
    handleGroupModeration(esc.sock, withId(escId, "esc-3", { text: "https://spam.example/e3" })),
  );
  equal("escalateAfter kicks on the next extra point", esc.kicks.length, 1);
}

section("silent flag notices and flag cooldown");
{
  const silentId = "120363-flag-silent@g.us";
  const silent = makeSock({ botAdmin: false });
  cache(silentId, silent.meta);
  store.saveGroupSettings(silentId, {
    antilink: { enabled: true, mode: "ALL", allowed_domains: [], blocked_domains: [] },
  });
  policyService.applyModerationPolicy(silentId, {
    limitAction: "FLAG",
    flag: { notify: "silent" },
  });
  policyService.applyModerationPolicy(silentId, { limitAction: "KICK", limit: 1 });
  await withLang("en", () =>
    handleGroupModeration(silent.sock, withId(silentId, "silent-1", { text: "https://spam.example/silent" })),
  );
  const silentText = texts(silent.sent).join("\n");
  ok("a blocked kick still says an admin must act", silentText.includes("an admin must act"));
  ok("silent notify skips the flag notice", !silentText.includes("Admins have been notified"));
  ok("the blocked kick still mentions an admin", mentionsOf(silent.sent).includes(ADMIN_LID));
  equal("the blocked kick writes a flag", store.listModerationFlags(silentId).length, 1);

  const coolId = "120363-flag-cool@g.us";
  const cool = makeSock();
  cache(coolId, cool.meta);
  store.saveGroupSettings(coolId, {
    antilink: { enabled: true, mode: "ALL", allowed_domains: [], blocked_domains: [] },
  });
  policyService.applyModerationPolicy(coolId, {
    limit: 1,
    limitAction: "FLAG",
    flag: { notify: "group", cooldownMinutes: 60 },
  });
  await withLang("en", () =>
    handleGroupModeration(cool.sock, withId(coolId, "cool-1", { text: "https://spam.example/c1" })),
  );
  ok(
    "the first flag notice is sent",
    texts(cool.sent).some((text) => text.includes("Admins have been notified")),
  );
  cool.sent.length = 0;
  await withLang("en", () =>
    handleGroupModeration(cool.sock, withId(coolId, "cool-2", { text: "https://spam.example/c2" })),
  );
  ok(
    "cooldown suppresses the second flag notice",
    !texts(cool.sent).some((text) => text.includes("Admins have been notified")),
  );
  equal("cooldown still updates the flag", store.getModerationFlag(coolId, USER_PN).warn_count, 2);
}

section("a protected sender is not claimed");
{
  const groupId = "120363-protected-claim@g.us";
  const { sock, meta } = makeSock();
  cache(groupId, meta);
  store.saveGroupSettings(groupId, {
    antilink: { enabled: true, mode: "ALL", allowed_domains: [], blocked_domains: [] },
  });
  await handleGroupModeration(
    sock,
    withId(groupId, "admin-1", {
      text: "https://spam.example/admin",
      participant: ADMIN_LID,
      participantAlt: ADMIN_PN,
    }),
  );
  equal("a group admin is not claimed", store.getModerationApplied(groupId, "admin-1"), null);
  equal("a group admin gains no warning", store.getUserWarnings(groupId, ADMIN_PN).length, 0);
  await handleGroupModeration(sock, groupMsg(groupId, { text: "https://spam.example/noid" }));
  equal("a message without an id is not enforced", store.getUserWarnings(groupId, USER_PN).length, 0);
}

section("the command and the panel persist the same limit");
{
  const express = (await import("express")).default;
  const { default: routes } = await import("../src/routes/dashboard.api.esm.js");
  const app = express();
  app.use(express.json());
  app.use(routes);
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const port = server.address().port;
  async function call(method, path, body) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, json: await response.json() };
  }
  try {
    const cmdGroup = "120363-policy-cmd@g.us";
    const apiGroup = "120363-policy-api@g.us";
    const badGroup = "120363-policy-bad@g.us";
    const starting = { warn_system: { max_warnings: 3, action: "KICK" } };
    store.saveGroupSettings(cmdGroup, JSON.parse(JSON.stringify(starting)));
    store.saveGroupSettings(apiGroup, JSON.parse(JSON.stringify(starting)));
    store.saveGroupSettings(badGroup, { ...starting, rules: "keep-me" });
    const { sock } = makeSock();
    await withLang("en", () => policyCommand.execute(sock, commandMsg(cmdGroup), ["set", "limit", "4"]));
    const patched = await call("PATCH", `/groups/${encodeURIComponent(apiGroup)}`, {
      moderation_policy: { limit: 4 },
    });
    equal("panel limit patch succeeds", patched.status, 200);
    equal("panel response includes the effective limit", patched.json.group.moderation_policy.limit, 4);
    equal("panel response includes visibility", patched.json.group.moderation_policy_visibility.limit, true);
    const commandSettings = store.getGroupSettings(cmdGroup);
    const panelSettings = store.getGroupSettings(apiGroup);
    equal("command and panel store the same max_warnings", commandSettings.warn_system.max_warnings, panelSettings.warn_system.max_warnings);
    equal("both limits are 4", commandSettings.warn_system.max_warnings, 4);
    equal(
      "command and panel store the same moderationPolicy",
      JSON.stringify(commandSettings.moderationPolicy),
      JSON.stringify(panelSettings.moderationPolicy),
    );
    equal("setting the limit does not change the stored action", commandSettings.warn_system.action, "KICK");

    const rejected = await call("PATCH", `/groups/${encodeURIComponent(badGroup)}`, {
      moderation_policy: { limit: 0 },
      rules: "changed",
    });
    equal("an invalid policy is HTTP 400", rejected.status, 400);
    equal("an invalid policy reports failure", rejected.json.success, false);
    ok("an invalid policy returns errors", rejected.json.errors.some((item) => item.code === "range"));
    equal("an invalid policy writes nothing", store.getGroupSettings(badGroup).rules, "keep-me");
    equal("an invalid policy does not store moderationPolicy", store.getGroupSettings(badGroup).moderationPolicy, undefined);

    const preview = await call("POST", "/groups/moderation-preview", {
      moderation_policy: { mode: "severity", flagAt: 4, kickAt: 4 },
    });
    equal("preview stays HTTP 200", preview.status, 200);
    equal("preview success stays true", preview.json.success, true);
    equal("severity hides the limit", preview.json.visibility.limit, false);
    ok("preview returns English", typeof preview.json.en === "string" && preview.json.en.includes("Warn limit"));
    ok("preview returns Arabic", typeof preview.json.ar === "string" && preview.json.ar.includes("حد الإنذارات"));
    ok(
      "preview reports the kickAt conflict",
      preview.json.errors.some((item) => item.code === "conflict" && item.field === "kickAt"),
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

section("the first mention is the only kick, promote, and demote target");
{
  const groupId = "120363-two-mentions@g.us";
  const metadata = {
    subject: "Moderation group",
    participants: [
      { id: OTHER_LID, phoneNumber: OTHER_PN, admin: null },
      { id: USER_LID, phoneNumber: USER_PN, admin: null },
      { id: ADMIN_LID, phoneNumber: ADMIN_PN, admin: "admin" },
      { id: BOT_LID, phoneNumber: BOT_PN, admin: "admin" },
    ],
  };
  const { sock, kicks } = makeSock({ metadata });
  cache(groupId, metadata);
  const mention = {
    key: { remoteJid: groupId, participant: ADMIN_PN },
    message: {
      extendedTextMessage: { contextInfo: { mentionedJid: [USER_PN, OTHER_PN] } },
    },
    pushName: "Admin",
  };
  await kickCommand.execute(sock, mention, ["@member", "@other", "spam"], "", metadata);
  equal("two mentions kick once", kicks.length, 1);
  equal("kick uses the first mention", kicks[0].users[0], USER_LID);

  kicks.length = 0;
  await promoteCommand.execute(sock, mention, ["@member", "@other"], "", metadata);
  equal("two mentions promote once", kicks.length, 1);
  equal("promote uses the first mention", kicks[0].users[0], USER_LID);
  equal("promote action is promote", kicks[0].action, "promote");

  kicks.length = 0;
  const demoteMeta = {
    ...metadata,
    participants: metadata.participants.map((participant) =>
      participant.id === USER_LID || participant.id === OTHER_LID
        ? { ...participant, admin: "admin" }
        : participant,
    ),
  };
  cache(groupId, demoteMeta);
  await demoteCommand.execute(sock, mention, ["@member", "@other"], "", demoteMeta);
  equal("two mentions demote once", kicks.length, 1);
  equal("demote uses the first mention", kicks[0].users[0], USER_LID);

  kicks.length = 0;
  const aliasMeta = {
    subject: "Moderation group",
    participants: [
      { id: OTHER_LID, admin: null },
      { id: USER_LID, admin: null },
      { id: ADMIN_LID, admin: "admin" },
      { id: BOT_LID, admin: "admin" },
    ],
  };
  cache(groupId, aliasMeta);
  await kickCommand.execute(
    sock,
    {
      key: { remoteJid: groupId, participant: ADMIN_PN },
      message: { extendedTextMessage: { contextInfo: { mentionedJid: [USER_PN] } } },
      pushName: "Admin",
    },
    ["@member"],
    "",
    aliasMeta,
  );
  equal("a phone mention kicks the mapped roster lid", kicks.length, 1);
  equal("mapped kick jid is the roster lid", kicks[0].users[0], USER_LID);
}

section("a legacy warn limit above 50 is kept; new writes stay 1-50");
{
  equal(
    "legacy max 100 resolves to 100",
    policyService.resolveModerationPolicy({ warn_system: { max_warnings: 100, action: "KICK" } }).limit,
    100,
  );
  equal(
    "legacy max 0 stays the default",
    policyService.resolveModerationPolicy({ warn_system: { max_warnings: 0 } }).limit,
    3,
  );
  ok(
    "a new limit of 100 is rejected",
    policyService
      .validateModerationPolicy({ limit: 100 }, {})
      .errors.some((item) => item.field === "limit" && item.code === "range"),
  );
  const groupId = "120363-legacy-100@g.us";
  const { sock, meta, kicks } = makeSock();
  cache(groupId, meta);
  store.saveGroupSettings(groupId, { warn_system: { max_warnings: 100, action: "KICK" } });
  for (const [index, reason] of ["one", "two", "three"].entries()) {
    await withLang("en", () =>
      warnCommand.execute(
        sock,
        {
          key: { remoteJid: groupId, participant: ADMIN_PN, id: `legacy-100-${index}` },
          message: { extendedTextMessage: { contextInfo: { mentionedJid: [USER_LID] } } },
        },
        ["@u", reason],
        "",
        meta,
      ),
    );
  }
  equal("three warnings do not kick at a legacy limit of 100", kicks.length, 0);
  equal("all three warnings stay on the ledger", store.getUserWarnings(groupId, USER_PN).length, 3);
}

section("a leave participant object clears every identity it carries");
{
  const groupId = "120363-leave-object@g.us";
  store.saveGroupSettings(groupId, {});
  store.saveUserWarnings(groupId, USER_LID, [
    { reason: "antilink:x", by: "system", date: new Date().toISOString() },
  ]);
  store.upsertModerationFlag(groupId, USER_LID, {
    warnCount: 1,
    lastRule: "link",
    reasons: ["antilink:x"],
  });
  await handleGroupParticipantsUpdate(
    {},
    {
      id: groupId,
      participants: [
        { id: USER_LID, lid: USER_LID, phoneNumber: USER_PN, admin: null },
      ],
      action: "remove",
    },
  );
  equal("an object leave clears warnings", store.getUserWarnings(groupId, USER_PN).length, 0);
  equal("an object leave clears the flag", store.getModerationFlag(groupId, USER_PN), null);

  const lidOnly = "120363-leave-lid-field@g.us";
  store.saveGroupSettings(lidOnly, {});
  store.saveUserWarnings(lidOnly, USER_PN, [
    { reason: "antilink:y", by: "system", date: new Date().toISOString() },
  ]);
  await handleGroupParticipantsUpdate(
    {},
    { id: lidOnly, participants: [{ lid: USER_LID }], action: "leave" },
  );
  equal("a lid field clears the phone ledger", store.getUserWarnings(lidOnly, USER_PN).length, 0);
}

section("a refused participant update is not a kick");
{
  const groupId = "120363-kick-403@g.us";
  const { sock, meta, kicks } = makeSock();
  cache(groupId, meta);
  store.saveGroupSettings(groupId, {
    antilink: { enabled: true, mode: "ALL", action: "KICK", allowed_domains: [], blocked_domains: [] },
  });
  sock.groupParticipantsUpdate = async (_jid, users, action) => {
    kicks.push({ users: [...users], action });
    return [{ status: "403", jid: users[0] }];
  };
  const result = await withLang("en", () =>
    handleGroupModeration(sock, withId(groupId, "deny-1", { text: "https://spam.example/deny" })),
  );
  equal("the removal was attempted", kicks.length, 1);
  equal("status 403 is not a kick", result.kicked, false);
  equal("status 403 keeps the warning", store.getUserWarnings(groupId, USER_PN).length, 1);
  equal("status 403 records a flag", store.listModerationFlags(groupId).length, 1);
  equal("status 403 does not mark kicked", store.getModerationApplied(groupId, "deny-1").kicked, false);

  const okId = "120363-kick-200@g.us";
  const okSock = makeSock();
  cache(okId, okSock.meta);
  store.saveGroupSettings(okId, {
    antilink: { enabled: true, mode: "ALL", action: "KICK", allowed_domains: [], blocked_domains: [] },
  });
  okSock.sock.groupParticipantsUpdate = async (_jid, users, action) => {
    okSock.kicks.push({ users: [...users], action });
    return [{ status: "200", jid: users[0] }];
  };
  const removed = await withLang("en", () =>
    handleGroupModeration(okSock.sock, withId(okId, "ok-1", { text: "https://spam.example/ok" })),
  );
  equal("status 200 kicks", removed.kicked, true);
  equal("status 200 clears warnings", store.getUserWarnings(okId, USER_PN).length, 0);
  equal("status 200 marks kicked", store.getModerationApplied(okId, "ok-1").kicked, true);

  const commandId = "120363-kick-cmd-403@g.us";
  store.saveUserWarnings(commandId, USER_PN, [
    { reason: "keep", by: "admin", date: new Date().toISOString() },
  ]);
  const commandSock = makeSock();
  cache(commandId, commandSock.meta);
  commandSock.sock.groupParticipantsUpdate = async () => ({ status: "403" });
  await kickCommand.execute(
    commandSock.sock,
    {
      key: { remoteJid: commandId, participant: ADMIN_PN },
      message: { extendedTextMessage: { contextInfo: { mentionedJid: [USER_PN] } } },
      pushName: "Admin",
    },
    ["@member", "spam"],
    "",
    commandSock.meta,
  );
  equal("!kick status 403 keeps warnings", store.getUserWarnings(commandId, USER_PN).length, 1);
}

section("a linked-account warn checks the target, not the sender");
{
  const groupId = "120363-warn-fromme@g.us";
  const { sock, meta, kicks } = makeSock();
  cache(groupId, meta);
  store.saveGroupSettings(groupId, { warn_system: { max_warnings: 2, action: "KICK" } });
  await withLang("en", () =>
    warnCommand.execute(
      sock,
      {
        key: { remoteJid: groupId, fromMe: true, id: "warn-fromme", participant: BOT_PN },
        message: { extendedTextMessage: { contextInfo: { mentionedJid: [USER_LID] } } },
      },
      ["@u", "manual"],
      "",
      meta,
    ),
  );
  equal("fromMe warn stores a warning", store.getUserWarnings(groupId, USER_PN).length, 1);
  equal("fromMe warn does not kick under the limit", kicks.length, 0);

  const blocked = await enforceHits(sock, {
    msg: { key: { remoteJid: groupId, fromMe: true, id: "warn-admin" } },
    groupId,
    groupMetadata: meta,
    hits: [{ rule: "warn", reason: "nope", detail: "nope" }],
    targetCandidates: [ADMIN_PN],
  });
  equal("fromMe warn of an admin does not act", blocked.acted, false);
  equal("fromMe warn of an admin stores nothing", store.getUserWarnings(groupId, ADMIN_PN).length, 0);

  const botTarget = await enforceHits(sock, {
    msg: { key: { remoteJid: groupId, fromMe: true, id: "warn-bot" } },
    groupId,
    groupMetadata: meta,
    hits: [{ rule: "warn", reason: "nope", detail: "nope" }],
    targetCandidates: [BOT_PN],
  });
  equal("fromMe warn of the bot does not act", botTarget.acted, false);

  const automatic = await enforceHits(sock, {
    msg: { key: { remoteJid: groupId, fromMe: true, id: "self-link" } },
    groupId,
    groupMetadata: meta,
    hits: [{ rule: "link", reason: "antilink:self", detail: "https://spam.example/self" }],
    targetCandidates: [USER_PN],
  });
  equal("fromMe automatic moderation does not act", automatic.acted, false);
  equal("fromMe automatic moderation does not add a warning", store.getUserWarnings(groupId, USER_PN).length, 1);
}

section("panel presets use the backend membership default");
{
  const source = readFileSync(new URL("../frontend/src/views/GroupsView.tsx", import.meta.url), "utf8");
  const defaults = source.slice(source.indexOf("const DEFAULT_POLICY"), source.indexOf("type PresetKey"));
  const presets = source.slice(source.indexOf("const PRESET_POLICIES"), source.indexOf("interface PolicyDraft"));
  equal("panel default membership is clear", defaults.match(/membership:\s*"([^"]+)"/)?.[1], "clear");
  ok("presets do not set membership themselves", !/membership\s*:/.test(presets));
  for (const name of ["standard", "relaxed", "strict"]) {
    equal(
      `${name} preset membership is clear`,
      policyService.resolveModerationPolicy(
        name === "standard" ? {} : policyService.applyModerationPreset(`120363-panel-${name}@g.us`, name).settings,
      ).membership,
      "clear",
    );
  }
}

finish();

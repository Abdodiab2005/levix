// Group moderation pipeline: identity-stable warnings, roster kicks, bot-admin
// gating, rule notices, and the shared Active-moderation summary.

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

store.storeLidPnMapping(USER_LID, USER_PN);
store.storeLidPnMapping(BOT_LID, BOT_PN);
store.storeLidPnMapping(ADMIN_LID, ADMIN_PN);

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

finish();

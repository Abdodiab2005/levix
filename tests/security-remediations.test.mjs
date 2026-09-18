import { existsSync } from "node:fs";
import {
  equal,
  finish,
  ok,
  require,
  section,
  throws,
  useTempDataDir,
} from "./harness.mjs";

useTempDataDir("levix-security-remediations");

const store = require("./src/db/store.cjs");
const memory = require("./src/utils/memory.cjs");
const secrets = require("./src/config/secrets.cjs");
const { isPanelSessionValid, stampPanelSession } = require("./src/panel/session-auth.cjs");
const { assertProviderBaseUrl, isForbiddenIp } = require("./src/utils/providerUrl.cjs");
const { runTool } = require("./src/services/aiTools.cjs");
const permissions = require("./src/utils/permissions.cjs");

await permissions.primePermissions();

section("provider endpoints reject secret-bearing SSRF destinations");

equal(
  "public HTTPS base URLs are accepted",
  assertProviderBaseUrl("https://api.example.com/v1/"),
  "https://api.example.com/v1",
);
equal(
  "explicit loopback stays available for local models",
  assertProviderBaseUrl("http://127.0.0.1:11434/v1"),
  "http://127.0.0.1:11434/v1",
);
throws("public HTTP is rejected", () => assertProviderBaseUrl("http://api.example.com/v1"));
throws("RFC1918 is rejected", () => assertProviderBaseUrl("https://192.168.1.10/v1"));
throws("cloud metadata is rejected", () => assertProviderBaseUrl("http://169.254.169.254"));
throws("credentials in a base URL are rejected", () =>
  assertProviderBaseUrl("https://user:pass@api.example.com"),
);
throws("query-bearing base URLs are rejected", () =>
  assertProviderBaseUrl("https://api.example.com/v1?target=elsewhere"),
);
ok("mapped loopback is classified as forbidden by default", isForbiddenIp("::ffff:7f00:1"));
ok("translated loopback is classified as forbidden", isForbiddenIp("::ffff:0:7f00:1"));
ok("6to4 destinations are classified as forbidden", isForbiddenIp("2002:7f00:1::"));

let result;
for (const url of [
  "http://[::ffff:0:7f00:1]/",
  "http://[2002:7f00:1::]/",
  "http://[64:ff9b::7f00:1]/",
  "http://[febf::1]/",
]) {
  result = await runTool("fetch_url", { url }, {});
  ok(`fetch_url rejects transitioned or link-local address ${url}`, Boolean(result.error));
}

section("AI privileges distinguish bot admins from WhatsApp group admins");

result = await runTool(
  "save_memory",
  { scope: "global", content: "group admin poison" },
  {
    chatId: "120363-security@g.us",
    senderId: "111@s.whatsapp.net",
    isOwner: false,
    isAdmin: false,
    isGroupAdmin: true,
  },
);
equal("a group admin cannot write global memory", result.saved, false);

result = await runTool("list_roles", {}, { isOwner: false, isAdmin: false, isGroupAdmin: true });
ok("a group admin cannot enumerate bot roles", Boolean(result.error));

result = await runTool(
  "save_memory",
  { scope: "chat", content: "chat-scoped fact" },
  {
    chatId: "120363-security@g.us",
    senderId: "111@s.whatsapp.net",
    isOwner: false,
    isAdmin: false,
    isGroupAdmin: true,
  },
);
equal("a group admin can still manage that chat's memory", result.saved, true);
result = await runTool(
  "forget_memory",
  { scope: "chat", ref: result.id },
  {
    chatId: "120363-security@g.us",
    senderId: "111@s.whatsapp.net",
    isOwner: false,
    isAdmin: false,
    isGroupAdmin: true,
  },
);
equal("chat memory removal remains group-scoped", result.removed, true);

result = await runTool(
  "grant_role",
  { target: "201111111111", role: "admin" },
  { isOwner: true, senderId: "owner@s.whatsapp.net", userText: "what is the weather?" },
);
equal("owner status alone does not bind a model-invented role target", result.granted, false);

result = await runTool(
  "grant_role",
  { target: "201111111111", role: "admin" },
  {
    isOwner: true,
    senderId: "owner@s.whatsapp.net",
    userText: "make 201111111111 an admin",
  },
);
equal("an explicit owner-supplied phone target is accepted", result.granted, true);

section("password epochs invalidate every older panel session");

secrets.setDashboardPassword("first-good-password");
const panelSession = {};
stampPanelSession(panelSession);
ok("freshly stamped session is valid", isPanelSessionValid(panelSession));
secrets.setDashboardPassword("second-good-password");
ok("password change invalidates the old epoch", !isPanelSessionValid(panelSession));
stampPanelSession(panelSession);
ok("the changing session can be restamped", isPanelSessionValid(panelSession));
store.deleteBotSetting("auth:password");
ok("CLI-style password deletion invalidates it too", !isPanelSessionValid(panelSession));

section("unlink clears account-derived AI state and pauses old jobs");

store.saveUserMetadata({ jid: "201222222222@s.whatsapp.net", displayName: "Old account" });
store.saveGroupSettings("120363-old@g.us", { antilink: { enabled: true } });
store.saveChatHistory("120363-old@g.us", [{ role: "user", parts: [{ text: "old secret" }] }]);
store.saveSchedule({
  id: "old-job",
  type: "recurring",
  targetJid: "120363-old@g.us",
  message: "old account job",
  cronString: "0 9 * * *",
  status: "active",
});
memory.addMemory({ scope: "global", content: "old global fact" });
memory.addMemory({ scope: "chat", chatId: "120363-old@g.us", content: "old chat fact" });

const { WhatsAppSession } = await import("../src/core/session.js");
const session = new WhatsAppSession({
  clearCredentials: async () => store.authClearAll(),
  isLinked: () => false,
  log: { info() {}, warn() {}, error() {}, debug() {} },
});
await session.logout();

equal("AI history is gone", store.getChatHistory("120363-old@g.us").length, 0);
ok("global memory is gone", !existsSync(memory.GLOBAL_FILE));
ok("chat memory is gone", !existsSync(memory.memoryFilePath("chat", "120363-old@g.us")));
equal("old schedules are paused", store.getSchedule("old-job").status, "paused");
equal("old user directory is gone", store.getAllUsers().length, 0);
equal("old group settings are gone", store.getAllGroupSettings().length, 0);

section("wrapped WhatsApp content reaches every moderation control");

const { visibleText, mediaType } = require("./src/utils/messageContent.cjs");
const wrappedImage = {
  ephemeralMessage: {
    message: {
      viewOnceMessageV2: {
        message: { imageMessage: { caption: "blocked.example forbidden" } },
      },
    },
  },
};
equal("wrapped image captions are visible", visibleText(wrappedImage), "blocked.example forbidden");
equal("wrapped media is classified", mediaType(wrappedImage), "image");

store.saveGroupSettings("120363-mod@g.us", {
  blacklist: ["201333333333@s.whatsapp.net"],
  antilink: { enabled: true, mode: "ALL", allowed_domains: [], blocked_domains: [] },
  media_control: { enabled: true, blocked_types: ["image"] },
  moderation: { forbiddenWords: { enabled: true, list: ["forbidden"] } },
  antispam: { enabled: true, message_count: 1, time_window: 10, action: "KICK" },
});
store.storeLidPnMapping("333@lid", "201333333333@s.whatsapp.net");

const sent = [];
let kicks = 0;
const ordinaryMetadata = {
  participants: [{ id: "333@lid", phoneNumber: "201333333333@s.whatsapp.net", admin: null }],
};
const adminMetadata = {
  participants: [
    { id: "201333333333@s.whatsapp.net", lid: "333@lid", admin: "admin" },
  ],
};
const sock = {
  user: { id: "209999999999@s.whatsapp.net" },
  async groupMetadata() {
    return ordinaryMetadata;
  },
  async sendMessage(_jid, payload) {
    sent.push(payload);
  },
  async groupParticipantsUpdate() {
    kicks += 1;
  },
};
const baseMessage = {
  key: {
    remoteJid: "120363-mod@g.us",
    participant: "333@lid",
    participantAlt: "201333333333@s.whatsapp.net",
    fromMe: false,
  },
  message: wrappedImage,
};

const { checkBlacklist } = await import("../src/middleware/blacklist.middleware.js");
ok("a PN blacklist entry matches a LID sender", await checkBlacklist(sock, baseMessage));
sock.groupMetadata = async () => adminMetadata;
ok("the same cross-format sender is exempt when they are an admin", !(await checkBlacklist(sock, baseMessage)));

const { handleAntiLink } = require("./src/commands/group/antilink.cjs");
const { handleMediaControl } = require("./src/commands/group/media.cjs");
const { handleForbiddenWords } = require("./src/commands/mod.cjs");
sock.groupMetadata = async () => ordinaryMetadata;
ok("anti-link sees a wrapped caption", await handleAntiLink(sock, baseMessage));
ok("media control sees wrapped media", await handleMediaControl(sock, baseMessage));
ok("forbidden-word control is actually enforced", await handleForbiddenWords(sock, baseMessage));

const { handleAntiSpam } = await import("../src/middleware/antispam.middleware.js");
sock.groupMetadata = async () => adminMetadata;
await handleAntiSpam(sock, baseMessage);
await handleAntiSpam(sock, baseMessage);
equal("cross-format admins cannot be kicked by antispam", kicks, 0);

const kickCommand = require("./src/commands/group/kick.cjs");
await kickCommand.execute(
  sock,
  {
    ...baseMessage,
    message: { extendedTextMessage: { contextInfo: { mentionedJid: ["333@lid"] } } },
  },
  ["@admin"],
  "",
  adminMetadata,
);
equal("a LID mention cannot bypass the group-admin kick guard", kicks, 0);

store.storeLidPnMapping("444@lid", "201444444444@s.whatsapp.net");
await permissions.grantRole("201444444444@s.whatsapp.net", "owner");
const warnCommand = require("./src/commands/group/warn.cjs");
await warnCommand.execute(
  sock,
  {
    ...baseMessage,
    message: { extendedTextMessage: { contextInfo: { mentionedJid: ["444@lid"] } } },
  },
  ["@owner", "reason"],
  "",
  { participants: [{ id: "201444444444@s.whatsapp.net", admin: null }] },
);
equal(
  "warn auto-kick cannot target a bot owner through their LID",
  store.getUserWarnings("120363-mod@g.us", "444@lid").length,
  0,
);
equal("warn protection does not attempt a kick", kicks, 0);

finish();

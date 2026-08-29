// Every read and write the bot performs, against a real SQLite file.
//
// Ported from the migration's verification run — the same assertions, now
// runnable with `npm test`. Covers the storage API, the settings layer, the
// command table and the generated secrets.

import { useTempDataDir, require, section, ok, finish } from "./harness.mjs";

useTempDataDir("levix-storage");

const store = require("./src/db/store.cjs");
const settings = require("./src/config/settings.cjs");
const secrets = require("./src/config/secrets.cjs");
const runtime = require("./src/config/runtime-config.cjs");


section("bot settings: strings, numbers, objects, arrays");
store.saveBotSetting("k:str", "hello");
store.saveBotSetting("k:num", 42);
store.saveBotSetting("k:obj", { a: 1, b: ["x"] });
store.saveBotSetting("k:arr", ["a", "b"]);
ok("string", store.getBotSetting("k:str") === "hello");
ok("number", store.getBotSetting("k:num") === 42);
ok("object", store.getBotSetting("k:obj").b[0] === "x");
ok("array", store.getBotSetting("k:arr").length === 2);
ok("default", store.getBotSetting("k:missing", "fb") === "fb");
store.deleteBotSetting("k:str");
ok("deleted", store.getBotSetting("k:str", null) === null);

section("group settings");
store.saveGroupSettings("g1@g.us", { antilink: true, warnLimit: 3 });
ok("group read", store.getGroupSettings("g1@g.us").antilink === true);
ok("group empty", Object.keys(store.getGroupSettings("nope@g.us")).length === 0);
ok("group count", store.countGroups() === 1);
ok("group all", store.getAllGroupSettings()[0].settings.warnLimit === 3);
// mutating what we got back must not leak into storage
const gs = store.getGroupSettings("g1@g.us"); gs.antilink = false;
ok("group copy", store.getGroupSettings("g1@g.us").antilink === true);

section("warnings");
store.saveUserWarnings("g1@g.us", "u1@s.whatsapp.net", [{ reason: "spam" }]);
ok("warn read", store.getUserWarnings("g1@g.us", "u1@s.whatsapp.net")[0].reason === "spam");
ok("warn count", store.countWarnings() === 1);
ok("warn all", store.getAllWarnings()[0].user_id === "u1@s.whatsapp.net");
store.clearUserWarnings("g1@g.us", "u1@s.whatsapp.net");
ok("warn cleared", store.getUserWarnings("g1@g.us", "u1@s.whatsapp.net").length === 0);

section("todos / notes");
store.saveUserTodos("u1", [{ text: "buy milk" }]);
ok("todo", store.getUserTodos("u1")[0].text === "buy milk");
ok("todo all", store.getAllTodos().length === 1);
store.saveNote("g1@g.us", "rules", "be nice");
store.saveNote("g1@g.us", "rules", "be nicer");
ok("note upsert", store.getNote("g1@g.us", "rules") === "be nicer");
ok("note list", store.getAllNotes("g1@g.us").join() === "rules");
ok("note flat", store.getAllNotesFlat()[0].keyword === "rules");
ok("note delete", store.deleteNote("g1@g.us", "rules") === true);
ok("note delete again", store.deleteNote("g1@g.us", "rules") === false);

section("qr");
store.saveQrCode("QR1"); ok("qr", store.getQrCode() === "QR1");
store.saveQrCode("QR2"); ok("qr replace", store.getQrCode() === "QR2");
store.deleteQrCode(); ok("qr gone", store.getQrCode() === null);

section("lid mapping");
store.storeLidPnMappings([
  { lid: "111@lid", pn: "201111111111@s.whatsapp.net", deviceIndex: 0 },
  { lid: "222@lid", pn: "202222222222@s.whatsapp.net" },
]);
ok("lid->pn", store.getPnForLid("111@lid") === "201111111111@s.whatsapp.net");
ok("pn->lid", store.getLidForPn("202222222222@s.whatsapp.net") === "222@lid");
ok("lids bulk", store.getLidsForPns(["201111111111@s.whatsapp.net"]).size === 1);
ok("lid all", store.getAllLidMappings().length === 2);

section("users & roles: the four-step lookup");
store.saveUserMetadata({ jid: "201234567890@s.whatsapp.net", lid: "999@lid", phone: "201234567890", displayName: "Abdo" });
ok("user by jid", store.getUserMetadata("201234567890@s.whatsapp.net").displayName === "Abdo");
ok("user by lid", store.getUserMetadata("999@lid").jid === "201234567890@s.whatsapp.net");
ok("user by phone", store.getUserMetadata("201234567890").jid === "201234567890@s.whatsapp.net");
ok("user by device suffix", store.getUserMetadata("201234567890:12@s.whatsapp.net")?.jid === "201234567890@s.whatsapp.net");
ok("user unknown", store.getUserMetadata("000@s.whatsapp.net") === null);

store.setUserRole("201234567890", "owner", true);
ok("owner set", store.isUserOwner("201234567890@s.whatsapp.net") === true);
// the regression that demoted owners: a plain message write must not clear it
store.saveUserMetadata({ jid: "201234567890@s.whatsapp.net" });
ok("owner survives a metadata write", store.isUserOwner("201234567890") === true);
ok("display name survives", store.getUserMetadata("201234567890").displayName === "Abdo");
ok("lid survives", store.getUserMetadata("201234567890").lid === "999@lid");
store.setUserRole("201234567890", "admin", true);
ok("admin set", store.isUserBotAdmin("201234567890") === true);
ok("owner still set", store.isUserOwner("201234567890") === true);
store.setUserRole("201234567890", "owner", false);
ok("owner revoked", store.isUserOwner("201234567890") === false);
ok("admin kept", store.isUserBotAdmin("201234567890") === true);
ok("owners list", store.getAllOwners().length === 0);
ok("admins list", store.getAllBotAdmins().length === 1);
store.setUserRole("2099999999", "owner", true);
ok("role creates user", store.getUserMetadata("2099999999").jid === "2099999999@s.whatsapp.net");
const before = store.getUserMetadata("201234567890").lastSeen;
store.updateUserLastSeen("201234567890@s.whatsapp.net");
ok("last seen", store.getUserMetadata("201234567890").lastSeen >= before);
ok("user count", store.countUsers() === 2);

section("forward scores");
ok("forward 1", store.incrementForwardScore("m1", "g1@g.us", "u1") === 1);
ok("forward 2", store.incrementForwardScore("m1", "g1@g.us", "u1") === 2);
ok("forward read", store.getForwardScore("m1").count === 2);
store.incrementForwardScore("m2", "g1@g.us", "u2");
ok("forward top", store.getTopForwardedMessages("g1@g.us")[0].message_id === "m1");
ok("forward missing", store.getForwardScore("nope") === null);

section("debts");
const d = store.addDebt({ groupId: "g1@g.us", debtorId: "u1", creditorId: "u2", amount: 50, description: "lunch" });
ok("debt id", Number.isInteger(d.id));
ok("debt read", store.getDebt(d.id).amount === 50);
ok("debt bool", store.getDebt(d.id).settled === false);
ok("debt list", store.listDebts("g1@g.us").length === 1);
ok("debt settled list", store.listDebts("g1@g.us", { settled: true }).length === 0);
ok("debt count", store.countDebts(false) === 1);
ok("debt recent", store.getRecentDebts()[0].id === d.id);
ok("debt delete", store.deleteDebt(d.id) === true);
ok("debt delete again", store.deleteDebt(d.id) === false);

section("schedules");
store.saveSchedule({ id: "j1", type: "once", targetJid: "g1@g.us", message: "hi", date: "2030-01-01T00:00:00.000Z", status: "pending", creatorJid: "u1" });
store.saveSchedule({ id: "j2", type: "recurring", targetJid: "g1@g.us", message: "daily", cronString: "0 9 * * *", status: "active" });
ok("schedules", store.getSchedules().length === 2);
ok("schedule shape", store.getSchedule("j2").cronString === "0 9 * * *");
store.setScheduleStatus("j1", "sent");
ok("schedule status", store.getSchedule("j1").status === "sent");
ok("schedule delete", store.deleteSchedule("j1") === true);
ok("schedule count", store.countSchedules() === 1);

section("ai history");
store.saveChatHistory("chat1", [{ role: "user", parts: [{ text: "hi" }] }]);
ok("history", store.getChatHistory("chat1")[0].parts[0].text === "hi");
ok("history empty", store.getChatHistory("nope").length === 0);
ok("history delete", store.deleteChatHistory("chat1") === true);
store.saveChatHistory("a", [1]); store.saveChatHistory("b", [2]);
store.deleteAllChatHistories();
ok("history wiped", store.getChatHistory("a").length === 0);

section("baileys auth");
ok("no creds yet", store.hasCredentials() === false);
store.authWrite("creds", '{"me":1}');
ok("has creds", store.hasCredentials() === true);
ok("auth read", store.authRead("creds") === '{"me":1}');
store.authRemove("creds");
ok("auth removed", store.authRead("creds") === null);
store.authWrite("x", "1"); store.authClearAll();
ok("auth cleared", store.authRead("x") === null);

section("settings layer");
ok("setting default", settings.get("gemini_model") === "gemini-3.7-flash");
ok("source default", settings.sourceOf("gemini_model") === "default");
settings.set("gemini_model", "some-other-model");
ok("setting saved", settings.get("gemini_model") === "some-other-model");
ok("source dashboard", settings.sourceOf("gemini_model") === "dashboard");
settings.set("gemini_model", "");
ok("setting cleared", settings.get("gemini_model") === "gemini-3.7-flash");
settings.set("ai_agent", "off");
ok("bool coercion", settings.get("ai_agent") === false);
settings.set("bot_min_delay_ms", "700");
ok("int coercion", settings.get("bot_min_delay_ms") === 700);
try { settings.set("bot_min_delay_ms", 999999); ok("range rejected", false); }
catch { ok("range rejected", true); }
try { settings.set("bot_timezone", "Not/AZone"); ok("tz rejected", false); }
catch { ok("tz rejected", true); }
settings.set("gemini_api_key", "sekrit");
const described = settings.describe();
const secretField = described.find((d) => d.key === "gemini_api_key");
ok("secret hidden", secretField.value === null && secretField.configured === true);
ok("restart flagged", described.find((d) => d.key === "port").restart === true);

section("runtime config");
ok("prefix default", runtime.getPrefix() === "!");
runtime.setPrefix(".");
ok("prefix saved", runtime.getPrefix() === ".");
ok("perm default", runtime.getPermission("ping") === "MEMBERS");
ok("perm group default", runtime.getPermission("group:kick") === "ADMINS_OWNER");
runtime.setPermission("ping", "OWNER_ONLY");
ok("perm override", runtime.getPermission("ping") === "OWNER_ONLY");
runtime.setPermission("ping", null);
ok("perm restored", runtime.getPermission("ping") === "MEMBERS");
runtime.setAliases("ping", ["p", "pong"]);
ok("aliases", runtime.getAliases("ping").join() === "p,pong");
runtime.setEnabled("ping", false);
ok("disabled", runtime.isDisabled("ping") === true);
runtime.setEnabled("ping", true);
ok("enabled", runtime.isDisabled("ping") === false);

section("secrets");
const s1 = secrets.getSessionSecret();
ok("session secret length", s1.length >= 64);
ok("session secret stable", secrets.getSessionSecret() === s1);
ok("no password yet", secrets.hasDashboardPassword() === false);
ok("verify with no password", secrets.verifyDashboardPassword("anything") === false);
try { secrets.setDashboardPassword("short"); ok("short rejected", false); }
catch { ok("short rejected", true); }
secrets.setDashboardPassword("correct horse battery");
ok("has password", secrets.hasDashboardPassword() === true);
ok("verify right", secrets.verifyDashboardPassword("correct horse battery") === true);
ok("verify wrong", secrets.verifyDashboardPassword("correct horse batteryy") === false);
ok("verify non-string", secrets.verifyDashboardPassword(undefined) === false);
const code = secrets.getSetupCode();
ok("setup code stable", secrets.getSetupCode() === code);
ok("setup code matches", secrets.setupCodeMatches(code.toLowerCase()) === true);
ok("setup code rejects", secrets.setupCodeMatches("DEADBEEF") === false);
finish();

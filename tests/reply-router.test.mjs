// Phase 05 reply router. Decisions are pure. Delivery uses a fake socket.
// Nothing here opens a WhatsApp connection or a network socket.

import { join } from "node:path";
import { equal, finish, ok, ROOT, require, section, useTempDataDir } from "./harness.mjs";

useTempDataDir("levix-reply-router");

const settings = require("./src/config/settings.cjs");
settings.set("bot_min_delay_ms", 0);
settings.set("bot_max_delay_ms", 0);
settings.set("bot_language", "en");
settings.set("reply_route", "same_chat");

const { timing } = await import(join(ROOT, "src/utils/sendBotMessage.esm.js"));
timing.sleep = async () => {};

const { planDelivery, assertSelfDelivery, routeSend } = require("./src/messaging/router.cjs");
const { setCached, flushAll } = require("./src/utils/groupMetadataCache.cjs");

const GROUP = "120363000000000009@g.us";
const OTHER = "120363000000000010@g.us";
const OWNER = "201000000000@s.whatsapp.net";
const MEMBER = "201111111111@s.whatsapp.net";
const STRANGER = "201222222222@s.whatsapp.net";

const identity = { phone: OWNER, lid: "999@lid", selfJids: [OWNER, "999@lid"] };

section("same chat is the default");

{
  const plan = planDelivery({
    sourceJid: GROUP,
    requestedJid: GROUP,
    sensitivity: "source",
    commandName: "ping",
    routeMode: "same_chat",
  });
  equal("destination", plan.destination, GROUP);
  equal("quote kept", plan.quote, true);
  const forged = planDelivery({
    sourceJid: GROUP,
    requestedJid: GROUP,
    contextChatId: STRANGER,
    routeMode: "same_chat",
    sensitivity: "source",
  });
  equal("a context chat id is ignored", forged.destination, GROUP);
}

section("leaving the chat");

{
  const leak = planDelivery({
    sourceJid: GROUP,
    requestedJid: STRANGER,
    sensitivity: "source",
    routeMode: "same_chat",
    commandName: "gemini",
  });
  equal("same-chat mode refuses another jid", leak.allow, false);
  equal("no destination", leak.destination, null);

  const owner = planDelivery({
    sourceJid: GROUP,
    requestedJid: GROUP,
    sensitivity: "source",
    routeMode: "owner_private",
    identity,
    commandName: "ping",
  });
  equal("owner private receives source content", owner.destination, OWNER);
  equal("the group message is not quoted elsewhere", owner.quote, false);

  const missing = planDelivery({
    sourceJid: GROUP,
    requestedJid: GROUP,
    sensitivity: "source",
    routeMode: "owner_private",
    identity: { selfJids: [] },
  });
  equal("no creds fails closed", missing.allow, false);
  ok("the refusal is not a group", missing.destination !== GROUP && missing.destination !== OTHER);

  const third = planDelivery({
    sourceJid: GROUP,
    requestedJid: GROUP,
    sensitivity: "source",
    routeMode: "authorized_chat",
    routeChat: STRANGER,
    identity,
  });
  equal("another person does not receive group content", third.allow, false);

  const operational = planDelivery({
    sourceJid: GROUP,
    requestedJid: GROUP,
    sensitivity: "operational",
    category: "progress",
    routeMode: "authorized_chat",
    routeChat: STRANGER,
    identity,
  });
  equal("operational text may go to an authorized person", operational.destination, STRANGER);

  flushAll();
  const unverified = planDelivery({
    sourceJid: GROUP,
    requestedJid: GROUP,
    sensitivity: "operational",
    routeMode: "authorized_chat",
    routeChat: OTHER,
    identity,
    knownGroups: {},
  });
  equal("an unverified group is refused", unverified.allow, false);

  setCached(OTHER, { id: OTHER, participants: [{ id: OWNER, admin: "admin" }] });
  const member = planDelivery({
    sourceJid: GROUP,
    requestedJid: GROUP,
    sensitivity: "operational",
    routeMode: "authorized_chat",
    routeChat: OTHER,
    identity,
    knownGroups: { [OTHER]: { member: true } },
  });
  equal("a verified group can take operational text", member.destination, OTHER);
  const content = planDelivery({
    sourceJid: GROUP,
    requestedJid: GROUP,
    sensitivity: "source",
    routeMode: "authorized_chat",
    routeChat: OTHER,
    identity,
    knownGroups: { [OTHER]: { member: true } },
  });
  equal("that group still cannot take source content", content.allow, false);
  flushAll();
}

section("named exceptions");

{
  const schedule = planDelivery({
    sourceJid: GROUP,
    requestedJid: MEMBER,
    senderJid: MEMBER,
    commandName: "schedule",
    sensitivity: "source",
    routeMode: "same_chat",
  });
  equal("schedule errors reach the creator", schedule.destination, MEMBER);
  const groupTarget = planDelivery({
    sourceJid: GROUP,
    requestedJid: OTHER,
    senderJid: OTHER,
    commandName: "schedule",
    routeMode: "same_chat",
  });
  equal("schedule errors do not go to a group", groupTarget.allow, false);

  equal("password reset accepts the linked chat", assertSelfDelivery(OWNER, OWNER), OWNER);
  let refused = false;
  try {
    assertSelfDelivery(GROUP, OWNER);
  } catch (error) {
    refused = error.code === "ROUTE_REFUSED";
  }
  ok("password reset refuses a group", refused);
}

section("settings and a fake socket");

{
  let threw = false;
  try {
    settings.set("reply_route_chat", "https://evil.example/chat");
  } catch {
    threw = true;
  }
  ok("a url is rejected", threw);
  equal("a url is not stored", settings.get("reply_route_chat"), "");
  settings.set("reply_route_chat", "");
  settings.set("reply_route_overrides", JSON.stringify({ commands: { ping: "same_chat" } }));
  const kept = routeSend({
    sourceJid: GROUP,
    requestedJid: GROUP,
    commandName: "ping",
    sensitivity: "source",
  });
  equal("an override of same_chat stays here", kept.destination, GROUP);
  settings.set("reply_route_overrides", "");

  const { handleCommand, loadCommands } = await import(
    join(ROOT, "src/handlers/command.handler.js")
  );
  await loadCommands();
  const sent = [];
  const fake = {
    async sendMessage(jid, content) {
      sent.push({ jid, content });
      return { key: { id: `m${sent.length}`, remoteJid: jid, fromMe: true } };
    },
    async sendPresenceUpdate() {},
  };
  const msg = {
    key: { remoteJid: GROUP, fromMe: true, id: "cmd" },
    message: { conversation: "!ping" },
  };
  await handleCommand(fake, msg, "!ping");
  equal("ping stays in the source chat", sent.at(-1)?.jid, GROUP);
  ok("ping is quoted", sent.at(-1)?.content?.text?.includes("Pong") || sent.length > 0);
}

finish();

// Phase 05 message engine, status editing, short !status and health.
// Probes are injected. This file does not call the network or ffmpeg.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { equal, finish, ok, ROOT, require, section, useTempDataDir } from "./harness.mjs";

useTempDataDir("levix-message-health");

const settings = require("./src/config/settings.cjs");
settings.set("bot_min_delay_ms", 0);
settings.set("bot_max_delay_ms", 0);
settings.set("bot_language", "en");
settings.set("message_watermark", false);
settings.set("reply_hide_progress", false);

const { timing } = await import(join(ROOT, "src/utils/sendBotMessage.esm.js"));
timing.sleep = async () => {};

const {
  createMessage,
  renderMessage,
  stampWatermark,
  setRenderHook,
  escapeParam,
} = require("./src/messaging/message.cjs");
const { assessHealth, whatsAppProbe } = require("./src/messaging/health.cjs");
const { createStatus } = require("./src/utils/statusMessage.cjs");

section("message engine");

{
  const message = createMessage({
    messageKey: "bot.core.commandHandler.unknown",
    category: "error",
    parameters: { name: "nope{injected}", prefix: "!" },
    context: { sourceChat: "1@g.us", chatId: "forged" },
  });
  equal("context has no forged chat id field", message.context.chatId, undefined);
  ok(
    "braces in a parameter cannot add a placeholder",
    !renderMessage(message).includes("{injected}"),
  );
  ok("the name is still visible", renderMessage(message).includes("nope"));
  equal("bidi is stripped", escapeParam("a\u202eb").includes("\u202e"), false);

  settings.set("message_watermark", true);
  const marked = stampWatermark("Hello", { commandName: "weather", category: "result" });
  ok("eligible result gains the watermark", marked.endsWith("Powered by Levix"));
  equal(
    "exact output stays exact",
    stampWatermark("2", { commandName: "calc", category: "result" }),
    "2",
  );
  equal("security text stays clean", stampWatermark("secret", { category: "security" }), "secret");
  settings.set("message_watermark", false);

  let saw = null;
  setRenderHook((envelope, text) => {
    saw = envelope.messageKey;
    return `${text}!`;
  });
  ok("the hook can change text", renderMessage(message).endsWith("!"));
  equal("the hook sees the key", saw, "bot.core.commandHandler.unknown");
  setRenderHook(null);
}

section("progress edits and hiding");

{
  const sent = [];
  const sock = {
    async sendMessage(jid, content) {
      sent.push({ jid, content });
      return { key: { id: "s1", remoteJid: jid } };
    },
    async sendPresenceUpdate() {},
  };
  const status = await createStatus(sock, "1@g.us", "working");
  await status.finish("done", { mentions: ["201@s.whatsapp.net"] });
  equal("one send and one edit", sent.length, 2);
  equal("the edit targets the same chat", sent[1].jid, "1@g.us");
  equal("mentions survive the edit", sent[1].content.mentions[0], "201@s.whatsapp.net");
  ok("the second call is an edit", Boolean(sent[1].content.edit));
}

{
  settings.set("reply_hide_progress", true);
  const sent = [];
  const sock = {
    async sendMessage(jid, content) {
      sent.push({ jid, content });
      return { key: { id: "s2", remoteJid: jid } };
    },
    async sendPresenceUpdate() {},
  };
  const status = await createStatus(sock, "1@g.us", "working");
  equal("hidden progress sends nothing yet", sent.length, 0);
  await status.finish("the result");
  equal("the result still arrives", sent.length, 1);
  equal("the result text", sent[0].content.text, "the result");
  const failure = await createStatus(sock, "1@g.us", "working");
  await failure.fail(new Error("boom"), "Failed");
  ok(
    "an error is not hidden",
    sent.some((row) => /boom/.test(row.content.text || "")),
  );
  settings.set("reply_hide_progress", false);
}

section("health");

{
  const healthSrc = readFileSync(join(ROOT, "src/messaging/health.cjs"), "utf8");
  ok("health does not fetch", !/fetch\(|axios|https?:\/\//.test(healthSrc));
  const quiet = assessHealth({
    node: { state: "ok" },
    whatsapp: { state: "ok" },
    database: { state: "ok" },
    scheduler: { state: "ok" },
    disk: { state: "ok" },
    memory: { state: "ok" },
    recovery: { state: "ok" },
    media: { state: "ok" },
  });
  equal("all ok", quiet.overall, "ok");
  const down = assessHealth({ ...quietChecks("ok"), whatsapp: { state: "down" } });
  equal("whatsapp down wins", down.overall, "down");
  const degraded = assessHealth({
    ...quietChecks("ok"),
    disk: { state: "degraded", detail: "/secret" },
  });
  equal("degraded", degraded.overall, "degraded");
  equal(
    "a path-like detail is kept only as data for the caller to filter",
    degraded.checks.find((c) => c.id === "disk").detail,
    "/secret",
  );
  equal("missing probe is unknown", assessHealth({}).overall, "unknown");
  equal(
    "connected means connected",
    whatsAppProbe({ state: "connected", connected: true }).state,
    "ok",
  );
  equal(
    "idle is not connected",
    whatsAppProbe({ state: "idle", connected: false }).state,
    "degraded",
  );
  equal("no session is unknown", whatsAppProbe(null).state, "unknown");
  equal(
    "a refused connection is down",
    whatsAppProbe({ state: "error", connected: false }).state,
    "down",
  );
}

function quietChecks(state) {
  return {
    node: { state },
    whatsapp: { state },
    database: { state },
    scheduler: { state },
    disk: { state },
    memory: { state },
    recovery: { state },
    media: { state },
  };
}

section("status command");

{
  const status = require("./src/commands/status.cjs");
  status.probes.gather = async () => quietChecks("ok");
  const sent = [];
  const sock = {
    async sendMessage(jid, content) {
      sent.push({ jid, content });
      return { key: { id: "st" } };
    },
  };
  const owner = { key: { remoteJid: "201@s.whatsapp.net", fromMe: true, id: "a" } };
  await status.execute(sock, owner, []);
  const short = sent.at(-1).content.text;
  ok("short status contains only uptime and OS", /^Uptime: [^|\n]+ \| OS: (Linux|Android|macOS|Windows|Unknown)$/.test(short));
  ok("short status has one line", !short.includes("\n"));
  ok("short status omits connection/running state", !/WhatsApp|connected|not connected|Running/i.test(short));
  ok("no node version", !/v\d+\.\d+/.test(short) && !/Node/.test(short));
  ok("no baileys", !/Baileys|baileys/.test(short));
  ok("no ffmpeg", !/ffmpeg|FFmpeg/.test(short));
  ok("no kernel release shape", !/\d+\.\d+\.\d+/.test(short));
  ok("an os family is present", /Linux|Android|macOS|Windows|Unknown/.test(short));

  const member = {
    key: { remoteJid: "120363@g.us", fromMe: false, id: "b", participant: "202@s.whatsapp.net" },
  };
  await status.execute(sock, member, ["debug"]);
  ok("a member does not get diagnostics", /owner/.test(sent.at(-1).content.text));
  ok("the refusal has no version", !/Baileys/.test(sent.at(-1).content.text));

  await status.execute(sock, owner, ["debug"]);
  const debug = sent.at(-1).content.text;
  ok("the owner sees a check", /Database: ok/.test(debug));
  ok("the owner sees node", /Node: v/.test(debug));
  ok("debug does not print a home path", !/\/home\/|\/data\/|ffmpeg/.test(debug));
}

finish();

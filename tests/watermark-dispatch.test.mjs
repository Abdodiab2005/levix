// Watermarks through the actual dispatcher, status edits and fresh-send fallback.
import { join } from "node:path";
import { equal, ok, finish, require, ROOT, useTempDataDir } from "./harness.mjs";
useTempDataDir("levix-watermark-dispatch");
const settings = require("./src/config/settings.cjs");
for (const [key, value] of Object.entries({
  bot_min_delay_ms: 0,
  bot_max_delay_ms: 0,
  bot_language: "en",
  message_watermark: true,
}))
  settings.set(key, value);
const { timing } = await import(join(ROOT, "src/utils/sendBotMessage.esm.js"));
timing.sleep = async () => {};
const { loadCommands, handleCommand } = await import(join(ROOT, "src/handlers/command.handler.js"));
await loadCommands();
const { createStatus } = require("./src/utils/statusMessage.cjs");
const weather = require("./src/commands/weather.cjs");
const original = weather.execute;
function socket(failEdit = false) {
  const sent = [];
  return {
    sent,
    user: { id: "100@s.whatsapp.net" },
    async sendPresenceUpdate() {},
    async sendMessage(jid, content) {
      if (content.edit && failEdit) throw Error("edit refused");
      sent.push({ jid, content });
      return { key: { id: "status", remoteJid: jid } };
    },
  };
}
async function run(text, sock = socket()) {
  const msg = {
    key: { id: "input", remoteJid: "100@s.whatsapp.net", fromMe: true },
    message: { conversation: text },
  };
  await handleCommand(sock, msg, text);
  return sock.sent;
}
try {
  for (const hidden of [false, true])
    for (const failEdit of [false, true])
      for (const failure of [false, true]) {
        settings.set("reply_hide_progress", hidden);
        weather.execute = async (sock, msg) => {
          const status = await createStatus(sock, msg.key.remoteJid, "working");
          status.lastEditAt = 0;
          if (failure) await status.fail(Error("fixture failure"));
          else await status.finish("forecast");
        };
        const sent = await run("!weather Cairo", socket(failEdit));
        equal(
          "progress stays clean",
          sent.filter((x) => x.content.text === "working").length,
          hidden ? 0 : 1,
        );
        const result = sent.at(-1).content.text;
        equal(
          `hidden=${hidden} fallback=${failEdit} error=${failure}`,
          result.includes("Powered by Levix"),
          !failure,
        );
      }
  weather.execute = original;
  const error = await run("!weather");
  ok("validation error has no mark", !error.at(-1).content.text.includes("Powered by Levix"));
  const helpError = await run("!help doesnotexist");
  ok("help error has no mark", !helpError.at(-1).content.text.includes("Powered by Levix"));
} finally {
  weather.execute = original;
}
finish();

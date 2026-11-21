// !stt must show a translated error class. A provider body never reaches the chat.

import { errorReply, startGenaiServer } from "./fixtures/genai-server.mjs";
import {
  equal,
  finish,
  ok,
  require as harnessRequire,
  section,
  useTempDataDir,
} from "./harness.mjs";

useTempDataDir("levix-stt-errors");

const geminiMedia = harnessRequire("./src/utils/geminiMedia.cjs");
geminiMedia.downloadMedia = async () => Buffer.from("OggS-stt-error");

const settings = harnessRequire("./src/config/settings.cjs");
const stt = harnessRequire("./src/commands/stt.cjs");
const { t, withLang } = harnessRequire("./src/utils/i18n.cjs");
const { timing } = await import("../src/utils/sendBotMessage.esm.js");
timing.sleep = async () => {};

settings.set("bot_min_delay_ms", 0);
settings.set("bot_max_delay_ms", 0);

section("!stt hides a provider error body");
{
  const leak = "upstream failed sk-FAKEKEY999 see https://evil.example/leak?key=sk-FAKEKEY999";
  const fake = await startGenaiServer([errorReply(400, leak)]);
  settings.set("ai_stt_provider", "gemini");
  settings.set("gemini_api_key", "AIzaSySttTestKey1234");
  settings.set("gemini_base_url", fake.baseUrl);
  try {
    const sent = [];
    const sock = {
      async sendMessage(jid, content) {
        sent.push({ jid, text: content?.text || "" });
        return { key: { id: `stt-${sent.length}`, remoteJid: jid, fromMe: true } };
      },
      async sendPresenceUpdate() {},
      async presenceSubscribe() {},
    };
    const chatId = "201000000501@s.whatsapp.net";
    const msg = {
      key: { remoteJid: chatId, fromMe: false, id: "voice-1" },
      message: {
        audioMessage: { mimetype: "audio/ogg; codecs=opus", fileLength: 16 },
      },
    };
    await withLang("en", async () => {
      await stt.execute(sock, msg, [], "!stt", null);
      const expected = t("bot.ai.stt.failed", {
        details: t("bot.ai.gemini.errorGeneric"),
        hintBlock: "",
      });
      const text = sent.at(-1)?.text || "";
      equal("the chat gets the translated failure", text, expected.trim());
      ok(
        "the fake key never reaches the chat",
        !sent
          .map((entry) => entry.text)
          .join("\n")
          .includes("sk-FAKEKEY999"),
      );
      ok(
        "the leak URL never reaches the chat",
        !sent
          .map((entry) => entry.text)
          .join("\n")
          .includes("evil.example"),
      );
    });
  } finally {
    await fake.stop();
  }
}

finish();

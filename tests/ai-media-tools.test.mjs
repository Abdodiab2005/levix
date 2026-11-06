// Model-initiated media: identity, upload, cost, deadline and delivery boundaries.
import { Readable } from "node:stream";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  openaiText,
  openaiToolCall,
  OPENAI_PATH,
  startProviderServer,
} from "./fixtures/provider-server.mjs";
import { equal, finish, ok, require, section, throws, useTempDataDir } from "./harness.mjs";

useTempDataDir("levix-ai-media-tools");
const settings = require("./src/config/settings.cjs");
const permissions = require("./src/utils/permissions.cjs");
await permissions.primePermissions();
const config = require("./src/config/runtime-config.cjs");
const { runTool, TOOLS } = require("./src/services/aiTools.cjs");
const { resolveCaller, callerAudio } = require("./src/services/aiToolAuth.cjs");
const media = require("./src/utils/geminiMedia.cjs");
const safety = require("./src/services/aiMedia.cjs");
const tts = require("./src/commands/tts.cjs");
const stt = require("./src/commands/stt.cjs");
const image = require("./src/services/aiImage.cjs");
const { timing } = await import("../src/utils/sendBotMessage.esm.js");
timing.sleep = async () => {};
settings.set("bot_min_delay_ms", 0);
settings.set("bot_max_delay_ms", 0);
settings.set("ai_stt_enabled", true);
settings.set("openai_api_key", "isolated-key");
settings.set("ai_stt_provider", "openai");

const voice = {
  audio: Buffer.from("OggS-test-voice"),
  mimetype: "audio/ogg; codecs=opus",
  ptt: true,
};
const audio = {
  url: "https://mmg.whatsapp.net/v/t/voice",
  mimetype: "audio/ogg; codecs=opus",
  fileLength: 32,
};
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
let next = 100;
function message({
  jid = `20100000${next++}@s.whatsapp.net`,
  attached = null,
  quoted = null,
} = {}) {
  return {
    key: { remoteJid: jid, id: `MEDIA${next}`, fromMe: false },
    message: attached
      ? { audioMessage: attached }
      : {
          extendedTextMessage: {
            text: "!ai process this",
            contextInfo: {
              participant: "201999999999@s.whatsapp.net",
              quotedMessage: quoted ? { audioMessage: quoted } : undefined,
            },
          },
        },
  };
}
const socket = () => ({
  sent: [],
  async sendPresenceUpdate() {},
  async sendMessage(jid, content) {
    this.sent.push({ jid, content });
    return { key: { id: "sent", remoteJid: jid } };
  },
});
const callerFor = (msg = message()) => resolveCaller({ msg, sock: socket(), text: "process this" });
const original = {
  synthesize: tts._synthesizeVoice,
  transcribe: stt.transcribe,
  download: media.downloadMedia,
  generate: image.generateImage,
};
let downloaded;
tts._synthesizeVoice = async () => voice;
stt.transcribe = async () => "a private transcript";
media.downloadMedia = async (_download, descriptor) => {
  downloaded = descriptor;
  return voice.audio;
};
image.generateImage = async () => ({
  image: png,
  mimetype: "image/png",
  provider: "gemini",
  model: "image-model",
});

try {
  section("media tools reuse commands and bind the real sender");
  for (const name of ["speak", "generate_image", "transcribe_audio"]) {
    ok(`${name} is declared`, Boolean(TOOLS[name]?.declaration));
    const denied = await runTool(
      name,
      { text: "hi", prompt: "cat" },
      { caller: { isOwner: true, senderId: "forged" }, sock: socket() },
    );
    equal(`${name} rejects a forged caller`, denied.denied, true);
  }
  const source = message({ quoted: { ...audio } });
  const caller = await callerFor(source);
  source.message.extendedTextMessage.contextInfo.quotedMessage.audioMessage.url =
    "http://127.0.0.1/changed";
  const copied = callerAudio(caller);
  copied.url = "https://evil.example/replaced";
  const transcript = await runTool(
    "transcribe_audio",
    { url: "http://127.0.0.1/forged", chatId: "forged" },
    { caller },
  );
  equal("transcript comes from shared STT", transcript.transcript, "a private transcript");
  equal("transcript is untrusted data", transcript.untrustedData, true);
  equal("media is a snapshot of the invoking quote", downloaded?.url, audio.url);
  equal("quoted author's identity is not the caller", caller.senderId, source.key.remoteJid);
  const direct = message({ attached: { ...audio, directPath: "/direct" } });
  direct.message.audioMessage.contextInfo = {
    quotedMessage: { audioMessage: { ...audio, directPath: "/quoted" } },
  };
  equal(
    "direct audio wins over a quoted voice",
    callerAudio(await callerFor(direct)).directPath,
    "/direct",
  );
  for (const [name, args] of [
    ["speak", { text: "read aloud" }],
    ["generate_image", { prompt: "a cat" }],
  ]) {
    const sock = socket();
    const real = await callerFor();
    const result = await runTool(name, { ...args, chatId: "forged" }, { caller: real, sock });
    equal(`${name} reports success only after sending`, result.sent, true);
    equal(`${name} sends once`, sock.sent.length, 1);
    equal(`${name} uses the true source chat`, sock.sent[0]?.jid, real.chatId);
    ok(
      `${name} returns no binary to chat history`,
      !JSON.stringify(result).includes("base64") && !("audio" in result) && !("image" in result),
    );
  }

  section("live permissions and disabled commands");
  for (const [tool, command, args] of [
    ["speak", "tts", { text: "hello" }],
    ["generate_image", "gemini", { prompt: "cat" }],
    ["transcribe_audio", "stt", {}],
  ]) {
    const real = await callerFor(message({ quoted: audio }));
    config.setPermission(command, "OWNER_ONLY");
    equal(
      `${tool} follows the command permission`,
      (await runTool(tool, args, { caller: real, sock: socket() })).denied,
      true,
    );
    config.setPermission(command, null);
    config.setEnabled(command, false);
    equal(
      `${tool} follows the command kill switch`,
      (await runTool(tool, args, { caller: real, sock: socket() })).denied,
      true,
    );
    config.setEnabled(command, true);
  }

  section("bad arguments, missing/unsafe media and output");
  for (const [tool, args] of [
    ["speak", { text: {} }],
    ["speak", { text: "hi", language: "../../en" }],
    ["generate_image", { prompt: [] }],
    ["generate_image", { prompt: "x".repeat(3001) }],
  ]) {
    ok(
      `${tool} validates arguments`,
      Boolean((await runTool(tool, args, { caller: await callerFor(), sock: socket() })).error),
    );
  }
  equal(
    "missing audio fails",
    (await runTool("transcribe_audio", {}, { caller: await callerFor() })).code,
    "MEDIA_NOT_AVAILABLE",
  );
  for (const url of [
    "http://127.0.0.1/voice",
    "https://mmg.whatsapp.net.evil.example/voice",
    "https://user:secret@mmg.whatsapp.net/voice",
  ]) {
    equal(
      "arbitrary URL is refused before download",
      (
        await runTool(
          "transcribe_audio",
          {},
          { caller: await callerFor(message({ quoted: { ...audio, url } })) },
        )
      ).code,
      "MEDIA_URL_INVALID",
    );
  }
  settings.set("ai_stt_enabled", false);
  equal(
    "STT switch is respected",
    (await runTool("transcribe_audio", {}, { caller })).code,
    "MEDIA_DISABLED",
  );
  settings.set("ai_stt_enabled", true);
  tts._synthesizeVoice = async () => ({ ...voice, audio: Buffer.from("bad") });
  const badSock = socket();
  equal(
    "bad audio is not sent",
    (await runTool("speak", { text: "hello" }, { caller: await callerFor(), sock: badSock })).code,
    "MEDIA_AUDIO_INVALID",
  );
  equal("no corrupt payload sent", badSock.sent.length, 0);
  tts._synthesizeVoice = async () => {
    throw new Error("429 provider body key=sk-private quoted group text");
  };
  const quota = await runTool(
    "speak",
    { text: "hello" },
    { caller: await callerFor(), sock: socket() },
  );
  ok(
    "quota is an error without provider content",
    quota.error && !quota.sent && !JSON.stringify(quota).includes("sk-private"),
  );
  tts._synthesizeVoice = async () => voice;
  stt.transcribe = async () => "";
  equal(
    "empty transcript is not success",
    (await runTool("transcribe_audio", {}, { caller: await callerFor(message({ quoted: audio })) }))
      .code,
    "STT_OUTPUT_INVALID",
  );
  stt.transcribe = async () => "a private transcript";
  settings.set("openai_api_key", "");
  equal(
    "missing speech key is explicit",
    (await runTool("transcribe_audio", {}, { caller: await callerFor(message({ quoted: audio })) }))
      .code,
    "STT_KEY_REQUIRED",
  );
  settings.set("openai_api_key", "isolated-key");
  throws("unsupported audio container is refused", () =>
    safety.assertAudio(Buffer.from("not-audio"), "audio/ogg"),
  );
  throws("oversized audio is refused", () =>
    safety.assertAudio(Buffer.alloc(safety.MAX_MEDIA_BYTES + 1), "audio/ogg"),
  );

  section("bounded download destroys an oversized stream");
  const stream = Readable.from([Buffer.alloc(5), Buffer.alloc(5)]);
  let boundedError;
  try {
    await original.download(async () => stream, { fileLength: 1 }, "audio", { maxBytes: 8 });
  } catch (error) {
    boundedError = error;
  }
  equal("stream byte count is authoritative", boundedError?.message, "MEDIA_TOO_LARGE");
  ok("oversized stream is destroyed", stream.destroyed);

  section("rate limits survive fresh callers and deadlines prevent late sends");
  const repeated = message();
  for (let i = 0; i < 3; i += 1)
    equal(
      "allowed attempt",
      (
        await runTool(
          "speak",
          { text: "hi" },
          { caller: await callerFor(repeated), sock: socket() },
        )
      ).sent,
      true,
    );
  equal(
    "a fresh caller object cannot reset rate",
    (await runTool("speak", { text: "hi" }, { caller: await callerFor(repeated), sock: socket() }))
      .code,
    "MEDIA_RATE_LIMIT",
  );
  let release;
  tts._synthesizeVoice = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const deadlineCaller = await callerFor();
  const lateSock = socket();
  const get = settings.get;
  settings.get = (key) => (key === "ai_tool_timeout_ms" ? 15 : get(key));
  try {
    const timed = runTool("speak", { text: "late" }, { caller: deadlineCaller, sock: lateSock });
    await new Promise((resolve) => setImmediate(resolve));
    equal(
      "concurrent attempt is refused",
      (await runTool("speak", { text: "again" }, { caller: deadlineCaller, sock: lateSock })).code,
      "MEDIA_BUSY",
    );
    equal("operation expires", (await timed).code, "MEDIA_TIMEOUT");
    equal(
      "non-cancellable work remains busy",
      (await runTool("speak", { text: "again" }, { caller: deadlineCaller, sock: lateSock })).code,
      "MEDIA_BUSY",
    );
    release(voice);
    await new Promise((resolve) => setImmediate(resolve));
    equal("late completion did not send", lateSock.sent.length, 0);
  } finally {
    settings.get = get;
  }
  tts._synthesizeVoice = async () => voice;
  const refusedSock = {
    async sendMessage() {
      return { refused: true };
    },
  };
  equal(
    "router refusal is not reported as success",
    (await runTool("speak", { text: "hi" }, { caller: await callerFor(), sock: refusedSock })).code,
    "MEDIA_DELIVERY_REFUSED",
  );

  section("shared TTS MP3 fallback cleans its private temporary file");
  const googleTTS = require("@sefinek/google-tts-api");
  const googleModule = require.cache[require.resolve("@sefinek/google-tts-api")];
  const thumbnail = require("./src/utils/thumbnail.cjs");
  const ffmpeg = thumbnail.ffmpegPath;
  const commandPath = require.resolve("./src/commands/tts.cjs");
  const before = readdirSync(tmpdir()).filter((name) => name.startsWith("wa-bot-tts-"));
  googleModule.exports = {
    ...googleTTS,
    getAllAudioBase64: async () => [
      { base64: Buffer.from("ID3-test-mp3-audio").toString("base64") },
    ],
  };
  thumbnail.ffmpegPath = () => null;
  delete require.cache[commandPath];
  try {
    const fallback = await require("./src/commands/tts.cjs")._synthesizeVoice("hello", "en");
    equal("MP3 fallback is not labelled PTT", fallback.ptt, false);
    equal("fallback has the correct MIME", fallback.mimetype, "audio/mpeg");
    equal(
      "temporary audio was cleaned",
      JSON.stringify(readdirSync(tmpdir()).filter((name) => name.startsWith("wa-bot-tts-"))),
      JSON.stringify(before),
    );
  } finally {
    googleModule.exports = googleTTS;
    thumbnail.ffmpegPath = ffmpeg;
    delete require.cache[commandPath];
  }

  section("explicit speech-provider choices never upload to a fallback");
  settings.set("ai_stt_provider", "gemini");
  settings.set("gemini_api_key", "");
  let missingEngine;
  try {
    await original.transcribe(voice.audio, voice.mimetype);
  } catch (error) {
    missingEngine = error;
  }
  equal("missing selected Gemini key fails closed", missingEngine?.code, "STT_KEY_REQUIRED");
  settings.set("ai_stt_provider", "openai");
  settings.set("openai_api_key", "");
  settings.set("gemini_api_key", "isolated-gemini-key");
  missingEngine = null;
  try {
    await original.transcribe(voice.audio, voice.mimetype);
  } catch (error) {
    missingEngine = error;
  }
  equal("missing selected OpenAI key fails closed", missingEngine?.code, "STT_KEY_REQUIRED");
  settings.set("gemini_api_key", "");
  settings.set("openai_api_key", "isolated-key");

  section("the dispatcher router cannot leak generated media to another chat");
  const dispatcher = await import("../src/handlers/command.handler.js");
  await dispatcher.loadCommands();
  const geminiCommand = dispatcher.getLoadedCommands().get("gemini");
  const execute = geminiCommand.execute;
  let routedResult;
  geminiCommand.execute = async (sock, msg) => {
    const real = await resolveCaller({ msg, sock, text: "create an image" });
    routedResult = await runTool(
      "generate_image",
      { prompt: "private content" },
      { caller: real, sock },
    );
  };
  settings.set("reply_route", "authorized_chat");
  settings.set("reply_route_chat", "201999999998@s.whatsapp.net");
  const routedSock = socket();
  try {
    const msg = message();
    await dispatcher.handleCommand(routedSock, msg, "!ai create an image");
    equal(
      "a refused route is not a successful image tool result",
      routedResult?.code,
      "MEDIA_DELIVERY_REFUSED",
    );
    ok(
      "no private media left the source chat",
      routedSock.sent.length > 0 &&
        routedSock.sent.every(
          (sent) => sent.jid === msg.key.remoteJid && !sent.content.image && !sent.content.audio,
        ),
    );
  } finally {
    geminiCommand.execute = execute;
    settings.set("reply_route", "same_chat");
    settings.set("reply_route_chat", "");
  }

  section("the real AI command does not eagerly upload a quoted voice");
  const fake = await startProviderServer({
    [OPENAI_PATH]: [
      openaiToolCall([{ name: "transcribe_audio", args: {} }]),
      openaiText("a private transcript"),
    ],
  });
  settings.set("ai_provider", "openai");
  settings.set("openai_base_url", fake.baseUrl);
  const command = require("./src/commands/gemini.cjs");
  let count = 0;
  media.downloadMedia = async (_download, descriptor) => {
    count += 1;
    downloaded = descriptor;
    return voice.audio;
  };
  try {
    const msg = message({ quoted: audio });
    await command.execute(
      socket(),
      msg,
      ["Transcribe", "this", "voice"],
      "!ai Transcribe this voice",
    );
    equal("audio is downloaded only by the authorized tool", count, 1);
    ok(
      "initial chat request has an attachment marker",
      JSON.stringify(fake.requests[0]?.body).includes("Quoted audio is available"),
    );
    ok(
      "audio bytes are absent from chat requests",
      !JSON.stringify(fake.requests).includes(voice.audio.toString("base64")),
    );
    ok(
      "transcript is tool context, not system instructions",
      fake.requests[1]?.body?.messages?.some(
        (entry) => entry.role === "tool" && entry.content.includes("a private transcript"),
      ),
    );
  } finally {
    await fake.stop();
  }
} finally {
  tts._synthesizeVoice = original.synthesize;
  stt.transcribe = original.transcribe;
  media.downloadMedia = original.download;
  image.generateImage = original.generate;
}
finish();

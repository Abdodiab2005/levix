// Cancellation at asynchronous send boundaries, without network or wall-clock races.
import { mock } from "node:test";
import { copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerHooks } from "node:module";
import { equal, finish, ok, require, section, useTempDataDir } from "./harness.mjs";

const dataDir = useTempDataDir("levix-media-cancellation");
const settings = require("./src/config/settings.cjs");
await require("./src/utils/permissions.cjs").primePermissions();
const { resolveCaller } = require("./src/services/aiToolAuth.cjs");
const { runTool } = require("./src/services/aiTools.cjs");
const cjs = require("./src/utils/sendBotMessage.cjs");
const { timing } = await import("../src/utils/sendBotMessage.esm.js");
const tts = require("./src/commands/tts.cjs");
const image = require("./src/services/aiImage.cjs");
const thumbnail = require("./src/utils/thumbnail.cjs");
const original = {
  synthesize: tts._synthesizeVoice,
  generate: image.generateImage,
  thumbnail: thumbnail.withMediaThumbnail,
  sleep: timing.sleep,
  get: settings.get,
};
const voice = { audio: Buffer.from("OggS-test-voice"), mimetype: "audio/ogg", ptt: true };
tts._synthesizeVoice = async () => voice;
image.generateImage = async () => ({ image: Buffer.from("mock image"), provider: "gemini" });
settings.set("bot_min_delay_ms", 0);
settings.set("bot_max_delay_ms", 0);
settings.get = (key) => (key === "ai_tool_timeout_ms" ? 50 : original.get(key));
timing.sleep = async () => {};
let id = 600;
const jid = () => `20100000${id++}@s.whatsapp.net`;
const sock = () => ({
  sent: [],
  async sendPresenceUpdate() {},
  async sendMessage(chat, content, options) {
    this.sent.push({ chat, content, options });
    return { key: { id: "out", remoteJid: chat } };
  },
});
const caller = (chat) =>
  resolveCaller({
    msg: { key: { remoteJid: chat, id: "in" }, message: { conversation: "!ai test" } },
    sock: sock(),
  });
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const turn = () => new Promise((resolve) => setImmediate(resolve));
async function rejected(label, action, expected) {
  let caught;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  equal(label, caught, expected);
}

// Only the Baileys constructor is replaced: the real socket's async outbound
// preparation and final send boundary still run. No WhatsApp socket is opened.
const socketUrl = new URL("../src/core/socket.js", import.meta.url).href;
const slot = Symbol.for("levix-cancellation-test-socket");
const hook = registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url !== socketUrl) return result;
    const source = String(result.source);
    const needle = 'import { makeWASocket } from "@whiskeysockets/baileys";';
    if (!source.includes(needle)) throw new Error("test socket interception failed");
    return {
      ...result,
      source: source.replace(
        needle,
        'const makeWASocket = () => globalThis[Symbol.for("levix-cancellation-test-socket")];',
      ),
    };
  },
});
let prepare = async (content) => content;
thumbnail.withMediaThumbnail = (...args) => prepare(...args);
const { createWhatsAppSocket } = await import("../src/core/socket.js");
hook.deregister();
async function wrappedSocket() {
  const raw = sock();
  globalThis[slot] = raw;
  return (await createWhatsAppSocket()).sock;
}

try {
  section("timeout during generation, ignored cancellation, concurrency and repeats");
  for (const [tool, args, payload] of [
    ["speak", { text: "hello" }, voice],
    ["generate_image", { prompt: "cat" }, { image: Buffer.from("mock image") }],
  ]) {
    const pending = deferred();
    const entered = deferred();
    const generate = () => {
      entered.resolve();
      return pending.promise;
    };
    if (tool === "speak") tts._synthesizeVoice = generate;
    else image.generateImage = generate;
    const real = await caller(jid());
    const out = sock();
    mock.timers.enable({ apis: ["setTimeout"] });
    const work = runTool(tool, args, { caller: real, sock: out });
    await entered.promise;
    equal(
      `${tool}: concurrent request is busy`,
      (await runTool(tool, args, { caller: real, sock: out })).code,
      "MEDIA_BUSY",
    );
    mock.timers.tick(50);
    equal(`${tool}: deadline expires`, (await work).code, "MEDIA_TIMEOUT");
    equal(
      `${tool}: ignored cancellation stays busy`,
      (await runTool(tool, args, { caller: real, sock: out })).code,
      "MEDIA_BUSY",
    );
    pending.resolve(payload);
    await turn();
    equal(`${tool}: late provider result never sends`, out.sent.length, 0);
    mock.timers.reset();
  }
  tts._synthesizeVoice = async () => voice;
  image.generateImage = async () => ({ image: Buffer.from("mock image"), provider: "gemini" });

  section("tool timeout during per-chat cooldown through the CommonJS wrapper");
  for (const [tool, args] of [
    ["speak", { text: "hello" }],
    ["generate_image", { prompt: "cat" }],
  ]) {
    const chat = jid();
    const out = sock();
    await cjs.sendBotMessage(out, chat, { text: "prime cooldown" }, { typing: false });
    const wait = deferred();
    const entered = deferred();
    timing.sleep = () => {
      entered.resolve();
      return wait.promise;
    };
    settings.set("bot_min_delay_ms", 1000);
    settings.set("bot_max_delay_ms", 1000);
    const real = await caller(chat);
    mock.timers.enable({ apis: ["setTimeout"] });
    const work = runTool(tool, args, { caller: real, sock: out });
    await entered.promise;
    mock.timers.tick(50);
    equal(`${tool}: cooldown exceeds deadline`, (await work).code, "MEDIA_TIMEOUT");
    equal(
      `${tool}: pending send remains busy`,
      (await runTool(tool, args, { caller: real, sock: out })).code,
      "MEDIA_BUSY",
    );
    wait.resolve();
    await turn();
    equal(`${tool}: no send after cooldown resumes`, out.sent.length, 1);
    mock.timers.reset();
    settings.set("bot_min_delay_ms", 0);
    settings.set("bot_max_delay_ms", 0);
    timing.sleep = async () => {};
    equal(
      `${tool}: a subsequent valid request succeeds`,
      (await runTool(tool, args, { caller: real, sock: out })).sent,
      true,
    );
  }

  section("deadline during typing delay");
  {
    const wait = deferred();
    const entered = deferred();
    const out = sock();
    timing.sleep = () => {
      entered.resolve();
      return wait.promise;
    };
    const real = await caller(jid());
    mock.timers.enable({ apis: ["setTimeout"] });
    const work = require("./src/services/aiMedia.cjs")
      .withMediaLimit(real, (signal) =>
        cjs.sendBotMessage(out, real.chatId, { text: "hello" }, { signal }),
      )
      .catch((error) => error);
    await entered.promise;
    mock.timers.tick(50);
    equal("typing deadline expires", (await work).message, "MEDIA_TIMEOUT");
    wait.resolve();
    await turn();
    equal("typing completion cannot initiate a send", out.sent.length, 0);
    mock.timers.reset();
  }

  section("already cancelled, typing delay, and final presence await");
  for (const stage of ["before helper", "typing", "paused"]) {
    const controller = new AbortController();
    const reason = new Error("cancelled");
    const out = sock();
    if (stage === "before helper") controller.abort(reason);
    timing.sleep = async () => {
      if (stage === "typing") controller.abort(reason);
    };
    out.sendPresenceUpdate = async (presence) => {
      if (stage === "paused" && presence === "paused") controller.abort(reason);
    };
    await rejected(
      `${stage}: helper propagates cancellation`,
      () => cjs.sendBotMessage(out, jid(), { text: "hello" }, { signal: controller.signal }),
      reason,
    );
    equal(`${stage}: no raw fallback send`, out.sent.length, 0);
  }
  timing.sleep = async () => {};

  section("socket preparation is inside the cancellation boundary");
  for (const fails of [false, true]) {
    const controller = new AbortController();
    const reason = new Error("cancelled at thumbnail");
    const wait = deferred();
    const entered = deferred();
    prepare = async (content) => {
      entered.resolve();
      await wait.promise;
      if (fails) throw new Error("thumbnail failed");
      return content;
    };
    const out = await wrappedSocket();
    const work = cjs.sendBotMessage(
      out,
      jid(),
      { image: Buffer.from("image") },
      { typing: false, signal: controller.signal },
    );
    await entered.promise;
    controller.abort(reason);
    wait.resolve();
    await rejected(
      `thumbnail ${fails ? "failure" : "success"}: cancellation propagates`,
      () => work,
      reason,
    );
    equal("no Baileys send begins after preparation", out.sent.length, 0);
  }
  prepare = async (content) => content;
  const out = await wrappedSocket();
  const controller = new AbortController();
  await cjs.sendBotMessage(
    out,
    jid(),
    { audio: voice.audio },
    { typing: false, signal: controller.signal },
  );
  equal("ordinary completed send works", out.sent.length, 1);
  ok("signal is consumed before Baileys options", !("signal" in out.sent[0].options));

  section("send failures and refusals never fall back to a second raw send");
  for (const helper of ["sendBotMessage", "sendBotError"]) {
    const reason = new Error("send refused");
    let calls = 0;
    const broken = {
      async sendMessage() {
        calls += 1;
        throw reason;
      },
    };
    await rejected(
      `${helper}: send error is preserved`,
      () =>
        cjs[helper](
          broken,
          jid(),
          helper === "sendBotError" ? new Error("original error") : { text: "hello" },
          ...(helper === "sendBotError" ? ["failed", { typing: false }] : [{ typing: false }]),
        ),
      reason,
    );
    equal(`${helper}: at most one send attempt`, calls, 1);
  }
  let calls = 0;
  const refusal = { refused: true, key: null };
  equal(
    "refusal result remains a refusal",
    await cjs.sendBotMessage(
      {
        async sendMessage() {
          calls += 1;
          return refusal;
        },
      },
      jid(),
      { text: "hello" },
      { typing: false },
    ),
    refusal,
  );
  equal("refused route has no retry", calls, 1);

  section("an import failure cannot bypass the send helpers");
  {
    const shimPath = join(dataDir, "sendBotMessage.cjs");
    copyFileSync(new URL("../src/utils/sendBotMessage.cjs", import.meta.url), shimPath);
    writeFileSync(join(dataDir, "i18n.cjs"), "exports.t = () => 'error';\n");
    const shim = require(shimPath);
    const out = sock();
    for (const helper of ["sendBotMessage", "sendBotError"]) {
      let error;
      try {
        await shim[helper](out, jid(), { text: "hello" });
      } catch (caught) {
        error = caught;
      }
      equal(`${helper}: missing ESM module fails closed`, error?.code, "ERR_MODULE_NOT_FOUND");
    }
    equal("import failure sends nothing", out.sent.length, 0);
  }

  section("deadline through the dispatcher and real socket preparation");
  {
    const dispatcher = await import("../src/handlers/command.handler.js");
    await dispatcher.loadCommands();
    const command = dispatcher.getLoadedCommands().get("gemini");
    const execute = command.execute;
    const wait = deferred();
    const entered = deferred();
    const chat = jid();
    const out = await wrappedSocket();
    let result;
    prepare = async (content) => {
      entered.resolve();
      await wait.promise;
      return content;
    };
    command.execute = async (proxy, msg) => {
      const real = await resolveCaller({ msg, sock: proxy });
      result = await runTool("generate_image", { prompt: "cat" }, { caller: real, sock: proxy });
    };
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const work = dispatcher.handleCommand(
        out,
        { key: { remoteJid: chat, id: "in" }, message: { conversation: "!ai cat" } },
        "!ai cat",
      );
      await entered.promise;
      mock.timers.tick(50);
      await work;
      equal("dispatcher tool expires during thumbnail preparation", result?.code, "MEDIA_TIMEOUT");
      wait.resolve();
      await turn();
      equal("no new WhatsApp send after timeout through the full path", out.sent.length, 0);
    } finally {
      wait.resolve();
      command.execute = execute;
      mock.timers.reset();
      prepare = async (content) => content;
    }
  }

  section("a cancelled edit cannot fall back to a fresh message");
  {
    const dispatcher = await import("../src/handlers/command.handler.js");
    const command = dispatcher.getLoadedCommands().get("digit");
    const execute = command.execute;
    const wait = deferred();
    const entered = deferred();
    const chat = jid();
    const out = await wrappedSocket();
    const ctl = new AbortController();
    const reason = new Error("cancel edit");
    let caught;
    prepare = async (content) => {
      entered.resolve();
      await wait.promise;
      return content;
    };
    command.execute = async (proxy) => {
      try {
        await cjs.sendBotMessage(
          proxy,
          chat,
          { text: "answer" },
          { typing: false, signal: ctl.signal },
        );
      } catch (error) {
        caught = error;
      }
    };
    try {
      const work = dispatcher.handleCommand(
        out,
        {
          key: { remoteJid: chat, id: "in", fromMe: true },
          message: { conversation: "!digit en 1" },
        },
        "!digit en 1",
      );
      await entered.promise;
      ctl.abort(reason);
      wait.resolve();
      await work;
      equal("edit propagates cancellation", caught, reason);
      equal("neither edit nor fallback send was initiated", out.sent.length, 0);
    } finally {
      wait.resolve();
      command.execute = execute;
      prepare = async (content) => content;
    }
  }

  section("an already initiated send is not retractable");
  const pending = deferred();
  const entered = deferred();
  const ctl = new AbortController();
  let sends = 0;
  const initiated = {
    async sendMessage() {
      sends += 1;
      entered.resolve();
      return pending.promise;
    },
  };
  const work = cjs.sendBotMessage(
    initiated,
    jid(),
    { text: "hello" },
    { typing: false, signal: ctl.signal },
  );
  await entered.promise;
  ctl.abort();
  pending.resolve({ key: { id: "already-started" } });
  await work;
  equal("initiated send is neither retracted nor retried", sends, 1);
} finally {
  mock.timers.reset();
  timing.sleep = original.sleep;
  settings.get = original.get;
  tts._synthesizeVoice = original.synthesize;
  image.generateImage = original.generate;
  thumbnail.withMediaThumbnail = original.thumbnail;
  delete globalThis[slot];
}
finish();

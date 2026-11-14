// Real SDK serialization and transport, synthetic media/keys, loopback servers only.
import http from "node:http";
import { equal, finish, ok, require, section, throws, useTempDataDir } from "./harness.mjs";
import { startGenaiServer, textReply } from "./fixtures/genai-server.mjs";

useTempDataDir("levix-gemini-budget");
const {
  geminiHttpOptions,
  assertGeminiRequestBudget,
} = require("./src/utils/geminiHttpOptions.cjs");
const { GoogleGenAI } = require("@google/genai");
const { geminiMediaPart } = require("./src/utils/geminiMedia.cjs");
const { withLang, t } = require("./src/utils/i18n.cjs");
const settings = require("./src/config/settings.cjs");
const { runAgent, isFileReferenceError } = require("./src/services/aiAgent.cjs");
const stt = require("./src/commands/stt.cjs");
const { Agent, getGlobalDispatcher, setGlobalDispatcher } = require("undici");
// Use a real Undici 8 dispatcher regardless of Node/SDK initialization order.
const originalDispatcher = getGlobalDispatcher();
const transport = new Agent();
setGlobalDispatcher(transport);

const MiB = 1024 * 1024;
const limit = 20 * MiB;
const imagePart = (bytes) => ({
  inlineData: { mimeType: "image/jpeg", data: Buffer.alloc(bytes).toString("base64") },
});
const client = (baseUrl) =>
  new GoogleGenAI({
    apiKey: "test-key-not-real",
    apiVersion: "v1beta",
    httpOptions: geminiHttpOptions(baseUrl),
  });

async function rejected(label, run) {
  let error;
  try {
    await run();
  } catch (caught) {
    error = caught;
  }
  equal(label, error?.code, "GEMINI_REQUEST_TOO_LARGE");
  return error;
}

section("Google keeps its SDK transport; custom URLs keep their path and get a budget");
for (const url of [undefined, "", "https://generativelanguage.googleapis.com/"]) {
  equal("no custom transport for Google", geminiHttpOptions(url).fetch, undefined);
}
for (const url of [
  "https://gateway.example",
  "https://gateway.example/gemini/",
  "http://127.0.0.1:1234",
]) {
  equal("base URL preserved", geminiHttpOptions(url).baseUrl, url);
  equal("custom transport installed", typeof geminiHttpOptions(url).fetch, "function");
}

section("exact serialized-byte boundary and localized errors");
{
  const overhead = Buffer.byteLength(JSON.stringify({ contents: [{ parts: [{ text: "" }] }] }));
  const body = JSON.stringify({ contents: [{ parts: [{ text: "a".repeat(limit - overhead) }] }] });
  equal("exactly 20 MiB", Buffer.byteLength(body), limit);
  assertGeminiRequestBudget(body);
  const above = `${body} `; // valid JSON, exactly one byte over
  for (const lang of ["en", "ar", "pt-BR", "es-419"]) {
    withLang(lang, () => {
      const err = throws(`${lang}: one byte over rejected`, () => assertGeminiRequestBudget(above));
      equal("localized error", err?.message, t("bot.ai.gemini.requestTooLarge"));
      ok("translation resolved", !err?.message.startsWith("bot."));
      ok("budget error cannot trigger media/history cleanup", !isFileReferenceError(err));
    });
  }
  // Same JS string length, one more UTF-8 byte.
  throws("UTF-8 bytes, not code units", () => assertGeminiRequestBudget(body.replace("a", "é")));
}

section("actual SDK wire payload: envelope, tools, Unicode and streaming");
let sent = 0;
let wireBytes = 0;
let wireUrl;
let wireBody;
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  sent += 1;
  wireUrl = `http://${req.headers.host}${req.url}`;
  const raw = Buffer.concat(chunks);
  wireBytes = raw.length;
  wireBody = raw.toString("utf8");
  const streaming = req.url.includes(":streamGenerateContent");
  res.writeHead(200, {
    "content-type": streaming ? "text/event-stream" : "application/json",
  });
  res.end(
    streaming ? `data: ${JSON.stringify(textReply("ok"))}\n\n` : JSON.stringify(textReply("ok")),
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
try {
  const genAI = client(`${baseUrl}/custom`);
  const config = {
    systemInstruction: "تعليمات 🖼️",
    tools: [{ functionDeclarations: [{ name: "test", description: "tool envelope" }] }],
  };
  const generate = (text) =>
    genAI.models.generateContent({
      model: "gemini-test",
      contents: [{ role: "user", parts: [{ text }] }],
      config,
    });
  await generate("");
  const padding = "x".repeat(limit - wireBytes);
  await generate(padding);
  equal("SDK final body exactly at limit goes out", wireBytes, limit);
  equal(
    "v1beta + custom prefix preserved",
    wireUrl,
    `${baseUrl}/custom/v1beta/models/gemini-test:generateContent`,
  );
  const count = sent;
  await rejected("one byte above actual SDK limit", () => generate(`${padding}x`));
  equal("oversized request never reaches transport", sent, count);

  const chunks = await genAI.models.generateContentStream({
    model: "gemini-test",
    contents: "small",
  });
  for await (const chunk of chunks) equal("stream parses", chunk.text, "ok");
  ok("SDK supplies alt=sse", wireUrl.endsWith(":streamGenerateContent?alt=sse"));
  const beforeStream = sent;
  await rejected("streaming cannot bypass budget", async () => {
    const response = await genAI.models.generateContentStream({
      model: "gemini-test",
      contents: "x".repeat(limit),
    });
    for await (const _chunk of response) {
      /* force lazy SDK request */
    }
  });
  equal("oversized stream never sent", sent, beforeStream);

  section("one large image, two images, and retained history");
  const sendImage = (part, text = "") =>
    genAI.models.generateContent({
      model: "gemini-test",
      contents: [{ role: "user", parts: [part, { text }] }],
      config,
    });
  await sendImage(imagePart(0));
  const imageEnvelope = wireBytes;
  const fittingImage = imagePart(Math.floor((limit - imageEnvelope) / 4) * 3);
  const remaining = limit - imageEnvelope - fittingImage.inlineData.data.length;
  await sendImage(fittingImage, "x".repeat(remaining));
  equal("large image plus full envelope exactly at limit succeeds", wireBytes, limit);
  await rejected("same image one envelope byte above limit", () =>
    sendImage(fittingImage, "x".repeat(remaining + 1)),
  );
  const large = imagePart(15 * MiB);
  await rejected("15 MiB image leaves no room for JSON", () =>
    genAI.models.generateContent({
      model: "gemini-test",
      contents: [{ parts: [large] }],
    }),
  );
  await rejected("above aggregate decoded-media limit", () =>
    genAI.models.generateContent({
      model: "gemini-test",
      contents: [{ parts: [imagePart(15 * MiB + 1)] }],
    }),
  );
  const half = imagePart(8 * MiB);
  const history = [
    { role: "user", parts: [half] },
    { role: "model", parts: [{ text: "first image" }] },
  ];
  const chat = genAI.chats.create({ model: "gemini-test", history });
  const beforeImages = sent;
  await rejected("two images in one turn", () =>
    genAI.models.generateContent({
      model: "gemini-test",
      contents: [{ role: "user", parts: [half, half] }],
    }),
  );
  await rejected("history image + new image aggregate", () =>
    chat.sendMessage({ message: [half] }),
  );
  equal("images not sent", sent, beforeImages);
  equal("history not trimmed to fit", history.length, 2);
  equal("SDK history retained after rejection", chat.getHistory().length, 2);
  equal("original media retained", history[0].parts[0], half);
  const smaller = imagePart(7 * MiB);
  await genAI.chats
    .create({
      model: "gemini-test",
      history: [
        { role: "user", parts: [smaller] },
        { role: "model", parts: [{ text: "first" }] },
      ],
    })
    .sendMessage({ message: [smaller] });
  equal(
    "two images across history remain intact below both limits",
    JSON.parse(wireBody).contents.filter((turn) => turn.parts.some((part) => part.inlineData))
      .length,
    2,
  );

  // A small attachment can still overflow because of prior text and tool data.
  const historyChat = genAI.chats.create({
    model: "gemini-test",
    history: [
      { role: "user", parts: [{ text: "x".repeat(limit - 100) }] },
      { role: "model", parts: [{ text: "answer" }] },
    ],
  });
  await rejected("image plus text history", () =>
    historyChat.sendMessage({ message: [imagePart(300)] }),
  );
  const toolChat = genAI.chats.create({
    model: "gemini-test",
    history: [
      { role: "user", parts: [{ text: "question" }] },
      {
        role: "model",
        parts: [{ functionCall: { name: "test", args: { text: "x".repeat(limit - 100) } } }],
      },
    ],
  });
  await rejected("follow-up tool response includes previous arguments", () =>
    toolChat.sendMessage({
      message: [{ functionResponse: { name: "test", response: { text: "result" } } }],
    }),
  );
  const argumentsOnly = {
    functionCall: { name: "test", args: { inlineData: { data: "not media" } } },
  };
  await genAI.models.generateContent({
    model: "gemini-test",
    contents: [{ role: "model", parts: [argumentsOnly] }],
  });
  ok("inlineData inside tool arguments is untouched", wireBody.includes("not media"));

  section("production agent validates with its real instruction and tools");
  settings.set("ai_provider", "gemini");
  settings.set("gemini_api_key", "test-key-not-real");
  settings.set("gemini_base_url", baseUrl);
  const beforeAgent = sent;
  await rejected("agent rejects large media", () =>
    runAgent({ parts: [large], history: [], search: false }),
  );
  equal("agent sends nothing", sent, beforeAgent);
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

section("caller abort and SDK timeout cancel real sockets before headers and during body reads");
for (const phase of ["headers", "body"]) {
  for (const cause of ["caller", "timeout"]) {
    const received = Promise.withResolvers();
    const closed = Promise.withResolvers();
    let requests = 0;
    const stalled = http.createServer(async (req, res) => {
      for await (const _chunk of req) {
        /* consume the real request */
      }
      requests += 1;
      res.on("close", closed.resolve);
      if (phase === "body") {
        res.writeHead(200, { "content-type": "application/json" });
        res.write('{"candidates":['); // Headers arrive; JSON never completes.
      }
      received.resolve();
    });
    await new Promise((resolve) => stalled.listen(0, "127.0.0.1", resolve));
    const controller = new AbortController();
    const genAI = client(`http://127.0.0.1:${stalled.address().port}/custom`);
    const started = performance.now();
    const pending = genAI.models
      .generateContent({
        model: "gemini-test",
        contents: "stall",
        config: {
          ...(cause === "caller" ? { abortSignal: controller.signal } : {}),
          httpOptions: { timeout: cause === "timeout" ? 500 : 5000, retryOptions: { attempts: 1 } },
        },
      })
      .then(
        () => null,
        (error) => error,
      );
    // An independent deadline bounds a broken transport without letting a test hang.
    let watchdogTimer;
    const watchdog = new Promise((resolve) => {
      watchdogTimer = setTimeout(() => resolve("watchdog"), 4000);
    });
    try {
      equal(
        `${cause}/${phase}: server received request`,
        await Promise.race([received.promise.then(() => "received"), watchdog]),
        "received",
      );
      if (cause === "caller") controller.abort();
      const error = await Promise.race([pending, watchdog]);
      equal(`${cause}/${phase}: SDK reports abort`, error?.name, "AbortError");
      equal(
        `${cause}/${phase}: server observes socket close`,
        await Promise.race([closed.promise.then(() => "closed"), watchdog]),
        "closed",
      );
      equal(`${cause}/${phase}: only one attempt`, requests, 1);
      if (cause === "timeout") {
        ok(`${phase}: SDK deadline elapsed`, performance.now() - started >= 400);
      }
    } finally {
      clearTimeout(watchdogTimer);
      controller.abort();
      stalled.closeAllConnections();
      await new Promise((resolve) => stalled.close(resolve));
      await pending;
    }
  }
}

section("working Files API upload and polling use the compatible transport");
const files = await startGenaiServer([], { fileStates: ["PROCESSING", "ACTIVE"] });
try {
  const genAI = client(files.baseUrl);
  const bytes = Buffer.from("synthetic-video-bytes");
  const part = await geminiMediaPart(genAI, bytes, "video/mp4", {
    baseUrl: files.baseUrl,
    pollMs: 1,
  });
  ok("upload carries exact bytes", files.uploads[0]?.bytes?.equals(bytes));
  equal("upload declares MIME", files.uploads[0]?.mimeType, "video/mp4");
  equal("processing file is polled", files.fileGets.length, 1);
  equal(
    "active file reference preserved",
    part.fileData?.fileUri,
    `${files.baseUrl}/v1beta/files/test1`,
  );
  const result = await genAI.models.generateContent({
    model: "gemini-test",
    contents: [{ role: "user", parts: [part] }],
  });
  equal("uploaded file request succeeds", result.text, "ok");
  equal(
    "file URI sent on wire",
    files.body().contents[0].parts[0].fileData.fileUri,
    part.fileData.fileUri,
  );
} finally {
  await files.stop();
}

section("missing Files API, custom prefix, small agent request and STT (real local server)");
const fake = await startGenaiServer([], { filesApi: false, prefix: "/gemini" });
try {
  settings.set("gemini_base_url", fake.baseUrl);
  settings.set("ai_stt_provider", "gemini");
  const genAI = client(fake.baseUrl);
  const bytes = Buffer.from("synthetic-jpeg");
  const part = await geminiMediaPart(genAI, bytes, "image/jpeg", { baseUrl: fake.baseUrl });
  equal("missing upload fell back inline", part.inlineData?.data, bytes.toString("base64"));
  ok("upload was attempted", fake.refused.length > 0);
  const refused = fake.refused.length;
  await geminiMediaPart(genAI, bytes, "image/jpeg", { baseUrl: fake.baseUrl });
  equal("missing API cache preserved", fake.refused.length, refused);
  const result = await runAgent({
    parts: [part, { text: "describe" }],
    history: [],
    search: false,
  });
  equal("small agent request succeeds", result.text, "ok");
  equal(
    "inline bytes preserved on wire",
    fake.body().contents.at(-1).parts[0].inlineData.data,
    part.inlineData.data,
  );
  equal(
    "small STT succeeds with per-call httpOptions",
    await stt.transcribe(Buffer.from("OggS-test"), "audio/ogg; codecs=opus"),
    "ok",
  );
  equal(
    "STT bare MIME preserved",
    fake.last().contents[0].parts[0].inlineData.mimeType,
    "audio/ogg",
  );
  equal(
    "STT reaches v1beta route",
    fake.requests.at(-1).url,
    `/v1beta/models/${settings.get("gemini_stt_model")}:generateContent`,
  );
} finally {
  settings.set("gemini_base_url", "");
  await fake.stop();
}

setGlobalDispatcher(originalDispatcher);
await transport.close();
finish();

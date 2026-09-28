// WhatsApp media on its way to Gemini: photos, voice notes, documents, and
// `!stt`.
//
// Both failures this pins down reached the user as an error card:
//
//   * "Can not determine mimeType. Please provide mimeType in the config." —
//     the agent handed the MIME type to `files.upload` outside `config`, and
//     wrote the bytes to a temp file with no extension to infer it from. Every
//     photo, video, voice note and document sent to the AI failed.
//   * `!stt` sent WhatsApp's `audio/ogg; codecs=opus` label as the audio type,
//     wrote its temp file next to the code, and handed the Whisper path the
//     download STREAM where a Buffer belongs.
//
// Like genai.test.mjs, the real @google/genai SDK runs here against the local
// stand-in for the Gemini endpoint, so the assertions are about the requests
// that actually went out.

import http from "node:http";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { startGenaiServer, textReply } from "./fixtures/genai-server.mjs";
import {
  equal,
  finish,
  require as harnessRequire,
  ok,
  ROOT,
  section,
  useTempDataDir,
} from "./harness.mjs";

useTempDataDir("levix-gemini-media");

const settings = harnessRequire("./src/config/settings.cjs");
const { GoogleGenAI } = harnessRequire("@google/genai");
const { baseMimeType, mediaKind, uploadToGemini, isMissingUploadEndpoint } = harnessRequire(
  "./src/utils/geminiMedia.cjs",
);
const aiAgent = harnessRequire("./src/services/aiAgent.cjs");
// (requiring aiAgent above is also what registers the gemini provider)
const { getProvider } = harnessRequire("./src/services/aiRouter.cjs");

settings.set("ai_provider", "gemini");
settings.set("gemini_api_key", "test-key-not-real");
settings.set("ai_vision_enabled", true);
settings.set("ai_stt_enabled", true);

/** A stand-in for Baileys' downloadContentFromMessage: records the type. */
function fakeDownloader(bytes) {
  const calls = [];
  const download = async (_message, type) => {
    calls.push(type);
    return (async function* () {
      // More than one chunk, the way a real decrypt stream arrives.
      yield bytes.subarray(0, 3);
      yield bytes.subarray(3);
    })();
  };
  return { download, calls };
}

async function withGemini(options, run, replies = []) {
  const fake = await startGenaiServer(replies, options);
  settings.set("gemini_base_url", fake.baseUrl);
  const genAI = new GoogleGenAI({ apiKey: "test-key", httpOptions: { baseUrl: fake.baseUrl } });
  try {
    return await run({ fake, genAI });
  } finally {
    settings.set("gemini_base_url", "");
    await fake.stop();
  }
}

const tempLeftovers = () =>
  ["src/services", "src/commands"].flatMap((dir) =>
    readdirSync(join(ROOT, dir)).filter((name) => /^(temp_media_|stt_audio_)/.test(name)),
  );

// ---------------------------------------------------------------------------

section("MIME types the way Gemini wants them");

equal("a voice note loses its codec parameter", baseMimeType("audio/ogg; codecs=opus"), "audio/ogg");
equal("case is normalised", baseMimeType("Image/JPEG"), "image/jpeg");
equal("a plain type is left alone", baseMimeType("application/pdf"), "application/pdf");
equal("no type at all falls back by kind", baseMimeType("", "audio"), "audio/ogg");
equal("…and for a photo", baseMimeType(undefined, "image"), "image/jpeg");
equal("kind: image", mediaKind("image/webp"), "image");
equal("kind: audio with parameters", mediaKind("audio/ogg; codecs=opus"), "audio");
equal("kind: anything else is a document", mediaKind("application/pdf"), "document");

section("a photo is uploaded with its MIME type (the screenshot's error)");

await withGemini({}, async ({ fake, genAI }) => {
  const bytes = Buffer.from("\xff\xd8\xff-fake-jpeg", "latin1");
  const { download, calls } = fakeDownloader(bytes);
  const parts = [];

  let error = null;
  try {
    await getProvider("gemini").prepareMedia(parts, { mimetype: "image/jpeg" }, null, {
      downloadContentFromMessage: download,
      genAI,
      downloadType: "image",
    });
  } catch (err) {
    error = err;
  }

  ok(`no error (${error?.message || "none"})`, error === null);
  equal("one upload went out", fake.uploads.length, 1);
  equal("…declaring image/jpeg", fake.uploads[0]?.mimeType, "image/jpeg");
  equal("…in the upload metadata too", fake.uploads[0]?.declared?.file?.mimeType, "image/jpeg");
  ok("…carrying every chunk of the photo", fake.uploads[0]?.bytes?.equals(bytes));
  equal("it was downloaded with the image keys", calls[0], "image");
  equal("the model gets a fileData part", parts.length, 1);
  equal("…with the uploaded file's URI", parts[0]?.fileData?.fileUri, `${fake.baseUrl}/v1beta/files/test1`);
  equal("…and its MIME type", parts[0]?.fileData?.mimeType, "image/jpeg");
});

section("a voice note to the agent is uploaded as audio/ogg");

await withGemini({}, async ({ fake, genAI }) => {
  const { download } = fakeDownloader(Buffer.from("OggS-fake-opus"));
  const parts = [];
  await getProvider("gemini").prepareMedia(
    parts,
    { mimetype: "audio/ogg; codecs=opus", ptt: true },
    null,
    { downloadContentFromMessage: download, genAI, downloadType: "audio" },
  );
  equal("the upload declares audio/ogg", fake.uploads[0]?.mimeType, "audio/ogg");
  equal("and so does the part the model sees", parts[0]?.fileData?.mimeType, "audio/ogg");
});

section("a photo sent as a document is downloaded as a document");

await withGemini({}, async ({ fake, genAI }) => {
  const { download, calls } = fakeDownloader(Buffer.from("\x89PNG-fake", "latin1"));
  const parts = [];
  await getProvider("gemini").prepareMedia(parts, { mimetype: "image/png", fileName: "a.png" }, null, {
    downloadContentFromMessage: download,
    genAI,
    downloadType: "document",
  });
  // The decryption keys follow the message type; the image keys would fail to
  // decrypt a document.
  equal("the document keys were used", calls[0], "document");
  equal("the upload still says image/png", fake.uploads[0]?.mimeType, "image/png");
});

section("a video is used only once Google has processed it");

await withGemini({ fileStates: ["PROCESSING", "PROCESSING", "ACTIVE"] }, async ({ fake, genAI }) => {
  const file = await uploadToGemini(genAI, Buffer.from("fake-mp4"), "video/mp4", { pollMs: 5 });
  equal("it waited for ACTIVE", file.state, "ACTIVE");
  equal("…asking twice", fake.fileGets.length, 2);
  ok("and returned a URI", !!file.uri);
});

await withGemini({ fileStates: ["PROCESSING", "FAILED"] }, async ({ genAI }) => {
  let error = null;
  try {
    await uploadToGemini(genAI, Buffer.from("fake-mp4"), "video/mp4", { pollMs: 5 });
  } catch (err) {
    error = err;
  }
  ok("a file Google failed to process is an error, not a dead URI", error !== null);
});

section("a gateway under a path: the photo goes inline (the second screenshot)");

// `gemini_base_url` pointing at a reverse proxy under a path. Text and voice
// notes worked through it; every photo died on "404 Not Found … nginx",
// because the SDK rewrites Google's upload URL to the proxy's host but keeps
// Google's path, which is outside the proxy's prefix.
await withGemini(
  { prefix: "/gemini" },
  async ({ fake, genAI }) => {
    const bytes = Buffer.from("\xff\xd8\xff-a-photo", "latin1");
    const parts = [];
    let error = null;
    try {
      await getProvider("gemini").prepareMedia(parts, { mimetype: "image/jpeg" }, null, {
        downloadContentFromMessage: fakeDownloader(bytes).download,
        genAI,
        downloadType: "image",
      });
    } catch (err) {
      error = err;
    }
    ok(`no error reaches the user (${error?.message?.slice(0, 60) || "none"})`, error === null);
    ok("the upload really was refused with the proxy's 404", fake.refused.length >= 1);
    equal("the photo became an inline part", parts[0]?.inlineData?.mimeType, "image/jpeg");
    ok(
      "…carrying its bytes",
      Buffer.from(parts[0]?.inlineData?.data || "", "base64").equals(bytes),
    );

    // And the model gets it, through the same prefixed endpoint.
    const result = await aiAgent.runAgent({
      parts: [...parts, { text: "describe it" }],
      history: [],
    });
    equal("the answer came back", result.text, "a man in a chair");
    const sent = fake.body(0)?.contents?.at(-1)?.parts || [];
    ok("the request carried the photo inline", sent.some((part) => part.inlineData?.data));
    ok("…and no file reference", !sent.some((part) => part.fileData));

    // The next photo doesn't pay for a doomed upload again.
    const refusedBefore = fake.refused.length;
    const uploadsBefore = fake.uploads.length;
    const again = [];
    await getProvider("gemini").prepareMedia(again, { mimetype: "image/jpeg" }, null, {
      downloadContentFromMessage: fakeDownloader(bytes).download,
      genAI,
      downloadType: "image",
    });
    ok("the second photo went straight inline", !!again[0]?.inlineData);
    equal("…with no upload attempt", fake.uploads.length, uploadsBefore);
    equal("…and nothing refused", fake.refused.length, refusedBefore);
  },
  [textReply("a man in a chair")],
);

section("a gateway with no upload route at all");

await withGemini({ filesApi: false }, async ({ fake, genAI }) => {
  const parts = [];
  await getProvider("gemini").prepareMedia(parts, { mimetype: "image/png" }, null, {
    downloadContentFromMessage: fakeDownloader(Buffer.from("\x89PNG-bytes", "latin1")).download,
    genAI,
    downloadType: "image",
  });
  ok("refused at the first upload request", fake.refused.length === 1);
  equal("and sent inline instead", parts[0]?.inlineData?.mimeType, "image/png");
});

section("a working Files API is still used, per endpoint");

await withGemini({}, async ({ fake, genAI }) => {
  const parts = [];
  await getProvider("gemini").prepareMedia(parts, { mimetype: "image/jpeg" }, null, {
    downloadContentFromMessage: fakeDownloader(Buffer.from("\xff\xd8-photo", "latin1")).download,
    genAI,
    downloadType: "image",
  });
  ok("another endpoint's missing Files API isn't held against this one", !!parts[0]?.fileData);
  equal("one upload", fake.uploads.length, 1);
});

section("only a missing endpoint falls back — a real error still surfaces");

ok("404", isMissingUploadEndpoint({ status: 404 }));
ok("405", isMissingUploadEndpoint({ status: 405 }));
ok("an HTML page instead of JSON", isMissingUploadEndpoint({ message: '{"error":{"message":"<html>…"}}' }));
ok(
  "the SDK's missing-upload-URL complaint",
  isMissingUploadEndpoint({ message: "Failed to get upload url. Server did not return the x-google-upload-url in the headers" }),
);
ok("a bad key is not", !isMissingUploadEndpoint({ status: 403, message: "API key not valid" }));
ok("a quota error is not", !isMissingUploadEndpoint({ status: 429, message: "RESOURCE_EXHAUSTED" }));
ok("a server error is not", !isMissingUploadEndpoint({ status: 500, message: "internal" }));

// ---------------------------------------------------------------------------

const stt = harnessRequire("./src/commands/stt.cjs");

section("!stt on Gemini: the voice note goes inline, as audio/ogg");

settings.set("ai_stt_provider", "gemini");
await withGemini(
  {},
  async ({ fake }) => {
    const audio = Buffer.from("OggS-a-short-voice-note");
    const text = await stt.transcribe(audio, "audio/ogg; codecs=opus");

    equal("the transcript came back", text, "مرحبا");
    equal("no Files API upload for a small voice note", fake.uploads.length, 0);
    const part = fake.body(0)?.contents?.[0]?.parts?.[0];
    equal("it went inline as audio/ogg", part?.inlineData?.mimeType, "audio/ogg");
    ok("…with the actual bytes", Buffer.from(part?.inlineData?.data || "", "base64").equals(audio));
    equal(
      "to the transcription model",
      fake.requests[0]?.url,
      `/v1beta/models/${settings.get("gemini_stt_model")}:generateContent`,
    );
  },
  [textReply("مرحبا")],
);

section("!stt on Whisper: the audio is a real file in the form");

{
  let received = null;
  const whisper = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      received = { url: req.url, body: Buffer.concat(chunks).toString("latin1") };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ text: "from whisper" }));
    });
  });
  await new Promise((resolve) => whisper.listen(0, "127.0.0.1", resolve));
  settings.set("ai_stt_provider", "openai");
  settings.set("openai_api_key", "test-openai-key");
  settings.set("openai_base_url", `http://127.0.0.1:${whisper.address().port}/v1`);
  try {
    const text = await stt.transcribe(Buffer.from("OggS-voice-bytes"), "audio/ogg; codecs=opus");
    equal("the transcript came back", text, "from whisper");
    equal("to the transcription route", received?.url, "/v1/audio/transcriptions");
    ok("the form carries the audio bytes", received?.body.includes("OggS-voice-bytes"));
    ok("…not a stringified stream", !received?.body.includes("[object Object]"));
    ok("…as audio.ogg", received?.body.includes('filename="audio.ogg"'));
  } finally {
    settings.set("ai_stt_provider", "auto");
    settings.set("openai_api_key", "");
    settings.set("openai_base_url", "");
    await new Promise((resolve) => whisper.close(resolve));
  }
}

section("nothing is written next to the code");

equal("no temp media files in src/", tempLeftovers().join(", "), "");

// ---------------------------------------------------------------------------

section("a quoted photo that can't be read is ONE reply, not an error plus a blind answer");

{
  const gemini = harnessRequire("./src/commands/gemini.cjs");
  await withGemini({}, async ({ fake }) => {
    const sent = [];
    const sock = {
      user: { id: "201999999999:7@s.whatsapp.net" },
      async sendMessage(jid, content) {
        sent.push({ jid, content });
        return { key: { id: `m${sent.length}`, remoteJid: jid, fromMe: true } };
      },
      async sendPresenceUpdate() {},
      async presenceSubscribe() {},
    };
    const self = "201999999999@s.whatsapp.net";
    const msg = {
      key: { remoteJid: self, fromMe: true, id: "q1" },
      pushName: "Owner",
      message: {
        extendedTextMessage: {
          text: ".ai اوصف الصورة",
          contextInfo: {
            stanzaId: "img1",
            participant: self,
            // No media key or URL: the download fails before any network I/O.
            quotedMessage: { imageMessage: { mimetype: "image/jpeg" } },
          },
        },
      },
    };

    await gemini.execute(sock, msg, ["اوصف", "الصورة"], ".ai اوصف الصورة", null, {
      invokedName: "ai",
    });

    const texts = sent.map((s) => s.content?.text).filter(Boolean);
    equal("exactly one message was sent", sent.length, 1);
    ok("…and it is the error card", /الرسالة المقتبسة/.test(texts[0] || ""), texts[0]);
    equal("the model was never asked to answer without the photo", fake.requests.length, 0);
  });
}

finish();

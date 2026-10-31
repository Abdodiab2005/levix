// Exercise URL validation and the actual socket wrapper with fake transports.
// No live endpoint, WhatsApp socket, or production data is used.
import { spawnSync } from "node:child_process";
import { promises as dns } from "node:dns";
import { join } from "node:path";
import { mock } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { equal, finish, ok, ROOT, require, section, useTempDataDir } from "./harness.mjs";

if (!process.execArgv.includes("--experimental-test-module-mocks")) {
  const child = spawnSync(
    process.execPath,
    ["--experimental-test-module-mocks", fileURLToPath(import.meta.url)],
    { stdio: "inherit", env: process.env, timeout: 30_000 },
  );
  if (child.error) console.error(child.error.message);
  process.exit(child.status ?? 1);
}
useTempDataDir("levix-https-fetch");
const source = (path) => pathToFileURL(join(ROOT, path)).href;
const sent = [];
mock.module(require.resolve("@whiskeysockets/baileys"), {
  namedExports: {
    makeWASocket: () => ({
      async sendMessage(jid, content, options) {
        // Model Baileys's fallback behavior: an explicit null/object wins;
        // otherwise its per-send getUrlInfo hook generates the preview.
        let preview = content.linkPreview;
        if (preview === undefined && content.text) {
          const match = content.text.match(/https?:\/\/[^\s]+/i)?.[0];
          if (match) preview = await options.getUrlInfo(match);
        }
        sent.push({ jid, content, options, preview });
        return { key: { id: "sent" } };
      },
    }),
  },
});
mock.module(source("src/auth/use-database-auth-state.js"), {
  namedExports: {
    useDatabaseAuthState: async () => ({ state: { creds: {} }, saveCreds() {}, clearAll() {} }),
  },
});
mock.module(source("src/config/baileys.config.js"), {
  namedExports: { getBaileysConfig: () => ({}), setRecentMessageGetter() {} },
});

const settings = require("./src/config/settings.cjs");
const provider = require("./src/utils/providerUrl.cjs");
const originalFetch = provider.safeProviderFetch;
const originalLookup = dns.lookup;
const calls = [];
let route;
dns.lookup = async (host) => [
  {
    address: host === "private.example" ? "192.168.1.20" : "8.8.8.8",
    family: 4,
  },
];
provider.safeProviderFetch = async (url, init, options) => {
  await provider.assertProviderRequestUrl(url, options);
  calls.push({ url, init, options });
  return route(url, init);
};
const { fetchHttpsBuffer } = require("./src/utils/httpsFetch.cjs");
const { getHttpsUrlInfo } = require("./src/utils/linkPreview.cjs");
const { withMediaThumbnail } = require("./src/utils/thumbnail.cjs");
const { createWhatsAppSocket } = await import(source("src/core/socket.js"));
const { sock } = await createWhatsAppSocket();
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const html = (body) =>
  new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
const redirect = (location) => new Response("redirect", { status: 302, headers: { location } });
async function rejects(label, run) {
  try {
    await run();
    ok(label, false, "expected rejection");
  } catch {
    ok(label, true);
  }
}
function reset(handler) {
  calls.length = 0;
  route = handler;
}

try {
  section("unsafe entry URLs never reach a transport");
  reset(() => {
    throw new Error("must not fetch");
  });
  for (const url of [
    "http://public.example/a",
    "HTTP://public.example/a",
    "https://127.0.0.1/a",
    "https://[::1]/a",
    "https://169.254.169.254/a",
    "https://u:p@public.example/a",
    "file:///tmp/a",
    "not a url",
    "https://private.example/a",
  ]) {
    await rejects(`reject ${url}`, () => fetchHttpsBuffer(url));
  }
  equal("all rejected before network dispatch", calls.length, 0);
  // The real fetch implementation must also refuse a private DNS answer before
  // constructing a socket, independently of our fake response router.
  await rejects("real DNS-pinned boundary refuses a private DNS answer", () =>
    originalFetch("https://private.example/a", {}, { allowLoopback: false }),
  );

  section("HTTPS redirects retain bounds and never downgrade");
  reset((url) => (url.endsWith("/start") ? redirect("/final?q=1#fragment") : new Response("safe")));
  const result = await fetchHttpsBuffer("https://public.example/start");
  equal(
    "relative redirect resolved and fragment stripped",
    result.url,
    "https://public.example/final?q=1",
  );
  equal("response bytes preserved", result.buffer.toString(), "safe");
  equal("one timeout signal covers the chain", calls[0].init.signal, calls[1].init.signal);
  ok(
    "every hop requests manual redirects with loopback disabled",
    calls.every((c) => c.init.redirect === "manual" && c.options.allowLoopback === false),
  );
  for (const destination of [
    "http://public.example/plain",
    "//private.example/a",
    "https://127.0.0.1/a",
    "https://u:p@public.example/a",
  ]) {
    let cancelled = false;
    reset(
      () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { status: 307, headers: { location: destination } },
        ),
    );
    await rejects(`redirect blocked: ${destination}`, () =>
      fetchHttpsBuffer("https://public.example/start"),
    );
    equal("blocked redirect did not dispatch a second request", calls.length, 1);
    ok("redirect body cancelled", cancelled);
  }
  reset(() => redirect("/loop"));
  await rejects("redirect loop is bounded", () => fetchHttpsBuffer("https://public.example/loop"));
  equal("at most four redirects followed", calls.length, 5);
  reset(() => new Response("", { status: 302 }));
  await rejects("missing redirect location is refused", () =>
    fetchHttpsBuffer("https://public.example/a"),
  );

  section("streamed limits and failures clean up");
  let cancelled = false;
  reset(
    () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-length": "100" } },
      ),
  );
  await rejects("oversized content-length refused", () =>
    fetchHttpsBuffer("https://public.example/a", { maxBytes: 4 }),
  );
  ok("oversized declared body cancelled", cancelled);
  cancelled = false;
  reset(
    () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array(3));
            c.enqueue(new Uint8Array(3));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  );
  await rejects("decoded/chunked response capped without content-length", () =>
    fetchHttpsBuffer("https://public.example/a", { maxBytes: 4 }),
  );
  ok("oversized stream cancelled", cancelled);
  reset(() => new Response("no", { status: 503 }));
  await rejects("HTTP errors refused", () => fetchHttpsBuffer("https://public.example/a"));
  reset(
    (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  );
  const keepAlive = setTimeout(() => {}, 100);
  await rejects("stalled request times out", () =>
    fetchHttpsBuffer("https://public.example/a", { timeoutMs: 10 }),
  );
  clearTimeout(keepAlive);
  let lateCancelled = false;
  reset(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return new Response(
      new ReadableStream({
        cancel() {
          lateCancelled = true;
        },
      }),
    );
  });
  await rejects("deadline also bounds a transport that has not finished DNS", () =>
    fetchHttpsBuffer("https://public.example/a", { timeoutMs: 10 }),
  );
  await new Promise((resolve) => setTimeout(resolve, 35));
  ok("late response body cancelled after timeout", lateCancelled);
  reset((url) =>
    url.includes("public.example") ? redirect("https://other.example/final") : new Response("ok"),
  );
  equal(
    "public HTTPS cross-host redirect is supported",
    (await fetchHttpsBuffer("https://public.example/a")).buffer.toString(),
    "ok",
  );
  reset(() => new Response("1234"));
  equal(
    "response exactly at the byte limit is accepted",
    (await fetchHttpsBuffer("https://public.example/a", { maxBytes: 4 })).buffer.length,
    4,
  );

  section("optional page previews never fall back to unsafe downloads");
  settings.set("link_previews_enabled", false);
  reset(() => {
    throw new Error("must not fetch");
  });
  equal("opt-out returns no preview", await getHttpsUrlInfo("https://public.example/a"), undefined);
  equal("opt-out costs no requests", calls.length, 0);
  settings.set("link_previews_enabled", true);
  equal("HTTP preview skipped", await getHttpsUrlInfo("http://public.example/a"), undefined);
  equal("HTTP preview costs no requests", calls.length, 0);
  reset(() => redirect("http://public.example/plain"));
  equal("downgraded preview skipped", await getHttpsUrlInfo("https://public.example/a"), undefined);
  equal("preview downgrade never dispatched", calls.length, 1);
  reset(() =>
    html(
      '<head><meta content="A &amp; B" property="og:title"><meta name="description" content="Description"><meta property="og:image" content="http://public.example/image"></head>',
    ),
  );
  const safeTitle = await getHttpsUrlInfo("https://public.example/a");
  equal("safe title decoded", safeTitle.title, "A & B");
  equal("description preserved", safeTitle.description, "Description");
  equal("HTTP image not fetched", calls.length, 1);
  reset((url) =>
    url.endsWith("/image")
      ? redirect("http://public.example/image")
      : html('<title>Safe page</title><meta property="og:image" content="/image">'),
  );
  const imageDowngrade = await getHttpsUrlInfo("https://public.example/a");
  equal("image downgrade keeps page metadata", imageDowngrade.title, "Safe page");
  equal("image downgrade has no thumbnail", imageDowngrade.jpegThumbnail, undefined);
  equal("only HTTPS page and image requested", calls.length, 2);
  reset((url) =>
    url.endsWith("/image")
      ? new Response(png, { headers: { "content-type": "image/png" } })
      : html('<title>Safe page</title><meta property="og:image" content="/image">'),
  );
  const imagePreview = await getHttpsUrlInfo("https://public.example/a");
  ok("HTTPS image produces local thumbnail", Buffer.isBuffer(imagePreview.jpegThumbnail));
  reset(() => new Response("not HTML", { headers: { "content-type": "text/plain" } }));
  equal(
    "non-HTML gets no page preview",
    await getHttpsUrlInfo("https://public.example/a"),
    undefined,
  );

  section("standalone thumbnails use the same guard");
  settings.set("thumbnail_remote", true);
  reset(() => {
    throw new Error("must not fetch");
  });
  const unsafeThumb = { image: { url: "http://public.example/image" } };
  equal(
    "unsafe optional thumbnail leaves content intact",
    await withMediaThumbnail(unsafeThumb),
    unsafeThumb,
  );
  equal("unsafe thumbnail performs no request", calls.length, 0);
  reset(() => redirect("http://public.example/image"));
  const downgradedThumb = { image: { url: "https://public.example/image" } };
  equal(
    "downgraded optional thumbnail leaves content intact",
    await withMediaThumbnail(downgradedThumb),
    downgradedThumb,
  );
  equal("thumbnail downgrade never dispatched", calls.length, 1);

  section("socket closes implicit Baileys paths while preserving text sends");
  reset(() => {
    throw new Error("network failed");
  });
  const unsafeOptions = {
    quoted: { key: { id: "quoted" } },
    getUrlInfo() {
      throw new Error("unsafe fallback");
    },
  };
  await sock.sendMessage("chat", { text: "https://public.example/a" }, unsafeOptions);
  equal("failed preview still sends text", sent.at(-1).content.text, "https://public.example/a");
  equal("safe per-send hook cannot be overridden", sent.at(-1).options.getUrlInfo, getHttpsUrlInfo);
  equal("quoted options preserved", sent.at(-1).options.quoted, unsafeOptions.quoted);
  await sock.sendMessage("chat", { text: "http://public.example/a" });
  equal("HTTP text still sends", sent.at(-1).content.text, "http://public.example/a");
  reset(() => {
    throw new Error("must not fetch");
  });
  const explicit = { title: "Provided", "matched-text": "https://public.example/a" };
  await sock.sendMessage("chat", { text: "https://public.example/a", linkPreview: explicit });
  equal("explicit preview preserved", sent.at(-1).preview, explicit);
  await sock.sendMessage("chat", { text: "https://public.example/a", linkPreview: null });
  equal("explicit null preserved", sent.at(-1).preview, null);
  settings.set("link_previews_enabled", false);
  await sock.sendMessage("chat", { text: "https://public.example/a" });
  equal("socket opt-out suppresses preview", sent.at(-1).content.linkPreview, null);
  await sock.sendMessage("chat", { text: "https://public.example/a", linkPreview: undefined });
  equal("explicit undefined cannot bypass opt-out", calls.length, 0);
  for (const field of ["image", "video", "audio", "document", "sticker"]) {
    const before = sent.length;
    await rejects(`HTTP ${field} refused even with explicit thumbnail`, () =>
      sock.sendMessage("chat", {
        [field]: { url: "http://public.example/media" },
        jpegThumbnail: png,
      }),
    );
    equal("unsafe media never reaches Baileys", sent.length, before);
  }
  reset(() => redirect("http://public.example/media"));
  await rejects("remote media downgrade refuses send", () =>
    sock.sendMessage("chat", { audio: { url: "https://public.example/media" } }),
  );
  equal("remote media downgrade never dispatched", calls.length, 1);
  settings.set("thumbnail_remote", false);
  reset(() => new Response(png));
  await sock.sendMessage("chat", {
    image: { url: new URL("https://public.example/image") },
    caption: "kept",
  });
  equal("actual remote media downloaded exactly once", calls.length, 1);
  ok("Baileys receives bytes instead of unchecked URL", Buffer.isBuffer(sent.at(-1).content.image));
  equal("caption preserved", sent.at(-1).content.caption, "kept");
  reset(() => {
    throw new Error("must not fetch");
  });
  const local = { audio: { url: "/tmp/local.ogg" } };
  await sock.sendMessage("chat", local);
  equal("local media path preserved", sent.at(-1).content.audio, local.audio);
  equal("local media costs no fetch", calls.length, 0);
} finally {
  provider.safeProviderFetch = originalFetch;
  dns.lookup = originalLookup;
}
finish();

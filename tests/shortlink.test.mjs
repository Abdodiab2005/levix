// !shortlink: link extraction, is.gd -> v.gd fallback, and the one-message rule.
//
// The network is never touched: the command exposes its HTTP GET as `http`,
// and every scenario swaps in a stub.

import { equal, finish, ok, require, section, useTempDataDir } from "./harness.mjs";

useTempDataDir("levix-shortlink");

const settings = require("./src/config/settings.cjs");
settings.set("bot_min_delay_ms", 0);
settings.set("bot_max_delay_ms", 0);
settings.set("bot_language", "en");

const shortlink = require("./src/commands/shortlink.cjs");
const { extractUrls, normaliseUrl, parseResponse, shortenUrl, http } = shortlink;

const CHAT = "201111111111@s.whatsapp.net";

// --- HTTP stubs -----------------------------------------------------------

const serverError = (message) => ({
  data: message,
});

const timedOut = () => {
  const error = new Error("timeout of 10000ms exceeded");
  error.code = "ECONNABORTED";
  return error;
};

// --- a fake socket and message -------------------------------------------

function buildMsg(args, quoted) {
  const text = ["!shortlink", ...args].join(" ").trim();
  if (quoted) {
    return {
      key: { remoteJid: CHAT, fromMe: true, id: "in" },
      message: { extendedTextMessage: { text, contextInfo: { quotedMessage: quoted } } },
    };
  }
  return {
    key: { remoteJid: CHAT, fromMe: true, id: "in" },
    message: { conversation: text },
  };
}

function makeSock() {
  const sent = [];
  return {
    sent,
    async sendMessage(jid, content, options) {
      sent.push({ jid, content, options });
      return { key: { id: `m${sent.length}`, remoteJid: jid, fromMe: true } };
    },
    async sendPresenceUpdate() {},
  };
}

async function run({ args = [], quoted = null, handler } = {}) {
  if (handler) http.get = handler;
  const sock = makeSock();
  await shortlink.execute(sock, buildMsg(args, quoted), args);
  return sock.sent;
}

const creations = (sent) => sent.filter((s) => !s.content?.edit);
const lastText = (sent) => sent[sent.length - 1]?.content?.text || "";

// ---------------------------------------------------------------------------

section("normaliseUrl");
equal("bare domain gets https", normaliseUrl("example.com/x"), "https://example.com/x");
equal("www gets https", normaliseUrl("www.example.com"), "https://www.example.com/");
equal("scheme is kept", normaliseUrl("http://example.com"), "http://example.com/");
equal(
  "trailing punctuation is stripped",
  normaliseUrl("https://example.com/a)."),
  "https://example.com/a",
);
equal(
  "leading punctuation is stripped",
  normaliseUrl("(https://example.com/a"),
  "https://example.com/a",
);
equal("not a link", normaliseUrl("notalink"), null);
equal("a number is not a link", normaliseUrl("1.2.3"), null);
equal("an email is not a link", normaliseUrl("foo@example.com"), null);
equal("empty", normaliseUrl(""), null);
equal(
  "https IDN with an Arabic TLD",
  normaliseUrl("https://موقع.مصر/x"),
  "https://xn--4gbrim.xn--wgbh1c/x",
);
equal(
  "bare Arabic IDN gets https and punycode",
  normaliseUrl("موقع.مصر/x"),
  "https://xn--4gbrim.xn--wgbh1c/x",
);
equal(
  "Latin domain with a punycode TLD",
  normaliseUrl("https://example.xn--p1ai"),
  "https://example.xn--p1ai/",
);

section("extractUrls");
{
  equal(
    "pulls a link out of Arabic text and strips )",
    extractUrls("شوف الرابط ده https://example.com/a) هنا").join(","),
    "https://example.com/a",
  );
  equal("no scheme", extractUrls("example.com/x").join(","), "https://example.com/x");
  equal(
    "several links",
    extractUrls("https://a.com/1 و https://b.com/2").join(","),
    "https://a.com/1,https://b.com/2",
  );
  equal("deduplicates", extractUrls("example.com example.com/").join(","), "https://example.com/");
  equal(
    "the comma is not part of the link",
    extractUrls("see https://a.com/x, thanks").join(","),
    "https://a.com/x",
  );
  equal("an email is not a link", extractUrls("mail me at foo@example.com").join(","), "");
  equal("no link at all", extractUrls("notalink").join(","), "");
  equal("a version number is not a link", extractUrls("1.2.3").join(","), "");
  equal(
    "finds a bare Arabic IDN in Arabic text",
    extractUrls("شوف موقع.مصر/x هنا").join(","),
    "https://xn--4gbrim.xn--wgbh1c/x",
  );
  equal(
    "finds an https IDN and a punycode TLD",
    extractUrls("https://موقع.مصر/x و https://example.xn--p1ai/y").join(","),
    "https://xn--4gbrim.xn--wgbh1c/x,https://example.xn--p1ai/y",
  );

  const many = extractUrls(
    "https://a.com/1 https://b.com/2 https://c.com/3 https://d.com/4 https://e.com/5 https://f.com/6",
  );
  equal("capped at 5", many.length, 5);
  equal("…keeping the first ones", many[4], "https://e.com/5");
}

section("parseResponse");
equal(
  "JSON object success",
  JSON.stringify(parseResponse({ shorturl: "https://is.gd/abc" }, "is.gd")),
  JSON.stringify({ ok: true, url: "https://is.gd/abc" }),
);
equal(
  "JSON string success",
  JSON.stringify(parseResponse('{"shorturl":"https://is.gd/abc"}', "is.gd")),
  JSON.stringify({ ok: true, url: "https://is.gd/abc" }),
);
equal(
  "bare short URL success",
  parseResponse("https://is.gd/abc", "is.gd").url,
  "https://is.gd/abc",
);
equal(
  "a foreign host is refused",
  parseResponse({ shorturl: "https://evil.test/x" }, "is.gd").ok,
  false,
);
equal("http is refused", parseResponse({ shorturl: "http://is.gd/x" }, "is.gd").ok, false);
equal("errorcode 1 -> invalid", parseResponse({ errorcode: 1 }, "is.gd").reason, "invalid");
equal("errorcode 2 -> unknown", parseResponse({ errorcode: 2 }, "is.gd").reason, "unknown");
equal("errorcode 3 -> rate", parseResponse({ errorcode: 3 }, "is.gd").reason, "rate");
equal("errorcode 4 -> unreachable", parseResponse({ errorcode: 4 }, "is.gd").reason, "unreachable");
equal("an HTML body is a failure", parseResponse("<html>oops</html>", "is.gd").ok, false);
equal("empty is a failure", parseResponse(undefined, "is.gd").ok, false);

section("shortenUrl falls back to v.gd");
{
  const calls = [];
  const get = async (url) => {
    calls.push(new URL(url).host);
    return { data: { shorturl: "https://is.gd/ok" } };
  };
  const result = await shortenUrl("https://example.com", get);
  equal("is.gd success", result.url, "https://is.gd/ok");
  equal("no fallback needed", calls.join(","), "is.gd");
}

{
  const calls = [];
  const get = async (url) => {
    const host = new URL(url).host;
    calls.push(host);
    if (host === "is.gd") return { data: { errorcode: 3, errormessage: "rate limited" } };
    return { data: { shorturl: "https://v.gd/ok" } };
  };
  const result = await shortenUrl("https://example.com", get);
  equal("rate-limited is.gd falls back", result.url, "https://v.gd/ok");
  equal("…to v.gd and stops", calls.join(","), "is.gd,v.gd");
}

{
  const get = async (url) => {
    if (new URL(url).host === "is.gd") throw timedOut();
    return { data: { shorturl: "https://v.gd/ok" } };
  };
  const result = await shortenUrl("https://example.com", get);
  equal("a timeout falls back", result.url, "https://v.gd/ok");
}

{
  const calls = [];
  const get = async (url) => {
    calls.push(new URL(url).host);
    return { data: { errorcode: 1, errormessage: "Please enter a valid URL to shorten" } };
  };
  const result = await shortenUrl("https://example.com", get);
  equal("invalid URL is final", result.reason, "invalid");
  equal("…and is not retried on v.gd", calls.join(","), "is.gd");
}

{
  const get = async () => {
    throw new Error("down");
  };
  const result = await shortenUrl("https://example.com", get);
  equal("both unreachable -> failure", result.ok, false);
  equal("…as unreachable", result.reason, "unreachable");
}

section("through execute: exactly one message, edited in place");
{
  const sent = await run({
    args: ["https://example.com/a"],
    handler: async () => ({ data: { shorturl: "https://is.gd/abc" } }),
  });
  ok("one message is created", creations(sent).length === 1);
  ok("the first message is the status line", /Shortening/.test(creations(sent)[0].content.text));
  ok("the last message is an edit", Boolean(sent[sent.length - 1].content.edit));
  ok("the reply carries the short link", lastText(sent).includes("https://is.gd/abc"));
}

{
  const sent = await run({
    args: ["https://example.com/a"],
    handler: async () => ({
      data: { errorcode: 1, errormessage: "Please enter a valid URL to shorten" },
    }),
  });
  ok("one message is created", creations(sent).length === 1);
  ok("the failure edits the same message", Boolean(sent[sent.length - 1].content.edit));
  ok("no second plain message", sent.filter((s) => !s.content.edit).length === 1);
  ok("the reason is human, not the server body", !/Please enter a valid URL/.test(lastText(sent)));
  ok("no raw code block is pasted", !lastText(sent).includes("```"));
  ok("an invalid link is named", /rejected/.test(lastText(sent)));
}

{
  const sent = await run({
    args: ["https://example.com/a"],
    handler: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  ok("both down: one message created", creations(sent).length === 1);
  ok("both down: the failure edits it", Boolean(sent[sent.length - 1].content.edit));
  ok("both down: says unreachable", /unreachable/.test(lastText(sent)));
}

{
  const sent = await run({
    args: ["https://example.com/a"],
    handler: async (url) => {
      if (new URL(url).host === "is.gd") throw timedOut();
      return { data: { shorturl: "https://v.gd/ok" } };
    },
  });
  ok("timeout in execute falls back to v.gd", lastText(sent).includes("https://v.gd/ok"));
  ok("still one created message", creations(sent).length === 1);
}

{
  const sent = await run({
    args: ["https://example.com/a"],
    handler: async () => serverError("<html>Error, database insert failed</html>"),
  });
  ok("a non-URL 200 body is a failure", /unreachable/.test(lastText(sent)));
  ok("the raw body is not pasted", !/database insert failed/.test(lastText(sent)));
}

section("through execute: reply-to-a-message");
{
  const sent = await run({
    quoted: { conversation: "شوف ده https://example.com/reply" },
    handler: async () => ({ data: { shorturl: "https://is.gd/reply" } }),
  });
  ok("a replied link is shortened", lastText(sent).includes("https://is.gd/reply"));
  ok("one message created", creations(sent).length === 1);
}

section("through execute: several links, capped at 5");
{
  let n = 0;
  const sent = await run({
    args: [
      "https://a.com/1",
      "https://b.com/2",
      "https://c.com/3",
      "https://d.com/4",
      "https://e.com/5",
      "https://f.com/6",
    ],
    handler: async () => ({ data: { shorturl: `https://is.gd/s${++n}` } }),
  });
  equal("exactly five links are shortened", n, 5);
  equal("five links are shown", (lastText(sent).match(/🔗/g) || []).length, 5);
  ok("one message created", creations(sent).length === 1);
}

section("through execute: validation, no network");
{
  let called = 0;
  const never = async () => {
    called += 1;
    return { data: {} };
  };
  const sent = await run({ handler: never });
  ok("no args asks for a link", /Send the link/.test(lastText(sent)));
  equal("no request is made", called, 0);
  ok("one message created", creations(sent).length === 1);

  called = 0;
  const invalid = await run({ args: ["notalink"], handler: never });
  ok(
    "an argument that is not a link is refused",
    /couldn't find a valid link/i.test(lastText(invalid)),
  );
  equal("still no request", called, 0);
  ok("…and one message", creations(invalid).length === 1);
}

finish();

// file: /commands/shortlink.cjs
//
// Shortens links with is.gd and falls back to v.gd (the same API on a second
// host) when the first is unreachable or rate-limits.
//
// The link may sit anywhere in the arguments — with or without a scheme, with
// the punctuation people wrap around it — or, when the arguments carry none,
// in the message the command is replying to. Up to MAX_LINKS links are
// shortened and answered in the one status message.

const axios = require("axios");
const logger = require("../utils/logger.cjs");
const { createStatus } = require("../utils/statusMessage.cjs");
const { tr } = require("../utils/i18n.cjs");
const { visibleText, quotedOf } = require("../utils/messageContent.cjs");

// The one HTTP GET the command performs. Exposed so tests can stub the network.
const http = {
  get: (url, options) => axios.get(url, options),
};

const HTTP_TIMEOUT_MS = 10_000;
const MAX_LINKS = 5;

// is.gd first; v.gd is the fallback — they speak the same API.
const SHORTENERS = ["is.gd", "v.gd"];

// WhatsApp users wrap links in punctuation the API rejects (`see here: x.com).`).
const LEADING_PUNCTUATION = /^[([{'"]+/;
const TRAILING_PUNCTUATION = /[)\]}>.,!?;:'"،؛]+$/;

// A URL with a scheme, or a bare/`www.` domain. Labels may be any script
// (\p{L}/\p{N}); the TLD is either two or more letters or a punycode label
// (`xn--…`) — so "notalink", "1.2.3" and emails are still not links. Unicode
// domains are punycoded later by `new URL()`.
const URL_PATTERN =
  /(?<![\p{L}\p{N}@.-])(?:(?:https?:\/\/|www\.)[^\s<>"'`]+|(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+(?:[\p{L}]{2,}|xn--[a-z0-9-]+)(?:\/[^\s<>"'`]*)?)/giu;

// The same domain at the start of a candidate, before we add `https://`.
const BARE_DOMAIN =
  /^(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+(?:[\p{L}]{2,}|xn--[a-z0-9-]+)(?::\d+)?(?:\/|$)/iu;

// is.gd's error codes -> the short bilingual reason we show the user.
const ERROR_REASONS = {
  1: "invalid", // bad or blocked URL
  2: "unknown", // a custom-url problem; we never ask for a custom URL
  3: "rate", // rate limited
  4: "unreachable", // the service itself failed
};

/** Is `url` an https URL on `host` (or a subdomain of it)? */
function onHost(url, host) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    return parsed.hostname === host || parsed.hostname.endsWith(`.${host}`);
  } catch {
    return false;
  }
}

/** Turn one candidate into a clean https URL, or null when it isn't one. */
function normaliseUrl(raw) {
  if (raw === null || raw === undefined) return null;
  const trimmed = String(raw)
    .trim()
    .replace(LEADING_PUNCTUATION, "")
    .replace(TRAILING_PUNCTUATION, "");
  if (!trimmed) return null;

  let candidate = trimmed;
  if (/^www\./i.test(candidate)) {
    candidate = `https://${candidate}`;
  } else if (!/^https?:\/\//i.test(candidate)) {
    // A bare domain must look like name.tld[/path] before we trust it.
    if (!BARE_DOMAIN.test(candidate)) return null;
    candidate = `https://${candidate}`;
  }

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    // `hostname` is punycode here, so the TLD is Latin letters or `xn--…`.
    if (!/^[a-z0-9.-]+\.(?:[a-z]{2,}|xn--[a-z0-9-]+)$/i.test(parsed.hostname)) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

/** Every distinct usable link in `text`, in order, capped at `limit`. */
function extractUrls(text, limit = MAX_LINKS) {
  const found = [];
  const seen = new Set();
  for (const match of String(text || "").match(URL_PATTERN) || []) {
    const url = normaliseUrl(match);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    found.push(url);
    if (found.length >= limit) break;
  }
  return found;
}

/** Read one shortener response into { ok: true, url } or { ok: false, reason }. */
function parseResponse(data, host) {
  let payload = data;

  if (typeof payload === "string") {
    const text = payload.trim();
    try {
      payload = JSON.parse(text);
    } catch {
      // Not JSON: a bare short URL is still usable, anything else is a failure.
      const direct = normaliseUrl(text);
      return direct && onHost(direct, host)
        ? { ok: true, url: direct }
        : { ok: false, reason: "unreachable" };
    }
  }

  if (payload && typeof payload === "object") {
    if (typeof payload.shorturl === "string" && payload.shorturl) {
      const short = normaliseUrl(payload.shorturl);
      return short && onHost(short, host)
        ? { ok: true, url: short }
        : { ok: false, reason: "unreachable" };
    }
    if (typeof payload.errorcode === "number") {
      return { ok: false, reason: ERROR_REASONS[payload.errorcode] || "unknown" };
    }
  }

  return { ok: false, reason: "unreachable" };
}

function apiUrl(host, longUrl) {
  return `https://${host}/create.php?format=json&url=${encodeURIComponent(longUrl)}`;
}

/**
 * Shorten one link, trying each shortener in turn. A rejection (invalid or
 * blocked URL) is final; an unreachable or rate-limited host falls through to
 * the next one.
 */
async function shortenUrl(longUrl, get = http.get) {
  let reason = "unreachable";

  for (const host of SHORTENERS) {
    try {
      const response = await get(apiUrl(host, longUrl), {
        timeout: HTTP_TIMEOUT_MS,
        headers: { Accept: "application/json" },
      });
      const parsed = parseResponse(response?.data, host);
      if (parsed.ok) return parsed;
      reason = parsed.reason;
      if (parsed.reason === "invalid") return parsed;
    } catch (error) {
      const status = error?.response?.status;
      if (status === 429) {
        reason = "rate";
      } else if (error?.response?.data) {
        const parsed = parseResponse(error.response.data, host);
        reason = parsed.ok ? "unreachable" : parsed.reason;
      } else {
        reason = "unreachable";
      }
    }
  }

  return { ok: false, reason };
}

/** One short bilingual line explaining why a link could not be shortened. */
function failureText(reason) {
  switch (reason) {
    case "invalid":
      return tr(
        "the service rejected the link (invalid or blocked)",
        "الخدمة رفضت الرابط (غير صالح أو محظور)",
      );
    case "rate":
      return tr(
        "the service is rate-limiting, try again later",
        "الخدمة تحدّ من الطلبات، جرّب لاحقًا",
      );
    case "unreachable":
      return tr("the service is unreachable right now", "تعذّر الوصول إلى الخدمة حاليًا");
    default:
      return tr("an unknown error happened", "حدث خطأ غير معروف");
  }
}

/** Turn every result into the single reply that lands in the status message. */
function renderResults(results) {
  const ok = results.filter((result) => result.ok);

  if (!ok.length) {
    const reason = results[results.length - 1].reason;
    if (results.length === 1) {
      return tr(
        `❌ *Couldn't shorten the link*\n\n${failureText(reason)}`,
        `❌ *تعذّر اختصار الرابط*\n\n${failureText(reason)}`,
      );
    }
    const failed = results.map((r) => `• ${r.url} — ${failureText(r.reason)}`).join("\n");
    return tr(
      `❌ *Couldn't shorten any of the links*\n\n${failed}`,
      `❌ *تعذّر اختصار أي من الروابط*\n\n${failed}`,
    );
  }

  const heading =
    results.length === 1
      ? tr("✅ Link shortened!", "✅ تم اختصار الرابط!")
      : tr(`✅ Links shortened (${ok.length})!`, `✅ تم اختصار الروابط (${ok.length})!`);

  const body = results
    .map((r) => (r.ok ? `🔗 ${r.url}` : `❌ ${r.url} — ${failureText(r.reason)}`))
    .join("\n");

  return `${heading}\n\n${body}`;
}

async function shortenMany(urls) {
  const results = [];
  for (const url of urls) {
    results.push({ url, ...(await shortenUrl(url)) });
  }
  return results;
}

function sendUsage(sock, chatId) {
  return sock.sendMessage(chatId, {
    text: tr(
      "Send the link you want to shorten, or reply to a message containing one.\n\n*Example:*\n`!shortlink https://github.com/WhiskeySockets/Baileys`",
      "أرسل الرابط الذي تريد اختصاره، أو اعمل رد على رسالة تحتوي رابطًا.\n\n*مثال:*\n`!shortlink https://github.com/WhiskeySockets/Baileys`",
    ),
  });
}

function sendInvalid(sock, chatId) {
  return sock.sendMessage(chatId, {
    text: tr(
      "I couldn't find a valid link. Send a URL like `https://example.com`, or reply to a message with one.",
      "لم أجد رابطًا صالحًا. أرسل رابطًا مثل `https://example.com`، أو اعمل رد على رسالة تحتوي عليه.",
    ),
  });
}

module.exports = {
  name: "shortlink",
  description: {
    en: "Shortens up to 5 links with is.gd, falling back to v.gd. Reads a URL from the command or a replied message.",
    ar: "يختصر حتى 5 روابط باستخدام is.gd مع التحويل إلى v.gd عند الحاجة، من الأمر أو من رسالة موجّه لها الرد.",
  },
  usage: {
    en: "shortlink <url> | reply to a message containing a link",
    ar: "shortlink <الرابط> | اعمل رد على رسالة تحتوي رابطًا",
  },
  chat: "all",
  neutralArgs: true, // a URL is not a language

  async execute(sock, msg, args) {
    const chatId = msg.key.remoteJid;
    const argText = (args || []).join(" ").trim();
    const quoted = quotedOf(msg);
    const quotedText = quoted ? visibleText(quoted) : "";

    let urls = extractUrls(argText);
    if (!urls.length && quotedText) urls = extractUrls(quotedText);

    if (!urls.length) {
      if (!argText && !quotedText) return sendUsage(sock, chatId);
      return sendInvalid(sock, chatId);
    }

    // One message: "shortening..." becomes the short link(s) or the reason.
    const status = await createStatus(sock, chatId, tr("🔗 Shortening...", "🔗 بختصر الرابط..."), {
      replyTo: msg,
    });

    try {
      const results = await shortenMany(urls);
      await status.finish(renderResults(results));
    } catch (error) {
      logger.error({ err: error, command: "shortlink" }, "[Error] in !shortlink command");
      await status.fail(error, tr("Couldn't shorten the link", "تعذّر اختصار الرابط"));
    }
  },

  // Pure helpers and the HTTP seam, kept for tests.
  http,
  extractUrls,
  normaliseUrl,
  parseResponse,
  shortenUrl,
};

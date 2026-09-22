// The tools the AI agent can actually call.
//
// Each entry is { declaration, run(args, ctx), describe(args) }:
//   declaration - what Gemini sees (name + JSON schema)
//   run         - what happens when the model calls it; ALWAYS resolves to a
//                 plain object (errors included) so one bad tool call doesn't
//                 kill the turn
//   describe    - the Arabic line shown in the live status message while the
//                 tool runs ("🔍 ببحث عن: ...")
//
// Anything privileged (roles) is gated on the *caller*, not on the model: the
// agent can ask, but the tool refuses when the person who sent the message
// isn't allowed to do it.

const dns = require("node:dns").promises;
const https = require("node:https");
const net = require("node:net");

const axios = require("axios");

const logger = require("../utils/logger.cjs");
const memory = require("../utils/memory.cjs");
const { decodeBuffer, stripHtml, decodeText } = require("../utils/textDecode.cjs");
const { grantRole, revokeRole, listRoles } = require("../utils/permissions.cjs");
const { isForbiddenIp } = require("../utils/providerUrl.cjs");

// @google/genai exports a `Type` enum (the old SDK called it `SchemaType`).
// Its members are the uppercase wire values — Type.STRING === "STRING" — so the
// fallback below is the same thing spelled out, and a future rename can't take
// the whole agent down with it.
let Type = null;
try {
  ({ Type } = require("@google/genai"));
} catch {
  Type = null;
}
const T = Type || {
  STRING: "STRING",
  NUMBER: "NUMBER",
  INTEGER: "INTEGER",
  BOOLEAN: "BOOLEAN",
  ARRAY: "ARRAY",
  OBJECT: "OBJECT",
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const settings = require("../config/settings.cjs");

const MAX_PAGE_CHARS = 6000;
const MAX_FETCH_BYTES = 3 * 1024 * 1024;

// ---------------------------------------------------------------------------
// web search
// ---------------------------------------------------------------------------

function unwrapDuckUrl(href) {
  if (!href) return null;
  let url = href.startsWith("//") ? `https:${href}` : href;
  const redirect = /[?&]uddg=([^&]+)/.exec(url);
  if (redirect) {
    try {
      url = decodeURIComponent(redirect[1]);
    } catch {
      // keep the wrapper url
    }
  }
  return url.startsWith("http") ? url : null;
}

async function searchDuckDuckGo(query, limit) {
  const response = await axios.get("https://html.duckduckgo.com/html/", {
    params: { q: query },
    responseType: "arraybuffer",
    timeout: 20000,
    headers: {
      "User-Agent": UA,
      "Accept-Language": "ar,en-US;q=0.9,en;q=0.8",
    },
    validateStatus: (status) => status >= 200 && status < 500,
  });

  const html = decodeBuffer(Buffer.from(response.data), response.headers["content-type"]);

  const results = [];
  const linkRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

  const snippets = [];
  let snippetMatch;
  while ((snippetMatch = snippetRe.exec(html)) !== null) {
    snippets.push(stripHtml(snippetMatch[1]));
  }

  let match;
  while ((match = linkRe.exec(html)) !== null && results.length < limit) {
    const url = unwrapDuckUrl(match[1]);
    if (!url) continue;
    results.push({
      title: stripHtml(match[2]),
      url,
      snippet: snippets[results.length] || "",
    });
  }
  return results;
}

async function searchGoogleCse(query, limit) {
  const response = await axios.get("https://www.googleapis.com/customsearch/v1", {
    params: {
      key: settings.get("google_search_api_key"),
      cx: settings.get("google_search_cx"),
      q: query,
      num: Math.min(10, limit),
    },
    timeout: 20000,
  });
  return (response.data?.items || []).slice(0, limit).map((item) => ({
    title: item.title,
    url: item.link,
    snippet: item.snippet || "",
  }));
}

async function webSearch(query, limit = 5) {
  // Google Programmable Search when the operator configured it, DuckDuckGo
  // otherwise — no key needed, which keeps the feature working out of the box.
  if (settings.get("google_search_api_key") && settings.get("google_search_cx")) {
    try {
      const results = await searchGoogleCse(query, limit);
      if (results.length) return results;
    } catch (err) {
      logger.warn({ err: err.message }, "[aiTools] Google CSE failed");
    }
  }
  return searchDuckDuckGo(query, limit);
}

async function searchNews(query, limit = 5) {
  const newsQuery = `${query} news أخبار`;
  return webSearch(newsQuery, limit);
}

async function enrichWikiResults(lang, titles, urls, limit) {
  const count = Math.min(titles?.length || 0, limit);
  const items = [];
  for (let i = 0; i < count; i++) {
    items.push({ title: titles[i], url: urls[i] });
  }

  const results = await Promise.all(
    items.map(async ({ title, url }) => {
      let extract = "";
      try {
        const summaryRes = await axios.get(
          `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
          {
            timeout: 8000,
            headers: { "User-Agent": "LevixBot/3.4 (https://github.com/Abdodiab2005/levix)" },
          },
        );
        extract = summaryRes.data?.extract || summaryRes.data?.description || "";
      } catch {
        // Non-fatal: summary lookup failure retains title and URL.
      }
      return { title, url, extract: extract.slice(0, 1000) };
    }),
  );

  return { language: lang, count: results.length, results };
}

async function searchWikipedia(query, language = "auto", limit = 3) {
  let lang = language;
  if (!lang || lang === "auto") {
    lang = /[\u0600-\u06FF]/.test(query) ? "ar" : "en";
  }
  const cleanLang = lang.toLowerCase() === "ar" ? "ar" : "en";
  try {
    const searchRes = await axios.get(`https://${cleanLang}.wikipedia.org/w/api.php`, {
      params: {
        action: "opensearch",
        search: query,
        limit: Math.min(5, Math.max(1, limit)),
        namespace: 0,
        format: "json",
      },
      timeout: 10000,
      headers: { "User-Agent": "LevixBot/3.4 (https://github.com/Abdodiab2005/levix)" },
    });
    const [, titles, , urls] = searchRes.data || [];
    if (!titles || !titles.length) {
      const altLang = cleanLang === "ar" ? "en" : "ar";
      const altRes = await axios.get(`https://${altLang}.wikipedia.org/w/api.php`, {
        params: {
          action: "opensearch",
          search: query,
          limit: Math.min(5, Math.max(1, limit)),
          namespace: 0,
          format: "json",
        },
        timeout: 10000,
        headers: { "User-Agent": "LevixBot/3.4 (https://github.com/Abdodiab2005/levix)" },
      });
      const [, altTitles, , altUrls] = altRes.data || [];
      if (!altTitles || !altTitles.length) {
        return { query, count: 0, results: [], note: "no Wikipedia articles found" };
      }
      return await enrichWikiResults(altLang, altTitles, altUrls, limit);
    }
    return await enrichWikiResults(cleanLang, titles, urls, limit);
  } catch (err) {
    logger.warn({ err: err.message }, "[aiTools] Wikipedia search failed");
    return { error: `Wikipedia search failed: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// url fetching
// ---------------------------------------------------------------------------

// The model picks these URLs, so keep it off the machine's own network.
//
// الفحص بالاسم لوحده مش كفاية: دومين عادي ممكن يـ resolve على 127.0.0.1،
// و 2130706433 و [::ffff:127.0.0.1] نفس العنوان بصيغة تانية، والأهم إن رابط
// عام ممكن يعمل redirect على 169.254.169.254 (مفاتيح السيرفر عند أغلب
// مزودي الاستضافة). فبنـ resolve العنوان ونفحص كل خطوة تحويل لوحدها.
// Resolve once, reject every local/reserved answer, then pin the HTTP socket to
// one of those exact answers. That closes the gap where a rebinding hostname
// could return a public address during validation and loopback during connect.
async function assertPublicUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("الرابط مش صالح");
  }
  if (url.protocol !== "https:") throw new Error("مسموح بروابط HTTPS بس");

  const host = url.hostname.replace(/^\[|\]$/g, "");

  if (net.isIP(host)) {
    if (isForbiddenIp(host)) throw new Error("الرابط ده ممنوع");
    return { url, host, addresses: [{ address: host, family: net.isIP(host) }] };
  }

  let addresses;
  try {
    addresses = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error("مش قادر أوصل للدومين ده");
  }
  if (!addresses.length || addresses.some((a) => isForbiddenIp(a.address))) {
    throw new Error("الرابط ده ممنوع");
  }

  return { url, host, addresses };
}

function pinnedAgent(expectedHost, addresses) {
  const lookup = (hostname, options, callback) => {
    if (String(hostname).toLowerCase() !== expectedHost.toLowerCase()) {
      const error = new Error("اتصال بدومين غير متوقع");
      error.code = "EAI_FAIL";
      return callback(error);
    }

    const requestedFamily = typeof options === "number" ? options : options?.family;
    const candidates = requestedFamily
      ? addresses.filter(({ family }) => family === requestedFamily)
      : addresses;
    if (!candidates.length) {
      const error = new Error("مفيش عنوان متوافق للدومين ده");
      error.code = "EAI_ADDRFAMILY";
      return callback(error);
    }
    if (typeof options === "object" && options?.all) {
      return callback(null, candidates.map(({ address, family }) => ({ address, family })));
    }
    return callback(null, candidates[0].address, candidates[0].family);
  };

  return new https.Agent({ keepAlive: false, lookup });
}

const MAX_REDIRECTS = 4;

async function fetchUrl(rawUrl) {
  let target = await assertPublicUrl(rawUrl);
  let response;

  for (let hop = 0; ; hop++) {
    const { url, host, addresses } = target;
    const agent = pinnedAgent(host, addresses);
    try {
      response = await axios.get(url.toString(), {
        responseType: "arraybuffer",
        timeout: 20000,
        // بنمشي ورا التحويلات بنفسنا عشان نفحص كل خطوة — axios بيفحص الأول بس.
        maxRedirects: 0,
        maxContentLength: MAX_FETCH_BYTES,
        // Ignore process-wide proxy variables: they would perform their own
        // hostname resolution and bypass the pinned lookup above.
        proxy: false,
        httpsAgent: agent,
        headers: {
          "User-Agent": UA,
          "Accept-Language": "ar,en;q=0.9",
          Accept: "text/html,application/json,text/plain,*/*",
        },
        validateStatus: (status) => status >= 200 && status < 500,
      });
    } finally {
      agent.destroy();
    }

    const location = response.headers?.location;
    const isRedirect = response.status >= 300 && response.status < 400 && location;
    if (!isRedirect) break;
    if (hop >= MAX_REDIRECTS) throw new Error("الرابط بيحوّل كتير أوي");

    target = await assertPublicUrl(new URL(location, url).toString());
  }

  const contentType = String(response.headers["content-type"] || "");
  const body = decodeBuffer(Buffer.from(response.data), contentType);

  const text = /json|text\/plain|xml/i.test(contentType) ? body : stripHtml(body);

  return {
    url: target.url.toString(),
    status: response.status,
    contentType,
    truncated: text.length > MAX_PAGE_CHARS,
    content: text.slice(0, MAX_PAGE_CHARS),
  };
}

// ---------------------------------------------------------------------------
// tool table
// ---------------------------------------------------------------------------

function scopeOf(args) {
  return memory.normalizeScope(args?.scope);
}

// نفس قاعدة أمر !memory بالظبط: الكتابة في الذاكرة العامة والمسح محتاجين
// أدمن/مالك. الفحص لازم يكون هنا مش في البرومبت — الموديل بيقرا صفحات ويب
// ورسايل ناس، وأي واحدة فيهم ممكن تقوله "احفظ ده في الذاكرة العامة".
function isBotPrivileged(ctx) {
  return Boolean(ctx?.isOwner || ctx?.isAdmin);
}

function isChatMemoryAdmin(ctx) {
  return isBotPrivileged(ctx) || Boolean(ctx?.isGroupAdmin);
}

function roleTargetBound(target, ctx) {
  const raw = String(target || "").trim();
  if (!raw) return false;
  const ids = [...(ctx?.mentionedJids || []), ctx?.quotedParticipant].filter(Boolean);
  const { sameUserSync } = require("../utils/permissions.cjs");
  if (ids.some((id) => sameUserSync(id, raw))) return true;
  const digits = raw.replace(/\D/g, "");
  if (digits.length >= 8 && String(ctx?.userText || "").replace(/\D/g, "").includes(digits)) {
    return true;
  }
  return false;
}

const NOT_PRIVILEGED = {
  error: "only the bot owner or an admin can do this",
};

function preview(value, length = 40) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > length ? `${text.slice(0, length)}...` : text;
}

const TOOLS = {
  web_search: {
    declaration: {
      name: "web_search",
      description:
        "Search the web for current information (news, prices, scores, facts you are unsure about). Returns titles, urls and snippets.",
      parameters: {
        type: T.OBJECT,
        properties: {
          query: { type: T.STRING, description: "The search query." },
          limit: {
            type: T.INTEGER,
            description: "How many results to return (1-8, default 5).",
          },
        },
        required: ["query"],
      },
    },
    describe: (args) => `🔍 جاري البحث عن: ${preview(args?.query, 50)}`,
    describeEn: (args) => `🔍 Searching for: ${preview(args?.query, 50)}`,
    async run(args) {
      const query = String(args?.query || "").trim();
      if (!query) return { error: "query is required" };
      const limit = Math.min(8, Math.max(1, Number(args?.limit) || 5));
      const results = await webSearch(query, limit);
      return {
        query,
        count: results.length,
        results,
        note: results.length ? undefined : "no results found",
      };
    },
  },

  search_wikipedia: {
    declaration: {
      name: "search_wikipedia",
      description:
        "Search Wikipedia for encyclopedic facts, history, science, biographies, definitions, and academic context in Arabic or English.",
      parameters: {
        type: T.OBJECT,
        properties: {
          query: {
            type: T.STRING,
            description: "The topic, entity, or term to look up.",
          },
          language: {
            type: T.STRING,
            description:
              "'ar' for Arabic Wikipedia, 'en' for English Wikipedia, or 'auto' (detect from query).",
          },
          limit: {
            type: T.INTEGER,
            description: "How many articles to return (1-5, default 3).",
          },
        },
        required: ["query"],
      },
    },
    describe: (args) => `📚 جاري البحث في ويكيبيديا: ${preview(args?.query, 45)}`,
    describeEn: (args) => `📚 Searching Wikipedia: ${preview(args?.query, 45)}`,
    async run(args) {
      const query = String(args?.query || "").trim();
      if (!query) return { error: "query is required" };
      const limit = Math.min(5, Math.max(1, Number(args?.limit) || 3));
      return searchWikipedia(query, args?.language, limit);
    },
  },

  search_news: {
    declaration: {
      name: "search_news",
      description:
        "Search recent news headlines, breaking events, press coverage, and current affairs.",
      parameters: {
        type: T.OBJECT,
        properties: {
          query: {
            type: T.STRING,
            description: "The news topic, person, or event to search for.",
          },
          limit: {
            type: T.INTEGER,
            description: "How many news results to return (1-8, default 5).",
          },
        },
        required: ["query"],
      },
    },
    describe: (args) => `📰 جاري البحث عن الأخبار: ${preview(args?.query, 45)}`,
    describeEn: (args) => `📰 Searching news: ${preview(args?.query, 45)}`,
    async run(args) {
      const query = String(args?.query || "").trim();
      if (!query) return { error: "query is required" };
      const limit = Math.min(8, Math.max(1, Number(args?.limit) || 5));
      const results = await searchNews(query, limit);
      return {
        query,
        count: results.length,
        results,
        note: results.length ? undefined : "no recent news found",
      };
    },
  },

  fetch_url: {
    declaration: {
      name: "fetch_url",
      description:
        "Open an HTTPS URL and read its text content (article, API response, page the user sent). Use after web_search when a snippet is not enough.",
      parameters: {
        type: T.OBJECT,
        properties: {
          url: { type: T.STRING, description: "Full HTTPS URL." },
        },
        required: ["url"],
      },
    },
    describe: (args) => `🌐 جاري فتح الرابط: ${preview(args?.url, 45)}`,
    describeEn: (args) => `🌐 Opening link: ${preview(args?.url, 45)}`,
    async run(args) {
      const url = String(args?.url || "").trim();
      if (!url) return { error: "url is required" };
      return fetchUrl(url);
    },
  },

  save_memory: {
    declaration: {
      name: "save_memory",
      description:
        "Save a fact to long-term memory so it survives across conversations. Use it whenever the user says things like 'save this', 'remember that', 'احفظ ده في ذاكرتك'. scope 'chat' keeps it to this conversation, scope 'global' shares it with every chat.",
      parameters: {
        type: T.OBJECT,
        properties: {
          content: {
            type: T.STRING,
            description: "The fact to remember, written as a short standalone sentence.",
          },
          scope: {
            type: T.STRING,
            description: "'chat' (default) or 'global'.",
          },
        },
        required: ["content"],
      },
    },
    describe: (args) =>
      `🧠 جاري الحفظ في ${scopeOf(args) === "global" ? "الذاكرة العامة" : "ذاكرة المحادثة"}: ${preview(
        args?.content,
      )}`,
    describeEn: (args) =>
      `🧠 Saving to ${scopeOf(args) === "global" ? "global" : "chat"} memory: ${preview(
        args?.content,
      )}`,
    async run(args, ctx) {
      const scope = scopeOf(args);
      // الذاكرة العامة بتتحقن في البرومبت بتاع كل الشاتات، فمش أي حد يكتب فيها.
      if (scope === "global" && !isBotPrivileged(ctx)) {
        return { ...NOT_PRIVILEGED, saved: false };
      }
      const entry = memory.addMemory({
        scope,
        chatId: ctx.chatId,
        content: args?.content,
        by: ctx.senderName || ctx.senderId,
        chatName: ctx.chatName,
      });
      return {
        saved: true,
        id: entry.id,
        scope,
        file: scope === "global" ? "global.md" : `chats/${ctx.chatId}.md`,
      };
    },
  },

  search_memory: {
    declaration: {
      name: "search_memory",
      description:
        "Look up what is already saved in long-term memory. Everything is also injected into your system prompt, so use this only to double-check or to get entry ids before forgetting something.",
      parameters: {
        type: T.OBJECT,
        properties: {
          query: {
            type: T.STRING,
            description: "Optional text filter; omit to list everything.",
          },
          scope: {
            type: T.STRING,
            description: "'chat' (default), 'global', or 'all'.",
          },
        },
      },
    },
    describe: () => "🧠 جاري البحث في الذاكرة...",
    describeEn: () => "🧠 Searching memory...",
    async run(args, ctx) {
      const wanted = String(args?.scope || "chat").toLowerCase();
      const scopes = wanted === "all" ? ["chat", "global"] : [scopeOf(args)];
      const out = {};
      for (const scope of scopes) {
        out[scope] = memory
          .searchMemory(args?.query, { scope, chatId: ctx.chatId })
          .map((entry) => ({ id: entry.id, content: entry.content, at: entry.at }));
      }
      return out;
    },
  },

  forget_memory: {
    declaration: {
      name: "forget_memory",
      description:
        "Delete one saved memory entry, addressed by its id, its position (1-based), or a text fragment.",
      parameters: {
        type: T.OBJECT,
        properties: {
          ref: {
            type: T.STRING,
            description: "Entry id, index, or a fragment of its text.",
          },
          scope: { type: T.STRING, description: "'chat' (default) or 'global'." },
        },
        required: ["ref"],
      },
    },
    describe: (args) => `🗑️ جاري الحذف من الذاكرة: ${preview(args?.ref)}`,
    describeEn: (args) => `🗑️ Removing from memory: ${preview(args?.ref)}`,
    async run(args, ctx) {
      const scope = scopeOf(args);
      const allowed = scope === "global" ? isBotPrivileged(ctx) : isChatMemoryAdmin(ctx);
      if (!allowed) return { ...NOT_PRIVILEGED, removed: false };
      const removed = memory.removeMemory({
        scope,
        chatId: ctx.chatId,
        ref: args?.ref,
      });
      return removed
        ? { removed: true, content: removed.content, scope }
        : { removed: false, reason: "no matching entry" };
    },
  },

  grant_role: {
    declaration: {
      name: "grant_role",
      description:
        "Give someone bot privileges. role 'admin' makes them an admin in every chat; role 'owner' gives full access. Only an owner may call this — say so politely if it is refused.",
      parameters: {
        type: T.OBJECT,
        properties: {
          target: {
            type: T.STRING,
            description:
              "Phone number or JID of the person. Use the mentioned/quoted user's id when the request points at someone in the chat.",
          },
          role: { type: T.STRING, description: "'admin' or 'owner'." },
        },
        required: ["target"],
      },
    },
    describe: (args) =>
      `🔑 جاري فحص صلاحيات: ${preview(args?.target, 25)} (${args?.role || "admin"})`,
    describeEn: (args) =>
      `🔑 Checking permissions: ${preview(args?.target, 25)} (${args?.role || "admin"})`,
    async run(args, ctx) {
      if (!ctx.isOwner) {
        return { error: "only the bot owner can grant roles", granted: false };
      }
      if (!roleTargetBound(args?.target, ctx)) {
        return {
          error: "mention, quote, or type the target phone number in your own request",
          granted: false,
        };
      }
      const role = String(args?.role || "admin").toLowerCase() === "owner" ? "owner" : "admin";
      const record = await grantRole(args?.target, role);
      logger.info(
        { target: args?.target, role, by: ctx.senderId },
        "[aiTools] role granted by the agent",
      );
      return {
        granted: true,
        role,
        user: record ? record.jid : args?.target,
      };
    },
  },

  revoke_role: {
    declaration: {
      name: "revoke_role",
      description: "Take back bot privileges from someone. Owner only.",
      parameters: {
        type: T.OBJECT,
        properties: {
          target: { type: T.STRING, description: "Phone number or JID." },
          role: { type: T.STRING, description: "'admin' or 'owner'." },
        },
        required: ["target"],
      },
    },
    describe: (args) => `🔑 جاري سحب الصلاحية من: ${preview(args?.target, 25)}`,
    describeEn: (args) => `🔑 Revoking permissions from: ${preview(args?.target, 25)}`,
    async run(args, ctx) {
      if (!ctx.isOwner) {
        return { error: "only the bot owner can revoke roles", revoked: false };
      }
      if (!roleTargetBound(args?.target, ctx)) {
        return {
          error: "mention, quote, or type the target phone number in your own request",
          revoked: false,
        };
      }
      const role = String(args?.role || "admin").toLowerCase() === "owner" ? "owner" : "admin";
      const record = await revokeRole(args?.target, role);
      return { revoked: true, role, user: record ? record.jid : args?.target };
    },
  },

  list_roles: {
    declaration: {
      name: "list_roles",
      description: "List who currently holds bot owner / admin roles. Owners and admins only.",
      parameters: { type: T.OBJECT, properties: {} },
    },
    describe: () => "🔑 جاري جلب قائمة الصلاحيات...",
    describeEn: () => "🔑 Fetching roles list...",
    async run(_args, ctx) {
      if (!ctx.isOwner && !ctx.isAdmin) {
        return { error: "only owners and admins can list roles" };
      }
      const { owners, admins } = await listRoles();
      const shape = (user) => ({
        id: user.jid,
        phone: user.phone,
        name: user.displayName,
      });
      return { owners: owners.map(shape), admins: admins.map(shape) };
    },
  },

  get_datetime: {
    declaration: {
      name: "get_datetime",
      description:
        "Current date and time. Use it instead of guessing whenever the answer depends on 'now'.",
      parameters: {
        type: T.OBJECT,
        properties: {
          timezone: {
            type: T.STRING,
            description: `IANA timezone, default ${settings.get("bot_timezone")}.`,
          },
        },
      },
    },
    describe: () => "🕒 جاري التحقق من الوقت الحالي...",
    describeEn: () => "🕒 Checking current time...",
    async run(args) {
      const timeZone = args?.timezone || settings.get("bot_timezone");
      const now = new Date();
      let local;
      try {
        local = new Intl.DateTimeFormat("ar-EG", {
          timeZone,
          dateStyle: "full",
          timeStyle: "short",
        }).format(now);
      } catch {
        local = now.toString();
      }
      return { iso: now.toISOString(), timezone: timeZone, local };
    },
  },
};

/** Everything Gemini needs to know about the tools, in one `tools` entry. */
function toolDeclarations() {
  return [
    {
      functionDeclarations: Object.values(TOOLS).map((tool) => tool.declaration),
    },
  ];
}

/** The status line for a tool call (falls back to the raw name). */
function describeCall(name, args, lang = settings.get("bot_language")) {
  const tool = TOOLS[name];
  const isEn = lang === "en";
  const fallback = isEn ? `⚙️ Running: ${name}` : `⚙️ جاري تشغيل: ${name}`;
  if (!tool) return fallback;
  try {
    if (isEn && typeof tool.describeEn === "function") {
      return tool.describeEn(args) || fallback;
    }
    return tool.describe(args) || fallback;
  } catch {
    return fallback;
  }
}

/**
 * Run one tool call. Never throws — a failure comes back as `{ error }` so the
 * model can apologise or try something else instead of the turn dying.
 */
async function runTool(name, args, ctx) {
  const tool = TOOLS[name];
  if (!tool) return { error: `unknown tool: ${name}` };

  try {
    const result = await tool.run(args || {}, ctx || {});
    return result && typeof result === "object" ? result : { result };
  } catch (err) {
    logger.warn({ err: err?.message, tool: name }, "[aiTools] tool call failed");
    return { error: `${err?.name || "Error"}: ${err?.message || err}` };
  }
}

module.exports = {
  TOOLS,
  toolDeclarations,
  describeCall,
  runTool,
  webSearch,
  searchNews,
  searchWikipedia,
  fetchUrl,
  decodeText,
};

// The tools the AI agent can actually call.
//
// Each entry is { declaration, access?, run(args, ctx), describe(args) }:
//   declaration - what Gemini sees (name + JSON schema)
//   access      - who may call it (see aiToolAuth.cjs): the command it stands
//                 in for, plus any role that command checks internally. A
//                 function of the arguments when the action they pick changes
//                 the rule (global vs chat memory). Absent = open to anyone
//                 who may use the AI at all.
//   run         - what happens when the model calls it; ALWAYS resolves to a
//                 plain object (errors included) so one bad tool call doesn't
//                 kill the turn
//   describe    - the Arabic line shown in the live status message while the
//                 tool runs ("🔍 ببحث عن: ...")
//
// Anything privileged is gated on the *caller* — the person whose message
// started the run, resolved by aiToolAuth.resolveCaller() — and never on the
// model. runTool() checks `access` before run() is reached, and tools take
// every identity they act on (chat, sender, targets) from ctx.caller, never
// from their arguments.

const dns = require("node:dns").promises;
const https = require("node:https");
const net = require("node:net");

const axios = require("axios");

const logger = require("../utils/logger.cjs");
const memory = require("../utils/memory.cjs");
const { decodeBuffer, stripHtml, decodeText } = require("../utils/textDecode.cjs");
const { grantRole, revokeRole, listRoles } = require("../utils/permissions.cjs");
const { authorize } = require("./aiToolAuth.cjs");
const { isForbiddenIp } = require("../utils/providerUrl.cjs");
const { sendBotMessage } = require("../utils/sendBotMessage.cjs");

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
const { currentLang } = require("../utils/i18n.cjs");

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
    throw new Error("الرابط غير صالح");
  }
  if (url.protocol !== "https:") throw new Error("يُسمح بروابط HTTPS فقط");

  const host = url.hostname.replace(/^\[|\]$/g, "");

  if (net.isIP(host)) {
    if (isForbiddenIp(host)) throw new Error("هذا الرابط محظور");
    return { url, host, addresses: [{ address: host, family: net.isIP(host) }] };
  }

  let addresses;
  try {
    addresses = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error("تعذّر الوصول إلى هذا النطاق");
  }
  if (!addresses.length || addresses.some((a) => isForbiddenIp(a.address))) {
    throw new Error("هذا الرابط محظور");
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
      const error = new Error("لا يوجد عنوان متوافق لهذا النطاق");
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
    if (hop >= MAX_REDIRECTS) throw new Error("تجاوز الرابط الحد المسموح لعمليات إعادة التوجيه");

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

// A role change may only target someone the sender themselves named: a
// mention, the author of the message they replied to, or a number they typed.
// A target the model came up with — from a web page, say — is refused.
function roleTargetBound(target, caller) {
  const raw = String(target || "").trim();
  if (!raw) return false;
  const ids = [...(caller?.mentionedJids || []), caller?.quotedParticipant].filter(Boolean);
  const { sameUserSync } = require("../utils/permissions.cjs");
  if (ids.some((id) => sameUserSync(id, raw))) return true;
  const digits = raw.replace(/\D/g, "");
  if (
    digits.length >= 8 &&
    String(caller?.text || "")
      .replace(/\D/g, "")
      .includes(digits)
  ) {
    return true;
  }
  return false;
}

function roleOf(args) {
  return String(args?.role || "admin").toLowerCase() === "owner" ? "owner" : "admin";
}

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
    describe: (args) => `🔍 جارٍ البحث عن: ${preview(args?.query, 50)}`,
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
    describe: (args) => `📚 جارٍ البحث في ويكيبيديا: ${preview(args?.query, 45)}`,
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
    describe: (args) => `📰 جارٍ البحث عن الأخبار: ${preview(args?.query, 45)}`,
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
    describe: (args) => `🌐 جارٍ فتح الرابط: ${preview(args?.url, 45)}`,
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
        "Save a fact to long-term memory so it survives across conversations. Use it whenever the user says things like 'save this', 'remember that', 'احفظ هذا في ذاكرتك'. scope 'chat' keeps it to this conversation, scope 'global' shares it with every chat.",
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
      `🧠 جارٍ الحفظ في ${scopeOf(args) === "global" ? "الذاكرة العامة" : "ذاكرة المحادثة"}: ${preview(
        args?.content,
      )}`,
    describeEn: (args) =>
      `🧠 Saving to ${scopeOf(args) === "global" ? "global" : "chat"} memory: ${preview(
        args?.content,
      )}`,
    // Same rule as `!memory add`: anyone may add to this chat, but global
    // memory reaches every chat's prompt, so only the owner or a bot admin.
    access: (args) => ({
      command: "memory",
      role: scopeOf(args) === "global" ? "botPrivileged" : undefined,
    }),
    async run(args, { caller }) {
      const scope = scopeOf(args);
      const entry = memory.addMemory({
        scope,
        chatId: caller.chatId,
        content: args?.content,
        by: caller.senderName || caller.senderId,
        chatName: caller.chatName,
      });
      return {
        saved: true,
        id: entry.id,
        scope,
        file: scope === "global" ? "global.md" : `chats/${caller.chatId}.md`,
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
    describe: () => "🧠 جارٍ البحث في الذاكرة...",
    describeEn: () => "🧠 Searching memory...",
    // `!memory search` reads both scopes for anyone who may run `!memory`.
    access: { command: "memory" },
    async run(args, { caller }) {
      const wanted = String(args?.scope || "chat").toLowerCase();
      const scopes = wanted === "all" ? ["chat", "global"] : [scopeOf(args)];
      const out = {};
      for (const scope of scopes) {
        out[scope] = memory
          .searchMemory(args?.query, { scope, chatId: caller.chatId })
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
    describe: (args) => `🗑️ جارٍ الحذف من الذاكرة: ${preview(args?.ref)}`,
    describeEn: (args) => `🗑️ Removing from memory: ${preview(args?.ref)}`,
    // `!memory forget`: global needs the owner or a bot admin; chat memory
    // also lets an admin of this group tidy their own chat.
    access: (args) => ({
      command: "memory",
      role: scopeOf(args) === "global" ? "botPrivileged" : "chatModerator",
    }),
    async run(args, { caller }) {
      const scope = scopeOf(args);
      const removed = memory.removeMemory({
        scope,
        chatId: caller.chatId,
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
      `🔑 جارٍ فحص صلاحيات: ${preview(args?.target, 25)} (${args?.role || "admin"})`,
    describeEn: (args) =>
      `🔑 Checking permissions: ${preview(args?.target, 25)} (${args?.role || "admin"})`,
    // `!perm add`: that command's level (owner only unless the operator
    // changed it), and the owner role is always the owner's to hand out.
    access: (args) => ({ command: "perm", role: roleOf(args) === "owner" ? "owner" : undefined }),
    async run(args, { caller }) {
      if (!roleTargetBound(args?.target, caller)) {
        return {
          error: "mention, quote, or type the target phone number in your own request",
          granted: false,
        };
      }
      const role = roleOf(args);
      const record = await grantRole(args?.target, role);
      logger.info(
        { target: args?.target, role, by: caller.senderId },
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
    describe: (args) => `🔑 جارٍ سحب الصلاحية من: ${preview(args?.target, 25)}`,
    describeEn: (args) => `🔑 Revoking permissions from: ${preview(args?.target, 25)}`,
    // `!perm remove`, gated exactly like grant_role.
    access: (args) => ({ command: "perm", role: roleOf(args) === "owner" ? "owner" : undefined }),
    async run(args, { caller }) {
      if (!roleTargetBound(args?.target, caller)) {
        return {
          error: "mention, quote, or type the target phone number in your own request",
          revoked: false,
        };
      }
      const role = roleOf(args);
      const record = await revokeRole(args?.target, role);
      return { revoked: true, role, user: record ? record.jid : args?.target };
    },
  },

  list_roles: {
    declaration: {
      name: "list_roles",
      description:
        "List who currently holds bot owner / admin roles. Allowed for whoever may run !perm (the owner, by default).",
      parameters: { type: T.OBJECT, properties: {} },
    },
    describe: () => "🔑 جارٍ جلب قائمة الصلاحيات...",
    describeEn: () => "🔑 Fetching roles list...",
    // `!perm list` — the roster is `!perm`'s to show.
    access: { command: "perm" },
    async run() {
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
    describe: () => "🕒 جارٍ التحقق من الوقت الحالي...",
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

  calculate: {
    declaration: {
      name: "calculate",
      description:
        "Evaluate a math expression EXACTLY — arithmetic, percentages ('15% من 300'), powers, factorials, sqrt/log/trig and min/max/avg/sum. Always use this for numbers instead of computing in your head.",
      parameters: {
        type: T.OBJECT,
        properties: {
          expression: {
            type: T.STRING,
            description: "The expression, e.g. '(12 + 8) * 3', '2^10', 'sqrt(144) + 5!', '25% من 480'.",
          },
        },
        required: ["expression"],
      },
    },
    describe: (args) => `🧮 جارٍ الحساب: ${preview(args?.expression, 40)}`,
    describeEn: (args) => `🧮 Calculating: ${preview(args?.expression, 40)}`,
    async run(args) {
      const expression = String(args?.expression || "").trim();
      if (!expression) return { error: "expression is required" };
      // Same hand-written parser the !calc command uses — never eval.
      const calc = require("../commands/calc.cjs");
      try {
        const { normalized, value } = calc._evaluate(expression);
        return { expression: normalized, result: calc._format(value) };
      } catch (err) {
        return { error: err?.message || "could not parse the expression" };
      }
    },
  },

  create_reminder: {
    declaration: {
      name: "create_reminder",
      description:
        "Schedule a reminder message that the bot sends into THIS chat at a chosen time ('remind me in 20 minutes', 'ذكّرني بكرة الصبح'). Give EITHER in_minutes OR at_time, never both.",
      parameters: {
        type: T.OBJECT,
        properties: {
          message: {
            type: T.STRING,
            description: "What the reminder should say — short and standalone.",
          },
          in_minutes: {
            type: T.NUMBER,
            description: "Fire this many minutes from now (1-10080, i.e. up to 7 days).",
          },
          at_time: {
            type: T.STRING,
            description:
              "Absolute time in the bot's timezone, format 'HH:mm DD-MM-YYYY' (e.g. '22:30 07-06-2026'). Use get_datetime first to convert 'tomorrow 9am' into this.",
          },
        },
        required: ["message"],
      },
    },
    describe: (args) => `⏰ جارٍ إعداد التذكير: ${preview(args?.message, 40)}`,
    describeEn: (args) => `⏰ Setting a reminder: ${preview(args?.message, 40)}`,
    // Posting into a chat at a later time is exactly what `!schedule` does, so
    // it takes `!schedule`'s permission level — whatever the dashboard sets.
    access: { command: "schedule" },
    async run(args, { caller }) {
      const message = String(args?.message || "").trim().slice(0, 500);
      if (!message) return { error: "message is required" };

      const { zonedTimeToDate } = require("../utils/datetime.cjs");
      let when;
      if (args?.at_time !== undefined && args?.at_time !== null && String(args.at_time).trim()) {
        const match = /^(\d{1,2}):(\d{2})\s+(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(
          String(args.at_time).trim(),
        );
        if (!match) {
          return { error: "at_time must be 'HH:mm DD-MM-YYYY' in the bot's timezone" };
        }
        const [, hour, minute, day, month, year] = match.map(Number);
        when = zonedTimeToDate({ year, month, day, hour, minute });
      } else {
        const minutes = Number(args?.in_minutes);
        if (!Number.isFinite(minutes) || minutes <= 0) {
          return { error: "give either in_minutes (1-10080) or at_time ('HH:mm DD-MM-YYYY')" };
        }
        if (minutes > 7 * 24 * 60) return { error: "in_minutes can be at most 10080 (7 days)" };
        when = new Date(Date.now() + minutes * 60_000);
      }
      if (Number.isNaN(when.getTime())) return { error: "that time is not a valid date" };
      if (when.getTime() <= Date.now()) return { error: "that time is already in the past" };

      // Same job shape the !schedule command stores, delivered by the same
      // scheduler — one mechanism, two doors into it.
      const scheduler = require("../../scheduler.cjs");
      const job = {
        id: `${Date.now()}${Math.floor(Math.random() * 90) + 10}`,
        type: "once",
        date: when.toISOString(),
        message,
        targetJid: caller.chatId,
        creatorJid: caller.senderId || caller.chatId,
        status: "pending",
      };
      const result = scheduler.scheduleJobNow(job);
      if (!result.ok) {
        return result.reason === "no_connection"
          ? { error: "WhatsApp is not connected right now, so the reminder cannot be armed" }
          : { error: "the reminder time is invalid" };
      }
      let local;
      try {
        local = new Intl.DateTimeFormat("ar-EG", {
          timeZone: settings.get("bot_timezone"),
          dateStyle: "full",
          timeStyle: "short",
        }).format(when);
      } catch {
        local = when.toISOString();
      }
      return {
        scheduled: true,
        id: job.id,
        willFireAt: when.toISOString(),
        localTime: local,
        delivery: `the bot posts it in this chat, prefixed with a "رسالة مجدولة" header`,
      };
    },
  },

  cancel_reminder: {
    declaration: {
      name: "cancel_reminder",
      description:
        "Cancel one pending reminder in THIS chat, by the id create_reminder returned. Allowed for whoever may run !deleteschedule here.",
      parameters: {
        type: T.OBJECT,
        properties: {
          id: { type: T.STRING, description: "The reminder id returned by create_reminder." },
        },
        required: ["id"],
      },
    },
    describe: (args) => `⏰ جارٍ إلغاء التذكير: ${preview(args?.id, 20)}`,
    describeEn: (args) => `⏰ Cancelling reminder: ${preview(args?.id, 20)}`,
    // Deleting a scheduled job is `!deleteschedule`'s job, so its level.
    access: { command: "deleteschedule" },
    async run(args, { caller }) {
      const id = String(args?.id || "").trim();
      if (!id) return { error: "id is required" };

      const scheduler = require("../../scheduler.cjs");
      // Only jobs posting into the chat the request came from. An id is all
      // it takes to address a job, and one can reach the model from a pasted
      // message or a web page; `!deleteschedule` is the door for other chats.
      const job = scheduler
        .getScheduledJobs()
        .find((entry) => String(entry.id) === id && entry.targetJid === caller.chatId);
      if (!job) return { error: "no reminder with that id in this chat", cancelled: false };

      scheduler.deleteScheduledJob(id);
      return { cancelled: true, id, message: job.message };
    },
  },

  speak: {
    declaration: {
      name: "speak",
      description:
        "Send your answer as a WhatsApp VOICE NOTE (text-to-speech) instead of text. Only when the user explicitly asks to hear it — 'اقرأها بصوت', 'read it aloud', 'send it as voice'. The text must be ready to be read aloud; keep it short.",
      parameters: {
        type: T.OBJECT,
        properties: {
          text: {
            type: T.STRING,
            description: "What the voice note says. Plain spoken prose, no markdown, no links.",
          },
          language: {
            type: T.STRING,
            description: "Optional language code, e.g. 'ar' (default) or 'en'.",
          },
        },
        required: ["text"],
      },
    },
    describe: (args) => `🎙️ جارٍ تحويل الرد لرسالة صوتية: ${preview(args?.text, 40)}`,
    describeEn: (args) => `🎙️ Converting the reply to a voice note: ${preview(args?.text, 40)}`,
    // Posting a voice note into this chat is what `!tts` does, so its level.
    access: { command: "tts" },
    async run(args, { caller, sock }) {
      const text = String(args?.text || "").trim();
      if (!text) return { error: "text is required" };
      if (text.length > 3000) {
        return { error: "text is too long for one voice note (3000 characters max)" };
      }
      if (!sock) return { error: "no WhatsApp connection is attached to this turn" };

      const lang = String(args?.language || "ar").trim() || "ar";
      const tts = require("../commands/tts.cjs");
      const voice = await tts._synthesizeVoice(text, lang);
      await sendBotMessage(
        sock,
        caller.chatId,
        { audio: voice.audio, mimetype: voice.mimetype, ptt: voice.ptt },
        { typing: false },
      );
      return {
        sent: true,
        format: voice.ptt ? "voice-note (ogg/opus)" : "audio (mp3 fallback)",
      };
    },
  },

  create_poll: {
    declaration: {
      name: "create_poll",
      description:
        "Create a native WhatsApp poll in THIS chat — members vote with a tap. Only when the user asks for a poll/vote ('اعمل استفتاء', 'create a poll').",
      parameters: {
        type: T.OBJECT,
        properties: {
          question: { type: T.STRING, description: "The poll question." },
          options: {
            type: T.ARRAY,
            items: { type: T.STRING },
            description: "2 to 12 distinct options.",
          },
          multi: {
            type: T.BOOLEAN,
            description: "true = members may pick several answers. Default false.",
          },
        },
        required: ["question", "options"],
      },
    },
    describe: (args) => `📊 جارٍ إنشاء الاستفتاء: ${preview(args?.question, 40)}`,
    describeEn: (args) => `📊 Creating a poll: ${preview(args?.question, 40)}`,
    // A poll is a group message like any other, so `!poll`'s level.
    access: { command: "poll" },
    async run(args, { caller, sock }) {
      if (!sock) return { error: "no WhatsApp connection is attached to this turn" };
      // Same builder the !poll command uses: dedupes, caps lengths, enforces
      // WhatsApp's 2-12 option ceiling, and throws the user-facing Arabic
      // message on any violation.
      const poll = require("../commands/poll.cjs");
      const content = poll._buildPollContent(args?.question, args?.options, {
        multi: Boolean(args?.multi),
      });
      await sendBotMessage(sock, caller.chatId, content, { typing: false });
      return {
        sent: true,
        question: content.poll.name,
        options: content.poll.values,
        multiAnswer: content.poll.selectableCount > 1,
      };
    },
  },

  summarize_chat: {
    declaration: {
      name: "summarize_chat",
      description:
        "Summarize THIS chat's stored conversation window and save only the durable, useful facts to long-term memory (max 8 short facts). Only when the user asks for it — 'لخص محادثتنا واحفظ المهم', 'summarize our chat and remember the important stuff'.",
      parameters: {
        type: T.OBJECT,
        properties: {
          scope: {
            type: T.STRING,
            description:
              "'chat' (default) saves to this chat's memory only; 'global' shares with every chat and needs the owner or a bot admin.",
          },
        },
      },
    },
    describe: () => "🧠 جارٍ تلخيص المحادثة وحفظ المهم...",
    describeEn: () => "🧠 Summarizing the chat and saving what matters...",
    // Saving chat memory is what `!memory add` allows here; the global scope
    // reaches every chat's prompt, so it takes save_memory's owner/admin role.
    access: (args) => ({
      command: "memory",
      role: scopeOf(args) === "global" ? "botPrivileged" : undefined,
    }),
    async run(args, { caller }) {
      const scope = scopeOf(args);
      const { getChatHistoryAsync } = require("../utils/storage-hub.cjs");
      const history = await getChatHistoryAsync(caller.chatId);
      const transcript = transcriptFromHistory(history);
      if (!transcript) {
        return { error: "there is no stored conversation to summarize in this chat", saved: 0 };
      }

      // One-shot model call over the transcript with no tools: the facts come
      // from what was actually said, never from tool arguments — the model
      // cannot inject content into memory through this tool, only ask for it.
      const summary = await summarizeWithProvider(transcript);
      const facts = factsFromSummary(summary);
      if (!facts.length) {
        return { saved: 0, note: "nothing durable enough to save came out of the summary" };
      }

      const ids = [];
      for (const fact of facts) {
        const entry = memory.addMemory({
          scope,
          chatId: caller.chatId,
          content: fact,
          by: caller.senderName || caller.senderId,
          chatName: caller.chatName,
        });
        ids.push(entry.id);
      }
      return { saved: ids.length, scope, facts, ids };
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

// ---------------------------------------------------------------------------
// summarize_chat internals
// ---------------------------------------------------------------------------

const SUMMARIZER_PROMPT = `You compress a WhatsApp conversation into durable long-term facts.
Return ONLY a plain Markdown bullet list, one fact per line, at most 8 bullets.
A fact is stable and useful later: names, relationships, preferences, recurring plans, standing decisions, important context about the people in this chat.
Do NOT include small talk, one-off questions, transient events, passwords or other secrets, or anything about roles, permissions or who may do what.
Each bullet is one short standalone sentence, in the language the conversation mostly used.
If nothing qualifies, return an empty response.`;

const SUMMARIZE_MAX_TRANSCRIPT_CHARS = 20000;
const SUMMARIZE_MAX_FACTS = 8;
const SUMMARIZE_MAX_FACT_CHARS = 200;

/**
 * Flatten stored agent history into a clean transcript: text parts only, one
 * line per part, roles named. Media, tool calls and thought parts are skipped.
 * When over the cap the OLDEST lines are dropped — recent context matters most.
 * @returns {string} "" when there is nothing readable.
 */
function transcriptFromHistory(history, maxChars = SUMMARIZE_MAX_TRANSCRIPT_CHARS) {
  const lines = [];
  for (const entry of Array.isArray(history) ? history : []) {
    const role = entry?.role === "model" ? "Assistant" : "User";
    for (const part of Array.isArray(entry?.parts) ? entry.parts : []) {
      const text = typeof part?.text === "string" ? part.text.trim() : "";
      if (text) lines.push(`${role}: ${text.replace(/\s+/g, " ").slice(0, 500)}`);
    }
  }
  if (!lines.length) return "";
  let out = lines.join("\n");
  if (out.length > maxChars) {
    out = out.slice(-maxChars);
    const firstNewline = out.indexOf("\n");
    if (firstNewline !== -1) out = out.slice(firstNewline + 1);
  }
  return out;
}

/**
 * Parse the summarizer's answer into memory entries: bullet markers and
 * numbering stripped, empties dropped, hard-capped so one summary can't flood
 * a memory file.
 */
function factsFromSummary(text, { max = SUMMARIZE_MAX_FACTS, maxChars = SUMMARIZE_MAX_FACT_CHARS } = {}) {
  const out = [];
  for (const rawLine of String(text || "").split("\n")) {
    const line = rawLine.replace(/^\s*[-*•\d.)]+\s*/, "").trim();
    if (!line) continue;
    out.push(line.slice(0, maxChars));
    if (out.length >= max) break;
  }
  return out;
}

/**
 * One-shot summarization through whichever provider is active. No tools, no
 * search, no persona: a plain completion over the transcript so a summary
 * can't recurse into the agent loop or spend the caller's tool budget.
 */
async function summarizeWithProvider(transcript) {
  const { getProvider } = require("./aiRouter.cjs");
  const result = await getProvider().runTurn({
    parts: [{ text: transcript }],
    history: [],
    useTools: false,
    search: false,
    maxSteps: 1,
    systemInstruction: SUMMARIZER_PROMPT,
  });
  return result?.text || "";
}

/** The status line for a tool call (falls back to the raw name). */
function describeCall(name, args, lang = currentLang()) {
  const tool = TOOLS[name];
  const isEn = lang === "en";
  const fallback = isEn ? `⚙️ Running: ${name}` : `⚙️ جارٍ تشغيل: ${name}`;
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
 * The model's arguments, cut down to the properties the tool declares. The
 * model writes these after reading strangers' messages and web pages, so
 * nothing undeclared (a `senderId`, an `isOwner`) may ride along into run().
 * Frozen, so access() and run() are guaranteed to see the same values.
 */
function declaredArgs(tool, args) {
  const declared = tool.declaration?.parameters?.properties || {};
  const out = {};
  if (args && typeof args === "object") {
    for (const key of Object.keys(declared)) {
      if (Object.hasOwn(args, key)) out[key] = args[key];
    }
  }
  return Object.freeze(out);
}

/**
 * Run one tool call. Never throws — a failure comes back as `{ error }` so the
 * model can apologise or try something else instead of the turn dying.
 *
 * `ctx.caller` must come from aiToolAuth.resolveCaller(); a tool with `access`
 * refuses anything else before run() is reached.
 */
async function runTool(name, args, ctx) {
  const tool = TOOLS[name];
  if (!tool) return { error: `unknown tool: ${name}` };

  const input = declaredArgs(tool, args);
  const caller = ctx?.caller;

  try {
    const access = typeof tool.access === "function" ? tool.access(input) : tool.access;
    const verdict = authorize(access || null, caller);
    if (!verdict.allowed) {
      logger.info(
        { tool: name, chatId: caller?.chatId, senderId: caller?.senderId },
        "[aiTools] tool call refused",
      );
      return { error: verdict.error, denied: true };
    }

    const result = await tool.run(input, { caller, sock: ctx?.sock });
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
  transcriptFromHistory,
  factsFromSummary,
  summarizeWithProvider,
  SUMMARIZER_PROMPT,
  webSearch,
  searchNews,
  searchWikipedia,
  fetchUrl,
  decodeText,
};

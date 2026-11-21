// Thought-signature lifecycle, one-shot recovery, memory batch stripping,
// signature stripping when Gemini settings change, and sanitized WhatsApp error cards.

import {
  errorReply,
  functionCallReply,
  startGenaiServer,
  textReply,
} from "./fixtures/genai-server.mjs";
import {
  OPENAI_PATH,
  openaiText,
  openaiToolCall,
  startProviderServer,
} from "./fixtures/provider-server.mjs";
import {
  equal,
  finish,
  require as harnessRequire,
  ok,
  section,
  useTempDataDir,
} from "./harness.mjs";

useTempDataDir("levix-thought-signature");

const settings = harnessRequire("./src/config/settings.cjs");
// Registers the gemini_model / base URL / API key listener that strips signatures.
harnessRequire("./src/services/settingsTransfer.cjs");
const store = harnessRequire("./src/db/store.cjs");
const { q } = harnessRequire("./src/db/db.cjs");
const permissions = harnessRequire("./src/utils/permissions.cjs");
await permissions.primePermissions();
const aiAgent = harnessRequire("./src/services/aiAgent.cjs");
const geminiCommand = harnessRequire("./src/commands/gemini.cjs");
const { stripMemoryToolParts } = harnessRequire("./src/services/memoryPolicy.cjs");
const { t, withLang } = harnessRequire("./src/utils/i18n.cjs");
const { timing } = await import("../src/utils/sendBotMessage.esm.js");
timing.sleep = async () => {};

settings.set("bot_min_delay_ms", 0);
settings.set("bot_max_delay_ms", 0);
settings.set("ai_google_search", false);

const OWNER = "201000000777@s.whatsapp.net";
const SELF = "201000000999@s.whatsapp.net";
await permissions.grantRole(OWNER, "owner");

function makeSocket() {
  const sent = [];
  return {
    sent,
    user: { id: SELF.replace("@", ":4@") },
    async sendMessage(jid, content) {
      sent.push({ jid, content, text: content?.text || "" });
      return { key: { id: `msg-${sent.length}`, remoteJid: jid, fromMe: true } };
    },
    async sendPresenceUpdate() {},
    async presenceSubscribe() {},
  };
}

function makeMessage(chatId = OWNER, text = "!ai hello") {
  return {
    key: {
      remoteJid: chatId,
      fromMe: false,
      id: `in-${Math.random().toString(36).slice(2)}`,
    },
    pushName: "Owner",
    message: { conversation: text },
  };
}

async function withGeminiServer(replies, run) {
  const fake = await startGenaiServer(replies);
  settings.set("ai_provider", "gemini");
  settings.set("gemini_model", "gemini-3.7-flash");
  settings.set("gemini_base_url", fake.baseUrl);
  settings.set("gemini_api_key", `AIzaSyTestSecretKey_${Math.random().toString(36).slice(2)}`);
  try {
    return await run(fake);
  } finally {
    settings.set("gemini_base_url", "");
    await fake.stop();
  }
}

function priorToolHistory(signature = "stale-sig-001") {
  return [
    { role: "user", parts: [{ text: "earlier question" }] },
    {
      role: "model",
      parts: [
        {
          text: "private chain of thought",
          thought: true,
          thoughtSignature: `${signature}-thought`,
        },
        {
          functionCall: { name: "get_datetime", args: {} },
          thoughtSignature: signature,
        },
      ],
    },
    {
      role: "user",
      parts: [
        {
          functionResponse: {
            name: "get_datetime",
            response: { iso: "2026-11-20T12:00:00.000Z" },
          },
        },
      ],
    },
    {
      role: "model",
      parts: [{ text: "earlier answer", thoughtSignature: `${signature}-text` }],
    },
  ];
}

// ---------------------------------------------------------------------------
// 1. First send returns the exact 400, second returns a normal answer
// ---------------------------------------------------------------------------

section("first send returns exact 400, second returns normal answer");

await withGeminiServer(
  [errorReply(400, "Invalid thought signature."), textReply("fresh answer")],
  async (fake) => {
    const chatId = "201000000101@s.whatsapp.net";
    store.saveChatHistory(chatId, priorToolHistory("stale-sig-recover"), {
      provider: "gemini",
      model: "gemini-3.7-flash",
    });
    const sock = makeSocket();
    const args = ["keep", "my", "prompt", "intact"];

    await withLang("en", () =>
      geminiCommand.execute(
        sock,
        makeMessage(chatId, `!ai ${args.join(" ")}`),
        args,
        `!ai ${args.join(" ")}`,
        null,
        { invokedName: "ai" },
      ),
    );

    equal("exactly two requests were sent to Gemini", fake.requests.length, 2);

    const firstBody = JSON.stringify(fake.body(0)?.contents || []);
    ok("first request carried prior functionCall", firstBody.includes("functionCall"));
    ok("first request carried prior signature", firstBody.includes("stale-sig-recover"));

    const secondContents = fake.body(1)?.contents || [];
    const secondBody = JSON.stringify(secondContents);
    ok("second request has no prior functionCall", !secondBody.includes("functionCall"));
    ok("second request has no prior functionResponse", !secondBody.includes("functionResponse"));
    ok("second request has no thought parts", !secondBody.includes("private chain of thought"));
    ok("second request has no stale signatures", !secondBody.includes("stale-sig-recover"));
    equal(
      "second request kept prior plain user text",
      secondContents[0]?.parts?.[0]?.text,
      "earlier question",
    );
    equal(
      "second request kept prior plain model text",
      secondContents[1]?.parts?.[0]?.text,
      "earlier answer",
    );
    equal(
      "second request kept current user message intact",
      secondContents.at(-1)?.parts?.[0]?.text,
      "keep my prompt intact",
    );

    const delivered = sock.sent.at(-1)?.text || "";
    ok("the answer was delivered to WhatsApp", delivered.includes("fresh answer"));

    const saved = store.getChatHistory(chatId);
    const savedJson = JSON.stringify(saved);
    ok("stored history has the new turn", savedJson.includes("fresh answer"));
    ok("stored history has no stale signatures", !savedJson.includes("stale-sig-recover"));
    ok("stored history has no prior functionCall", !savedJson.includes("functionCall"));
    ok("stored history is a plain array", Array.isArray(saved));
    ok("stored history has no provider stamp", saved.provider === undefined);
    const raw = q("SELECT history FROM ai_history WHERE chat_id = ?").get(chatId).history;
    ok("disk history is a JSON array", raw.startsWith("["));
  },
);

// ---------------------------------------------------------------------------
// 2. Exact 400 twice: two requests only, translated signature message, no JSON
// ---------------------------------------------------------------------------

section("exact 400 twice: two requests only, translated signature message, no raw JSON");

await withGeminiServer(
  [
    errorReply(400, "Invalid thought signature."),
    errorReply(400, "Function call is missing a thought_signature."),
    textReply("must never be reached"),
  ],
  async (fake) => {
    const chatId = "201000000102@s.whatsapp.net";
    const initialHistory = priorToolHistory("stale-sig-twice");
    store.saveChatHistory(chatId, initialHistory, {
      provider: "gemini",
      model: "gemini-3.7-flash",
    });
    const beforeStored = JSON.stringify(store.getChatHistory(chatId));
    const sock = makeSocket();

    await withLang("en", () =>
      geminiCommand.execute(sock, makeMessage(chatId, "!ai hello"), ["hello"], "!ai hello", null, {
        invokedName: "ai",
      }),
    );

    equal("two requests only (no retry loop)", fake.requests.length, 2);
    const finalCard = sock.sent.at(-1)?.text || "";
    ok("shows translated signature message", finalCard.includes("out of sync with the AI model"));
    ok("no raw JSON brace in sent text", !finalCard.includes("{") && !finalCard.includes("}"));
    ok("no INVALID_ARGUMENT in sent text", !finalCard.includes("INVALID_ARGUMENT"));
    ok("no ApiError type leak in sent text", !finalCard.includes("ApiError"));
    equal(
      "failed turn does not overwrite stored history",
      JSON.stringify(store.getChatHistory(chatId)),
      beforeStored,
    );
  },
);

// ---------------------------------------------------------------------------
// 3. Exact 400 after a tool already ran: no retry, tool ran once
// ---------------------------------------------------------------------------

section("exact 400 after a tool already ran: no retry, tool ran once, translated message");

await withGeminiServer(
  [
    functionCallReply([{ name: "get_datetime", args: {}, id: "call-1" }], {
      thoughtSignature: "turn-sig-1",
    }),
    errorReply(400, "Invalid thought signature."),
    textReply("must never run"),
  ],
  async (fake) => {
    const chatId = "201000000103@s.whatsapp.net";
    store.deleteChatHistory(chatId);
    const sock = makeSocket();

    await withLang("en", () =>
      geminiCommand.execute(
        sock,
        makeMessage(chatId, "!ai what time is it"),
        ["what", "time", "is", "it"],
        "!ai what time is it",
        null,
        { invokedName: "ai" },
      ),
    );

    equal("only initial request + tool response request (no retry)", fake.requests.length, 2);
    const toolUpdates = sock.sent.filter((entry) =>
      /Checking current time/i.test(entry.text || ""),
    );
    equal("tool ran once", toolUpdates.length, 1);

    const finalCard = sock.sent.at(-1)?.text || "";
    ok("shows translated signature message", finalCard.includes("out of sync with the AI model"));
    ok("no raw JSON in sent text", !finalCard.includes("{") && !finalCard.includes("}"));
    ok("no INVALID_ARGUMENT in sent text", !finalCard.includes("INVALID_ARGUMENT"));
    equal("failed tool turn did not persist history", store.getChatHistory(chatId).length, 0);
  },
);

// ---------------------------------------------------------------------------
// 4. Unrelated 400: no retry, generic translated message
// ---------------------------------------------------------------------------

section("unrelated 400: no retry, generic translated message");

await withGeminiServer(
  [
    errorReply(400, "Invalid value at 'contents[0]': unsupported field."),
    textReply("must not retry"),
  ],
  async (fake) => {
    const chatId = "201000000104@s.whatsapp.net";
    store.saveChatHistory(chatId, priorToolHistory("sig-unrelated-400"), {
      provider: "gemini",
      model: "gemini-3.7-flash",
    });
    const sock = makeSocket();

    await withLang("en", () =>
      geminiCommand.execute(sock, makeMessage(chatId, "!ai test"), ["test"], "!ai test", null, {
        invokedName: "ai",
      }),
    );

    equal("no retry on unrelated 400", fake.requests.length, 1);
    const finalCard = sock.sent.at(-1)?.text || "";
    ok(
      "shows generic translated message",
      finalCard.includes("The AI could not complete this request right now"),
    );
    ok("no raw JSON in sent text", !finalCard.includes("{") && !finalCard.includes("}"));
    ok("no INVALID_ARGUMENT in sent text", !finalCard.includes("INVALID_ARGUMENT"));
    ok("no raw server message in sent text", !finalCard.includes("unsupported field"));
  },
);

// ---------------------------------------------------------------------------
// 5. Memory filter with parallel batch [save_memory (signed), web_search (unsigned)]
// ---------------------------------------------------------------------------

section(
  "memory filter removes whole parallel batch with memory tool and keeps non-memory signatures byte-exact",
);
{
  const exactSig = "sig-non-memory-byte-exact-987654321+/=";
  const history = [
    { role: "user", parts: [{ text: "remember this and search" }] },
    {
      role: "model",
      parts: [
        {
          functionCall: { name: "save_memory", args: { content: "secret", scope: "global" } },
          thoughtSignature: "sig-memory-first-in-batch",
        },
        {
          functionCall: { name: "web_search", args: { query: "levix bot" } },
        },
      ],
    },
    {
      role: "user",
      parts: [
        { functionResponse: { name: "save_memory", response: { saved: true } } },
        { functionResponse: { name: "web_search", response: { results: ["hit"] } } },
      ],
    },
    { role: "model", parts: [{ text: "Saved and searched." }] },
    { role: "user", parts: [{ text: "now check time and calculate" }] },
    {
      role: "model",
      parts: [
        {
          functionCall: { name: "get_datetime", args: {}, id: "c1" },
          thoughtSignature: exactSig,
        },
        {
          functionCall: { name: "calculate", args: { expression: "6*7" }, id: "c2" },
        },
      ],
    },
    {
      role: "user",
      parts: [
        { functionResponse: { name: "get_datetime", id: "c1", response: { iso: "2026-11-20" } } },
        { functionResponse: { name: "calculate", id: "c2", response: { result: 42 } } },
      ],
    },
    { role: "model", parts: [{ text: "42 at noon." }] },
  ];

  const filtered = stripMemoryToolParts(history);
  const serialized = JSON.stringify(filtered);

  ok("memory tool call is removed", !serialized.includes("save_memory"));
  ok("unsigned sibling in mixed batch is removed too", !serialized.includes("web_search"));
  ok("mixed batch signature is removed", !serialized.includes("sig-memory-first-in-batch"));
  equal(
    "remaining entries count (2 text turns + 1 non-memory exchange + 2 text turns)",
    filtered.length,
    6,
  );
  equal(
    "non-memory exchange keeps its signature byte-exact",
    filtered[3].parts[0].thoughtSignature,
    exactSig,
  );
  equal(
    "non-memory sibling call is preserved",
    filtered[3].parts[1].functionCall.name,
    "calculate",
  );
  equal(
    "non-memory responses remain paired",
    filtered[4].parts.map((p) => p.functionResponse.name).join(","),
    "get_datetime,calculate",
  );
}

// ---------------------------------------------------------------------------
// 6. Provider switch and model change provenance
// ---------------------------------------------------------------------------

section(
  "openai function calls stay in the first Gemini request; a model change strips signatures once and keeps the calls",
);
{
  const chatId = "201000000106@s.whatsapp.net";
  const openaiServer = await startProviderServer({
    [OPENAI_PATH]: [
      openaiToolCall([{ name: "get_datetime", args: {}, id: "call_openai_1" }]),
      openaiText("OpenAI answered with a tool"),
    ],
  });
  settings.set("ai_provider", "openai");
  settings.set("openai_api_key", "sk-test-openai-secret-key");
  settings.set("openai_model", "gpt-5.4-mini");
  settings.set("openai_base_url", openaiServer.baseUrl);
  try {
    const sock = makeSocket();
    await withLang("en", () =>
      geminiCommand.execute(
        sock,
        makeMessage(chatId, "!ai check time on openai"),
        ["check", "time", "on", "openai"],
        "!ai check time on openai",
        null,
        { invokedName: "ai" },
      ),
    );
  } finally {
    await openaiServer.stop();
  }

  const storedAfterOpenAI = store.getChatHistory(chatId);
  ok("stored openai history is a plain array", Array.isArray(storedAfterOpenAI));
  ok("stored openai history has no provider stamp", storedAfterOpenAI.provider === undefined);
  ok("stored openai history has no model stamp", storedAfterOpenAI.model === undefined);
  const rawOpenAI = q("SELECT history FROM ai_history WHERE chat_id = ?").get(chatId).history;
  ok("stored openai history is a JSON array on disk", rawOpenAI.startsWith("["));
  ok(
    "stored openai history contains unsigned canonical functionCall",
    rawOpenAI.includes("functionCall"),
  );

  // A provider switch no longer drops function calls. Signatures stay until a
  // Gemini model, endpoint, or API key change.
  const exactGeminiSig = "gemini-sig-byte-exact-ABC123xyz==";
  await withGeminiServer(
    [
      functionCallReply([{ name: "get_datetime", args: {} }], {
        thoughtSignature: exactGeminiSig,
      }),
      textReply("Gemini turn 1 done"),
      textReply("Gemini turn 2 done"),
    ],
    async (fake) => {
      const sock = makeSocket();
      await withLang("en", () =>
        geminiCommand.execute(
          sock,
          makeMessage(chatId, "!ai now on gemini"),
          ["now", "on", "gemini"],
          "!ai now on gemini",
          null,
          { invokedName: "ai" },
        ),
      );

      equal("first Gemini turn took 2 requests (initial + 1 tool result)", fake.requests.length, 2);
      const firstGeminiContents = fake.body(0)?.contents || [];
      const firstGeminiJson = JSON.stringify(firstGeminiContents);
      ok(
        "unsigned openai functionCall is still in the first Gemini request",
        firstGeminiJson.includes("call_openai_1") && firstGeminiJson.includes("functionCall"),
      );
      ok(
        "openai functionResponse is still in the first Gemini request",
        firstGeminiJson.includes("functionResponse"),
      );
      equal(
        "plain user text from openai turn was kept",
        firstGeminiContents[0]?.parts?.[0]?.text,
        "check time on openai",
      );
      ok(
        "plain model text from openai turn was kept",
        firstGeminiJson.includes("OpenAI answered with a tool"),
      );

      // Next turn on the SAME provider (gemini) and SAME model (gemini-3.7-flash):
      // history is replayed unchanged and signatures are byte-exact.
      await withLang("en", () =>
        geminiCommand.execute(
          sock,
          makeMessage(chatId, "!ai follow up same model"),
          ["follow", "up", "same", "model"],
          "!ai follow up same model",
          null,
          { invokedName: "ai" },
        ),
      );

      equal("second Gemini turn sent 1 request", fake.requests.length, 3);
      const replayContents = fake.body(2)?.contents || [];
      const signed = replayContents
        .flatMap((turn) => turn.parts || [])
        .find((part) => part.thoughtSignature === exactGeminiSig);
      ok("same model replayed the signed tool turn", Boolean(signed?.functionCall));
      equal("replayed thoughtSignature is byte-exact", signed?.thoughtSignature, exactGeminiSig);

      const rawBeforeChange = q("SELECT history FROM ai_history WHERE chat_id = ?").get(
        chatId,
      ).history;
      ok(
        "stored signature is present before the setting change",
        rawBeforeChange.includes(exactGeminiSig),
      );

      const realStrip = store.stripGeminiThoughtSignatures;
      let strips = 0;
      store.stripGeminiThoughtSignatures = function (...args) {
        strips += 1;
        return realStrip.apply(this, args);
      };
      try {
        settings.set("link_previews_enabled", true);
        equal("an unrelated setting does not strip", strips, 0);
        equal(
          "an unrelated setting keeps the stored JSON byte-exact",
          q("SELECT history FROM ai_history WHERE chat_id = ?").get(chatId).history,
          rawBeforeChange,
        );
        settings.set("link_previews_enabled", false);

        settings.set("gemini_model", "gemini-3.1-pro-preview");
        equal("changing gemini_model strips once", strips, 1);

        await withLang("en", () =>
          geminiCommand.execute(
            sock,
            makeMessage(chatId, "!ai after model change"),
            ["after", "model", "change"],
            "!ai after model change",
            null,
            { invokedName: "ai" },
          ),
        );

        equal("third Gemini turn sent 1 request", fake.requests.length, 4);
        const afterModelChangeJson = JSON.stringify(fake.body(3)?.contents || []);
        ok(
          "the next request has no thoughtSignature",
          !afterModelChangeJson.includes("thoughtSignature") &&
            !afterModelChangeJson.includes(exactGeminiSig),
        );
        ok(
          "function calls survive the model change",
          afterModelChangeJson.includes("functionCall"),
        );
        ok(
          "function responses survive the model change",
          afterModelChangeJson.includes("functionResponse"),
        );
        ok(
          "plain text turns survived the gemini_model change",
          afterModelChangeJson.includes("Gemini turn 2 done"),
        );

        await withLang("en", () =>
          geminiCommand.execute(
            sock,
            makeMessage(chatId, "!ai once more"),
            ["once", "more"],
            "!ai once more",
            null,
            { invokedName: "ai" },
          ),
        );
        equal("a later message does not strip again", strips, 1);
        settings.set("gemini_model", "gemini-3.1-pro-preview");
        equal("setting the current model does not strip", strips, 1);
      } finally {
        store.stripGeminiThoughtSignatures = realStrip;
      }
    },
  );

  // Backward compatibility: legacy row stored as a plain JSON array without wrapper.
  const legacyChatId = "201000000199@s.whatsapp.net";
  q("INSERT OR REPLACE INTO ai_history (chat_id, history, updated_at) VALUES (?, ?, ?)").run(
    legacyChatId,
    JSON.stringify([{ role: "user", parts: [{ text: "legacy turn" }] }]),
    Date.now(),
  );
  const legacyLoaded = store.getChatHistory(legacyChatId);
  equal("legacy array row loads turns", legacyLoaded.length, 1);
  ok("legacy array row has no provider stamp", legacyLoaded.provider === undefined);
  ok("legacy array row has no model stamp", legacyLoaded.model === undefined);

  const wrappedChatId = "201000000198@s.whatsapp.net";
  store.saveChatHistory(wrappedChatId, {
    provider: "gemini",
    model: "gemini-3.7-flash",
    history: [
      { role: "user", parts: [{ text: "wrapped user" }] },
      {
        role: "model",
        parts: [{ functionCall: { name: "get_datetime", args: {} }, thoughtSignature: "wrap-sig" }],
      },
      {
        role: "user",
        parts: [{ functionResponse: { name: "get_datetime", response: { ok: true } } }],
      },
    ],
  });
  const wrappedRaw = q("SELECT history FROM ai_history WHERE chat_id = ?").get(
    wrappedChatId,
  ).history;
  ok("saving a wrapper writes an array", wrappedRaw.startsWith("["));
  const wrappedLoaded = store.getChatHistory(wrappedChatId);
  equal("wrapper input loads as the inner turns", wrappedLoaded.length, 3);
  ok("loaded wrapper has no provider stamp", wrappedLoaded.provider === undefined);

  q("INSERT OR REPLACE INTO ai_history (chat_id, history, updated_at) VALUES (?, ?, ?)").run(
    wrappedChatId,
    JSON.stringify({
      provider: "gemini",
      model: "gemini-3.7-flash",
      history: [
        { role: "user", parts: [{ text: "wrapped user" }] },
        {
          role: "model",
          parts: [
            { functionCall: { name: "get_datetime", args: {} }, thoughtSignature: "wrap-sig" },
          ],
        },
        {
          role: "user",
          parts: [{ functionResponse: { name: "get_datetime", response: { ok: true } } }],
        },
      ],
    }),
    Date.now(),
  );
  const reread = store.getChatHistory(wrappedChatId);
  equal("a stored wrapper still loads its turns", reread.length, 3);
  ok("a stored wrapper read has no provider stamp", reread.provider === undefined);
  settings.set("gemini_model", "gemini-3.8-flash");
  const strippedRaw = q("SELECT history FROM ai_history WHERE chat_id = ?").get(
    wrappedChatId,
  ).history;
  ok("a setting change rewrites the wrapper as an array", strippedRaw.startsWith("["));
  ok(
    "a setting change drops thought signatures",
    !strippedRaw.includes("wrap-sig") && !strippedRaw.includes("thoughtSignature"),
  );
  ok("a setting change keeps the function call", strippedRaw.includes("functionCall"));
  ok("a setting change keeps the function response", strippedRaw.includes("functionResponse"));
  ok("a setting change keeps the text", strippedRaw.includes("wrapped user"));
}

// ---------------------------------------------------------------------------
// 7. WhatsApp error text for each error class has no "{", no "INVALID_ARGUMENT", no API key fragment
// ---------------------------------------------------------------------------

section("WhatsApp error text for every error class in all locales is the exact translation");
{
  const secretKey = "AIzaSySuperSecretKeyFragment998877";
  settings.set("gemini_api_key", secretKey);
  const classKeys = {
    signature: "bot.ai.gemini.errorThoughtSignature",
    quota: "bot.ai.gemini.errorQuota",
    apiKey: "bot.ai.gemini.errorApiKey",
    safety: "bot.ai.gemini.errorSafety",
    unavailable: "bot.ai.gemini.errorUnavailable",
    generic: "bot.ai.gemini.errorGeneric",
  };

  const errorCases = [
    {
      expectedKind: "signature",
      reply: errorReply(400, `Invalid thought signature for key ${secretKey}`),
    },
    {
      expectedKind: "quota",
      reply: {
        __status: 429,
        body: {
          error: {
            code: 429,
            message: `Resource has been exhausted (e.g. check quota) for ${secretKey}`,
            status: "RESOURCE_EXHAUSTED",
          },
        },
      },
    },
    {
      expectedKind: "apiKey",
      reply: {
        __status: 401,
        body: {
          error: {
            code: 401,
            message: `API key not valid: ${secretKey}. Please pass a valid API key.`,
            status: "UNAUTHENTICATED",
          },
        },
      },
    },
    {
      expectedKind: "safety",
      reply: errorReply(400, `Request blocked due to SAFETY (PROHIBITED_CONTENT) ${secretKey}`),
    },
    {
      expectedKind: "unavailable",
      reply: {
        __status: 503,
        body: {
          error: {
            code: 503,
            message: `The service is currently unavailable (${secretKey}).`,
            status: "UNAVAILABLE",
          },
        },
      },
    },
    {
      expectedKind: "generic",
      reply: errorReply(400, `Unexpected schema mismatch near ${secretKey}`),
    },
  ];

  for (const { expectedKind, reply } of errorCases) {
    for (const locale of ["en", "ar", "pt-BR", "es-419"]) {
      await withGeminiServer([reply, reply], async () => {
        settings.set("gemini_api_key", secretKey);
        const chatId = `2010000099${errorCases.findIndex((c) => c.expectedKind === expectedKind)}@s.whatsapp.net`;
        const sock = makeSocket();

        await withLang(locale, async () => {
          await geminiCommand.execute(
            sock,
            makeMessage(chatId, "!ai test error card"),
            ["test", "error", "card"],
            "!ai test error card",
            null,
            { invokedName: "ai" },
          );
          const text = sock.sent.at(-1)?.text || "";
          const expected = settings
            .redactSecrets(
              t("bot.core.statusMessage.errorCard", {
                lead: t("bot.ai.gemini.chatFailed"),
                name: "Error",
                message: t(classKeys[expectedKind]),
              }),
            )
            .slice(0, 1500);
          equal(`${expectedKind}/${locale}: exact translated card`, text, expected);
          ok(`${expectedKind}/${locale}: contains no "{"`, !text.includes("{"));
          ok(`${expectedKind}/${locale}: contains no "}"`, !text.includes("}"));
          ok(
            `${expectedKind}/${locale}: contains no "INVALID_ARGUMENT"`,
            !text.includes("INVALID_ARGUMENT"),
          );
          ok(
            `${expectedKind}/${locale}: contains no API key fragment`,
            !text.includes("AIzaSy") && !text.includes("SuperSecretKeyFragment"),
          );
          ok(
            `${expectedKind}/${locale}: contains no raw catalog key`,
            !text.includes("bot.ai.") && !text.includes("bot.core."),
          );
        });
      });
    }
  }
}

section("thought-signature rejection matches explicit wording only");
{
  const accept = [
    "Invalid thought signature.",
    "The thought signature is not valid",
    "Function call is missing a thought_signature.",
    "missing thought signature in contents",
    "Thought signature was issued by an unavailable route",
  ];
  for (const message of accept) {
    ok(
      message,
      aiAgent.isThoughtSignatureError(Object.assign(new Error(message), { status: 400 })),
    );
  }
  ok(
    "a 400 that only echoes the field name is not a rejection",
    !aiAgent.isThoughtSignatureError(
      Object.assign(
        new Error(
          "Invalid value at contents[0].parts[0].thoughtSignature: echoed from the user prompt",
        ),
        { status: 400 },
      ),
    ),
  );
  ok(
    "a 500 that quotes the phrase is not a signature error",
    !aiAgent.isThoughtSignatureError(
      Object.assign(new Error("Invalid thought signature."), { status: 500 }),
    ),
  );
}

section("a stale file reference is positive, and a bare 404 is not");
{
  const sent = [
    {
      fileData: {
        fileUri: "https://generativelanguage.googleapis.com/v1beta/files/sentfile1",
      },
    },
  ];
  ok(
    "bare 404 is not a file reference",
    !aiAgent.isFileReferenceError(Object.assign(new Error("Not Found"), { status: 404 })),
  );
  ok(
    "permission_denied alone is not a file reference",
    !aiAgent.isFileReferenceError(Object.assign(new Error("PERMISSION_DENIED"), { status: 403 })),
  );
  ok(
    "failed_precondition alone is not a file reference",
    !aiAgent.isFileReferenceError(Object.assign(new Error("FAILED_PRECONDITION"), { status: 400 })),
  );
  ok(
    "file expired is a file reference",
    aiAgent.isFileReferenceError(Object.assign(new Error("file expired"), { status: 404 })),
  );
  ok(
    "Invalid file format is not a file reference even when a file URI was sent",
    !aiAgent.isFileReferenceError(
      Object.assign(new Error("Invalid file format"), { status: 400 }),
      sent,
    ),
  );
  ok(
    "a files id this turn sent is a file reference",
    aiAgent.isFileReferenceError(
      Object.assign(new Error("https://generativelanguage.googleapis.com/v1beta/files/sentfile1"), {
        status: 404,
      }),
      sent,
    ),
  );
  ok(
    "a different files id is not a file reference",
    !aiAgent.isFileReferenceError(
      Object.assign(new Error("https://generativelanguage.googleapis.com/v1beta/files/otherfile"), {
        status: 404,
      }),
      sent,
    ),
  );
}

section("a 400 that echoes thoughtSignature is not retried");
{
  await withGeminiServer(
    [
      errorReply(
        400,
        "Invalid value at contents[0].parts[0].thoughtSignature: echoed from the user prompt",
      ),
      textReply("must not retry"),
    ],
    async (fake) => {
      const chatId = "201000000181@s.whatsapp.net";
      store.saveChatHistory(chatId, priorToolHistory("sig-echo-field"));
      const sock = makeSocket();
      await withLang("en", async () => {
        await geminiCommand.execute(
          sock,
          makeMessage(chatId, "!ai echo"),
          ["echo"],
          "!ai echo",
          null,
          { invokedName: "ai" },
        );
        const text = sock.sent.at(-1)?.text || "";
        const expected = settings
          .redactSecrets(
            t("bot.core.statusMessage.errorCard", {
              lead: t("bot.ai.gemini.chatFailed"),
              name: "Error",
              message: t("bot.ai.gemini.errorGeneric"),
            }),
          )
          .slice(0, 1500);
        equal("one request only", fake.requests.length, 1);
        equal("generic card, not the signature class", text, expected);
        ok("the field echo is not in the chat", !text.includes("thoughtSignature"));
      });
    },
  );
}

section("a bare 404 before any tool is not recovered");
{
  await withGeminiServer(
    [errorReply(404, "Not Found"), textReply("must not retry")],
    async (fake) => {
      const chatId = "201000000182@s.whatsapp.net";
      const sock = makeSocket();
      await withLang("en", () =>
        geminiCommand.execute(
          sock,
          makeMessage(chatId, "!ai missing"),
          ["missing"],
          "!ai missing",
          null,
          {
            invokedName: "ai",
          },
        ),
      );
      equal("bare 404 is not retried", fake.requests.length, 1);
    },
  );
}

section("a positive stale file error before any tool retries once");
{
  const fileUri = "https://generativelanguage.googleapis.com/v1beta/files/sentfile1";
  await withGeminiServer(
    [errorReply(404, "file expired"), textReply("recovered without the file")],
    async (fake) => {
      const chatId = "201000000183@s.whatsapp.net";
      store.saveChatHistory(chatId, [
        { role: "user", parts: [{ text: "look", fileData: { fileUri, mimeType: "image/jpeg" } }] },
        { role: "model", parts: [{ text: "saw it" }] },
      ]);
      const sock = makeSocket();
      await withLang("en", () =>
        geminiCommand.execute(
          sock,
          makeMessage(chatId, "!ai again"),
          ["again"],
          "!ai again",
          null,
          {
            invokedName: "ai",
          },
        ),
      );
      equal("file expiry retries once", fake.requests.length, 2);
      const second = JSON.stringify(fake.body(1)?.contents || []);
      ok(
        "retry dropped the file part",
        !second.includes("fileData") && !second.includes("sentfile1"),
      );
      ok(
        "the recovered answer was delivered",
        (sock.sent.at(-1)?.text || "").includes("recovered without the file"),
      );
    },
  );
}

section("a tool that already ran is not executed again when the provider returns 404");
{
  const scheduler = harnessRequire("./scheduler.cjs");
  const realScheduleJobNow = scheduler.scheduleJobNow;
  let reminders = 0;
  scheduler.scheduleJobNow = () => {
    reminders += 1;
    return { ok: true };
  };
  const fileUri = "https://generativelanguage.googleapis.com/v1beta/files/sentfile1";
  try {
    await withGeminiServer(
      [
        functionCallReply([
          { name: "create_reminder", args: { message: "stand up", in_minutes: 5 } },
        ]),
        errorReply(404, `File ${fileUri} not found`),
        textReply("must not rerun"),
      ],
      async (fake) => {
        const chatId = OWNER;
        store.deleteChatHistory(chatId);
        store.saveChatHistory(chatId, [
          {
            role: "user",
            parts: [{ text: "photo", fileData: { fileUri, mimeType: "image/jpeg" } }],
          },
          { role: "model", parts: [{ text: "noted" }] },
        ]);
        const sock = makeSocket();
        await withLang("en", () =>
          geminiCommand.execute(
            sock,
            makeMessage(chatId, "!ai remind me"),
            ["remind", "me"],
            "!ai remind me",
            null,
            { invokedName: "ai" },
          ),
        );
        equal("initial request plus the tool result, and no rerun", fake.requests.length, 2);
        equal("create_reminder ran once", reminders, 1);
      },
    );
  } finally {
    scheduler.scheduleJobNow = realScheduleJobNow;
  }
}

section("a tool failure does not send the provider body to the model or the chat");
{
  const { TOOLS } = harnessRequire("./src/services/aiTools.cjs");
  const original = TOOLS.calculate.run;
  const leak = "sk-FAKEKEY999 https://evil.example/leak?key=sk-FAKEKEY999 at run (/tmp/x.js:4:1)";
  TOOLS.calculate.run = async () => {
    throw new Error(leak);
  };
  try {
    await withGeminiServer(
      [
        functionCallReply([{ name: "calculate", args: { expression: "1+1" } }]),
        textReply("calculated"),
      ],
      async (fake) => {
        const chatId = "201000000184@s.whatsapp.net";
        const sock = makeSocket();
        await withLang("en", () =>
          geminiCommand.execute(
            sock,
            // "add" is the batch sub-command; any other word reaches the model.
            makeMessage(chatId, "!ai compute"),
            ["compute"],
            "!ai compute",
            null,
            { invokedName: "ai" },
          ),
        );
        equal("tool result was sent once", fake.requests.length, 2);
        const wire = JSON.stringify(fake.body(1) || {});
        ok("the fake key never reaches the model", !wire.includes("sk-FAKEKEY999"));
        ok("the leak URL never reaches the model", !wire.includes("evil.example"));
        ok(
          "the model receives the fixed tool error",
          wire.includes("TOOL_FAILED") || wire.includes("could not complete"),
        );
        const chat = sock.sent.map((entry) => entry.text).join("\n");
        ok("the fake key never reaches the chat", !chat.includes("sk-FAKEKEY999"));
        ok("the leak URL never reaches the chat", !chat.includes("evil.example"));
      },
    );
  } finally {
    TOOLS.calculate.run = original;
  }
}

section("a short provider error never reaches the model or the chat");
{
  const { TOOLS } = harnessRequire("./src/services/aiTools.cjs");
  const original = TOOLS.calculate.run;
  const upstream = "Upstream session abc123";
  TOOLS.calculate.run = async () => {
    throw new Error(upstream);
  };
  try {
    await withGeminiServer(
      [
        functionCallReply([{ name: "calculate", args: { expression: "1+1" } }]),
        textReply("calculated"),
      ],
      async (fake) => {
        const chatId = "201000000186@s.whatsapp.net";
        const sock = makeSocket();
        await withLang("en", () =>
          geminiCommand.execute(
            sock,
            makeMessage(chatId, "!ai compute"),
            ["compute"],
            "!ai compute",
            null,
            { invokedName: "ai" },
          ),
        );
        equal("the short failure was sent back once", fake.requests.length, 2);
        const wire = JSON.stringify(fake.body(1) || {});
        ok("the short provider string never reaches the model", !wire.includes(upstream));
        ok(
          "the model receives the fixed tool error",
          wire.includes("TOOL_FAILED") || wire.includes("could not complete"),
        );
        const chat = sock.sent.map((entry) => entry.text).join("\n");
        ok("the short provider string never reaches the chat", !chat.includes(upstream));
      },
    );
  } finally {
    TOOLS.calculate.run = original;
  }
}

function storedHistory(chatId) {
  return q("SELECT history FROM ai_history WHERE chat_id = ?").get(chatId).history;
}

section("Invalid file format does not retry and leaves stored history byte-exact");
{
  const fileUri = "https://generativelanguage.googleapis.com/v1beta/files/sentfile1";
  await withGeminiServer(
    [errorReply(400, "Invalid file format"), textReply("must not retry")],
    async (fake) => {
      const chatId = "201000000187@s.whatsapp.net";
      store.saveChatHistory(chatId, [
        { role: "user", parts: [{ text: "look", fileData: { fileUri, mimeType: "image/jpeg" } }] },
        { role: "model", parts: [{ text: "saw it", thoughtSignature: "keep-format-sig" }] },
      ]);
      const before = storedHistory(chatId);
      const sock = makeSocket();
      await withLang("en", () =>
        geminiCommand.execute(
          sock,
          makeMessage(chatId, "!ai again"),
          ["again"],
          "!ai again",
          null,
          { invokedName: "ai" },
        ),
      );
      equal("Invalid file format is not retried", fake.requests.length, 1);
      equal("Invalid file format leaves stored history byte-exact", storedHistory(chatId), before);
      ok("the file URI is still stored", before.includes("sentfile1"));
      const chat = sock.sent.map((entry) => entry.text).join("\n");
      ok("Invalid file format is not quoted in the chat", !chat.includes("Invalid file format"));
    },
  );
}

section("a failed file retry leaves stored history byte-exact");
{
  const fileUri = "https://generativelanguage.googleapis.com/v1beta/files/sentfile1";
  await withGeminiServer(
    [errorReply(404, "file expired"), errorReply(500, "still broken")],
    async (fake) => {
      const chatId = "201000000188@s.whatsapp.net";
      store.saveChatHistory(chatId, [
        { role: "user", parts: [{ text: "look", fileData: { fileUri, mimeType: "image/jpeg" } }] },
        { role: "model", parts: [{ text: "saw it", thoughtSignature: "keep-retry-sig" }] },
      ]);
      const before = storedHistory(chatId);
      const sock = makeSocket();
      await withLang("en", () =>
        geminiCommand.execute(
          sock,
          makeMessage(chatId, "!ai again"),
          ["again"],
          "!ai again",
          null,
          { invokedName: "ai" },
        ),
      );
      equal("file expiry still retries once", fake.requests.length, 2);
      equal("a failed retry leaves stored history byte-exact", storedHistory(chatId), before);
      ok("the failed retry did not drop the file URI", before.includes(fileUri));
      const chat = sock.sent.map((entry) => entry.text).join("\n");
      ok("the retry failure body is not in the chat", !chat.includes("still broken"));
    },
  );
}

section("a gemini_model change during a pending turn stores no signature");
{
  const pendingSig = "pending-turn-sig-XYZ";
  await withGeminiServer(
    [
      () => {
        settings.set("gemini_model", "gemini-3.1-pro-preview");
        return functionCallReply([{ name: "get_datetime", args: {} }], {
          thoughtSignature: pendingSig,
        });
      },
      textReply("pending answer"),
    ],
    async (fake) => {
      const chatId = "201000000189@s.whatsapp.net";
      store.saveChatHistory(chatId, priorToolHistory("seed-sig-pending"));
      const sock = makeSocket();
      await withLang("en", () =>
        geminiCommand.execute(
          sock,
          makeMessage(chatId, "!ai while settings move"),
          ["while", "settings", "move"],
          "!ai while settings move",
          null,
          { invokedName: "ai" },
        ),
      );
      equal("the pending turn finished", fake.requests.length, 2);
      const raw = storedHistory(chatId);
      ok(
        "a signature issued after the model change is not stored",
        !raw.includes(pendingSig) && !raw.includes("thoughtSignature"),
      );
      ok("the seed signature is not stored either", !raw.includes("seed-sig-pending"));
      ok("the new answer is stored", raw.includes("pending answer"));
      ok("the function call is stored", raw.includes("functionCall"));
      ok(
        "the fingerprint does not contain the live API key",
        !geminiCommand.geminiSettingsFingerprint().includes(settings.get("gemini_api_key")),
      );
    },
  );
}

section("A to B to A during a pending turn stores no signature");
{
  const pendingSig = "aba-roundtrip-sig";
  let originalKey = "";
  await withGeminiServer(
    [
      () => {
        settings.set("gemini_model", "gemini-3.1-pro-preview");
        settings.set("gemini_api_key", "AIzaSyRotatedDuringTurn000");
        return functionCallReply([{ name: "get_datetime", args: {} }], {
          thoughtSignature: pendingSig,
        });
      },
      () => {
        settings.set("gemini_model", "gemini-3.7-flash");
        settings.set("gemini_api_key", originalKey);
        return {
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  {
                    text: "hidden-thought-aba",
                    thought: true,
                    thoughtSignature: "aba-thought-sig",
                  },
                  { text: "round trip answer", thoughtSignature: "aba-text-sig" },
                ],
              },
            },
          ],
        };
      },
    ],
    async (fake) => {
      originalKey = settings.get("gemini_api_key");
      const chatId = "201000000190@s.whatsapp.net";
      store.saveChatHistory(chatId, priorToolHistory("aba-seed-sig"));
      const sock = makeSocket();
      await withLang("en", () =>
        geminiCommand.execute(
          sock,
          makeMessage(chatId, "!ai round trip"),
          ["round", "trip"],
          "!ai round trip",
          null,
          { invokedName: "ai" },
        ),
      );
      equal("the round trip finished", fake.requests.length, 2);
      equal(
        "the first request uses the pinned model",
        fake.requests[0].url,
        "/v1beta/models/gemini-3.7-flash:generateContent",
      );
      equal(
        "the tool result uses the pinned model",
        fake.requests[1].url,
        "/v1beta/models/gemini-3.7-flash:generateContent",
      );
      equal(
        "the first request uses the pinned API key",
        fake.requests[0].headers["x-goog-api-key"],
        originalKey,
      );
      equal(
        "the tool result uses the pinned API key",
        fake.requests[1].headers["x-goog-api-key"],
        originalKey,
      );
      const raw = storedHistory(chatId);
      ok("the new call signature is not stored", !raw.includes(pendingSig));
      ok("the new text signature is not stored", !raw.includes("aba-text-sig"));
      ok("the thought signature field is not stored", !raw.includes("thoughtSignature"));
      ok("the seed signature is not stored", !raw.includes("aba-seed-sig"));
      ok("the thought part is not stored", !raw.includes("hidden-thought-aba"));
      ok("the answer is stored", raw.includes("round trip answer"));
      ok("the function call is stored", raw.includes("functionCall"));
    },
  );
}

section("a file-recovery retry uses the pinned model");
{
  const fileUri = "https://generativelanguage.googleapis.com/v1beta/files/sentfile1";
  let originalKey = "";
  await withGeminiServer(
    [
      () => {
        settings.set("gemini_model", "gemini-3.1-pro-preview");
        settings.set("gemini_api_key", "AIzaSyRotatedOnRetry00000");
        return errorReply(404, "file expired");
      },
      () => {
        settings.set("gemini_model", "gemini-3.7-flash");
        settings.set("gemini_api_key", originalKey);
        return {
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  {
                    text: "hidden-thought-retry",
                    thought: true,
                    thoughtSignature: "retry-thought-sig",
                  },
                  { text: "retry answer", thoughtSignature: "retry-text-sig" },
                ],
              },
            },
          ],
        };
      },
    ],
    async (fake) => {
      originalKey = settings.get("gemini_api_key");
      const chatId = "201000000191@s.whatsapp.net";
      store.saveChatHistory(chatId, [
        {
          role: "user",
          parts: [{ text: "look" }, { fileData: { fileUri, mimeType: "image/jpeg" } }],
        },
        {
          role: "model",
          parts: [
            {
              text: "private chain of thought",
              thought: true,
              thoughtSignature: "retry-seed-thought",
            },
            { text: "saw it", thoughtSignature: "retry-seed-sig" },
          ],
        },
      ]);
      const sock = makeSocket();
      await withLang("en", () =>
        geminiCommand.execute(
          sock,
          makeMessage(chatId, "!ai retry pinned"),
          ["retry", "pinned"],
          "!ai retry pinned",
          null,
          { invokedName: "ai" },
        ),
      );
      equal("file expiry still retries once on the pinned client", fake.requests.length, 2);
      equal(
        "the failed request uses the pinned model",
        fake.requests[0].url,
        "/v1beta/models/gemini-3.7-flash:generateContent",
      );
      equal(
        "the retry uses the pinned model",
        fake.requests[1].url,
        "/v1beta/models/gemini-3.7-flash:generateContent",
      );
      equal(
        "the retry uses the pinned API key",
        fake.requests[1].headers["x-goog-api-key"],
        originalKey,
      );
      const raw = storedHistory(chatId);
      ok("the retry signature is not stored", !raw.includes("retry-text-sig"));
      ok("the seed signature is not stored", !raw.includes("retry-seed-sig"));
      ok("thought parts are not stored", !raw.includes("private chain of thought"));
      ok("thoughtSignature is not stored", !raw.includes("thoughtSignature"));
      ok("the retry answer is stored", raw.includes("retry answer"));
      ok("the earlier answer text is stored", raw.includes("saw it"));
    },
  );
}

section("a turn with no gemini settings change keeps its signatures");
{
  const kept = "kept-turn-sig-XYZ";
  await withGeminiServer(
    [
      functionCallReply([{ name: "get_datetime", args: {} }], { thoughtSignature: kept }),
      textReply("kept answer"),
    ],
    async () => {
      const chatId = "201000000192@s.whatsapp.net";
      store.saveChatHistory(chatId, priorToolHistory("kept-seed-sig"));
      const sock = makeSocket();
      await withLang("en", () =>
        geminiCommand.execute(
          sock,
          makeMessage(chatId, "!ai keep signatures"),
          ["keep", "signatures"],
          "!ai keep signatures",
          null,
          { invokedName: "ai" },
        ),
      );
      const raw = storedHistory(chatId);
      ok("the new signature is stored", raw.includes(kept));
      ok("the seed signature is stored", raw.includes("kept-seed-sig"));
      ok("the answer is stored", raw.includes("kept answer"));
    },
  );
}

section("the gemini settings fingerprint hashes the key");
{
  const key = "AIzaSyFingerprintSecret_abc123";
  settings.set("gemini_api_key", key);
  settings.set("gemini_model", "gemini-3.7-flash");
  const fingerprint = geminiCommand.geminiSettingsFingerprint();
  ok("the fingerprint does not contain the key", !fingerprint.includes(key));
  ok("the fingerprint names the model", fingerprint.startsWith("gemini-3.7-flash\n"));
  equal(
    "the fingerprint is stable for the same settings",
    geminiCommand.geminiSettingsFingerprint(),
    fingerprint,
  );
  settings.set("gemini_model", "gemini-3.1-pro-preview");
  ok(
    "a model change moves the fingerprint",
    geminiCommand.geminiSettingsFingerprint() !== fingerprint,
  );
  settings.set("gemini_model", "gemini-3.7-flash");
}

finish();

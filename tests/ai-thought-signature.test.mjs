// Thought-signature lifecycle, one-shot recovery, memory batch stripping,
// provider/model provenance sanitization, and sanitized WhatsApp error cards.

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
const store = harnessRequire("./src/db/store.cjs");
const { q } = harnessRequire("./src/db/db.cjs");
const permissions = harnessRequire("./src/utils/permissions.cjs");
await permissions.primePermissions();
const aiAgent = harnessRequire("./src/services/aiAgent.cjs");
const geminiCommand = harnessRequire("./src/commands/gemini.cjs");
const { stripMemoryToolParts } = harnessRequire("./src/services/memoryPolicy.cjs");
const { withLang } = harnessRequire("./src/utils/i18n.cjs");
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
    equal("stored history records provider provenance", saved.provider, "gemini");
    equal("stored history records model provenance", saved.model, "gemini-3.7-flash");
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
  "history stored by openai provider is sanitized before first Gemini send; same provider+model replays signatures byte-exact",
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
  equal("stored history recorded openai provider", storedAfterOpenAI.provider, "openai");
  equal("stored history recorded openai model", storedAfterOpenAI.model, "gpt-5.4-mini");
  ok(
    "stored openai history contains unsigned canonical functionCall",
    JSON.stringify(storedAfterOpenAI).includes("functionCall"),
  );

  // Switch to Gemini: must sanitize before the very first send.
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
        "unsigned openai functionCall was stripped BEFORE the first Gemini send",
        !firstGeminiJson.includes("call_openai_1") && !firstGeminiJson.includes("functionCall"),
      );
      ok(
        "openai functionResponse was stripped BEFORE the first Gemini send",
        !firstGeminiJson.includes("functionResponse"),
      );
      equal(
        "plain user text from openai turn was kept",
        firstGeminiContents[0]?.parts?.[0]?.text,
        "check time on openai",
      );
      equal(
        "plain model text from openai turn was kept",
        firstGeminiContents[1]?.parts?.[0]?.text,
        "OpenAI answered with a tool",
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
      const replayCallTurn = replayContents.find((turn) =>
        (turn.parts || []).some((part) => part.functionCall),
      );
      ok("same provider and model replayed the prior tool turn unchanged", Boolean(replayCallTurn));
      equal(
        "replayed thoughtSignature is byte-exact",
        replayCallTurn?.parts?.[0]?.thoughtSignature,
        exactGeminiSig,
      );

      // Now change gemini_model: the next turn must sanitize history from the old model before sending.
      settings.set("gemini_model", "gemini-3.1-pro-preview");
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
        "changing gemini_model sanitized prior model's signed tool calls before first send",
        !afterModelChangeJson.includes(exactGeminiSig) &&
          !afterModelChangeJson.includes("functionCall"),
      );
      ok(
        "plain text turns survived the gemini_model change",
        afterModelChangeJson.includes("Gemini turn 2 done"),
      );
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
  equal("legacy array row has null provider (unknown)", legacyLoaded.provider, null);
  equal("legacy array row has null model (unknown)", legacyLoaded.model, null);
}

// ---------------------------------------------------------------------------
// 7. WhatsApp error text for each error class has no "{", no "INVALID_ARGUMENT", no API key fragment
// ---------------------------------------------------------------------------

section(
  "WhatsApp error text for every error class in all locales has no JSON, status token or key leak",
);
{
  const secretKey = "AIzaSySuperSecretKeyFragment998877";
  settings.set("gemini_api_key", secretKey);

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

        await withLang(locale, () =>
          geminiCommand.execute(
            sock,
            makeMessage(chatId, "!ai test error card"),
            ["test", "error", "card"],
            "!ai test error card",
            null,
            { invokedName: "ai" },
          ),
        );

        const text = sock.sent.at(-1)?.text || "";
        ok(`${expectedKind}/${locale}: error message sent`, text.length > 0);
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
    }
  }
}

finish();

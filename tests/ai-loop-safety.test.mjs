// Phase 07.5c: fake providers and sockets only. No network.
import { mock } from "node:test";
import { equal, finish, ok, require, section, useTempDataDir } from "./harness.mjs";

useTempDataDir("ai-loop-safety");
const settings = require("./src/config/settings.cjs");
const transport = require("./src/utils/providerUrl.cjs");
const originalFetch = transport.safeProviderFetch;
let fetchFake;
transport.safeProviderFetch = (...args) => fetchFake(...args);
const { runProviderAgent, historyToOpenAI } = require("./src/services/aiProviders.cjs");
const agent = require("./src/services/aiAgent.cjs");
const { TOOLS, runTool, runToolWithDeadline } = require("./src/services/aiTools.cjs");
const { resolveCaller } = require("./src/services/aiToolAuth.cjs");
const permissions = require("./src/utils/permissions.cjs");
await permissions.primePermissions();
const store = require("./src/db/store.cjs");
const hub = require("./src/utils/storage-hub.cjs");
const { withLang } = require("./src/utils/i18n.cjs");
const { timing } = await import("../src/utils/sendBotMessage.esm.js");
const originalSleep = timing.sleep;
timing.sleep = async () => {};
settings.set("bot_min_delay_ms", 0);
settings.set("bot_max_delay_ms", 0);
settings.set("openai_api_key", "secret-key-for-loop-tests");
settings.set("openai_base_url", "http://127.0.0.1:1/v1");
settings.set("anthropic_base_url", "http://127.0.0.1:1");
settings.set("ai_provider", "openai");
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const turn = () => new Promise((resolve) => setImmediate(resolve));
const socket = () => ({
  sent: [],
  async sendPresenceUpdate() {},
  async sendMessage(jid, content) {
    this.sent.push(content);
    return { key: { id: "out", remoteJid: jid } };
  },
});
const message = (jid) => ({
  key: { remoteJid: jid, id: "in", fromMe: true },
  message: { conversation: "!ai hello" },
});
const callerFor = (jid, sock) => resolveCaller({ msg: message(jid), sock });
const response = (payload, status = 200) => ({
  ok: status === 200,
  status,
  async json() {
    return payload;
  },
});

try {
  section("trailing unanswered calls are removed as whole turns");
  for (const id of [undefined, "openai-call"]) {
    const user = { role: "user", parts: [{ text: "hello" }] };
    const call = {
      role: "model",
      parts: [
        { text: "thinking", thoughtSignature: "keep-verbatim" },
        { functionCall: { name: "calculate", args: { expression: "2+2" }, ...(id ? { id } : {}) } },
      ],
    };
    const answer = {
      role: "user",
      parts: [
        {
          functionResponse: {
            name: "calculate",
            response: { result: 4 },
            ...(id ? { id } : {}),
          },
        },
      ],
    };
    const final = { role: "model", parts: [{ text: "4" }] };
    const completed = [user, call, answer, final];
    const before = JSON.stringify(completed);
    const repaired = agent.trimHistory([...completed, call]);
    equal("only the trailing unanswered model turn is removed", repaired.length, 4);
    equal("completed pairs remain byte-identical", JSON.stringify(repaired), before);
    ok(
      "kept turns and parts retain their identity",
      repaired.every((v, i) => v === completed[i]),
    );
    const wire = historyToOpenAI(repaired);
    for (let i = 0; i < wire.length; i++) {
      for (const tool of wire[i].tool_calls || []) {
        ok(
          "every OpenAI call has a tool message",
          wire.slice(i + 1).some((m) => m.role === "tool" && m.tool_call_id === tool.id),
        );
      }
    }
  }

  section("provider step budget output is repaired by runAgent");
  fetchFake = async () =>
    response({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "budget",
                type: "function",
                function: {
                  name: "calculate",
                  arguments: '{"expression":"2+2"}',
                },
              },
            ],
          },
        },
      ],
    });
  const budget = await agent.runAgent({ parts: [{ text: "hi" }], maxSteps: 0 });
  ok(
    "budget result has no trailing tool calls",
    !budget.history.at(-1)?.parts?.some((p) => p.functionCall),
  );

  section("shared tool deadline aborts late work");
  {
    const entered = deferred();
    const pending = deferred();
    let signal;
    TOOLS.__deadline = {
      declaration: { parameters: { properties: {} } },
      async run(_args, ctx) {
        signal = ctx.signal;
        entered.resolve();
        await pending.promise;
        return { aborted: signal.aborted };
      },
    };
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const work = runToolWithDeadline("__deadline", {}, {}, 50).catch((e) => e);
      await entered.promise;
      mock.timers.tick(50);
      const error = await work;
      ok("deadline returns a timeout", /longer|ثانية/.test(error.message));
      equal("underlying operation sees cancellation", signal.aborted, true);
      equal("abort reason is the timeout error", signal.reason, error);
      pending.resolve();
      await turn();
    } finally {
      pending.resolve();
      delete TOOLS.__deadline;
      mock.timers.reset();
    }
  }

  section("create_poll cannot send after a deadline in cooldown");
  {
    const out = socket();
    const jid = "201000001001@s.whatsapp.net";
    const caller = await callerFor(jid, out);
    await require("./src/utils/sendBotMessage.cjs").sendBotMessage(
      out,
      jid,
      { text: "prime" },
      { typing: false },
    );
    const entered = deferred();
    const pending = deferred();
    timing.sleep = () => {
      entered.resolve();
      return pending.promise;
    };
    settings.set("bot_min_delay_ms", 1000);
    settings.set("bot_max_delay_ms", 1000);
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const work = runToolWithDeadline(
        "create_poll",
        {
          question: "Pick",
          options: ["one", "two"],
        },
        { caller, sock: out },
        50,
      ).catch((e) => e);
      await entered.promise;
      mock.timers.tick(50);
      ok("poll deadline expires", (await work) instanceof Error);
      pending.resolve();
      await turn();
      equal("late poll never sends", out.sent.length, 1);
    } finally {
      pending.resolve();
      mock.timers.reset();
      timing.sleep = async () => {};
      settings.set("bot_min_delay_ms", 0);
      settings.set("bot_max_delay_ms", 0);
    }
  }

  section("provider deadline covers body consumption");
  for (const provider of ["openai", "anthropic"]) {
    settings.set(`${provider}_api_key`, "fake-provider-key");
    const entered = deferred();
    fetchFake = async (_url, { signal }) => ({
      ok: true,
      async json() {
        entered.resolve();
        return new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    });
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const work = runProviderAgent(provider, { parts: [{ text: "hi" }] }).catch((e) => e);
      await entered.promise;
      mock.timers.tick(120000);
      const error = await work;
      ok(`${provider}: stalled body throws timeout`, /timed out/.test(error.message));
    } finally {
      mock.timers.reset();
    }
  }

  section("secret redaction at provider and error-card boundaries");
  {
    const key = "abc123";
    settings.set("openai_api_key", key);
    fetchFake = async () =>
      response(
        {
          error: {
            message: `${key} Bearer remote-token ?key=query-token`,
          },
        },
        401,
      );
    const error = await runProviderAgent("openai", { parts: [{ text: "hi" }] }).catch((e) => e);
    ok(
      "provider error removes configured and patterned secrets",
      !/abc123|remote-token|query-token/.test(error.message),
    );
    equal("provider status is preserved", error.status, 401);
    const { redactSecrets } = require("./src/config/settings.cjs");
    settings.set("gemini_api_key", "abc");
    equal("values below four characters are ignored", redactSecrets("abc"), "abc");
    equal("six-character keys are redacted", redactSecrets(key), "[redacted]");
    settings.set("whatsapp_proxy_password", "a-different-secret-password");
    ok(
      "every secret setting is read live",
      !redactSecrets("a-different-secret-password").includes("different"),
    );
    for (const surface of ["status", "sendBotError"]) {
      const out = socket();
      await withLang("en", async () => {
        const err = new TypeError(`oops ${key} Bearer token-value ?key=query-value`);
        if (surface === "status") {
          const status = await require("./src/utils/statusMessage.cjs").createStatus(
            out,
            "201000001002@s.whatsapp.net",
            "thinking",
          );
          await status.fail(err, "Failed");
        } else {
          await require("./src/utils/sendBotMessage.cjs").sendBotError(
            out,
            "201000001003@s.whatsapp.net",
            err,
            "Failed",
            { typing: false },
          );
        }
      });
      const text = out.sent.at(-1)?.text || "";
      ok(
        `${surface}: card keeps name and lead`,
        text.includes("TypeError") && text.includes("Failed"),
      );
      ok(
        `${surface}: card hides secrets`,
        text.includes("[redacted]") && !/abc123|token-value|query-value/.test(text),
      );
    }
  }

  section("account changes prevent pending context-buffer insertions");
  {
    const router = require("./src/services/aiRouter.cjs");
    const realProvider = router.getProvider("openai");
    const command = require("./src/commands/gemini.cjs");
    const entered = deferred();
    const pending = deferred();
    const out = socket();
    const jid = "201000003001@s.whatsapp.net";
    router.registerProvider(
      "openai",
      Object.assign(Object.create(realProvider), {
        async prepareMedia(parts) {
          entered.resolve();
          await pending.promise;
          parts.push({ text: "old account media" });
        },
      }),
    );
    try {
      const msg = {
        ...message(jid),
        message: {
          imageMessage: { caption: "!ai add old account text", mimetype: "image/png" },
        },
      };
      const work = command.execute(out, msg, ["add", "old", "account", "text"], "!ai add");
      await entered.promise;
      store.advanceAccountEpoch();
      command.clearAllContextBuffers();
      pending.resolve();
      await work;
      await withLang("en", () => command.execute(out, message(jid), ["show"], "!ai show"));
      const text = out.sent.at(-1)?.text || "";
      ok("old context is not reinserted", !text.includes("old account"));
      ok("context buffer stays empty", /empty|nothing|add/i.test(text));
    } finally {
      pending.resolve();
      router.registerProvider("openai", realProvider);
    }
  }

  section("delayed command dispatch cannot adopt a fresh account epoch");
  {
    const router = require("./src/services/aiRouter.cjs");
    const realProvider = router.getProvider("openai");
    const command = require("./src/commands/gemini.cjs");
    const out = socket();
    const jid = "201000003002@s.whatsapp.net";
    const receivedEpoch = store.accountEpoch();
    store.advanceAccountEpoch();
    let providerCalls = 0;
    router.registerProvider(
      "openai",
      Object.assign(Object.create(realProvider), {
        async runTurn() {
          providerCalls += 1;
          return { text: "done", history: [{ role: "user", parts: [{ text: "stale" }] }] };
        },
      }),
    );
    try {
      await command.execute(out, message(jid), ["hello"], "!ai hello", null, {
        accountEpoch: receivedEpoch,
      });
      equal("old dispatch epoch never calls the provider", providerCalls, 0);
      equal("delayed dispatch cannot save history", (await hub.getChatHistoryAsync(jid)).length, 0);
      equal(
        "delayed dispatch cannot write memory",
        require("./src/utils/memory.cjs").listMemory({ scope: "chat", chatId: jid }).length,
        0,
      );
    } finally {
      router.registerProvider("openai", realProvider);
    }
  }

  section("history deletion and account changes fence pending completions");
  {
    const router = require("./src/services/aiRouter.cjs");
    const realProvider = router.getProvider("openai");
    const command = require("./src/commands/gemini.cjs");
    for (const action of ["del", "delall", "epoch", "file-retry"]) {
      const out = socket();
      const index = ["del", "delall", "epoch", "file-retry"].indexOf(action);
      const jid = `20100000200${index}@s.whatsapp.net`;
      const entered = deferred();
      const pending = deferred();
      await hub.saveChatHistoryAsync(jid, [{ role: "user", parts: [{ text: "old" }] }]);
      router.registerProvider(
        "openai",
        Object.assign(Object.create(realProvider), {
          async runTurn() {
            entered.resolve();
            await pending.promise;
            if (action === "file-retry") {
              throw Object.assign(new Error("file expired"), { status: 410 });
            }
            return { text: "done", history: [{ role: "user", parts: [{ text: "stale" }] }] };
          },
        }),
      );
      try {
        const work = command.execute(out, message(jid), ["hello"], "!ai hello");
        await entered.promise;
        if (action === "epoch" || action === "file-retry") {
          store.advanceAccountEpoch();
          await hub.deleteChatHistoryAsync(jid);
        } else {
          await command.execute(out, message(jid), [], `!${action}`, null, { invokedName: action });
        }
        pending.resolve();
        await work;
        equal(
          `${action}: pending run cannot restore deleted history`,
          (await hub.getChatHistoryAsync(jid)).length,
          0,
        );
      } finally {
        pending.resolve();
        router.registerProvider("openai", realProvider);
      }
    }
  }
} finally {
  mock.timers.reset();
  timing.sleep = originalSleep;
  transport.safeProviderFetch = originalFetch;
}
finish();

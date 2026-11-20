import { equal, finish, ok, require, section, throws, useTempDataDir } from "./harness.mjs";

useTempDataDir("levix-extensions-host");

const store = require("./src/db/store.cjs");
const { createExtensionHost } = require("./src/extensions/host.cjs");

const silent = {
  child() {
    return silent;
  },
  info() {},
  warn() {},
  error() {},
  debug() {},
};

function fakeEntitlement(initial = false) {
  let active = initial;
  const listeners = new Set();
  return {
    isActive: () => active,
    status() {
      return { state: active ? "active" : "none", until: null, reason: null };
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    start() {
      return () => {};
    },
    setActive(next) {
      active = next;
      const snap = this.status();
      for (const fn of listeners) fn(snap);
    },
  };
}

function handlers(extra = {}) {
  return {
    templates: { resolve: () => null },
    watermark: { hide: () => false },
    progress: { hide: () => false },
    autoReply: { scope: () => [], consider: async () => ({ reply: false }) },
    panelApi: { handle: async () => ({ status: 200, body: {} }) },
    ...extra,
  };
}

function validMod(overrides = {}) {
  return {
    apiVersion: 1,
    id: "levix-plus",
    version: "1.0.0",
    requiresEntitlement: "plus",
    capabilities: ["templates", "watermark", "progress", "autoReply", "panelApi"],
    async activate() {
      return handlers();
    },
    async deactivate() {},
    onAccountReset() {},
    ...overrides,
  };
}

function makeHost({ entitlement, loadModule, plusEnabled = true, ...rest } = {}) {
  return createExtensionHost({
    entitlement: entitlement || fakeEntitlement(false),
    loadModule: loadModule || (() => null),
    settingsGet: (key) => (key === "plus_enabled" ? plusEnabled : true),
    log: silent,
    now: () => Date.now(),
    pollMs: 60_000,
    ...rest,
  });
}

section("absent module is Free");
{
  const host = makeHost({ loadModule: () => null });
  await host.start();
  equal("state", host.status().state, "absent");
  equal("templateFor", host.templateFor("bot.help.title", "en"), null);
  equal("hideWatermark", host.hideWatermark({ command: "ping" }), false);
  equal("hideProgress", host.hideProgress({ command: "gemini" }), false);
  const panel = await host.handlePanel("GET", "/", {}, null);
  equal("panel 409", panel.status, 409);
  await host.stop();
}

section("valid fake, no entitlement: inactive, Free hooks");
{
  const host = makeHost({
    entitlement: fakeEntitlement(false),
    loadModule: () => validMod(),
  });
  await host.start();
  equal("state", host.status().state, "inactive");
  equal("templateFor", host.templateFor("bot.help.title", "en"), null);
  equal("hideWatermark", host.hideWatermark({}), false);
  equal("hideProgress", host.hideProgress({}), false);
  await host.stop();
}

section("entitlement active: hooks applied");
{
  const entitlement = fakeEntitlement(true);
  const host = makeHost({
    entitlement,
    loadModule: () =>
      validMod({
        async activate() {
          return handlers({
            templates: { resolve: (key) => (key === "bot.help.title" ? "PLUS {name}" : null) },
            watermark: { hide: () => true },
            progress: { hide: () => true },
          });
        },
      }),
  });
  await host.start();
  equal("state", host.status().state, "active");
  equal("generation", host.generation() > 0, true);
  equal("templateFor", host.templateFor("bot.help.title", "en"), "PLUS {name}");
  equal("hideWatermark", host.hideWatermark({ command: "weather" }), true);
  equal("hideProgress", host.hideProgress({ command: "gemini" }), true);
  const panel = await host.handlePanel("GET", "/x", {}, null);
  equal("panel 200", panel.status, 200);
  await host.stop();
}

section("entitlement lost: deactivate, signal aborted, Free hooks");
{
  const entitlement = fakeEntitlement(true);
  let deactivated = null;
  let signal;
  const host = makeHost({
    entitlement,
    loadModule: () =>
      validMod({
        async activate(ctx) {
          signal = ctx.signal;
          return handlers();
        },
        async deactivate(reason) {
          deactivated = reason;
        },
      }),
  });
  await host.start();
  equal("active first", host.status().state, "active");
  ok("signal live", signal && signal.aborted === false);
  entitlement.setActive(false);
  await host.start();
  equal("inactive after loss", host.status().state, "inactive");
  equal("deactivate reason", deactivated, "entitlement");
  equal("signal aborted", signal.aborted, true);
  equal("watermark Free", host.hideWatermark({}), false);
  equal("progress Free", host.hideProgress({}), false);
  equal("template Free", host.templateFor("bot.help.title", "en"), null);
  await host.stop();
}

section("incompatible apiVersion");
{
  const host = makeHost({
    entitlement: fakeEntitlement(true),
    loadModule: () => validMod({ apiVersion: 2 }),
  });
  await host.start();
  equal("state", host.status().state, "incompatible");
  equal("hooks Free", host.hideWatermark({}), false);
  await host.stop();
}

section("undeclared handler");
{
  const host = makeHost({
    entitlement: fakeEntitlement(true),
    loadModule: () =>
      validMod({
        capabilities: ["templates"],
        async activate() {
          return {
            templates: { resolve: () => null },
            watermark: { hide: () => true },
          };
        },
      }),
  });
  await host.start();
  equal("not active", host.status().state, "inactive");
  equal("watermark Free", host.hideWatermark({}), false);
  await host.stop();
}

section("throwing activate");
{
  const host = makeHost({
    entitlement: fakeEntitlement(true),
    loadModule: () =>
      validMod({
        async activate() {
          throw new Error("nope");
        },
      }),
  });
  await host.start();
  equal("not active", host.status().state, "inactive");
  await host.stop();
}

section("slow activate hits deadline");
{
  const host = makeHost({
    entitlement: fakeEntitlement(true),
    activateTimeoutMs: 40,
    loadModule: () =>
      validMod({
        activate() {
          return new Promise(() => {});
        },
      }),
  });
  await host.start();
  equal("not active", host.status().state, "inactive");
  await host.stop();
}

section("throwing sync hook falls back");
{
  const host = makeHost({
    entitlement: fakeEntitlement(true),
    loadModule: () =>
      validMod({
        async activate() {
          return handlers({
            watermark: {
              hide() {
                throw new Error("hook");
              },
            },
            progress: {
              hide() {
                throw new Error("hook");
              },
            },
            templates: {
              resolve() {
                throw new Error("hook");
              },
            },
          });
        },
      }),
  });
  await host.start();
  equal("active", host.status().state, "active");
  equal("watermark fallback", host.hideWatermark({}), false);
  equal("progress fallback", host.hideProgress({}), false);
  equal("template fallback", host.templateFor("bot.help.title", "en"), null);
  await host.stop();
}

section("circuit breaker after 5 failures");
{
  let deactivated = null;
  let signal;
  const host = makeHost({
    entitlement: fakeEntitlement(true),
    loadModule: () =>
      validMod({
        async activate(ctx) {
          signal = ctx.signal;
          return handlers({
            watermark: {
              hide() {
                throw new Error("hook");
              },
            },
          });
        },
        async deactivate(reason) {
          deactivated = reason;
        },
      }),
  });
  await host.start();
  for (let i = 0; i < 5; i++) host.hideWatermark({});
  await new Promise((resolve) => setTimeout(resolve, 40));
  equal("failed", host.status().state, "failed");
  equal("deactivate failure", deactivated, "failure");
  equal("signal aborted", signal.aborted, true);
  equal("hooks Free", host.hideWatermark({}), false);
  await host.stop();
}

section("plus_enabled off");
{
  let enabled = true;
  let deactivated = null;
  const entitlement = fakeEntitlement(true);
  const host = createExtensionHost({
    entitlement,
    loadModule: () =>
      validMod({
        async deactivate(reason) {
          deactivated = reason;
        },
      }),
    settingsGet: (key) => (key === "plus_enabled" ? enabled : true),
    log: silent,
    pollMs: 60_000,
  });
  await host.start();
  equal("active while on", host.status().state, "active");
  enabled = false;
  await host.start();
  equal("disabled", host.status().state, "disabled");
  equal("reason", deactivated, "disabled");
  equal("hooks Free", host.hideWatermark({}), false);
  await host.stop();
}

section("accountReset wipes accountStorage and calls onAccountReset");
{
  let resetReason = null;
  let ctx;
  const host = makeHost({
    entitlement: fakeEntitlement(true),
    loadModule: () =>
      validMod({
        async activate(c) {
          ctx = c;
          c.accountStorage.set("pref", { n: 1 });
          return handlers();
        },
        onAccountReset(reason) {
          resetReason = reason;
        },
      }),
  });
  await host.start();
  equal("stored", ctx.accountStorage.get("pref").n, 1);
  host.accountReset("unlink");
  equal("wiped", ctx.accountStorage.get("pref"), undefined);
  equal("onAccountReset", resetReason, "unlink");
  equal("row gone", store.getExtStorage("levix-plus", "acct", "pref"), undefined);
  await host.stop();
}

section("stop() calls deactivate(shutdown)");
{
  let deactivated = null;
  const host = makeHost({
    entitlement: fakeEntitlement(true),
    loadModule: () =>
      validMod({
        async deactivate(reason) {
          deactivated = reason;
        },
      }),
  });
  await host.start();
  await host.stop();
  equal("shutdown", deactivated, "shutdown");
}

section("every paid entry checks entitlement expiry and the switch without reconciliation");
for (const loss of ["expiry", "disabled"]) {
  for (const entry of [
    "templateFor",
    "hideWatermark",
    "hideProgress",
    "dispatchAutoReply",
    "handlePanel",
  ]) {
    let entitled = true;
    let enabled = true;
    let calls = 0;
    const host = makeHost({
      entitlement: { isActive: () => entitled },
      settingsGet: () => enabled,
      loadModule: () =>
        validMod({
          async activate() {
            return handlers({
              templates: {
                resolve: () => {
                  calls += 1;
                  return "PLUS {name}";
                },
              },
              watermark: {
                hide: () => {
                  calls += 1;
                  return true;
                },
              },
              progress: {
                hide: () => {
                  calls += 1;
                  return true;
                },
              },
              autoReply: {
                scope: () => [],
                consider: async () => {
                  calls += 1;
                  return {};
                },
              },
              panelApi: {
                handle: async () => {
                  calls += 1;
                  return { status: 200 };
                },
              },
            });
          },
        }),
    });
    await host.start();
    if (loss === "expiry") entitled = false;
    else enabled = false;
    equal(`${loss}/${entry} starts with cached active state`, host.status().state, "active");
    if (entry === "templateFor")
      equal("template Free", host.templateFor("bot.help.title", "en"), null);
    else if (entry === "handlePanel")
      equal("panel inactive", (await host.handlePanel("GET", "/", {})).status, 409);
    else if (entry === "dispatchAutoReply") {
      const autoReply = require("./src/extensions/autoReply.cjs");
      const originalDispatch = autoReply.dispatch;
      autoReply.dispatch = async () => {
        calls += 1;
      };
      try {
        await host.dispatchAutoReply({}, {}, 0);
      } finally {
        autoReply.dispatch = originalDispatch;
      }
    } else equal("hide hook Free", host[entry]({}), false);
    equal(`${loss}/${entry} never enters a paid handler`, calls, 0);
    // The live check itself schedules this; no explicit reconcile is requested.
    await new Promise((resolve) => setImmediate(resolve));
    equal(
      `${loss}/${entry} schedules reconciliation`,
      host.status().state,
      loss === "expiry" ? "inactive" : "disabled",
    );
    await host.stop();
  }
}

section("activation cannot publish handlers after entitlement or switch loss");
for (const loss of ["entitlement", "disabled"]) {
  let entitled = true;
  let enabled = true;
  let signal;
  let deactivated;
  const host = makeHost({
    entitlement: { isActive: () => entitled },
    settingsGet: () => enabled,
    loadModule: () =>
      validMod({
        async activate(ctx) {
          signal = ctx.signal;
          await Promise.resolve();
          if (loss === "entitlement") entitled = false;
          else enabled = false;
          return handlers();
        },
        async deactivate(reason) {
          deactivated = reason;
        },
      }),
  });
  await host.start();
  equal(
    `${loss}: never active`,
    host.status().state,
    loss === "disabled" ? "disabled" : "inactive",
  );
  equal(`${loss}: generation aborted`, signal.aborted, true);
  equal(`${loss}: runtime deactivated`, deactivated, loss);
  await host.stop();
}

section("accountStorage wipe errors propagate after in-memory abort");
{
  const autoReply = require("./src/extensions/autoReply.cjs");
  const originalAbort = autoReply.abortAccountJobs;
  const originalWipe = store.wipeExtStorage;
  const order = [];
  const failure = new Error("disk full");
  const host = makeHost();
  try {
    autoReply.abortAccountJobs = () => {
      order.push("abort");
    };
    store.wipeExtStorage = () => {
      order.push("wipe");
      throw failure;
    };
    equal(
      "same wipe error reaches caller",
      throws("required wipe throws", () => host.accountReset("unlink")),
      failure,
    );
    equal("abort comes before failed wipe", order.join(","), "abort,wipe");
  } finally {
    autoReply.abortAccountJobs = originalAbort;
    store.wipeExtStorage = originalWipe;
    await host.stop();
  }
}

section("panel deadline aborts the request and request/generation signals are combined");
for (const cancellation of ["deadline", "request", "generation"]) {
  let passedSignal;
  let entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const request = new AbortController();
  const host = makeHost({
    entitlement: fakeEntitlement(true),
    panelTimeoutMs: 40,
    loadModule: () =>
      validMod({
        async activate() {
          return handlers({
            panelApi: {
              handle(_method, _path, _body, { signal }) {
                passedSignal = signal;
                entered();
                return new Promise(() => {});
              },
            },
          });
        },
      }),
  });
  await host.start();
  const response = host.handlePanel("GET", "/preview", {}, request.signal);
  await ready;
  equal(`${cancellation}: initially live`, passedSignal.aborted, false);
  if (cancellation === "request") request.abort();
  if (cancellation === "generation") await host.stop();
  const result = await response;
  equal(`${cancellation}: handler sees abort`, passedSignal.aborted, true);
  equal(`${cancellation}: no successful response`, result.status, 500);
  await host.stop();
}

section("scope invalidation aborts every pending and in-flight Auto Reply job");
{
  const autoReply = require("./src/extensions/autoReply.cjs");
  const chats = [
    "201111111111@s.whatsapp.net",
    "201222222222@s.whatsapp.net",
    "201333333333@s.whatsapp.net",
    "201444444444@s.whatsapp.net",
  ];
  const scope = new Set(chats);
  const turns = new Map();
  const signals = new Map();
  const sent = [];
  let ctx;
  let entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  let pendingEntered;
  let pendingCount = 0;
  const pendingReady = new Promise((resolve) => {
    pendingEntered = resolve;
  });
  let releasePending;
  let entitled = true;
  const pendingGate = new Promise((resolve) => {
    releasePending = resolve;
  });
  autoReply.resetAutoReplyDeps();
  autoReply.setAutoReplyDeps({
    accountEpoch: () => 1,
    isLinkedSelf: () => false,
    getMessageFromRecent: async () => undefined,
    settingsGet: () => 5000,
    resolveCaller: async ({ msg }) => ({
      chatId: msg.key.remoteJid,
      isGroup: false,
      isOwner: false,
    }),
    runAgent: ({ context }) =>
      new Promise((resolve) => {
        turns.set(context.chatId, { context, resolve });
        if (turns.size === 2) entered();
      }),
    sendBotMessage: async (_sock, jid, _content, options) => {
      await options.deliveryGuard.refresh();
      options.deliveryGuard.assert();
      sent.push(jid);
    },
  });
  const host = makeHost({
    entitlement: { isActive: () => entitled },
    loadModule: () =>
      validMod({
        async activate(context) {
          ctx = context;
          return handlers({
            autoReply: {
              scope: () => scope,
              consider(event, { signal }) {
                signals.set(event.chatJid, signal);
                if (event.chatJid === chats[2] || event.chatJid === chats[3]) {
                  if (++pendingCount === 2) pendingEntered();
                  return pendingGate;
                }
                return { reply: true };
              },
            },
          });
        },
      }),
  });
  try {
    await host.start();
    const dispatch = (jid) =>
      host.dispatchAutoReply(
        {},
        {
          key: { remoteJid: jid, id: "scope", fromMe: false },
          message: { conversation: "hello" },
        },
        1,
      );
    const first = dispatch(chats[0]);
    const second = dispatch(chats[1]);
    await ready;
    const third = dispatch(chats[2]);
    const fourth = dispatch(chats[3]);
    await pendingReady;
    scope.delete(chats[0]);
    scope.delete(chats[2]);
    ctx.invalidateScope();
    equal("removed in-flight turn aborted", turns.get(chats[0]).context.signal.aborted, true);
    equal("retained in-flight chat also aborted", turns.get(chats[1]).context.signal.aborted, true);
    equal("removed pending consideration aborted", signals.get(chats[2]).aborted, true);
    equal("retained pending consideration also aborted", signals.get(chats[3]).aborted, true);
    turns.get(chats[0]).resolve({ text: "late" });
    turns.get(chats[1]).resolve({ text: "kept" });
    releasePending({ reply: true });
    await Promise.all([first, second, third, fourth]);
    equal("no stale memory decision delivers", sent.length, 0);

    let releaseTurn;
    autoReply.setAutoReplyDeps({
      runAgent: async ({ context }) => {
        scope.clear();
        ctx.invalidateScope();
        releaseTurn = context.signal.aborted;
        return { text: "after kill switch" };
      },
    });
    await host.dispatchAutoReply(
      {},
      {
        key: { remoteJid: chats[1], id: "kill", fromMe: false },
        message: { conversation: "hello" },
      },
      1,
    );
    equal("kill switch aborts an admitted turn", releaseTurn, true);
    equal("kill switch prevents delivery", sent.length, 0);

    scope.add(chats[1]);
    ctx.invalidateScope();
    autoReply.setAutoReplyDeps({
      runAgent: async ({ context }) => {
        entitled = false;
        equal("expiry has no abort notification yet", context.signal.aborted, false);
        return { text: "after expiry" };
      },
    });
    await host.dispatchAutoReply(
      {},
      {
        key: { remoteJid: chats[1], id: "expiry", fromMe: false },
        message: { conversation: "hello" },
      },
      1,
    );
    equal("runtime final guard checks live entitlement", sent.length, 0);
  } finally {
    await host.stop();
    autoReply.resetAutoReplyDeps();
  }
}

section("host subscribers observe real state changes and isolate listener failures");

{
  const entitlement = fakeEntitlement(false);
  let activations = 0;
  let finishActivation;
  let activationEntered;
  const entered = new Promise((resolve) => {
    activationEntered = resolve;
  });
  const host = makeHost({
    entitlement,
    loadModule: () =>
      validMod({
        activate() {
          activations += 1;
          if (activations > 1) return handlers();
          activationEntered();
          return new Promise((resolve) => {
            finishActivation = () => resolve(handlers());
          });
        },
      }),
  });
  const changes = [];
  let throwingCalls = 0;
  const unsubscribeThrowing = host.subscribe(() => {
    throwingCalls += 1;
    throw new Error("listener failed");
  });
  const unsubscribe = host.subscribe(() => changes.push(host.status().state));
  try {
    equal("subscribe does not emit an initial state", changes.length, 0);
    await host.start();
    equal("inactive transition emits once", changes.join(","), "inactive");
    await host.start();
    equal("unchanged inactive state emits nothing", changes.length, 1);
    entitlement.setActive(true);
    await entered;
    equal("pending activation keeps inactive state", host.status().state, "inactive");
    equal("pending activation emits nothing", changes.length, 1);
    finishActivation();
    await host.start();
    equal("throwing listener does not stop activation", host.status().state, "active");
    equal("activation emits once after completion", changes.join(","), "inactive,active");
    equal("throwing listener receives both transitions", throwingCalls, 2);
    entitlement.setActive(true);
    await host.start();
    equal("unchanged active state emits nothing", changes.length, 2);
    entitlement.setActive(false);
    await host.start();
    equal("deactivation emits once", changes.join(","), "inactive,active,inactive");
    unsubscribe();
    unsubscribeThrowing();
    entitlement.setActive(true);
    await host.start();
    equal("activation still completes after unsubscribe", host.status().state, "active");
    equal("unsubscribe stops notifications", changes.length, 3);
    equal("throwing listener is also removed", throwingCalls, 3);
  } finally {
    unsubscribe();
    unsubscribeThrowing();
    await host.stop();
  }
}

section("host advertises scopeDescriptor capability and accepts array or descriptor scopes");
{
  const autoReply = require("./src/extensions/autoReply.cjs");
  const PRIVATE_UNLISTED = "201555555555@s.whatsapp.net";
  const PRIVATE_EXCLUDED = "201666666666@s.whatsapp.net";
  const GROUP_JID = "120363000000000099@g.us";
  let currentScopeValue = [PRIVATE_UNLISTED];
  let seenCtx = null;
  let considered = [];
  const sent = [];

  autoReply.resetAutoReplyDeps();
  autoReply.setAutoReplyDeps({
    accountEpoch: () => 1,
    isLinkedSelf: () => false,
    getMessageFromRecent: async () => undefined,
    settingsGet: () => 5000,
    resolveCaller: async ({ msg }) => ({
      chatId: msg.key.remoteJid,
      isGroup: msg.key.remoteJid.endsWith("@g.us"),
      isOwner: false,
    }),
    runAgent: async () => ({ text: "reply" }),
    groupMetadataCache: {
      resolveGroupMetadata: async () => ({ id: GROUP_JID, participants: [] }),
      getRosterVersion: () => "0:0",
      isRosterStale: () => false,
    },
    sendBotMessage: async (_sock, jid, _content, options) => {
      await options.deliveryGuard.refresh();
      options.deliveryGuard.assert();
      sent.push(jid);
    },
  });

  const host = makeHost({
    entitlement: fakeEntitlement(true),
    loadModule: () =>
      validMod({
        async activate(ctx) {
          seenCtx = ctx;
          return handlers({
            autoReply: {
              scope: () => currentScopeValue,
              consider: async (event) => {
                considered.push(event.chatJid);
                return { reply: true };
              },
            },
          });
        },
      }),
  });

  const msgFor = (jid, id) => ({
    key: {
      remoteJid: jid,
      id,
      fromMe: false,
      ...(jid.endsWith("@g.us") ? { participant: PRIVATE_UNLISTED } : {}),
    },
    message: { conversation: "hello" },
  });

  try {
    await host.start();
    equal("ctx.autoReply.scopeDescriptor advertised", seenCtx?.autoReply?.scopeDescriptor, true);
    ok("ctx.autoReply frozen", Object.isFrozen(seenCtx?.autoReply));

    // 1. Legacy array treated as mode "only".
    await host.dispatchAutoReply({}, msgFor(PRIVATE_UNLISTED, "arr-1"), 1);
    await host.dispatchAutoReply({}, msgFor(PRIVATE_EXCLUDED, "arr-2"), 1);
    equal("array scope admits listed chat only", sent.join(","), PRIVATE_UNLISTED);

    // 2. Descriptor mode "all" with groupsEnabled false.
    sent.length = 0;
    considered = [];
    currentScopeValue = {
      mode: "all",
      groupsEnabled: false,
      chats: [],
      excluded: [],
    };
    seenCtx.invalidateScope();
    await host.dispatchAutoReply({}, msgFor(PRIVATE_EXCLUDED, "all-dm"), 1);
    await host.dispatchAutoReply({}, msgFor(GROUP_JID, "all-grp-off"), 1);
    equal("all mode admits unlisted private chat", sent.join(","), PRIVATE_EXCLUDED);
    equal("groupsEnabled false drops group in prefilter", considered.join(","), PRIVATE_EXCLUDED);

    // 3. Descriptor mode "except" with groupsEnabled true.
    sent.length = 0;
    considered = [];
    currentScopeValue = {
      mode: "except",
      groupsEnabled: true,
      chats: [],
      excluded: [PRIVATE_EXCLUDED],
    };
    seenCtx.invalidateScope();
    await host.dispatchAutoReply({}, msgFor(PRIVATE_EXCLUDED, "exc-dropped"), 1);
    await host.dispatchAutoReply({}, msgFor(PRIVATE_UNLISTED, "exc-dm"), 1);
    await host.dispatchAutoReply({}, msgFor(GROUP_JID, "exc-grp"), 1);
    equal(
      "except mode drops excluded chat and admits others",
      sent.join(","),
      `${PRIVATE_UNLISTED},${GROUP_JID}`,
    );

    // 4. Malformed descriptors fail closed to empty "only" (no replies).
    for (const [idx, malformed] of [
      null,
      undefined,
      "all",
      42,
      {},
      { mode: "everyone", groupsEnabled: true, chats: [], excluded: [] },
      { mode: "all", groupsEnabled: "true", chats: [], excluded: [] },
      { mode: "all", groupsEnabled: true, chats: [123], excluded: [] },
      { mode: "except", groupsEnabled: true, chats: [], excluded: [null] },
      { mode: "except", groupsEnabled: true, chats: [] },
      { mode: "only", groupsEnabled: true, excluded: [] },
      { mode: "all", groupsEnabled: true, chats: [], excluded: [], extra: true },
      [123],
      [""],
    ].entries()) {
      sent.length = 0;
      considered = [];
      currentScopeValue = malformed;
      seenCtx.invalidateScope();
      await host.dispatchAutoReply({}, msgFor(PRIVATE_UNLISTED, `mal-${idx}`), 1);
      equal(`malformed scope #${idx} prefilters out every chat`, considered.length, 0);
      equal(`malformed scope #${idx} sends nothing`, sent.length, 0);
    }

    // 5. Host dispatch applies alias matching in prefilter with mapped/unmapped LID chats.
    const PN_MAPPED = "201333333333@s.whatsapp.net";
    const LID_MAPPED = "333333@lid";
    const LID_UNMAPPED = "444444@lid";

    autoReply.setAutoReplyDeps({
      roleIdentityAliases: (jid) => {
        if (jid === PN_MAPPED || jid === LID_MAPPED) {
          return [jid, jid === PN_MAPPED ? LID_MAPPED : PN_MAPPED];
        }
        return [jid];
      },
    });

    // 5a. Phone exclusion blocks mapped LID form in host dispatch
    sent.length = 0;
    considered = [];
    currentScopeValue = {
      mode: "except",
      groupsEnabled: true,
      chats: [],
      excluded: [PN_MAPPED],
    };
    seenCtx.invalidateScope();
    await host.dispatchAutoReply({}, msgFor(LID_MAPPED, "exc-mapped-lid"), 1);
    equal("host prefilter: phone exclusion blocks mapped LID form", considered.length, 0);
    equal("host prefilter: no send for mapped LID form", sent.length, 0);

    // 5b. Phone exclusion blocks unmapped LID form (fail closed)
    await host.dispatchAutoReply({}, msgFor(LID_UNMAPPED, "exc-unmapped-lid"), 1);
    equal(
      "host prefilter: phone exclusion blocks unmapped LID (fail closed)",
      considered.length,
      0,
    );

    // 5c. "only" mode with phone entry admits mapped LID form
    sent.length = 0;
    considered = [];
    currentScopeValue = {
      mode: "only",
      groupsEnabled: false,
      chats: [PN_MAPPED],
      excluded: [],
    };
    seenCtx.invalidateScope();
    await host.dispatchAutoReply({}, msgFor(LID_MAPPED, "only-mapped-lid"), 1);
    equal(
      "host prefilter: only with phone entry admits mapped LID",
      considered.join(","),
      LID_MAPPED,
    );
    equal("host send for mapped LID", sent.length, 1);
  } finally {
    await host.stop();
    autoReply.resetAutoReplyDeps();
  }
}

finish();

import { equal, finish, ok, require, section, useTempDataDir } from "./harness.mjs";

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

finish();

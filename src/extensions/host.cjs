// Public extension host. Loads one optional Plus module, activates it only
// while entitlement is live and plus_enabled is on, and isolates every hook.

const { createRequire } = require("node:module");
const fs = require("node:fs");
const path = require("node:path");
const { API_VERSION, validateManifest, validateHandlers } = require("./contract.cjs");
const { isCustomizable, validateOverride } = require("./templateKeys.cjs");
const { buildContext } = require("./context.cjs");
const autoReply = require("./autoReply.cjs");
const { setTemplateOverride } = require("../utils/i18n.cjs");

const ACTIVATE_MS = 5000;
const DEACTIVATE_MS = 5000;
const CONSIDER_MS = 2000;
const PANEL_MS = 10_000;
const POLL_MS = 5000;
const FAILURE_WINDOW_MS = 60_000;
const FAILURE_LIMIT = 5;

function defaultLoadModule() {
  const file = path.join(
    require("../config/paths.cjs").assetPath(),
    "extensions/levix-plus/index.cjs",
  );
  if (!fs.existsSync(file)) return null;
  return createRequire(file)(file);
}

function withDeadline(promise, ms, abort) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        abort?.abort();
      } catch {}
      const err = new Error("deadline");
      err.code = "DEADLINE";
      reject(err);
    }, ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function createExtensionHost(opts = {}) {
  const entitlement = opts.entitlement || require("./entitlement/index.cjs");
  const loadModule = opts.loadModule || defaultLoadModule;
  const settingsGet = opts.settingsGet || ((key) => require("../config/settings.cjs").get(key));
  const log = opts.log || require("../utils/logger.cjs");
  const now = opts.now || (() => Date.now());
  const activateTimeoutMs = opts.activateTimeoutMs ?? ACTIVATE_MS;
  const deactivateTimeoutMs = opts.deactivateTimeoutMs ?? DEACTIVATE_MS;
  const considerTimeoutMs = opts.considerTimeoutMs ?? CONSIDER_MS;
  const panelTimeoutMs = opts.panelTimeoutMs ?? PANEL_MS;
  const pollMs = opts.pollMs ?? POLL_MS;
  const failureWindowMs = opts.failureWindowMs ?? FAILURE_WINDOW_MS;
  const failureLimit = opts.failureLimit ?? FAILURE_LIMIT;

  let state = "absent";
  let generation = 0;
  let running = false;
  let moduleLoaded;
  let incompatible = false;
  let handlers = null;
  let controller = null;
  let scopeSet = new Set();
  let unsub = null;
  let pollTimer = null;
  let chain = Promise.resolve();
  let lastEnabled = null;
  const failures = [];
  let didActivate = false;
  let liveReconcilePending = false;

  function plusEnabled() {
    try {
      return settingsGet("plus_enabled") !== false;
    } catch {
      return false;
    }
  }

  function schedule() {
    chain = chain.then(
      () => reconcileNow(),
      () => reconcileNow(),
    );
    return chain;
  }

  function isActive() {
    if (state !== "active") return false;
    let active = false;
    try {
      active = Boolean(entitlement.isActive?.("plus")) && plusEnabled();
    } catch {}
    if (!active && !liveReconcilePending) {
      liveReconcilePending = true;
      const settled = () => {
        liveReconcilePending = false;
      };
      schedule().then(settled, settled);
    }
    return active;
  }

  function recordFailure(error) {
    const t = now();
    failures.push(t);
    while (failures.length && t - failures[0] > failureWindowMs) failures.shift();
    try {
      log.warn?.({ err: error?.message || error }, "Plus extension failure");
    } catch {}
    if (failures.length >= failureLimit && state !== "failed") {
      tripFailed();
    }
  }

  function tripFailed() {
    const wasActive = state === "active" || didActivate;
    state = "failed";
    handlers = null;
    scopeSet = new Set();
    try {
      setTemplateOverride(null);
    } catch {}
    try {
      controller?.abort();
    } catch {}
    didActivate = false;
    if (wasActive && typeof moduleLoaded?.deactivate === "function") {
      Promise.resolve()
        .then(() => withDeadline(moduleLoaded.deactivate("failure"), deactivateTimeoutMs))
        .catch(() => {});
    }
  }

  function ensureLoaded() {
    if (moduleLoaded) return moduleLoaded;
    if (incompatible) return null;
    try {
      const mod = loadModule();
      if (!mod) return null;
      const check = validateManifest(mod);
      if (!check.ok) {
        incompatible = true;
        state = "incompatible";
        try {
          log.warn?.({ reason: check.reason }, "Plus extension rejected");
        } catch {}
        return null;
      }
      moduleLoaded = mod;
      return mod;
    } catch {
      incompatible = true;
      state = "incompatible";
      try {
        log.warn?.("Plus extension failed to load");
      } catch {}
      return null;
    }
  }

  function refreshScope() {
    scopeSet = new Set();
    const scopeFn = handlers?.autoReply?.scope;
    if (typeof scopeFn !== "function") return;
    try {
      const value = scopeFn();
      const list = value && typeof value[Symbol.iterator] === "function" ? value : [];
      for (const jid of list) {
        if (typeof jid === "string" && jid) scopeSet.add(jid);
      }
    } catch (error) {
      recordFailure(error);
    }
  }

  function invalidateScope() {
    autoReply.abortAccountJobs();
    refreshScope();
  }

  function runtimeView() {
    return {
      isActive,
      generation: () => generation,
      signal: () => controller?.signal,
      getScope: () => scopeSet,
      consider: (event, opts) => handlers?.autoReply?.consider?.(event, opts),
      considerTimeoutMs: () => considerTimeoutMs,
      recordFailure,
      log,
      now,
    };
  }

  async function activateNow(mod) {
    generation += 1;
    const gen = generation;
    try {
      controller?.abort();
    } catch {}
    controller = new AbortController();
    const ctx = buildContext({
      id: mod.id,
      signal: controller.signal,
      generation: gen,
      capabilities: mod.capabilities,
      log,
      invalidateScope,
      aiReply: (job) =>
        generation === gen
          ? autoReply.runAiReply(runtimeView(), job)
          : Promise.resolve({ sent: false }),
    });
    let returned;
    try {
      returned = await withDeadline(mod.activate(ctx), activateTimeoutMs, controller);
    } catch (error) {
      if (generation !== gen) return;
      try {
        controller.abort();
      } catch {}
      recordFailure(error);
      if (state !== "failed") state = "inactive";
      return;
    }
    if (generation !== gen || !running) return;
    const enabled = plusEnabled();
    if (!enabled || !entitlement.isActive?.("plus")) {
      handlers = returned;
      await deactivate(enabled ? "entitlement" : "disabled");
      return;
    }
    const check = validateHandlers(mod.capabilities, returned);
    if (!check.ok) {
      try {
        controller.abort();
      } catch {}
      recordFailure(check.reason);
      try {
        log.warn?.({ reason: check.reason }, "Plus extension handlers rejected");
      } catch {}
      if (state !== "failed") state = "inactive";
      return;
    }
    handlers = returned;
    refreshScope();
    setTemplateOverride((key, locale) => templateFor(key, locale));
    didActivate = true;
    state = "active";
  }

  async function deactivate(reason) {
    const mod = moduleLoaded;
    const hadHandlers = Boolean(handlers);
    handlers = null;
    scopeSet = new Set();
    didActivate = false;
    try {
      setTemplateOverride(null);
    } catch {}
    try {
      controller?.abort();
    } catch {}
    if (reason === "disabled") state = "disabled";
    else if (reason === "failure") state = "failed";
    else if (reason === "shutdown") state = moduleLoaded ? "inactive" : "absent";
    else state = "inactive";
    if (hadHandlers && typeof mod?.deactivate === "function") {
      try {
        await withDeadline(mod.deactivate(reason), deactivateTimeoutMs);
      } catch (error) {
        try {
          log.warn?.({ err: error?.message }, "Plus deactivate failed");
        } catch {}
      }
    }
  }

  async function reconcileNow() {
    if (!running) return;
    const enabled = plusEnabled();
    const enabledChanged = lastEnabled !== null && lastEnabled !== enabled;
    lastEnabled = enabled;
    if (enabledChanged) {
      failures.length = 0;
      if (state === "failed" && enabled) state = "inactive";
    }

    if (state === "failed" && enabled) return;

    const mod = ensureLoaded();
    if (incompatible) return;
    if (!mod) {
      state = "absent";
      return;
    }

    if (!enabled) {
      if (didActivate || handlers) await deactivate("disabled");
      else state = "disabled";
      return;
    }

    const entitled = Boolean(entitlement.isActive?.("plus"));
    if (!entitled) {
      if (didActivate || handlers) await deactivate("entitlement");
      else state = "inactive";
      return;
    }

    if (state === "active" && handlers) return;
    await activateNow(mod);
  }

  function templateFor(key, locale) {
    if (!isActive() || typeof handlers?.templates?.resolve !== "function") return null;
    if (!isCustomizable(key)) return null;
    try {
      const result = handlers.templates.resolve(key, locale);
      const check = validateOverride(key, result);
      if (!check.ok) return null;
      return result;
    } catch (error) {
      recordFailure(error);
      return null;
    }
  }

  function hideWatermark(meta) {
    if (!isActive() || typeof handlers?.watermark?.hide !== "function") return false;
    try {
      return handlers.watermark.hide(meta) === true;
    } catch (error) {
      recordFailure(error);
      return false;
    }
  }

  function hideProgress(meta) {
    if (!isActive() || typeof handlers?.progress?.hide !== "function") return false;
    try {
      return handlers.progress.hide(meta) === true;
    } catch (error) {
      recordFailure(error);
      return false;
    }
  }

  function dispatchAutoReply(sock, msg, epoch) {
    if (!isActive() || !handlers?.autoReply) return Promise.resolve();
    return autoReply.dispatch(runtimeView(), sock, msg, epoch).catch((error) => {
      try {
        log.error?.({ err: error }, "auto-reply dispatch failed");
      } catch {}
    });
  }

  async function handlePanel(method, pathName, body, signal) {
    if (!isActive()) return { status: 409, body: { error: "inactive" } };
    if (typeof handlers?.panelApi?.handle !== "function") {
      return { status: 404, body: { error: "not_found" } };
    }
    const requestAbort = new AbortController();
    const combinedSignal = AbortSignal.any(
      [signal, controller?.signal, requestAbort.signal].filter(Boolean),
    );
    try {
      combinedSignal.throwIfAborted();
      const result = await withDeadline(
        handlers.panelApi.handle(method, pathName, body, {
          signal: combinedSignal,
        }),
        panelTimeoutMs,
        requestAbort,
      );
      if (!result || typeof result.status !== "number") {
        return { status: 500, body: { error: "invalid" } };
      }
      return { status: result.status, body: result.body ?? {} };
    } catch (error) {
      recordFailure(error);
      return { status: 500, body: { error: "failed" } };
    }
  }

  function accountReset(reason) {
    const allowed =
      reason === "logged_out" || reason === "restore" || reason === "unlink" ? reason : "unlink";
    try {
      autoReply.abortAccountJobs();
    } catch {}
    const id = moduleLoaded?.id || "levix-plus";
    require("../db/store.cjs").wipeExtStorage(id, "acct");
    try {
      if (typeof moduleLoaded?.onAccountReset === "function") moduleLoaded.onAccountReset(allowed);
    } catch (error) {
      try {
        log.warn?.({ err: error?.message }, "Plus onAccountReset failed");
      } catch {}
    }
  }

  function start() {
    if (!running) {
      running = true;
      try {
        unsub = entitlement.subscribe?.(() => {
          schedule();
        });
      } catch {}
      pollTimer = setInterval(() => schedule(), Math.max(1000, pollMs));
      pollTimer.unref?.();
    }
    return schedule();
  }

  async function stop() {
    running = false;
    try {
      if (typeof unsub === "function") unsub();
    } catch {}
    unsub = null;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (didActivate || handlers) await deactivate("shutdown");
    else {
      try {
        controller?.abort();
      } catch {}
      try {
        setTemplateOverride(null);
      } catch {}
    }
  }

  return {
    start,
    stop,
    status() {
      return { state, generation };
    },
    accountReset,
    templateFor,
    hideWatermark,
    hideProgress,
    dispatchAutoReply,
    handlePanel,
    generation() {
      return generation;
    },
  };
}

const host = createExtensionHost();

module.exports = {
  API_VERSION,
  createExtensionHost,
  host,
  defaultLoadModule,
};

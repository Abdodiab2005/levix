// Levix Plus entitlement. The extension host reads isActive, status, subscribe
// and start. Claim, refresh and prepare are the panel. Free installs have no
// record and never call the verifier.

const { createInstallation } = require("./installation.cjs");
const { verifyToken } = require("./token.cjs");
const state = require("./state.cjs");
const client = require("./client.cjs");

const BACKOFF_MS = Object.freeze([60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000]);
const FIRST_REFRESH_MS = 60_000;
const TWELVE_H_MS = 12 * 60 * 60 * 1000;
const SIX_H_MS = 6 * 60 * 60 * 1000;
const ONE_H_MS = 60 * 60 * 1000;
const FIFTEEN_MIN_MS = 15 * 60 * 1000;
const MIN_SUCCESS_DELAY_MS = 60_000;
const MAX_TIMER_MS = 2 ** 31 - 1;
const ACTIVE = new Set(["active", "grace", "canceled"]);
const NONE = Object.freeze({ state: "none", until: null, reason: null });

function defaultSetTimer(fn, ms) {
  const timer = setTimeout(fn, ms);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}

function keysCacheKey(keys) {
  if (!Array.isArray(keys)) return "";
  return keys.map((k) => `${k?.keyId ?? ""}:${k?.publicKey ?? ""}`).join(",");
}

function rawRecordString(stored) {
  if (stored == null) return null;
  if (typeof stored === "string") return stored;
  try {
    return JSON.stringify(stored);
  } catch {
    return undefined;
  }
}

function wrapStorage(raw) {
  if (!raw) {
    return {
      getBotSetting: (...args) => require("../../db/store.cjs").getBotSetting(...args),
      saveBotSetting: (...args) => require("../../db/store.cjs").saveBotSetting(...args),
    };
  }
  return {
    getBotSetting(key, fallback = null) {
      if (typeof raw.getBotSetting === "function") return raw.getBotSetting(key, fallback);
      if (typeof raw.get === "function") {
        const value = raw.get(key);
        return value === undefined ? fallback : value;
      }
      return fallback;
    },
    saveBotSetting(key, value) {
      const cloned = value == null ? null : JSON.parse(JSON.stringify(value));
      if (typeof raw.saveBotSetting === "function") raw.saveBotSetting(key, cloned);
      else if (typeof raw.set === "function") raw.set(key, cloned);
    },
  };
}

function createEntitlement(deps = {}) {
  const storage = wrapStorage(deps.storage);
  const vault = deps.vault ?? require("../../config/vault.cjs");
  const installations = deps.installation ?? createInstallation({ storage, vault });
  const now = deps.now ?? deps.clock ?? (() => Date.now());
  const random = deps.random ?? Math.random;
  const randomBytes = deps.randomBytes ?? ((size) => require("node:crypto").randomBytes(size));
  const setTimer = deps.setTimer ?? defaultSetTimer;
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle));
  const listeners = new Set();
  const inFlightControllers = new Set();
  let memory = { record: null, hw: null, invalid: false, claims: null };
  let maxAcceptedSeq = null;
  let maxAcceptedJti = null;
  let cachedRawRecord = undefined;
  let cachedRawHw = undefined;
  let cachedInstallationId = undefined;
  let verifiedCache = null;
  let lastStatus = null;
  let lastHighWaterPersistMs = null;
  let notifying = false;
  let running = false;
  let refreshTimer = null;
  let expiryTimer = null;
  let flight = null;
  let failCount = 0;

  function trustedKeys() {
    if (Object.hasOwn(deps, "keys")) return Array.isArray(deps.keys) ? deps.keys : [];
    return require("./keys.cjs").TRUSTED_KEYS;
  }

  function isConfigured() {
    return trustedKeys().length > 0;
  }

  function clock() {
    const value = now();
    return Number.isSafeInteger(value) ? value : Date.now();
  }

  function installationView() {
    return installations.getInstallation();
  }

  function currentInstallationId() {
    try {
      return installationView()?.installationId ?? null;
    } catch {
      return null;
    }
  }

  function persist(record) {
    const pub = state.publicFields(record);
    storage.saveBotSetting(state.RECORD_KEY, pub);
    cachedRawRecord = rawRecordString(pub);
  }

  function persistHw(hw) {
    const sealed = state.sealHighWater(hw, vault);
    storage.saveBotSetting(state.HW_KEY, sealed);
    cachedRawHw = sealed;
  }

  function syncFromStorage(localNow, installationId = currentInstallationId()) {
    const stored = storage.getBotSetting(state.RECORD_KEY, null);
    const rawHw = storage.getBotSetting(state.HW_KEY, null);
    const rawRecord = rawRecordString(stored);
    if (
      cachedRawRecord !== undefined &&
      rawRecord !== undefined &&
      rawRecord === cachedRawRecord &&
      rawHw === cachedRawHw &&
      installationId === cachedInstallationId
    ) {
      return;
    }
    verifiedCache = null;
    cachedRawRecord = rawRecord;
    cachedRawHw = rawHw;
    cachedInstallationId = installationId;

    const openedHw = state.openHighWater(rawHw, vault);
    let hw = null;
    if (openedHw && openedHw.installationId === installationId) {
      hw = openedHw;
      if (maxAcceptedSeq == null || hw.maxSeq > maxAcceptedSeq) {
        maxAcceptedSeq = hw.maxSeq;
        maxAcceptedJti = hw.jti;
      }
      if (
        memory.hw &&
        memory.hw.installationId === hw.installationId &&
        memory.hw.maxSeq === hw.maxSeq &&
        memory.hw.jti === hw.jti &&
        memory.hw.highWaterMs > hw.highWaterMs
      ) {
        hw = { ...hw, highWaterMs: memory.hw.highWaterMs };
      }
    }

    if (stored == null) {
      const expectedRecord = rawHw != null || maxAcceptedSeq != null;
      memory = { record: null, hw, invalid: expectedRecord, claims: null };
      return;
    }
    if (!state.recordShape(stored) || typeof stored.token !== "string") {
      memory = { record: null, hw, invalid: true, claims: null };
      return;
    }
    const pub = state.publicFields(stored);
    if (hw) {
      pub.serverOffsetMs = hw.serverOffsetMs;
      pub.highWaterMs = hw.highWaterMs;
    }
    memory = { record: pub, hw, invalid: false, claims: null };
    if (lastHighWaterPersistMs == null) lastHighWaterPersistMs = localNow ?? clock();
  }

  function touchHighWater(localNow) {
    if (!memory.record || !memory.hw) return;
    const noted = state.noteHighWater(memory.hw, localNow, lastHighWaterPersistMs);
    memory.hw = noted.hw;
    memory.record = {
      ...memory.record,
      serverOffsetMs: memory.hw.serverOffsetMs,
      highWaterMs: memory.hw.highWaterMs,
    };
    lastHighWaterPersistMs = noted.lastPersistMs;
    if (noted.persisted) {
      persistHw(memory.hw);
      persist(memory.record);
    }
  }

  function judge() {
    const localNow = clock();
    const installationId = currentInstallationId();
    syncFromStorage(localNow, installationId);
    if (memory.invalid)
      return { state: "unverified", until: null, reason: "bad_record", claims: null };
    if (!memory.record) return { state: "none", until: null, reason: null, claims: null };
    const keysList = trustedKeys();
    const keysKey = keysCacheKey(keysList);
    if (
      !verifiedCache ||
      verifiedCache.token !== memory.record.token ||
      verifiedCache.installationId !== installationId ||
      verifiedCache.keysKey !== keysKey
    ) {
      verifiedCache = {
        token: memory.record.token,
        installationId,
        keysKey,
        result: verifyToken(memory.record.token, {
          keys: keysList,
          installationId,
          storedSeq: null,
          storedJti: null,
        }),
      };
    }
    const judged = state.evaluate(memory.record, localNow, {
      keys: keysList,
      installationId,
      hw: memory.hw,
      maxSeq: maxAcceptedSeq,
      maxJti: maxAcceptedJti,
      verified: verifiedCache.result,
    });
    if (judged.claims) {
      memory.claims = judged.claims;
      if (maxAcceptedSeq == null || judged.claims.seq > maxAcceptedSeq) {
        maxAcceptedSeq = judged.claims.seq;
        maxAcceptedJti = judged.claims.jti;
      }
      touchHighWater(localNow);
    }
    return judged;
  }

  function toPublic(judged) {
    return Object.freeze({
      state: judged?.state || "none",
      until: typeof judged?.until === "string" ? judged.until : null,
      reason: typeof judged?.reason === "string" ? judged.reason : null,
    });
  }

  function publish(judged) {
    const next = toPublic(judged);
    if (
      lastStatus &&
      lastStatus.state === next.state &&
      lastStatus.until === next.until &&
      lastStatus.reason === next.reason
    ) {
      return next;
    }
    const hadPrevious = lastStatus !== null;
    lastStatus = next;
    if (!hadPrevious && next.state === "none") return next;
    if (notifying) return next;
    notifying = true;
    try {
      for (const listener of [...listeners]) {
        try {
          listener(next);
        } catch {
          /* a subscriber cannot break the others */
        }
      }
    } finally {
      notifying = false;
    }
    return next;
  }

  function status() {
    try {
      return publish(judge());
    } catch {
      return publish({ state: "unverified", until: null, reason: "unavailable" });
    }
  }

  function isActive(name = "plus") {
    if (name !== "plus") return false;
    try {
      const judged = judge();
      publish(judged);
      return ACTIVE.has(judged.state) && judged.claims?.ent?.includes("plus") === true;
    } catch {
      return false;
    }
  }

  function subscribe(listener) {
    if (typeof listener !== "function") return () => {};
    if (lastStatus === null) {
      try {
        lastStatus = toPublic(judge());
      } catch {
        lastStatus = NONE;
      }
    }
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function clearRefreshTimer() {
    if (refreshTimer) clearTimer(refreshTimer);
    refreshTimer = null;
  }

  function clearExpiryTimer() {
    if (expiryTimer) clearTimer(expiryTimer);
    expiryTimer = null;
  }

  function armRefresh(delayMs) {
    clearRefreshTimer();
    const wait = Math.max(MIN_SUCCESS_DELAY_MS, Math.min(Math.floor(delayMs), MAX_TIMER_MS));
    if (memory.record) {
      memory.record.nextRefreshAt = clock() + wait;
      persist(memory.record);
    }
    if (!running || trustedKeys().length === 0) return;
    refreshTimer = setTimer(() => {
      refreshTimer = null;
      Promise.resolve(refresh({ force: true })).catch(() => {});
    }, wait);
  }

  function armExpiry() {
    clearExpiryTimer();
    if (!running || trustedKeys().length === 0 || !memory.claims || !memory.record) return;
    const delay = memory.claims.exp * 1000 - memory.record.serverOffsetMs - clock();
    if (!Number.isFinite(delay)) return;
    const wait = Math.max(0, Math.min(Math.floor(delay), MAX_TIMER_MS));
    expiryTimer = setTimer(() => {
      expiryTimer = null;
      try {
        const judged = judge();
        publish(judged);
        if (judged.claims && judged.state !== "expired" && judged.state !== "unverified")
          armExpiry();
      } catch {
        publish({ state: "unverified", until: null, reason: "unavailable" });
      }
    }, wait);
  }

  function successDelay(claims, record) {
    const target = Math.min(claims.iat * 1000 + TWELVE_H_MS, claims.exp * 1000 - SIX_H_MS);
    let delay = target - record.serverOffsetMs - clock();
    if (!Number.isFinite(delay) || delay < MIN_SUCCESS_DELAY_MS) delay = MIN_SUCCESS_DELAY_MS;
    const unit = Number(random());
    const fraction = Number.isFinite(unit) && unit > 0 ? Math.min(unit, 1) : 0;
    return Math.max(MIN_SUCCESS_DELAY_MS, Math.floor(delay + delay * fraction * 0.1));
  }

  function scheduleSuccess() {
    if (!memory.claims || !memory.record) return;
    armRefresh(successDelay(memory.claims, memory.record));
    armExpiry();
  }

  function scheduleFailure(result) {
    if (!memory.record) return;
    const step = BACKOFF_MS[Math.min(failCount, BACKOFF_MS.length - 1)];
    failCount += 1;
    const retryMs = Number.isFinite(result?.retryAfter) ? result.retryAfter * 1000 : 0;
    armRefresh(Math.min(Math.max(step, retryMs), MAX_TIMER_MS));
  }

  function rememberError(code) {
    if (!memory.record) return;
    memory.record.lastError = typeof code === "string" ? code : "UNAVAILABLE";
    memory.record.lastRefreshAt = clock();
    persist(memory.record);
  }

  function commit(token, claims) {
    const localNow = clock();
    const previousHigh =
      memory.record && Number.isFinite(memory.record.highWaterMs) ? memory.record.highWaterMs : 0;
    const serverOffsetMs = claims.iat * 1000 - localNow;
    const record = {
      token,
      seq: claims.seq,
      jti: claims.jti,
      serverOffsetMs,
      highWaterMs: Math.max(previousHigh, claims.iat * 1000),
      lastRefreshAt: localNow,
      nextRefreshAt: null,
      lastError: null,
    };
    memory = { record, invalid: false, claims };
    lastHighWaterPersistMs = localNow;
    failCount = 0;
    persist(record);
  }

  function applyToken(token) {
    syncFromStorage();
    if (memory.record && !memory.claims) {
      try {
        judge();
      } catch {
        /* fall back to stored seq/jti */
      }
    }
    let installationId = null;
    try {
      installationId = installationView()?.installationId ?? null;
    } catch {
      return { ok: false, code: "UNAVAILABLE" };
    }
    const storedSeq =
      memory.claims?.seq ?? (Number.isSafeInteger(memory.record?.seq) ? memory.record.seq : null);
    const storedJti =
      memory.claims?.jti ?? (typeof memory.record?.jti === "string" ? memory.record.jti : null);
    const verified = verifyToken(token, {
      keys: trustedKeys(),
      installationId,
      storedSeq,
      storedJti,
    });
    if (!verified.ok) {
      if (verified.reason === "replay") {
        scheduleSuccess();
        return { ok: true, ignored: true };
      }
      rememberError("BAD_SIGNATURE");
      scheduleFailure({ code: "BAD_SIGNATURE" });
      return { ok: false, code: "BAD_SIGNATURE" };
    }
    if (storedSeq != null && verified.claims.seq <= storedSeq) {
      scheduleSuccess();
      return { ok: true, ignored: true };
    }
    commit(token, verified.claims);
    scheduleSuccess();
    publish(judge());
    return { ok: true };
  }

  function clientDeps(installation, seq) {
    return {
      keys: trustedKeys(),
      installation,
      seq,
      fetch: deps.fetch,
      now: clock,
      randomBytes,
      logger: deps.logger,
    };
  }

  function resultOf(outcome) {
    return {
      ok: outcome.ok === true,
      ...(outcome.ok === true || typeof outcome.code !== "string" ? {} : { code: outcome.code }),
      ...(Number.isFinite(outcome.retryAfter) ? { retryAfter: outcome.retryAfter } : {}),
      entitlement: status(),
    };
  }

  async function claim(input) {
    if (trustedKeys().length === 0) return resultOf({ ok: false, code: "UNCONFIGURED" });
    if (!client.validateClaimBody(input)) return resultOf({ ok: false, code: "BAD_REQUEST" });
    let installation;
    try {
      installation = installations.getOrCreateInstallation();
    } catch {
      return resultOf({ ok: false, code: "UNAVAILABLE" });
    }
    const outcome = await client.claim(input, clientDeps(installation, 0));
    if (!outcome.ok) {
      rememberError(outcome.code);
      return resultOf(outcome);
    }
    const applied = applyToken(outcome.token);
    return resultOf({ ...outcome, ...applied, ok: applied.ok, code: applied.code });
  }

  async function runRefresh() {
    if (trustedKeys().length === 0) return resultOf({ ok: false, code: "UNCONFIGURED" });
    syncFromStorage();
    if (memory.record && !memory.claims) {
      try {
        judge();
      } catch {
        /* seq falls back to memory.record.seq */
      }
    }
    let installation;
    try {
      installation = installationView();
    } catch {
      return resultOf({ ok: false, code: "UNAVAILABLE" });
    }
    if (!installation) return resultOf({ ok: false, code: "NO_INSTALLATION" });
    const seq =
      memory.claims?.seq ?? (Number.isSafeInteger(memory.record?.seq) ? memory.record.seq : 0);
    const outcome = await client.refresh(clientDeps(installation, seq));
    if (!outcome.ok) {
      rememberError(outcome.code);
      scheduleFailure(outcome);
      return resultOf(outcome);
    }
    const applied = applyToken(outcome.token);
    if (!applied.ok) return resultOf(applied);
    return resultOf({ ok: true });
  }

  function refresh(options = {}) {
    if (flight) return flight;
    const force = options?.force === true;
    if (!force && (memory.record?.nextRefreshAt == null || clock() < memory.record.nextRefreshAt)) {
      return Promise.resolve(resultOf({ ok: true }));
    }
    flight = runRefresh().finally(() => {
      flight = null;
    });
    return flight;
  }

  function prepare() {
    const created = installations.getOrCreateInstallation();
    return { installationId: created.installationId };
  }

  function stop() {
    running = false;
    clearRefreshTimer();
    clearExpiryTimer();
  }

  function start() {
    running = true;
    clearRefreshTimer();
    clearExpiryTimer();
    failCount = 0;
    if (trustedKeys().length === 0) return stop;
    try {
      syncFromStorage();
    } catch {
      return stop;
    }
    if (!memory.record) return stop;
    try {
      publish(judge());
    } catch {
      // A record that cannot be judged still refreshes; the request may replace it.
    }
    armRefresh(FIRST_REFRESH_MS);
    armExpiry();
    return stop;
  }

  return { isActive, status, subscribe, start, stop, claim, refresh, prepare, isConfigured };
}

const singleton = createEntitlement();

module.exports = {
  isActive: (name) => singleton.isActive(name),
  status: () => singleton.status(),
  subscribe: (listener) => singleton.subscribe(listener),
  start: () => singleton.start(),
  stop: () => singleton.stop(),
  claim: (input) => singleton.claim(input),
  refresh: (options) => singleton.refresh(options),
  prepare: () => singleton.prepare(),
  isConfigured: () => singleton.isConfigured(),
  createEntitlement,
  _createForTest: createEntitlement,
};

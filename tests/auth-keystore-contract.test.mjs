// SignalKeyStore contract for Baileys' commit retry.
//
// keys.set of one call is one transaction. null/undefined deletes the row.
// A storage or parse failure rejects with the original error. Creds load and
// saveCreds still swallow, because they run where a throw takes the process
// down (socket build, and the creds.update listener in src/core/events.js).

import { addTransactionCapability, BufferJSON } from "@whiskeysockets/baileys";
import { equal, finish, ok, require, section, useTempDataDir } from "./harness.mjs";

useTempDataDir("levix-auth-keystore");

const store = require("./src/db/store.cjs");
const vault = require("./src/config/vault.cjs");
const logger = require("./src/utils/logger.cjs");
const { createAuthStorage } = require("./src/auth/auth-storage.cjs");
const { AUTH_STORE_FENCED, useDatabaseAuthState } = await import(
  "../src/auth/use-database-auth-state.js"
);

function canon(value) {
  return JSON.stringify(value, BufferJSON.replacer);
}

function sameValue(label, actual, expected) {
  equal(label, canon(actual), canon(expected));
}

async function catchError(fn) {
  try {
    await fn();
    return null;
  } catch (error) {
    return error;
  }
}

const txLogger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child() {
    return txLogger;
  },
};

const sessionValue = {
  registrationId: 1,
  noiseKey: { private: Buffer.from([1, 2, 3, 4]), public: Buffer.from([5, 6]) },
  flag: false,
  count: 0,
};
const senderKeyValue = {
  senderKey: Buffer.from([9, 8, 7, 6]),
  chain: [Buffer.from([1]), Buffer.from([2, 2])],
};
const preKeyValue = { private: Buffer.from([7, 7, 7]), public: Buffer.from([8, 8]) };
const memoryValue = {
  "201000000001@s.whatsapp.net": true,
  blob: Buffer.from("mem"),
};
const appStateValue = { keyData: Buffer.from([4, 4, 4, 4]), fingerprint: Buffer.from([3]) };

const { state, saveCreds } = await useDatabaseAuthState();
const { keys } = state;

section("typed set/get round trip");

{
  const originalApply = store.authApply;
  let batch = null;
  store.authApply = (entries) => {
    batch = entries.map((entry) => entry.key);
    return originalApply(entries);
  };
  const setError = await catchError(() =>
    keys.set({
      session: { s1: sessionValue },
      "sender-key": { sk1: senderKeyValue },
      "pre-key": { 1: preKeyValue },
      "sender-key-memory": { g1: memoryValue },
      "app-state-sync-key": { as1: appStateValue },
    }),
  );
  store.authApply = originalApply;

  ok("typed set resolves", setError === null);
  equal("typed set is one authApply", batch ? batch.length : 0, 5);
  equal(
    "typed batch key order",
    batch ? batch.join(",") : "",
    "session-s1,sender-key-sk1,pre-key-1,sender-key-memory-g1,app-state-sync-key-as1",
  );

  const session = await keys.get("session", ["s1"]);
  const sender = await keys.get("sender-key", ["sk1"]);
  const pre = await keys.get("pre-key", ["1"]);
  const mem = await keys.get("sender-key-memory", ["g1"]);
  const app = await keys.get("app-state-sync-key", ["as1"]);
  sameValue("session round trip", session.s1, sessionValue);
  sameValue("sender-key round trip", sender.sk1, senderKeyValue);
  sameValue("pre-key round trip", pre["1"], preKeyValue);
  sameValue("sender-key-memory round trip", mem.g1, memoryValue);
  sameValue("app-state round trip", app.as1, appStateValue);
  ok(
    "session private key is a Buffer",
    Buffer.isBuffer(session.s1?.noiseKey?.private) &&
      session.s1.noiseKey.private.equals(Buffer.from([1, 2, 3, 4])),
  );
  equal("false survives", session.s1?.flag, false);
  equal("zero survives", session.s1?.count, 0);

  const planted = canon(sessionValue);
  store.authWrite("session-planted", planted);
  const legacy = await keys.get("session", ["planted", "missing"]);
  sameValue("row written by authWrite reads back", legacy.planted, sessionValue);
  ok("missing id is omitted", legacy.missing === undefined);
  equal("missing id creates no row", store.authRead("session-missing"), null);
  equal("keys.set stores the same BufferJSON text", store.authRead("session-s1"), planted);

  const auth = createAuthStorage("sqlite");
  await auth.writeData("session-via-write", sessionValue);
  const via = await keys.get("session", ["via-write"]);
  sameValue("writeData row reads through keys.get", via["via-write"], sessionValue);
  sameValue("readData sees keys.set", await auth.readData("session-s1"), sessionValue);
}

section("null and undefined delete the row");

{
  await keys.set({ session: { n1: sessionValue, u1: { n: 1 } } });
  const originalApply = store.authApply;
  let batch = null;
  store.authApply = (entries) => {
    batch = entries;
    return originalApply(entries);
  };
  const setError = await catchError(() => keys.set({ session: { n1: null, u1: undefined } }));
  store.authApply = originalApply;

  ok("delete set resolves", setError === null);
  ok(
    "null is a delete marker in the one batch",
    !!batch && batch.some((entry) => entry.key === "session-n1" && entry.value === null),
  );
  ok(
    "undefined is a delete marker in the same batch",
    !!batch && batch.some((entry) => entry.key === "session-u1" && entry.value == null),
  );
  equal("null deletes the row", store.authRead("session-n1"), null);
  equal("undefined deletes the row", store.authRead("session-u1"), null);
  const gone = await keys.get("session", ["n1", "u1"]);
  ok("deleted ids are absent", gone.n1 === undefined && gone.u1 === undefined);
}

section("legacy null text stays absent and stays stored");

{
  store.authWrite("session-legacy-null", "null");
  const got = await keys.get("session", ["legacy-null"]);
  ok("legacy null text reads as absent", got["legacy-null"] === undefined);
  equal("legacy null row is not rewritten", store.authRead("session-legacy-null"), "null");
}

section("read and write failures reject");

{
  await keys.set({ session: { good: { n: 1 } } });
  store.authWrite("session-bad", "{");
  const parseError = await catchError(() => keys.get("session", ["good", "bad"]));
  ok("unparseable row rejects keys.get", parseError instanceof SyntaxError);
  equal("unparseable row is kept", store.authRead("session-bad"), "{");
  const good = await keys.get("session", ["good"]);
  equal("sibling row still reads", good.good?.n, 1);

  await keys.set({ session: { stable: { n: 1 } } });
  const originalApply = store.authApply;
  store.authApply = () => {
    throw new Error("disk-full");
  };
  const writeError = await catchError(() =>
    keys.set({ session: { stable: { n: 2 }, extra: { n: 3 } } }),
  );
  store.authApply = originalApply;
  equal("keys.set rejects the storage error", writeError && writeError.message, "disk-full");
  const still = await keys.get("session", ["stable", "extra"]);
  equal("previous value kept", still.stable?.n, 1);
  ok("failed insert is absent", still.extra === undefined);

  const originalRead = store.authRead;
  store.authRead = () => {
    throw new Error("read-down");
  };
  const readError = await catchError(() => keys.get("session", ["stable"]));
  store.authRead = originalRead;
  equal("keys.get rejects the storage error", readError && readError.message, "read-down");
}

section("a failure on the 2nd of 3 entries rolls back");

{
  store.authWrite("session-sentinel", JSON.stringify({ keep: true }));
  const originalSeal = vault.seal;
  let seals = 0;
  vault.seal = (plaintext) => {
    seals += 1;
    if (seals === 2) throw new Error("second-entry");
    return originalSeal(plaintext);
  };
  const error = await catchError(() =>
    keys.set({
      session: { a1: { n: 1 }, a2: { n: 2 }, a3: { n: 3 } },
    }),
  );
  vault.seal = originalSeal;

  equal("keys.set rejects the 2nd entry", error && error.message, "second-entry");
  ok("the 2nd seal is where it failed", seals >= 2);
  equal("1st entry rolled back", store.authRead("session-a1"), null);
  equal("2nd entry absent", store.authRead("session-a2"), null);
  equal("3rd entry absent", store.authRead("session-a3"), null);
  equal("unrelated row kept", store.authRead("session-sentinel"), JSON.stringify({ keep: true }));
}

section("legacy untyped keys.set");

{
  const longId = "A".repeat(24);
  const originalApply = store.authApply;
  let batch = null;
  store.authApply = (entries) => {
    batch = entries;
    return originalApply(entries);
  };
  const error = await catchError(() =>
    keys.set({
      "user@s.whatsapp.net": "sess",
      7: 7,
      [longId]: "app",
      "plain-name": false,
    }),
  );
  store.authApply = originalApply;

  ok("untyped set resolves", error === null);
  equal("untyped set is one authApply", batch ? batch.length : 0, 4);
  equal(
    "untyped key names",
    // Object.keys lists integer-like keys ("7") first, so compare as sets.
    batch
      ? batch
          .map((entry) => entry.key)
          .sort()
          .join(",")
      : "",
    [`session-user@s.whatsapp.net`, `pre-key-7`, `app-state-sync-key-${longId}`, `plain-name`]
      .sort()
      .join(","),
  );
  equal("untyped session value", JSON.parse(store.authRead("session-user@s.whatsapp.net")), "sess");
  equal("untyped pre-key value", JSON.parse(store.authRead("pre-key-7")), 7);
  equal(
    "untyped app-state value",
    JSON.parse(store.authRead(`app-state-sync-key-${longId}`)),
    "app",
  );
  equal("untyped plain value", JSON.parse(store.authRead("plain-name")), false);

  await keys.set({ "plain-name": null });
  equal("untyped null deletes", store.authRead("plain-name"), null);
}

section("Baileys commit retry");

{
  const tx = addTransactionCapability(keys, txLogger, {
    maxCommitRetries: 3,
    delayBetweenTriesMs: 1,
  });
  const originalApply = store.authApply;

  let attempts = 0;
  store.authApply = (entries) => {
    attempts += 1;
    if (attempts === 1) throw new Error("transient");
    return originalApply(entries);
  };
  const transient = await catchError(() =>
    tx.transaction(async () => {
      await tx.set({ session: { "retry@s.whatsapp.net": sessionValue } });
    }, "session"),
  );
  store.authApply = originalApply;
  equal("one transient failure still commits", transient, null);
  equal("commit retried once", attempts, 2);
  const committed = await keys.get("session", ["retry@s.whatsapp.net"]);
  sameValue("retry commit reads back", committed["retry@s.whatsapp.net"], sessionValue);

  attempts = 0;
  store.authApply = () => {
    attempts += 1;
    throw new Error("persistent");
  };
  const persistent = await catchError(() =>
    tx.transaction(async () => {
      await tx.set({ session: { "persist@s.whatsapp.net": sessionValue } });
    }, "session"),
  );
  store.authApply = originalApply;
  equal("persistent failure rejects", persistent && persistent.message, "persistent");
  equal("persistent failure uses every retry", attempts, 3);
  equal(
    "persistent failure writes nothing",
    store.authRead("session-persist@s.whatsapp.net"),
    null,
  );
}

section("memory backend");

{
  const memory = await useDatabaseAuthState("memory");
  const memKeys = memory.state.keys;
  await memKeys.set({ session: { m1: sessionValue, m2: { n: 2 } } });
  const round = await memKeys.get("session", ["m1"]);
  sameValue("memory session round trip", round.m1, sessionValue);

  const originalStringify = JSON.stringify;
  let encodedNullish = false;
  JSON.stringify = (value, replacer, space) => {
    if (value == null && typeof replacer === "function") encodedNullish = true;
    return originalStringify.call(JSON, value, replacer, space);
  };
  const deleteError = await catchError(() => memKeys.set({ session: { m1: null, m2: undefined } }));
  JSON.stringify = originalStringify;
  ok("memory null delete resolves", deleteError === null);
  ok("memory null deletes without JSON null", encodedNullish === false);
  const gone = await memKeys.get("session", ["m1", "m2"]);
  ok("memory deleted ids are absent", gone.m1 === undefined && gone.m2 === undefined);

  await memKeys.set({ session: { keep: { n: 9 } } });
  const bad = {
    toJSON() {
      throw new Error("memory-write");
    },
  };
  const writeError = await catchError(() =>
    memKeys.set({ session: { a: { n: 1 }, b: bad, c: { n: 3 } } }),
  );
  equal("memory write error propagates", writeError && writeError.message, "memory-write");
  const left = await memKeys.get("session", ["keep", "a", "b", "c"]);
  equal("memory failure keeps the previous row", left.keep?.n, 9);
  ok(
    "memory failure writes none of the batch",
    left.a === undefined && left.b === undefined && left.c === undefined,
  );
}

section("creds load and saveCreds still swallow");

{
  const originalWrite = store.authWrite;
  store.authWrite = () => {
    throw new Error("creds-disk");
  };
  const saveError = await catchError(() => saveCreds());
  store.authWrite = originalWrite;
  ok("saveCreds does not reject", saveError === null);

  const originalRead = store.authRead;
  store.authRead = (key) => {
    if (key === "creds") throw new Error("creds-unreadable");
    return originalRead(key);
  };
  const loadedError = await catchError(() => useDatabaseAuthState());
  store.authRead = originalRead;
  ok("initial creds load does not reject", loadedError === null);
}

section(
  "fence() rejects keys.set and keys.get, writes nothing, and makes saveCreds a log-once no-op",
);

{
  store.authClearAll();
  const auth = await useDatabaseAuthState();
  equal("fence is exposed as a function", typeof auth.fence, "function");

  await auth.state.keys.set({ session: { "before-fence@s.whatsapp.net": sessionValue } });
  const beforeFence = await auth.state.keys.get("session", ["before-fence@s.whatsapp.net"]);
  sameValue("reads work before fence", beforeFence["before-fence@s.whatsapp.net"], sessionValue);

  auth.fence();

  let readCalls = 0;
  let applyCalls = 0;
  let writeCalls = 0;
  const originalRead = store.authRead;
  const originalApply = store.authApply;
  const originalWrite = store.authWrite;
  store.authRead = (key) => {
    readCalls += 1;
    return originalRead(key);
  };
  store.authApply = (entries) => {
    applyCalls += 1;
    return originalApply(entries);
  };
  store.authWrite = (key, value) => {
    writeCalls += 1;
    return originalWrite(key, value);
  };

  let setErr;
  let emptySetErr;
  let getErr;
  const debugCalls = [];
  const originalDebug = logger.debug;
  logger.debug = (...args) => {
    debugCalls.push(args);
  };
  try {
    setErr = await catchError(() =>
      auth.state.keys.set({
        session: { "after-fence@s.whatsapp.net": sessionValue },
        "pre-key": { 77: preKeyValue },
      }),
    );
    emptySetErr = await catchError(() => auth.state.keys.set({}));
    getErr = await catchError(() =>
      auth.state.keys.get("session", ["before-fence@s.whatsapp.net"]),
    );

    auth.state.creds.me = { id: "111@s.whatsapp.net", name: "Fenced" };
    await auth.saveCreds();
    await auth.saveCreds();
    await auth.saveCreds();
  } finally {
    logger.debug = originalDebug;
    store.authRead = originalRead;
    store.authApply = originalApply;
    store.authWrite = originalWrite;
  }

  equal("fenced keys.set rejects with AUTH_STORE_FENCED", setErr?.code, AUTH_STORE_FENCED);
  equal(
    "fenced keys.set({}) also rejects with AUTH_STORE_FENCED",
    emptySetErr?.code,
    AUTH_STORE_FENCED,
  );
  equal("fenced keys.get rejects with AUTH_STORE_FENCED", getErr?.code, AUTH_STORE_FENCED);
  equal("fenced keys.get performs no storage read", readCalls, 0);
  equal("fenced keys.set performs no storage apply", applyCalls, 0);
  equal("fenced saveCreds performs no storage write", writeCalls, 0);
  equal("fenced saveCreds logs once at debug", debugCalls.length, 1);
  equal(
    "fenced keys.set wrote nothing to sqlite",
    store.authRead("session-after-fence@s.whatsapp.net"),
    null,
  );
  equal("fenced pre-key write did not land", store.authRead("pre-key-77"), null);
  ok(
    "existing row before fence is untouched",
    store.authRead("session-before-fence@s.whatsapp.net") !== null,
  );

  // A new auth state instance created for a reconnect or next account is unfenced.
  const nextAuth = await useDatabaseAuthState();
  await nextAuth.state.keys.set({ session: { "next-instance@s.whatsapp.net": sessionValue } });
  const nextRead = await nextAuth.state.keys.get("session", ["next-instance@s.whatsapp.net"]);
  sameValue(
    "new auth state instance is unaffected by old fence",
    nextRead["next-instance@s.whatsapp.net"],
    sessionValue,
  );

  // Memory backend also supports fence().
  const memAuth = await useDatabaseAuthState("memory");
  memAuth.fence();
  const memSetErr = await catchError(() =>
    memAuth.state.keys.set({ session: { m1: sessionValue } }),
  );
  const memGetErr = await catchError(() => memAuth.state.keys.get("session", ["m1"]));
  equal("memory fenced keys.set rejects", memSetErr?.code, AUTH_STORE_FENCED);
  equal("memory fenced keys.get rejects", memGetErr?.code, AUTH_STORE_FENCED);
}

section(
  "pending Baileys commitWithRetry after fence writes nothing into cleared or next account state",
);

{
  store.authClearAll();
  const oldAccount = await useDatabaseAuthState();
  const txKeys = addTransactionCapability(oldAccount.state.keys, txLogger, {
    maxCommitRetries: 4,
    delayBetweenTriesMs: 25,
  });

  let applyAttempts = 0;
  const originalApply = store.authApply;
  let nextAccount;
  store.authApply = (entries) => {
    // Count only the old account's commits; the next account's own write is legitimate.
    const fromOldAccount = entries.some((entry) => /old-account|::old@/.test(entry.key));
    if (!fromOldAccount) return originalApply(entries);
    applyAttempts += 1;
    if (applyAttempts === 1) {
      // Simulate a transient SQLite failure on the first commit attempt, then
      // the operator unlinks and pairs a new account while Baileys waits to retry.
      setTimeout(async () => {
        oldAccount.fence();
        await oldAccount.clearAll();
        nextAccount = await useDatabaseAuthState();
        await nextAccount.state.keys.set({
          session: { "new-account@s.whatsapp.net": { n: 200 } },
        });
      }, 5);
      throw new Error("transient-before-unlink");
    }
    return originalApply(entries);
  };

  let txError;
  try {
    txError = await catchError(() =>
      txKeys.transaction(async () => {
        await txKeys.set({
          session: { "old-account@s.whatsapp.net": sessionValue },
          "sender-key": { "120363001@g.us::old@lid::0": senderKeyValue },
        });
      }, "old-account-send"),
    );
  } finally {
    store.authApply = originalApply;
  }

  equal(
    "pending commit retry rejects with AUTH_STORE_FENCED after fence",
    txError?.code,
    AUTH_STORE_FENCED,
  );
  equal("storage apply was only called once before fence blocked retries", applyAttempts, 1);
  equal(
    "old account session key is absent from baileys_auth",
    store.authRead("session-old-account@s.whatsapp.net"),
    null,
  );
  equal(
    "old account sender-key is absent from baileys_auth",
    store.authRead("sender-key-120363001@g.us::old@lid::0"),
    null,
  );
  ok("next account auth state was created during retry window", Boolean(nextAccount));
  const nextCheck = await nextAccount.state.keys.get("session", [
    "new-account@s.whatsapp.net",
    "old-account@s.whatsapp.net",
  ]);
  equal("next account keeps its own key", nextCheck["new-account@s.whatsapp.net"]?.n, 200);
  equal(
    "old account key did not leak into next account",
    nextCheck["old-account@s.whatsapp.net"],
    undefined,
  );
}

finish();

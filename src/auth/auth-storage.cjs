// auth-storage.cjs
//
// Where Baileys' credentials and session keys live: the `baileys_auth` table
// in the same SQLite file as everything else. "memory" is only useful for a
// throwaway pairing that you don't mind re-scanning after a restart.

const store = require("../db/store.cjs");

let BufferJSON;
try {
  BufferJSON = require("@whiskeysockets/baileys").BufferJSON;
} catch (e) {
  BufferJSON = {
    replacer: (k, v) => v,
    reviver: (k, v) => v,
  };
}

const MISSING = Symbol("missing");

function serialize(value) {
  return JSON.stringify(value, BufferJSON.replacer);
}

function deserialize(text) {
  return JSON.parse(text, BufferJSON.reviver);
}

// `value == null` is a delete. Anything else is BufferJSON text. Stringify
// every entry before the first mutation so a later encode failure leaves
// the batch untouched.
function encodeEntry(entry) {
  if (entry == null || typeof entry.key !== "string") {
    throw new TypeError("auth entry needs a string key");
  }
  if (entry.value == null) return { key: entry.key, delete: true };
  return { key: entry.key, text: serialize(entry.value) };
}

function memoryFactory() {
  const map = new Map();

  return {
    async writeData(key, value) {
      map.set(key, serialize(value));
    },
    async readData(key) {
      if (!map.has(key)) return null;
      const text = map.get(key);
      if (text == null) return null;
      return deserialize(text);
    },
    async removeData(key) {
      map.delete(key);
    },
    async apply(entries) {
      const ops = entries.map((entry) => encodeEntry(entry));
      const prior = new Map();
      try {
        for (const op of ops) {
          if (!prior.has(op.key)) prior.set(op.key, map.has(op.key) ? map.get(op.key) : MISSING);
          if (op.delete) map.delete(op.key);
          else map.set(op.key, op.text);
        }
      } catch (error) {
        for (const [key, value] of prior) {
          if (value === MISSING) map.delete(key);
          else map.set(key, value);
        }
        throw error;
      }
    },
    async clearAll() {
      map.clear();
    },
  };
}

// SQLite-backed auth.
//
// Values are stored as BufferJSON text, which is the whole reason this is a
// TEXT column: Baileys' session keys are full of Buffers, and BufferJSON is
// what turns them into something storable and back again. Storing the string
// rather than a parsed object means the buffers round-trip exactly.
function sqliteFactory() {
  return {
    async writeData(key, value) {
      store.authWrite(key, serialize(value));
    },
    async readData(key) {
      const text = store.authRead(key);
      if (text == null) return null;
      return deserialize(text);
    },
    async removeData(key) {
      store.authRemove(key);
    },
    async apply(entries) {
      store.authApply(
        entries.map((entry) => {
          const op = encodeEntry(entry);
          return op.delete ? { key: op.key, value: null } : { key: op.key, value: op.text };
        }),
      );
    },
    async clearAll() {
      store.authClearAll();
    },
  };
}

function createAuthStorage(type = "sqlite") {
  if (type === "sqlite") return sqliteFactory();
  if (type === "memory") return memoryFactory();

  throw new Error(`Unknown storage type: ${type}`);
}

module.exports = {
  createAuthStorage,
};

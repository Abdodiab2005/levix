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

function memoryFactory() {
  const map = new Map();

  return {
    async writeData(key, value) {
      map.set(key, JSON.stringify(value, BufferJSON.replacer));
    },
    async readData(key) {
      const v = map.get(key);
      if (!v) return null;
      return JSON.parse(v, BufferJSON.reviver);
    },
    async removeData(key) {
      map.delete(key);
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
      store.authWrite(key, JSON.stringify(value, BufferJSON.replacer));
    },
    async readData(key) {
      const text = store.authRead(key);
      if (text === null || text === undefined) return null;
      return JSON.parse(text, BufferJSON.reviver);
    },
    async removeData(key) {
      store.authRemove(key);
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

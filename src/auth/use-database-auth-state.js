// use-database-auth-state.js
import { initAuthCreds } from "@whiskeysockets/baileys";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { createAuthStorage } = require("./auth-storage.cjs");
const logger = require("../utils/logger.cjs");

export const AUTH_STORE_FENCED = "AUTH_STORE_FENCED";

function fencedError() {
  const err = new Error("Auth store is fenced");
  err.code = AUTH_STORE_FENCED;
  return err;
}

// Baileys' typed shape is `{ [type]: { [id]: value } }`. The untyped shape is
// a flat id → value map left over from older sessions; the key names stay.
function collectKeyEntries(data) {
  const entries = [];
  const topKeys = Object.keys(data);
  const looksLikeTyped = topKeys.some((key) => typeof data[key] === "object" && data[key] !== null);

  if (looksLikeTyped) {
    for (const type of topKeys) {
      const typed = data[type];
      if (typeof typed !== "object" || typed === null) continue;
      for (const id of Object.keys(typed)) {
        entries.push({ key: `${type}-${id}`, value: typed[id] });
      }
    }
    return entries;
  }

  for (const id of topKeys) {
    let keyName = id;
    const base64Id = id.length > 20 && /^[A-Za-z0-9+/=]+$/.test(id);
    if (id.includes("@")) keyName = `session-${id}`;
    else if (/^\d+$/.test(id)) keyName = `pre-key-${id}`;
    else if (base64Id) keyName = `app-state-sync-key-${id}`;
    entries.push({ key: keyName, value: data[id] });
  }
  return entries;
}

export async function useDatabaseAuthState(storageType = null) {
  // SQLite unless the caller explicitly asks for the throwaway memory store.
  const resolvedType = storageType || "sqlite";
  const storage = createAuthStorage(resolvedType);
  logger.info(`[Auth] Using ${resolvedType} storage backend`);

  // Creds only. The first load runs while the socket is built, and saveCreds
  // is the `creds.update` listener (src/core/events.js). A rejection there is
  // an unhandled exception, so these three helpers still swallow. keys.get
  // and keys.set do not use them.
  const writeData = async (key, data) => {
    try {
      await storage.writeData(key, data);
    } catch (err) {
      logger.error({ err, key }, "[Auth] Failed to write data");
    }
  };

  const readData = async (key) => {
    try {
      return await storage.readData(key);
    } catch (err) {
      logger.error({ err, key }, "[Auth] Failed to read data");
      return null;
    }
  };

  const removeData = async (key) => {
    try {
      await storage.removeData(key);
    } catch (err) {
      logger.error({ err, key }, "[Auth] Failed to remove data");
    }
  };

  // load or init creds
  let creds = await readData("creds");
  if (!creds) {
    creds = initAuthCreds();
    await writeData("creds", creds);
    logger.info("[Auth] Initialized new credentials");
  } else {
    logger.info("[Auth] Loaded existing credentials from database");
  }

  let fenced = false;
  let fencedSaveLogged = false;
  const fence = () => {
    fenced = true;
  };

  const keys = {
    get: async (type, ids) => {
      if (fenced) throw fencedError();
      const out = {};
      await Promise.all(
        ids.map(async (id) => {
          if (fenced) throw fencedError();
          const val = await storage.readData(`${type}-${id}`);
          if (fenced) throw fencedError();
          if (val !== null && val !== undefined) out[id] = val;
        }),
      );
      if (fenced) throw fencedError();
      return out;
    },

    set: async (data) => {
      if (fenced) throw fencedError();
      const entries = collectKeyEntries(data);
      if (entries.length === 0) return;
      if (fenced) throw fencedError();
      await storage.apply(entries);
    },
  };

  const state = { creds, keys };

  const saveCreds = async () => {
    if (fenced) {
      if (!fencedSaveLogged) {
        fencedSaveLogged = true;
        logger.debug("[Auth] Ignoring saveCreds on fenced auth state");
      }
      return;
    }
    try {
      await writeData("creds", state.creds);
    } catch (err) {
      logger.error({ err }, "[Auth] Failed to save credentials");
    }
  };

  const clearAll = async () => {
    fenced = true;
    try {
      if (storage.clearAll) {
        await storage.clearAll();
      } else {
        await removeData("creds");
      }
      logger.info("[Auth] Cleared all authentication data");
    } catch (err) {
      logger.error({ err }, "[Auth] Failed to clear all data");
    }
  };

  return { state, saveCreds, clearAll, fence };
}

export default useDatabaseAuthState;

// use-database-auth-state.js
import { initAuthCreds } from "@whiskeysockets/baileys";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { createAuthStorage } = require("./auth-storage.cjs");
const logger = require("../utils/logger.cjs");

export async function useDatabaseAuthState(storageType = null) {
  // SQLite unless the caller explicitly asks for the throwaway memory store.
  const resolvedType = storageType || "sqlite";
  const storage = createAuthStorage(resolvedType);
  logger.info(`[Auth] Using ${resolvedType} storage backend`);

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

  const keys = {
    get: async (type, ids) => {
      const out = {};
      await Promise.all(
        ids.map(async (id) => {
          const key = `${type}-${id}`;
          const val = await readData(key);
          if (val !== null && val !== undefined) out[id] = val;
        })
      );
      return out;
    },

    set: async (data) => {
      try {
        const topKeys = Object.keys(data);
        const looksLikeTyped = topKeys.some(
          (k) => typeof data[k] === "object" && data[k] !== null
        );

        if (looksLikeTyped) {
          for (const type of topKeys) {
            const typed = data[type];
            if (typeof typed !== "object" || typed === null) continue;
            for (const id of Object.keys(typed)) {
              const key = `${type}-${id}`;
              await writeData(key, typed[id]);
            }
          }
          return;
        }

        for (const id of topKeys) {
          const val = data[id];
          let keyName = id;

          if (id.includes("@")) {
            keyName = `session-${id}`;
          } else if (/^\d+$/.test(id)) {
            keyName = `pre-key-${id}`;
          } else if (id.length > 20 && /^[A-Za-z0-9+/=]+$/.test(id)) {
            keyName = `app-state-sync-key-${id}`;
          } else {
            keyName = id;
          }

          await writeData(keyName, val);
        }
      } catch (err) {
        logger.error({ err }, "[Auth] keys.set failed");
      }
    },
  };

  const state = { creds, keys };

  const saveCreds = async () => {
    try {
      await writeData("creds", state.creds);
    } catch (err) {
      logger.error({ err }, "[Auth] Failed to save credentials");
    }
  };

  const clearAll = async () => {
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

  return { state, saveCreds, clearAll };
}

export default useDatabaseAuthState;

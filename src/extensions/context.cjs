// Frozen ctx handed to activate(). Holds only what declared capabilities need.

const catalog = require("../i18n/catalog.generated.cjs");
const templateKeys = require("./templateKeys.cjs");

function makeStorage(id, kind) {
  return Object.freeze({
    get(name) {
      return require("../db/store.cjs").getExtStorage(id, kind, name);
    },
    set(name, value) {
      require("../db/store.cjs").setExtStorage(id, kind, name, value);
    },
    delete(name) {
      require("../db/store.cjs").deleteExtStorage(id, kind, name);
    },
  });
}

function linkedAccount() {
  const { linkedIdentity } = require("../messaging/identity.cjs");
  const identity = linkedIdentity();
  if (!identity.phone && !identity.lid) return null;
  return Object.freeze({ lid: identity.lid || null, phone: identity.phone || null });
}

function childLog(log, id) {
  if (log && typeof log.child === "function") return log.child({ extension: id });
  return log;
}

function buildContext({
  id,
  signal,
  generation,
  capabilities,
  log,
  invalidateScope,
  aiReply,
} = {}) {
  const caps = new Set(Array.isArray(capabilities) ? capabilities : []);
  const ctx = {
    apiVersion: 1,
    signal,
    generation,
    log: childLog(log, id),
    storage: makeStorage(id, "cfg"),
  };
  if (caps.has("autoReply")) {
    ctx.accountStorage = makeStorage(id, "acct");
    ctx.ai = Object.freeze({
      reply(job) {
        return aiReply(job);
      },
    });
    ctx.linkedAccount = linkedAccount;
    ctx.invalidateScope = typeof invalidateScope === "function" ? invalidateScope : () => {};
  }
  if (caps.has("templates")) {
    ctx.i18n = Object.freeze({
      locales: Object.freeze((catalog.locales || []).map((entry) => entry.code)),
      isCustomizable: templateKeys.isCustomizable,
      catalogTemplate: templateKeys.catalogTemplate,
      placeholders: templateKeys.placeholders,
      customizableKeys: templateKeys.customizableKeys,
    });
    ctx.translate = (text, targetLocale) =>
      require("../commands/translate.cjs").translateForExtension(text, targetLocale);
  }
  return Object.freeze(ctx);
}

module.exports = { buildContext };

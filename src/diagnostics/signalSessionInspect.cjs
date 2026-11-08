// libsignal logs SessionEntry objects. Node ignores the legacy inspect() hook
// since v11. util.inspect.custom restores a key-free form so private keys never
// reach stdout, the terminal, journald, docker logs or the Android host log.
// A static require keeps the executable's bundle on the same libsignal instance
// that Baileys uses.

const util = require("node:util");

const SESSION_PLACEHOLDER = "[SessionEntry redacted]";

function redactSessionEntry() {
  return SESSION_PLACEHOLDER;
}

function installSignalSessionInspect() {
  try {
    const { SessionRecord } = require("libsignal");
    if (typeof SessionRecord?.createEntry !== "function") return false;
    const prototype = Object.getPrototypeOf(SessionRecord.createEntry());
    if (prototype === null || prototype === undefined) return false;
    const existing = Object.getOwnPropertyDescriptor(prototype, util.inspect.custom);
    if (existing && existing.value === redactSessionEntry) return true;
    Object.defineProperty(prototype, util.inspect.custom, {
      configurable: true,
      enumerable: false,
      writable: false,
      value: redactSessionEntry,
    });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  installSignalSessionInspect,
  SESSION_PLACEHOLDER,
};

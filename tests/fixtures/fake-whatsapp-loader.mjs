import { registerHooks } from "node:module";
import net from "node:net";
import os from "node:os";

// Fail closed if the child unexpectedly tries to dial a non-local host.
const localAddresses = new Set(["localhost", "127.0.0.1", "::1"]);
try {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) localAddresses.add(entry.address);
  }
} catch {
  // Sandboxes may refuse interface enumeration; loopback remains allowed.
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = typeof first === "object" && first !== null ? first.host : args[1];
  const path = typeof first === "object" && first !== null ? first.path : null;
  if (!path && host && !localAddresses.has(host)) {
    throw new Error(`test child refused non-local network host: ${host}`);
  }
  return connect.apply(this, args);
};

const socketUrl = new URL("../../src/core/socket.js", import.meta.url).href;
const fakeUrl = new URL("./fake-whatsapp.mjs", import.meta.url).href;
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url !== socketUrl) return result;
    const source = String(result.source);
    const original = 'import { makeWASocket } from "@whiskeysockets/baileys";';
    if (!source.includes(original)) throw new Error("WhatsApp test interception failed");
    return {
      ...result,
      source: source.replace(original, `import { makeWASocket } from ${JSON.stringify(fakeUrl)};`),
    };
  },
});

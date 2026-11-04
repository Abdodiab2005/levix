import { registerHooks } from "node:module";
import "./no-external-network.cjs";

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

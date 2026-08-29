// Does a pending reconnect keep the process alive?
//
// Headless Levix has nothing else holding the event loop open once the WhatsApp
// socket is gone: the database is synchronous and the log transport does not
// hold a reference. So if the retry timer were unref'd, the process would
// simply exit during the wait instead of reconnecting — silently, and only on
// the deployment shape that has no dashboard to notice.
//
// Run as a child process because the question is literally "did this process
// stay alive", which cannot be asked from inside the process asking it.
//
//   node tests/fixtures/reconnect-liveness.mjs --data <dir>

import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const index = process.argv.indexOf("--data");
if (index === -1 || !process.argv[index + 1]) {
  console.error("--data is required");
  process.exit(1);
}
process.env.LEVIX_DATA_DIR = process.argv[index + 1];

const { WhatsAppSession } = await import(`${ROOT}src/core/session.js`);

let created = 0;
const session = new WhatsAppSession({
  createSocket: async () => {
    created += 1;
    return {
      sock: {
        user: { id: "1@s.whatsapp.net" },
        ev: new EventEmitter(),
        async end() {},
        async logout() {},
      },
      saveCreds: async () => {},
      clearAll: async () => {},
      isPaired: true,
    };
  },
  attachListeners: (sock, { onConnectionUpdate }) => {
    sock.onConnectionUpdate = onConnectionUpdate;
  },
  onOpen: async () => {},
  // Long enough that only a ref'd timer can hold the process open across it.
  retryDelaysMs: [1500],
  log: { info() {}, warn() {}, error() {}, debug() {}, trace() {} },
});

// Nothing else in this process keeps the loop alive from here on.
process.on("exit", () => {
  console.log(created > 1 ? "RECONNECTED" : "EXITED_BEFORE_RETRY");
});

await session.start();
const first = session.socket;
await first.onConnectionUpdate({ connection: "open" });
await first.onConnectionUpdate({
  connection: "close",
  lastDisconnect: { error: { output: { statusCode: 408 } } },
});

// No await, no timer of our own: whether this process is still here in 1.5s is
// entirely up to the retry timer the session scheduled.

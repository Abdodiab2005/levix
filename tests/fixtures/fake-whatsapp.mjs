// Child-process integration tests exercise the real session and panel while
// replacing only the Baileys socket constructor. No WhatsApp traffic occurs.
import { EventEmitter } from "node:events";

export function makeWASocket() {
  const ev = new EventEmitter();
  const ws = new EventEmitter();
  const sock = {
    ev,
    ws,
    sendMessage: async () => ({}),
    end: () => {},
    logout: async () => {},
  };
  setImmediate(() => ev.emit("connection.update", { qr: "levix-test-qr" }));
  return sock;
}

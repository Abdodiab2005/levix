// Preloaded into test processes and their Node children. Local servers and
// local-interface binding tests are allowed; external TCP and UDP are not.
const net = require("node:net");
const os = require("node:os");
const dgram = require("node:dgram");
const local = new Set(["localhost", "127.0.0.1", "::1"]);
try {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) local.add(entry.address);
  }
} catch {
  // Interface enumeration is not available in every sandbox.
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = typeof first === "object" && first !== null ? first.host : args[1];
  const path = typeof first === "object" && first !== null ? first.path : null;
  if (!path && typeof host === "string" && !local.has(host)) {
    throw new Error(`test refused non-local network host: ${host}`);
  }
  return connect.apply(this, args);
};
// The suite has no UDP tests. Do not allow a production endpoint to be
// reached by an unexpected UDP path, even if it bypasses TCP interception.
dgram.Socket.prototype.send = function () { throw new Error("test refused UDP send"); };
dgram.Socket.prototype.connect = function () { throw new Error("test refused UDP connect"); };

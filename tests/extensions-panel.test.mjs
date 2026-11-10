import { equal, finish, ok, require, section, useTempDataDir } from "./harness.mjs";

useTempDataDir("levix-extensions-panel");

const { app, server } = require("./app.cjs");
const { host } = require("./src/extensions/host.cjs");
const { bootstrapPanel } = await import("../src/bootstrap/panel.js");
const originalUse = app.use;
const originalListen = server.listen;
const originalHandle = host.handlePanel;
let handler;

section("extension panel receives the mount-relative URL with its query string");
try {
  app.use = function (...args) {
    if (args[0] === "/dashboard/api/plus/ext") handler = args.at(-1);
    return this;
  };
  // Capture route wiring without opening any port or socket.
  server.listen = function (...args) {
    args.at(-1)();
    return this;
  };
  await bootstrapPanel();
  ok("extension route installed", typeof handler === "function");
  host.handlePanel = async (method, path, body) => ({ status: 200, body: { method, path, body } });
  for (const url of ["/preview?key=bot.help.title&locale=pt-BR", "/?locale=ar"]) {
    const result = await new Promise((resolve) => {
      const req = { method: "GET", url, path: url.split("?")[0], body: undefined };
      const res = {
        status() {
          return this;
        },
        json: resolve,
      };
      handler(req, res);
    });
    equal(`${url}: path and query preserved`, result.path, url);
    equal(`${url}: leading slash preserved`, result.path.startsWith("/"), true);
    equal(`${url}: method preserved`, result.method, "GET");
  }
} finally {
  app.use = originalUse;
  server.listen = originalListen;
  host.handlePanel = originalHandle;
}

finish();

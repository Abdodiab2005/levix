import { readFileSync } from "node:fs";
import { dashboardSocketOptions } from "../frontend/src/hooks/socket-options.mjs";
import { equal, finish, ok, section } from "./harness.mjs";

section("options");
const first = dashboardSocketOptions();
equal("tryAllTransports", first.tryAllTransports, true);
equal("transports", JSON.stringify(first.transports), JSON.stringify(["websocket", "polling"]));
equal("path", first.path, "/socket.io");
equal("reconnectionAttempts", first.reconnectionAttempts, 10);
equal("reconnectionDelay", first.reconnectionDelay, 2000);
ok("object is not frozen", Object.isFrozen(first) === false);

const second = dashboardSocketOptions();
ok("calls return different objects", first !== second);
ok("calls return different transports arrays", first.transports !== second.transports);

first.path = "/other";
first.transports.push("webtransport");
const next = dashboardSocketOptions();
equal("mutation does not change the next path", next.path, "/socket.io");
equal(
  "mutation does not change the next transports",
  JSON.stringify(next.transports),
  JSON.stringify(["websocket", "polling"]),
);

section("hook");
const hook = readFileSync(new URL("../frontend/src/hooks/useSocket.ts", import.meta.url), "utf8");
ok("hook calls dashboardSocketOptions()", hook.includes("dashboardSocketOptions()"));
ok("hook has no inline transports key", !hook.includes("transports:"));
finish();

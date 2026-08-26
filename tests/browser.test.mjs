// When Levix may open a browser.
//
// Getting this wrong is not cosmetic: a spawned browser on a headless VPS is a
// process nobody asked for, and in CI it can hang a pipeline. The rule is that
// several signals have to agree, so the decision is a pure function of the
// environment and gets tested as one.

import { useTempDataDir, require, section, ok, equal, finish } from "./harness.mjs";

useTempDataDir("levix-browser");

const { browserBlockedBecause, openBrowser, openCommand } = require("./src/utils/openBrowser.cjs");

// A plain Linux desktop, which every case below modifies.
const DESKTOP = { DISPLAY: ":0" };
const allowed = (env, platform = "linux") =>
  browserBlockedBecause(env, { platform }) === null;

section("a desktop session is allowed");

ok("Linux with an X display", allowed(DESKTOP));
ok("Linux under Wayland", allowed({ WAYLAND_DISPLAY: "wayland-0" }));
ok("macOS needs no display variable", allowed({}, "darwin"));
ok("Windows needs no display variable", allowed({}, "win32"));

section("a server is not");

const blocked = [
  ["no display at all", {}, "linux"],
  ["over SSH", { ...DESKTOP, SSH_CONNECTION: "10.0.0.1 22 10.0.0.2 22" }, "linux"],
  ["over SSH, client variable", { ...DESKTOP, SSH_CLIENT: "10.0.0.1" }, "linux"],
  ["over SSH on macOS", { SSH_TTY: "/dev/ttys000" }, "darwin"],
  ["under systemd", { ...DESKTOP, INVOCATION_ID: "abc123" }, "linux"],
  ["under systemd, journal", { ...DESKTOP, JOURNAL_STREAM: "8:1234" }, "linux"],
  ["in CI", { ...DESKTOP, CI: "true" }, "linux"],
  ["in GitHub Actions", { ...DESKTOP, GITHUB_ACTIONS: "true" }, "linux"],
  ["in GitLab CI", { ...DESKTOP, GITLAB_CI: "true" }, "linux"],
  ["in a container", { ...DESKTOP, container: "podman" }, "linux"],
  ["in Kubernetes", { ...DESKTOP, KUBERNETES_SERVICE_HOST: "10.96.0.1" }, "linux"],
  ["on a headless VPS with a stale DISPLAY", { SSH_CONNECTION: "x", DISPLAY: ":0" }, "linux"],
];

for (const [label, env, platform] of blocked) {
  const reason = browserBlockedBecause(env, { platform });
  ok(`not ${label}`, reason !== null, "it would have opened a browser");
}

section("the reason is specific enough to print");

equal("SSH says so", browserBlockedBecause({ SSH_CONNECTION: "x" }, { platform: "linux" }), "connected over SSH");
equal("CI says so", browserBlockedBecause({ CI: "1" }, { platform: "linux" }), "running in CI");
equal(
  "systemd says so",
  browserBlockedBecause({ INVOCATION_ID: "x", DISPLAY: ":0" }, { platform: "linux" }),
  "started by systemd"
);
equal(
  "a missing display says so",
  browserBlockedBecause({}, { platform: "linux" }),
  "no graphical session"
);

section("the operator can always decide for themselves");

ok(
  "LEVIX_OPEN_BROWSER=0 stops it on a desktop",
  !allowed({ ...DESKTOP, LEVIX_OPEN_BROWSER: "0" })
);
ok(
  "LEVIX_OPEN_BROWSER=1 forces it over SSH",
  allowed({ SSH_CONNECTION: "x", LEVIX_OPEN_BROWSER: "1" })
);
ok(
  "…and even in CI, where someone may genuinely want it",
  allowed({ CI: "true", LEVIX_OPEN_BROWSER: "true" })
);
equal(
  "the reason names the variable",
  browserBlockedBecause({ ...DESKTOP, LEVIX_OPEN_BROWSER: "off" }, { platform: "linux" }),
  "LEVIX_OPEN_BROWSER is off"
);

section("the right command per platform");

equal("macOS uses open", openCommand("http://x", "darwin").command, "open");
equal("Linux uses xdg-open", openCommand("http://x", "linux").command, "xdg-open");
equal("Windows goes through cmd", openCommand("http://x", "win32").command, "cmd");
ok(
  "Windows passes an empty title first, so a quoted URL isn't eaten",
  openCommand("http://x", "win32").args[2] === ""
);
ok(
  "Windows escapes an ampersand for cmd",
  openCommand("http://x?a=1&b=2", "win32").args[3].includes("^&")
);

section("failing to open a browser is never fatal");

{
  // A platform whose opener does not exist here. The spawn fails
  // asynchronously; nothing may throw, and Levix must carry on.
  const result = openBrowser("http://127.0.0.1:3001", {
    env: { LEVIX_OPEN_BROWSER: "1" },
    platform: "linux",
  });
  ok("it returns a result rather than throwing", typeof result.opened === "boolean");

  const refused = openBrowser("http://127.0.0.1:3001", {
    env: {},
    platform: "linux",
  });
  equal("a blocked environment reports not-opened", refused.opened, false);
  ok("…with a reason to print", typeof refused.reason === "string" && refused.reason.length > 0);

  // Give the spawned child a moment to fail, and prove the failure did not
  // become an unhandled error.
  let crashed = false;
  const onError = () => {
    crashed = true;
  };
  process.once("uncaughtException", onError);
  await new Promise((resolve) => setTimeout(resolve, 300));
  process.removeListener("uncaughtException", onError);
  ok("a missing browser binary does not crash the process", !crashed);
}

finish();

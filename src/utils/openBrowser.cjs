// Open the panel in a browser — but only when there is a person and a screen.
//
// Opening a browser is a nice touch on a laptop and pure noise on a server: it
// spawns something that will never render, on a machine nobody is looking at.
// So the question is not "can we" but "should we", and the answer comes from
// several signals rather than one variable, because any one of them lies.
//
// Whatever happens, this is best-effort. The URL is printed either way, and
// nothing in here is allowed to take the bot down.

const { spawn } = require("node:child_process");
const fs = require("node:fs");

const logger = require("./logger.cjs");

/**
 * Why we would not open a browser. Returns null when we should.
 *
 * Split out from the opening itself so it can be tested against a synthetic
 * environment instead of the machine running the tests.
 *
 * @param {object} [env] - defaults to the real environment
 * @param {object} [options]
 * @param {string} [options.platform] - defaults to the real platform
 */
function browserBlockedBecause(env = process.env, { platform = process.platform } = {}) {
  // An explicit answer beats every guess below, in both directions.
  if (isFalsey(env.LEVIX_OPEN_BROWSER)) return "LEVIX_OPEN_BROWSER is off";
  if (isTruthy(env.LEVIX_OPEN_BROWSER)) return null;

  // Somebody else's automation is driving. Opening a browser there wedges
  // pipelines and pops windows on developers' machines.
  if (isTruthy(env.CI) || env.GITHUB_ACTIONS || env.GITLAB_CI || env.BUILDKITE) {
    return "running in CI";
  }

  // A container has no session to open anything into, and the browser it
  // spawned would be inside the container anyway.
  if (inContainer(env)) return "running in a container";

  // systemd starts services with neither a terminal nor a session.
  if (env.INVOCATION_ID || env.JOURNAL_STREAM || env.NOTIFY_SOCKET) {
    return "started by systemd";
  }

  // A remote shell: the display, if any, belongs to another machine.
  if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return "connected over SSH";

  // Nothing to render into. Windows and macOS always have a session when a
  // user is logged in; on Linux and the BSDs it takes a display server.
  if (platform !== "win32" && platform !== "darwin") {
    const hasDisplay = Boolean(env.DISPLAY || env.WAYLAND_DISPLAY || env.MIR_SOCKET);
    if (!hasDisplay) return "no graphical session";
  }

  return null;
}

function isTruthy(value) {
  if (value === undefined || value === "") return false;
  return !["0", "false", "off", "no"].includes(String(value).trim().toLowerCase());
}

function isFalsey(value) {
  if (value === undefined || value === "") return false;
  return ["0", "false", "off", "no"].includes(String(value).trim().toLowerCase());
}

function inContainer(env = process.env) {
  if (isTruthy(env.LEVIX_IN_DOCKER) || isTruthy(env.KUBERNETES_SERVICE_HOST)) return true;
  if (env.container) return true; // podman, systemd-nspawn, lxc
  try {
    if (fs.existsSync("/.dockerenv")) return true;
    // The cgroup path names the container runtime on most setups.
    const cgroup = fs.readFileSync("/proc/1/cgroup", "utf8");
    if (/docker|kubepods|containerd|lxc|podman/i.test(cgroup)) return true;
  } catch {
    // Not Linux, or /proc is not readable. Fall through: the other signals
    // above are what actually matter on macOS and Windows.
  }
  return false;
}

/** The command that opens a URL on this platform. */
function openCommand(url, platform = process.platform) {
  if (platform === "win32") {
    // `start` is a cmd builtin; the empty string is the window title, which
    // start would otherwise take from a quoted URL.
    return { command: "cmd", args: ["/c", "start", "", url.replace(/&/g, "^&")] };
  }
  if (platform === "darwin") return { command: "open", args: [url] };
  return { command: "xdg-open", args: [url] };
}

/**
 * Open `url` if this looks like somebody's desktop.
 *
 * @returns {{ opened: boolean, reason: string|null }} — never throws.
 */
function openBrowser(url, { env = process.env, platform = process.platform } = {}) {
  const blocked = browserBlockedBecause(env, { platform });
  if (blocked) return { opened: false, reason: blocked };

  try {
    const { command, args } = openCommand(url, platform);
    const child = spawn(command, args, {
      stdio: "ignore",
      detached: true,
      env,
    });
    // A missing xdg-open is an ordinary outcome on a minimal desktop, not an
    // error worth interrupting anyone over.
    child.on("error", (error) => {
      logger.debug(`[browser] could not open a browser: ${error.message}`);
    });
    child.unref();
    return { opened: true, reason: null };
  } catch (error) {
    logger.debug(`[browser] could not open a browser: ${error.message}`);
    return { opened: false, reason: "the browser could not be launched" };
  }
}

module.exports = {
  openBrowser,
  browserBlockedBecause,
  openCommand,
  inContainer,
};

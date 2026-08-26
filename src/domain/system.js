// Everything the domain command needs from the machine it's running on,
// behind one small interface.
//
// Two reasons it exists rather than calling child_process directly:
//
//   1. this code runs as root on servers with unrelated production sites on
//      them, so every command it would run has to be visible in one place
//   2. the tests must be able to describe a server — "nginx and certbot, port
//      443 held by apache" — without that server existing
//
// The default implementation is the real one. Tests pass their own.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import dns from "node:dns/promises";

/**
 * @typedef {object} System
 * @property {(cmd: string, args?: string[], opts?: object) => {status: number, stdout: string, stderr: string}} run
 * @property {(path: string) => boolean} exists
 * @property {(path: string) => string} readFile
 * @property {(path: string, content: string) => void} writeFile
 * @property {(path: string) => void} mkdirp
 * @property {(path: string) => void} remove
 * @property {(from: string, to: string) => void} symlink
 * @property {(command: string) => boolean} which
 * @property {() => Array<{port: number, process: string}>} listeners
 * @property {(hostname: string) => Promise<{v4: string[], v6: string[]}>} resolve
 * @property {() => Promise<{v4: string|null, v6: string|null}>} publicIp
 */

export function createSystem(overrides = {}) {
  const real = {
    run(command, args = [], options = {}) {
      const result = spawnSync(command, args, {
        encoding: "utf8",
        timeout: options.timeoutMs ?? 120000,
        ...options,
      });
      return {
        status: result.status ?? 1,
        stdout: result.stdout || "",
        stderr: result.stderr || (result.error ? String(result.error.message) : ""),
      };
    },

    exists: (path) => fs.existsSync(path),
    readFile: (path) => fs.readFileSync(path, "utf8"),

    writeFile(path, content) {
      fs.writeFileSync(path, content, "utf8");
    },

    mkdirp(path) {
      fs.mkdirSync(path, { recursive: true });
    },

    remove(path) {
      fs.rmSync(path, { force: true });
    },

    symlink(from, to) {
      try {
        fs.unlinkSync(to);
      } catch {}
      fs.symlinkSync(from, to);
    },

    which(command) {
      const result = spawnSync("sh", ["-c", `command -v ${command}`], { encoding: "utf8" });
      return (result.status ?? 1) === 0 && Boolean((result.stdout || "").trim());
    },

    /** What is listening on 80 and 443, and which program owns it. */
    listeners() {
      // `ss` on anything modern; `netstat` for the stragglers. Both need the
      // process column, which needs root — without it we still learn that the
      // port is taken, just not by whom, and the command treats an unknown
      // owner as a reason to stop rather than guess.
      const attempts = [
        ["ss", ["-ltnpH"]],
        ["netstat", ["-ltnp"]],
      ];

      for (const [command, args] of attempts) {
        const result = spawnSync(command, args, { encoding: "utf8" });
        if ((result.status ?? 1) !== 0 || !result.stdout) continue;
        return parseListeners(result.stdout);
      }
      return [];
    },

    async resolve(hostname) {
      const out = { v4: [], v6: [] };
      try {
        out.v4 = await dns.resolve4(hostname);
      } catch {}
      try {
        out.v6 = await dns.resolve6(hostname);
      } catch {}
      return out;
    },

    async publicIp() {
      const out = { v4: null, v6: null };
      // One short call to a plain-text endpoint. If there is no network, or it
      // is slow, we carry on without it: the DNS check just becomes advisory.
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 4000);
        const response = await fetch("https://api.ipify.org", { signal: controller.signal });
        clearTimeout(timer);
        if (response.ok) out.v4 = (await response.text()).trim() || null;
      } catch {}
      return out;
    },
  };

  return { ...real, ...overrides };
}

/** Pull `{ port, process }` out of ss/netstat output. Exported to be tested. */
export function parseListeners(output) {
  const found = [];
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!line || /^(Netid|Proto|Active)/i.test(line)) continue;

    // The local address column is the 4th on ss -ltnpH and netstat -ltnp.
    const columns = line.split(/\s+/);
    const local = columns.find((column) => /:\d+$/.test(column));
    if (!local) continue;

    const port = Number(local.slice(local.lastIndexOf(":") + 1));
    if (!Number.isFinite(port)) continue;

    // users:(("nginx",pid=123,fd=6))  |  123/nginx: master
    const owner =
      /users:\(\("([^"]+)"/.exec(line)?.[1] ||
      /\d+\/([\w.-]+)/.exec(line)?.[1] ||
      null;

    found.push({ port, process: owner });
  }
  return found;
}

export default createSystem;

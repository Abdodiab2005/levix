// Caddy: the one web server Levix will install, and only onto a machine that
// has none.
//
// It is the fresh-server choice because it gets and renews the certificate by
// itself — no certbot step, no cron, nothing for the operator to remember.
//
// On a machine that already runs Caddy we add one import line and one site
// file. We never rewrite somebody's Caddyfile.

const IMPORT_LINE = "import /etc/caddy/levix/*.caddy";
const SITE_DIR = "/etc/caddy/levix";

export function renderSite({ domain, port }) {
  return `# Managed by Levix. Rewritten by \`levix domain ${domain}\`.
${domain} {
    reverse_proxy 127.0.0.1:${port}
}
`;
}

export function sitePath(domain) {
  return `${SITE_DIR}/${domain}.caddy`;
}

/**
 * Add (or update) the Levix site, validate, reload.
 *
 * @returns {{ ok: boolean, path: string, error?: string, reloaded: boolean }}
 */
export function applySite(system, { domain, port, caddyfile = "/etc/caddy/Caddyfile" }) {
  const path = sitePath(domain);

  const existed = system.exists(path);
  const previous = existed ? system.readFile(path) : null;
  const hadCaddyfile = system.exists(caddyfile);
  const previousCaddyfile = hadCaddyfile ? system.readFile(caddyfile) : null;

  system.mkdirp(SITE_DIR);
  system.writeFile(path, renderSite({ domain, port }));

  // One import line, appended once. Everything else in their Caddyfile is
  // theirs and stays exactly as it is.
  const current = hadCaddyfile ? previousCaddyfile : "";
  if (!current.includes(IMPORT_LINE)) {
    system.writeFile(
      caddyfile,
      `${current}${current.endsWith("\n") || current === "" ? "" : "\n"}\n# Added by Levix — loads its site files.\n${IMPORT_LINE}\n`
    );
  }

  const restore = () => {
    if (existed) system.writeFile(path, previous);
    else system.remove(path);
    if (hadCaddyfile) system.writeFile(caddyfile, previousCaddyfile);
    else system.remove(caddyfile);
  };

  const validated = system.run("caddy", ["validate", "--config", caddyfile]);
  if (validated.status !== 0) {
    restore();
    return {
      ok: false,
      path,
      reloaded: false,
      error: (validated.stderr || validated.stdout || "caddy validate failed").trim(),
    };
  }

  const reload = system.run("systemctl", ["reload", "caddy"]);
  if (reload.status !== 0) {
    return {
      ok: false,
      path,
      reloaded: false,
      error: `configuration is valid but Caddy did not reload: ${(reload.stderr || "").trim()}`,
    };
  }

  return { ok: true, path, reloaded: true };
}

/**
 * Install Caddy from its official repository. Only ever called after the
 * operator has said yes, and only on a machine with no web server at all.
 */
export function install(system) {
  if (system.which("caddy")) return { ok: true, skipped: "already installed" };

  if (system.which("apt-get")) {
    const script = [
      "set -e",
      "apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl",
      "curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg",
      "curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt | tee /etc/apt/sources.list.d/caddy-stable.list",
      "apt-get update",
      "apt-get install -y caddy",
    ].join("\n");
    const result = system.run("sh", ["-c", script], { timeoutMs: 300000 });
    if (result.status !== 0) {
      return { ok: false, error: (result.stderr || result.stdout || "").trim() };
    }
    return { ok: true };
  }

  if (system.which("dnf") || system.which("yum")) {
    const manager = system.which("dnf") ? "dnf" : "yum";
    const result = system.run("sh", ["-c", `${manager} install -y caddy`], { timeoutMs: 300000 });
    if (result.status !== 0) {
      return { ok: false, error: (result.stderr || result.stdout || "").trim() };
    }
    return { ok: true };
  }

  return {
    ok: false,
    error: "no supported package manager found (apt-get, dnf or yum)",
  };
}

export { IMPORT_LINE, SITE_DIR };

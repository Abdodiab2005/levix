// What is already on this machine, and what that means Levix may do to it.
//
// The rule the whole file serves: **Levix integrates with the server it finds;
// it does not take over the server.** A VPS may be running somebody's shop.
// Detection therefore never changes anything, and the classification errs
// towards printing instructions rather than editing another program's config.

const PANELS = [
  // Strong signals only: a directory a panel owns, not a package that might
  // have been installed for another reason.
  { name: "Plesk", paths: ["/usr/local/psa", "/opt/psa"] },
  { name: "cPanel / WHM", paths: ["/usr/local/cpanel"] },
  { name: "CyberPanel", paths: ["/usr/local/CyberCP", "/usr/local/CyberPanel"] },
  { name: "aaPanel", paths: ["/www/server/panel"] },
  { name: "CloudPanel", paths: ["/home/clp", "/etc/clp", "/usr/local/bin/clpctl"] },
  { name: "HestiaCP", paths: ["/usr/local/hestia"] },
  { name: "ISPConfig", paths: ["/usr/local/ispconfig"] },
  { name: "Coolify", paths: ["/data/coolify"] },
  { name: "Dokploy", paths: ["/etc/dokploy", "/var/lib/dokploy"] },
  { name: "Virtualmin / Webmin", paths: ["/etc/webmin/virtual-server"] },
];

// Programs we know how to work alongside on ports 80/443. Anything else
// holding those ports means we stop and let a human look.
const KNOWN_WEB_SERVERS = /^(nginx|apache2?|httpd|caddy|haproxy|traefik|litespeed|openlitespeed)$/i;

/**
 * Look at the machine. Changes nothing.
 *
 * @param {import("./system.js").System} system
 * @param {object} [context] - what Levix already knows about itself
 */
export async function inspect(system, context = {}) {
  const panel = PANELS.find((entry) => entry.paths.some((path) => system.exists(path))) || null;

  const nginx = {
    installed: system.which("nginx"),
    sitesAvailable: system.exists("/etc/nginx/sites-available"),
    confD: system.exists("/etc/nginx/conf.d"),
    levixSite: system.exists(nginxSitePath(context.domain, system)),
  };

  const caddy = {
    installed: system.which("caddy"),
    caddyfile: ["/etc/caddy/Caddyfile"].find((path) => system.exists(path)) || null,
  };

  const apache = {
    installed: system.which("apache2") || system.which("httpd"),
  };

  const listeners = system.listeners();
  const ports = {};
  for (const port of [80, 443]) {
    const hit = listeners.find((entry) => entry.port === port);
    ports[port] = hit ? { taken: true, process: hit.process } : { taken: false, process: null };
  }

  return {
    panel: panel ? panel.name : null,
    nginx,
    caddy,
    apache,
    certbot: system.which("certbot"),
    systemd: system.which("systemctl"),
    container: Boolean(context.container),
    root: typeof process.getuid === "function" ? process.getuid() === 0 : false,
    ports,
    listeners,
  };
}

/**
 * Turn a report into a decision.
 *
 * @returns {{ action: string, reason: string, target?: string }}
 *   action is one of:
 *     docker            — instructions; the host's web server isn't ours to touch
 *     panel             — instructions; a control panel owns this web server
 *     blocked           — stop; something unknown holds 80/443
 *     nginx             — configure a Levix site in the existing nginx
 *     caddy             — add a Levix site to the existing Caddy
 *     apache            — instructions; we don't edit Apache automatically
 *     install-caddy     — nothing is installed; offer to install Caddy
 */
export function classify(report) {
  // A container cannot configure the host's proxy, and installing one inside
  // the application image would be a second thing to keep alive.
  if (report.container) {
    return {
      action: "docker",
      reason: "Levix is running inside a container",
    };
  }

  // A panel owns its web server's configuration and will overwrite ours, or
  // break when it can't parse what we wrote.
  if (report.panel) {
    return {
      action: "panel",
      reason: `${report.panel} appears to manage this server`,
      target: report.panel,
    };
  }

  // Something is on 80/443 that we don't recognise. Installing a web server
  // now would collide with it; editing it isn't possible either.
  const unknown = [80, 443]
    .map((port) => ({ port, ...report.ports[port] }))
    .find((entry) => entry.taken && !KNOWN_WEB_SERVERS.test(entry.process || ""));

  if (unknown && !report.nginx.installed && !report.caddy.installed && !report.apache.installed) {
    return {
      action: "blocked",
      reason: `port ${unknown.port} is held by ${unknown.process || "an unknown process"}`,
      target: unknown.process,
    };
  }

  // In order of how well we can work with them.
  if (report.nginx.installed) {
    return { action: "nginx", reason: "nginx is installed and not panel-managed" };
  }
  if (report.caddy.installed) {
    return { action: "caddy", reason: "Caddy is installed" };
  }
  if (report.apache.installed) {
    return {
      action: "apache",
      reason: "Apache is installed, and Levix does not edit it automatically",
    };
  }

  if (unknown) {
    return {
      action: "blocked",
      reason: `port ${unknown.port} is held by ${unknown.process || "an unknown process"}`,
      target: unknown.process,
    };
  }

  return { action: "install-caddy", reason: "no web server is installed" };
}

/** Where a Levix nginx site lives on this distro. */
export function nginxSitePath(domain, system) {
  const name = `levix-${domain || "site"}.conf`;
  if (system.exists("/etc/nginx/sites-available")) return `/etc/nginx/sites-available/${name}`;
  return `/etc/nginx/conf.d/${name}`;
}

/**
 * Does this domain point at this machine?
 *
 * Advisory: without a public IP to compare against (no network, an internal
 * DNS view) it returns `unknown` rather than blocking.
 */
export async function checkDns(system, domain) {
  const [resolved, mine] = await Promise.all([system.resolve(domain), system.publicIp()]);

  if (!resolved.v4.length && !resolved.v6.length) {
    return { status: "unresolved", resolved, mine };
  }
  if (!mine.v4 && !mine.v6) {
    return { status: "unknown", resolved, mine };
  }
  const matches =
    (mine.v4 && resolved.v4.includes(mine.v4)) || (mine.v6 && resolved.v6.includes(mine.v6));

  return { status: matches ? "ok" : "elsewhere", resolved, mine };
}

export { PANELS, KNOWN_WEB_SERVERS };

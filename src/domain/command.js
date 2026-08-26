// `levix domain [name]`
//
// Points a domain at Levix by working with whatever is already on the server.
// It inspects first, decides second, and asks before it changes anything. On a
// machine it does not understand it prints the exact reverse-proxy settings a
// person would need and changes nothing at all.
//
// The bot itself never needs root. This command may, and says so when it does.

import readline from "node:readline/promises";
import { createRequire } from "node:module";

import { createSystem } from "./system.js";
import { inspect, classify, checkDns } from "./detect.js";
import * as nginx from "./nginx.js";
import * as caddy from "./caddy.js";

const require = createRequire(import.meta.url);
const settings = require("../config/settings.cjs");
const { inContainer } = require("../utils/openBrowser.cjs");

const line = (text = "") => console.log(text);
const tick = (text) => line(`  ✓ ${text}`);
const cross = (text) => line(`  ✗ ${text}`);

// A hostname, not a URL and not an IP. Anything else is a typo we can catch
// before it reaches certbot.
const DOMAIN_PATTERN = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i;

/** Short, reliable guidance per panel. No panel APIs — just where to click. */
const PANEL_HINTS = {
  "CloudPanel": 'Sites → Add Site → Reverse Proxy, then "SSL/TLS → Let\'s Encrypt".',
  "Plesk": "Domains → Hosting & DNS → Apache & nginx Settings → additional nginx directives.",
  "cPanel / WHM": "WHM → Apache → Reverse Proxy (or ProxyPass in an include file).",
  "CyberPanel": "Websites → Manage → vHost Conf, then Issue SSL.",
  "aaPanel": "Website → Settings → Reverse proxy, then Let's Encrypt under SSL.",
  "HestiaCP": "Web → Edit domain → Proxy Template, then enable Let's Encrypt.",
  "ISPConfig": "Sites → Options → nginx Directives.",
  "Coolify": "Add a service pointing at the host port, and let Coolify terminate TLS.",
  "Dokploy": "Create an application/domain entry pointing at the host port.",
  "Virtualmin / Webmin": "Services → Configure Website → Edit Directives.",
};

function proxyInstructions(domain, port, { https = "your panel" } = {}) {
  line();
  line("  Configure a reverse proxy with:");
  line();
  line(`    Domain:     ${domain}`);
  line(`    Upstream:   http://127.0.0.1:${port}`);
  line("    WebSocket:  required (the panel pushes the pairing QR over it)");
  line(`    HTTPS:      enable from ${https}`);
  line();
}

async function ask(question, { assumeYes }) {
  if (assumeYes) return true;
  if (!process.stdin.isTTY) {
    line();
    line("  Not running interactively. Re-run with --yes to accept, or run it in a terminal.");
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`  ${question} [Y/n] `)).trim().toLowerCase();
    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

async function askDomain({ assumeYes }) {
  if (assumeYes || !process.stdin.isTTY) return null;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question("  Domain (e.g. bot.example.com): ")).trim();
  } finally {
    rl.close();
  }
}

/**
 * Remember the domain. `proxied` is what decides the security-relevant part:
 * only a proxy we actually put in front justifies trusting one hop of
 * forwarded headers, and only then is it safe to stop listening publicly.
 */
function persist({ domain, proxied }) {
  settings.set("public_domain", domain);
  if (proxied) {
    // Exactly one hop: the proxy on this machine. See src/utils/requestOrigin.cjs
    // for why this does not weaken the first-run check.
    settings.set("trust_proxy", "1");
    // Nobody should be able to reach the panel past the certificate by asking
    // for the raw port.
    settings.set("bind_address", "127.0.0.1");
  }
}

export async function runDomainCommand({ domain = null, assumeYes = false, system } = {}) {
  const sys = system || createSystem();
  const port = settings.get("port");

  line();
  line("  Levix — domain setup");
  line();

  let name = domain || (await askDomain({ assumeYes }));
  if (!name) {
    cross("No domain given. Try: levix domain bot.example.com");
    return 1;
  }
  name = name.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");

  if (!DOMAIN_PATTERN.test(name)) {
    cross(`"${name}" doesn't look like a domain name.`);
    return 1;
  }

  const report = await inspect(sys, { domain: name, container: inContainer() });
  const decision = classify(report);

  printFindings(report);

  switch (decision.action) {
    case "docker":
      line("  Levix is running inside a container.");
      line("  A container cannot — and should not — configure the host's web server.");
      proxyInstructions(name, port, { https: "the host proxy" });
      persist({ domain: name, proxied: false });
      tick(`Saved ${name} as the public address.`);
      return 0;

    case "panel": {
      line(`  Detected: ${decision.target}`);
      line();
      line("  This server appears to be managed by a hosting panel, so Levix will not");
      line("  touch its web server configuration — the panel would overwrite it, or");
      line("  break on it.");
      proxyInstructions(name, port, { https: decision.target });
      const hint = PANEL_HINTS[decision.target];
      if (hint) line(`  In ${decision.target}: ${hint}\n`);
      persist({ domain: name, proxied: false });
      tick(`Saved ${name} as the public address.`);
      return 0;
    }

    case "apache":
      line("  Apache is installed.");
      line();
      line("  Levix does not edit Apache automatically: doing it correctly depends on");
      line("  which modules and vhost layout this server uses, and getting it wrong");
      line("  takes other sites down with it.");
      proxyInstructions(name, port, { https: "certbot --apache" });
      line("  The proxy needs mod_proxy, mod_proxy_http and mod_proxy_wstunnel.");
      line();
      persist({ domain: name, proxied: false });
      return 0;

    case "blocked":
      cross(`Port 80/443 is in use by ${decision.target || "an unknown service"}.`);
      line();
      line("  Levix will not install or reconfigure a web server on top of something");
      line("  it doesn't recognise — that would take the other service down.");
      proxyInstructions(name, port, { https: "that service" });
      return 1;

    case "nginx":
      return configureNginx(sys, { name, port, report, assumeYes });

    case "caddy":
      return configureCaddy(sys, { name, port, report, assumeYes, install: false });

    case "install-caddy":
      return configureCaddy(sys, { name, port, report, assumeYes, install: true });

    default:
      cross(`Nothing to do (${decision.reason}).`);
      return 1;
  }
}

function printFindings(report) {
  const found = [];
  if (report.nginx.installed) found.push("nginx");
  if (report.apache.installed) found.push("Apache");
  if (report.caddy.installed) found.push("Caddy");
  if (report.certbot) found.push("certbot");
  if (report.panel) found.push(report.panel);

  line(`  Found: ${found.length ? found.join(", ") : "no web server"}`);
  for (const port of [80, 443]) {
    const state = report.ports[port];
    line(`  Port ${port}: ${state.taken ? `in use by ${state.process || "an unknown process"}` : "free"}`);
  }
  line();
}

function requireRoot(report) {
  if (report.root) return true;
  cross("This step edits files under /etc, so it needs root.");
  line();
  line("  Re-run it as: sudo levix domain <name>");
  line();
  return false;
}

async function confirmDns(sys, name, { assumeYes }) {
  const dnsCheck = await checkDns(sys, name);

  if (dnsCheck.status === "ok") {
    tick("DNS points at this server");
    return true;
  }

  if (dnsCheck.status === "unknown") {
    line("  ? Could not confirm DNS (no public IP available from here).");
    return ask("Continue anyway?", { assumeYes });
  }

  const ip = dnsCheck.mine.v4 || dnsCheck.mine.v6 || "<this server's IP>";
  const [subdomain, ...rest] = name.split(".");
  const isApex = rest.length < 2;

  cross(
    dnsCheck.status === "unresolved"
      ? `${name} does not resolve yet.`
      : `${name} resolves to ${dnsCheck.resolved.v4.join(", ") || dnsCheck.resolved.v6.join(", ")}, not to this server.`
  );
  line();
  line("  Add this DNS record:");
  line();
  line(`    Type:  A`);
  line(`    Name:  ${isApex ? "@" : subdomain}`);
  line(`    Value: ${ip}`);
  if (dnsCheck.mine.v6) {
    line();
    line(`    Type:  AAAA`);
    line(`    Name:  ${isApex ? "@" : subdomain}`);
    line(`    Value: ${dnsCheck.mine.v6}`);
  }
  line();
  line("  DNS can take a few minutes. HTTPS can't be issued until it resolves.");
  line();

  return ask("Continue without HTTPS for now?", { assumeYes });
}

async function configureNginx(sys, { name, port, report, assumeYes }) {
  if (!requireRoot(report)) return 1;

  const dnsOk = await confirmDns(sys, name, { assumeYes });
  if (!dnsOk) {
    line("  Stopped. Nothing was changed.");
    return 1;
  }

  line();
  line(`  Levix will add one nginx site for ${name} and leave every other site alone.`);
  if (!(await ask("Continue?", { assumeYes }))) {
    line("  Stopped. Nothing was changed.");
    return 1;
  }

  const applied = nginx.applySite(sys, { domain: name, port });
  if (!applied.ok) {
    cross("nginx rejected the configuration — nothing was reloaded.");
    line();
    line(applied.error.split("\n").map((l) => `    ${l}`).join("\n"));
    line();
    line("  The previous state has been restored.");
    return 1;
  }

  tick(`nginx site written to ${applied.path}`);
  tick("nginx -t passed");
  tick("nginx reloaded");

  let https = false;
  if (report.certbot) {
    if (await ask("Issue an HTTPS certificate with certbot?", { assumeYes })) {
      const cert = nginx.ensureCertificate(sys, { domain: name });
      if (cert.ok) {
        https = true;
        tick(cert.skipped ? `HTTPS: ${cert.skipped}` : "HTTPS certificate issued");
      } else {
        cross("certbot failed — the site is up over HTTP.");
        line();
        line(cert.error.split("\n").slice(0, 8).map((l) => `    ${l}`).join("\n"));
        line();
      }
    }
  } else {
    line();
    line("  certbot is not installed, so the site is HTTP only for now.");
    line("  To add HTTPS later:");
    line("    apt install certbot python3-certbot-nginx");
    line(`    certbot --nginx -d ${name}`);
    line();
  }

  persist({ domain: name, proxied: true });
  finalUrl(name, https, { restart: true });
  return 0;
}

async function configureCaddy(sys, { name, port, report, assumeYes, install }) {
  if (!requireRoot(report)) return 1;

  if (install) {
    line("  No reverse proxy was detected.");
    line("  Caddy is the simplest option here: it gets and renews HTTPS by itself.");
    line();
    if (!(await ask("Install Caddy and configure HTTPS?", { assumeYes }))) {
      line("  Stopped. Nothing was installed.");
      proxyInstructions(name, port, { https: "whatever proxy you prefer" });
      return 1;
    }

    const dnsOk = await confirmDns(sys, name, { assumeYes });
    if (!dnsOk) {
      line("  Stopped before installing anything.");
      return 1;
    }

    const installed = caddy.install(sys);
    if (!installed.ok) {
      cross(`Could not install Caddy: ${installed.error}`);
      return 1;
    }
    tick(installed.skipped ? "Caddy was already installed" : "Caddy installed");
  } else {
    line("  Caddy is already running here — Levix will add one site to it.");
    if (!(await ask("Continue?", { assumeYes }))) {
      line("  Stopped. Nothing was changed.");
      return 1;
    }
    const dnsOk = await confirmDns(sys, name, { assumeYes });
    if (!dnsOk) {
      line("  Stopped. Nothing was changed.");
      return 1;
    }
  }

  const applied = caddy.applySite(sys, {
    domain: name,
    port,
    caddyfile: report.caddy.caddyfile || "/etc/caddy/Caddyfile",
  });
  if (!applied.ok) {
    cross("Caddy rejected the configuration — nothing was reloaded.");
    line();
    line(applied.error.split("\n").map((l) => `    ${l}`).join("\n"));
    line();
    return 1;
  }

  tick(`Caddy site written to ${applied.path}`);
  tick("caddy validate passed");
  tick("Caddy reloaded");
  tick("HTTPS will be issued automatically on the first request");

  persist({ domain: name, proxied: true });
  finalUrl(name, true, { restart: true });
  return 0;
}

function finalUrl(name, https, { restart }) {
  tick("Levix proxy settings updated");
  line();
  line(`  Levix will be available at:`);
  line();
  line(`    ${https ? "https" : "http"}://${name}`);
  line();
  if (restart) {
    line("  Restart Levix for the new bind address to take effect:");
    line("    systemctl restart levix     (or stop and start it however you run it)");
    line();
  }
}

export default runDomainCommand;

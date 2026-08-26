// Adding one nginx site, and nothing else.
//
// The safety contract, in order:
//
//   1. write only a file named after Levix, in the directory this distro uses
//   2. enable it the way this distro enables sites
//   3. `nginx -t` — the whole configuration, not just ours
//   4. if that fails: put back exactly what was there, print nginx's own words,
//      do NOT reload
//   5. only then reload (never restart: a restart drops every live connection
//      on a server that may be serving somebody else's site)
//
// Running it twice with the same domain rewrites the same file. No timestamped
// piles of backups, no second server block.

import { nginxSitePath } from "./detect.js";

/** The site itself. WebSocket upgrade included — socket.io needs it. */
export function renderSite({ domain, port }) {
  return `# Managed by Levix. Rewritten by \`levix domain ${domain}\`.
# Delete this file to remove the site; nothing else here is Levix's.
server {
    listen 80;
    listen [::]:80;
    server_name ${domain};

    location / {
        proxy_pass http://127.0.0.1:${port};

        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # The control panel pushes the pairing QR over socket.io.
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # A QR can sit open for a while before it is scanned.
        proxy_read_timeout 300s;
    }
}
`;
}

/**
 * Write, validate, and only then reload.
 *
 * @returns {{ ok: boolean, path: string, error?: string, reloaded: boolean }}
 */
export function applySite(system, { domain, port }) {
  const path = nginxSitePath(domain, system);
  const usesSitesAvailable = path.includes("/sites-available/");
  const enabledPath = usesSitesAvailable
    ? path.replace("/sites-available/", "/sites-enabled/")
    : null;

  // What was there before, so a failed `nginx -t` can be undone precisely.
  const existed = system.exists(path);
  const previous = existed ? system.readFile(path) : null;

  const restore = () => {
    if (existed) system.writeFile(path, previous);
    else {
      system.remove(path);
      if (enabledPath) system.remove(enabledPath);
    }
  };

  system.writeFile(path, renderSite({ domain, port }));
  if (enabledPath) system.symlink(path, enabledPath);

  const test = system.run("nginx", ["-t"]);
  if (test.status !== 0) {
    restore();
    return {
      ok: false,
      path,
      reloaded: false,
      // nginx's own message names the file and the line. Ours would not.
      error: (test.stderr || test.stdout || "nginx -t failed").trim(),
    };
  }

  const reload = system.run("systemctl", ["reload", "nginx"]);
  if (reload.status !== 0) {
    // The configuration is valid, so leave it in place — but say plainly that
    // it is not live yet.
    return {
      ok: false,
      path,
      reloaded: false,
      error: `configuration is valid but nginx did not reload: ${(reload.stderr || "").trim()}`,
    };
  }

  return { ok: true, path, reloaded: true };
}

/**
 * Ask certbot for a certificate, if there isn't already a live one.
 *
 * @returns {{ ok: boolean, skipped?: string, error?: string }}
 */
export function ensureCertificate(system, { domain, email = null }) {
  if (hasCertificate(system, domain)) {
    return { ok: true, skipped: "a certificate for this domain already exists" };
  }

  const args = [
    "--nginx",
    "-d",
    domain,
    "--non-interactive",
    "--agree-tos",
    "--redirect",
    ...(email ? ["-m", email] : ["--register-unsafely-without-email"]),
  ];

  const result = system.run("certbot", args, { timeoutMs: 180000 });
  if (result.status !== 0) {
    return { ok: false, error: (result.stderr || result.stdout || "certbot failed").trim() };
  }
  return { ok: true };
}

/** Is there already a certificate covering this domain? */
export function hasCertificate(system, domain) {
  if (system.exists(`/etc/letsencrypt/live/${domain}/fullchain.pem`)) return true;

  // A certificate can live under a different lineage name while still covering
  // the domain; certbot knows.
  const listed = system.run("certbot", ["certificates"]);
  if (listed.status !== 0) return false;
  return new RegExp(`Domains:.*\\b${domain.replace(/\./g, "\\.")}\\b`).test(listed.stdout);
}

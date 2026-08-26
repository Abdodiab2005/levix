// `levix domain` — deciding what a server is, and touching as little as
// possible.
//
// None of this runs against the real machine. A fake system describes a
// server — "nginx and certbot, port 443 held by apache, a CloudPanel
// directory" — and records every command and every file write, so the tests
// can assert on what Levix *would* do to somebody's production box.

import { useTempDataDir, require, section, ok, equal, finish } from "./harness.mjs";

useTempDataDir("levix-domain");

const { inspect, classify } = await import("../src/domain/detect.js");
const nginx = await import("../src/domain/nginx.js");
const caddy = await import("../src/domain/caddy.js");
const { parseListeners } = await import("../src/domain/system.js");

/**
 * A server described in one object.
 *
 * @param {object} spec
 * @param {string[]} spec.commands - what `which` finds
 * @param {string[]} spec.paths - what exists on disk
 * @param {object[]} spec.listeners - [{port, process}]
 * @param {object} spec.results - scripted { "nginx -t": {status, stderr} }
 */
function fakeSystem({ commands = [], paths = [], listeners = [], results = {}, files = {} } = {}) {
  const disk = new Map(Object.entries(files));
  for (const path of paths) if (!disk.has(path)) disk.set(path, "");

  const calls = [];
  const writes = [];
  const removed = [];

  return {
    calls,
    writes,
    removed,
    disk,
    run(command, args = []) {
      const key = [command, ...args].join(" ");
      calls.push(key);
      const scripted = results[key] ?? results[command];
      return { status: 0, stdout: "", stderr: "", ...(scripted || {}) };
    },
    which: (command) => commands.includes(command),
    exists: (path) => disk.has(path),
    readFile: (path) => disk.get(path) ?? "",
    writeFile(path, content) {
      writes.push(path);
      disk.set(path, content);
    },
    mkdirp(path) {
      disk.set(path, "");
    },
    remove(path) {
      removed.push(path);
      disk.delete(path);
    },
    symlink(from, to) {
      writes.push(to);
      disk.set(to, `-> ${from}`);
    },
    listeners: () => listeners,
    async resolve() {
      return { v4: [], v6: [] };
    },
    async publicIp() {
      return { v4: null, v6: null };
    },
  };
}

const NGINX_LAYOUT = ["/etc/nginx/sites-available", "/etc/nginx/sites-enabled"];

// --- classification -------------------------------------------------------

section("what kind of server is this?");

const scenarios = [
  {
    label: "nginx + certbot",
    spec: { commands: ["nginx", "certbot", "systemctl"], paths: NGINX_LAYOUT, listeners: [{ port: 80, process: "nginx" }, { port: 443, process: "nginx" }] },
    expect: "nginx",
  },
  {
    label: "nginx without certbot",
    spec: { commands: ["nginx", "systemctl"], paths: NGINX_LAYOUT, listeners: [{ port: 80, process: "nginx" }] },
    expect: "nginx",
  },
  {
    label: "caddy",
    spec: { commands: ["caddy", "systemctl"], paths: ["/etc/caddy/Caddyfile"], listeners: [{ port: 443, process: "caddy" }] },
    expect: "caddy",
  },
  {
    label: "apache",
    spec: { commands: ["apache2", "systemctl"], listeners: [{ port: 80, process: "apache2" }] },
    expect: "apache",
  },
  {
    label: "an empty server",
    spec: { commands: ["systemctl", "apt-get"], listeners: [] },
    expect: "install-caddy",
  },
  {
    label: "something unknown on :443",
    spec: { commands: ["systemctl"], listeners: [{ port: 443, process: "some-app" }] },
    expect: "blocked",
  },
  {
    label: "something unknown on :80",
    spec: { commands: ["systemctl"], listeners: [{ port: 80, process: "node" }] },
    expect: "blocked",
  },
  {
    label: "a port in use with no owner visible",
    spec: { commands: ["systemctl"], listeners: [{ port: 443, process: null }] },
    expect: "blocked",
  },
];

for (const { label, spec, expect } of scenarios) {
  const system = fakeSystem(spec);
  const report = await inspect(system, { domain: "bot.example.com" });
  const decision = classify(report);
  equal(`${label} -> ${expect}`, decision.action, expect);
  ok(`${label} explains itself`, typeof decision.reason === "string" && decision.reason.length > 0);
}

section("a hosting panel is never touched");

for (const [panel, path] of [
  ["Plesk", "/usr/local/psa"],
  ["cPanel / WHM", "/usr/local/cpanel"],
  ["CyberPanel", "/usr/local/CyberCP"],
  ["aaPanel", "/www/server/panel"],
  ["CloudPanel", "/home/clp"],
  ["HestiaCP", "/usr/local/hestia"],
  ["ISPConfig", "/usr/local/ispconfig"],
  ["Coolify", "/data/coolify"],
  ["Dokploy", "/etc/dokploy"],
]) {
  // Even with a perfectly configurable nginx sitting right there.
  const system = fakeSystem({
    commands: ["nginx", "certbot", "systemctl"],
    paths: [...NGINX_LAYOUT, path],
    listeners: [{ port: 443, process: "nginx" }],
  });
  const decision = classify(await inspect(system, { domain: "bot.example.com" }));
  equal(`${panel} -> instructions only`, decision.action, "panel");
  equal(`${panel} is named`, decision.target, panel);
}

section("a container configures nothing");

{
  const system = fakeSystem({ commands: ["nginx", "systemctl"], paths: NGINX_LAYOUT });
  const decision = classify(await inspect(system, { domain: "x.example.com", container: true }));
  equal("inside Docker -> instructions", decision.action, "docker");
}

section("reading who owns a port");

{
  const ss = `LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=880,fd=6))
LISTEN 0 511 [::]:443 [::]:* users:(("caddy",pid=901,fd=9))`;
  const parsed = parseListeners(ss);
  equal("two listeners found", parsed.length, 2);
  equal("port 80 is nginx", parsed.find((p) => p.port === 80).process, "nginx");
  equal("port 443 is caddy", parsed.find((p) => p.port === 443).process, "caddy");

  const netstat = "tcp 0 0 0.0.0.0:80 0.0.0.0:* LISTEN 880/nginx: master";
  equal("netstat output parses too", parseListeners(netstat)[0].process, "nginx");
  equal("a header line is ignored", parseListeners("Proto Recv-Q Send-Q Local").length, 0);
}

// --- nginx ---------------------------------------------------------------

section("the nginx site Levix writes");

{
  const site = nginx.renderSite({ domain: "bot.example.com", port: 3001 });
  ok("names the domain", site.includes("server_name bot.example.com;"));
  ok("proxies to the local port only", site.includes("proxy_pass http://127.0.0.1:3001;"));
  ok("sets HTTP/1.1, which WebSocket needs", site.includes("proxy_http_version 1.1;"));
  ok("passes the Upgrade header", site.includes("proxy_set_header Upgrade $http_upgrade;"));
  ok("passes the Connection header", site.includes('proxy_set_header Connection "upgrade";'));
  ok("passes X-Forwarded-For", site.includes("X-Forwarded-For $proxy_add_x_forwarded_for;"));
  ok("passes X-Forwarded-Proto", site.includes("X-Forwarded-Proto $scheme;"));
  ok("says who manages it", site.includes("Managed by Levix"));
}

section("applying it: validate, then reload");

{
  const system = fakeSystem({ commands: ["nginx", "systemctl"], paths: NGINX_LAYOUT });
  const result = nginx.applySite(system, { domain: "bot.example.com", port: 3001 });

  ok("it succeeds", result.ok === true);
  equal("the site goes in sites-available", result.path, "/etc/nginx/sites-available/levix-bot.example.com.conf");
  ok("and is enabled by symlink", system.disk.has("/etc/nginx/sites-enabled/levix-bot.example.com.conf"));

  const testIndex = system.calls.indexOf("nginx -t");
  const reloadIndex = system.calls.indexOf("systemctl reload nginx");
  ok("nginx -t ran", testIndex !== -1);
  ok("the reload ran", reloadIndex !== -1);
  ok("and it ran only after the test passed", testIndex < reloadIndex);
  ok("nginx was never restarted", !system.calls.some((c) => c.includes("restart nginx")));

  const touched = system.writes.filter((path) => !path.includes("levix-"));
  ok("no file outside Levix's own was written", touched.length === 0, touched.join(" "));
}

section("a configuration nginx rejects is never reloaded");

{
  const system = fakeSystem({
    commands: ["nginx", "systemctl"],
    paths: NGINX_LAYOUT,
    results: {
      "nginx -t": { status: 1, stderr: "nginx: [emerg] duplicate server name /etc/nginx/x:3" },
    },
  });
  const result = nginx.applySite(system, { domain: "bot.example.com", port: 3001 });

  ok("it reports failure", result.ok === false);
  ok("it did not reload", result.reloaded === false);
  ok("nothing was reloaded at all", !system.calls.some((c) => c.includes("reload")));
  ok("nginx's own message is passed through", result.error.includes("duplicate server name"));
  ok("the half-written site was removed", !system.disk.has(result.path));
  ok("…and so was its symlink", !system.disk.has("/etc/nginx/sites-enabled/levix-bot.example.com.conf"));
}

section("a Levix site that already exists is restored on failure");

{
  const path = "/etc/nginx/sites-available/levix-bot.example.com.conf";
  const system = fakeSystem({
    commands: ["nginx", "systemctl"],
    paths: NGINX_LAYOUT,
    files: { [path]: "# the previous Levix site\n" },
    results: { "nginx -t": { status: 1, stderr: "nginx: [emerg] bad" } },
  });
  nginx.applySite(system, { domain: "bot.example.com", port: 3001 });
  equal("the previous content is back", system.disk.get(path), "# the previous Levix site\n");
}

section("running it twice changes nothing the second time");

{
  const system = fakeSystem({ commands: ["nginx", "systemctl"], paths: NGINX_LAYOUT });
  const first = nginx.applySite(system, { domain: "bot.example.com", port: 3001 });
  const contentAfterFirst = system.disk.get(first.path);
  const second = nginx.applySite(system, { domain: "bot.example.com", port: 3001 });

  equal("the same file is used", second.path, first.path);
  equal("with identical content", system.disk.get(second.path), contentAfterFirst);
  const levixFiles = [...system.disk.keys()].filter((p) => p.includes("levix-"));
  equal("and there is exactly one site file plus its symlink", levixFiles.length, 2);
}

section("conf.d layouts work too");

{
  const system = fakeSystem({ commands: ["nginx", "systemctl"], paths: ["/etc/nginx/conf.d"] });
  const result = nginx.applySite(system, { domain: "bot.example.com", port: 3001 });
  equal("the site lands in conf.d", result.path, "/etc/nginx/conf.d/levix-bot.example.com.conf");
  ok("no sites-enabled symlink is invented", ![...system.disk.keys()].some((p) => p.includes("sites-enabled")));
}

section("certificates are not issued twice");

{
  const system = fakeSystem({
    commands: ["certbot"],
    paths: ["/etc/letsencrypt/live/bot.example.com/fullchain.pem"],
  });
  const result = nginx.ensureCertificate(system, { domain: "bot.example.com" });
  ok("it succeeds", result.ok === true);
  ok("it says it skipped", Boolean(result.skipped));
  ok("certbot was never asked for a new one", !system.calls.some((c) => c.startsWith("certbot --nginx")));
}

{
  const system = fakeSystem({ commands: ["certbot"] });
  const result = nginx.ensureCertificate(system, { domain: "bot.example.com" });
  ok("a missing certificate is requested", result.ok === true);
  ok(
    "…non-interactively, for that domain only",
    system.calls.some((c) => c.includes("--nginx -d bot.example.com") && c.includes("--non-interactive"))
  );
}

{
  const system = fakeSystem({
    commands: ["certbot"],
    results: { certbot: { status: 1, stderr: "DNS problem: NXDOMAIN looking up A" } },
  });
  const result = nginx.ensureCertificate(system, { domain: "bot.example.com" });
  ok("a certbot failure is reported, not swallowed", result.ok === false);
  ok("with certbot's own words", result.error.includes("NXDOMAIN"));
}

// --- caddy ---------------------------------------------------------------

section("the Caddy site");

{
  const system = fakeSystem({
    commands: ["caddy", "systemctl"],
    files: { "/etc/caddy/Caddyfile": "example.com {\n  respond \"hi\"\n}\n" },
  });
  const result = caddy.applySite(system, { domain: "bot.example.com", port: 3001 });

  ok("it succeeds", result.ok === true);
  equal("the site is its own file", result.path, "/etc/caddy/levix/bot.example.com.caddy");
  ok("which reverse-proxies to the local port", system.disk.get(result.path).includes("reverse_proxy 127.0.0.1:3001"));

  const caddyfile = system.disk.get("/etc/caddy/Caddyfile");
  ok("the existing Caddyfile is preserved", caddyfile.includes('example.com {'));
  ok("with one import line added", caddyfile.includes(caddy.IMPORT_LINE));

  const validateIndex = system.calls.findIndex((c) => c.startsWith("caddy validate"));
  const reloadIndex = system.calls.indexOf("systemctl reload caddy");
  ok("it validated first", validateIndex !== -1 && validateIndex < reloadIndex);

  // Second run: the import must not pile up.
  caddy.applySite(system, { domain: "bot.example.com", port: 3001 });
  const occurrences = system.disk.get("/etc/caddy/Caddyfile").split(caddy.IMPORT_LINE).length - 1;
  equal("the import line appears exactly once", occurrences, 1);
}

section("a Caddyfile Caddy rejects is rolled back");

{
  const original = "example.com {\n  respond \"hi\"\n}\n";
  const system = fakeSystem({
    commands: ["caddy", "systemctl"],
    files: { "/etc/caddy/Caddyfile": original },
    results: { caddy: { status: 1, stderr: "adapt: line 3: unrecognized directive" } },
  });
  const result = caddy.applySite(system, { domain: "bot.example.com", port: 3001 });

  ok("it reports failure", result.ok === false);
  ok("nothing was reloaded", !system.calls.some((c) => c.includes("reload")));
  ok("Caddy's own message is passed through", result.error.includes("unrecognized directive"));
  equal("the operator's Caddyfile is exactly as it was", system.disk.get("/etc/caddy/Caddyfile"), original);
  ok("and the site file is gone", !system.disk.has(result.path));
}

section("installing Caddy needs a package manager it knows");

{
  const none = caddy.install(fakeSystem({ commands: [] }));
  ok("an unknown distro is refused rather than guessed at", none.ok === false);
  ok("…with a reason", none.error.includes("package manager"));

  const already = caddy.install(fakeSystem({ commands: ["caddy"] }));
  ok("an existing Caddy is left alone", already.ok === true && Boolean(already.skipped));
}

finish();

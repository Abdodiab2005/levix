// What actually goes in the npm tarball.
//
// `npm start` from a git clone proves nothing about the published package: it
// reads files the tarball may not carry. This checks the manifest itself.
// scripts/validate-tarball.mjs goes further and boots the packed artifact —
// this one is the fast tripwire that runs on every `npm test`.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { require, ROOT, section, ok, equal, finish } from "./harness.mjs";

const pkg = require("./package.json");

const packed = spawnSync("npm", ["pack", "--dry-run", "--json"], {
  cwd: ROOT,
  encoding: "utf8",
  env: { ...process.env, npm_config_loglevel: "silent" },
});

if (packed.status !== 0) {
  console.log(`    npm pack failed: ${packed.stderr.slice(0, 400)}`);
  ok("npm pack --dry-run succeeds", false);
  finish();
  process.exit(1);
}

const manifest = JSON.parse(packed.stdout)[0];
const files = manifest.files.map((entry) => entry.path);
const has = (path) => files.includes(path);
const hasUnder = (prefix) => files.some((path) => path.startsWith(prefix));

section("the package is complete");

ok("npm pack --dry-run succeeds", true);
equal("it is named levix-bot", manifest.name, "levix-bot");
equal("at the version in package.json", manifest.version, pkg.version);

for (const required of [
  "package.json",
  "app.cjs",
  "scheduler.cjs",
  "bin/levix.js",
  "src/index.js",
  "src/config/paths.cjs",
  "src/config/secrets.cjs",
  "src/config/defaults.cjs",
  "src/config/ai-persona.md",
  "src/db/db.cjs",
  "src/db/store.cjs",
  "views/setup.ejs",
  "views/login.ejs",
  "views/dashboard.ejs",
  "views/qr.ejs",
  "public/dashboard.css",
  "public/dashboard.js",
  "public/qrcode.min.js",
  "public/socket.io.min.js",
  "deploy/levix.service",
  "deploy/install.sh",
]) {
  ok(`ships ${required}`, has(required));
}

ok("ships the brand assets the panel renders", hasUnder("public/brand/"));
ok("ships every command", files.filter((f) => f.startsWith("src/commands/")).length > 50);
ok("ships the group sub-commands", hasUnder("src/commands/group/"));

section("everything package.json promises is really in there");

// A `files` entry that matches nothing is how a package ends up missing its
// own licence or its service unit.
for (const entry of pkg.files || []) {
  const clean = entry.replace(/\/$/, "");
  const present = has(clean) || hasUnder(`${clean}/`);
  ok(`files[] entry "${entry}" matches something`, present);
}

ok(
  "the LICENSE file the manifest declares exists",
  existsSync(join(ROOT, "LICENSE")),
  `license field says ${pkg.license}`
);

section("and nothing that shouldn't be");

const forbidden = [
  [/(^|\/)\.env/, ".env files"],
  [/\.db($|-wal|-shm)/, "database files"],
  [/(^|\/)data\//, "a runtime data directory"],
  [/(^|\/)logs?\//, "log directories"],
  [/(^|\/)memory\//, "memory files"],
  [/(^|\/)build\//, "build output"],
  [/(^|\/)tests?\//, "the test suite"],
  [/(^|\/)node_modules\//, "node_modules"],
  [/(^|\/)assets\/brand\/source\//, "the logo sources"],
  [/_manifest\.cjs$/, "a generated SEA manifest"],
  [/\.tgz$/, "a packed tarball"],
  [/(^|\/)\.github\//, "CI workflows"],
  [/(^|\/)Dockerfile$/, "the Dockerfile"],
  [/levix\.lock$/, "a lock file"],
];

for (const [pattern, label] of forbidden) {
  const offenders = files.filter((path) => pattern.test(path));
  ok(`no ${label}`, offenders.length === 0, offenders.slice(0, 3).join(" "));
}

section("it is a sensible size");

// Not a style rule: a tarball that suddenly triples has picked something up.
ok(
  `unpacked size is under 5 MB (${(manifest.unpackedSize / 1e6).toFixed(1)} MB)`,
  manifest.unpackedSize < 5_000_000
);
ok(`file count is plausible (${manifest.entryCount})`, manifest.entryCount > 100 && manifest.entryCount < 400);

section("the manifest itself");

equal("declares a bin", typeof pkg.bin?.levix, "string");
ok("the bin file exists", existsSync(join(ROOT, pkg.bin.levix)));
ok("requires Node 24+", /(>=\s*24|\^24|24\.x)/.test(pkg.engines?.node || ""));
ok("has no mongoose dependency", !("mongoose" in (pkg.dependencies || {})));
ok("has no dotenv dependency", !("dotenv" in (pkg.dependencies || {})));
ok(
  "keeps the SEA build tools out of runtime dependencies",
  !("esbuild" in (pkg.dependencies || {})) && !("postject" in (pkg.dependencies || {}))
);

finish();

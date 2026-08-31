// The public installer: how it is generated for a release, and how it is put
// in place on the download server.
//
// The part that can do damage is the publishing step — it replaces a file that
// people are piping into root shells. That part is a shell script precisely so
// this file can run it against a temporary directory instead of trusting a
// review of some YAML.

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, section, ok, equal, throws, finish } from "./harness.mjs";
import { parseTag, buildInstaller, verifyInstaller, generate, SOURCE } from "../scripts/build-release-installer.mjs";

const PUBLISH = join(ROOT, "scripts", "publish-installer.sh");
const source = readFileSync(SOURCE, "utf8");

const work = mkdtempSync(join(tmpdir(), "levix-installer-"));
process.on("exit", () => {
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {}
});

const bash = (...args) => spawnSync("bash", args, { encoding: "utf8" });
const read = (path) => (existsSync(path) ? readFileSync(path, "utf8") : null);
const mode = (path) => (existsSync(path) ? (statSync(path).mode & 0o777).toString(8) : null);

// --------------------------------------------------------------------------

section("the installer in git is the only source");

ok("deploy/install.sh is valid shell", bash("-n", SOURCE).status === 0);

const versionLines = source.match(/^VERSION="[^"\n]*"$/gm) || [];
equal("it has exactly one VERSION line", versionLines.length, 1);
equal("which is unpinned in git", versionLines[0], 'VERSION="latest"');
ok(
  "and the install step uses it",
  /npm install -g "\$\{PACKAGE\}@\$\{VERSION\}"/.test(source)
);
ok(
  "no generated installer was committed",
  !existsSync(join(ROOT, "deploy", "install-v2.0.0.sh")) &&
    (spawnSync("git", ["ls-files", "deploy/install-*.sh", "deploy/install/*"], {
      cwd: ROOT,
      encoding: "utf8",
    }).stdout || "").trim() === ""
);

// --------------------------------------------------------------------------

section("a release tag is validated before it becomes a path");

for (const good of ["v2.0.0", "v2.0.1", "v2.1.0", "v3.0.0", "v10.20.30", "2.0.1"]) {
  const parsed = parseTag(good);
  ok(`accepts ${good}`, parsed.version.length > 0);
}

equal("v2.0.1 is stable", parseTag("v2.0.1").stable, true);
equal("v2.1.0-rc.1 is not", parseTag("v2.1.0-rc.1").stable, false);
equal("v2.1.0-beta.1 is not", parseTag("v2.1.0-beta.1").stable, false);
equal("a bare tag is normalised", parseTag("2.0.1").tag, "v2.0.1");

for (const bad of [
  "",
  "v2",
  "2.0",
  "latest",
  "main",
  "vX.Y.Z",
  "v-1.0.0",
  "v2.0.1 ",
  " v2.0.1",
  "v2.0.1\n",
  "v2.0.1\nv9.9.9",
  "../v2.0.1",
  "v2.0.1/../../etc/passwd",
  "/v2.0.1",
  "v2.0.1/install.sh",
  "v2.0.1;rm -rf /",
  "v2.0.1$(id)",
  "v2.0.1`id`",
  "v2.0.1|id",
  "v2.0.1&&id",
  "v2.0.1'",
  "v../0.1",
  "v2.0.1-",
]) {
  throws(`rejects ${JSON.stringify(bad)}`, () => parseTag(bad));
}
throws("rejects a number", () => parseTag(2.01));
throws("rejects nothing at all", () => parseTag(undefined));

// --------------------------------------------------------------------------

section("the generated installer is pinned to its release");

const built = generate("v2.0.1", join(work, "gen", "levix-v2.0.1-install.sh"));
const builtText = readFileSync(built.path, "utf8");

equal("it reports the tag it built", built.tag, "v2.0.1");
equal("and the npm version", built.version, "2.0.1");
ok("it is valid shell", bash("-n", built.path).status === 0);
ok("it pins VERSION", /^VERSION="2\.0\.1"$/m.test(builtText));
ok("nothing is left unpinned", !/^VERSION="latest"$/m.test(builtText));
equal("exactly one VERSION line survives", (builtText.match(/^VERSION="/gm) || []).length, 1);
ok(
  "no other version can sneak in",
  (builtText.match(/levix@[0-9][^\s"']*/g) || []).every((m) => m === "levix@2.0.1")
);
ok("it is the same script otherwise", builtText.split("\n").length === source.split("\n").length);
equal("it is world readable, not writable", mode(built.path), "644");

const other = generate("v2.5.0", join(work, "gen", "levix-v2.5.0-install.sh"));
ok("a later release pins its own version", /^VERSION="2\.5\.0"$/m.test(readFileSync(other.path, "utf8")));
ok("and does not mention the earlier one", !/2\.0\.1/.test(readFileSync(other.path, "utf8")));
equal("the earlier file is untouched", readFileSync(built.path, "utf8"), builtText);

throws("a bad tag never reaches the filesystem", () => generate("../evil", join(work, "gen", "evil.sh")));
ok("and wrote nothing", !existsSync(join(work, "gen", "evil.sh")));

section("the generator checks its own output");

throws("a source with two VERSION lines is refused", () =>
  buildInstaller(`${source}\nVERSION="sneaky"\n`, "2.0.1")
);
throws("a source with none is refused", () =>
  buildInstaller(source.replace(/^VERSION="[^"\n]*"$/m, "# gone"), "2.0.1")
);
ok(
  "a hardcoded package version is caught",
  verifyInstaller(`${builtText}\n# npm i -g levix@1.0.0\n`, "2.0.1").length > 0
);
ok(
  "so is an install line that stopped using VERSION",
  verifyInstaller(builtText.replace('npm install -g "${PACKAGE}@${VERSION}"', 'npm install -g levix'), "2.0.1")
    .length > 0
);
equal("a good one has nothing to report", verifyInstaller(builtText, "2.0.1").length, 0);

// --------------------------------------------------------------------------

section("publishing to the download directory");

function root(name) {
  const dir = join(work, name);
  mkdirSync(join(dir, ".incoming"), { recursive: true });
  return dir;
}

/** Stage a file the way scp would, then run the script that runs on the server. */
function publish(dir, version, text, stable = "yes", { staged } = {}) {
  const at = staged || join(dir, ".incoming", `levix-v${version}-install.sh`);
  mkdirSync(join(dir, ".incoming"), { recursive: true });
  writeFileSync(at, text);
  return bash(PUBLISH, dir, version, at, stable);
}

const site = root("site");
const v200 = readFileSync(generate("v2.0.0", join(work, "gen", "v2.0.0.sh")).path, "utf8");
const v201 = builtText;
const v202rc = readFileSync(generate("v2.0.2-rc.1", join(work, "gen", "rc.sh")).path, "utf8");

let result = publish(site, "2.0.0", v200);
equal("the first release publishes", result.status, 0);
equal("the versioned file is written", read(join(site, "install", "v2.0.0.sh")), v200);
equal("and install.sh is the same file", read(join(site, "install.sh")), v200);
equal("the marker records it", read(join(site, "install.version")).trim(), "2.0.0");
equal("the versioned file is 0644", mode(join(site, "install", "v2.0.0.sh")), "644");
equal("install.sh is 0644", mode(join(site, "install.sh")), "644");
ok("the staged upload is cleaned up", !existsSync(join(site, ".incoming", "levix-v2.0.0-install.sh")));

result = publish(site, "2.0.1", v201);
equal("the next release publishes", result.status, 0);
equal("its versioned file exists", read(join(site, "install", "v2.0.1.sh")), v201);
equal("install.sh moved to it", read(join(site, "install.sh")), v201);
equal("v2.0.0.sh is exactly as it was", read(join(site, "install", "v2.0.0.sh")), v200);
ok("which still installs 2.0.0", /^VERSION="2\.0\.0"$/m.test(read(join(site, "install", "v2.0.0.sh"))));

result = publish(site, "2.0.1", v201);
equal("publishing the same release again succeeds", result.status, 0);
ok("and says it changed nothing", /unchanged/.test(result.stdout));
equal("install.sh is still the same file", read(join(site, "install.sh")), v201);

section("a prerelease never becomes the stable installer");

result = publish(site, "2.0.2-rc.1", v202rc, "no");
equal("it publishes", result.status, 0);
ok("its versioned file exists", existsSync(join(site, "install", "v2.0.2-rc.1.sh")));
equal("install.sh was left alone", read(join(site, "install.sh")), v201);
equal("and the marker too", read(join(site, "install.version")).trim(), "2.0.1");
ok("it says why", /prerelease/.test(result.stdout));

section("install.sh never goes backwards");

const v190 = readFileSync(generate("v1.9.0", join(work, "gen", "v1.9.0.sh")).path, "utf8");
result = publish(site, "1.9.0", v190);
equal("an out-of-order release does not fail the job", result.status, 0);
ok("its versioned file is still published", existsSync(join(site, "install", "v1.9.0.sh")));
equal("but install.sh stays on the newer release", read(join(site, "install.sh")), v201);
ok("and it says so", /refusing to go back/.test(result.stdout));

section("nothing broken is ever published");

const before = read(join(site, "install.sh"));

result = publish(site, "2.1.0", "#!/usr/bin/env bash\nVERSION=\"2.1.0\"\nif [ 1 = 1 ; then\n");
ok("a syntax error fails the deployment", result.status !== 0);
ok("nothing was published", !existsSync(join(site, "install", "v2.1.0.sh")));
equal("install.sh is untouched", read(join(site, "install.sh")), before);

result = publish(site, "2.1.0", "");
ok("an empty upload fails", result.status !== 0);
ok("still nothing published", !existsSync(join(site, "install", "v2.1.0.sh")));

result = publish(site, "2.1.0", v201);
ok("an installer pinned to the wrong version fails", result.status !== 0);
ok("with an explicit reason", /not pinned/.test(result.stderr));
ok("and publishes nothing", !existsSync(join(site, "install", "v2.1.0.sh")));

result = publish(site, "2.0.0", `${v200}\n# a different build\n`);
ok("rewriting a published version fails", result.status !== 0);
ok("because they are immutable", /immutable/.test(result.stderr));
equal("the original is intact", read(join(site, "install", "v2.0.0.sh")), v200);
equal("install.sh is intact", read(join(site, "install.sh")), before);

section("a version can never become a path");

for (const bad of ["../../etc/passwd", "2.0.1/../..", "latest", "2.0.1;id", "", " 2.0.1", "2.0.1 && id"]) {
  const attempt = publish(site, bad, v201, "yes", { staged: join(site, ".incoming", "attempt.sh") });
  ok(`refuses version ${JSON.stringify(bad)}`, attempt.status !== 0);
}
equal("install.sh survived all of that", read(join(site, "install.sh")), before);
ok(
  "and nothing odd was created",
  !existsSync(join(site, "install", "vlatest.sh")) && !existsSync(join(work, "passwd"))
);

const outside = join(work, "outside.sh");
writeFileSync(outside, v201);
result = bash(PUBLISH, site, "2.0.1", outside, "yes");
ok("a file outside the upload directory is refused", result.status !== 0);
ok("with a reason", /\.incoming/.test(result.stderr));

result = bash(PUBLISH, join(work, "no-such-root"), "2.0.1", outside, "yes");
ok("a missing download root is refused", result.status !== 0);

result = bash(PUBLISH, "site", "2.0.1", join(site, ".incoming", "attempt.sh"), "yes");
ok("a relative download root is refused", result.status !== 0);

result = bash(PUBLISH, `${site}/../site`, "2.0.1", join(site, ".incoming", "attempt.sh"), "yes");
ok("so is one that climbs", result.status !== 0);
equal("install.sh is still what it was", read(join(site, "install.sh")), before);

section("rollback stays a one-liner");

// Not a feature, a property: the previous installer is still a whole file on
// disk, so restoring it is a copy — which is what an operator would do at 3am.
const rollback = root("rollback");
publish(rollback, "2.0.0", v200);
publish(rollback, "2.0.1", v201);
writeFileSync(join(rollback, "install.sh"), read(join(rollback, "install", "v2.0.0.sh")));
equal("restoring an older installer needs nothing but cp", read(join(rollback, "install.sh")), v200);

// --------------------------------------------------------------------------

section("the release pipeline is wired to the gate");

const release = readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8");
const deployScript = readFileSync(join(ROOT, "scripts", "deploy-installer.sh"), "utf8");

ok(
  "the installer job waits for the published release",
  /installer:[\s\S]*?needs:\s*publish-release/.test(release)
);
ok(
  "the published release waits for npm",
  /publish-release:[\s\S]*?needs:\s*\[[^\]]*\bnpm\b[^\]]*\]/.test(release)
);
ok(
  "the published release waits for the container image",
  /publish-release:[\s\S]*?needs:\s*\[[^\]]*\bimage\b[^\]]*\]/.test(release)
);
ok(
  "the published release waits for every binary",
  /publish-release:[\s\S]*?needs:\s*\[[^\]]*\bbinaries\b[^\]]*\]/.test(release)
);
ok("the binaries wait for CI", /binaries:\s*\n\s*needs:\s*ci/.test(release));
ok("only tags trigger it", /on:\s*\n\s*push:\s*\n\s*tags:/.test(release));
ok("not every push to main", !/branches:\s*\[main\]/.test(release));
ok("two releases cannot race", /group:\s*levix-installer-production/.test(release));
ok("and a running deployment is never cancelled", /cancel-in-progress:\s*false/.test(release));
ok("deployment secrets live on their own environment", /environment:\s*installer-production/.test(release));
ok(
  "the installer is generated from the tag being released",
  /build-release-installer\.mjs "\$TAG"/.test(release) && /TAG: \$\{\{ github\.ref_name \}\}/.test(release)
);
ok("it ships as a release asset too", /name: installer[\s\S]*?path: dist\/levix-\*-install\.sh/.test(release));
ok("covered by the existing checksum manifest", /sha256sum levix-\* > SHA256SUMS\.txt/.test(release));

section("the deployment carries no secrets and no shortcuts");

ok("host verification is never turned off", !/StrictHostKeyChecking\s*=\s*no/.test(deployScript));
ok("it is explicitly turned on", /StrictHostKeyChecking=yes/.test(deployScript));
ok("known_hosts comes from a secret", /LEVIX_DEPLOY_KNOWN_HOSTS/.test(deployScript));
ok("no password prompt can hang a release", /BatchMode=yes/.test(deployScript));
ok("no hostname is written down", !/leviro\.net/.test(deployScript));
ok("no IP address either", !/\b\d{1,3}(\.\d{1,3}){3}\b/.test(deployScript));
ok("no user is written down", !/levix-deploy@/.test(deployScript));
ok("the key is never echoed", !/echo\s+"?\$\{?LEVIX_DEPLOY_SSH_KEY/.test(deployScript));
ok("the key directory is removed on every exit", /trap cleanup EXIT/.test(deployScript));
ok("it does not run as root on the server", !/\bsudo\b/.test(deployScript));

finish();

// Official Node is 24. These checks read the pins; they do not run a build.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { equal, finish, ok, ROOT, section } from "./harness.mjs";

function read(path) {
  return readFileSync(join(ROOT, path), "utf8");
}

section("desktop pin");

const nodeVersionFile = read(".node-version");
const nodeVersionLines = nodeVersionFile.split("\n");
ok(
  ".node-version is one Node 24 patch",
  nodeVersionLines.length === 2 &&
    nodeVersionLines[1] === "" &&
    /^24\.\d+\.\d+$/.test(nodeVersionLines[0]),
);
const pin = nodeVersionLines[0];

section("workflows");

// The `with:` block is the lines after `uses:` that stay indented past the
// step's `- ` marker, then the lines indented past `with:` itself.
function stepWithBodies(text) {
  const lines = text.split("\n");
  const bodies = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!/uses:\s*actions\/setup-node@/.test(lines[i])) continue;
    let marker = -1;
    for (let k = i; k >= 0; k -= 1) {
      if (lines[k].trimStart().startsWith("- ")) {
        marker = lines[k].indexOf("- ");
        break;
      }
    }
    const body = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j];
      if (!line.trim()) break;
      const indent = line.match(/^ */)?.[0].length ?? 0;
      if (indent <= marker) break;
      body.push(line);
    }
    const withAt = body.findIndex((line) => /^\s*with:\s*$/.test(line));
    const withBody = [];
    if (withAt >= 0) {
      const withIndent = body[withAt].match(/^ */)?.[0].length ?? 0;
      for (const line of body.slice(withAt + 1)) {
        const indent = line.match(/^ */)?.[0].length ?? 0;
        if (indent <= withIndent) break;
        withBody.push(line);
      }
    }
    bodies.push(withBody);
  }
  return bodies;
}

const workflowNames = readdirSync(join(ROOT, ".github", "workflows"))
  .filter((name) => name.endsWith(".yml"))
  .sort();
let setupNodes = 0;
for (const name of workflowNames) {
  const bodies = stepWithBodies(read(join(".github", "workflows", name)));
  setupNodes += bodies.length;
  for (const [index, body] of bodies.entries()) {
    ok(
      `${name} setup-node ${index + 1} reads .node-version`,
      body.some((line) => /^\s*node-version-file:\s*\.node-version\s*$/.test(line)),
    );
    ok(
      `${name} setup-node ${index + 1} sets no node-version`,
      !body.some((line) => /^\s*node-version\s*:/.test(line)),
    );
  }
}
ok("workflows pin at least one setup-node", setupNodes >= 1);

function jobBody(text, job) {
  const lines = text.split("\n");
  const start = lines.indexOf(`  ${job}:`);
  if (start < 0) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}[A-Za-z0-9-]+:\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

const release = read(".github/workflows/release.yml");
ok(
  "verify-version sets up Node",
  /uses:\s*actions\/setup-node@/.test(jobBody(release, "verify-version")),
);
ok("installer sets up Node", /uses:\s*actions\/setup-node@/.test(jobBody(release, "installer")));

function hashesLock(text) {
  return text
    .split("\n")
    .some(
      (line) =>
        line.includes("hashFiles(") && line.includes("'android/scripts/termux-packages.lock'"),
    );
}
ok("ci android cache hashes the pin file", hashesLock(read(".github/workflows/ci.yml")));
ok("release android cache hashes the pin file", hashesLock(release));

section("image and packages");

const docker = read("Dockerfile");
const firstFrom = docker.search(/^FROM /m);
ok(
  "the image ARG matches .node-version and comes before FROM",
  firstFrom > 0 && docker.slice(0, firstFrom).includes(`ARG NODE_VERSION=${pin}`),
);
const froms = docker.split("\n").filter((line) => line.startsWith("FROM "));
ok(
  "every FROM uses the pinned Node image",
  froms.length >= 1 &&
    froms.every((line) => /^FROM node:\$\{NODE_VERSION\}-slim(?: AS [\w-]+)?$/.test(line)),
);

const pkg = JSON.parse(read("package.json"));
equal("package.json supports Node 24 only", pkg.engines?.node, ">=24 <25");
const lock = JSON.parse(read("package-lock.json"));
equal("the lockfile root engines match", lock.packages?.[""]?.engines?.node, ">=24 <25");

section("runtime guards");

ok("the CLI names Node 24", read("src/cli.js").includes("const SUPPORTED_MAJOR = 24;"));
ok(
  "the SEA build names Node 24",
  read("scripts/build-sea.mjs").includes("const SEA_NODE_MAJOR = 24;"),
);
ok(
  "the Android fetch names Node 24",
  read("android/scripts/fetch-node-android.sh").includes("SUPPORTED_NODE_MAJOR=24"),
);
ok(
  "Gradle names Node 24",
  read("android/app/build.gradle.kts").includes("val supportedNodeMajor = 24"),
);

const installer = read("deploy/install.sh");
ok("the installer floor is Node 24", /^MIN_NODE_MAJOR=24$/m.test(installer));
ok(
  "the installer warns when Node is newer than that floor",
  /\[\s*"\$NODE_MAJOR"\s+-gt\s+"\$MIN_NODE_MAJOR"\s*\]/.test(installer),
);

const nodeRows = read("android/scripts/termux-packages.lock")
  .split("\n")
  .filter((line) => line && !line.startsWith("#") && line.split(/\s+/)[1] === "nodejs-lts");
ok(
  "every pinned nodejs-lts is Node 24",
  nodeRows.length >= 1 &&
    nodeRows.every((line) => {
      const version = line.split(/\s+/)[2].replace(/^\d+:/, "").replace(/-\d+$/, "");
      return /^24\.\d+\.\d+$/.test(version);
    }),
);

section("android runtime archive");

const runtimeRows = read("android/scripts/node-runtime.lock")
  .split("\n")
  .filter((line) => line && !line.startsWith("#"));
equal("node-runtime.lock has exactly one data row", runtimeRows.length, 1);
if (runtimeRows.length === 1) {
  const runtimeFields = runtimeRows[0].split(/\s+/);
  equal("node-runtime.lock row has 4 fields", runtimeFields.length, 4);
  const runtimeFile = runtimeFields[0];
  const runtimeSha = runtimeFields[1];
  const runtimeSize = runtimeFields[2];
  const runtimeUrl = runtimeFields[3];
  ok("node-runtime.lock sha256 is 64 lowercase hex", /^[0-9a-f]{64}$/.test(runtimeSha ?? ""));
  ok("node-runtime.lock size is numeric", /^[0-9]+$/.test(runtimeSize ?? ""));
  ok(
    "node-runtime.lock url is a Levix release asset",
    (runtimeUrl ?? "").startsWith("https://github.com/Abdodiab2005/levix/releases/download/"),
  );
  if (nodeRows.length >= 1) {
    const nodeVersion = nodeRows[0].split(/\s+/)[2].replace(/^\d+:/, "").replace(/-\d+$/, "");
    equal(
      "node-runtime.lock names the pinned nodejs-lts archive",
      runtimeFile,
      `levix-node-runtime-${nodeVersion}-android.tar.xz`,
    );
    ok("the archive node version is Node 24", nodeVersion.startsWith("24."));
  }
}

finish();

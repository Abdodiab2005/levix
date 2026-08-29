// Generate the public installer for one release.
//
//   node scripts/build-release-installer.mjs v2.0.1 dist/levix-v2.0.1-install.sh
//
// deploy/install.sh is the only installer source in this repository. This does
// exactly one thing to it: rewrites the VERSION line so the generated file
// installs that release and nothing else. That is what makes
// https://levix.leviro.net/install/v2.0.1.sh still install 2.0.1 after 2.5.0
// exists.
//
// Generated installers are release artifacts. They are never committed.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const SOURCE = join(ROOT, "deploy", "install.sh");

// The tag shape the project releases with. Anchored, no whitespace, no slashes,
// no shell metacharacters — this string becomes a filename on a public server,
// so nothing that could climb out of it is allowed anywhere near it.
const TAG = /^v?(\d{1,5})\.(\d{1,5})\.(\d{1,5})(-[0-9A-Za-z][0-9A-Za-z.]*)?$/;

/**
 * "v2.0.1" -> { tag: "v2.0.1", version: "2.0.1", stable: true }
 * Throws on anything that is not a Levix release tag.
 */
export function parseTag(input) {
  if (typeof input !== "string") throw new Error("release tag must be a string");
  const match = TAG.exec(input);
  if (!match) throw new Error(`not a Levix release tag: ${JSON.stringify(input)}`);
  const version = `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}${match[4] || ""}`;
  return { tag: `v${version}`, version, stable: !match[4] };
}

/** Rewrite the one VERSION line. Fails loudly if the source ever stops having exactly one. */
export function buildInstaller(source, version) {
  const line = /^VERSION="[^"\n]*"$/gm;
  const found = source.match(line) || [];
  if (found.length !== 1) {
    throw new Error(`deploy/install.sh must contain exactly one VERSION= line, found ${found.length}`);
  }
  const out = source.replace(line, `VERSION="${version}"`);
  if (!out.includes(`VERSION="${version}"`)) throw new Error("failed to pin the version");
  return out;
}

/** Everything that must be true before a file is allowed to be served to the public. */
export function verifyInstaller(text, version) {
  const problems = [];
  if (!text.startsWith("#!")) problems.push("no shebang");
  const versions = text.match(/^VERSION="[^"\n]*"$/gm) || [];
  if (versions.length !== 1) problems.push(`${versions.length} VERSION lines`);
  else if (versions[0] !== `VERSION="${version}"`) problems.push(`pinned to ${versions[0]}`);
  if (!/^PACKAGE="levix-bot"$/m.test(text)) {
    problems.push("the installer does not target the levix-bot npm package");
  }
  if (!/npm install -g "\$\{PACKAGE\}@\$\{VERSION\}"/.test(text)) {
    problems.push("the install line no longer uses the pinned version");
  }
  // A literal package@version elsewhere would bypass PACKAGE/VERSION and could
  // install something other than what the URL promises.
  for (const stray of text.match(/(?:levix|levix-bot)@[0-9][^\s"']*/g) || []) {
    problems.push(`hardcoded ${stray}`);
  }
  return problems;
}

function checkSyntax(file) {
  const bash = spawnSync("bash", ["-n", file], { encoding: "utf8" });
  if (bash.status !== 0) throw new Error(`generated installer is not valid shell:\n${bash.stderr.trim()}`);
}

export function generate(tagInput, outPath) {
  const { tag, version, stable } = parseTag(tagInput);
  const text = buildInstaller(readFileSync(SOURCE, "utf8"), version);
  const problems = verifyInstaller(text, version);
  if (problems.length) throw new Error(`generated installer failed its own check: ${problems.join("; ")}`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, text, { mode: 0o644 });
  checkSyntax(outPath);
  return { tag, version, stable, path: outPath };
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  if (!argv[0]) {
    console.error("usage: build-release-installer.mjs [--print] <tag> [output]");
    process.exit(2);
  }
  // `--print` is what the release workflow uses to turn a tag into job outputs
  // without a second copy of the rules living in YAML.
  if (argv[0] === "--print") {
    try {
      const { tag, version, stable } = parseTag(argv[1]);
      console.log(`tag=${tag}\nversion=${version}\nstable=${stable ? "yes" : "no"}`);
      process.exit(0);
    } catch (error) {
      console.error(`error: ${error.message}`);
      process.exit(1);
    }
  }
  const [tag, out] = argv;
  try {
    const parsed = parseTag(tag);
    const result = generate(tag, out || join(ROOT, "dist", `levix-${parsed.tag}-install.sh`));
    console.log(`${result.tag} (${result.stable ? "stable" : "prerelease"}) -> ${result.path}`);
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exit(1);
  }
}

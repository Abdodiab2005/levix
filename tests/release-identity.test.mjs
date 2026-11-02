// Release identity: package.json version, plus +android.<versionCode> when the
// staged archive carries levix-build.json. No Android SDK and no Gradle run.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { equal, finish, ok, require, ROOT, section, throws, useTempDataDir } from "./harness.mjs";

useTempDataDir("levix-release-identity");

const release = require("./src/config/release.cjs");
const pkg = require("./package.json");

function invalid(label, text) {
  const error = throws(label, () => release.parseBuildInfo(text));
  equal(`${label} code`, error?.code, "BUILD_INFO_INVALID");
}

section("parseBuildInfo");

{
  const parsed = release.parseBuildInfo('{"schema":1,"platform":"android","versionCode":69}\n');
  equal("valid schema", parsed.schema, 1);
  equal("valid platform", parsed.platform, "android");
  equal("valid versionCode", parsed.versionCode, 69);
  const ceiling = release.parseBuildInfo(
    '{"schema":1,"platform":"android","versionCode":2100000000}',
  );
  equal("versionCode ceiling", ceiling.versionCode, 2100000000);

  invalid("extra key", '{"schema":1,"platform":"android","versionCode":69,"extra":1}');
  invalid("wrong schema", '{"schema":2,"platform":"android","versionCode":69}');
  invalid("wrong platform", '{"schema":1,"platform":"desktop","versionCode":69}');
  invalid("zero", '{"schema":1,"platform":"android","versionCode":0}');
  invalid("negative", '{"schema":1,"platform":"android","versionCode":-1}');
  invalid("float", '{"schema":1,"platform":"android","versionCode":1.5}');
  invalid("string number", '{"schema":1,"platform":"android","versionCode":"69"}');
  invalid("missing key", '{"schema":1,"platform":"android"}');
  invalid("not JSON", "{");
  invalid(
    "above the versionCode ceiling",
    '{"schema":1,"platform":"android","versionCode":2100000001}',
  );
}

section("composeIdentity");

{
  equal("no build info keeps the version", release.composeIdentity("4.9.2", null), "4.9.2");
  equal(
    "undefined build info keeps the version",
    release.composeIdentity("4.9.2", undefined),
    "4.9.2",
  );
  const info = release.parseBuildInfo('{"schema":1,"platform":"android","versionCode":69}');
  equal("android identity", release.composeIdentity("4.9.2", info), "4.9.2+android.69");
}

section("a real levix-build.json");

// Require the module first, then point assetPath at the temp dir. A read at
// module load would cache the plain version from the repository root.
const PATHS = JSON.stringify(join(ROOT, "src/config/paths.cjs"));
const RELEASE = JSON.stringify(join(ROOT, "src/config/release.cjs"));
const identitySource = `process.env.LEVIX_DATA_DIR = process.argv[2];
const { setAssetRoot } = require(${PATHS});
const release = require(${RELEASE});
setAssetRoot(process.argv[3]);
try {
  process.stdout.write(release.releaseIdentity());
  process.exit(0);
} catch (error) {
  process.stderr.write(error && error.code ? error.code : "THROW");
  process.exit(2);
}
`;

function runIdentity(assetDir, env = process.env) {
  const data = mkdtempSync(join(tmpdir(), "levix-release-data-"));
  const probeDir = mkdtempSync(join(tmpdir(), "levix-release-probe-"));
  const file = join(probeDir, "probe.cjs");
  writeFileSync(file, identitySource);
  const run = spawnSync(process.execPath, [file, data, assetDir], { encoding: "utf8", env });
  rmSync(data, { recursive: true, force: true });
  rmSync(probeDir, { recursive: true, force: true });
  return run;
}

function childDetail(run) {
  return `status=${run.status} stdout=${JSON.stringify(run.stdout)} stderr=${JSON.stringify(run.stderr)}`;
}

{
  const absent = mkdtempSync(join(tmpdir(), "levix-assets-absent-"));
  const present = mkdtempSync(join(tmpdir(), "levix-assets-present-"));
  const invalidDir = mkdtempSync(join(tmpdir(), "levix-assets-invalid-"));
  const unread = mkdtempSync(join(tmpdir(), "levix-assets-unread-"));
  try {
    writeFileSync(
      join(present, "levix-build.json"),
      '{"schema":1,"platform":"android","versionCode":69}\n',
    );
    writeFileSync(join(invalidDir, "levix-build.json"), "{");
    mkdirSync(join(unread, "levix-build.json"));

    const plain = runIdentity(absent);
    ok(
      "absent build file is the package version",
      plain.status === 0 && plain.stdout === pkg.version,
      childDetail(plain),
    );

    const android = runIdentity(present, { ...process.env, LEVIX_ANDROID_VERSION_CODE: "999" });
    ok(
      "present build file is read on first call and ignores LEVIX_ANDROID_VERSION_CODE",
      android.status === 0 && android.stdout === `${pkg.version}+android.69`,
      childDetail(android),
    );

    const bad = runIdentity(invalidDir);
    ok(
      "invalid build file throws BUILD_INFO_INVALID",
      bad.status === 2 && bad.stdout === "" && bad.stderr === "BUILD_INFO_INVALID",
      childDetail(bad),
    );

    const blocked = runIdentity(unread);
    ok(
      "unreadable build file fails closed",
      blocked.status === 2 && blocked.stdout === "" && blocked.stderr === "EISDIR",
      childDetail(blocked),
    );
  } finally {
    rmSync(absent, { recursive: true, force: true });
    rmSync(present, { recursive: true, force: true });
    rmSync(invalidDir, { recursive: true, force: true });
    rmSync(unread, { recursive: true, force: true });
  }
}

section("the stage script and Gradle agree");

{
  const stageSrc = readFileSync(join(ROOT, "android/scripts/stage-levix-app.sh"), "utf8");
  const gradleSrc = readFileSync(join(ROOT, "android/app/build.gradle.kts"), "utf8");
  const releaseSrc = readFileSync(join(ROOT, "src/config/release.cjs"), "utf8");
  const stageTask = /tasks\.register<Exec>\("stageLevixApp"\) \{([\s\S]*?)\n\}/.exec(gradleSrc)?.[1] ?? "";
  const writeAt = stageSrc.indexOf('> "$STAGE/levix-build.json"');
  const zipAt = stageSrc.indexOf('node "$ROOT/android/scripts/zip-tree.mjs"');
  const listAt = stageSrc.indexOf('grep -qxF "levix-build.json"');
  const missingAt = stageSrc.indexOf("LEVIX_ANDROID_VERSION_CODE is missing");

  const shellVersionCode = "$" + "{LEVIX_ANDROID_VERSION_CODE-}";
  ok("the script reads LEVIX_ANDROID_VERSION_CODE", stageSrc.includes(shellVersionCode));
  ok(
    "a missing versionCode is refused",
    missingAt !== -1 && stageSrc.indexOf("exit 1", missingAt) - missingAt < 80,
  );
  ok(
    "a value with leading zeros is refused",
    stageSrc.includes("positive integer without leading zeros") && stageSrc.includes("^[1-9][0-9]*$"),
  );
  ok("a versionCode above 2100000000 is refused", stageSrc.includes("[ \"$version_code\" -gt 2100000000 ]"));
  ok(
    "the JSON keys are schema, platform, versionCode",
    stageSrc.includes('{"schema":1,"platform":"android","versionCode":'),
  );
  ok("the build file line ends with a newline", stageSrc.includes("printf '%s\\n'"));
  ok("levix-build.json is written before zip-tree.mjs", writeAt !== -1 && zipAt !== -1 && writeAt < zipAt);
  ok("the zip listing must contain levix-build.json", listAt > zipAt);
  ok("release.cjs does not read process.env", !releaseSrc.includes("process.env"));
  ok(
    "Gradle passes LEVIX_ANDROID_VERSION_CODE from defaultConfig.versionCode",
    stageTask.includes('environment("LEVIX_ANDROID_VERSION_CODE", versionCode)') &&
      stageTask.includes("android.defaultConfig.versionCode"),
  );
  ok(
    "Gradle declares versionCode as a task input",
    stageTask.includes('inputs.property("versionCode", versionCode)'),
  );
}

finish();

// The stale-runtime guard: android/scripts/fetch-node-android.sh stamps every
// staged runtime (node-runtime/<abi>/.levix-stamp) and android/app/build.gradle.kts
// recomputes that stamp and refuses to package a runtime that does not carry it.
// The two sides are written in different languages, so nothing but this file
// keeps them computing the same thing. No Android SDK needed.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { equal, finish, ok, ROOT, section } from "./harness.mjs";

const SCRIPTS = join(ROOT, "android", "scripts");
const FETCH = join(SCRIPTS, "fetch-node-android.sh");
const fetchSrc = readFileSync(FETCH, "utf8");
const gradleSrc = readFileSync(join(ROOT, "android", "app", "build.gradle.kts"), "utf8");

section("the application archive cannot reuse stale recovery code or dashboard assets");

const stageTask = /tasks\.register<Exec>\("stageLevixApp"\) \{([\s\S]*?)\n\}/.exec(gradleSrc)?.[1] ?? "";
const stageSrc = readFileSync(join(SCRIPTS, "stage-levix-app.sh"), "utf8");
const tracked = [...stageTask.matchAll(/inputs\.(?:dir|file)\(File\(repoRoot, "([^"]+)"\)\)/g)].map(
  (match) => match[1],
);
for (const [, source] of stageSrc.matchAll(/copy_tree "\$ROOT\/([^"]+)"/g)) {
  ok(`Gradle tracks the packaged ${source} tree`, tracked.includes(source));
}
for (const source of [
  "node_modules",
  "app.cjs",
  "scheduler.cjs",
  "package.json",
  "package-lock.json",
  "LICENSE",
  "android/host-boot.mjs",
  "android/scripts/stage-levix-app.sh",
  "scripts/build-frontend.mjs",
]) {
  ok(`Gradle tracks archive input ${source}`, tracked.includes(source));
}
ok(
  "Gradle tracks the complete frontend, including build configuration and lockfile",
  /inputs\.files\(fileTree\(File\(repoRoot, "frontend"\)\)/.test(stageTask),
);
ok(
  "frontend input tracking excludes installed dependencies and generated TypeScript state",
  /exclude\("node_modules\/\*\*", "\*\.tsbuildinfo"\)/.test(stageTask),
);

section("the script and Gradle name the same stamp");

const scriptFile = /^RUNTIME_STAMP_FILE="([^"]+)"$/m.exec(fetchSrc)?.[1];
const gradleFile = /^val runtimeStampFile = "([^"]+)"$/m.exec(gradleSrc)?.[1];
equal("the stamp file is .levix-stamp in the script", scriptFile, ".levix-stamp");
equal("Gradle reads the stamp file the script writes", gradleFile, scriptFile);

const scriptInputs =
  /^RUNTIME_STAMP_INPUTS=\(([^)]*)\)$/m.exec(fetchSrc)?.[1].trim().split(/\s+/) ?? [];
const gradleInputs = [
  ...(/^val runtimeStampInputs = listOf\(([^)]*)\)$/m.exec(gradleSrc)?.[1] ?? "").matchAll(
    /"([^"]+)"/g,
  ),
].map((m) => m[1]);
equal(
  "Gradle hashes exactly the inputs the script hashes, in order",
  gradleInputs.join(" "),
  scriptInputs.join(" "),
);
ok("the FFmpeg recipe is a stamp input", scriptInputs.includes("build-ffmpeg-android.sh"));
ok("the runtime recipe itself is a stamp input", scriptInputs.includes("fetch-node-android.sh"));
ok("the pin file is a stamp input", scriptInputs.includes("termux-packages.lock"));
ok("node-runtime.lock is a stamp input", scriptInputs.includes("node-runtime.lock"));
ok("node-runtime-archive.py is a stamp input", scriptInputs.includes("node-runtime-archive.py"));
ok("Gradle hashes the pin file too", gradleInputs.includes("termux-packages.lock"));
ok("Gradle hashes node-runtime.lock", gradleInputs.includes("node-runtime.lock"));
ok("Gradle hashes node-runtime-archive.py", gradleInputs.includes("node-runtime-archive.py"));
for (const input of scriptInputs) {
  ok(`stamp input ${input} exists in android/scripts`, existsSync(join(SCRIPTS, input)));
}

ok(
  "both sides start the stamp with the same header",
  fetchSrc.includes('echo "levix-runtime-stamp 1"') &&
    gradleSrc.includes('"levix-runtime-stamp 1", "abi $abi"'),
);
ok(
  "both sides use 16 hex characters of sha256",
  /sha256sum "\$SCRIPTS\/\$input" \| cut -c1-16/.test(fetchSrc) &&
    /"SHA-256"[\s\S]{0,200}\.take\(16\)/.test(gradleSrc),
);

section("the script writes it, last");

ok(
  "the stamp is written after FFmpeg is installed and every ELF verified",
  /build-ffmpeg-android\.sh" "\$ABI"[\s\S]*verify_elfs "\$RUNTIME" "\$ABI"[\s\S]*runtime_stamp "\$ABI" > "\$RUNTIME\/\$RUNTIME_STAMP_FILE"/.test(
    fetchSrc,
  ),
);
ok(
  "the runtime directory is emptied before restaging, so no stamp survives a failed run",
  /rm -rf "\$RUNTIME"/.test(fetchSrc),
);

section("Gradle checks it, and only checks it");

ok(
  "the guard sits with the per-ABI Missing $lib check",
  /Missing \$lib for \$abi[\s\S]{0,400}expectedRuntimeStamp\(abi\)/.test(gradleSrc),
);
ok(
  "the failure names the exact refresh command for that ABI",
  gradleSrc.includes('"LEVIX_ANDROID_ABIS=$abi bash android/scripts/fetch-node-android.sh"'),
);
ok("the failure says which ABI is stale", /Stale Android runtime for \$abi/.test(gradleSrc));
ok(
  "Gradle never runs the fetch script itself",
  !/commandLine\([^)]*fetch-node-android/.test(gradleSrc),
);
ok(
  "the staged FFmpeg must carry the libwebp and libwebp_anim encoders",
  /requiredFfmpegEncoders = listOf\("libwebp", "libwebp_anim"\)/.test(gradleSrc),
);

section("the script's stamp is the one Gradle expects");

// Gradle's recipe, transcribed: header, abi, then "<input> <sha256[0:16]>".
function gradleStamp(abi) {
  return [
    "levix-runtime-stamp 1",
    `abi ${abi}`,
    ...gradleInputs.map(
      (input) =>
        `${input} ${createHash("sha256")
          .update(readFileSync(join(SCRIPTS, input)))
          .digest("hex")
          .slice(0, 16)}`,
    ),
  ];
}

const haveTools = ["bash", "sha256sum"].every(
  (tool) => spawnSync(tool, ["--version"], { stdio: "ignore" }).status === 0,
);
if (!haveTools) {
  console.log("    (bash or sha256sum not on PATH — skipping the --print-stamp comparison)");
} else {
  for (const abi of ["arm64-v8a", "armeabi-v7a"]) {
    const run = spawnSync("bash", [FETCH, "--print-stamp", abi], { encoding: "utf8" });
    equal(`--print-stamp ${abi} exits cleanly`, run.status, 0);
    equal(
      `the stamp fetch-node-android.sh writes for ${abi} is the one Gradle recomputes`,
      run.stdout.split("\n").filter(Boolean).join("\n"),
      gradleStamp(abi).join("\n"),
    );
  }
  const bad = spawnSync("bash", [FETCH, "--print-stamp", "x86"], { encoding: "utf8" });
  ok("--print-stamp rejects an unknown ABI", bad.status !== 0 && /unknown ABI/.test(bad.stderr));
}

section("the runtime archive, not Termux debs");

// --update-pins also runs `pins check`. The default staging check is the later one.
const stagingAt = fetchSrc.lastIndexOf('pins check "$PIN_FILE"');
const staging = stagingAt >= 0 ? fetchSrc.slice(stagingAt) : "";
ok("staging starts at the default pins check", stagingAt > fetchSrc.indexOf("--update-pins"));
ok("the fetch script never calls dpkg-deb", !fetchSrc.includes("dpkg-deb"));
ok("staging never calls dpkg-deb", staging.length > 0 && !staging.includes("dpkg-deb"));
ok(
  "staging never downloads a Termux url",
  staging.length > 0 && !staging.includes("packages.termux.dev"),
);
const fetchEnd = staging.indexOf("Downloading patchelf");
const runtimeFetch = fetchEnd >= 0 ? staging.slice(0, fetchEnd) : "";
// Any line that runs curl, including `if ! curl ...`.
const runtimeCurls = runtimeFetch.match(/^.*\bcurl\s.*$/gm) ?? [];
ok(
  "the runtime fetch downloads only the node-runtime.lock url",
  runtimeCurls.length === 1 &&
    runtimeCurls[0].includes('"$runtime_url"') &&
    !/packages\.termux\.dev|\$BASE/.test(runtimeFetch),
);
ok(
  "the patchelf download is checked against a pinned sha256",
  /^PATCHELF_SHA256="[0-9a-f]{64}"$/m.test(fetchSrc) &&
    fetchSrc.includes('"$(sha256sum "$tmp/patchelf.tgz" | cut -c1-64)" != "$PATCHELF_SHA256"'),
);
ok(
  "staging checks the archive sha256",
  staging.includes('[ "$(sha256sum "$ARCHIVE" | cut -c1-64)" = "$runtime_sha" ]') &&
    staging.includes('"$runtime_have" != "$runtime_sha"'),
);
ok(
  "staging extracts through node-runtime-archive.py",
  staging.includes('"$SCRIPTS/node-runtime-archive.py" extract'),
);
ok(
  "Gradle requires the lock's nodejs-lts version inside libnode.so",
  gradleSrc.includes('"\\u0000v$nodeVersion\\u0000"') &&
    /nodejs-lts/.test(gradleSrc) &&
    gradleSrc.includes("termux-packages.lock"),
);

section("check-pins rejects a lock that would move the runtime off Node 24");

const havePinTools = ["bash", "python3"].every(
  (tool) => spawnSync(tool, ["--version"], { stdio: "ignore" }).status === 0,
);
if (!havePinTools) {
  console.log("    (bash or python3 not on PATH — skipping the --check-pins cases)");
} else {
  const good = spawnSync("bash", [FETCH, "--check-pins"], { encoding: "utf8" });
  ok("the repo lock passes --check-pins", good.status === 0, good.stderr);

  const lockText = readFileSync(join(SCRIPTS, "termux-packages.lock"), "utf8");
  const dataRows = lockText.split("\n").filter((line) => line && !line.startsWith("#"));
  const firstSha = dataRows[0].split(/\s+/)[3];
  const cases = [
    [
      "nodejs-lts 26.12.1 on both arches",
      lockText.replaceAll("nodejs-lts 24.22.1 ", "nodejs-lts 26.12.1 "),
    ],
    [
      "different nodejs-lts versions",
      lockText.replace("arm nodejs-lts 24.22.1 ", "arm nodejs-lts 24.22.0 "),
    ],
    ["a 63-character sha256", lockText.replace(firstSha, firstSha.slice(0, -1))],
    [
      "a missing arm zlib row",
      lockText
        .split("\n")
        .filter((line) => !line.startsWith("arm zlib "))
        .join("\n"),
    ],
    ["a duplicate row", `${lockText}${dataRows[0]}\n`],
    [
      "a url whose file name names the other arch",
      lockText.replace("nodejs-lts_24.22.1_aarch64.deb", "nodejs-lts_24.22.1_arm.deb"),
    ],
  ];

  const dir = mkdtempSync(join(tmpdir(), "levix-pins-"));
  try {
    for (const [label, body] of cases) {
      const file = join(dir, `${label.replace(/[^\w]+/g, "-")}.lock`);
      writeFileSync(file, body);
      const run = spawnSync("bash", [FETCH, "--check-pins", file], { encoding: "utf8" });
      ok(`${label} is rejected`, run.status === 1, run.stderr.trim());
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

section("update-pins refuses an index that would move the runtime off its pins");

function lockRows(text, arch) {
  const marker = "/termux-main/";
  return text
    .split("\n")
    .filter((line) => line.startsWith(`${arch} `))
    .map((line) => {
      const parts = line.split(/\s+/);
      const url = parts[4];
      const at = url.indexOf(marker);
      return {
        pkg: parts[1],
        version: parts[2],
        sha: parts[3],
        filename: url.slice(at + marker.length),
      };
    });
}

function packagesIndex(rows, versionOf) {
  const records = rows.map((row) =>
    [
      `Package: ${row.pkg}`,
      "Installed-Size: 1",
      `Version: ${versionOf(row)}`,
      `Filename: ${row.filename}`,
      `SHA256: ${row.sha}`,
    ].join("\n"),
  );
  return `${records.join("\n\n")}\n`;
}

const haveUpdateTools = ["bash", "python3", "curl"].every(
  (tool) => spawnSync(tool, ["--version"], { stdio: "ignore" }).status === 0,
);
if (!haveUpdateTools) {
  console.log("    (bash, python3 or curl not on PATH — skipping the --update-pins cases)");
} else {
  const updateDir = mkdtempSync(join(tmpdir(), "levix-update-pins-"));
  try {
    const scriptsDir = join(updateDir, "scripts");
    const repo = join(updateDir, "repo");
    const sameVersion = (row) => row.version;
    const node26 = (row) => (row.pkg === "nodejs-lts" ? "26.13.0" : row.version);
    const armNext = (row) => (row.pkg === "nodejs-lts" ? "24.23.0" : row.version);
    const cases = [
      {
        label: "nodejs-lts 26.13.0 on both arches",
        versionOf: { aarch64: node26, arm: node26 },
        stderr: "26.13.0",
      },
      {
        label: "aarch64 24.22.1 and arm 24.23.0",
        versionOf: { aarch64: sameVersion, arm: armNext },
      },
      {
        label: "unchanged versions with file urls",
        versionOf: { aarch64: sameVersion, arm: sameVersion },
      },
    ];
    mkdirSync(scriptsDir, { recursive: true });
    for (const arch of ["aarch64", "arm"]) {
      mkdirSync(join(repo, "dists", "stable", "main", `binary-${arch}`), { recursive: true });
    }
    const lockText = readFileSync(join(SCRIPTS, "termux-packages.lock"), "utf8");
    const lockCopy = join(scriptsDir, "termux-packages.lock");
    writeFileSync(lockCopy, lockText);
    const baseLine = 'BASE="https://packages.termux.dev/apt/termux-main"';
    const script = readFileSync(FETCH, "utf8").replace(baseLine, `BASE="file://${repo}"`);
    const scriptCopy = join(scriptsDir, "fetch-node-android.sh");
    const pointed = script.includes(`BASE="file://${repo}"`);
    ok("the copy points BASE at the local file repo", pointed);
    if (pointed) {
      writeFileSync(scriptCopy, script);
      for (const { label, versionOf, stderr } of cases) {
        for (const arch of ["aarch64", "arm"]) {
          writeFileSync(
            join(repo, "dists", "stable", "main", `binary-${arch}`, "Packages"),
            packagesIndex(lockRows(lockText, arch), versionOf[arch]),
          );
        }
        const run = spawnSync("bash", [scriptCopy, "--update-pins"], { encoding: "utf8" });
        equal(`${label} exits 1`, run.status, 1);
        equal(`${label} leaves the lock untouched`, readFileSync(lockCopy, "utf8"), lockText);
        if (stderr) {
          ok(`${label} names ${stderr}`, run.stderr.includes(stderr), run.stderr.trim());
        }
      }
    }
  } finally {
    rmSync(updateDir, { recursive: true, force: true });
  }
}

finish();

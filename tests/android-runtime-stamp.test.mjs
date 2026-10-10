// The stale-runtime guard: android/scripts/fetch-node-android.sh stamps every
// staged runtime (node-runtime/<abi>/.levix-stamp) and android/app/build.gradle.kts
// recomputes that stamp and refuses to package a runtime that does not carry it.
// The two sides are written in different languages, so nothing but this file
// keeps them computing the same thing. No Android SDK needed.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { equal, finish, ok, ROOT, section } from "./harness.mjs";

const SCRIPTS = join(ROOT, "android", "scripts");
const FETCH = join(SCRIPTS, "fetch-node-android.sh");
const fetchSrc = readFileSync(FETCH, "utf8");
const gradleSrc = readFileSync(join(ROOT, "android", "app", "build.gradle.kts"), "utf8");

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

finish();

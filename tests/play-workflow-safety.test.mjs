// No public workflow may publish to Google Play through a known upload
// mechanism. Play builds, uploads and promotions live in the private levix-plus
// repository, so every public workflow is checked for known upload actions,
// credentials, environments and track variables.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { finish, ok, ROOT, section } from "./harness.mjs";

section("known Google Play upload mechanisms");
const workflowDir = join(ROOT, ".github/workflows");
const forbidden = [
  "upload-google-play",
  "PLAY_SERVICE_ACCOUNT_JSON",
  "environment: google-play",
  "PLAY_TRACK",
  "play-release-notes",
  "androidpublisher",
  "play.google.com",
];
for (const file of readdirSync(workflowDir).filter((name) => /\.ya?ml$/.test(name))) {
  const source = readFileSync(join(workflowDir, file), "utf8");
  for (const marker of forbidden) {
    ok(`${file} does not contain ${marker}`, !source.includes(marker));
  }
  const playActions = source.split("\n").filter((line) => /^\s*-?\s*uses:.*play/i.test(line));
  ok(`${file} uses no Play action`, playActions.length === 0);
}
ok("the manual Play upload workflow is gone", !existsSync(join(workflowDir, "play-store.yml")));
ok("the beta AAB upload workflow is gone", !existsSync(join(workflowDir, "android-beta-aab.yml")));
ok("the signer check workflow is gone", !existsSync(join(workflowDir, "verify-upload-signing.yml")));
const signingWorkflows = readdirSync(workflowDir)
  .filter((name) => /\.ya?ml$/.test(name))
  .filter((name) => readFileSync(join(workflowDir, name), "utf8").includes("play-signing"));
ok(
  "release.yml is the only workflow using play-signing",
  signingWorkflows.join(",") === "release.yml",
);

section("public release and CI retain their Free Android builds");
const release = readFileSync(join(workflowDir, "release.yml"), "utf8");
const ci = readFileSync(join(workflowDir, "ci.yml"), "utf8");
ok(
  "release builds APKs and no AAB",
  release.includes("./gradlew :app:assembleRelease --stacktrace"),
);
ok(
  "release does not stage or build a Play bundle",
  !release.includes("stageLevixBundle") && !release.includes("bundleRelease") && !release.includes(".aab"),
);
ok(
  "CI still builds release APKs and AAB with a test key",
  ci.includes(":app:assembleRelease :app:bundleRelease"),
);
ok(
  "public builds do not stage the private Plus runtime",
  !/LEVIX_EXTENSIONS_DIR\s*:|levixPlusProductId=levix\.plus/.test(release + ci),
);
const gradle = readFileSync(join(ROOT, "android/app/build.gradle.kts"), "utf8");
ok("the public Gradle build has no Play bundle task", !gradle.includes("stageLevixBundle"));
section("CI artifacts omit debug-signed release builds");
{
  // Every step in ci.yml starts at 6 spaces. Keep each upload inside its own step.
  const steps = ci.split(/(?=^ {6}- )/m).filter((chunk) => /^ {6}- /m.test(chunk));
  const uploads = steps.filter((chunk) => chunk.includes("uses: actions/upload-artifact@"));
  const usesCount = [...ci.matchAll(/uses: actions\/upload-artifact@/g)].length;
  ok("the inventory covers existing CI artifact uploads", uploads.length >= 2 && uploads.length === usesCount);
  for (const chunk of uploads) {
    const step = chunk.match(/^ {6}- name: (.+)$/m)?.[1] ?? "unnamed upload";
    ok(
      `${step} excludes release APKs and the AAB`,
      !/outputs\/bundle\/|outputs\/apk\/release\/|\.aab\b/.test(chunk),
    );
  }
  ok("debug APK artifact remains", ci.includes("name: android-debug-apks"));
}
section("public release signing uses protected play-signing secrets");
const apkJob = [...release.matchAll(/^ {2}([\w-]+):\s*\n([\s\S]*?)(?=^ {2}[\w-]+:\s*\n|$(?![\s\S]))/gm)]
  .find(([, name]) => name === "apk")?.[2];
ok("tagged APK/AAB job exists", Boolean(apkJob));
ok(
  "tagged APK/AAB job is gated by play-signing environment",
  /^ {4}environment: play-signing\s*$/m.test(apkJob ?? ""),
);
section("tag release starts only for the repository owner");
{
  const head = release.slice(release.indexOf("  verify-version:"), release.indexOf("    steps:", release.indexOf("  verify-version:")));
  ok("verify-version requires the owner as actor", head.includes("github.actor == github.repository_owner"));
  ok("verify-version requires the owner as triggering actor", head.includes("github.triggering_actor == github.repository_owner"));
  // Every job reaches verify-version through needs. A re-run skips a successful
  // gate, so each job's own if re-checks the triggering actor.
  const jobsBlock = release.slice(release.indexOf("\njobs:\n"));
  const jobs = [...jobsBlock.matchAll(/^ {2}([a-z][a-z-]*):\n/gm)].map((m) => m[1]);
  const bodies = Object.fromEntries(jobs.map((job) => {
    const start = release.indexOf(`\n  ${job}:\n`);
    const next = jobs.map((j) => release.indexOf(`\n  ${j}:\n`)).filter((i) => i > start).sort((a, b) => a - b)[0] ?? release.length;
    return [job, release.slice(start, next)];
  }));
  const needs = Object.fromEntries(jobs.map((job) => {
    const m = bodies[job].match(/^ {4}needs: (\[[^\]]*\]|[a-z-]+)/m);
    return [job, m ? m[1].replace(/[\[\]\s]/g, "").split(",").filter(Boolean) : []];
  }));
  const reaches = (job, seen = new Set()) => job === "verify-version" || (needs[job] || []).some((n) => !seen.has(n) && (seen.add(n), reaches(n, seen)));
  for (const job of jobs) ok(`${job} depends on verify-version`, reaches(job));
  // Job-level if is exactly 4 spaces, plus continuation lines indented 6 or more.
  const jobLevelIf = (body) => {
    const lines = body.split("\n");
    const start = lines.findIndex((line) => /^ {4}if:/.test(line));
    if (start < 0) return "";
    const kept = [lines[start]];
    for (let i = start + 1; i < lines.length; i += 1) {
      if (/^ {6,}/.test(lines[i])) kept.push(lines[i]);
      else break;
    }
    return kept.join("\n");
  };
  for (const job of jobs) {
    const condition = jobLevelIf(bodies[job]);
    ok(
      `${job} job-level if has no status function`,
      condition !== "" && !/\b(always|cancelled|failure|success)\s*\(/.test(condition),
    );
    if (job !== "verify-version") {
      ok(
        `${job} re-checks the triggering actor`,
        /^ {4}if: github\.triggering_actor == github\.repository_owner *$/.test(condition),
      );
    }
  }
}

finish();

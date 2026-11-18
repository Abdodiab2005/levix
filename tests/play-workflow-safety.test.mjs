// Public Android artifacts are Free-only. They must never be uploaded to Play
// by any public workflow, including manually dispatched jobs and testing tracks.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { equal, finish, ok, ROOT, section } from "./harness.mjs";

section("every public Google Play upload job is unconditionally disabled");
const workflowDir = join(ROOT, ".github/workflows");
let uploadJobs = 0;
for (const file of readdirSync(workflowDir).filter((name) => /\.ya?ml$/.test(name))) {
  const source = readFileSync(join(workflowDir, file), "utf8");
  // Workflows use block-style jobs. Inspect every upload action rather than
  // assuming only release.yml can publish an Android bundle.
  const jobs = [
    ...source.matchAll(/^ {2}([\w-]+):\s*\n([\s\S]*?)(?=^ {2}[\w-]+:\s*\n|$(?![\s\S]))/gm),
  ];
  const uploadPattern = /uses:\s*r0adkll\/upload-google-play@/g;
  const uploadsInFile = [...source.matchAll(uploadPattern)].length;
  let uploadsInJobs = 0;
  for (const [, name, job] of jobs) {
    const uploads = [...job.matchAll(uploadPattern)].length;
    if (!uploads) continue;
    uploadsInJobs += uploads;
    uploadJobs += 1;
    ok(
      `${file}:${name} cannot upload even with confirmation inputs`,
      /^ {4}if: \$\{\{ false \}\}\s*$/m.test(job),
    );
  }
  equal(`${file}: all Play upload actions belong to inspected jobs`, uploadsInJobs, uploadsInFile);
}
ok("the inventory covers existing public upload jobs", uploadJobs >= 2);

section("public release and CI retain their Free Android builds");
const release = readFileSync(join(workflowDir, "release.yml"), "utf8");
const ci = readFileSync(join(workflowDir, "ci.yml"), "utf8");
ok(
  "release still builds APKs and AAB",
  release.includes(":app:assembleRelease :app:stageLevixBundle"),
);
ok(
  "CI still builds release APKs and AAB with a test key",
  ci.includes(":app:assembleRelease :app:bundleRelease"),
);
ok(
  "public builds do not stage the private Plus runtime",
  !/LEVIX_EXTENSIONS_DIR\s*:|levixPlusProductId=levix\.plus/.test(release + ci),
);
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
section("manual signer check cannot publish and stays owner/main-only");
const signerCheck = readFileSync(join(workflowDir, "verify-upload-signing.yml"), "utf8");
ok("signer check requires play-signing", /^ {4}environment: play-signing\s*$/m.test(signerCheck));
ok("signer check limits dispatch to main", signerCheck.includes("github.ref == 'refs/heads/main'"));
ok("signer check requires repository owner", signerCheck.includes("github.actor == github.repository_owner"));
ok("signer check takes original upload fingerprint", signerCheck.includes("expected_upload_cert_sha256"));
ok("signer check has no upload or artifacts", !/upload-google-play|actions\/upload-artifact|gh release create/.test(signerCheck));
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
    if (job === "play") {
      ok(`${job} job-level if is \${{ false }}`, condition.includes("${{ false }}"));
    } else if (job !== "verify-version") {
      ok(
        `${job} re-checks the triggering actor`,
        /^ {4}if: github\.triggering_actor == github\.repository_owner *$/.test(condition),
      );
    }
  }
}

finish();

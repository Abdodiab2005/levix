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
finish();

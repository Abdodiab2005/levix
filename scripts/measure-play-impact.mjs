// Q-16: compare built APK structure, merged manifests and resolved dependencies.
// APK bytes are artifact sizes, never Play download or incremental-update sizes.
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const [baselineApk, proposedApk, analyzer, baselineDeps, proposedDeps, output] =
  process.argv.slice(2);
if (!output)
  throw new Error(
    "usage: baseline.apk proposed.apk apkanalyzer baseline-deps.txt proposed-deps.txt output.json",
  );
const manifest = (apk) =>
  execFileSync(analyzer, ["manifest", "print", apk], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
const base = manifest(baselineApk);
const next = manifest(proposedApk);
const entries = (xml, tag) =>
  [...xml.matchAll(new RegExp(`<${tag}\\b[\\s\\S]*?\\/>`, "g"))]
    .map((match) => match[0].replace(/\s+/g, " "))
    .sort();
const extra = (before, after) => after.filter((value) => !before.includes(value));
const permissions = extra(entries(base, "uses-permission"), entries(next, "uses-permission"));
const features = extra(entries(base, "uses-feature"), entries(next, "uses-feature"));
const libraries = extra(entries(base, "uses-library"), entries(next, "uses-library"));
const depsBefore = readFileSync(baselineDeps, "utf8");
const depsAfter = readFileSync(proposedDeps, "utf8");
const deps = (text) =>
  [...new Set(text.match(/com\.google\.android\.(?:play|gms):[\w.-]+:[\w.-]+/g) || [])].sort();
const added = extra(deps(depsBefore), deps(depsAfter));
const report = {
  baselineApk,
  proposedApk,
  apkBytes: {
    baseline: readFileSync(baselineApk).length,
    proposed: readFileSync(proposedApk).length,
  },
  addedPermissions: permissions,
  addedFeatures: features,
  addedLibraries: libraries,
  addedGoogleDependencies: added,
  gmsRuntimeDependencies: deps(depsAfter).filter((value) =>
    value.startsWith("com.google.android.gms:"),
  ),
  // No flavors are selected here. This reports the evidence for the Q-16 decision.
  type: "built-artifact-comparison; not Google Play download size",
};
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (libraries.length || features.some((value) => !value.includes('android:required="false"'))) {
  process.exitCode = 1;
}

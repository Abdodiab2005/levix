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
// Parse both self-closing and expanded tags with the standard XML parser.
const entries = (xml, tag) =>
  JSON.parse(
    execFileSync(
      "python3",
      [
        "-c",
        `
import json,sys,xml.etree.ElementTree as ET
root=ET.fromstring(sys.stdin.read())
print(json.dumps(sorted([json.dumps(dict(sorted(e.attrib.items())),sort_keys=True) for e in root.iter(sys.argv[1])])) )
`,
        tag,
      ],
      { input: xml, encoding: "utf8" },
    ),
  );
const extra = (before, after) => after.filter((value) => !before.includes(value));
const permissions = extra(entries(base, "uses-permission"), entries(next, "uses-permission"));
const features = extra(entries(base, "uses-feature"), entries(next, "uses-feature"));
const libraries = extra(entries(base, "uses-library"), entries(next, "uses-library"));
const depsBefore = readFileSync(baselineDeps, "utf8");
const depsAfter = readFileSync(proposedDeps, "utf8");
const deps = (text) =>
  [
    ...new Set(
      [
        ...text.matchAll(
          /^LEVIX_RUNTIME_MODULE (com\.google\.android\.(?:play|gms):[\w.-]+:[\w.-]+)$/gm,
        ),
      ].map((match) => match[1]),
    ),
  ].sort();
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
const required = (value) =>
  JSON.parse(value)["{http://schemas.android.com/apk/res/android}required"] !== "false";
if (libraries.some(required) || features.some(required)) {
  process.exitCode = 1;
}

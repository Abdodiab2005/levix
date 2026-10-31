// size-report.mjs groups APK and AAB entries and tags packages from a lockfile.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipTree } from "../android/scripts/zip-tree.mjs";
import {
  buildReport,
  classifyEntry,
  componentRows,
  readZip,
  renderMarkdown,
} from "../scripts/size-report.mjs";
import { equal, finish, ok, section } from "./harness.mjs";

const NATIVE_FILE = /(?:^|\/)lib\/([^/]+)\/[^/]+$/;

function expectClass(name) {
  const base = name.slice(name.lastIndexOf("/") + 1);
  if (base === "levix-app.zip") return "levix-app.zip";
  const native = NATIVE_FILE.exec(name);
  if (native) return `native ${native[1]}`;
  if (/^classes\d*\.dex$/.test(base) || name.startsWith("base/dex/")) return "dex";
  if (
    base === "resources.arsc" ||
    name === "base/resources.pb" ||
    name.startsWith("res/") ||
    name.startsWith("base/res/")
  ) {
    return "resources";
  }
  return "other";
}

function sumsOf(entries) {
  const sums = {};
  for (const entry of entries) {
    const name = expectClass(entry.name);
    const row = sums[name] ?? { stored: 0, uncompressed: 0 };
    row.stored += entry.compressedSize;
    row.uncompressed += entry.uncompressedSize;
    sums[name] = row;
  }
  return sums;
}

function under(name, prefix) {
  return name === prefix || name.startsWith(`${prefix}/`);
}

const root = mkdtempSync(join(tmpdir(), "levix-size-"));

try {
  section("apk and aab components");

  const appDir = join(root, "app");
  mkdirSync(join(appDir, "src"), { recursive: true });
  mkdirSync(join(appDir, "node_modules", "prodpkg"), { recursive: true });
  mkdirSync(join(appDir, "node_modules", "@scope", "devpkg"), { recursive: true });
  mkdirSync(join(appDir, "node_modules", "concat-stream", "node_modules", "readable-stream"), {
    recursive: true,
  });
  mkdirSync(join(appDir, "node_modules", "pino", "test", "fixtures", "eval", "node_modules"), {
    recursive: true,
  });
  mkdirSync(join(appDir, "node_modules", "mystery"), { recursive: true });
  writeFileSync(join(appDir, "src", "a.js"), "console.log(1)\n");
  writeFileSync(join(appDir, "node_modules", "prodpkg", "index.js"), "module.exports = 1;\n");
  writeFileSync(
    join(appDir, "node_modules", "@scope", "devpkg", "index.js"),
    "module.exports = 2;\n",
  );
  writeFileSync(join(appDir, "node_modules", "concat-stream", "index.js"), "concat\n");
  writeFileSync(
    join(appDir, "node_modules", "concat-stream", "node_modules", "readable-stream", "index.js"),
    "readable\n",
  );
  writeFileSync(
    join(appDir, "node_modules", "pino", "test", "fixtures", "eval", "node_modules", "file14.js"),
    "fixture\n",
  );
  writeFileSync(join(appDir, "node_modules", "mystery", "index.js"), "mystery\n");
  const appZip = join(root, "levix-app.zip");
  writeFileSync(appZip, zipTree(appDir));

  const apkDir = join(root, "apk");
  mkdirSync(join(apkDir, "lib", "arm64-v8a"), { recursive: true });
  mkdirSync(join(apkDir, "assets"), { recursive: true });
  mkdirSync(join(apkDir, "res"), { recursive: true });
  writeFileSync(join(apkDir, "AndroidManifest.xml"), "<manifest/>");
  writeFileSync(join(apkDir, "lib", "arm64-v8a", "libnode.so"), Buffer.alloc(100, 1));
  writeFileSync(join(apkDir, "lib", "arm64-v8a", "libz_1.so"), Buffer.alloc(40, 2));
  writeFileSync(join(apkDir, "assets", "levix-app.zip"), readFileSync(appZip));
  writeFileSync(join(apkDir, "classes.dex"), Buffer.alloc(20, 3));
  writeFileSync(join(apkDir, "resources.arsc"), Buffer.alloc(10, 4));
  writeFileSync(join(apkDir, "res", "x.xml"), "<x/>");

  const aabDir = join(root, "aab");
  mkdirSync(join(aabDir, "base", "manifest"), { recursive: true });
  mkdirSync(join(aabDir, "base", "lib", "arm64-v8a"), { recursive: true });
  mkdirSync(join(aabDir, "base", "assets"), { recursive: true });
  mkdirSync(join(aabDir, "base", "dex"), { recursive: true });
  mkdirSync(join(aabDir, "base", "res"), { recursive: true });
  writeFileSync(join(aabDir, "base", "manifest", "AndroidManifest.xml"), "<manifest/>");
  writeFileSync(join(aabDir, "base", "lib", "arm64-v8a", "libnode.so"), Buffer.alloc(100, 1));
  writeFileSync(join(aabDir, "base", "lib", "arm64-v8a", "libz_1.so"), Buffer.alloc(40, 2));
  writeFileSync(join(aabDir, "base", "assets", "levix-app.zip"), readFileSync(appZip));
  writeFileSync(join(aabDir, "base", "dex", "classes.dex"), Buffer.alloc(20, 3));
  writeFileSync(join(aabDir, "base", "resources.pb"), Buffer.alloc(10, 4));
  writeFileSync(join(aabDir, "base", "res", "x.xml"), "<x/>");

  const apkPath = join(root, "app.apk");
  const aabPath = join(root, "app.aab");
  writeFileSync(apkPath, zipTree(apkDir));
  writeFileSync(aabPath, zipTree(aabDir));

  const lockPath = join(root, "package-lock.json");
  writeFileSync(
    lockPath,
    JSON.stringify({
      packages: {
        "node_modules/prodpkg": { version: "1.0.0" },
        "node_modules/@scope/devpkg": { version: "1.0.0", dev: true },
        "node_modules/concat-stream": { version: "1.0.0" },
        "node_modules/concat-stream/node_modules/readable-stream": {
          version: "2.0.0",
          dev: true,
        },
        "node_modules/pino": { version: "1.0.0" },
      },
    }),
  );
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  const report = buildReport([apkPath, aabPath], lock);

  equal("artifact keys", Object.keys(report.artifacts).sort().join(","), "aab,apk:arm64-v8a");
  equal("schema", report.schema, 1);

  const apkZip = readZip(readFileSync(apkPath));
  const aabZip = readZip(readFileSync(aabPath));
  equal(
    "apk file bytes",
    report.artifacts["apk:arm64-v8a"].fileBytes,
    readFileSync(apkPath).length,
  );
  equal("apk entries", report.artifacts["apk:arm64-v8a"].entries, apkZip.entries.length);
  equal("aab entries", report.artifacts.aab.entries, aabZip.entries.length);

  for (const [label, zip, artifact] of [
    ["apk", apkZip, report.artifacts["apk:arm64-v8a"]],
    ["aab", aabZip, report.artifacts.aab],
  ]) {
    const sums = sumsOf(zip.entries);
    equal(
      `${label} component keys`,
      Object.keys(artifact.components).sort().join(","),
      Object.keys(sums).sort().join(","),
    );
    for (const entry of zip.entries) {
      equal(`${label} ${entry.name}`, classifyEntry(entry.name), expectClass(entry.name));
    }
    for (const name of Object.keys(sums)) {
      equal(`${label} ${name} stored`, artifact.components[name].stored, sums[name].stored);
      equal(
        `${label} ${name} uncompressed`,
        artifact.components[name].uncompressed,
        sums[name].uncompressed,
      );
    }
  }

  equal(
    "apk libraries",
    Object.keys(report.artifacts["apk:arm64-v8a"].libraries).sort().join(","),
    "lib/arm64-v8a/libnode.so,lib/arm64-v8a/libz_1.so",
  );
  equal(
    "aab libraries",
    Object.keys(report.artifacts.aab.libraries).sort().join(","),
    "base/lib/arm64-v8a/libnode.so,base/lib/arm64-v8a/libz_1.so",
  );

  const inner = readZip(apkZip.entries.find((entry) => entry.name === "assets/levix-app.zip").data);
  const nestedPrefix = "node_modules/concat-stream/node_modules/readable-stream";
  let dev = 0;
  let prod = 0;
  let nested = 0;
  let parent = 0;
  let pino = 0;
  let mystery = 0;
  for (const entry of inner.entries) {
    if (under(entry.name, "node_modules/@scope/devpkg")) dev += entry.compressedSize;
    if (under(entry.name, "node_modules/prodpkg")) prod += entry.compressedSize;
    if (under(entry.name, nestedPrefix)) nested += entry.compressedSize;
    else if (under(entry.name, "node_modules/concat-stream")) parent += entry.compressedSize;
    if (under(entry.name, "node_modules/pino")) pino += entry.compressedSize;
    if (under(entry.name, "node_modules/mystery")) mystery += entry.compressedSize;
  }
  const app = report.artifacts["apk:arm64-v8a"].app;
  const nestedName = "concat-stream/node_modules/readable-stream";
  equal(
    "package names",
    Object.keys(app.packages).sort().join(","),
    ["@scope/devpkg", "concat-stream", nestedName, "mystery", "pino", "prodpkg"].sort().join(","),
  );
  equal("prodpkg is prod", app.packages.prodpkg.type, "prod");
  equal("devpkg is dev", app.packages["@scope/devpkg"].type, "dev");
  equal("prodpkg compressed", app.packages.prodpkg.compressed, prod);
  equal("devpkg compressed", app.packages["@scope/devpkg"].compressed, dev);
  equal("concat-stream is prod", app.packages["concat-stream"].type, "prod");
  equal("concat-stream compressed", app.packages["concat-stream"].compressed, parent);
  equal("nested package is dev", app.packages[nestedName].type, "dev");
  equal("nested package compressed", app.packages[nestedName].compressed, nested);
  equal("pino is prod", app.packages.pino.type, "prod");
  equal("pino compressed includes the fixture", app.packages.pino.compressed, pino);
  ok("file14.js is not a package", !Object.hasOwn(app.packages, "file14.js"));
  equal("mystery is unknown", app.packages.mystery.type, "unknown");
  equal("mystery compressed", app.packages.mystery.compressed, mystery);
  equal("apk dev total", app.devCompressed, dev + nested);
  equal("aab dev total", report.artifacts.aab.app.devCompressed, dev + nested);
  equal("inner entry count", app.entries, inner.entries.length);
  ok("top-level src", Object.hasOwn(app.topLevel, "src"));
  ok("top-level node_modules", Object.hasOwn(app.topLevel, "node_modules"));

  section("baseline delta");

  const baseline = JSON.parse(JSON.stringify(report));
  delete baseline.artifacts.aab;
  const current = report.artifacts["apk:arm64-v8a"].components.dex.stored;
  baseline.artifacts["apk:arm64-v8a"].components.dex.stored = current + 5;
  const rows = componentRows(
    report.artifacts["apk:arm64-v8a"].components,
    baseline.artifacts["apk:arm64-v8a"].components,
  );
  const dex = rows.find((row) => row.name === "dex");
  equal("dex delta", dex.delta, -5);
  const pct = (-5 / (current + 5)) * 100;
  ok("dex percent", Math.abs(dex.deltaPct - pct) < 1e-9);
  const markdown = renderMarkdown(report, baseline);
  ok("markdown shows the delta", markdown.includes("| -5 |"));
  ok(
    "apk table has baseline columns",
    markdown.includes("| component | stored bytes | baseline | delta | delta % |"),
  );
  const aabPart = markdown.split("## aab\n")[1] ?? "";
  ok("aab section is present", aabPart.length > 0);
  ok("aab has no baseline columns", !aabPart.includes("delta %"));
} finally {
  rmSync(root, { recursive: true, force: true });
}

finish();

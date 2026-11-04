import { readFileSync } from "node:fs";
import { join } from "node:path";
import { finish, ok, ROOT, section } from "./harness.mjs";

section("dashboard fonts are served locally");
const html = readFileSync(join(ROOT, "frontend/index.html"), "utf8");
const css = readFileSync(join(ROOT, "frontend/src/assets/fonts/fonts.css"), "utf8");
ok("dashboard has no Google Fonts request", !/fonts\.(googleapis|gstatic)\.com/.test(html + css));
for (const family of ["Plus Jakarta Sans", "Tajawal", "JetBrains Mono"]) {
  ok(`${family} remains available`, css.includes(`font-family: '${family}'`));
}
for (const [, file] of css.matchAll(/url\(\.\/([^)]*)\)/g)) {
  const bytes = readFileSync(join(ROOT, "frontend/src/assets/fonts", file));
  ok(`${file} is a WOFF2 font`, bytes.subarray(0, 4).toString() === "wOF2");
}
finish();

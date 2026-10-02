import { readFileSync } from "node:fs";
import { join } from "node:path";
import { finish, ok, ROOT, section } from "./harness.mjs";

section("dashboard.css fixes");

const css = readFileSync(join(ROOT, "public/dashboard.css"), "utf8");
ok("the hidden rule exists for .gateway-back-btn", css.includes(".gateway-back-btn[hidden] {"));

finish();

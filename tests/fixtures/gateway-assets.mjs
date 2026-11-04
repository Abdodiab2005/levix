// A gateway asset root owned by one test file. No checkout build is consulted.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "../harness.mjs";

export function gatewayAssets() {
  const root = mkdtempSync(join(tmpdir(), "levix-gateway-test-"));
  symlinkSync(join(ROOT, "src"), join(root, "src"), "dir");
  const dashboard = join(root, "public", "dashboard");
  mkdirSync(dashboard, { recursive: true });
  const shell = join(dashboard, "gateway.html");
  const preload = join(root, "preload.cjs");
  writeFileSync(
    preload,
    `require(${JSON.stringify(join(ROOT, "src/config/paths.cjs"))}).setAssetRoot(${JSON.stringify(root)});\n`,
  );
  process.on("exit", () => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    preload,
    fallback() {
      rmSync(shell, { force: true });
    },
    react() {
      writeFileSync(shell, '<!doctype html><html><head></head><body><div id="root"></div></body></html>');
    },
  };
}

export function gatewayState(html) {
  const match = /<script id="levix-gateway-state" type="application\/json">([^<]*)<\/script>/.exec(html);
  return match ? JSON.parse(match[1]) : null;
}

// Deterministic public-document allowlist. No runtime scan or external service.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const MAX_SECTION_CHARS = 4000;
export const SOURCES = Object.freeze([
  "README.md",
  "SETUP.md",
  "ANDROID.md",
  "PRIVACY.md",
  ...["en", "ar", "pt-BR", "es-419"].map((locale) => `i18n/${locale}/commands.json`),
]);

function slug(text) {
  return (
    text
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "intro"
  );
}
export function markdownSections(markdown) {
  const clean = markdown
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/^.*<(?:a|img|p)\b[^>]*>.*$/gm, "")
    .replace(/<\/?(?:p|a|img|div|span|br|strong|em|h[1-6])\b[^>]*>/gi, "")
    .replace(/!?\[([^\]\n]+)\]\([^\n)]+\)/g, "$1");
  const sections = [];
  let title = "Introduction";
  let lines = [];
  let fence = null;
  const flush = () => {
    const text = lines.join("\n").trim();
    if (text) sections.push({ title: title.slice(0, 160), text });
    lines = [];
  };
  for (const line of clean.split(/\r?\n/)) {
    const delimiter = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]?.[0];
    if (delimiter) fence = fence === delimiter ? null : fence || delimiter;
    const heading = !fence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      flush();
      title = heading[2];
    } else lines.push(line);
  }
  flush();
  return sections;
}
export function buildIndex({ version, sources }) {
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version))
    throw new Error("Invalid documentation release version");
  if (
    !sources ||
    Object.keys(sources).length !== SOURCES.length ||
    Object.keys(sources).some((source) => !SOURCES.includes(source))
  )
    throw new Error("Documentation sources must match the public allowlist");
  const sections = [];
  const digests = [];
  for (const source of SOURCES) {
    const raw = sources[source];
    if (typeof raw !== "string") throw new Error("Missing documentation source");
    digests.push({ file: source, sha256: createHash("sha256").update(raw).digest("hex") });
    const locale = source.startsWith("i18n/") ? source.split("/")[1] : "en";
    let parts;
    if (source.endsWith(".json")) {
      const catalog = JSON.parse(raw);
      parts = Object.keys(catalog)
        .sort()
        .filter((key) => key.endsWith(".description"))
        .map((key) => {
          const name = key.slice(0, -".description".length);
          const usage = catalog[`${name}.usage`] ?? "";
          if (typeof catalog[key] !== "string" || typeof usage !== "string")
            throw new Error("Invalid command documentation");
          return { title: `!${name}`, text: `${catalog[key]}\n${usage}` };
        });
    } else parts = markdownSections(raw);
    const used = new Map();
    for (const part of parts) {
      const base = slug(part.title);
      const count = (used.get(base) || 0) + 1;
      used.set(base, count);
      const id = `${source}#${base}${count > 1 ? `-${count}` : ""}`;
      let remaining = part.text;
      for (let n = 1; remaining; n += 1) {
        let end = Math.min(remaining.length, MAX_SECTION_CHARS);
        if (end < remaining.length) {
          const boundary = remaining.lastIndexOf("\n", end);
          if (boundary > end / 2) end = boundary;
        }
        sections.push({
          id: `${id}${n > 1 ? `-part${n}` : ""}`,
          source,
          title: part.title,
          locale,
          text: remaining.slice(0, end).trim(),
        });
        remaining = remaining.slice(end).trimStart();
      }
    }
  }
  const index = { schema: 1, version, sources: digests, sections };
  if (Buffer.byteLength(JSON.stringify(index)) > 1024 * 1024)
    throw new Error("Documentation index exceeds 1 MiB");
  return index;
}
export function buildFromRepository(root = ROOT) {
  return buildIndex({
    version: JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version,
    sources: Object.fromEntries(
      SOURCES.map((source) => [source, readFileSync(join(root, source), "utf8")]),
    ),
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (!["build", "check"].includes(mode)) throw new Error("Usage: build-ai-docs.mjs build|check");
  const output = `${JSON.stringify(buildFromRepository(), null, 2)}\n`;
  const target = join(ROOT, "src/services/levix-docs.generated.json");
  if (mode === "build") writeFileSync(target, output);
  else if (readFileSync(target, "utf8") !== output)
    throw new Error("Bundled documentation is stale; run npm run docs:build");
  console.log(`Documentation index ${mode}: PASS`);
}

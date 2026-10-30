// Prove the staged tree can load every package its own code names.
// node_modules is not scanned: those files belong to dependencies, and a
// missing package there is that package's problem, not the app's.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

// Names that may be absent. Each value is why the app still runs.
export const OPTIONAL = {
  "ffmpeg-static":
    "Android ships libffmpeg.so; src/utils/thumbnail.cjs loads it in try/catch",
};

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

function isIdent(ch) {
  return ch !== undefined && /[A-Za-z0-9_$]/.test(ch);
}

function isSpace(ch) {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f";
}

function startsWord(code, pos, word) {
  if (!code.startsWith(word, pos)) return false;
  if (pos > 0 && isIdent(code[pos - 1])) return false;
  const after = code[pos + word.length];
  return after === undefined || !isIdent(after);
}

function readQuoted(code, pos) {
  const quote = code[pos];
  if (quote !== "'" && quote !== '"') return null;
  let i = pos + 1;
  let value = "";
  while (i < code.length) {
    const ch = code[i];
    if (ch === "\\") {
      value += code[i + 1] ?? "";
      i += 2;
      continue;
    }
    if (ch === quote) return { value, next: i + 1 };
    if (ch === "\n") return null;
    value += ch;
    i += 1;
  }
  return null;
}

// Spaces and comments between a keyword and its string literal.
function skipGap(code, pos) {
  let i = pos;
  while (i < code.length) {
    while (i < code.length && isSpace(code[i])) i += 1;
    if (code[i] === "/" && code[i + 1] === "/") {
      i += 2;
      while (i < code.length && code[i] !== "\n") i += 1;
      continue;
    }
    if (code[i] === "/" && code[i + 1] === "*") {
      i += 2;
      while (i < code.length && !(code[i] === "*" && code[i + 1] === "/")) i += 1;
      i = Math.min(code.length, i + 2);
      continue;
    }
    break;
  }
  return i;
}

// String literals that are the module specifier of require, import or export.
// Comments and ordinary strings are skipped, so a mention in prose is not a load.
function collectSpecifiers(code) {
  const found = [];
  const n = code.length;

  function scan(pos, expr) {
    let i = pos;
    let braces = 0;
    while (i < n) {
      const ch = code[i];
      const next = code[i + 1];
      if (ch === "/" && next === "/") {
        i += 2;
        while (i < n && code[i] !== "\n") i += 1;
        continue;
      }
      if (ch === "/" && next === "*") {
        i += 2;
        while (i < n && !(code[i] === "*" && code[i + 1] === "/")) i += 1;
        i = Math.min(n, i + 2);
        continue;
      }
      if (ch === "'" || ch === '"') {
        const read = readQuoted(code, i);
        i = read ? read.next : i + 1;
        continue;
      }
      if (ch === "`") {
        i = skipTemplate(i + 1);
        continue;
      }
      if (startsWord(code, i, "require") || startsWord(code, i, "import")) {
        const word = code.startsWith("require", i) ? "require" : "import";
        let j = skipGap(code, i + word.length);
        if (code[j] === "(") {
          j = skipGap(code, j + 1);
          const read = readQuoted(code, j);
          if (read) {
            found.push(read.value);
            i = read.next;
            continue;
          }
        } else if (word === "import") {
          const read = readQuoted(code, j);
          if (read) {
            found.push(read.value);
            i = read.next;
            continue;
          }
        }
      }
      if (startsWord(code, i, "from")) {
        const j = skipGap(code, i + 4);
        const read = readQuoted(code, j);
        if (read) {
          found.push(read.value);
          i = read.next;
          continue;
        }
      }
      if (ch === "{") {
        braces += 1;
        i += 1;
        continue;
      }
      if (ch === "}") {
        if (braces === 0) {
          if (expr) return i + 1;
          i += 1;
          continue;
        }
        braces -= 1;
        i += 1;
        continue;
      }
      i += 1;
    }
    return i;
  }

  // ${} inside a template is code, so a require there still counts.
  function skipTemplate(pos) {
    let i = pos;
    while (i < n) {
      const ch = code[i];
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "`") return i + 1;
      if (ch === "$" && code[i + 1] === "{") {
        i = scan(i + 2, true);
        continue;
      }
      i += 1;
    }
    return i;
  }

  scan(0, false);
  return found;
}

// Bare package name, or null when the specifier is not a third-party package.
function packageName(specifier) {
  if (typeof specifier !== "string" || specifier.length === 0) return null;
  if (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("#") ||
    specifier.startsWith("node:")
  ) {
    return null;
  }
  if (/^[A-Za-z]:[\\/]/.test(specifier)) return null;
  if (isBuiltin(specifier)) return null;
  if (specifier.startsWith("@")) {
    const slash = specifier.indexOf("/");
    if (slash <= 1) return null;
    const second = specifier.indexOf("/", slash + 1);
    const name = second === -1 ? specifier : specifier.slice(0, second);
    return name.split("/")[1] ? name : null;
  }
  const slash = specifier.indexOf("/");
  return slash === -1 ? specifier : specifier.slice(0, slash);
}

function sourceFiles(dir, out) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.isSymbolicLink()) continue;
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === "node_modules") continue;
      sourceFiles(full, out);
      continue;
    }
    if (ent.isFile() && /\.(?:mjs|cjs|js)$/.test(ent.name)) out.push(full);
  }
  return out;
}

function packageJson(stageDir, name) {
  return join(stageDir, "node_modules", ...name.split("/"), "package.json");
}

// Packages the staged app code loads, and which of them are absent.
export function scanStage(stageDir) {
  const byPackage = new Map();
  for (const file of sourceFiles(stageDir, [])) {
    const rel = relative(stageDir, file).split(sep).join("/");
    const text = readFileSync(file, "utf8");
    for (const specifier of collectSpecifiers(text)) {
      const name = packageName(specifier);
      if (!name) continue;
      if (!byPackage.has(name)) byPackage.set(name, new Set());
      byPackage.get(name).add(rel);
    }
  }
  const packages = [...byPackage.keys()].sort();
  const missing = [];
  for (const name of packages) {
    if (existsSync(packageJson(stageDir, name))) continue;
    if (Object.hasOwn(OPTIONAL, name)) continue;
    missing.push({ name, files: [...byPackage.get(name)].sort() });
  }
  return { count: packages.length, packages, missing };
}

if (isDirectRun()) {
  const stageDir = process.argv[2];
  if (!stageDir) {
    process.stderr.write("usage: node check-stage-deps.mjs <stageDir>\n");
    process.exit(2);
  }
  const result = scanStage(stageDir);
  if (result.missing.length > 0) {
    for (const item of result.missing) {
      console.log(`missing ${item.name}: ${item.files.join(", ")}`);
    }
    process.exit(1);
  }
  console.log(
    `Stage dependencies OK: ${result.count} packages loaded by the app code, all present`,
  );
}

// Owner tool for the Terms signing key. Never run in CI.
//
//   node scripts/legal-release.mjs keygen --out <path>
//   node scripts/legal-release.mjs public-key --key <path>
//   node scripts/legal-release.mjs sign --key <path> --out <path> [--dir <dir>]
//
// keygen writes a PKCS#8 PEM (mode 0600) and prints the keyId and the base64
// raw public key for src/legal/keys.cjs. It refuses a path inside this
// repository and refuses to overwrite. The private key is never printed.

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { buildRelease, signRelease, verifyEnvelope } = require("../src/legal/release.cjs");
const { keyIdForRaw, rawFromKeyObject } = require("../src/legal/keys.cjs");

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = path.join(SCRIPT_DIR, "..", "src", "legal", "bundled");
const LOCALES = ["ar", "en", "pt-BR", "es-419"];

function die(message) {
  const text = String(message || "failed");
  const safe = /PRIVATE|BEGIN |END /.test(text) ? "failed" : text;
  process.stderr.write(`legal-release: ${safe}\n`);
  process.exit(1);
}

function repoRoot() {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: SCRIPT_DIR,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    die("Cannot resolve the git work tree, so the key path was refused.");
  }
}

function containedBy(parent, child) {
  const rel = path.relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function realTarget(file) {
  const abs = path.resolve(file);
  if (fs.existsSync(abs)) return fs.realpathSync(abs);
  const parent = path.dirname(abs);
  if (!fs.existsSync(parent)) die("output directory does not exist");
  return path.join(fs.realpathSync(parent), path.basename(abs));
}

function assertOutsideRepo(file) {
  const repo = fs.realpathSync(repoRoot());
  if (containedBy(repo, realTarget(file))) {
    die("Refusing to write a private key inside the repository.");
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) die(`Unexpected argument ${arg}`);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) die(`Missing value for ${arg}`);
    out[arg.slice(2)] = value;
    i += 1;
  }
  return out;
}

function readPrivate(file) {
  let pem;
  try {
    pem = fs.readFileSync(file);
  } catch {
    die("Could not read the Ed25519 private key.");
  }
  let key;
  try {
    key = crypto.createPrivateKey(pem);
  } catch {
    die("Could not read the Ed25519 private key.");
  }
  if (!key || key.asymmetricKeyType !== "ed25519") die("The key is not Ed25519.");
  return key;
}

function printPublic(raw) {
  process.stdout.write(`keyId: ${keyIdForRaw(raw)}\n`);
  process.stdout.write(`publicKey: ${raw.toString("base64")}\n`);
}

function rawOf(privateKey) {
  return rawFromKeyObject(crypto.createPublicKey(privateKey));
}

function keygen(args) {
  if (!args.out) die("keygen requires --out <path>");
  assertOutsideRepo(args.out);
  const target = path.resolve(args.out);
  if (fs.existsSync(target)) die("Refusing to overwrite an existing file.");
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  try {
    fs.writeFileSync(target, pem, { flag: "wx", mode: 0o600 });
    fs.chmodSync(target, 0o600);
  } catch {
    try {
      fs.rmSync(target, { force: true });
    } catch {
      // The write already failed. Leave the refuse message.
    }
    die("Could not write the private key.");
  }
  const mode = fs.statSync(target).mode & 0o777;
  if (mode !== 0o600) {
    fs.rmSync(target, { force: true });
    die("Could not set the private key file mode to 0600.");
  }
  const again = rawOf(readPrivate(target));
  const expected = rawFromKeyObject(publicKey);
  if (!again.equals(expected)) {
    fs.rmSync(target, { force: true });
    die("The written key did not match the key just generated.");
  }
  printPublic(expected);
}

function publicKey(args) {
  if (!args.key) die("public-key requires --key <path>");
  printPublic(rawOf(readPrivate(args.key)));
}

function sign(args) {
  if (!args.key || !args.out) die("sign requires --key <path> and --out <path>");
  const privateKey = readPrivate(args.key);
  const dir = args.dir ? path.resolve(args.dir) : DEFAULT_DIR;
  const documents = {};
  for (const locale of LOCALES) {
    const file = path.join(dir, `${locale}.json`);
    try {
      documents[locale] = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      die(`Could not read ${locale}.json`);
    }
  }
  const release = buildRelease(documents);
  const envelope = signRelease(release, privateKey);
  const raw = rawOf(privateKey);
  verifyEnvelope(envelope, [{ keyId: keyIdForRaw(raw), publicKey: raw.toString("base64") }]);
  const outDir = path.dirname(path.resolve(args.out));
  if (!fs.existsSync(outDir)) die("output directory does not exist");
  fs.writeFileSync(args.out, `${JSON.stringify(envelope, null, 2)}\n`);
  process.stdout.write(`signed version=${release.version} keyId=${envelope.keyId}\n`);
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (command === "keygen") keygen(args);
  else if (command === "public-key") publicKey(args);
  else if (command === "sign") sign(args);
  else die("Usage: legal-release.mjs keygen|public-key|sign");
}

try {
  main();
} catch (error) {
  die(error && error.message ? error.message : "failed");
}

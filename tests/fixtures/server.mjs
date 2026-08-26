// Boots the real control panel — app.cjs, the real routes, the real database —
// and prints the URL it is listening on. Everything WhatsApp is left out: no
// socket, no pairing, no network. That boundary is deliberate and the tests
// that use this say so.
//
// Used as a child process because app.cjs is a singleton: one process can only
// ever hold one trust-proxy configuration, and the setup boundary has to be
// tested under several.
//
//   node tests/fixtures/server.mjs --data <dir> [--trust 1] [--host 0.0.0.0] [--routes]

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const require = createRequire(`${ROOT}/package.json`);

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const dataDir = arg("data");
if (!dataDir) {
  console.error("--data is required");
  process.exit(1);
}
process.env.LEVIX_DATA_DIR = dataDir;

// Written before app.cjs is loaded: it reads the proxy setting once, at import.
const trust = arg("trust");
if (trust !== null) require(`${ROOT}/src/config/settings.cjs`).set("trust_proxy", trust);

const { app, server, dashboardJson, requireLoginApi, noStore, installFinalHandlers } =
  require(`${ROOT}/app.cjs`);

if (has("routes")) {
  const dashboardApi = (await import(`${ROOT}/src/routes/dashboard.api.esm.js`)).default;
  const { loadCommands } = await import(`${ROOT}/src/handlers/command.handler.js`);
  await loadCommands();
  app.use("/dashboard/api", requireLoginApi, noStore, dashboardJson, dashboardApi);
}

installFinalHandlers();

const host = arg("host", "127.0.0.1");
server.listen(0, host, () => {
  // What Express ended up trusting — a test needs this to check that a real
  // reverse-proxy deployment still resolves req.ip correctly.
  console.log(`TRUSTPROXY ${JSON.stringify(app.get("trust proxy") ?? null)}`);
  // The parent waits for this line.
  console.log(`LISTENING ${host}:${server.address().port}`);
});

process.on("SIGTERM", () => process.exit(0));

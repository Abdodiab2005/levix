// Exercise the real socket factory without creating a WhatsApp connection.
// Module mocking is isolated in a child so the normal test runner needs no flags.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { mock } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { equal, finish, ok, ROOT, require, section, useTempDataDir } from "./harness.mjs";

if (!process.execArgv.includes("--experimental-test-module-mocks")) {
  const child = spawnSync(
    process.execPath,
    ["--experimental-test-module-mocks", fileURLToPath(import.meta.url)],
    { stdio: "inherit", env: process.env, timeout: 30_000 },
  );
  if (child.error) console.error(child.error.message);
  process.exit(child.status ?? 1);
}

useTempDataDir("levix-photo-proxy");
process.env.LEVIX_ANDROID = "1";
const source = (path) => pathToFileURL(join(ROOT, path)).href;
mock.module(require.resolve("@whiskeysockets/baileys"), {
  namedExports: { makeWASocket: () => ({ sendMessage: async () => {} }) },
});
mock.module(source("src/auth/use-database-auth-state.js"), {
  namedExports: {
    useDatabaseAuthState: async () => ({ state: { creds: {} }, saveCreds() {}, clearAll() {} }),
  },
});
mock.module(source("src/config/baileys.config.js"), {
  namedExports: { getBaileysConfig: () => ({}), setRecentMessageGetter() {} },
});

const provider = require("./src/utils/providerUrl.cjs");
const undici = require("undici");
const originalSafeFetch = provider.safeProviderFetch;
const originalAssertUrl = provider.assertProviderRequestUrl;
const originalUndiciFetch = undici.fetch;
const calls = [];
const validations = [];
let rejectDestination = false;
let failProxy = false;
let closed = 0;
provider.assertProviderRequestUrl = async (url, options) => {
  validations.push({ url, options });
  if (rejectDestination) throw new Error("blocked destination");
  return new URL(url);
};
provider.safeProviderFetch = async (url, init, options) => {
  calls.push({ type: "direct", url, init, options });
  return new Response("direct image");
};
undici.fetch = async (url, init) => {
  calls.push({ type: "proxy", url, init });
  if (failProxy) throw new Error("proxy unavailable");
  return new Response("proxied image");
};

async function rejects(label, run) {
  try {
    await run();
    ok(label, false, "expected rejection");
  } catch {
    ok(label, true);
  }
}

try {
  const { createWhatsAppSocket, fetchWhatsAppImage } = await import(source("src/core/socket.js"));
  const dispatcherA = {
    close() {
      closed += 1;
    },
    destroy() {
      closed += 1;
    },
  };
  const dispatcherB = {
    close() {
      closed += 1;
    },
    destroy() {
      closed += 1;
    },
  };
  const proxy = (dispatcher) => ({ agent: {}, fetchAgent: {}, dispatcher, label: "test proxy" });
  const { sock: a } = await createWhatsAppSocket({ proxy: proxy(dispatcherA) });
  const { sock: b } = await createWhatsAppSocket({ proxy: proxy(dispatcherB) });
  const { sock: direct } = await createWhatsAppSocket();
  const url = "https://mmg.whatsapp.net/picture.jpg";
  const signal = AbortSignal.timeout(8000);

  section("photo bytes follow the transport captured by their socket");
  const response = await fetchWhatsAppImage(a, url, {
    signal,
    dispatcher: dispatcherB,
    redirect: "follow",
  });
  equal(
    "first socket uses its own dispatcher despite caller override",
    calls.at(-1).init.dispatcher,
    dispatcherA,
  );
  equal(
    "proxy redirects cannot escape destination validation",
    calls.at(-1).init.redirect,
    "manual",
  );
  equal("caller timeout signal survives", calls.at(-1).init.signal, signal);
  equal("validated destination reaches fetch unchanged", calls.at(-1).url, url);
  equal("proxy validates destination before fetching", validations.at(-1).url, url);
  equal(
    "proxy validation rejects loopback destinations",
    validations.at(-1).options.allowLoopback,
    false,
  );
  equal("proxied response remains readable", await response.text(), "proxied image");
  equal("consuming the photo does not close shared socket transport", closed, 0);

  await fetchWhatsAppImage(b, url);
  equal("second socket uses a different dispatcher", calls.at(-1).init.dispatcher, dispatcherB);
  require("./src/config/settings.cjs").set("whatsapp_proxy_enabled", false);
  await fetchWhatsAppImage(a, url);
  equal(
    "saved proxy changes do not alter the already-live socket",
    calls.at(-1).init.dispatcher,
    dispatcherA,
  );

  section("direct sockets retain the existing DNS-pinned fetch boundary");
  await fetchWhatsAppImage(direct, url, { signal });
  equal("direct socket delegates to safeProviderFetch", calls.at(-1).type, "direct");
  equal("direct socket preserves timeout", calls.at(-1).init.signal, signal);
  equal("direct socket cannot opt into loopback", calls.at(-1).options.allowLoopback, false);
  await fetchWhatsAppImage({}, url);
  equal("existing fake route sockets retain direct fetch behavior", calls.at(-1).type, "direct");

  section("invalid destinations and failed proxies never cause a direct request");
  const before = calls.length;
  for (const unsafe of [
    "http://mmg.whatsapp.net/a",
    "https://mmg.whatsapp.net.evil.test/a",
    "https://127.0.0.1/a",
    "not-a-url",
  ]) {
    await rejects(`proxied socket rejects ${unsafe}`, () => fetchWhatsAppImage(a, unsafe));
    await rejects(`direct socket rejects ${unsafe}`, () => fetchWhatsAppImage(direct, unsafe));
  }
  equal("URL guards run before either fetch implementation", calls.length, before);
  rejectDestination = true;
  await rejects("public-address validation failure rejects proxied fetch", () =>
    fetchWhatsAppImage(a, url),
  );
  equal("blocked public-address check never reaches a transport", calls.length, before);
  rejectDestination = false;
  failProxy = true;
  const directBefore = calls.filter((call) => call.type === "direct").length;
  await rejects("proxy network failure is propagated", () => fetchWhatsAppImage(a, url));
  equal(
    "proxy failure never falls back to the direct connection",
    calls.filter((call) => call.type === "direct").length,
    directBefore,
  );
  equal("failed photo never closes the shared transport", closed, 0);
} catch (error) {
  ok("photo transport regression checks execute", false, error?.stack || String(error));
} finally {
  provider.safeProviderFetch = originalSafeFetch;
  provider.assertProviderRequestUrl = originalAssertUrl;
  undici.fetch = originalUndiciFetch;
  finish();
}

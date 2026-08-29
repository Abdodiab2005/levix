// The WhatsApp session proxy.
//
// Two halves, both without a real proxy server anywhere:
//
//   * src/core/proxy.js on its own — validation, credential encoding, the two
//     agent shapes Baileys needs, and the redaction that keeps the password out
//     of everything a human or a browser sees.
//   * the session driving it — that the config reaches the socket factory, that
//     changing it while connected does not create a second socket, and that
//     "reconnect to apply" goes through the lifecycle rather than round it.
//
// What is NOT covered here is whether a real proxy accepts the connection; that
// needs a proxy and a phone. See the report.

import { EventEmitter } from "node:events";
import {
  useTempDataDir,
  require as harnessRequire,
  ROOT,
  section,
  ok,
  equal,
  finish,
} from "./harness.mjs";

useTempDataDir("levix-proxy");

const settings = harnessRequire("./src/config/settings.cjs");
const proxy = await import("../src/core/proxy.js");
const { WhatsAppSession, SESSION_STATES } = await import("../src/core/session.js");

const S = SESSION_STATES;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const silent = { info() {}, warn() {}, error() {}, debug() {}, trace() {} };

const PASSWORD = "s3cr3t:p@ss/word";

/** Put a whole proxy configuration into the real settings store. */
function saveProxy({ enabled, protocol = "http", host = "", port = 0, username = "", password = "" }) {
  settings.set("whatsapp_proxy_enabled", enabled);
  settings.set("whatsapp_proxy_protocol", protocol);
  settings.set("whatsapp_proxy_host", host);
  settings.set("whatsapp_proxy_port", port);
  settings.set("whatsapp_proxy_username", username);
  settings.set("whatsapp_proxy_password", password);
}

// ---------------------------------------------------------------------------

section("validation");

{
  const off = proxy.normalizeProxyConfig({ enabled: false, host: "", port: 0 });
  equal("a disabled proxy needs no host", off.enabled, false);

  const trimmed = proxy.normalizeProxyConfig({
    enabled: true,
    protocol: "  SOCKS5 ",
    host: "  10.0.0.1  ",
    port: "1080",
    username: "  bob  ",
  });
  equal("the protocol is normalised", trimmed.protocol, "socks5");
  equal("whitespace is trimmed off the host", trimmed.host, "10.0.0.1");
  equal("a string port becomes a number", trimmed.port, 1080);
  equal("and off the username", trimmed.username, "bob");

  const rejects = [
    [{ enabled: true, protocol: "ftp", host: "h", port: 1 }, "an unsupported protocol"],
    [{ enabled: true, protocol: "http", host: "", port: 8080 }, "a missing host"],
    [{ enabled: true, protocol: "http", host: "h", port: 0 }, "port 0"],
    [{ enabled: true, protocol: "http", host: "h", port: 65536 }, "port 65536"],
    [{ enabled: true, protocol: "http", host: "h", port: "abc" }, "a non-numeric port"],
  ];
  for (const [config, what] of rejects) {
    let threw = null;
    try {
      proxy.normalizeProxyConfig(config);
    } catch (error) {
      threw = error;
    }
    ok(`${what} is refused`, threw !== null);
    ok(`…and the message never carries a password`, !String(threw?.message).includes(PASSWORD));
  }

  for (const port of [1, 8080, 65535]) {
    const config = proxy.normalizeProxyConfig({ enabled: true, host: "h", port });
    equal(`port ${port} is accepted`, config.port, port);
  }
}

section("credentials are encoded the way the agent libraries decode them");

{
  const config = proxy.normalizeProxyConfig({
    enabled: true,
    protocol: "http",
    host: "proxy.example",
    port: 8080,
    username: "user name",
    password: PASSWORD,
  });

  const url = proxy.proxyUrl(config);
  ok(`the url is encoded (${url})`, url.includes("user%20name"));
  ok("the password is percent-encoded", url.includes(encodeURIComponent(PASSWORD)));
  ok("…so no raw @ or : breaks the authority", !url.includes(`:${PASSWORD}@`));

  // All three libraries decodeURIComponent() what they find in the URL, so
  // encoding here is what makes the round trip lossless.
  const parsed = new URL(url);
  equal("the username survives the round trip", decodeURIComponent(parsed.username), "user name");
  equal("and so does the password", decodeURIComponent(parsed.password), PASSWORD);
  equal("the host is untouched", parsed.hostname, "proxy.example");
  equal("and the port", parsed.port, "8080");
}

section("nothing human-facing carries the password");

{
  const config = proxy.normalizeProxyConfig({
    enabled: true,
    protocol: "socks5",
    host: "proxy.example",
    port: 1080,
    username: "bob",
    password: PASSWORD,
  });

  const redacted = proxy.redactProxy(config);
  ok(`the label names the proxy (${redacted})`, redacted.includes("proxy.example:1080"));
  ok("…and the username", redacted.includes("bob"));
  ok("but never the password", !redacted.includes(PASSWORD));

  equal("a disabled proxy has no label", proxy.redactProxy({ enabled: false }), null);

  const agents = proxy.createProxyAgents(config);
  ok("the built agents carry the redacted label", !agents.label.includes(PASSWORD));

  for (const [what, error] of [
    ["refused", Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })],
    ["auth", new Error("407 Proxy Authentication Required")],
    ["timeout", Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })],
    ["dns", Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" })],
    ["socks", new Error("Socks5 Authentication failed")],
    ["unknown", new Error("something else entirely")],
  ]) {
    const described = proxy.describeProxyFailure(error, config);
    ok(`a ${what} failure is explained`, typeof described === "string" && described.length > 10);
    ok(`…without the password`, !described.includes(PASSWORD));
    ok(`…and it names the proxy`, described.includes("proxy.example"));
  }

  equal(
    "a failure with the proxy off is not blamed on it",
    proxy.describeProxyFailure(new Error("boom"), { enabled: false }),
    null
  );
}

section("the two agent shapes Baileys actually needs");

{
  // Baileys has three network paths and they do NOT all want the same object:
  //
  //   agent              the WebSocket        -> https.request, classic agent
  //   fetchAgent         media upload on Node -> https.request, classic agent
  //   options.dispatcher media download       -> global fetch, undici Dispatcher
  //
  // Getting this backwards breaks quietly in both directions: a dispatcher
  // handed to https.request breaks uploads, and a classic agent handed to
  // fetch is ignored and the download goes out unproxied. Hence these checks.
  for (const protocol of ["http", "https", "socks5"]) {
    const config = proxy.normalizeProxyConfig({
      enabled: true,
      protocol,
      host: "proxy.example",
      port: 8080,
    });
    const agents = proxy.createProxyAgents(config);

    ok(
      `${protocol}: the WebSocket gets a classic http.Agent`,
      typeof agents.agent?.addRequest === "function"
    );
    ok(
      `${protocol}: media upload gets a classic http.Agent too`,
      typeof agents.fetchAgent?.addRequest === "function"
    );
    ok(
      `${protocol}: …and NOT an undici dispatcher, which https.request cannot use`,
      typeof agents.fetchAgent?.dispatch !== "function"
    );
    ok(
      `${protocol}: media download gets an undici Dispatcher`,
      typeof agents.dispatcher?.dispatch === "function"
    );

    const expected = protocol === "socks5" ? "SocksProxyAgent" : "HttpsProxyAgent";
    equal(`${protocol}: the right agent class`, agents.agent.constructor.name, expected);
    equal(`${protocol}: for upload as well`, agents.fetchAgent.constructor.name, expected);
  }

  equal("a disabled proxy builds nothing", proxy.createProxyAgents({ enabled: false }), null);
}

section("the socket config wires each agent to the path that can use it");

{
  // Read from the source rather than by booting Baileys: what matters is which
  // key each object is assigned to, and that is a fact about this one block.
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const source = readFileSync(join(ROOT, "src", "core", "socket.js"), "utf8");

  ok("the WebSocket agent goes to `agent`", /config\.agent\s*=\s*proxy\.agent/.test(source));
  ok("the upload agent goes to `fetchAgent`", /config\.fetchAgent\s*=\s*proxy\.fetchAgent/.test(source));
  ok(
    "the dispatcher goes to `options.dispatcher`",
    /dispatcher:\s*proxy\.dispatcher/.test(source)
  );
  ok(
    "and nothing is set when there is no proxy",
    /if \(proxy\) \{/.test(source)
  );
}

section("the socket factory is handed exactly what was configured");

/**
 * A session whose socket factory records the proxy it was given. Nothing here
 * opens a connection — the point is what reaches the factory.
 */
function makeHarness() {
  const sockets = [];
  const proxiesSeen = [];

  const session = new WhatsAppSession({
    createSocket: async ({ proxy: given } = {}) => {
      proxiesSeen.push(given);
      const sock = {
        user: null,
        ev: new EventEmitter(),
        async end() {},
        async logout() {},
      };
      sockets.push(sock);
      return { sock, saveCreds: async () => {}, clearAll: async () => {}, isPaired: true };
    },
    attachListeners: (sock, { onConnectionUpdate }) => {
      sock.updates = onConnectionUpdate;
    },
    onOpen: async () => {},
    retryDelaysMs: [20, 40],
    log: silent,
  });

  return {
    session,
    sockets,
    proxiesSeen,
    latest: () => sockets[sockets.length - 1],
    push: (update, socket = sockets[sockets.length - 1]) => socket.updates(update),
    async open() {
      await session.start();
      this.latest().user = { id: "1@s.whatsapp.net" };
      await this.push({ connection: "open" });
    },
  };
}

{
  saveProxy({ enabled: false });
  const h = makeHarness();
  await h.open();

  equal("with the proxy off the factory gets null", h.proxiesSeen[0], null);
  equal("…and the session reports no proxy", h.session.getState().proxy, null);
  ok("…and nothing to apply", !h.session.getState().proxyChanged);
  await h.session.stop();
}

{
  saveProxy({ enabled: true, protocol: "http", host: "http.example", port: 3128 });
  const h = makeHarness();
  await h.open();

  const given = h.proxiesSeen[0];
  ok("an HTTP proxy reaches the factory", !!given);
  ok("…as a WebSocket agent", !!given.agent);
  ok("…and a media dispatcher", typeof given.dispatcher.dispatch === "function");
  ok(
    `…and the session says so (${h.session.getState().proxy})`,
    h.session.getState().proxy.includes("http.example:3128")
  );
  await h.session.stop();
}

{
  saveProxy({
    enabled: true,
    protocol: "socks5",
    host: "socks.example",
    port: 1080,
    username: "bob",
    password: PASSWORD,
  });
  const h = makeHarness();
  await h.open();

  const given = h.proxiesSeen[0];
  ok("a SOCKS5 proxy reaches the factory", !!given);
  equal("…as a SocksProxyAgent", given.agent.constructor.name, "SocksProxyAgent");
  ok("…with a media dispatcher too", typeof given.dispatcher.dispatch === "function");

  const snapshot = h.session.getState();
  ok("the snapshot names it", snapshot.proxy.includes("socks.example:1080"));
  ok("…without the password", !JSON.stringify(snapshot).includes(PASSWORD));
  await h.session.stop();
}

section("changing the proxy never touches the live socket by itself");

{
  saveProxy({ enabled: true, protocol: "http", host: "first.example", port: 3128 });
  const h = makeHarness();
  await h.open();
  equal("one socket", h.sockets.length, 1);
  ok("nothing to apply yet", !h.session.getState().proxyChanged);

  // The operator edits the settings. This must not disturb anything.
  saveProxy({ enabled: true, protocol: "http", host: "second.example", port: 3128 });

  equal("the session is still connected", h.session.state, S.CONNECTED);
  equal("no second socket was created", h.sockets.length, 1);
  ok("but the panel is told a reconnect would change something", h.session.getState().proxyChanged);
  ok(
    "and the live socket still reports the OLD proxy",
    h.session.getState().proxy.includes("first.example")
  );

  await sleep(60);
  equal("still exactly one socket after waiting", h.sockets.length, 1);

  // Changing only the password must be noticed too.
  await h.session.stop();
}

{
  saveProxy({ enabled: true, protocol: "http", host: "p.example", port: 3128, username: "u", password: "one" });
  const h = makeHarness();
  await h.open();
  ok("clean to start with", !h.session.getState().proxyChanged);

  saveProxy({ enabled: true, protocol: "http", host: "p.example", port: 3128, username: "u", password: "two" });
  ok("a password-only change is still a change", h.session.getState().proxyChanged);
  await h.session.stop();
}

section("reconnect-to-apply goes through the lifecycle");

{
  saveProxy({ enabled: true, protocol: "http", host: "old.example", port: 3128 });
  const h = makeHarness();
  await h.open();
  saveProxy({ enabled: true, protocol: "http", host: "new.example", port: 3128 });

  await h.session.reconnect({ reason: "test" });

  equal("exactly one more socket was made", h.sockets.length, 2);
  ok(
    "the new one got the new proxy",
    h.proxiesSeen[1].label.includes("new.example")
  );
  ok("…and nothing is stale any more", !h.session.getState().proxyChanged);
  equal("the session is back on its way up", h.session.state, S.STARTING);
  await h.session.stop();
}

{
  // Reconnect and start racing must still leave one socket, exactly as two
  // Starts do — the same #starting guard covers both.
  saveProxy({ enabled: true, protocol: "http", host: "race.example", port: 3128 });
  const h = makeHarness();
  await h.open();
  const before = h.sockets.length;

  await Promise.all([
    h.session.reconnect({ reason: "a" }),
    h.session.start({ reason: "b" }),
    h.session.start({ reason: "c" }),
  ]);

  equal("one reconnect, not three", h.sockets.length, before + 1);
  await h.session.stop();
}

section("a proxy that cannot be built fails the attempt, it does not crash");

{
  // Enabled with no host: the settings layer stores it happily (half-typed
  // config is allowed), and the failure surfaces on the next connection.
  saveProxy({ enabled: true, protocol: "http", host: "", port: 0 });
  const h = makeHarness();
  await h.session.start();

  equal("the session reports an error state", h.session.state, S.ERROR);
  equal("no socket was created", h.sockets.length, 0);
  equal("and the reason names the proxy", h.session.getState().reason, "proxy_invalid");
  ok("the detail explains what to fix", /host/i.test(h.session.getState().detail));
  ok("it can still be started again by hand", h.session.getState().canStart);
}

section("a proxy that rejects the handshake does not hang");

{
  // ws only aborts a handshake when NOTHING listens for 'unexpected-response',
  // and Baileys registers a listener that ignores it — so a 407 used to produce
  // no error, no close and no state change at all. The session listens for it
  // and turns it into an ordinary close.
  saveProxy({ enabled: true, protocol: "http", host: "auth.example", port: 3128, username: "u", password: "wrong" });

  const sockets = [];
  let rejectHandshake = null;

  const session = new WhatsAppSession({
    createSocket: async () => {
      const sock = {
        user: null,
        ev: new EventEmitter(),
        ended: 0,
        async end(error) {
          this.ended += 1;
          // What Baileys does: end() emits the close through the normal path.
          this.updates?.({ connection: "close", lastDisconnect: { error } });
        },
        async logout() {},
      };
      sockets.push(sock);
      return { sock, saveCreds: async () => {}, clearAll: async () => {}, isPaired: true };
    },
    attachListeners: (sock, { onConnectionUpdate, onHandshakeRejected }) => {
      sock.updates = onConnectionUpdate;
      rejectHandshake = onHandshakeRejected;
    },
    onOpen: async () => {},
    // Long enough that the state after the rejection is observable — the
    // retry itself is covered in session.test.mjs.
    retryDelaysMs: [5000],
    log: silent,
  });

  await session.start();
  ok("the session is waiting on the handshake", session.state === S.STARTING);
  ok("a handshake-rejection hook was registered", typeof rejectHandshake === "function");

  rejectHandshake({ statusCode: 407 });
  await sleep(30);

  equal("the socket was ended rather than left hanging", sockets[0].ended, 1);
  equal(
    "…and the close ran through the normal state machine",
    session.state,
    S.RECONNECTING
  );
  const detail = session.getState().detail || "";
  ok(`the reason blames the proxy credentials (${detail})`, /username or password/i.test(detail));
  ok("without printing the password", !JSON.stringify(session.getState()).includes("wrong"));

  await session.stop();
  saveProxy({ enabled: false });
}

section("headless reads the same saved configuration");

{
  // Headless has no dashboard, but it builds its socket through exactly the
  // same session manager and the same settings read.
  saveProxy({ enabled: true, protocol: "socks5", host: "headless.example", port: 1080 });
  const h = makeHarness();
  await h.session.start({ reason: "autostart" });

  ok("the autostart path proxies too", !!h.proxiesSeen[0]);
  ok(
    "with the configured proxy",
    h.proxiesSeen[0].label.includes("headless.example:1080")
  );
  await h.session.stop();

  saveProxy({ enabled: false });
}

section("the settings API never hands the password back");

{
  saveProxy({
    enabled: true,
    protocol: "socks5",
    host: "proxy.example",
    port: 1080,
    username: "bob",
    password: PASSWORD,
  });

  const described = settings.describe();
  const password = described.find((entry) => entry.key === "whatsapp_proxy_password");

  equal("the password is a secret setting", password.type, "secret");
  equal("its value is never returned", password.value, null);
  equal("only whether it is set", password.configured, true);
  ok(
    "nothing in the whole settings payload contains it",
    !JSON.stringify(described).includes(PASSWORD)
  );

  const protocol = described.find((entry) => entry.key === "whatsapp_proxy_protocol");
  equal(
    "the protocol offers a fixed set of choices",
    JSON.stringify(protocol.choices),
    JSON.stringify(["http", "https", "socks5"])
  );

  let threw = null;
  try {
    settings.set("whatsapp_proxy_protocol", "ftp");
  } catch (error) {
    threw = error;
  }
  ok("and refuses anything else", threw !== null);

  saveProxy({ enabled: false });
}

finish();

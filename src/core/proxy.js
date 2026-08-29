// The outbound proxy for the WhatsApp session — and for nothing else.
//
// WHY TWO AGENT SHAPES
// --------------------
// Baileys rc14 does not have one network layer, it has two, and they want
// different objects:
//
//   * the WebSocket goes through the `ws` library, which puts the agent into
//     https.request (Socket/Client/websocket.js:30 — `agent: this.config.agent`).
//     Classic http.Agent.
//   * media UPLOAD goes through `uploadMedia`, and on Node that is
//     `uploadWithNodeHttp` — plain https.request again (Utils/messages-media.js:
//     633-642 branches on isNodeRuntime(); the fetch/dispatcher branch beside it
//     is for Bun and Deno only). Classic http.Agent, via `fetchAgent`.
//   * media DOWNLOAD goes through `getHttpStream`, which is Node's global fetch
//     — and fetch takes an undici Dispatcher and nothing else
//     (Utils/messages-media.js:297-301, `dispatcher: options.dispatcher`).
//
// Two of the three want a classic agent and the third wants a dispatcher, so
// this module builds both shapes from one configuration. Getting that mapping
// backwards is not a silent no-op in either direction: an undici dispatcher
// handed to https.request breaks uploads, and a classic agent handed to fetch
// is ignored, which would leave every download going out from the real IP.
//
// WHAT IS NOT PROXIED
// -------------------
// Nothing global is patched. The agents are handed to one `makeWASocket()`
// call by the session manager, so the dashboard's own HTTP server, Gemini,
// Groq and every other outbound request keep using the direct connection they
// use today.
//
// SECRETS
// -------
// The password is an ordinary `secret` setting, so it is stored like the API
// keys, never returned by the settings API, and never printed by settings.set.
// On top of that: `proxyUrl()` is the only function that puts the password in a
// string, its result never reaches a log or an HTTP response, and everything
// human-facing goes through `redactProxy()`.

import { createRequire } from "module";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import { Agent as UndiciAgent, ProxyAgent as UndiciProxyAgent } from "undici";
import { SocksClient } from "socks";
import tls from "node:tls";

const require = createRequire(import.meta.url);
const settings = require("../config/settings.cjs");

export const PROXY_PROTOCOLS = Object.freeze(["http", "https", "socks5"]);

const MIN_PORT = 1;
const MAX_PORT = 65535;

/** Everything the operator can set, read at call time like every other setting. */
export function readProxyConfig() {
  return normalizeProxyConfig({
    enabled: settings.get("whatsapp_proxy_enabled"),
    protocol: settings.get("whatsapp_proxy_protocol"),
    host: settings.get("whatsapp_proxy_host"),
    port: settings.get("whatsapp_proxy_port"),
    username: settings.get("whatsapp_proxy_username"),
    password: settings.get("whatsapp_proxy_password"),
  });
}

/**
 * Trim, coerce and check. Throws only on a value that cannot be used at all;
 * a disabled proxy is never validated, so half-filled settings can be saved
 * while the operator is still typing.
 *
 * @throws {Error} with a message safe to show a browser — it never contains
 *   the password.
 */
export function normalizeProxyConfig(raw = {}) {
  const enabled = raw.enabled === true || raw.enabled === "true" || raw.enabled === 1;
  const protocol = String(raw.protocol ?? "http").trim().toLowerCase();
  const host = String(raw.host ?? "").trim();
  const port = Number(raw.port ?? 0);
  // Usernames and passwords are taken exactly as given except for surrounding
  // whitespace, which is almost always a copy-paste accident.
  const username = String(raw.username ?? "").trim();
  const password = String(raw.password ?? "");

  const config = { enabled, protocol, host, port, username, password };
  if (!enabled) return config;

  if (!PROXY_PROTOCOLS.includes(protocol)) {
    throw new Error(`Proxy protocol must be one of: ${PROXY_PROTOCOLS.join(", ")}`);
  }
  if (!host) {
    throw new Error("Proxy host is required when the proxy is enabled");
  }
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new Error(`Proxy port must be a whole number between ${MIN_PORT} and ${MAX_PORT}`);
  }

  return config;
}

/**
 * The authenticated URL the agents want.
 *
 * Credentials are percent-encoded because all three agent libraries
 * `decodeURIComponent` them back out (verified in https-proxy-agent
 * dist/index.js:89, socks-proxy-agent dist/index.js:59, undici
 * proxy-agent.js:142) — so a password containing `@`, `:` or `/` survives the
 * round trip instead of corrupting the URL.
 *
 * NEVER log, return or embed this. Use redactProxy() for anything a human or a
 * browser will see.
 */
export function proxyUrl(config) {
  const auth = config.username
    ? `${encodeURIComponent(config.username)}:${encodeURIComponent(config.password)}@`
    : "";
  return `${config.protocol}://${auth}${config.host}:${config.port}`;
}

/** The same thing with the password removed. This is what may be shown. */
export function redactProxy(config) {
  if (!config?.enabled) return null;
  const auth = config.username ? `${config.username}:***@` : "";
  return `${config.protocol}://${auth}${config.host}:${config.port}`;
}

/**
 * An opaque value that changes whenever the effective proxy changes.
 *
 * Stays on the server: it is compared against the config the live socket was
 * built with to decide whether a reconnect would change anything. Only the
 * boolean answer is ever sent to a browser, so the password is not handed out
 * as a hash to be attacked offline.
 */
export function proxyFingerprint(config) {
  if (!config?.enabled) return "disabled";
  return proxyUrl(config);
}

/**
 * Build the agents for one socket, or null when the proxy is off.
 *
 * @returns {{ agent: object, fetchAgent: object, dispatcher: object, label: string } | null}
 */
export function createProxyAgents(config) {
  if (!config?.enabled) return null;

  const url = proxyUrl(config);
  const socks = config.protocol === "socks5";

  // For https.request: the WebSocket handshake and, on Node, media upload.
  const agent = socks ? new SocksProxyAgent(url) : new HttpsProxyAgent(url);

  // For global fetch: media download, app-state and history blobs. undici's own
  // ProxyAgent speaks HTTP CONNECT only, so SOCKS5 gets a plain undici Agent
  // whose socket factory dials through the SOCKS server instead.
  const dispatcher = socks ? socksDispatcher(config) : new UndiciProxyAgent(url);

  return {
    agent,
    // A second classic agent rather than the same instance: upload and the
    // WebSocket are long-lived, independent connections, and sharing one
    // agent's socket pool between them has no benefit.
    fetchAgent: socks ? new SocksProxyAgent(url) : new HttpsProxyAgent(url),
    dispatcher,
    label: redactProxy(config),
  };
}

/**
 * An undici Dispatcher that reaches the origin through a SOCKS5 server.
 *
 * undici hands us the target and expects a connected (and, for https, TLS-
 * wrapped) socket back. `socks` does the SOCKS5 handshake; the TLS upgrade is
 * ours to do, exactly as undici's own default connector would.
 */
function socksDispatcher(config) {
  const proxy = {
    host: config.host,
    port: config.port,
    type: 5,
    ...(config.username
      ? { userId: config.username, password: config.password }
      : {}),
  };

  return new UndiciAgent({
    connect: (options, callback) => {
      const port = Number(options.port) || (options.protocol === "http:" ? 80 : 443);
      SocksClient.createConnection({
        proxy,
        command: "connect",
        destination: { host: options.hostname, port },
      })
        .then(({ socket }) => {
          if (options.protocol !== "https:") return callback(null, socket);
          const secure = tls.connect({
            ...options,
            socket,
            servername: options.servername || options.hostname,
          });
          secure.once("secureConnect", () => callback(null, secure));
          secure.once("error", (error) => callback(error, null));
        })
        .catch((error) => callback(error, null));
    },
  });
}

/**
 * Turn a connection failure into something an operator can act on.
 *
 * Returns null when the failure has nothing to do with the proxy, so the
 * session's own disconnect classification stays in charge of what the state
 * becomes — this only enriches the sentence shown next to it.
 *
 * The proxy is named in redacted form; no credential ever reaches this string.
 */
export function describeProxyFailure(error, config) {
  if (!config?.enabled) return null;

  const where = redactProxy(config);
  const code = error?.code || error?.cause?.code || "";
  const message = `${error?.message || ""} ${error?.cause?.message || ""}`.toLowerCase();

  if (code === "ECONNREFUSED" || message.includes("econnrefused")) {
    return `The proxy at ${where} refused the connection.`;
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || message.includes("enotfound")) {
    return `The proxy host ${where} could not be resolved.`;
  }
  if (
    code === "ETIMEDOUT" ||
    message.includes("etimedout") ||
    message.includes("timeout") ||
    message.includes("timed out")
  ) {
    return `The proxy at ${where} timed out.`;
  }
  // https-proxy-agent surfaces the CONNECT response verbatim; socks throws its
  // own auth failures.
  if (
    message.includes("407") ||
    message.includes("proxy authentication") ||
    message.includes("authentication failed") ||
    message.includes("socks5 authentication")
  ) {
    return `The proxy at ${where} rejected the username or password.`;
  }
  if (message.includes("socks")) {
    return `The SOCKS proxy at ${where} refused the connection.`;
  }

  return `Could not reach WhatsApp through the proxy at ${where}.`;
}

export default {
  PROXY_PROTOCOLS,
  readProxyConfig,
  normalizeProxyConfig,
  proxyUrl,
  redactProxy,
  proxyFingerprint,
  createProxyAgents,
  describeProxyFailure,
};

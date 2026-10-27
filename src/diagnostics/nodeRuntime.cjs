// Node-level diagnostics for connection problems.
//
// Baileys reports most transport failures as one generic close. The facts that
// explain it (DNS, TCP, TLS and the CA store Node trusts) live one layer down,
// so this module writes them to the sanitized debug log (logger.debugOnly):
//
//   - once at boot: the runtime and its certificate store
//   - always: process warnings
//   - when `connection_log_level` is debug or trace: every outbound socket's
//     connect, TLS result and error, through node:diagnostics_channel
//
// Only hosts, ports, codes and TLS facts are logged. Never a request body.

const dc = require("node:diagnostics_channel");
const tls = require("node:tls");

const logger = require("../utils/logger.cjs");
const settings = require("../config/settings.cjs");

const log = logger.debugOnly.child({ module: "node" });
let installed = false;

function verbose() {
  const level = settings.get("connection_log_level");
  return level === "debug" || level === "trace";
}

function caCount(type) {
  try {
    return tls.getCACertificates?.(type)?.length ?? null;
  } catch (error) {
    return `error: ${error?.message}`;
  }
}

function errorFacts(error) {
  return {
    name: error?.name,
    detail: error?.message,
    code: error?.code,
    errno: error?.errno,
    syscall: error?.syscall,
    address: error?.address,
    port: error?.port,
    hostname: error?.hostname,
  };
}

function onSocket({ socket }) {
  if (!socket || !verbose()) return;
  const started = Date.now();
  const target = () => ({
    host: socket.servername || socket._host,
    remote: socket.remoteAddress,
    port: socket.remotePort,
    ms: Date.now() - started,
  });
  socket.once("lookup", (error, address, family, host) => {
    if (error) log.debug({ host, err: errorFacts(error) }, "[net] DNS lookup failed");
    else log.debug({ host, address, family }, "[net] DNS lookup");
  });
  socket.once("connect", () => log.debug(target(), "[net] TCP connected"));
  socket.once("secureConnect", () => {
    log.debug(
      {
        ...target(),
        authorized: socket.authorized,
        authorizationError: socket.authorizationError?.toString?.() ?? socket.authorizationError,
        protocol: socket.getProtocol?.(),
        alpn: socket.alpnProtocol,
        cipher: socket.getCipher?.()?.name,
        issuer: socket.getPeerCertificate?.()?.issuer?.CN,
      },
      "[tls] handshake done",
    );
  });
  socket.once("error", (error) =>
    log.debug({ ...target(), err: errorFacts(error) }, "[net] socket error"),
  );
  socket.once("close", (hadError) => log.trace({ ...target(), hadError }, "[net] socket closed"));
}

function onRequestStart({ request }) {
  if (!verbose()) return;
  log.debug({ method: request?.method, host: request?.host }, "[http] request start");
}

function onRequestError({ request, error }) {
  if (!verbose()) return;
  log.debug({ host: request?.host, err: errorFacts(error) }, "[http] request failed");
}

function onResponse({ request, response }) {
  if (!verbose()) return;
  log.debug({ host: request?.host, status: response?.statusCode }, "[http] response");
}

/** Install once per process. Safe to call again. */
function installNodeDiagnostics() {
  if (installed) return;
  installed = true;

  log.info(
    {
      node: process.version,
      openssl: process.versions.openssl,
      uv: process.versions.uv,
      platform: process.platform,
      arch: process.arch,
      android: process.env.LEVIX_ANDROID === "1",
      caBundled: caCount("bundled"),
      caSystem: caCount("system"),
      caDefault: caCount("default"),
      extraCa: Boolean(process.env.NODE_EXTRA_CA_CERTS),
      opensslConf: process.env.OPENSSL_CONF || null,
      connectionLogLevel: settings.get("connection_log_level"),
    },
    "[runtime] Node runtime",
  );

  process.on("warning", (warning) => {
    log.warn({ err: warning }, `[runtime] process warning: ${warning?.message}`);
  });

  dc.subscribe("net.client.socket", onSocket);
  dc.subscribe("http.client.request.start", onRequestStart);
  dc.subscribe("http.client.request.error", onRequestError);
  dc.subscribe("http.client.response.finish", onResponse);
}

module.exports = { installNodeDiagnostics };

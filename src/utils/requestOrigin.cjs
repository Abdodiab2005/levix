// Who is really on the other end of this request.
//
// WHY THIS IS NOT `req.ip`
// ------------------------
// Express's `req.ip` honours `X-Forwarded-For` as soon as `trust proxy` is set
// — including a hop count like `1`, which is exactly what the panel tells an
// nginx user to configure. From a non-loopback address:
//
//   trust proxy = 1, header "X-Forwarded-For: 127.0.0.1"  ->  req.ip = 127.0.0.1
//
// So a stranger could have made an unclaimed bot believe they were sitting at
// its keyboard, and claim it without the setup code. `req.ip` is the right
// answer for logging and for "who is this user"; it is the wrong answer for
// "is this physically the same machine".
//
// The socket address on its own isn't enough either: a reverse proxy on the
// same host connects from 127.0.0.1, so every remote visitor through it would
// look local.
//
// THE RULE
// --------
// A request counts as local only when all three hold:
//
//   1. the operator has NOT configured a proxy (`trust_proxy` is empty) —
//      if they told us something is in front, anything could have come through it
//   2. no forwarding header is present — anything that sets one is a proxy,
//      declared or not
//   3. the TCP peer is a loopback address — the only part of this that a
//      remote client cannot influence
//
// A reverse-proxy deployment therefore always uses the setup code, which is
// what we want: the code is printed on the server's own console, so having it
// proves access to the machine. `levix` on a laptop stays code-free.

// Headers that mean "a proxy handled this". Any of them present is enough to
// stop calling the request local, whether or not we trust the value.
const FORWARDING_HEADERS = [
  "x-forwarded-for",
  "x-real-ip",
  "forwarded",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-client-ip",
  "cf-connecting-ip",
  "true-client-ip",
];

/** 127.0.0.0/8, ::1, and the IPv4-mapped forms of both. */
function isLoopbackAddress(address) {
  if (typeof address !== "string" || !address) return false;

  // Strip a zone id ("fe80::1%eth0") and any IPv4-mapped IPv6 prefix.
  let value = address.trim().toLowerCase().split("%")[0];
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  if (value.startsWith("::ffff:")) value = value.slice("::ffff:".length);

  if (value === "::1" || value === "0:0:0:0:0:0:0:1") return true;

  // 127.0.0.0/8 — and only that: "127.0.0.1.evil.com" or "1270.0.1" must not pass.
  const octets = value.split(".");
  if (octets.length !== 4) return false;
  if (!octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) {
    return false;
  }
  return octets[0] === "127";
}

function hasForwardingHeader(headers = {}) {
  return FORWARDING_HEADERS.some((name) => {
    const value = headers[name];
    return typeof value === "string" && value.trim() !== "";
  });
}

/**
 * The address of the machine that actually opened the TCP connection.
 * Never derived from a header, so it can't be forged — which is what makes it
 * the right key for rate limiting a password or setup-code guess.
 */
function clientAddress(req) {
  return req?.socket?.remoteAddress || req?.connection?.remoteAddress || "";
}

/**
 * Is this request coming straight from this machine, with nothing in between?
 *
 * @param {object} req
 * @param {{ proxyConfigured?: boolean }} [options]
 */
function isDirectLocalRequest(req, { proxyConfigured = false } = {}) {
  if (proxyConfigured) return false;
  if (hasForwardingHeader(req?.headers)) return false;
  return isLoopbackAddress(clientAddress(req));
}

module.exports = {
  FORWARDING_HEADERS,
  isLoopbackAddress,
  hasForwardingHeader,
  clientAddress,
  isDirectLocalRequest,
};

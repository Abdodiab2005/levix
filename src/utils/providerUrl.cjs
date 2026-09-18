// Security boundary for operator-configured AI provider endpoints.
//
// Local loopback is an intentional product feature (Ollama / LM Studio and
// local compatibility gateways). Other private, link-local, metadata,
// multicast, and reserved destinations must never receive a vaulted API key.

const dns = require("node:dns").promises;
const net = require("node:net");
const { Agent, fetch: undiciFetch, Response: UndiciResponse } = require("undici");

function ipv4Bytes(host) {
  const parts = String(host).split(".");
  if (
    parts.length !== 4 ||
    !parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  ) {
    return null;
  }
  return parts.map(Number);
}

function ipv6Bytes(host) {
  let value = String(host).toLowerCase().split("%")[0];
  const dotted = value.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dotted) {
    const bytes = ipv4Bytes(dotted);
    if (!bytes) return null;
    value = value.slice(0, -dotted.length) + `${(bytes[0] << 8) | bytes[1]}:${
      (bytes[2] << 8) | bytes[3]
    }`;
  }

  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const words = [...left, ...Array(missing).fill("0"), ...right];
  if (words.length !== 8 || !words.every((word) => /^[0-9a-f]{1,4}$/.test(word))) return null;

  const out = [];
  for (const word of words) {
    const number = Number.parseInt(word, 16);
    out.push(number >> 8, number & 0xff);
  }
  return out;
}

function isIpv4Loopback(bytes) {
  return bytes?.[0] === 127;
}

function isForbiddenIpv4(bytes, { allowLoopback = false } = {}) {
  if (!bytes) return true;
  const [a, b] = bytes;
  if (isIpv4Loopback(bytes)) return !allowLoopback;
  return (
    a === 0 ||
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function embeddedIpv4(bytes) {
  if (!bytes || bytes.length !== 16) return null;
  const prefixIsZero = bytes.slice(0, 10).every((byte) => byte === 0);
  if (prefixIsZero && bytes[10] === 0xff && bytes[11] === 0xff) return bytes.slice(12);
  const translatedPrefix =
    bytes.slice(0, 8).every((byte) => byte === 0) &&
    bytes[8] === 0xff &&
    bytes[9] === 0xff &&
    bytes[10] === 0 &&
    bytes[11] === 0;
  if (translatedPrefix) return bytes.slice(12);

  if (
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    (bytes.slice(4, 12).every((byte) => byte === 0) ||
      (bytes[4] === 0 && bytes[5] === 1 && bytes.slice(6, 12).every((byte) => byte === 0)))
  ) {
    return bytes.slice(12);
  }
  return null;
}

function isIpv6Loopback(bytes) {
  return bytes?.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1;
}

function isForbiddenIpv6(bytes, { allowLoopback = false } = {}) {
  if (!bytes) return true;
  if (isIpv6Loopback(bytes)) return !allowLoopback;
  if (bytes.every((byte) => byte === 0)) return true;

  const embedded = embeddedIpv4(bytes);
  if (embedded) return isForbiddenIpv4(embedded, { allowLoopback });

  const first = bytes[0];
  const second = bytes[1];
  if ((first & 0xfe) === 0xfc) return true;
  if (first === 0xfe && (second & 0xc0) === 0x80) return true;
  if (first === 0xfe && (second & 0xc0) === 0xc0) return true;
  if (first === 0xff) return true;
  if (first === 0x20 && second === 0x02) return true;
  return false;
}

function isForbiddenIp(host, options = {}) {
  const family = net.isIP(host);
  if (family === 4) return isForbiddenIpv4(ipv4Bytes(host), options);
  if (family === 6) return isForbiddenIpv6(ipv6Bytes(host), options);
  return false;
}

function parseProviderUrl(raw, { allowLoopback = true, allowQuery = false } = {}) {
  const text = String(raw ?? "").trim();
  if (!text) throw new Error("Base URL is required");

  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error("Base URL must be a valid http(s) URL");
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error("Base URL must be http or https");
  if (!url.hostname) throw new Error("Base URL must include a host");
  if (url.username || url.password) throw new Error("Base URL cannot contain credentials");
  if ((!allowQuery && url.search) || url.hash) {
    throw new Error("Base URL cannot contain a query or fragment");
  }

  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const isLoopback =
    host === "localhost" ||
    (net.isIP(host) === 4 && isIpv4Loopback(ipv4Bytes(host))) ||
    (net.isIP(host) === 6 && isIpv6Loopback(ipv6Bytes(host)));

  if (/^(metadata|metadata\.google\.internal|instance-data)$/i.test(host)) {
    throw new Error("Base URL cannot point at cloud metadata");
  }
  if (net.isIP(host) && isForbiddenIp(host, { allowLoopback })) {
    throw new Error("Base URL cannot point at a private, link-local, or reserved address");
  }
  if (isLoopback && !allowLoopback) throw new Error("Loopback provider URLs are not allowed");
  if (url.protocol === "http:" && !isLoopback) {
    throw new Error("Public provider URLs must use HTTPS");
  }
  return url;
}

function assertProviderBaseUrl(raw, options = {}) {
  const url = parseProviderUrl(raw, options);
  return url.toString().replace(/\/+$/, "");
}

async function resolveProviderRequestUrl(raw, options = {}) {
  const url = parseProviderUrl(raw, { ...options, allowQuery: true });
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (net.isIP(host)) {
    return { url, host, addresses: [{ address: host, family: net.isIP(host) }] };
  }

  let answers;
  try {
    answers = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error("Provider host could not be resolved");
  }
  const explicitLocalhost = host === "localhost";
  if (
    !answers.length ||
    answers.some(({ address }) =>
      isForbiddenIp(address, { allowLoopback: explicitLocalhost && options.allowLoopback !== false }),
    )
  ) {
    throw new Error("Provider host resolves to a private, link-local, or reserved address");
  }
  return { url, host, addresses: answers };
}

async function assertProviderRequestUrl(raw, options = {}) {
  const { url } = await resolveProviderRequestUrl(raw, options);
  return url;
}

function pinnedLookup(expectedHost, addresses) {
  return (hostname, lookupOptions, callback) => {
    if (String(hostname).toLowerCase() !== expectedHost) {
      const error = new Error("Provider connection attempted an unexpected host");
      error.code = "EAI_FAIL";
      return callback(error);
    }
    const requestedFamily =
      typeof lookupOptions === "number" ? lookupOptions : lookupOptions?.family;
    const candidates = requestedFamily
      ? addresses.filter(({ family }) => family === requestedFamily)
      : addresses;
    if (!candidates.length) {
      const error = new Error("Provider host has no address in the requested family");
      error.code = "EAI_ADDRFAMILY";
      return callback(error);
    }
    if (typeof lookupOptions === "object" && lookupOptions?.all) {
      return callback(null, candidates.map(({ address, family }) => ({ address, family })));
    }
    return callback(null, candidates[0].address, candidates[0].family);
  };
}

function responseWithDispatcherCleanup(response, dispatcher) {
  let released = false;
  const release = (destroy = false) => {
    if (released) return;
    released = true;
    const done = destroy ? dispatcher.destroy() : dispatcher.close();
    Promise.resolve(done).catch(() => dispatcher.destroy());
  };

  if (!response.body) {
    release();
    return response;
  }

  const reader = response.body.getReader();
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          controller.close();
          release();
        } else {
          controller.enqueue(chunk.value);
        }
      } catch (error) {
        controller.error(error);
        release(true);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        release(true);
      }
    },
  });
  return new UndiciResponse(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function safeProviderFetch(raw, init = {}, options = {}) {
  const { url, host, addresses } = await resolveProviderRequestUrl(raw, options);
  const dispatcher = new Agent({ connect: { lookup: pinnedLookup(host, addresses) } });
  try {
    const response = await undiciFetch(url, { ...init, redirect: "manual", dispatcher });
    return responseWithDispatcherCleanup(response, dispatcher);
  } catch (error) {
    Promise.resolve(dispatcher.destroy()).catch(() => {});
    throw error;
  }
}

module.exports = {
  assertProviderBaseUrl,
  assertProviderRequestUrl,
  safeProviderFetch,
  isForbiddenIp,
};

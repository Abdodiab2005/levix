// Untrusted page/media URLs must never fall through to a library's automatic
// redirects. Reuse the provider boundary for DNS validation and socket pinning.
const provider = require("./providerUrl.cjs");

function httpsUrl(raw, base) {
  const url = new URL(raw, base);
  if (url.protocol !== "https:") throw new Error("Remote URLs must use HTTPS");
  url.hash = ""; // fragments are local to a document, not part of a request
  provider.assertProviderBaseUrl(url.href, { allowLoopback: false, allowQuery: true });
  return url;
}

async function cancelBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    // Cleanup must not hide the original transport error.
  }
}

// DNS lookup in the shared provider boundary is not itself abortable. Bound the
// whole wait, and release a response if it arrives after the caller timed out.
function beforeDeadline(request, signal) {
  return new Promise((resolve, reject) => {
    let aborted = signal.aborted;
    const onAbort = () => {
      aborted = true;
      reject(signal.reason);
    };
    if (aborted) reject(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
    request.then(
      (response) => {
        signal.removeEventListener("abort", onAbort);
        if (aborted) void cancelBody(response);
        else resolve(response);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function readLimited(response, maxBytes) {
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await cancelBody(response);
    throw new Error("Remote response exceeds the size limit");
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  let complete = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        complete = true;
        return Buffer.concat(chunks, bytes);
      }
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error("Remote response exceeds the size limit");
      chunks.push(Buffer.from(value));
    }
  } finally {
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function requestHttps(url, signal, dispatcher) {
  const init = { signal, redirect: "manual", headers: { Accept: "*/*" } };
  if (!dispatcher) return provider.safeProviderFetch(url.href, init, { allowLoopback: false });
  // The dispatcher belongs to a live WhatsApp socket. Validate every hop, use
  // that transport, and never close it or fall back to a direct connection.
  await provider.assertProviderRequestUrl(url.href, { allowLoopback: false });
  const { fetch } = require("undici");
  return fetch(url.href, { ...init, dispatcher });
}

async function fetchHttpsBuffer(
  raw,
  { maxBytes = 20 * 1024 * 1024, timeoutMs = 20_000, dispatcher } = {},
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("Invalid byte limit");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid timeout");
  let url = httpsUrl(raw);
  const signal = AbortSignal.timeout(timeoutMs);
  for (let hop = 0; ; hop += 1) {
    signal.throwIfAborted();
    const response = await beforeDeadline(requestHttps(url, signal, dispatcher), signal);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await cancelBody(response);
      const location = response.headers.get("location");
      if (!location || hop >= 4) throw new Error("Remote redirect limit or missing location");
      url = httpsUrl(location, url);
      continue;
    }
    if (!response.ok) {
      await cancelBody(response);
      throw new Error(`Remote request failed (${response.status})`);
    }
    return {
      buffer: await readLimited(response, maxBytes),
      url: url.href,
      contentType: response.headers.get("content-type") || "",
    };
  }
}

module.exports = { fetchHttpsBuffer, httpsUrl };

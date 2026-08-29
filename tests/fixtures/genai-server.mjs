// A stand-in for the Gemini endpoint.
//
// The point of these tests is what Levix actually PUTS ON THE WIRE, so nothing
// here mocks @google/genai — the real SDK runs, and this server is pointed at
// with `httpOptions.baseUrl`. Every request body is captured, and each reply is
// a real `generateContent` response shape, so the SDK parses it the same way it
// would parse Google's.
//
// That is the difference between testing the integration and testing a mock of
// it: if the SDK changes how it serialises tools, or how it reads grounding
// metadata back, these tests notice.

import http from "node:http";

/**
 * Start the fake endpoint.
 *
 * @param {Array<object|function>} replies - one per request, in order. A
 *   function is called with the parsed request body. Anything past the end of
 *   the list gets a plain text answer.
 */
export async function startGenaiServer(replies = []) {
  const requests = [];
  let index = 0;

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let parsed = {};
      try {
        parsed = JSON.parse(body || "{}");
      } catch {}
      requests.push({ url: req.url, method: req.method, body: parsed, headers: req.headers });

      const reply = replies[index++] ?? textReply("ok");
      const payload = typeof reply === "function" ? reply(parsed) : reply;

      res.writeHead(payload?.__status || 200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload?.__status ? payload.body : payload));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requests,
    /** The nth captured request body (0-based). */
    body: (n = 0) => requests[n]?.body,
    last: () => requests[requests.length - 1]?.body,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** A plain text answer. */
export function textReply(text, extra = {}) {
  return {
    candidates: [{ content: { role: "model", parts: [{ text }] }, ...extra }],
  };
}

/**
 * A turn that asks for function calls.
 *
 * `thoughtSignature` goes on the first part, which is where Gemini 3 puts it
 * and what it validates on the way back.
 */
export function functionCallReply(calls, { thoughtSignature = "sig-abc123" } = {}) {
  return {
    candidates: [
      {
        content: {
          role: "model",
          parts: calls.map((call, i) => ({
            functionCall: { name: call.name, args: call.args || {}, ...(call.id ? { id: call.id } : {}) },
            ...(i === 0 && thoughtSignature ? { thoughtSignature } : {}),
          })),
        },
      },
    ],
  };
}

/** A grounded answer, shaped the way the API documents groundingMetadata. */
export function groundedReply(text, sources, { webSearchQueries = ["a query"] } = {}) {
  return {
    candidates: [
      {
        content: { role: "model", parts: [{ text }] },
        groundingMetadata: {
          webSearchQueries,
          groundingChunks: sources.map((source) => ({
            web: { uri: source.uri, title: source.title },
          })),
        },
      },
    ],
  };
}

/** An error the SDK will turn into its ApiError. */
export function errorReply(status, message) {
  return { __status: status, body: { error: { code: status, message, status: "INVALID_ARGUMENT" } } };
}

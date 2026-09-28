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
 * @param {object} [options]
 * @param {string[]} [options.fileStates] - the Files API side: the first entry
 *   is the state an upload comes back in, each later one answers the next
 *   `files.get`. Defaults to ["ACTIVE"].
 * @param {string} [options.prefix] - serve under a path, the way a reverse
 *   proxy does (`https://proxy.example/gemini`). Anything outside it gets the
 *   proxy's own HTML 404, and the upload URL handed back is Google's, so the
 *   SDK's host-only rewrite of it lands outside the prefix — what a real
 *   gateway under a path does to every upload.
 * @param {boolean} [options.filesApi=true] - false: a gateway that forwards
 *   generateContent only; every upload request gets the HTML 404.
 */
export async function startGenaiServer(
  replies = [],
  { fileStates = ["ACTIVE"], prefix = "", filesApi = true } = {},
) {
  const requests = [];
  // Files API traffic is kept apart from `requests`, so body(n) still means
  // "the nth generateContent" in tests that upload something first.
  const uploads = [];
  const fileGets = [];
  // Upload requests that were refused with the HTML 404.
  const refused = [];
  let index = 0;
  let baseUrl = "";

  const nginx404 = (res, url) => {
    refused.push(url);
    res.writeHead(404, { "content-type": "text/html" });
    res.end(
      "<html>\r\n<head><title>404 Not Found</title></head>\r\n<body>\r\n" +
        "<center><h1>404 Not Found</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n",
    );
  };

  const fileResource = (upload, state) => ({
    name: upload.name,
    uri: `${baseUrl}/v1beta/${upload.name}`,
    mimeType: upload.mimeType,
    sizeBytes: String(upload.bytes?.length || 0),
    state,
  });

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);

      if (prefix) {
        if (!req.url.startsWith(`${prefix}/`)) return nginx404(res, req.url);
        req.url = req.url.slice(prefix.length);
      }
      if (!filesApi && req.url.startsWith("/upload")) return nginx404(res, req.url);

      // The resumable upload @google/genai speaks: a `start` that declares the
      // MIME type in a header and gets an upload URL back, then the bytes.
      if (req.url.startsWith("/upload/")) {
        let declared = {};
        try {
          declared = JSON.parse(raw.toString("utf8") || "{}");
        } catch {}
        const upload = {
          name: `files/test${uploads.length + 1}`,
          mimeType: req.headers["x-goog-upload-header-content-type"],
          declared,
          headers: req.headers,
          bytes: null,
        };
        uploads.push(upload);
        res.writeHead(200, {
          "content-type": "application/json",
          "x-goog-upload-url": prefix
            ? `https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=${uploads.length}`
            : `${baseUrl}/upload-session/${uploads.length}`,
        });
        res.end("{}");
        return;
      }
      if (req.url.startsWith("/upload-session/")) {
        const upload = uploads[Number(req.url.split("/")[2]) - 1];
        upload.bytes = Buffer.concat([upload.bytes || Buffer.alloc(0), raw]);
        res.writeHead(200, {
          "content-type": "application/json",
          "x-goog-upload-status": "final",
        });
        res.end(JSON.stringify({ file: fileResource(upload, fileStates[0]) }));
        return;
      }
      const fileGet = /^\/v1beta\/(files\/[^/?]+)/.exec(req.url);
      if (req.method === "GET" && fileGet) {
        const upload = uploads.find((u) => u.name === fileGet[1]);
        fileGets.push(fileGet[1]);
        const state = fileStates[Math.min(fileGets.length, fileStates.length - 1)];
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(fileResource(upload, state)));
        return;
      }

      let parsed = {};
      try {
        parsed = JSON.parse(raw.toString("utf8") || "{}");
      } catch {}
      requests.push({ url: req.url, method: req.method, body: parsed, headers: req.headers });

      const reply = replies[index++] ?? textReply("ok");
      const payload = typeof reply === "function" ? reply(parsed) : reply;

      res.writeHead(payload?.__status || 200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload?.__status ? payload.body : payload));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}${prefix}`;

  return {
    baseUrl,
    requests,
    /** Requests answered with the proxy's HTML 404. */
    refused,
    /** Files API uploads: { name, mimeType (the declared header), bytes }. */
    uploads,
    /** The file names `files.get` was asked about, in order. */
    fileGets,
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

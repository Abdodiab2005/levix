// A stand-in for BOTH non-Gemini endpoints: an OpenAI-compatible
// /chat/completions server and an Anthropic /v1/messages server, in one
// process, routed by URL.
//
// Same discipline as genai-server.mjs: nothing mocks Levix's code. The real
// `fetch` runs, the request the loop actually builds is captured byte for
// byte, and each scripted reply is a real response shape, so the parsing and
// the tool-result round trip are tested the way they will run.

import http from "node:http";

/** A plain text answer on the chat-completions wire. */
export function openaiText(text) {
  return { choices: [{ message: { role: "assistant", content: text } }] };
}

/**
 * A turn that asks for tools on the chat-completions wire. `arguments` is a
 * JSON STRING there, not an object — that is part of the shape under test.
 */
export function openaiToolCall(calls) {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: calls.map((call, i) => ({
            id: call.id || `call_${i}`,
            type: "function",
            function: {
              name: call.name,
              arguments: JSON.stringify(call.args || {}),
            },
          })),
        },
      },
    ],
  };
}

/** A plain text answer on the Messages-API wire. */
export function anthropicText(text) {
  return { content: [{ type: "text", text }], stop_reason: "end_turn" };
}

/** A tool_use turn on the Messages-API wire. */
export function anthropicToolCall(calls) {
  return {
    content: calls.map((call, i) => ({
      type: "tool_use",
      id: call.id || `toolu_${i}`,
      name: call.name,
      input: call.args || {},
    })),
    stop_reason: "tool_use",
  };
}

/** An error body both wire formats share. */
export function providerError(status, message) {
  return { __status: status, body: { error: { message } } };
}

/**
 * Start the fake endpoints. `replies` is per base path, one reply per request
 * in order; a function is called with the parsed request body, and anything
 * past the end of the list gets a plain text answer.
 */
export async function startProviderServer(replies = {}) {
  const requests = [];

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let parsed = {};
      try {
        parsed = JSON.parse(body || "{}");
      } catch {}
      const path = req.url.split("?")[0];
      requests.push({ url: path, method: req.method, body: parsed, headers: req.headers });

      const queue = replies[path] || [];
      const reply = queue[requests.filter((r) => r.url === path).length - 1] ?? {
        choices: [{ message: { role: "assistant", content: "ok" } }],
        content: [{ type: "text", text: "ok" }],
      };
      const payload = typeof reply === "function" ? reply(parsed) : reply;

      res.writeHead(payload?.__status || 200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload?.__status ? payload.body : payload));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requests,
    /** The nth captured request body for one path (0-based). */
    body: (path, n = 0) => requests.filter((r) => r.url === path)[n]?.body,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

export const OPENAI_PATH = "/chat/completions";
export const ANTHROPIC_PATH = "/v1/messages";

// Health report. Pure: the caller gathers probes. This module does not open
// a socket, a file, or a URL, so a check cannot create the load it measures.

const CHECKS = Object.freeze([
  "node",
  "whatsapp",
  "database",
  "scheduler",
  "disk",
  "memory",
  "recovery",
  "media",
]);

const STATES = new Set(["ok", "degraded", "down", "unknown"]);

function stateOf(value) {
  return STATES.has(value) ? value : "unknown";
}

function overallOf(checks) {
  if (checks.some((check) => check.state === "down")) return "down";
  if (checks.some((check) => check.state === "degraded")) return "degraded";
  if (checks.some((check) => check.state === "unknown")) return "unknown";
  return "ok";
}

function line(id, probe) {
  const source = probe && typeof probe === "object" ? probe : {};
  const detail = typeof source.detail === "string" && source.detail ? source.detail : null;
  return {
    id,
    state: stateOf(source.state),
    detail: detail && detail.length <= 80 ? detail : null,
  };
}

/**
 * @param {object} probes one entry per check. Missing entries are `unknown`.
 * @returns {{overall: string, checks: Array<{id: string, state: string, detail: string|null}>}}
 */
function assessHealth(probes = {}) {
  const checks = CHECKS.map((id) => line(id, probes[id]));
  return { overall: overallOf(checks), checks };
}

function whatsAppProbe(sessionState) {
  if (!sessionState || typeof sessionState !== "object") return { state: "unknown" };
  if (sessionState.connected === true && sessionState.state === "connected") return { state: "ok" };
  if (sessionState.connected === true) return { state: "degraded" };
  const waiting = new Set([
    "idle",
    "starting",
    "waiting_for_qr",
    "linking",
    "reconnecting",
    "consent_required",
    "paused",
  ]);
  if (waiting.has(sessionState.state)) return { state: "degraded" };
  if (sessionState.state) return { state: "down" };
  return { state: "unknown" };
}

module.exports = { CHECKS, assessHealth, whatsAppProbe, overallOf };

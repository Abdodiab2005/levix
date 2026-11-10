// Public Levix Plus extension contract v1.
//
// The host loads one optional module from a fixed path and talks to it only
// through this shape. A mismatch leaves Core in Free state.

const API_VERSION = 1;
const CAPABILITIES = Object.freeze(["templates", "watermark", "progress", "autoReply", "panelApi"]);

const ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const HANDLER_FIELDS = Object.freeze({
  templates: ["resolve"],
  watermark: ["hide"],
  progress: ["hide"],
  autoReply: ["scope", "consider"],
  panelApi: ["handle"],
});

function validateManifest(mod) {
  if (!mod || typeof mod !== "object") return { ok: false, reason: "module" };
  if (mod.apiVersion !== API_VERSION) return { ok: false, reason: "apiVersion" };
  if (typeof mod.id !== "string" || !ID_RE.test(mod.id)) return { ok: false, reason: "id" };
  if (typeof mod.version !== "string" || !SEMVER_RE.test(mod.version)) {
    return { ok: false, reason: "version" };
  }
  if (mod.requiresEntitlement !== "plus") return { ok: false, reason: "requiresEntitlement" };
  if (!Array.isArray(mod.capabilities)) return { ok: false, reason: "capabilities" };
  const seen = new Set();
  for (const cap of mod.capabilities) {
    if (!CAPABILITIES.includes(cap)) return { ok: false, reason: `capability:${cap}` };
    if (seen.has(cap)) return { ok: false, reason: `duplicate:${cap}` };
    seen.add(cap);
  }
  if (typeof mod.activate !== "function") return { ok: false, reason: "activate" };
  if (typeof mod.deactivate !== "function") return { ok: false, reason: "deactivate" };
  if (mod.onAccountReset != null && typeof mod.onAccountReset !== "function") {
    return { ok: false, reason: "onAccountReset" };
  }
  return { ok: true };
}

function validateHandlers(capabilities, handlers) {
  if (!handlers || typeof handlers !== "object" || Array.isArray(handlers)) {
    return { ok: false, reason: "handlers" };
  }
  const declared = new Set(Array.isArray(capabilities) ? capabilities : []);
  for (const cap of declared) {
    if (!CAPABILITIES.includes(cap)) return { ok: false, reason: `capability:${cap}` };
    const handler = handlers[cap];
    if (!handler || typeof handler !== "object") return { ok: false, reason: `missing:${cap}` };
    for (const field of HANDLER_FIELDS[cap] || []) {
      if (typeof handler[field] !== "function")
        return { ok: false, reason: `missing:${cap}.${field}` };
    }
  }
  for (const key of Object.keys(handlers)) {
    if (!CAPABILITIES.includes(key)) return { ok: false, reason: `unknown:${key}` };
    if (!declared.has(key)) return { ok: false, reason: `undeclared:${key}` };
  }
  return { ok: true };
}

module.exports = {
  API_VERSION,
  CAPABILITIES,
  validateManifest,
  validateHandlers,
};

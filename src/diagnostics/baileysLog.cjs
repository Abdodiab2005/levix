// What Baileys may put in the debug log.
//
// Baileys logs whole protocol objects: binary nodes, their attrs (`notify`
// carries a contact's display name), the paired account (`me.name`), app-state
// patches (contacts, chat actions) and pushName updates. The debug log
// sanitizer strips JIDs, numbers and secret-named keys, but a display name or
// a group subject is ordinary text to it. So every Baileys record passes
// through these serializers first: the listed keys keep their structure (node
// tags, attribute names, sizes) and a short allowlist of protocol attribute
// values, and lose every other string.

const logger = require("../utils/logger.cjs");

// Top-level keys Baileys uses for protocol objects or personal data.
const SHAPED_KEYS = [
  "node",
  "groupNode",
  "payload",
  "payloadNode",
  "data",
  "updates",
  "attrs",
  "msgAttrs",
  "content",
  "child",
  "fullErrorNode",
  "reasonNode",
  "uploadResult",
  "helloMsg",
  "me",
  "name",
  "xml",
  "frame",
  "msg",
  "fullMessage",
  "collections",
  "errors",
];

// Protocol attribute values that explain a failure and name nobody.
const SAFE_VALUE_KEYS = new Set([
  "tag",
  "type",
  "code",
  "reason",
  "class",
  "xmlns",
  "status",
  "text_code",
]);

const MAX_DEPTH = 4;
const MAX_ITEMS = 8;

/** Structure without personal text. */
function shape(value, depth = 0, key = "") {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (SAFE_VALUE_KEYS.has(key) && value.length <= 64) return value;
    // binaryNodeToString output: keep the outer tag, drop everything inside.
    const tag = /^<([\w:.-]{1,40})/.exec(value);
    return tag ? `<${tag[1]}> [${value.length} chars]` : `[${value.length} chars]`;
  }
  if (typeof value === "bigint") return `[bigint]`;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return `[${value.length} bytes]`;
  if (typeof value !== "object") return `[${typeof value}]`;
  if (depth >= MAX_DEPTH) return "[…]";
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((item) => shape(item, depth + 1));
    if (value.length > MAX_ITEMS) items.push(`[+${value.length - MAX_ITEMS} more]`);
    return items;
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = shape(v, depth + 1, k);
  return out;
}

const serializers = Object.fromEntries(
  SHAPED_KEYS.map((key) => [key, (value) => shape(value, 0, key)]),
);

/** Baileys' logger: the debug log only, at `level`, with the shaping above. */
function createBaileysLogger(level) {
  return logger.debugOnly.child({ module: "baileys" }, { level, serializers });
}

module.exports = { createBaileysLogger, shape, SHAPED_KEYS };

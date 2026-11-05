// Reply Router.
//
// The default destination is the chat the command was typed in. Another
// destination is allowed only when this module says so. The dashboard stores
// the choice; it does not send. A forged chat id on a message context is not
// read here. Callers pass the Baileys key's remote JID as `sourceJid`.
//
// Named exceptions, decided with the owner (Q-21): `!schedule` and
// `!autoschedule` errors still go to the creator's private chat.
// Password-reset codes use `assertSelfDelivery` and never a group.
//
// When a destination is missing or not allowed, the answer is a refusal.
// The caller tells the source chat with a neutral notice. Nothing in here
// falls back to a group.

const normalizeJid = require("../utils/normalizeJid.cjs");
const { getCached } = require("../utils/groupMetadataCache.cjs");
const { linkedIdentity } = require("./identity.cjs");

const MODES = new Set(["same_chat", "owner_private", "authorized_chat"]);
const JID_RE = /^[0-9]{1,30}@(s\.whatsapp\.net|lid|g\.us)$/;
const SCHEDULE_COMMANDS = new Set(["schedule", "autoschedule"]);

function canonicalJid(jid) {
  if (!jid || typeof jid !== "string") return null;
  const norm = normalizeJid(jid.trim());
  if (!norm || !JID_RE.test(norm)) return null;
  return norm;
}

function resolveMode(input) {
  const commands = input.overrides?.commands;
  const categories = input.overrides?.categories;
  const chosen =
    commands?.[input.commandName] ||
    categories?.[input.category] ||
    input.routeMode ||
    "same_chat";
  return MODES.has(chosen) ? chosen : "same_chat";
}

function ownerDestination(identity) {
  if (!identity) return null;
  return canonicalJid(identity.phone) || canonicalJid(identity.lid) || null;
}

function classify(dest, input) {
  const source = canonicalJid(input.sourceJid);
  if (dest === source) return { ok: true, kind: "source" };
  const self = input.identity?.selfJids || [];
  if (self.includes(dest)) return { ok: true, kind: "owner_private" };
  if (dest.endsWith("@g.us")) {
    const known = input.knownGroups?.[dest];
    if (!known?.member) return { ok: false, kind: "group" };
    return { ok: true, kind: "group" };
  }
  return { ok: true, kind: "other" };
}

function allow(destination, quote) {
  return { allow: true, destination, quote: Boolean(quote), noticeKey: null };
}

function refuse() {
  return {
    allow: false,
    destination: null,
    quote: false,
    noticeKey: "bot.core.message.routeFailed",
  };
}

/**
 * Decide one delivery. Pure: no settings read, no socket, no network.
 *
 * @returns {{allow: boolean, destination: string|null, quote: boolean, noticeKey: string|null}}
 */
function planDelivery(input = {}) {
  const source = canonicalJid(input.sourceJid);
  if (!source) return refuse();
  if (input.terminal) return allow(source, true);

  const requested = canonicalJid(input.requestedJid) || source;
  const sensitivity = input.sensitivity || "source";
  const sender = canonicalJid(input.senderJid);
  const commandName = input.commandName || "";

  // Q-21. The creator's own private chat, never a group, never a third person.
  if (
    SCHEDULE_COMMANDS.has(commandName) &&
    sender &&
    requested === sender &&
    !requested.endsWith("@g.us")
  ) {
    return allow(requested, requested === source);
  }

  const mode = resolveMode(input);

  if (mode === "same_chat") {
    if (requested !== source) return refuse();
    return allow(source, true);
  }

  // Security text stays in the chat that produced it.
  if (sensitivity === "secret") {
    if (requested !== source) return refuse();
    return allow(source, true);
  }

  if (mode === "owner_private") {
    const owner = ownerDestination(input.identity);
    if (!owner) return refuse();
    return allow(owner, owner === source);
  }

  if (mode === "authorized_chat") {
    const dest = canonicalJid(input.routeChat);
    if (!dest) return refuse();
    const kind = classify(dest, input);
    if (!kind.ok) return refuse();
    if (kind.kind === "other" || kind.kind === "group") {
      if (sensitivity !== "operational") return refuse();
    }
    return allow(dest, dest === source);
  }

  return refuse();
}

function readOverrides() {
  try {
    const settings = require("../config/settings.cjs");
    const raw = settings.get("reply_route_overrides");
    if (!raw) return { commands: {}, categories: {} };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { commands: {}, categories: {} };
    }
    return {
      commands: parsed.commands && typeof parsed.commands === "object" ? parsed.commands : {},
      categories:
        parsed.categories && typeof parsed.categories === "object" ? parsed.categories : {},
    };
  } catch {
    return { commands: {}, categories: {} };
  }
}

function groupMembership(jid, identity) {
  const meta = getCached(jid);
  if (!meta || !Array.isArray(meta.participants)) return null;
  const self = new Set(identity.selfJids || []);
  const member = meta.participants.some((participant) => self.has(normalizeJid(participant?.id)));
  return { member };
}

/** Settings, and creds only when the route can leave the source chat. No network. */
function routeSend(input = {}) {
  const settings = require("../config/settings.cjs");
  const overrides = readOverrides();
  const routeMode = settings.get("reply_route");
  const chosen =
    overrides.commands?.[input.commandName] ||
    overrides.categories?.[input.category] ||
    routeMode ||
    "same_chat";
  // The default path does not read pairing credentials.
  if (!MODES.has(chosen) || chosen === "same_chat") {
    return planDelivery({
      ...input,
      routeMode: "same_chat",
      routeChat: "",
      overrides,
      identity: { selfJids: [] },
      knownGroups: {},
    });
  }
  const routeChat = settings.get("reply_route_chat");
  const identity = linkedIdentity();
  const knownGroups = {};
  const dest = canonicalJid(routeChat);
  if (dest?.endsWith("@g.us")) {
    const known = groupMembership(dest, identity);
    if (known) knownGroups[dest] = known;
  }
  return planDelivery({
    ...input,
    routeMode,
    routeChat,
    overrides,
    identity,
    knownGroups,
  });
}

/**
 * Password-reset codes (and anything else that must reach only the linked
 * account) call this before they send. A group, a broadcast, or a different
 * person throws. There is no fallback.
 */
function assertSelfDelivery(destination, selfId) {
  const dest = canonicalJid(destination);
  const self = canonicalJid(selfId);
  if (!dest || !self || dest !== self || dest.endsWith("@g.us")) {
    const error = new Error("refusing to deliver outside the linked account chat");
    error.code = "ROUTE_REFUSED";
    throw error;
  }
  return dest;
}

module.exports = {
  MODES,
  canonicalJid,
  planDelivery,
  routeSend,
  assertSelfDelivery,
  resolveMode,
};

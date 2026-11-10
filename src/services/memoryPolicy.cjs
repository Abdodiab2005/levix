// Server-owned global memory grants. Caller identity comes only from aiToolAuth;
// settings are read on every check, including immediately before a tool writes.
const settings = require("../config/settings.cjs");
const { isCurrentCaller } = require("./aiToolAuth.cjs");
const { sameUserSync } = require("../utils/permissions.cjs");

function globalMemoryAccess(context = {}) {
  const caller = context?.caller;
  if (!isCurrentCaller(caller) || !caller.chatId) {
    return Object.freeze({ read: false, write: false });
  }
  // Auto Reply may only read global memory. It skips the linked account's own
  // messages, so no owner can be the sender, and a write grant would only let
  // external senders steer what the AI saves.
  if (context.memoryScope === "chat") {
    return Object.freeze({ read: context.autoReplyGlobal?.read === true, write: false });
  }

  const where = settings.get("ai_global_memory_where");
  const allowedHere =
    where === "all" ||
    (!caller.isGroup &&
      (where === "private" ||
        (where === "own_chat" && caller.candidates.some((id) => sameUserSync(caller.chatId, id)))));
  const permits = (value) =>
    allowedHere &&
    (value === "everyone" ||
      (value === "owner" && caller.isOwner) ||
      (value === "privileged" && (caller.isOwner || caller.isBotAdmin)));

  return Object.freeze({
    read: permits(settings.get("ai_global_memory_read")),
    write: permits(settings.get("ai_global_memory_write")),
  });
}

const MEMORY_TOOLS = new Set(["search_memory", "save_memory", "forget_memory", "summarize_chat"]);

function stripMemoryToolParts(history) {
  if (!Array.isArray(history)) return [];
  return history.flatMap((entry) => {
    if (!Array.isArray(entry?.parts)) return [];
    // Text alongside a tool call was intermediate output, never a chat reply.
    const intermediate = entry.role === "model" && entry.parts.some((part) => part?.functionCall);
    const parts = entry.parts.filter(
      (part) =>
        part?.thought !== true &&
        !(intermediate && typeof part?.text === "string") &&
        !MEMORY_TOOLS.has(part?.functionCall?.name) &&
        !MEMORY_TOOLS.has(part?.functionResponse?.name),
    );
    return parts.length ? [{ ...entry, parts }] : [];
  });
}

module.exports = { globalMemoryAccess, stripMemoryToolParts };

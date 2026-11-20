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

function isToolCallEntry(entry) {
  return Array.isArray(entry?.parts) && entry.parts.some((part) => part?.functionCall);
}

function isToolResponseEntry(entry) {
  return Array.isArray(entry?.parts) && entry.parts.some((part) => part?.functionResponse);
}

function hasMemoryTool(entry) {
  return (
    Array.isArray(entry?.parts) &&
    entry.parts.some(
      (part) =>
        MEMORY_TOOLS.has(part?.functionCall?.name) ||
        MEMORY_TOOLS.has(part?.functionResponse?.name),
    )
  );
}

function copyHistoryProvenance(source, target) {
  if (!source || typeof source !== "object" || !Array.isArray(target)) return target;
  if (source.provider !== undefined || source.model !== undefined) {
    Object.defineProperties(target, {
      provider: {
        value: source.provider ?? null,
        writable: true,
        configurable: true,
      },
      model: {
        value: source.model ?? null,
        writable: true,
        configurable: true,
      },
    });
  }
  return target;
}

function stripMemoryToolParts(history) {
  const list = Array.isArray(history)
    ? history
    : Array.isArray(history?.history)
      ? history.history
      : null;
  if (!list) return [];
  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    const entry = list[i];
    if (!Array.isArray(entry?.parts)) continue;

    if (isToolCallEntry(entry)) {
      const next = list[i + 1];
      const hasResponse = isToolResponseEntry(next);
      // Drop the entire tool exchange whenever any call in the batch is a
      // memory tool, or when the call/response pair is already incomplete.
      // That prevents dropping a signed leading memory call while leaving an
      // unsigned sibling call behind, and never splits a call/response pair.
      if (!hasResponse || hasMemoryTool(entry) || hasMemoryTool(next)) {
        if (hasResponse) i += 1;
        continue;
      }
      // Text alongside a tool call was intermediate output, never a chat reply.
      const callParts = entry.parts.filter(
        (part) => part?.thought !== true && typeof part?.text !== "string",
      );
      const responseParts = next.parts.filter((part) => part?.thought !== true);
      const callCount = callParts.filter((part) => part?.functionCall).length;
      const responseCount = responseParts.filter((part) => part?.functionResponse).length;
      if (!callCount || callCount !== responseCount) {
        i += 1;
        continue;
      }
      out.push({ ...entry, parts: callParts }, { ...next, parts: responseParts });
      i += 1;
      continue;
    }

    if (isToolResponseEntry(entry)) {
      continue;
    }

    const parts = entry.parts.filter((part) => part?.thought !== true);
    if (parts.length) out.push({ ...entry, parts });
  }
  return copyHistoryProvenance(history, out);
}

module.exports = { globalMemoryAccess, stripMemoryToolParts };

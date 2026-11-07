import { delay } from "@whiskeysockets/baileys";
import { createRequire } from "module";
import { getGroupSettings } from "../utils/storage.esm.js";

const require = createRequire(import.meta.url);
const logger = require("../utils/logger.cjs");
const { t } = require("../utils/i18n.cjs");
const { buildModerationSummary } = require("../utils/moderationSummary.cjs");
const { resolveModerationPolicy } = require("../services/moderationPolicy.cjs");
const { clearMemberModeration } = require("../utils/moderationAction.cjs");

function participantIdentities(participant) {
  if (typeof participant === "string") return [participant];
  if (!participant || typeof participant !== "object") return [];
  const ids = [];
  for (const field of ["id", "lid", "phoneNumber", "jid", "pn"]) {
    const value = participant[field];
    if (typeof value === "string" && value && !ids.includes(value)) ids.push(value);
  }
  return ids;
}

// Baileys rc14 sends group-participants.update participants as objects
// ({ id, phoneNumber?, lid?, username?, admin }, Socket/messages-recv.js:637);
// older builds sent the bare JID string. The welcome path only needs the JID,
// and calling .split() on the object is what used to throw inside the try/catch
// and swallow every welcome message.
function participantJid(participant) {
  if (typeof participant === "string") return participant || null;
  if (!participant || typeof participant !== "object") return null;
  const { id } = participant;
  return typeof id === "string" && id ? id : null;
}

// rc14 emits 'group.join-request' with { id, participant, participantPn,
// action: "created" | "revoked" | "rejected", method }
// (Utils/process-message.js:496). Older builds passed
// { type: "request", jid, from }. Both shapes are read here, and the requester
// is resolved through participantJid() so an object and a string behave alike.
function joinRequestFields(request) {
  if (!request || typeof request !== "object") return null;
  const legacy = request.type === "request";
  const pending = legacy || request.action === "created";
  if (!pending) return null;

  const groupId = request.jid || request.id;
  const participantId =
    participantJid(request.from) ||
    participantJid(request.participant) ||
    participantJid(request.participantPn);
  if (!groupId || !participantId) return null;

  return { groupId, participantId };
}

// Handle group participant updates (join/leave)
export async function handleGroupParticipantsUpdate(sock, update) {
  const { id, participants, action } = update;
  logger.info({ update }, "Received group participants update");

  if (action === "remove" || action === "leave") {
    try {
      const settings = getGroupSettings(id) || {};
      if (resolveModerationPolicy(settings).membership === "clear") {
        for (const participant of participants || []) {
          for (const identity of participantIdentities(participant)) {
            clearMemberModeration(id, identity);
          }
        }
      }
    } catch (error) {
      logger.error({ err: error, update }, "Error clearing moderation on leave");
    }
  }

  if (action !== "add") {
    logger.info(`[Group] ${action} action for ${id}`);
    return;
  }

  try {
    const settings = getGroupSettings(id);
    const welcomeConfig = settings?.welcome_system;

    if (!welcomeConfig || !welcomeConfig.enabled || welcomeConfig.messages.length === 0) {
      logger.warn(`[Group] Welcome system disabled or no messages for ${id}`);
      return;
    }

    // Send welcome message to each new participant
    for (const participant of participants || []) {
      const participantId = participantJid(participant);
      if (!participantId) {
        logger.warn({ group: id }, "[Group] Welcome skipped: participant has no JID");
        continue;
      }

      const randomIndex = Math.floor(Math.random() * welcomeConfig.messages.length);
      const welcomeMessage = welcomeConfig.messages[randomIndex];

      const welcomeText = welcomeMessage.replace(/\${user}/g, `@${participantId.split("@")[0]}`);
      const summary = buildModerationSummary(settings);
      const finalMessage = summary ? `${welcomeText}\n\n${summary}` : welcomeText;

      await delay(1000);
      await sock.sendMessage(id, {
        text: finalMessage,
        mentions: [participantId],
      });
    }
  } catch (error) {
    logger.error({ err: error, update }, "Error in group-participants.update event");
  }
}

// Handle group join requests
export async function handleGroupJoinRequests(sock, events) {
  logger.info({ events }, "Received group join request update");

  // rc14 emits one object per 'group.join-request' event, while the older
  // 'group-requests.update' delivered an array. Accept either.
  const requests = Array.isArray(events) ? events : events ? [events] : [];

  for (const request of requests) {
    const fields = joinRequestFields(request);
    if (!fields) continue;

    const { groupId, participantId } = fields;

    try {
      const settings = getGroupSettings(groupId);

      if (settings?.join_requests?.auto_approve_enabled) {
        logger.info(`[Auto-Approve] Approving ${participantId} for group ${groupId}`);

        // rc14 names the action groupRequestParticipantsUpdate(jid, users,
        // action); the older single-participant method is kept as a fallback
        // for a socket that still exposes it.
        if (typeof sock.groupRequestParticipantsUpdate === "function") {
          await sock.groupRequestParticipantsUpdate(groupId, [participantId], "approve");
        } else {
          await sock.groupRequestUpdate(groupId, participantId, "approve");
        }

        await delay(500);
        await sock.sendMessage(groupId, {
          text: t("bot.moderation.groupHandler.joinRequestApproved", {
            member: participantId.split("@")[0],
          }),
          mentions: [participantId],
        });
      }
    } catch (error) {
      logger.error({ err: error, request }, "Error in auto-approve event");
    }
  }
}

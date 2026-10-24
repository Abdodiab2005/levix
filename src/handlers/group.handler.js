import { delay } from "@whiskeysockets/baileys";
import { createRequire } from "module";
import { getGroupSettings } from "../utils/storage.esm.js";

const require = createRequire(import.meta.url);
const logger = require("../utils/logger.cjs");
const { tr } = require("../utils/i18n.cjs");
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
    for (const participant of participants) {
      const randomIndex = Math.floor(Math.random() * welcomeConfig.messages.length);
      const welcomeMessage = welcomeConfig.messages[randomIndex];

      const welcomeText = welcomeMessage.replace(/\${user}/g, `@${participant.split("@")[0]}`);
      const summary = buildModerationSummary(settings);
      const finalMessage = summary ? `${welcomeText}\n\n${summary}` : welcomeText;

      await delay(1000);
      await sock.sendMessage(id, {
        text: finalMessage,
        mentions: [participant],
      });
    }
  } catch (error) {
    logger.error({ err: error, update }, "Error in group-participants.update event");
  }
}

// Handle group join requests
export async function handleGroupJoinRequests(sock, events) {
  logger.info({ events }, "Received group join request update");

  for (const request of events) {
    if (request.type !== "request") continue;

    const groupId = request.jid;
    const participantId = request.from;

    try {
      const settings = getGroupSettings(groupId);

      if (settings?.join_requests?.auto_approve_enabled) {
        logger.info(`[Auto-Approve] Approving ${participantId} for group ${groupId}`);

        await sock.groupRequestUpdate(groupId, participantId, "approve");

        await delay(500);
        await sock.sendMessage(groupId, {
          text: tr(
            `✅ @${participantId.split("@")[0]}'s join request was approved automatically.`,
            `✅ تم قبول طلب انضمام @${participantId.split("@")[0]} تلقائيًا.`,
          ),
          mentions: [participantId],
        });
      }
    } catch (error) {
      logger.error({ err: error, request }, "Error in auto-approve event");
    }
  }
}

// !status — a short line for the owner, and an owner-only health report.
//
// The command's permission stays OWNER_ONLY (Q-06, option a). `!status debug`
// is gated again on the owner role, so lowering the command in the panel
// cannot show versions, paths or the kernel to a group member.

const os = require("os");
const { getSession } = require("../core/session-holder.cjs");
const { checkFfmpeg } = require("../utils/thumbnail.cjs");
const { t } = require("../utils/i18n.cjs");
const { isOwnerJidSync, getSenderCandidatesSync } = require("../utils/permissions.cjs");
const logger = require("../utils/logger.cjs");
const { assessHealth, whatsAppProbe } = require("../messaging/health.cjs");

const FAMILIES = {
  linux: "Linux",
  darwin: "macOS",
  win32: "Windows",
  android: "Android",
};

function osFamily() {
  if (process.env.LEVIX_ANDROID === "1") return "Android";
  return FAMILIES[os.platform()] || t("bot.core.status.osUnknown");
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / (3600 * 24));
  const h = Math.floor((seconds % (3600 * 24)) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return t("bot.core.status.uptime", { days: d, hours: h, minutes: m, seconds: s });
}

function senderIsOwner(msg, sock, groupMetadata) {
  if (msg?.key?.fromMe) return true;
  try {
    const ids = getSenderCandidatesSync(msg, sock);
    return ids.some((id) => isOwnerJidSync(id, groupMetadata));
  } catch {
    return false;
  }
}

function sessionState() {
  try {
    return getSession()?.getState() || null;
  } catch {
    return null;
  }
}

function nodeProbe() {
  const major = Number(String(process.versions.node || "").split(".")[0]);
  return { state: major === 24 ? "ok" : "degraded" };
}

function databaseProbe() {
  let opened = false;
  try {
    const { db } = require("../db/db.cjs");
    opened = true;
    db.prepare("SELECT 1 AS ok").get();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("SELECT 1 AS ok").get();
    } finally {
      db.exec("ROLLBACK");
    }
    const row = db.prepare("PRAGMA quick_check(1)").get();
    const value = row ? Object.values(row)[0] : null;
    return { state: value === "ok" ? "ok" : "down" };
  } catch {
    return { state: opened ? "degraded" : "down" };
  }
}

function schedulerProbe() {
  try {
    const jobs = require("../../scheduler.cjs").getScheduledJobs();
    if (!Array.isArray(jobs)) return { state: "unknown" };
    const failed = jobs.some((job) => job?.status === "failed" || job?.status === "error");
    return { state: failed ? "degraded" : "ok" };
  } catch {
    return { state: "unknown" };
  }
}

function diskProbe() {
  try {
    const dir = require("../config/paths.cjs").DATA_DIR;
    const stats = fsStatfs(dir);
    const free = Number(stats.bavail) * Number(stats.bsize);
    if (!Number.isFinite(free) || free < 0) return { state: "unknown" };
    const mb = Math.round(free / (1024 * 1024));
    return { state: free < 50 * 1024 * 1024 ? "degraded" : "ok", detail: `${mb} MB` };
  } catch {
    return { state: "unknown" };
  }
}

function fsStatfs(dir) {
  return require("fs").statfsSync(dir);
}

function memoryProbe() {
  try {
    const free = os.freemem();
    if (!Number.isFinite(free)) return { state: "unknown" };
    const mb = Math.round(free / (1024 * 1024));
    return { state: free < 32 * 1024 * 1024 ? "degraded" : "ok", detail: `${mb} MB` };
  } catch {
    return { state: "unknown" };
  }
}

function recoveryProbe() {
  try {
    const journal = require("../backup/journal.cjs").readJournal();
    return { state: journal ? "degraded" : "ok" };
  } catch {
    return { state: "unknown" };
  }
}

async function mediaProbe() {
  try {
    const ffmpeg = await checkFfmpeg();
    return { state: ffmpeg?.ok ? "ok" : "down" };
  } catch {
    return { state: "unknown" };
  }
}

async function gatherProbes() {
  const [media] = await Promise.all([mediaProbe()]);
  return {
    node: nodeProbe(),
    whatsapp: whatsAppProbe(sessionState()),
    database: databaseProbe(),
    scheduler: schedulerProbe(),
    disk: diskProbe(),
    memory: memoryProbe(),
    recovery: recoveryProbe(),
    media,
  };
}

function safeDetail(detail) {
  return typeof detail === "string" && /^[0-9]+ MB$/.test(detail) ? detail : null;
}

function debugText(report) {
  const lines = [t("bot.core.status.debugHeader")];
  for (const check of report.checks) {
    const name = t(`bot.core.status.check.${check.id}`);
    const state = t(`bot.core.status.state.${check.state}`);
    const detail = safeDetail(check.detail);
    lines.push(
      detail
        ? t("bot.core.status.debugLineDetail", { name, state, detail })
        : t("bot.core.status.debugLine", { name, state }),
    );
  }
  lines.push(t("bot.core.status.debugNode", { version: process.version }));
  let baileys = "unknown";
  try {
    baileys = require("@whiskeysockets/baileys/package.json").version;
  } catch {
    baileys = t("bot.core.status.osUnknown");
  }
  lines.push(t("bot.core.status.debugBaileys", { version: baileys }));
  return lines.join("\n");
}

const probes = { gather: gatherProbes };

module.exports = {
  name: "status",
  keywords: ["debug"],
  chat: "all",
  probes,

  async execute(sock, msg, args, body, groupMetadata, ctx) {
    const chatId = msg.key.remoteJid;
    const send = (text) => sock.sendMessage(chatId, { text });
    try {
      if (String(args?.[0] || "").toLowerCase() === "debug") {
        const authMetadata =
          ctx && Object.hasOwn(ctx, "authGroupMetadata") ? ctx.authGroupMetadata : groupMetadata;
        if (!senderIsOwner(msg, sock, authMetadata)) {
          return await send(t("bot.core.status.debugOwnerOnly"));
        }
        const report = assessHealth(await probes.gather());
        return await send(debugText(report));
      }

      const reply = t("bot.core.status.short", {
        uptime: formatUptime(process.uptime()),
        osFamily: osFamily(),
      });
      return await send(reply);
    } catch (error) {
      logger.error(error, "[Error] في أمر !status:");
      return await send(t("bot.core.status.failed"));
    }
  },
};

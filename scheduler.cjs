// file: scheduler.cjs
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");
const logger = require("./src/utils/logger.cjs");

const settings = require("./src/config/settings.cjs");
const { ensureDataDir } = require("./src/config/paths.cjs");
const storage = require("./src/utils/storage.cjs");

// الجدولة كانت في config/schedule.json: الداشبورد مش شايفاه، وكراش وسط
// الكتابة كان ممكن يقصّه. دلوقتي جدول في نفس قاعدة البيانات زي أي حاجة تانية.

// The media folder is trimmed to a 3-day retention window every 6 hours so
// files the bot wrote while answering a command don't fill up the disk.
const RETENTION_MS = 1000 * 60 * 60 * 24 * 3;
const cacheCleanupCron = "0 */6 * * *"; // every 6 hours

function getScheduledJobs() {
  try {
    return storage.getSchedules();
  } catch (err) {
    logger.error({ err }, "[Scheduler] failed to read jobs");
    return [];
  }
}

function saveScheduledJob(job) {
  return storage.saveSchedule(job);
}

const runningTasks = new Map();
const deliveriesInFlight = new Set();
let cleanupScheduled = false;

function trimMediaDirectory() {
  try {
    const dir = ensureDataDir("media");
    const cutoff = Date.now() - RETENTION_MS;
    let removed = 0;
    for (const file of fs.readdirSync(dir)) {
      const fp = path.join(dir, file);
      try {
        const stat = fs.statSync(fp);
        if (stat.isFile() && stat.mtimeMs < cutoff) {
          fs.unlinkSync(fp);
          removed++;
        }
      } catch (err) {
        logger.warn({ err, fp }, "[Scheduler] failed to inspect media file");
      }
    }
    if (removed) logger.info(`[Scheduler] Trimmed ${removed} old media files`);
  } catch (err) {
    logger.error({ err }, "[Scheduler] media trim failed");
  }
}

function initializeScheduledJobs(sock) {
  const jobs = getScheduledJobs();
  logger.info(`[Scheduler] Initializing ${jobs.length} total jobs...`);

  // الدالة دي بتتنده مع كل اتصال ناجح (يعني مع كل reconnect كمان)، فلازم
  // scheduleNewJob توقف النسخة القديمة من نفس الجوب الأول — وإلا الرسالة
  // الأسبوعية بتتبعت مرتين بعد أول قطع اتصال، وتلاتة بعد التاني.
  jobs.forEach((job) => {
    if (job.status === "active" || job.status === "pending") {
      scheduleNewJob(sock, job);
    }
  });

  // Media cleanup — مرة واحدة في عمر الـ process لنفس السبب.
  if (!cleanupScheduled) {
    cleanupScheduled = true;
    cron.schedule(
      cacheCleanupCron,
      () => {
        logger.info("[Scheduler] Running periodic media cleanup...");
        trimMediaDirectory();
      },
      { timezone: settings.get("bot_timezone") }
    );
  }

  // Run a trim once on startup so a freshly-restarted bot doesn't carry
  // stale files indefinitely.
  trimMediaDirectory();
}

// setTimeout بيتعامل مع التأخير كعدد 32-bit: أي مدة أطول من ~24 يوم بتلف
// وتشتغل فورًا، فبنقسّمها على مراحل.
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

function scheduleAt(whenMs, run) {
  let timer = null;
  const arm = () => {
    const remaining = whenMs - Date.now();
    timer = setTimeout(
      remaining > MAX_TIMEOUT_MS ? arm : run,
      Math.min(Math.max(remaining, 0), MAX_TIMEOUT_MS)
    );
  };
  arm();
  return { stop: () => clearTimeout(timer) };
}

/**
 * Stop every running task.
 *
 * Each task closes over the socket it was armed with (see scheduleNewJob), so
 * once that socket is gone the task can only fail. The connection handler calls
 * initializeScheduledJobs() again on the next open, which re-arms every job
 * against the socket that is actually alive.
 */
function stopAllScheduledJobs() {
  const count = runningTasks.size;
  for (const jobId of [...runningTasks.keys()]) stopTask(jobId);
  if (count) logger.info(`[Scheduler] Stopped ${count} job(s) — no live connection`);
}

function stopTask(jobId) {
  const existing = runningTasks.get(jobId);
  if (!existing) return;
  try {
    existing.stop();
  } catch (err) {
    logger.warn({ err, jobId }, "[Scheduler] failed to stop previous task");
  }
  runningTasks.delete(jobId);
}

function deliveryErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error ?? "Unknown error");
  return message.replace(/\s+/g, " ").trim().slice(0, 240) || "Unknown error";
}

function recordDelivery(jobId, status, runAt, error = null) {
  try {
    storage.setScheduleDelivery(jobId, status, runAt, error);
  } catch (stateError) {
    logger.error(
      { err: stateError, jobId },
      "[Scheduler] failed to record scheduled delivery state"
    );
  }
}

async function deliverScheduledJob(sock, job) {
  if (deliveriesInFlight.has(job.id)) {
    logger.warn(`[Scheduler] Job ${job.id} is already being delivered — skipping overlap`);
    return { ok: false, reason: "in_flight", skipped: true };
  }

  deliveriesInFlight.add(job.id);
  const runAt = Date.now();

  try {
    await sock.sendMessage(job.targetJid, {
      text: `*رسالة مجدولة 🗓️*\n\n${job.message}`,
    });
    recordDelivery(job.id, "sent", runAt);
    logger.info(`[Scheduler] Executed job ${job.id} -> ${job.targetJid}`);
    return { ok: true, reason: "sent" };
  } catch (error) {
    const message = deliveryErrorMessage(error);
    recordDelivery(job.id, "failed", runAt, message);
    logger.error(
      { err: error, jobId: job.id },
      "[Scheduler] failed to send scheduled message"
    );
    return { ok: false, reason: "delivery_failed", error: message };
  } finally {
    deliveriesInFlight.delete(job.id);
  }
}

async function executeScheduledJob(sock, job) {
  const result = await deliverScheduledJob(sock, job);

  if (job.type !== "recurring" && !result.skipped) {
    try {
      updateJobStatus(job.id, result.ok ? "sent" : "failed");
    } catch (error) {
      logger.error(
        { err: error, jobId: job.id },
        "[Scheduler] failed to record one-off schedule status"
      );
    }
  }

  return result;
}

function scheduleNewJob(sock, job) {
  stopTask(job.id);

  if (job.type === "recurring") {
    if (!job.cronString || !cron.validate(job.cronString)) {
      logger.error(
        `[Scheduler] Job ${job.id} has an invalid cron string (${job.cronString}) — skipping it`
      );
      updateJobStatus(job.id, "invalid");
      return false;
    }

    runningTasks.set(
      job.id,
      cron.schedule(job.cronString, () => executeScheduledJob(sock, job), {
        timezone: settings.get("bot_timezone"),
      })
    );
  } else {
    const when = new Date(job.date).getTime();
    if (!Number.isFinite(when)) {
      logger.error(`[Scheduler] Job ${job.id} has an invalid date (${job.date})`);
      updateJobStatus(job.id, "invalid");
      return false;
    }
    if (when <= Date.now()) {
      updateJobStatus(job.id, "expired");
      return false;
    }

    // وقت مطلق. الكود القديم كان بيبني كرون من ساعة السيرفر المحلية
    // (jobDate.getHours()) وبيجدوله بتوقيت القاهرة، فالرسالة كانت بتتبعت
    // بفارق ساعات على أي سيرفر مش متوقيت القاهرة — وكانت كمان بتتكرر كل سنة
    // لأن الكرون مفيهوش خانة سنة.
    runningTasks.set(
      job.id,
      scheduleAt(when, async () => {
        try {
          await executeScheduledJob(sock, job);
        } finally {
          runningTasks.delete(job.id);
        }
      })
    );
  }

  logger.info(`[Scheduler] Job ${job.id} is now scheduled.`);
  return true;
}

async function retryScheduledJob(sock, jobId) {
  const job = storage.getSchedule(jobId);
  if (!job) return { ok: false, reason: "not_found" };

  const retryable =
    job.status === "failed" ||
    (job.type === "recurring" &&
      job.status === "active" &&
      job.lastDeliveryStatus === "failed");
  if (!retryable) return { ok: false, reason: "not_failed", job };

  const result = await executeScheduledJob(sock, job);
  return { ...result, job: storage.getSchedule(jobId) };
}

function deleteScheduledJob(jobId) {
  stopTask(jobId);
  storage.deleteSchedule(jobId);
  logger.info(`[Scheduler] Deleted job ${jobId}.`);
  return true;
}

function updateJobStatus(jobId, status) {
  storage.setScheduleStatus(jobId, status);
}

module.exports = {
  initializeScheduledJobs,
  stopAllScheduledJobs,
  scheduleNewJob,
  retryScheduledJob,
  getScheduledJobs,
  saveScheduledJob,
  deleteScheduledJob,
  updateJobStatus,
};

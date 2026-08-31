// Recurring parsing and delivery state, without opening a WhatsApp connection.

import {
  useTempDataDir,
  require as harnessRequire,
  ROOT,
  section,
  ok,
  equal,
  finish,
} from "./harness.mjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";

useTempDataDir("levix-scheduling");

const recurrence = harnessRequire("./src/utils/recurrence.cjs");
const scheduler = harnessRequire("./scheduler.cjs");
const storage = harnessRequire("./src/utils/storage.cjs");
const autoschedule = harnessRequire("./src/commands/autoschedule.cjs");
const cron = harnessRequire("node-cron");

async function waitUntil(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

section("daily and weekly recurrence parsing");

{
  const daily = recurrence.parseRecurringArgs(["daily", "9:05", "صباح", "الخير"]);
  equal("daily cron", daily.cronString, "5 9 * * *");
  equal("daily time is normalized", daily.time, "09:05");
  equal("daily message is preserved", daily.message, "صباح الخير");

  const english = recurrence.parseRecurringArgs(["weekly", "Monday", "18:30", "Team", "sync"]);
  equal("English weekday", english.cronString, "30 18 * * 1");
  equal("weekly message", english.message, "Team sync");

  const arabic = recurrence.parseRecurringArgs(["weekly", "الجمعة", "7:00", "تذكير"]);
  equal("Arabic weekday", arabic.cronString, "0 7 * * 5");
  equal("Sunday may use cron's 7 alias", recurrence.parseDayOfWeek("7"), 0);
  equal(
    "a bad day is rejected",
    recurrence.parseRecurringArgs(["weekly", "someday", "10:00", "x"]).error,
    "day"
  );
  equal(
    "a bad time is rejected",
    recurrence.parseRecurringArgs(["daily", "25:00", "x"]).error,
    "time"
  );
  equal(
    "an empty message is rejected",
    recurrence.parseRecurringArgs(["daily", "10:00"]).error,
    "message"
  );
  equal(
    "weekly schedules are readable",
    recurrence.describeScheduledJob(
      { type: "recurring", cronString: "30 18 * * 5" },
      "Africa/Cairo"
    ),
    "Every Friday at 18:30 (Africa/Cairo)"
  );
}

section("the autoschedule command persists a real weekly job");

{
  const realSchedule = cron.schedule;
  let scheduled = null;
  const replies = [];
  cron.schedule = (expression, callback, options) => {
    scheduled = { expression, callback, options };
    return { stop() {} };
  };

  try {
    const sock = {
      async sendMessage(jid, content) {
        replies.push({ jid, content });
      },
    };
    const msg = {
      key: {
        remoteJid: "120363@g.us",
        participant: "201000000000@s.whatsapp.net",
      },
    };

    await autoschedule.execute(sock, msg, [
      "weekly",
      "الجمعة",
      "18:30",
      "موعد",
      "الفريق",
    ]);

    const [job] = scheduler.getScheduledJobs();
    equal("one job is saved", scheduler.getScheduledJobs().length, 1);
    equal("the weekly cron reaches the scheduler", scheduled.expression, "30 18 * * 5");
    equal("the configured timezone reaches cron", scheduled.options.timezone, "Africa/Cairo");
    equal("the job is recurring", job.type, "recurring");
    equal("the message is saved", job.message, "موعد الفريق");
    equal("the target chat is saved", job.targetJid, "120363@g.us");
    ok("the confirmation says weekly", replies.at(-1).content.text.includes("أسبوعيًا"));

    await autoschedule.execute(sock, msg, ["weekly", "not-a-day", "18:30", "x"]);
    equal("an invalid day saves nothing", scheduler.getScheduledJobs().length, 1);
    ok("the invalid day gets a useful reply", replies.at(-1).content.text.includes("اليوم غير صالح"));
  } finally {
    scheduler.stopAllScheduledJobs();
    cron.schedule = realSchedule;
  }
}

section("a failed one-off is never reported as sent");

{
  const job = {
    id: "one-off-failure",
    type: "once",
    targetJid: "201000000000@s.whatsapp.net",
    creatorJid: "201000000000@s.whatsapp.net",
    message: "remember this",
    date: new Date(Date.now() + 40).toISOString(),
    status: "pending",
  };
  scheduler.saveScheduledJob(job);
  scheduler.scheduleNewJob(
    {
      async sendMessage() {
        throw new Error("network unavailable");
      },
    },
    job
  );

  ok(
    "the timer records the failure",
    await waitUntil(() => storage.getSchedule(job.id)?.status === "failed")
  );
  let stored = storage.getSchedule(job.id);
  equal("the lifecycle says failed", stored.status, "failed");
  equal("the delivery says failed", stored.lastDeliveryStatus, "failed");
  equal("the useful error is retained", stored.lastError, "network unavailable");
  ok("the attempt time is retained", Number.isFinite(stored.lastRunAt));

  let sent = 0;
  const retry = await scheduler.retryScheduledJob(
    {
      async sendMessage(jid, content) {
        sent += 1;
        equal("retry target", jid, job.targetJid);
        ok("retry carries the message", content.text.includes(job.message));
      },
    },
    job.id
  );
  ok("manual retry succeeds", retry.ok);
  equal("manual retry sends once", sent, 1);
  stored = storage.getSchedule(job.id);
  equal("a successful retry marks it sent", stored.status, "sent");
  equal("the last delivery is sent", stored.lastDeliveryStatus, "sent");
  equal("success clears the old error", stored.lastError, null);
}

section("recurring failures stay active and retries cannot overlap");

{
  const realSchedule = cron.schedule;
  let tick = null;
  cron.schedule = (expression, callback) => {
    tick = callback;
    return { stop() {} };
  };

  const recurring = {
    id: "weekly-failure",
    type: "recurring",
    targetJid: "120363@g.us",
    creatorJid: "201000000000@s.whatsapp.net",
    message: "weekly report",
    cronString: "0 9 * * 1",
    status: "active",
  };
  scheduler.saveScheduledJob(recurring);

  try {
    scheduler.scheduleNewJob(
      {
        async sendMessage() {
          throw new Error("temporary outage");
        },
      },
      recurring
    );
    await tick();

    const failed = storage.getSchedule(recurring.id);
    equal("the recurrence remains active", failed.status, "active");
    equal("its last delivery records failure", failed.lastDeliveryStatus, "failed");

    let release;
    let sends = 0;
    const slowSocket = {
      async sendMessage() {
        sends += 1;
        await new Promise((resolve) => {
          release = resolve;
        });
      },
    };

    const first = scheduler.retryScheduledJob(slowSocket, recurring.id);
    await Promise.resolve();
    const overlap = await scheduler.retryScheduledJob(slowSocket, recurring.id);
    equal("an overlapping retry is refused", overlap.reason, "in_flight");
    equal("only one WhatsApp send starts", sends, 1);
    release();
    ok("the original retry finishes", (await first).ok);

    const recovered = storage.getSchedule(recurring.id);
    equal("the recurrence is still active", recovered.status, "active");
    equal("the successful retry is visible", recovered.lastDeliveryStatus, "sent");
  } finally {
    scheduler.stopAllScheduledJobs();
    cron.schedule = realSchedule;
  }
}

section("the panel exposes delivery state and manual retry");

{
  const source = readFileSync(join(ROOT, "public", "dashboard.js"), "utf8");
  ok("the table renders the readable schedule", source.includes("job.when"));
  ok("failed jobs get a retry control", source.includes("data-retry-schedule"));
  ok(
    "the retry control calls the protected API",
    /schedules\/\$\{encodeURIComponent\(retryButton\.dataset\.retrySchedule\)\}\/retry/.test(
      source
    )
  );
}

finish();

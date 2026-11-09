// Recurring parsing and delivery state, without opening a WhatsApp connection.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  equal,
  finish,
  require as harnessRequire,
  ok,
  ROOT,
  section,
  useTempDataDir,
} from "./harness.mjs";

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

// The scheduler delivers through its own live raw socket (set by
// initializeScheduledJobs), never through the socket handed to scheduleNewJob.
// One raw socket, with a handler each section swaps. cron is stubbed while the
// stored jobs are re-armed, so no live cron timer is left behind.
const rawSock = {
  user: { id: "201000000001@s.whatsapp.net" },
  handler: async () => {},
  async sendMessage(jid, content) {
    return this.handler(jid, content);
  },
};

function bindRaw(handler) {
  rawSock.handler = handler;
  const realSchedule = cron.schedule;
  cron.schedule = () => ({ stop() {} });
  try {
    scheduler.initializeScheduledJobs(rawSock);
  } finally {
    cron.schedule = realSchedule;
  }
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
    "day",
  );
  equal(
    "a bad time is rejected",
    recurrence.parseRecurringArgs(["daily", "25:00", "x"]).error,
    "time",
  );
  equal(
    "an empty message is rejected",
    recurrence.parseRecurringArgs(["daily", "10:00"]).error,
    "message",
  );
  equal(
    "weekly schedules are readable",
    recurrence.describeScheduledJob(
      { type: "recurring", cronString: "30 18 * * 5" },
      "Africa/Cairo",
    ),
    "Every Friday at 18:30 (Africa/Cairo)",
  );
}

section("autoschedule usage hints parse for every locale");

{
  const locales = JSON.parse(readFileSync(join(ROOT, "i18n/locales.json"), "utf8"));

  function backtickedAutoscheduleExamples(usage) {
    return [...String(usage).matchAll(/`(!autoschedule[^`]*)`/g)].map((match) => match[1]);
  }

  function argsFromExample(example) {
    const prepared = example.replace(/HH:mm/g, "09:30").replace(/\bday\b/g, "monday");
    return prepared.trim().split(/\s+/).slice(1);
  }

  for (const locale of locales) {
    const schedules = JSON.parse(
      readFileSync(join(ROOT, `i18n/${locale.code}/bot/schedules.json`), "utf8"),
    );
    const examples = backtickedAutoscheduleExamples(schedules["autoschedule.usage"]);
    ok(`${locale.code} has an autoschedule example`, examples.length > 0);
    for (const example of examples) {
      const parsed = recurrence.parseRecurringArgs(argsFromExample(example));
      equal(`${locale.code} ${example} parses`, parsed.error, undefined);
    }
  }

  const planted = "`!autoschedule weekly dia HH:mm sua mensagem`";
  const [badExample] = backtickedAutoscheduleExamples(planted);
  equal(
    "a translated day word such as dia is refused",
    recurrence.parseRecurringArgs(argsFromExample(badExample)).error,
    "day",
  );
}

section("recurrence builder -> cron for every kind");

{
  const daily = recurrence.recurrenceToCron({ kind: "daily", time: "9:05" });
  equal("daily cron", daily.cronString, "5 9 * * *");

  const weekly = recurrence.recurrenceToCron({
    kind: "weekly",
    time: "09:00",
    weekdays: [1, 4],
  });
  equal("weekly multi-day cron", weekly.cronString, "0 9 * * 1,4");

  const weeklySorted = recurrence.recurrenceToCron({
    kind: "weekly",
    time: "18:30",
    weekdays: [5, 1, 1],
  });
  equal("weekly days are unique and sorted", weeklySorted.cronString, "30 18 * * 1,5");

  const monthly = recurrence.recurrenceToCron({
    kind: "monthly",
    time: "07:00",
    dayOfMonth: 31,
  });
  equal("monthly cron", monthly.cronString, "0 7 31 * *");

  const hourly = recurrence.recurrenceToCron({
    kind: "hourly",
    time: "00:15",
    everyHours: 3,
  });
  equal("hourly cron", hourly.cronString, "15 */3 * * *");

  equal(
    "bad time is rejected",
    recurrence.recurrenceToCron({ kind: "daily", time: "25:00" }).error,
    "time",
  );
  equal(
    "minute 60 is rejected",
    recurrence.recurrenceToCron({ kind: "daily", time: "09:60" }).error,
    "time",
  );
  equal(
    "empty weekdays are rejected",
    recurrence.recurrenceToCron({ kind: "weekly", time: "09:00", weekdays: [] }).error,
    "weekdays",
  );
  equal(
    "missing weekdays are rejected",
    recurrence.recurrenceToCron({ kind: "weekly", time: "09:00" }).error,
    "weekdays",
  );
  equal(
    "day 0 is rejected",
    recurrence.recurrenceToCron({ kind: "monthly", time: "09:00", dayOfMonth: 0 }).error,
    "dayOfMonth",
  );
  equal(
    "day 32 is rejected",
    recurrence.recurrenceToCron({ kind: "monthly", time: "09:00", dayOfMonth: 32 }).error,
    "dayOfMonth",
  );
  equal(
    "every 0 hours is rejected",
    recurrence.recurrenceToCron({ kind: "hourly", time: "00:00", everyHours: 0 }).error,
    "everyHours",
  );
  equal(
    "every 13 hours is rejected",
    recurrence.recurrenceToCron({ kind: "hourly", time: "00:00", everyHours: 13 }).error,
    "everyHours",
  );
  equal(
    "every 5 hours is rejected (does not divide 24)",
    recurrence.recurrenceToCron({ kind: "hourly", time: "00:00", everyHours: 5 }).error,
    "everyHours",
  );
  equal(
    "every 7 hours is rejected (does not divide 24)",
    recurrence.recurrenceToCron({ kind: "hourly", time: "00:00", everyHours: 7 }).error,
    "everyHours",
  );
}

section("describeScheduledJob covers every builder shape in both languages");

{
  const tz = "Africa/Cairo";
  const describe = (cronString, lang) =>
    recurrence.describeScheduledJob({ type: "recurring", cronString }, tz, lang);

  equal("daily en", describe("0 9 * * *", "en"), "Daily at 09:00 (Africa/Cairo)");
  equal("daily ar", describe("0 9 * * *", "ar"), "يومياً الساعة 09:00 (Africa/Cairo)");

  equal("weekly one day en", describe("30 18 * * 5", "en"), "Every Friday at 18:30 (Africa/Cairo)");
  equal(
    "weekly one day ar",
    describe("30 18 * * 5", "ar"),
    "كل يوم الجمعة الساعة 18:30 (Africa/Cairo)",
  );

  equal(
    "weekly two days en",
    describe("0 9 * * 1,4", "en"),
    "Every Monday and Thursday at 09:00 (Africa/Cairo)",
  );
  equal(
    "weekly two days ar",
    describe("0 9 * * 1,4", "ar"),
    "كل يوم الاثنين والخميس الساعة 09:00 (Africa/Cairo)",
  );

  equal(
    "monthly en",
    describe("0 9 15 * *", "en"),
    "Every month on day 15 at 09:00 (Africa/Cairo)",
  );
  equal(
    "monthly ar",
    describe("0 9 15 * *", "ar"),
    "كل شهر في اليوم 15 الساعة 09:00 (Africa/Cairo)",
  );

  equal("hourly en", describe("15 */3 * * *", "en"), "Every 3 hours at minute 15 (Africa/Cairo)");
  equal("hourly ar", describe("15 */3 * * *", "ar"), "كل 3 ساعات عند الدقيقة 15 (Africa/Cairo)");
  equal("hourly one en", describe("0 */1 * * *", "en"), "Every hour at minute 0 (Africa/Cairo)");
  equal("hourly one ar", describe("0 */1 * * *", "ar"), "كل ساعة عند الدقيقة 0 (Africa/Cairo)");
  equal("hourly two ar", describe("0 */2 * * *", "ar"), "كل ساعتين عند الدقيقة 0 (Africa/Cairo)");
  equal(
    "hourly twelve ar",
    describe("0 */12 * * *", "ar"),
    "كل 12 ساعة عند الدقيقة 0 (Africa/Cairo)",
  );
}

section("a panel recurring job persists cronString");

{
  const built = recurrence.recurrenceToCron({ kind: "daily", time: "09:00" });
  const job = {
    id: "panel-cron-regression",
    type: "recurring",
    targetJid: "201000000000@s.whatsapp.net",
    message: "hello",
    cronString: built.cronString,
    status: "active",
    creatorJid: "dashboard@levix",
  };
  scheduler.saveScheduledJob(job);
  const stored = storage.getSchedule(job.id);
  equal("cronString is persisted", stored.cronString, "0 9 * * *");
  ok("node-cron accepts the stored expression", cron.validate(stored.cronString));

  const source = readFileSync(join(ROOT, "src/routes/dashboard.api.esm.js"), "utf8");
  ok("the route assigns job.cronString", /job\.cronString\s*=/.test(source));
  ok("the route does not assign job.cron", !/job\.cron\s*=/.test(source));

  scheduler.deleteScheduledJob(job.id);
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

    await autoschedule.execute(sock, msg, ["weekly", "الجمعة", "18:30", "موعد", "الفريق"]);

    const [job] = scheduler.getScheduledJobs();
    equal("one job is saved", scheduler.getScheduledJobs().length, 1);
    equal("the weekly cron reaches the scheduler", scheduled.expression, "30 18 * * 5");
    equal("the configured timezone reaches cron", scheduled.options.timezone, "Africa/Cairo");
    equal("the job is recurring", job.type, "recurring");
    equal("the message is saved", job.message, "موعد الفريق");
    equal("the target chat is saved", job.targetJid, "120363@g.us");
    // The success confirmation is deliberately silent: a ✅ reaction on the
    // command message, no separate "message scheduled" bubble.
    const confirmation = replies.at(-1).content;
    ok("the confirmation is a reaction, not a message", !confirmation.text);
    ok("the confirmation reacts ✅ on the command message", confirmation.react?.text === "✅");

    await autoschedule.execute(sock, msg, ["weekly", "not-a-day", "18:30", "x"]);
    equal("an invalid day saves nothing", scheduler.getScheduledJobs().length, 1);
    ok(
      "the invalid day gets a useful reply",
      replies.at(-1).content.text.includes("اليوم غير صالح"),
    );
  } finally {
    scheduler.stopAllScheduledJobs();
    cron.schedule = realSchedule;
  }
}

section("a failed one-off is never reported as sent");

{
  bindRaw(async () => {
    throw new Error("network unavailable");
  });
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
  scheduler.scheduleNewJob({ async sendMessage() {} }, job);

  ok(
    "the timer records the failure",
    await waitUntil(() => storage.getSchedule(job.id)?.status === "failed"),
  );
  let stored = storage.getSchedule(job.id);
  equal("the lifecycle says failed", stored.status, "failed");
  equal("the delivery says failed", stored.lastDeliveryStatus, "failed");
  equal("the useful error is retained", stored.lastError, "network unavailable");
  ok("the attempt time is retained", Number.isFinite(stored.lastRunAt));

  let sent = 0;
  rawSock.handler = async (jid, content) => {
    sent += 1;
    equal("retry target", jid, job.targetJid);
    ok("retry carries the message", content.text.includes(job.message));
  };
  const retry = await scheduler.retryScheduledJob({ async sendMessage() {} }, job.id);
  ok("manual retry succeeds", retry.ok);
  equal("manual retry sends once", sent, 1);
  stored = storage.getSchedule(job.id);
  equal("a successful retry marks it sent", stored.status, "sent");
  equal("the last delivery is sent", stored.lastDeliveryStatus, "sent");
  equal("success clears the old error", stored.lastError, null);
}

section("a scheduled file goes out with its text, then is cleaned up");

{
  const { existsSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  const job = {
    id: "one-off-voice",
    type: "once",
    targetJid: "201000000000@s.whatsapp.net",
    creatorJid: "dashboard@levix",
    message: "listen to this",
    date: new Date(Date.now() + 60_000).toISOString(),
    status: "failed",
    media: { kind: "audio", mimeType: "audio/mpeg", fileName: "note.mp3" },
  };
  const mediaPath = scheduler.scheduleMediaPath(job.id);
  mkdirSync(dirname(mediaPath), { recursive: true });
  writeFileSync(mediaPath, Buffer.from("ID3 fake mp3"));
  scheduler.saveScheduledJob(job);
  equal("the media metadata round-trips", storage.getSchedule(job.id).media?.kind, "audio");

  const sentPayloads = [];
  rawSock.handler = async (_jid, content) => {
    sentPayloads.push(content);
  };
  const result = await scheduler.retryScheduledJob({ async sendMessage() {} }, job.id);
  ok("the voice job is delivered", result.ok);
  ok("the audio goes first", Buffer.isBuffer(sentPayloads[0]?.audio));
  ok(
    "audio takes no caption, so the text follows as its own message",
    sentPayloads.length === 2 && String(sentPayloads[1]?.text).includes(job.message),
  );
  ok("a sent one-off drops its file", !existsSync(mediaPath));
}

section("recurring failures stay active and retries cannot overlap");

{
  bindRaw(async () => {
    throw new Error("temporary outage");
  });
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
    scheduler.scheduleNewJob({ async sendMessage() {} }, recurring);
    await tick();

    const failed = storage.getSchedule(recurring.id);
    equal("the recurrence remains active", failed.status, "active");
    equal("its last delivery records failure", failed.lastDeliveryStatus, "failed");

    let release;
    let sends = 0;
    rawSock.handler = async () => {
      sends += 1;
      await new Promise((resolve) => {
        release = resolve;
      });
    };
    const slowSocket = { async sendMessage() {} };

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

section("delivery uses the scheduler's raw socket, not the socket that armed the job");

{
  const rawCalls = [];
  const proxyCalls = [];
  bindRaw(async (jid, content) => {
    rawCalls.push({ jid, content });
  });
  // What a command passes: a per-command reply proxy.
  const proxy = {
    async sendMessage(jid, content) {
      proxyCalls.push({ jid, content });
    },
  };
  const job = {
    id: "proxy-capture",
    type: "once",
    targetJid: "120363@g.us",
    creatorJid: "201000000000@s.whatsapp.net",
    message: "pay the fee",
    date: new Date(Date.now() + 40).toISOString(),
    status: "pending",
  };
  scheduler.saveScheduledJob(job);
  ok("scheduleNewJob arms the job", scheduler.scheduleNewJob(proxy, job));

  ok(
    "the reminder is delivered",
    await waitUntil(() => storage.getSchedule(job.id)?.status === "sent"),
  );
  equal("the raw socket sent once", rawCalls.length, 1);
  equal("the raw socket sent to the job's chat", rawCalls[0]?.jid, job.targetJid);
  ok("the reminder carries the message", String(rawCalls[0]?.content?.text).includes(job.message));
  equal("the proxy sent nothing", proxyCalls.length, 0);
}

section("one delivery attempt uses one socket for every payload");

{
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  const job = {
    id: "one-socket-per-attempt",
    type: "once",
    targetJid: "201000000000@s.whatsapp.net",
    creatorJid: "dashboard@levix",
    message: "listen, then read",
    date: new Date(Date.now() + 60_000).toISOString(),
    status: "failed",
    media: { kind: "audio", mimeType: "audio/mpeg", fileName: "note.mp3" },
  };
  const mediaPath = scheduler.scheduleMediaPath(job.id);
  mkdirSync(dirname(mediaPath), { recursive: true });
  writeFileSync(mediaPath, Buffer.from("ID3 fake mp3"));
  scheduler.saveScheduledJob(job);

  const rawCalls = [];
  const lateCalls = [];
  bindRaw(async (_jid, content) => {
    rawCalls.push(content);
    // The connection drops while the first payload is out: currentSock becomes null.
    if (rawCalls.length === 1) scheduler.stopAllScheduledJobs();
  });
  const first = await scheduler.retryScheduledJob({ async sendMessage() {} }, job.id);
  ok("the attempt finishes", first.ok);
  equal("both payloads went through the captured socket", rawCalls.length, 2);
  ok("the audio went first", Buffer.isBuffer(rawCalls[0]?.audio));
  ok("the text followed", String(rawCalls[1]?.text).includes(job.message));

  // A later swap of currentSock cannot redirect an attempt already running.
  scheduler.saveScheduledJob({ ...job, status: "failed" });
  writeFileSync(mediaPath, Buffer.from("ID3 fake mp3"));
  const otherSock = {
    user: { id: "201000000002@s.whatsapp.net" },
    async sendMessage(jid, content) {
      lateCalls.push({ jid, content });
    },
  };
  rawCalls.length = 0;
  bindRaw(async (_jid, content) => {
    rawCalls.push(content);
    if (rawCalls.length === 1) {
      const realSchedule = cron.schedule;
      cron.schedule = () => ({ stop() {} });
      try {
        scheduler.initializeScheduledJobs(otherSock);
      } finally {
        cron.schedule = realSchedule;
      }
    }
  });
  const second = await scheduler.retryScheduledJob({ async sendMessage() {} }, job.id);
  ok("the second attempt finishes", second.ok);
  equal("every payload stayed on the first socket", rawCalls.length, 2);
  equal("the replacement socket got nothing from this attempt", lateCalls.length, 0);
}

section("with no live socket a delivery fails without sending");

{
  const rawCalls = [];
  const proxyCalls = [];
  bindRaw(async (jid, content) => {
    rawCalls.push({ jid, content });
  });
  scheduler.stopAllScheduledJobs(); // clears currentSock
  const proxy = {
    async sendMessage(jid, content) {
      proxyCalls.push({ jid, content });
    },
  };
  const job = {
    id: "no-live-socket",
    type: "once",
    targetJid: "201000000000@s.whatsapp.net",
    creatorJid: "201000000000@s.whatsapp.net",
    message: "nobody home",
    date: new Date(Date.now() + 60_000).toISOString(),
    status: "failed",
  };
  scheduler.saveScheduledJob(job);

  const retry = await scheduler.retryScheduledJob(proxy, job.id);
  equal("the retry is a delivery failure", retry.reason, "delivery_failed");
  equal("the retry is not ok", retry.ok, false);
  equal("the raw socket sent nothing", rawCalls.length, 0);
  equal("the proxy sent nothing", proxyCalls.length, 0);
  const stored = storage.getSchedule(job.id);
  equal("the job stays failed", stored.status, "failed");
  equal("the delivery is recorded as failed", stored.lastDeliveryStatus, "failed");
  ok("the reason is recorded", String(stored.lastError || "").length > 0);

  // Arming still works without a socket; the reconnect re-arms with the raw one.
  const armed = { ...job, id: "armed-without-socket", status: "pending" };
  scheduler.saveScheduledJob(armed);
  ok("a command can still arm a job", scheduler.scheduleNewJob(proxy, armed));
  scheduler.deleteScheduledJob(armed.id);
}

section("the panel exposes delivery state and manual retry");

{
  const source = readFileSync(join(ROOT, "frontend", "src", "views", "SchedulesView.tsx"), "utf8");
  ok("the table renders the readable schedule", source.includes("scheduleWhen(s, language)"));
  ok(
    "failed jobs get a retry control",
    source.includes('s.lastDeliveryStatus === "failed"') && source.includes("void handleRetry(s.id)"),
  );
  ok("the retry control calls the protected API", source.includes("await api.retrySchedule(id)"));
}

section("unlink during a running one-off leaves it paused");

{
  let release;
  let started = false;
  const job = {
    id: "one-off-unlink",
    type: "once",
    targetJid: "201000000000@s.whatsapp.net",
    creatorJid: "201000000000@s.whatsapp.net",
    message: "still paused",
    date: new Date(Date.now() + 40).toISOString(),
    status: "pending",
  };
  bindRaw(async () => {
    started = true;
    await new Promise((resolve) => {
      release = resolve;
    });
    throw new Error("unlinked");
  });
  scheduler.saveScheduledJob(job);
  scheduler.scheduleNewJob({ async sendMessage() {} }, job);
  try {
    ok("the one-off send started", await waitUntil(() => started));
    const { WhatsAppSession } = await import("../src/core/session.js");
    const session = new WhatsAppSession({
      checkConsent: () => ({ ok: true }),
      log: { info() {}, warn() {}, error() {}, debug() {}, trace() {} },
    });
    await session.logout();
  } finally {
    if (release) release();
    scheduler.stopAllScheduledJobs();
  }
  await new Promise((resolve) => setTimeout(resolve, 30));
  const stored = storage.getSchedule(job.id);
  equal("unlink leaves the one-off paused", stored.status, "paused");
  equal("stale delivery does not record failure", stored.lastDeliveryStatus, null);
}

finish();

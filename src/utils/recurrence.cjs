const { t, withLang, currentLang, intlTag } = require("./i18n.cjs");

const DAY_ALIASES = new Map([
  ["0", 0],
  ["7", 0],
  ["sun", 0],
  ["sunday", 0],
  ["الاحد", 0],
  ["احد", 0],
  ["1", 1],
  ["mon", 1],
  ["monday", 1],
  ["الاثنين", 1],
  ["اثنين", 1],
  ["الاتنين", 1],
  ["اتنين", 1],
  ["2", 2],
  ["tue", 2],
  ["tues", 2],
  ["tuesday", 2],
  ["الثلاثاء", 2],
  ["ثلاثاء", 2],
  ["التلات", 2],
  ["3", 3],
  ["wed", 3],
  ["wednesday", 3],
  ["الاربعاء", 3],
  ["اربعاء", 3],
  ["الاربع", 3],
  ["4", 4],
  ["thu", 4],
  ["thur", 4],
  ["thurs", 4],
  ["thursday", 4],
  ["الخميس", 4],
  ["خميس", 4],
  ["5", 5],
  ["fri", 5],
  ["friday", 5],
  ["الجمعه", 5],
  ["جمعه", 5],
  ["6", 6],
  ["sat", 6],
  ["saturday", 6],
  ["السبت", 6],
  ["سبت", 6],
]);

// */N restarts at midnight; only these keep a gap of N across the day boundary.
const HOURLY_INTERVALS = [1, 2, 3, 4, 6, 8, 12];

function normalizeDay(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[\u0640\u064b-\u065f\u0670]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه");
}

function parseDayOfWeek(value) {
  return DAY_ALIASES.get(normalizeDay(value)) ?? null;
}

function parseTime(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? "").trim());
  if (!match) return null;

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;

  return {
    hour,
    minute,
    text: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
  };
}

function parseRecurringArgs(args) {
  const type = String(args[0] ?? "")
    .trim()
    .toLowerCase();

  if (type === "daily") {
    const time = parseTime(args[1]);
    const message = args.slice(2).join(" ").trim();
    if (!time) return { error: "time" };
    if (!message) return { error: "message" };
    return {
      type,
      time: time.text,
      message,
      cronString: `${time.minute} ${time.hour} * * *`,
    };
  }

  if (type === "weekly") {
    const dayOfWeek = parseDayOfWeek(args[1]);
    const time = parseTime(args[2]);
    const message = args.slice(3).join(" ").trim();
    if (dayOfWeek === null) return { error: "day" };
    if (!time) return { error: "time" };
    if (!message) return { error: "message" };
    return {
      type,
      dayOfWeek,
      time: time.text,
      message,
      cronString: `${time.minute} ${time.hour} * * ${dayOfWeek}`,
    };
  }

  return { error: type ? "type" : "usage" };
}

function uniqueSortedDays(values) {
  if (!Array.isArray(values)) return { error: "weekdays" };
  const days = [];
  for (const value of values) {
    const day = Number(value);
    if (!Number.isInteger(day) || day < 0 || day > 6) return { error: "weekdays" };
    if (!days.includes(day)) days.push(day);
  }
  days.sort((a, b) => a - b);
  return { days };
}

/**
 * Turn a panel recurrence object into a 5-field cron string.
 * The client never supplies the cron — this is the only builder.
 *
 * { kind: "daily"|"weekly"|"monthly"|"hourly", time: "HH:MM",
 *   weekdays?: number[], dayOfMonth?: number, everyHours?: number }
 */
function recurrenceToCron(recurrence) {
  if (!recurrence || typeof recurrence !== "object") return { error: "recurrence" };
  const kind = String(recurrence.kind || "")
    .trim()
    .toLowerCase();
  const time = parseTime(recurrence.time);

  if (kind === "daily") {
    if (!time) return { error: "time" };
    return {
      kind,
      time: time.text,
      cronString: `${time.minute} ${time.hour} * * *`,
    };
  }

  if (kind === "weekly") {
    if (!time) return { error: "time" };
    const parsed = uniqueSortedDays(recurrence.weekdays);
    if (parsed.error) return parsed;
    if (!parsed.days.length) return { error: "weekdays" };
    return {
      kind,
      time: time.text,
      weekdays: parsed.days,
      cronString: `${time.minute} ${time.hour} * * ${parsed.days.join(",")}`,
    };
  }

  if (kind === "monthly") {
    if (!time) return { error: "time" };
    const day = Number(recurrence.dayOfMonth);
    if (!Number.isInteger(day) || day < 1 || day > 31) return { error: "dayOfMonth" };
    return {
      kind,
      time: time.text,
      dayOfMonth: day,
      cronString: `${time.minute} ${time.hour} ${day} * *`,
    };
  }

  if (kind === "hourly") {
    const n = Number(recurrence.everyHours);
    if (!Number.isInteger(n) || !HOURLY_INTERVALS.includes(n)) return { error: "everyHours" };
    if (!time) return { error: "time" };
    return {
      kind,
      everyHours: n,
      minute: time.minute,
      time: time.text,
      cronString: `${time.minute} */${n} * * *`,
    };
  }

  return { error: "kind" };
}

const DESCRIBE_LANGS = new Set(["en", "ar", "pt-BR", "es-419"]);

function describeLang(lang) {
  // Codes outside en, ar, pt-BR, and es-419 stay English.
  return DESCRIBE_LANGS.has(lang) ? lang : "en";
}

function recurrenceErrorMessage(error, lang = "en") {
  // The panel calls this with no reply language, so the default stays English.
  return withLang(describeLang(lang), () => {
    switch (error) {
      case "time":
        return t("bot.schedules.recurrence.errorTime");
      case "weekdays":
        return t("bot.schedules.recurrence.errorWeekdays");
      case "dayOfMonth":
        return t("bot.schedules.recurrence.errorDayOfMonth");
      case "everyHours":
        return t("bot.schedules.recurrence.errorEveryHours");
      default:
        return t("bot.schedules.recurrence.errorInvalid");
    }
  });
}

function joinWeekdayNames(days) {
  const names = days.map((day) => t(`bot.schedules.recurrence.weekday${day}`));
  if (names.length === 1) return names[0];
  const and = t("bot.schedules.recurrence.weekdayAnd");
  if (names.length === 2) return `${names[0]}${and}${names[1]}`;
  const sep = t("bot.schedules.recurrence.weekdaySep");
  return `${names.slice(0, -1).join(sep)}${and}${names[names.length - 1]}`;
}

function withZone(text, timezone) {
  return `${text} (${timezone})`;
}

// The old phrase used the plural noun for 3 to 10 only. CLDR "few" also
// covers 103 and 110, and those used the same phrase as 11.
function hourlyPluralCount(n) {
  const category = new Intl.PluralRules(currentLang()).select(n);
  if (category === "few" && (n < 3 || n > 10)) return 11;
  return n;
}

// one and two name the interval and do not print the number.
function hourlyToken(n) {
  const category = new Intl.PluralRules(currentLang()).select(n);
  if (category === "one" || category === "two") return "";
  return String(n);
}

function everyHoursPhrase(n, minute, lang = "en") {
  return withLang(describeLang(lang), () =>
    t("bot.schedules.recurrence.hourly", {
      count: hourlyPluralCount(n),
      n: hourlyToken(n),
      minute,
    }),
  );
}

function describeRecurringCron(cronString, timezone) {
  const fallback = withZone(cronString || t("bot.schedules.recurrence.unknown"), timezone);
  const parts = String(cronString ?? "")
    .trim()
    .split(/\s+/);
  if (parts.length !== 5) return fallback;

  const [minuteText, hourText, dayOfMonth, month, dayText] = parts;
  const minute = Number(minuteText);
  const hour = Number(hourText);
  const validMinute = /^\d+$/.test(minuteText) && minute >= 0 && minute <= 59;
  const validHour = /^\d+$/.test(hourText) && hour >= 0 && hour <= 23;

  const everyHours = /^\*\/(\d+)$/.exec(hourText);
  if (validMinute && everyHours && dayOfMonth === "*" && month === "*" && dayText === "*") {
    const n = Number(everyHours[1]);
    if (n >= 1 && n <= 12) {
      return withZone(everyHoursPhrase(n, minute, currentLang()), timezone);
    }
  }

  if (!validMinute || !validHour || month !== "*") return fallback;
  const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

  if (dayOfMonth !== "*" && dayText === "*") {
    const day = Number(dayOfMonth);
    if (/^\d+$/.test(dayOfMonth) && day >= 1 && day <= 31) {
      return withZone(t("bot.schedules.recurrence.monthly", { day, time }), timezone);
    }
    return fallback;
  }

  if (dayOfMonth !== "*") return fallback;

  if (dayText === "*") {
    return withZone(t("bot.schedules.recurrence.daily", { time }), timezone);
  }

  const days = dayText.split(",").map((token) => parseDayOfWeek(token.trim()));
  if (!days.length || days.some((day) => day === null)) return fallback;
  const unique = [...new Set(days)].sort((a, b) => a - b);
  const names = joinWeekdayNames(unique);
  return withZone(t("bot.schedules.recurrence.weekly", { days: names, time }), timezone);
}

function describeScheduledJob(job, timezone, lang = "en") {
  const code = describeLang(lang);
  return withLang(code, () => {
    if (job.type === "recurring") return describeRecurringCron(job.cronString, timezone);

    const date = new Date(job.date);
    if (!Number.isFinite(date.getTime())) return t("bot.schedules.recurrence.invalidDate");
    return withZone(
      new Intl.DateTimeFormat(intlTag(code), {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: timezone,
      }).format(date),
      timezone,
    );
  });
}

module.exports = {
  parseDayOfWeek,
  parseRecurringArgs,
  parseTime,
  recurrenceToCron,
  recurrenceErrorMessage,
  everyHoursPhrase,
  describeScheduledJob,
};

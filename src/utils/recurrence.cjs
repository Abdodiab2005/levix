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

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKDAYS_AR = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
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

function recurrenceErrorMessage(error) {
  switch (error) {
    case "time":
      return "Invalid time";
    case "weekdays":
      return "Select at least one weekday";
    case "dayOfMonth":
      return "Day of month must be between 1 and 31";
    case "everyHours":
      return "Hours must be 1, 2, 3, 4, 6, 8 or 12";
    default:
      return "Invalid recurrence";
  }
}

function joinWeekdayNames(days, lang) {
  const names = days.map((day) => (lang === "ar" ? WEEKDAYS_AR[day] : WEEKDAYS[day]));
  if (lang === "ar") return names.join(" و");
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function withZone(text, timezone) {
  return `${text} (${timezone})`;
}

function arabicEveryHours(n) {
  if (n === 1) return "كل ساعة";
  if (n === 2) return "كل ساعتين";
  if (n >= 3 && n <= 10) return `كل ${n} ساعات`;
  return `كل ${n} ساعة`;
}

function describeRecurringCron(cronString, timezone, lang) {
  const ar = lang === "ar";
  const fallback = withZone(cronString || (ar ? "تكرار غير معروف" : "Unknown recurrence"), timezone);
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
  if (
    validMinute &&
    everyHours &&
    dayOfMonth === "*" &&
    month === "*" &&
    dayText === "*"
  ) {
    const n = Number(everyHours[1]);
    if (n >= 1 && n <= 12) {
      if (ar) {
        return withZone(`${arabicEveryHours(n)} عند الدقيقة ${minute}`, timezone);
      }
      return withZone(
        n === 1 ? `Every hour at minute ${minute}` : `Every ${n} hours at minute ${minute}`,
        timezone,
      );
    }
  }

  if (!validMinute || !validHour || month !== "*") return fallback;
  const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

  if (dayOfMonth !== "*" && dayText === "*") {
    const day = Number(dayOfMonth);
    if (/^\d+$/.test(dayOfMonth) && day >= 1 && day <= 31) {
      return withZone(
        ar ? `كل شهر في اليوم ${day} الساعة ${time}` : `Every month on day ${day} at ${time}`,
        timezone,
      );
    }
    return fallback;
  }

  if (dayOfMonth !== "*") return fallback;

  if (dayText === "*") {
    return withZone(ar ? `يومياً الساعة ${time}` : `Daily at ${time}`, timezone);
  }

  const days = dayText.split(",").map((token) => parseDayOfWeek(token.trim()));
  if (!days.length || days.some((day) => day === null)) return fallback;
  const unique = [...new Set(days)].sort((a, b) => a - b);
  const names = joinWeekdayNames(unique, ar ? "ar" : "en");
  if (ar) return withZone(`كل يوم ${names} الساعة ${time}`, timezone);
  if (unique.length === 1) return withZone(`Every ${names} at ${time}`, timezone);
  return withZone(`Every ${names} at ${time}`, timezone);
}

function describeScheduledJob(job, timezone, lang = "en") {
  const ar = lang === "ar";
  if (job.type === "recurring") {
    return describeRecurringCron(job.cronString, timezone, ar ? "ar" : "en");
  }

  const date = new Date(job.date);
  if (!Number.isFinite(date.getTime())) return ar ? "تاريخ غير صالح" : "Invalid date";
  return withZone(
    new Intl.DateTimeFormat(ar ? "ar-EG" : "en-GB", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: timezone,
    }).format(date),
    timezone,
  );
}

module.exports = {
  parseDayOfWeek,
  parseRecurringArgs,
  parseTime,
  recurrenceToCron,
  recurrenceErrorMessage,
  describeScheduledJob,
};

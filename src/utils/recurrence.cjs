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

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

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
  const type = String(args[0] ?? "").trim().toLowerCase();

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

function describeScheduledJob(job, timezone) {
  if (job.type === "recurring") {
    const parts = String(job.cronString ?? "").trim().split(/\s+/);
    if (parts.length === 5) {
      const [minuteText, hourText, dayOfMonth, month, dayText] = parts;
      const minute = Number(minuteText);
      const hour = Number(hourText);
      const validTime =
        /^\d+$/.test(minuteText) &&
        /^\d+$/.test(hourText) &&
        minute >= 0 &&
        minute <= 59 &&
        hour >= 0 &&
        hour <= 23;

      if (validTime && dayOfMonth === "*" && month === "*") {
        const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
        if (dayText === "*") return `Daily at ${time} (${timezone})`;

        const day = parseDayOfWeek(dayText);
        if (day !== null) return `Every ${WEEKDAYS[day]} at ${time} (${timezone})`;
      }
    }

    return `${job.cronString || "Unknown recurrence"} (${timezone})`;
  }

  const date = new Date(job.date);
  if (!Number.isFinite(date.getTime())) return "Invalid date";
  return `${new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: timezone,
  }).format(date)} (${timezone})`;
}

module.exports = {
  parseDayOfWeek,
  parseRecurringArgs,
  describeScheduledJob,
};

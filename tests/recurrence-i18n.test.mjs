// en and ar recurrence text must match HEAD src/utils/recurrence.cjs.
// The oracle below is that text path, copied here so the check does not
// depend on git at runtime.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  equal,
  finish,
  ok,
  require as harnessRequire,
  ROOT,
  section,
  useTempDataDir,
} from "./harness.mjs";

useTempDataDir("levix-recurrence-i18n");

const recurrence = harnessRequire("./src/utils/recurrence.cjs");
const i18n = harnessRequire("./src/utils/i18n.cjs");
const weather = harnessRequire("./src/commands/weather.cjs");

const ZONE = "Africa/Cairo";

function legacyRecurrence() {
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
    const fallback = withZone(
      cronString || (ar ? "تكرار غير معروف" : "Unknown recurrence"),
      timezone,
    );
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

  return {
    describeScheduledJob,
    recurrenceErrorMessage,
    arabicEveryHours,
    joinWeekdayNames,
  };
}

const legacy = legacyRecurrence();

function recurring(cronString) {
  return { type: "recurring", cronString };
}

function firstMismatch(cases, lang) {
  for (const cronString of cases) {
    const actual = recurrence.describeScheduledJob(recurring(cronString), ZONE, lang);
    const expected = legacy.describeScheduledJob(recurring(cronString), ZONE, lang);
    if (actual !== expected) return { cronString, actual, expected };
  }
  return null;
}

function assertSame(label, cases, lang) {
  const bad = firstMismatch(cases, lang);
  ok(label, bad === null, bad ? JSON.stringify(bad) : undefined);
}

function dailyCrons() {
  const out = [];
  for (let hour = 0; hour <= 23; hour += 1) {
    out.push(`0 ${hour} * * *`, `5 ${hour} * * *`, `59 ${hour} * * *`);
  }
  return out;
}

function weeklyCrons() {
  const out = [];
  for (let count = 1; count <= 7; count += 1) {
    const days = [];
    for (let day = 0; day < count; day += 1) days.push(String(day));
    out.push(`0 9 * * ${days.join(",")}`);
    out.push(`30 18 * * ${days.join(",")}`);
  }
  out.push("0 9 * * 5,1,5", "0 9 * * 7", "15 0 * * 6,0");
  return out;
}

function hourlyCrons() {
  const out = [];
  for (let n = 1; n <= 24; n += 1) {
    out.push(`0 */${n} * * *`, `15 */${n} * * *`);
  }
  return out;
}

function monthlyCrons() {
  const out = [];
  for (let day = 1; day <= 31; day += 1) {
    out.push(`0 9 ${day} * *`, `7 0 ${day} * *`);
  }
  return out;
}

const INVALID_CRONS = [
  "",
  null,
  undefined,
  "   ",
  "nope",
  "0 9 * *",
  "0 9 * * * *",
  "0 9 * 1 *",
  "0 9 0 * *",
  "0 9 32 * *",
  "0 9 15 * 1",
  "60 9 * * *",
  "0 24 * * *",
  "0 9 * * 8",
  "0 9 * * 1,8",
  "0 */0 * * *",
  "0 */24 * * *",
];

const ENGLISH_LEFT = new RegExp(
  "\\b(Daily|Every|Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|" +
    "Unknown|Invalid|hour|hours|minute)\\b",
);

function catalog(locale) {
  const path = join(ROOT, "i18n", locale, "bot", "schedules.json");
  return JSON.parse(readFileSync(path, "utf8"));
}

function placeholderSet(text) {
  const names = [];
  for (const match of String(text).matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
    names.push(match[1]);
  }
  return [...new Set(names)].sort().join(",");
}

section("en and ar match the HEAD recurrence text");

const groups = [
  ["daily", dailyCrons()],
  ["weekly", weeklyCrons()],
  ["hourly", hourlyCrons()],
  ["monthly", monthlyCrons()],
  ["invalid", INVALID_CRONS],
];
for (const lang of ["en", "ar"]) {
  for (const [name, cases] of groups) assertSame(`${name} ${lang}`, cases, lang);
}

const friday = recurring("30 18 * * 5");
equal(
  "default lang stays English",
  recurrence.describeScheduledJob(friday, ZONE),
  legacy.describeScheduledJob(friday, ZONE),
);
for (const lang of ["fr", "pt", "AR", null]) {
  equal(
    `lang ${String(lang)} stays English`,
    recurrence.describeScheduledJob(friday, ZONE, lang),
    legacy.describeScheduledJob(friday, ZONE, lang),
  );
}

const onceOk = { type: "once", date: "2026-06-07T20:30:00.000Z" };
const onceBad = { type: "once", date: "not-a-date" };
for (const lang of ["en", "ar"]) {
  for (const zone of [ZONE, "UTC"]) {
    equal(
      `once ${lang} ${zone}`,
      recurrence.describeScheduledJob(onceOk, zone, lang),
      legacy.describeScheduledJob(onceOk, zone, lang),
    );
    equal(
      `invalid date ${lang} ${zone}`,
      recurrence.describeScheduledJob(onceBad, zone, lang),
      legacy.describeScheduledJob(onceBad, zone, lang),
    );
  }
}
equal("invalid date en", recurrence.describeScheduledJob(onceBad, ZONE, "en"), "Invalid date");
equal("invalid date ar", recurrence.describeScheduledJob(onceBad, ZONE, "ar"), "تاريخ غير صالح");

section("hourly phrases for every Arabic plural boundary");

function legacyHours(n, minute, lang) {
  if (lang === "ar") return `${legacy.arabicEveryHours(n)} عند الدقيقة ${minute}`;
  if (n === 1) return `Every hour at minute ${minute}`;
  return `Every ${n} hours at minute ${minute}`;
}

{
  const ns = [];
  for (let n = 0; n <= 120; n += 1) ns.push(n);
  for (let n = 200; n <= 210; n += 1) ns.push(n);
  let bad = null;
  for (const lang of ["en", "ar"]) {
    for (const minute of [0, 15]) {
      for (const n of ns) {
        const actual = recurrence.everyHoursPhrase(n, minute, lang);
        const expected = legacyHours(n, minute, lang);
        if (actual !== expected) {
          bad = { lang, n, minute, actual, expected };
          break;
        }
      }
      if (bad) break;
    }
    if (bad) break;
  }
  ok("everyHoursPhrase en and ar", bad === null, bad ? JSON.stringify(bad) : undefined);
}

section("pt-BR and es-419 catalog text");

const PHRASES = [
  ...dailyCrons(),
  ...weeklyCrons(),
  ...hourlyCrons(),
  ...monthlyCrons(),
  ...INVALID_CRONS,
];

function assertNoEnglish(lang) {
  let bad = null;
  for (const cronString of PHRASES) {
    const actual = recurrence.describeScheduledJob(recurring(cronString), ZONE, lang);
    const raw = `${cronString} (${ZONE})`;
    if (actual === raw) continue;
    const english = recurrence.describeScheduledJob(recurring(cronString), ZONE, "en");
    if (!actual || actual === english || ENGLISH_LEFT.test(actual)) {
      bad = { cronString, actual, english };
      break;
    }
  }
  ok(`${lang} phrases are not English`, bad === null, bad ? JSON.stringify(bad) : undefined);
}

assertNoEnglish("pt-BR");
assertNoEnglish("es-419");

const SAMPLES = [
  ["pt-BR", "0 9 * * *", "Todos os dias às 09:00 (Africa/Cairo)"],
  ["pt-BR", "30 18 * * 5", "A cada Sexta-feira às 18:30 (Africa/Cairo)"],
  ["pt-BR", "0 9 * * 1,4", "A cada Segunda-feira e Quinta-feira às 09:00 (Africa/Cairo)"],
  [
    "pt-BR",
    "0 9 * * 0,1,2",
    "A cada Domingo, Segunda-feira e Terça-feira às 09:00 (Africa/Cairo)",
  ],
  [
    "pt-BR",
    "0 9 * * 0,1,2,3,4,5,6",
    "A cada Domingo, Segunda-feira, Terça-feira, Quarta-feira, " +
      "Quinta-feira, Sexta-feira e Sábado às 09:00 (Africa/Cairo)",
  ],
  ["pt-BR", "0 */1 * * *", "A cada hora no minuto 0 (Africa/Cairo)"],
  ["pt-BR", "0 */2 * * *", "A cada 2 horas no minuto 0 (Africa/Cairo)"],
  ["pt-BR", "15 */3 * * *", "A cada 3 horas no minuto 15 (Africa/Cairo)"],
  ["pt-BR", "0 */12 * * *", "A cada 12 horas no minuto 0 (Africa/Cairo)"],
  ["pt-BR", "0 9 15 * *", "Todo mês no dia 15 às 09:00 (Africa/Cairo)"],
  ["pt-BR", "", "Repetição desconhecida (Africa/Cairo)"],
  ["pt-BR", "0 9 * * 7", "A cada Domingo às 09:00 (Africa/Cairo)"],
  ["es-419", "0 9 * * *", "Todos los días a las 09:00 (Africa/Cairo)"],
  ["es-419", "30 18 * * 5", "Cada Viernes a las 18:30 (Africa/Cairo)"],
  ["es-419", "0 9 * * 1,4", "Cada Lunes y Jueves a las 09:00 (Africa/Cairo)"],
  ["es-419", "0 9 * * 0,1,2", "Cada Domingo, Lunes y Martes a las 09:00 (Africa/Cairo)"],
  [
    "es-419",
    "0 9 * * 0,1,2,3,4,5,6",
    "Cada Domingo, Lunes, Martes, Miércoles, Jueves, Viernes y Sábado " +
      "a las 09:00 (Africa/Cairo)",
  ],
  ["es-419", "0 */1 * * *", "Cada hora en el minuto 0 (Africa/Cairo)"],
  ["es-419", "0 */2 * * *", "Cada 2 horas en el minuto 0 (Africa/Cairo)"],
  ["es-419", "15 */3 * * *", "Cada 3 horas en el minuto 15 (Africa/Cairo)"],
  ["es-419", "0 */12 * * *", "Cada 12 horas en el minuto 0 (Africa/Cairo)"],
  ["es-419", "0 9 15 * *", "Todos los meses el día 15 a las 09:00 (Africa/Cairo)"],
  ["es-419", "", "Repetición desconocida (Africa/Cairo)"],
  ["es-419", "0 9 * * 7", "Cada Domingo a las 09:00 (Africa/Cairo)"],
];
for (const [lang, cronString, expected] of SAMPLES) {
  equal(
    `${lang} ${cronString || "empty"}`,
    recurrence.describeScheduledJob(recurring(cronString), ZONE, lang),
    expected,
  );
}
equal(
  "invalid date pt-BR",
  recurrence.describeScheduledJob(onceBad, ZONE, "pt-BR"),
  "Data inválida",
);
equal(
  "invalid date es-419",
  recurrence.describeScheduledJob(onceBad, ZONE, "es-419"),
  "Fecha no válida",
);

for (const [lang, tag] of [
  ["en", "en-GB"],
  ["ar", "ar-EG"],
  ["pt-BR", "pt-BR"],
  ["es-419", "es-419"],
]) {
  const formatted = new Intl.DateTimeFormat(tag, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: ZONE,
  }).format(new Date(onceOk.date));
  equal(
    `once tag ${lang}`,
    recurrence.describeScheduledJob(onceOk, ZONE, lang),
    `${formatted} (${ZONE})`,
  );
}

section("catalog plural shape");

const KEYS = [
  "recurrence.weekday0",
  "recurrence.weekday1",
  "recurrence.weekday2",
  "recurrence.weekday3",
  "recurrence.weekday4",
  "recurrence.weekday5",
  "recurrence.weekday6",
  "recurrence.weekdaySep",
  "recurrence.weekdayAnd",
  "recurrence.daily",
  "recurrence.weekly",
  "recurrence.monthly",
  "recurrence.hourly",
  "recurrence.unknown",
  "recurrence.invalidDate",
  "recurrence.errorTime",
  "recurrence.errorWeekdays",
  "recurrence.errorDayOfMonth",
  "recurrence.errorEveryHours",
  "recurrence.errorInvalid",
];
const enHourly = catalog("en")["recurrence.hourly"];
const union = new Set();
for (const text of Object.values(enHourly)) {
  for (const name of placeholderSet(text).split(",")) if (name) union.add(name);
}
const unionText = [...union].sort().join(",");
for (const locale of ["en", "ar", "pt-BR", "es-419"]) {
  const data = catalog(locale);
  for (const key of KEYS) ok(`${locale} ${key}`, Object.hasOwn(data, key));
  const hourly = data["recurrence.hourly"];
  for (const [category, text] of Object.entries(hourly)) {
    equal(`${locale} ${category} placeholders`, placeholderSet(text), unionText);
    ok(`${locale} ${category} plain`, !/[`*]/.test(text));
  }
}
equal(
  "ar hourly categories",
  Object.keys(catalog("ar")["recurrence.hourly"]).sort().join(","),
  "few,many,one,other,two,zero",
);
for (const locale of ["pt-BR", "es-419"]) {
  const hourly = catalog(locale)["recurrence.hourly"];
  equal(
    `${locale} hourly categories`,
    Object.keys(hourly).sort().join(","),
    "many,one,other",
  );
  equal(`${locale} many equals other`, hourly.many, hourly.other);
}

section("error text");

const ERRORS = [
  ["time", "errorTime"],
  ["weekdays", "errorWeekdays"],
  ["dayOfMonth", "errorDayOfMonth"],
  ["everyHours", "errorEveryHours"],
  ["recurrence", "errorInvalid"],
  ["other", "errorInvalid"],
];
for (const [code] of ERRORS) {
  equal(
    `error ${code} default`,
    recurrence.recurrenceErrorMessage(code),
    legacy.recurrenceErrorMessage(code),
  );
  equal(
    `error ${code} en`,
    recurrence.recurrenceErrorMessage(code, "en"),
    legacy.recurrenceErrorMessage(code),
  );
}
for (const locale of ["ar", "pt-BR", "es-419"]) {
  const data = catalog(locale);
  for (const [code, key] of ERRORS) {
    equal(
      `error ${code} ${locale}`,
      recurrence.recurrenceErrorMessage(code, locale),
      data[`recurrence.${key}`],
    );
  }
}

section("intl tags and weather lang");

equal("intlTag default", i18n.intlTag(), "ar-EG");
equal("intlTag en", i18n.intlTag("en"), "en-GB");
equal("intlTag ar", i18n.intlTag("ar"), "ar-EG");
equal("intlTag pt-BR", i18n.intlTag("pt-BR"), "pt-BR");
equal("intlTag es-419", i18n.intlTag("es-419"), "es-419");
equal("intlTag en scope", i18n.withLang("en", () => i18n.intlTag()), "en-GB");
equal("intlTag ar scope", i18n.withLang("ar", () => i18n.intlTag()), "ar-EG");
equal("intlTag pt scope", i18n.withLang("pt-BR", () => i18n.intlTag()), "pt-BR");
equal("intlTag es scope", i18n.withLang("es-419", () => i18n.intlTag()), "es-419");

const lists = readFileSync(join(ROOT, "src/commands/listschedules.cjs"), "utf8");
const warns = readFileSync(join(ROOT, "src/commands/group/warns.cjs"), "utf8");
ok("listschedules uses intlTag", lists.includes("toLocaleString(intlTag(),"));
ok("warns uses intlTag", warns.includes("toLocaleString(intlTag(),"));
ok("listschedules has no tr locale", !lists.includes('tr("en-GB", "ar-EG")'));
ok("warns has no tr locale", !warns.includes('tr("en-GB", "ar-EG")'));

function weatherQuery(lang) {
  const url = i18n.withLang(lang, () => weather.weatherApiUrl("Cairo", "KEY"));
  const prefix = "https://api.openweathermap.org/data/2.5/weather?";
  ok(`weather ${lang} path`, url.startsWith(prefix));
  return url.slice(prefix.length);
}
equal("weather en", weatherQuery("en"), "q=Cairo&appid=KEY&units=metric&lang=en");
equal("weather ar", weatherQuery("ar"), "q=Cairo&appid=KEY&units=metric&lang=ar");
equal("weather pt-BR", weatherQuery("pt-BR"), "q=Cairo&appid=KEY&units=metric&lang=pt_br");
equal("weather es-419", weatherQuery("es-419"), "q=Cairo&appid=KEY&units=metric&lang=es");

section("dashboard whenByLocale");

const express = (await import("express")).default;
const { default: routes } = await import("../src/routes/dashboard.api.esm.js");
const { saveSchedule } = await import("../src/utils/storage.esm.js");
saveSchedule({
  id: "i18n-friday",
  type: "recurring",
  targetJid: "120363@g.us",
  message: "weekly report",
  cronString: "30 18 * * 5",
  status: "active",
  creatorJid: "201000000000@s.whatsapp.net",
});
const app = express();
app.use(express.json());
app.use("/dashboard/api", routes);
const server = await new Promise((resolve) => {
  const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
});
try {
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/dashboard/api/schedules`);
  const body = await response.json();
  equal("schedules status", response.status, 200);
  const row = body.schedules.find((item) => item.id === "i18n-friday");
  ok("friday row", Boolean(row));
  for (const code of ["en", "ar", "pt-BR", "es-419"]) {
    const text = row?.whenByLocale?.[code];
    ok(`${code} whenByLocale`, typeof text === "string" && text.length > 0);
  }
  equal("when is en", row.when, row.whenByLocale.en);
  equal("whenAr is ar", row.whenAr, row.whenByLocale.ar);
  equal("when en text", row.when, "Every Friday at 18:30 (Africa/Cairo)");
  equal("when ar text", row.whenAr, "كل يوم الجمعة الساعة 18:30 (Africa/Cairo)");
  equal("when pt text", row.whenByLocale["pt-BR"], "A cada Sexta-feira às 18:30 (Africa/Cairo)");
  equal("when es text", row.whenByLocale["es-419"], "Cada Viernes a las 18:30 (Africa/Cairo)");
} finally {
  await new Promise((resolve) => server.close(resolve));
}

finish();

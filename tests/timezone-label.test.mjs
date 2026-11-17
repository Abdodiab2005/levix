import { timezoneLabel } from "../frontend/src/utils/timezoneLabel.ts";
import { finish, ok, section } from "./harness.mjs";

const january = new Date(Date.UTC(2026, 0, 15, 12));
const july = new Date(Date.UTC(2026, 6, 15, 12));

/** The offset Intl reports for this date, written as UTC±HH:MM. */
function runtimeUtc(timeZone, date) {
  const raw =
    new Intl.DateTimeFormat("en", {
      timeZone,
      hour: "2-digit",
      timeZoneName: "longOffset",
    })
      .formatToParts(date)
      .find((part) => part.type === "timeZoneName")?.value ?? "";
  if (/^GMT$/i.test(raw)) return "UTC+00:00";
  const match = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/i.exec(raw);
  if (!match) return raw.replace(/^GMT/i, "UTC");
  const hours = match[2].padStart(2, "0");
  const minutes = (match[3] ?? "00").padStart(2, "0");
  return `UTC${match[1]}${hours}:${minutes}`;
}

section("Cairo winter offset");
{
  const label = timezoneLabel("Africa/Cairo", "en", january);
  ok("January label contains UTC+02:00", label.includes("UTC+02:00"), label);
}

section("Cairo summer offset follows the runtime");
{
  const expected = runtimeUtc("Africa/Cairo", july);
  const label = timezoneLabel("Africa/Cairo", "en", july);
  ok("July label contains the runtime offset", label.includes(expected), `${label} vs ${expected}`);
  ok("the runtime offset is a UTC label", expected.startsWith("UTC"));
}

section("Arabic label keeps the UTC offset");
{
  const label = timezoneLabel("Africa/Cairo", "ar", january);
  ok("Arabic label contains UTC", label.includes("UTC"), label);
}

section("invalid ids do not throw");
{
  let threw = false;
  let label = "";
  try {
    label = timezoneLabel("Not/AZone", "en", january);
  } catch {
    threw = true;
  }
  ok("unknown zone returns", !threw);
  ok("empty id is empty", timezoneLabel("   ", "en", january) === "");
  ok("unknown zone still returns a string", typeof label === "string");
}

finish();

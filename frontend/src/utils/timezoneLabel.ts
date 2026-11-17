// file: frontend/src/utils/timezoneLabel.ts

function zoneName(
  timeZone: string,
  date: Date,
  locale: string,
  timeZoneName: "longGeneric" | "longOffset",
): string | null {
  try {
    const parts = new Intl.DateTimeFormat(locale, {
      timeZone,
      hour: "2-digit",
      timeZoneName,
    }).formatToParts(date);
    const name = parts.find((part) => part.type === "timeZoneName")?.value?.trim();
    return name || null;
  } catch {
    return null;
  }
}

/** `GMT+2` / `GMT+02:00` from Intl, written as `UTC+02:00`. Empty when the id is invalid. */
export function utcOffsetLabel(timeZone: string, date: Date): string {
  const raw = zoneName(timeZone, date, "en", "longOffset");
  if (!raw) return "";
  if (/^GMT$/i.test(raw)) return "UTC+00:00";
  const match = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/i.exec(raw);
  if (!match) return raw.replace(/^GMT/i, "UTC");
  const hours = match[2].padStart(2, "0");
  const minutes = (match[3] ?? "00").padStart(2, "0");
  return `UTC${match[1]}${hours}:${minutes}`;
}

function cityOf(timeZone: string): string {
  const city = timeZone.split("/").pop() ?? "";
  return city.replace(/_/g, " ").trim();
}

/**
 * Human label for an IANA id. Uses the localized generic zone name, or the city
 * segment when that name is unavailable, plus the offset for `date` (DST included).
 * The stored value stays the id.
 */
export function timezoneLabel(timeZone: string, locale: string, date = new Date()): string {
  const id = timeZone.trim();
  if (!id) return "";
  const generic = zoneName(id, date, locale || "en", "longGeneric");
  const offset = utcOffsetLabel(id, date);
  const place = generic || cityOf(id);
  if (place && offset) return `${place} (${offset})`;
  return place || offset;
}

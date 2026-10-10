// file: frontend/src/components/ui/relative-time.tsx
import { useEffect, useState } from "react";
import { useI18n } from "../../context/I18nContext";
import { cn } from "../../utils/cn";

const listeners = new Set<() => void>();
let ticker: number | null = null;

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (ticker === null) {
    ticker = window.setInterval(() => {
      for (const notify of listeners) notify();
    }, 30_000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && ticker !== null) {
      window.clearInterval(ticker);
      ticker = null;
    }
  };
}

function localeOf(language: string) {
  return language === "ar" ? "ar" : "en";
}

function toMillis(value: number | string | Date): number | null {
  const ms =
    value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

const UNITS: Array<{ unit: Intl.RelativeTimeFormatUnit; ms: number }> = [
  { unit: "year", ms: 1000 * 60 * 60 * 24 * 365 },
  { unit: "month", ms: 1000 * 60 * 60 * 24 * 30 },
  { unit: "week", ms: 1000 * 60 * 60 * 24 * 7 },
  { unit: "day", ms: 1000 * 60 * 60 * 24 },
  { unit: "hour", ms: 1000 * 60 * 60 },
  { unit: "minute", ms: 1000 * 60 },
  { unit: "second", ms: 1000 },
];

function formatRelative(ms: number, now: number, language: string) {
  const diff = ms - now;
  const abs = Math.abs(diff);
  const format = new Intl.RelativeTimeFormat(localeOf(language), { numeric: "auto" });
  const picked = UNITS.find((item) => abs >= item.ms) ?? UNITS[UNITS.length - 1];
  const amount = Math.round(diff / picked.ms);
  return format.format(amount, picked.unit);
}

export interface RelativeTimeProps {
  /** Unix milliseconds, an ISO string, or a Date. */
  value: number | string | Date;
  className?: string;
}

/** A `<time>` that reads "3 minutes ago" and refreshes while it is mounted. */
export function RelativeTime({ value, className }: RelativeTimeProps) {
  const { language } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => subscribe(() => setNow(Date.now())), []);

  const ms = toMillis(value);
  if (ms === null) return null;
  const locale = localeOf(language);
  const absolute = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(ms);

  return (
    <time
      dateTime={new Date(ms).toISOString()}
      title={absolute}
      className={cn("whitespace-nowrap", className)}
    >
      {formatRelative(ms, now, language)}
    </time>
  );
}

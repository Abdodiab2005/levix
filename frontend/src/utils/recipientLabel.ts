// Labels for a recipient row or a schedule target. Pure: no React, no I/O.

import { fill } from "./fill.ts";

export const MEMBER_CATEGORIES = ["zero", "one", "two", "few", "many", "other"] as const;

export type NameSource = "saved" | "push" | "subject" | "phone" | "none";

export interface RecipientLike {
  id?: string | null;
  name?: string | null;
  type?: string | null;
  phone?: string | null;
  savedName?: string | null;
  pushName?: string | null;
  memberCount?: number | null;
  nameSource?: string | null;
  targetJid?: string | null;
  targetLabel?: string | null;
  targetKind?: string | null;
  targetPhone?: string | null;
  targetNameSource?: string | null;
}

export interface RecipientParts {
  title: string;
  subtitle: string;
  kind: "group" | "contact";
  distinguisher: string;
}

export type LabelCopy = (key: string) => string;

export interface BidiRun {
  text: string;
  ltr: boolean;
}

const GENERIC_LABELS = new Set(["Contact", "Group"]);

function asSource(value: string | null | undefined): NameSource | null {
  if (
    value === "saved" ||
    value === "push" ||
    value === "subject" ||
    value === "phone" ||
    value === "none"
  ) {
    return value;
  }
  return null;
}

/** Digits only, with leading zeros removed, so "+20 100" and "0020100" compare. */
export function phoneDigits(value: string | null | undefined): string {
  return String(value || "")
    .replace(/\D/g, "")
    .replace(/^0+/, "");
}

/** At least "+<digits>". Groups of three are only for reading. */
export function formatPhone(value: string | null | undefined): string {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  const groups = digits.match(/.{1,3}/g);
  return `+${groups ? groups.join(" ") : digits}`;
}

export function recipientKind(item: RecipientLike): "group" | "contact" {
  const type = item.type || item.targetKind || "";
  const id = String(item.id || item.targetJid || "");
  if (type === "group" || id.endsWith("@g.us")) return "group";
  return "contact";
}

export function resolveNameSource(item: RecipientLike): NameSource {
  const given = asSource(item.nameSource) || asSource(item.targetNameSource);
  if (given) return given;
  const kind = recipientKind(item);
  if (cleanName(item.savedName)) return "saved";
  if (cleanName(item.pushName)) return "push";
  if (kind === "group" && (cleanName(item.name, true) || cleanName(item.targetLabel, true))) {
    return "subject";
  }
  if (item.phone || item.targetPhone) return "phone";
  return "none";
}

function cleanName(value: string | null | undefined, rejectGeneric = false): string | null {
  const text = String(value || "").trim();
  if (!text || text.includes("@")) return null;
  if (/^\d{8,}$/.test(text)) return null;
  if (rejectGeneric && GENERIC_LABELS.has(text)) return null;
  return text;
}

/** Last four digits of a JID local part. Short enough that it is not a phone number. */
export function idTail(id: string | null | undefined): string {
  const local = String(id || "")
    .split("@")[0]
    .split(":")[0];
  const digits = local.replace(/\D/g, "");
  const source = digits || local;
  if (!source) return "";
  return source.slice(-4);
}

function peerId(item: RecipientLike): string {
  return String(item.id || item.targetJid || "");
}

function titleFor(item: RecipientLike, source: NameSource): string | null {
  if (source === "saved") {
    return (
      cleanName(item.savedName) || cleanName(item.name, true) || cleanName(item.targetLabel, true)
    );
  }
  if (source === "push") {
    return (
      cleanName(item.pushName) || cleanName(item.name, true) || cleanName(item.targetLabel, true)
    );
  }
  if (source === "subject") {
    return cleanName(item.name) || cleanName(item.targetLabel);
  }
  return null;
}

export function memberCountLabel(count: number, t: LabelCopy, locale: string): string {
  let category = "other";
  try {
    category = new Intl.PluralRules(locale).select(count);
  } catch {
    category = "other";
  }
  const key = `recipientMembers_${category}`;
  const template = t(key);
  const text = template && template !== key ? template : t("recipientMembers_other");
  return fill(text, { count });
}

function distinguisherFor(id: string, t: LabelCopy): string {
  const tail = idTail(id);
  if (!tail) return "";
  return fill(t("recipientIdTail"), { tail });
}

export function recipientParts(item: RecipientLike, t: LabelCopy, locale = "en"): RecipientParts {
  const kind = recipientKind(item);
  const source = resolveNameSource(item);
  const id = peerId(item);
  const distinguisher = distinguisherFor(id, t);
  const named = titleFor(item, source);
  const phone = formatPhone(item.phone || item.targetPhone);

  if (source === "phone" && phone) {
    return { title: phone, subtitle: "", kind, distinguisher };
  }
  if (source === "none" || !named) {
    const title = kind === "group" ? t("recipientUnnamedGroup") : t("recipientUnknownContact");
    return { title, subtitle: distinguisher, kind, distinguisher };
  }

  let subtitle = "";
  if (kind === "group") {
    const count = item.memberCount;
    if (typeof count === "number" && Number.isFinite(count) && count >= 0) {
      subtitle = memberCountLabel(Math.trunc(count), t, locale);
    }
  } else if (phone && phoneDigits(phone) !== phoneDigits(named)) {
    subtitle = phone;
  }
  return { title: named, subtitle, kind, distinguisher };
}

function pairKey(part: RecipientParts): string {
  return `${part.title}\n${part.subtitle}`;
}

/** When two rows share a title and a subtitle, both gain the id tail. */
export function disambiguateParts(list: RecipientParts[]): RecipientParts[] {
  const counts = new Map<string, number>();
  for (const part of list) counts.set(pairKey(part), (counts.get(pairKey(part)) || 0) + 1);
  return list.map((part) => {
    if ((counts.get(pairKey(part)) || 0) < 2 || !part.distinguisher) return part;
    if (part.subtitle.includes(part.distinguisher) || part.title.includes(part.distinguisher)) {
      return part;
    }
    const subtitle = part.subtitle
      ? `${part.subtitle} · ${part.distinguisher}`
      : part.distinguisher;
    return { ...part, subtitle };
  });
}

export function labelRecipients(
  items: RecipientLike[],
  t: LabelCopy,
  locale = "en",
): RecipientParts[] {
  return disambiguateParts(items.map((item) => recipientParts(item, t, locale)));
}

function searchableNames(item: RecipientLike): string[] {
  const source = resolveNameSource(item);
  const rejectGeneric = source === "none" || source === "phone";
  const values = [item.savedName, item.pushName, item.name, item.targetLabel];
  const names: string[] = [];
  for (const value of values) {
    const clean = cleanName(value, rejectGeneric);
    if (clean && !names.includes(clean)) names.push(clean);
  }
  return names;
}

export function recipientMatches(item: RecipientLike, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  if (searchableNames(item).some((name) => name.toLowerCase().includes(needle))) return true;
  const digits = phoneDigits(query);
  if (!digits) return false;
  const phones = [item.phone, item.targetPhone];
  const id = peerId(item);
  if (id.endsWith("@s.whatsapp.net")) phones.push(id);
  if (phones.some((phone) => phoneDigits(phone).includes(digits))) return true;
  return idTail(id) === digits;
}

/** Split a subtitle so phone numbers and digit runs can be LTR-isolated. */
export function bidiRuns(text: string): BidiRun[] {
  const runs: BidiRun[] = [];
  const re = /\+?\d[\d\u00a0 ]*/g;
  let last = 0;
  for (const match of text.matchAll(re)) {
    const index = match.index ?? 0;
    if (index > last) runs.push({ text: text.slice(last, index), ltr: false });
    const token = match[0].trimEnd();
    const trailing = match[0].slice(token.length);
    if (token) runs.push({ text: token, ltr: true });
    if (trailing) runs.push({ text: trailing, ltr: false });
    last = index + match[0].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last), ltr: false });
  if (!runs.length) runs.push({ text, ltr: false });
  return runs;
}

export function timezoneLongName(timeZone: string, locale: string, now = new Date()): string {
  const zone = timeZone || "UTC";
  try {
    const parts = new Intl.DateTimeFormat(locale, {
      timeZone: zone,
      timeZoneName: "long",
    }).formatToParts(now);
    return parts.find((part) => part.type === "timeZoneName")?.value || zone;
  } catch {
    return zone;
  }
}

export function formatInstantInZone(epochMs: number, timeZone: string, locale: string): string {
  const zone = timeZone || "UTC";
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone: zone,
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "long",
    }).format(new Date(epochMs));
  } catch {
    return new Intl.DateTimeFormat(locale, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(epochMs));
  }
}

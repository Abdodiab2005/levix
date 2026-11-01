// file: frontend/src/views/SchedulesView.tsx

import {
  AlertCircle,
  BookUser,
  Calendar,
  CheckCircle2,
  Eye,
  Paperclip,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  User,
  Users,
  X,
} from "lucide-react";
import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import type { ViewTab } from "../components/Sidebar";
import { useToast } from "../components/Toasts";
import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  Field,
  FilterButton,
  IconButton,
  Input,
  MenuItem,
  OverflowMenu,
  PageHeader,
  Pagination,
  RadioGroup,
  Select,
  Skeleton,
  SortMenu,
  Spinner,
  StatusPill,
  Textarea,
  Toolbar,
  UserText,
  usePagination,
} from "../components/ui";
import { useI18n } from "../context/I18nContext";
import { intlLocale, pickLocalized } from "../i18n/locale";
import type { Language, MessageKey } from "../i18n/translations";
import type { ScheduleItem } from "../types";
import { fill } from "../utils/fill";
import {
  canHostUploadForm,
  type HostSource,
  pickHostFile,
  uploadHostForm,
} from "../utils/hostBridge";

type RepeatKind = "daily" | "weekly" | "monthly" | "hourly";

interface RecipientItem {
  id: string;
  name: string;
  type: "group" | "contact";
  phone?: string | null;
  savedName?: string | null;
  pushName?: string | null;
  memberCount?: number | null;
}

const WEEKDAY_KEYS = [
  "weekdaySun",
  "weekdayMon",
  "weekdayTue",
  "weekdayWed",
  "weekdayThu",
  "weekdayFri",
  "weekdaySat",
] as const;

const WEEKDAY_FULL_KEYS = [
  "schedulesWeekdaySunday",
  "schedulesWeekdayMonday",
  "schedulesWeekdayTuesday",
  "schedulesWeekdayWednesday",
  "schedulesWeekdayThursday",
  "schedulesWeekdayFriday",
  "schedulesWeekdaySaturday",
] as const satisfies readonly MessageKey[];

const HOURLY_INTERVALS = [1, 2, 3, 4, 6, 8, 12];

type ScheduleCopy = (key: MessageKey) => string;

function hasPhoneBookPicker() {
  const host = (window as { LevixHost?: { pickContact?: () => void } }).LevixHost;
  return Boolean(host && typeof host.pickContact === "function");
}

function digitsToWhatsAppJid(phone: string): string | null {
  let digits = String(phone || "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.length < 8 || digits.length > 15) return null;
  return `${digits}@s.whatsapp.net`;
}

function personName(value?: string | null): string | null {
  const text = String(value || "").trim();
  if (!text || text.includes("@")) return null;
  // A bare long number is an id (a LID the mapping never resolved), not a
  // name — fall through to the phone display or the generic label instead.
  if (/^\d{8,}$/.test(text)) return null;
  return text;
}

function contactTitle(
  item: {
    savedName?: string | null;
    pushName?: string | null;
    name?: string | null;
    phone?: string | null;
    targetLabel?: string | null;
  },
  fallback: string,
): string {
  return (
    personName(item.savedName) ||
    personName(item.pushName) ||
    personName(item.name) ||
    personName(item.targetLabel) ||
    item.phone ||
    fallback
  );
}

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function joinWeekdayNames(days: number[], t: ScheduleCopy) {
  const names = days.map((day) => t(WEEKDAY_FULL_KEYS[day]));
  if (names.length <= 1) return names[0] || "";
  const and = t("schedulesWeekdayAnd");
  if (names.length === 2) return `${names[0]}${and}${names[1]}`;
  return `${names.slice(0, -1).join(t("schedulesWeekdaySep"))}${and}${names[names.length - 1]}`;
}

function scheduleWhen(item: ScheduleItem, language: Language): string {
  if (item.whenByLocale) return pickLocalized(item.whenByLocale, language);
  return pickLocalized(
    { en: item.when || undefined, ar: item.whenAr || undefined },
    language,
  );
}

function mediaKindLabel(
  t: (key: "mediaKindImage" | "mediaKindVideo" | "mediaKindAudio" | "mediaKindDocument") => string,
  kind: string,
): string {
  if (kind === "image") return t("mediaKindImage");
  if (kind === "video") return t("mediaKindVideo");
  if (kind === "audio") return t("mediaKindAudio");
  if (kind === "document") return t("mediaKindDocument");
  return kind;
}

/** One label + value line of the details modal. */
const DetailRow: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex flex-col sm:flex-row sm:items-start gap-1 sm:gap-3">
    <span className="sm:w-32 shrink-0 font-bold text-muted">{label}</span>
    <span className="min-w-0">{children}</span>
  </div>
);

function previewRecurrence(
  kind: RepeatKind,
  time: string,
  weekdays: number[],
  dayOfMonth: number,
  everyHours: number,
  minute: number,
  timezone: string,
  t: ScheduleCopy,
): string | null {
  const timeOk = /^\d{1,2}:\d{2}$/.test(time);
  const zone = timezone || "UTC";
  if (kind === "hourly") {
    if (!Number.isInteger(everyHours) || !HOURLY_INTERVALS.includes(everyHours)) return null;
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
    if (everyHours === 1) return fill(t("schedulesHourlyOne"), { minute, zone });
    if (everyHours === 2) return fill(t("schedulesHourlyTwo"), { minute, zone });
    if (everyHours <= 10) return fill(t("schedulesHourlyFew"), { hours: everyHours, minute, zone });
    return fill(t("schedulesHourlyMany"), { hours: everyHours, minute, zone });
  }
  if (!timeOk) return null;
  const [h, m] = time.split(":").map(Number);
  if (h > 23 || m > 59) return null;
  const hhmm = `${pad2(h)}:${pad2(m)}`;
  if (kind === "daily") return fill(t("schedulesDaily"), { time: hhmm, zone });
  if (kind === "weekly") {
    const days = [...new Set(weekdays.filter((d) => d >= 0 && d <= 6))].sort((a, b) => a - b);
    if (!days.length) return null;
    return fill(t("schedulesWeekly"), { days: joinWeekdayNames(days, t), time: hhmm, zone });
  }
  if (kind === "monthly") {
    if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) return null;
    return fill(t("schedulesMonthly"), { day: dayOfMonth, time: hhmm, zone });
  }
  return null;
}

type ScheduleSort = "newest" | "oldest" | "target" | "status";
type DeliveryFilter = "any" | "active" | "failed";
type MediaFilter = "any" | "with" | "without";

interface ScheduleFilters {
  type: "any" | "recurring" | "once";
  delivery: DeliveryFilter;
  media: MediaFilter;
}

const EMPTY_SCHEDULE_FILTERS: ScheduleFilters = { type: "any", delivery: "any", media: "any" };

/** The name a target is best known by, or its phone/JID when there is none. */
function scheduleTarget(s: ScheduleItem): string {
  return (
    personName(s.savedName) ||
    personName(s.pushName) ||
    personName(s.targetLabel) ||
    s.targetPhone ||
    s.phone ||
    s.targetJid
  );
}

function matchesSchedule(s: ScheduleItem, query: string, filters: ScheduleFilters): boolean {
  const needle = query.trim().toLowerCase();
  if (needle) {
    const haystack = [
      s.message,
      s.targetLabel,
      s.savedName,
      s.pushName,
      s.phone,
      s.targetPhone,
      s.when,
      s.whenAr,
      ...(s.whenByLocale ? Object.values(s.whenByLocale) : []),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  if (filters.type !== "any" && s.type !== filters.type) return false;
  if (filters.delivery === "failed" && s.lastDeliveryStatus !== "failed") return false;
  if (filters.delivery === "active" && s.lastDeliveryStatus === "failed") return false;
  if (filters.media === "with" && !s.media) return false;
  if (filters.media === "without" && s.media) return false;
  return true;
}

function sortSchedules(list: ScheduleItem[], sort: ScheduleSort, language: string): ScheduleItem[] {
  const items = [...list];
  const byTarget = (a: ScheduleItem, b: ScheduleItem) =>
    scheduleTarget(a).localeCompare(scheduleTarget(b), language, { sensitivity: "base" });
  if (sort === "oldest") {
    items.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || byTarget(a, b));
  } else if (sort === "target") {
    items.sort(byTarget);
  } else if (sort === "status") {
    const rank = (s: ScheduleItem) => (s.lastDeliveryStatus === "failed" ? 0 : 1);
    items.sort(
      (a, b) => rank(a) - rank(b) || (b.createdAt ?? 0) - (a.createdAt ?? 0) || byTarget(a, b),
    );
  } else {
    items.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || byTarget(a, b));
  }
  return items;
}

interface SchedulesViewProps {
  isConnected?: boolean;
  onNavigate?: (view: ViewTab) => void;
}

export const SchedulesView: React.FC<SchedulesViewProps> = ({
  isConnected = false,
  onNavigate,
}) => {
  const { t, language } = useI18n();
  const { toast } = useToast();
  const [schedules, setSchedules] = useState<ScheduleItem[]>([]);
  const [timezone, setTimezone] = useState("UTC");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ScheduleSort>("newest");
  const [filters, setFilters] = useState<ScheduleFilters>(EMPTY_SCHEDULE_FILTERS);

  // Recipients state
  const [recipients, setRecipients] = useState<RecipientItem[]>([]);
  const [loadingRecipients, setLoadingRecipients] = useState(false);
  const [selectedRecipient, setSelectedRecipient] = useState<RecipientItem | null>(null);
  const [searchRecipient, setSearchRecipient] = useState("");

  // New schedule modal state
  const [showAddModal, setShowAddModal] = useState(false);
  const [message, setMessage] = useState("");
  const [scheduleType, setScheduleType] = useState<"recurring" | "once">("recurring");
  const [repeatKind, setRepeatKind] = useState<RepeatKind>("daily");
  const [sendTime, setSendTime] = useState("09:00");
  const [weekdays, setWeekdays] = useState<number[]>([1]);
  const [dayOfMonth, setDayOfMonth] = useState(1);
  const [everyHours, setEveryHours] = useState(1);
  const [hourlyMinute, setHourlyMinute] = useState(0);
  const [oneOffTime, setOneOffTime] = useState("");
  const [creating, setCreating] = useState(false);

  // Optional media that travels with the scheduled message
  const [scheduleMedia, setScheduleMedia] = useState<File | null>(null);
  const [scheduleMediaHost, setScheduleMediaHost] = useState<HostSource | null>(null);
  const mediaInputRef = useRef<HTMLInputElement>(null);

  // Row details modal
  const [detailSchedule, setDetailSchedule] = useState<ScheduleItem | null>(null);

  const MAX_SCHEDULES = 3;
  const MEDIA_MAX_BYTES = 20 * 1024 * 1024;
  const MEDIA_MAX_MB = 20;
  const isLimitReached = schedules.length >= MAX_SCHEDULES;

  const recurrencePreview = useMemo(
    () =>
      previewRecurrence(
        repeatKind,
        sendTime,
        weekdays,
        dayOfMonth,
        everyHours,
        hourlyMinute,
        timezone,
        t,
      ),
    [repeatKind, sendTime, weekdays, dayOfMonth, everyHours, hourlyMinute, timezone, t],
  );

  const loadSchedules = async () => {
    setLoading(true);
    try {
      const res = await api.getSchedules();
      if (res?.schedules) {
        setSchedules(res.schedules);
        if (res.timezone) setTimezone(res.timezone);
      }
      setError(null);
    } catch (err: any) {
      setError(err.message);
      toast(err.message, "error");
    } finally {
      setLoading(false);
    }
  };

  const loadRecipients = async () => {
    setLoadingRecipients(true);
    try {
      const res = await api.getRecipients();
      if (res?.recipients) {
        setRecipients(res.recipients);
      }
    } catch {
      // silently handle, user can retry
    } finally {
      setLoadingRecipients(false);
    }
  };

  useEffect(() => {
    loadSchedules();
    if (isConnected) {
      loadRecipients();
    }
  }, [isConnected, reloadToken]);

  const visible = useMemo(
    () =>
      sortSchedules(
        schedules.filter((s) => matchesSchedule(s, query, filters)),
        sort,
        language,
      ),
    [schedules, query, filters, sort, language],
  );

  const resetKey = `${query}|${sort}|${filters.type}|${filters.delivery}|${filters.media}`;
  const { page, pageCount, pageItems, setPage, total } = usePagination(visible, 20, resetKey);

  const activeFilters =
    (filters.type !== "any" ? 1 : 0) +
    (filters.delivery !== "any" ? 1 : 0) +
    (filters.media !== "any" ? 1 : 0);

  const clearFilters = () => {
    setQuery("");
    setFilters(EMPTY_SCHEDULE_FILTERS);
  };

  const handleDelete = async (id: string) => {
    try {
      await api.deleteSchedule(id);
      toast(t("savedSuccessfully"), "success");
      setSchedules((prev) => prev.filter((s) => s.id !== id));
    } catch (err: any) {
      toast(err.message, "error");
    }
  };

  const handleRetry = async (id: string) => {
    if (!isConnected) {
      toast(t("schedulesRetryDisconnected"), "warning");
      return;
    }
    try {
      await api.retrySchedule(id);
      toast(t("schedulesRetryTriggered"), "info");
      loadSchedules();
    } catch (err: any) {
      toast(err.message, "error");
    }
  };

  const handlePickPhoneContact = async () => {
    const host = (window as { LevixHost?: { pickContact?: () => void } }).LevixHost;
    if (!host?.pickContact) {
      toast(t("schedulesPhoneBookAndroid"), "info");
      return;
    }
    const picked = await new Promise<{ name: string; phone: string } | null>((resolve) => {
      const onPicked = (ev: Event) => {
        window.removeEventListener("levix-contact", onPicked);
        const detail = (ev as CustomEvent).detail as { name?: string; phone?: string } | null;
        if (!detail?.phone) {
          resolve(null);
          return;
        }
        resolve({ name: String(detail.name || ""), phone: String(detail.phone) });
      };
      window.addEventListener("levix-contact", onPicked);
      try {
        host.pickContact?.();
      } catch {
        window.removeEventListener("levix-contact", onPicked);
        resolve(null);
      }
    });
    if (!picked) return;
    const jid = digitsToWhatsAppJid(picked.phone);
    if (!jid) {
      toast(t("schedulesInvalidNumber"), "error");
      return;
    }
    const phone = `+${jid.split("@")[0]}`;
    const saved = personName(picked.name);
    setSelectedRecipient({
      id: jid,
      name: saved || phone,
      savedName: saved,
      pushName: null,
      phone,
      type: "contact",
    });
  };

  const resetForm = () => {
    setSelectedRecipient(null);
    setSearchRecipient("");
    setMessage("");
    setScheduleType("recurring");
    setRepeatKind("daily");
    setSendTime("09:00");
    setWeekdays([1]);
    setDayOfMonth(1);
    setEveryHours(1);
    setHourlyMinute(0);
    setOneOffTime("");
    setScheduleMedia(null);
    setScheduleMediaHost(null);
  };

  const clearScheduleMedia = () => {
    setScheduleMedia(null);
    setScheduleMediaHost(null);
  };

  const pickHostMedia = async () => {
    try {
      const picked = await pickHostFile();
      if (!picked) return;
      if (picked.size > MEDIA_MAX_BYTES) {
        toast(t("feedbackFileTooLarge").replace("{max}", String(MEDIA_MAX_MB)), "error");
        return;
      }
      setScheduleMediaHost(picked);
    } catch (err: any) {
      toast(err?.message || "Could not attach the file", "error");
    }
  };

  const handleOpenAddModal = () => {
    if (!isConnected) {
      toast(t("schedulesNeedConnection"), "warning");
      return;
    }
    if (isLimitReached) {
      toast(t("maxSchedulesReached"), "warning");
      return;
    }
    resetForm();
    setShowAddModal(true);
    if (!recipients.length) loadRecipients();
  };

  const toggleWeekday = (day: number) => {
    setWeekdays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort((a, b) => a - b),
    );
  };

  const handleCreateSchedule = async () => {
    if (!selectedRecipient) {
      toast(t("schedulesSelectRecipient"), "warning");
      return;
    }
    if (!message.trim() && !scheduleMedia && !scheduleMediaHost) {
      toast(t("schedulesMessageOrFile"), "warning");
      return;
    }

    if (scheduleType === "once" && (!oneOffTime || new Date(oneOffTime).getTime() <= Date.now())) {
      toast(t("schedulesFutureTime"), "warning");
      return;
    }

    if (scheduleType === "recurring" && repeatKind === "weekly" && weekdays.length === 0) {
      toast(t("weekdayRequired"), "warning");
      return;
    }

    setCreating(true);
    const payload: Record<string, unknown> = {
      targetJid: selectedRecipient.id,
      message: message.trim(),
      type: scheduleType,
    };

    if (selectedRecipient.type === "contact") {
      const targetName =
        personName(selectedRecipient.savedName) || personName(selectedRecipient.name);
      if (targetName && targetName !== selectedRecipient.phone) {
        payload.targetName = targetName;
      }
    }

    if (scheduleType === "recurring") {
      const recurrence: Record<string, unknown> = { kind: repeatKind };
      if (repeatKind === "hourly") {
        recurrence.everyHours = everyHours;
        recurrence.time = `00:${pad2(hourlyMinute)}`;
      } else {
        recurrence.time = sendTime;
        if (repeatKind === "weekly") recurrence.weekdays = weekdays;
        if (repeatKind === "monthly") recurrence.dayOfMonth = dayOfMonth;
      }
      payload.recurrence = recurrence;
    } else {
      payload.scheduledTime = new Date(oneOffTime).getTime();
    }

    try {
      // Multipart fields arrive as text parts: plain strings, except the
      // structured recurrence object which the backend JSON-parses.
      const fields: Record<string, string> = {};
      for (const [key, value] of Object.entries(payload)) {
        fields[key] = key === "recurrence" ? JSON.stringify(value) : String(value);
      }
      if (scheduleMediaHost) {
        // Android host: the native bridge streams the file; the fields ride
        // along as text parts of the same multipart body.
        await uploadHostForm<{ success: boolean }>(
          "/dashboard/api/schedules",
          fields,
          scheduleMediaHost.token,
          MEDIA_MAX_BYTES + 1024 * 1024,
        );
      } else if (scheduleMedia) {
        await api.postMultipart("/schedules", fields, scheduleMedia);
      } else {
        await api.createSchedule(payload);
      }
      toast(t("savedSuccessfully"), "success");
      setShowAddModal(false);
      resetForm();
      loadSchedules();
    } catch (err: any) {
      toast(err.message, "error");
    } finally {
      setCreating(false);
    }
  };

  const filteredRecipients = recipients.filter((r) => {
    const q = searchRecipient.toLowerCase().trim();
    if (!q) return true;
    return (
      r.name.toLowerCase().includes(q) ||
      Boolean(r.savedName?.toLowerCase().includes(q)) ||
      Boolean(r.pushName?.toLowerCase().includes(q)) ||
      Boolean(r.phone?.toLowerCase().includes(q))
    );
  });

  const renderContactLines = (
    item: {
      type?: string;
      savedName?: string | null;
      pushName?: string | null;
      name?: string | null;
      phone?: string | null;
      targetLabel?: string | null;
      targetKind?: string | null;
      targetPhone?: string | null;
      targetJid?: string;
    },
    titleClass: string,
    showIcon = true,
  ) => {
    const isGroup =
      item.type === "group" ||
      item.targetKind === "group" ||
      Boolean(item.targetJid?.includes("@g.us"));
    if (isGroup) {
      const label =
        personName(item.name) ||
        (personName(item.targetLabel) && item.targetLabel !== "Group" ? item.targetLabel : null) ||
        t("groupFallback");
      return (
        <span className="inline-flex items-center gap-1.5 text-brand-cyan min-w-0">
          {showIcon && <Users size={14} className="shrink-0" />}
          <span className={`${titleClass} truncate`}>{label}</span>
        </span>
      );
    }
    const phone = item.phone || item.targetPhone || null;
    const title = contactTitle(item, t("contactFallback"));
    const showPhone = Boolean(phone && title !== phone);
    return (
      <span className="inline-flex items-center gap-1.5 text-ok min-w-0">
        {showIcon && <User size={14} className="shrink-0" />}
        <span className="min-w-0">
          <span className={`${titleClass} truncate block`}>{title}</span>
          {showPhone && (
            <span className="block text-[11px] text-muted font-mono" dir="ltr">
              {phone}
            </span>
          )}
        </span>
      </span>
    );
  };

  return (
    <div className="flex flex-col gap-5 sm:gap-6">
      {/* Offline Alert Banner */}
      {!isConnected && (
        <div className="rounded-2xl border border-warn/30 bg-warn/10 p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <div className="w-10 h-10 rounded-xl bg-warn/20 text-warn flex items-center justify-center shrink-0">
              <AlertCircle size={22} />
            </div>
            <div>
              <h3 className="text-sm sm:text-base font-bold text-warn">
                {t("schedulesDisconnectedTitle")}
              </h3>
              <p className="text-xs sm:text-sm text-text-main/80 mt-0.5">
                {t("schedulesDisconnectedBody")}
              </p>
            </div>
          </div>
          <Button variant="primary" className="shrink-0" onClick={() => onNavigate?.("connection")}>
            {t("schedulesGoToConnection")}
          </Button>
        </div>
      )}

      <PageHeader
        icon={<Calendar size={24} />}
        title={
          <span className="inline-flex flex-wrap items-center gap-2">
            {t("schedules")}
            <Badge tone={isLimitReached ? "warn" : "info"}>
              {schedules.length} / {MAX_SCHEDULES} {t("scheduledCount")}
            </Badge>
          </span>
        }
        description={
          <>
            {t("timezoneLabel")}:{" "}
            <code className="rounded border border-line bg-bg-soft px-1.5 py-0.5 font-mono font-semibold text-brand-cyan">
              {timezone}
            </code>{" "}
            · {t("headerSubtitle")}
          </>
        }
        actions={
          schedules.length > 0 ? (
            <Button
              variant="primary"
              size="lg"
              className="w-full sm:w-auto"
              icon={<Plus size={18} />}
              onClick={handleOpenAddModal}
              disabled={isLimitReached || !isConnected}
            >
              {!isConnected
                ? t("schedulesConnectionRequired")
                : isLimitReached
                  ? t("limitReached")
                  : t("scheduleNewMsg")}
            </Button>
          ) : undefined
        }
      />

      {!loading && !error && schedules.length > 0 && (
        <Toolbar data-tour="schedules-list">
          <Input
            type="search"
            name="schedule-search"
            autoComplete="off"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("searchSchedules")}
            aria-label={t("searchSchedules")}
            className="min-w-48 flex-1"
          />
          <SortMenu
            label={t("sort")}
            value={sort}
            onChange={setSort}
            options={[
              { value: "newest", label: t("sortNewest") },
              { value: "oldest", label: t("sortOldest") },
              { value: "target", label: t("thTarget") },
              { value: "status", label: t("thDelivery") },
            ]}
          />
          <FilterButton
            label={t("filter")}
            resetLabel={t("reset")}
            activeCount={activeFilters}
            onReset={() => setFilters(EMPTY_SCHEDULE_FILTERS)}
          >
            <RadioGroup
              label={t("thType")}
              name="schedule-type-filter"
              value={filters.type}
              onChange={(type) => setFilters((prev) => ({ ...prev, type }))}
              options={[
                { value: "any", label: t("statusAny") },
                { value: "recurring", label: t("typeRecurring") },
                { value: "once", label: t("typeOnce") },
              ]}
            />
            <RadioGroup
              label={t("thDelivery")}
              name="schedule-delivery-filter"
              value={filters.delivery}
              onChange={(delivery) => setFilters((prev) => ({ ...prev, delivery }))}
              options={[
                { value: "any", label: t("statusAny") },
                { value: "active", label: t("deliveryActive") },
                { value: "failed", label: t("deliveryFailed") },
              ]}
            />
            <RadioGroup
              label={t("thMedia")}
              name="schedule-media-filter"
              value={filters.media}
              onChange={(media) => setFilters((prev) => ({ ...prev, media }))}
              options={[
                { value: "any", label: t("statusAny") },
                { value: "with", label: t("mediaWith") },
                { value: "without", label: t("mediaWithout") },
              ]}
            />
          </FilterButton>
        </Toolbar>
      )}

      {loading && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2" aria-busy="true">
          {["s1", "s2", "s3", "s4"].map((id) => (
            <Card key={id} className="flex flex-col gap-3">
              <div className="flex items-center gap-3">
                <Skeleton className="size-10 rounded-xl" />
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-3 w-24" />
                </div>
              </div>
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-6 w-28" />
            </Card>
          ))}
        </div>
      )}

      {!loading && error && (
        <EmptyState
          kind="error"
          icon={<AlertCircle size={28} />}
          description={error}
          action={
            <Button
              variant="secondary"
              icon={<RotateCcw size={16} />}
              onClick={() => setReloadToken((value) => value + 1)}
            >
              {t("retryLoad")}
            </Button>
          }
        />
      )}

      {!loading && !error && schedules.length === 0 && (
        <EmptyState
          kind="empty"
          icon={<Calendar size={28} />}
          text={t("noSchedules")}
          action={
            <Button
              variant="primary"
              icon={<Plus size={16} />}
              onClick={handleOpenAddModal}
              disabled={!isConnected || isLimitReached}
            >
              {t("scheduleNewMsg")}
            </Button>
          }
        />
      )}

      {!loading && !error && schedules.length > 0 && visible.length === 0 && (
        <EmptyState
          kind="no-results"
          action={
            <Button variant="secondary" onClick={clearFilters}>
              {t("clearFilters")}
            </Button>
          }
        />
      )}

      {!loading && !error && visible.length > 0 && (
        <>
          <div className="grid grid-cols-1 gap-3 md:hidden">
            {pageItems.map((s) => (
              <Card key={s.id} className="flex flex-col gap-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 items-start gap-3">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand-blue/10 text-brand-cyan">
                      {s.targetKind === "group" || s.targetJid.includes("@g.us") ? (
                        <Users size={18} />
                      ) : (
                        <User size={18} />
                      )}
                    </div>
                    <div className="min-w-0">
                      <bdi>
                        {renderContactLines(
                          {
                            targetJid: s.targetJid,
                            targetKind: s.targetKind,
                            targetLabel: s.targetLabel,
                            targetPhone: s.targetPhone,
                            savedName: s.savedName,
                            pushName: s.pushName,
                            phone: s.phone,
                          },
                          "text-sm font-bold text-text-main",
                          false,
                        )}
                      </bdi>
                      <p className="mt-0.5 truncate text-xs text-muted" dir="auto">
                        {scheduleWhen(s, language) || s.cronString || "—"}
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {s.lastDeliveryStatus === "failed" && (
                      <IconButton
                        label={t("retryDelivery")}
                        icon={<RefreshCw size={16} />}
                        onClick={() => {
                          void handleRetry(s.id);
                        }}
                      />
                    )}
                    <IconButton
                      label={t("scheduleDetails")}
                      variant="ghost"
                      icon={<Eye size={16} />}
                      onClick={() => setDetailSchedule(s)}
                    />
                    <OverflowMenu label={t("moreActions")}>
                      <MenuItem
                        danger
                        icon={<Trash2 size={16} />}
                        onSelect={() => {
                          void handleDelete(s.id);
                        }}
                      >
                        {t("delete")}
                      </MenuItem>
                    </OverflowMenu>
                  </div>
                </div>

                <UserText lines={2} className="text-sm text-text-main">
                  {s.media ? `${s.media.fileName || ""} ${s.message}`.trim() : s.message || "—"}
                </UserText>

                <div className="flex flex-wrap items-center gap-1.5">
                  {s.media && (
                    <Badge tone="info">
                      <Paperclip size={12} />
                      {mediaKindLabel(t, s.media.kind)}
                    </Badge>
                  )}
                  <Badge tone={s.type === "recurring" ? "info" : "neutral"}>
                    {s.type === "recurring" ? t("typeRecurring") : t("typeOnce")}
                  </Badge>
                  <StatusPill
                    tone={
                      s.lastDeliveryStatus === "failed"
                        ? "danger"
                        : s.status === "active"
                          ? "ok"
                          : "neutral"
                    }
                  >
                    {s.lastDeliveryStatus === "failed" ? (
                      <AlertCircle size={13} />
                    ) : (
                      <CheckCircle2 size={13} />
                    )}
                    <span>
                      {s.lastDeliveryStatus === "failed"
                        ? t("deliveryFailed")
                        : s.status === "active"
                          ? t("deliveryActive")
                          : s.status}
                    </span>
                  </StatusPill>
                </div>
              </Card>
            ))}
          </div>

          <Card padded={false} className="hidden overflow-hidden md:block">
            <div className="overflow-x-auto">
              <table className="w-full table-fixed border-collapse text-start text-sm">
                <thead>
                  <tr className="bg-panel-raised border-b border-line text-xs font-bold text-muted uppercase tracking-wider">
                    <th className="w-[22%] px-4 py-4 text-start">{t("thTarget")}</th>
                    <th className="w-[30%] px-4 py-4 text-start">{t("thMessage")}</th>
                    <th className="w-[16%] px-4 py-4 text-start">{t("thSchedule")}</th>
                    <th className="w-[9%] px-4 py-4 text-start">{t("thType")}</th>
                    <th className="w-[13%] px-4 py-4 text-start">{t("thDelivery")}</th>
                    <th className="w-[10%] px-4 py-4 text-center">{t("thActions")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line/40">
                  {pageItems.map((s) => (
                    <tr
                      key={s.id}
                      onClick={() => setDetailSchedule(s)}
                      className="cursor-pointer transition-colors hover:bg-panel-hover/50"
                    >
                      <td className="px-4 py-4 text-xs text-text-main">
                        <bdi>
                          {renderContactLines(
                            {
                              targetJid: s.targetJid,
                              targetKind: s.targetKind,
                              targetLabel: s.targetLabel,
                              targetPhone: s.targetPhone,
                              savedName: s.savedName,
                              pushName: s.pushName,
                              phone: s.phone,
                            },
                            "font-semibold",
                          )}
                        </bdi>
                      </td>
                      <td className="px-4 py-4 text-xs text-text-main sm:text-sm">
                        <UserText lines={2}>
                          {s.media
                            ? `${s.media.fileName || ""} ${s.message}`.trim()
                            : s.message || "—"}
                        </UserText>
                      </td>
                      <td className="px-4 py-4 text-xs text-muted">
                        <span dir="auto">
                          {scheduleWhen(s, language) || s.cronString || "—"}
                        </span>
                      </td>
                      <td className="px-4 py-4">
                        <Badge tone={s.type === "recurring" ? "info" : "neutral"}>
                          {s.type === "recurring" ? t("typeRecurring") : t("typeOnce")}
                        </Badge>
                      </td>
                      <td className="px-4 py-4">
                        <StatusPill
                          tone={
                            s.lastDeliveryStatus === "failed"
                              ? "danger"
                              : s.status === "active"
                                ? "ok"
                                : "neutral"
                          }
                        >
                          {s.lastDeliveryStatus === "failed" ? (
                            <AlertCircle size={13} />
                          ) : (
                            <CheckCircle2 size={13} />
                          )}
                          <span>
                            {s.lastDeliveryStatus === "failed"
                              ? t("deliveryFailed")
                              : s.status === "active"
                                ? t("deliveryActive")
                                : s.status}
                          </span>
                        </StatusPill>
                      </td>
                      <td className="px-4 py-4 text-center">
                        <div
                          className="flex items-center justify-center gap-1"
                          onClick={(event) => event.stopPropagation()}
                        >
                          {s.lastDeliveryStatus === "failed" && (
                            <IconButton
                              label={t("retryDelivery")}
                              icon={<RefreshCw size={16} />}
                              onClick={() => {
                                void handleRetry(s.id);
                              }}
                            />
                          )}
                          <OverflowMenu label={t("moreActions")}>
                            <MenuItem
                              danger
                              icon={<Trash2 size={16} />}
                              onSelect={() => {
                                void handleDelete(s.id);
                              }}
                            >
                              {t("delete")}
                            </MenuItem>
                          </OverflowMenu>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Pagination page={page} pageCount={pageCount} total={total} onPageChange={setPage} />
        </>
      )}

      <Dialog
        isOpen={showAddModal}
        onClose={() => setShowAddModal(false)}
        title={t("scheduleNewMsg")}
        maxWidth="560px"
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowAddModal(false)}>
              {t("cancel")}
            </Button>
            <Button
              variant="primary"
              loading={creating}
              onClick={handleCreateSchedule}
              disabled={
                creating ||
                !selectedRecipient ||
                (!message.trim() && !scheduleMedia && !scheduleMediaHost)
              }
            >
              {creating ? t("saving") : t("scheduleAction")}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4 py-1">
          {/* Target Recipient Selector (No raw JIDs!) */}
          <div className="space-y-1.5">
            <div className="block text-xs font-bold text-text-main">
              {t("selectRecipient")} <span className="text-danger">*</span>
            </div>

            {selectedRecipient ? (
              <div className="flex items-center justify-between p-3 rounded-xl border border-brand-blue/40 bg-brand-blue/10">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="w-8 h-8 rounded-lg bg-brand-blue/20 text-brand-cyan flex items-center justify-center shrink-0">
                    {selectedRecipient.type === "group" ? <Users size={16} /> : <User size={16} />}
                  </div>
                  <div className="min-w-0">
                    {renderContactLines(
                      selectedRecipient,
                      "text-xs sm:text-sm font-bold text-text-main",
                      false,
                    )}
                  </div>
                </div>
                <IconButton
                  label={t("changeChat")}
                  variant="ghost"
                  icon={<X size={16} />}
                  onClick={() => setSelectedRecipient(null)}
                />
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <div className="relative min-w-0 flex-1">
                    <Search
                      size={16}
                      className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-muted"
                    />
                    <Input
                      type="search"
                      value={searchRecipient}
                      onChange={(e) => setSearchRecipient(e.target.value)}
                      placeholder={t("searchRecipients")}
                      aria-label={t("searchRecipients")}
                      className="ps-9"
                    />
                  </div>
                  {hasPhoneBookPicker() && (
                    <Button
                      variant="secondary"
                      size="sm"
                      className="shrink-0"
                      icon={<BookUser size={15} />}
                      onClick={handlePickPhoneContact}
                      title={t("pickPhoneContactHint")}
                    >
                      <span className="hidden sm:inline">{t("pickPhoneContact")}</span>
                    </Button>
                  )}
                </div>

                <div className="max-h-48 overflow-y-auto rounded-xl border border-line bg-panel-raised divide-y divide-line/40">
                  {loadingRecipients ? (
                    <div className="flex justify-center p-4">
                      <Spinner label={t("loading")} />
                    </div>
                  ) : filteredRecipients.length === 0 ? (
                    <EmptyState className="px-4 py-4" text={t("noRecipientsFound")} />
                  ) : (
                    filteredRecipients.map((rec) => (
                      <Button
                        key={rec.id}
                        variant="ghost"
                        onClick={() => setSelectedRecipient(rec)}
                        className="h-auto w-full justify-between gap-2 rounded-none px-2.5 py-2.5 text-start"
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <div className="w-7 h-7 rounded-lg bg-panel border border-line flex items-center justify-center shrink-0 text-muted">
                            {rec.type === "group" ? <Users size={14} /> : <User size={14} />}
                          </div>
                          <div className="min-w-0">
                            {renderContactLines(rec, "text-xs font-bold text-text-main", false)}
                          </div>
                        </div>
                        <Badge tone="neutral" className="shrink-0">
                          {rec.type === "group" ? t("groupFallback") : t("contactFallback")}
                        </Badge>
                      </Button>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>

          <Field label={t("scheduleType")} htmlFor="schedule-type">
            <Select
              id="schedule-type"
              value={scheduleType}
              onChange={(e) => setScheduleType(e.target.value as "recurring" | "once")}
            >
              <option value="recurring">{t("scheduleRecurring")}</option>
              <option value="once">{t("scheduleOnce")}</option>
            </Select>
          </Field>

          {scheduleType === "recurring" ? (
            <div className="space-y-3 rounded-xl border border-line bg-panel-raised/40 p-3.5">
              <Field label={t("repeat")} htmlFor="repeat-kind">
                <Select
                  id="repeat-kind"
                  value={repeatKind}
                  onChange={(e) => setRepeatKind(e.target.value as RepeatKind)}
                >
                  <option value="daily">{t("repeatDaily")}</option>
                  <option value="weekly">{t("repeatWeekly")}</option>
                  <option value="monthly">{t("repeatMonthly")}</option>
                  <option value="hourly">{t("repeatHourly")}</option>
                </Select>
              </Field>

              {repeatKind === "weekly" && (
                <fieldset className="space-y-1.5">
                  <legend className="block text-xs font-bold text-text-main">
                    {t("weekdays")}
                  </legend>
                  <div className="flex flex-wrap gap-1.5">
                    {WEEKDAY_KEYS.map((key, day) => {
                      const selected = weekdays.includes(day);
                      return (
                        <Button
                          key={key}
                          size="sm"
                          variant={selected ? "primary" : "secondary"}
                          aria-pressed={selected}
                          onClick={() => toggleWeekday(day)}
                        >
                          {t(key)}
                        </Button>
                      );
                    })}
                  </div>
                </fieldset>
              )}

              {repeatKind === "monthly" && (
                <Field
                  label={t("dayOfMonth")}
                  htmlFor="day-of-month"
                  description={t("monthDayHint")}
                >
                  <Input
                    id="day-of-month"
                    type="number"
                    min={1}
                    max={31}
                    inputMode="numeric"
                    value={dayOfMonth}
                    onChange={(e) => setDayOfMonth(Number(e.target.value))}
                  />
                </Field>
              )}

              {repeatKind === "hourly" ? (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label={t("everyHours")} htmlFor="every-hours">
                    <Select
                      id="every-hours"
                      value={everyHours}
                      onChange={(e) => setEveryHours(Number(e.target.value))}
                    >
                      {HOURLY_INTERVALS.map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label={t("atMinute")} htmlFor="hourly-minute">
                    <Input
                      id="hourly-minute"
                      type="number"
                      min={0}
                      max={59}
                      inputMode="numeric"
                      value={hourlyMinute}
                      onChange={(e) => setHourlyMinute(Number(e.target.value))}
                      dir="ltr"
                    />
                  </Field>
                </div>
              ) : (
                <Field
                  label={
                    <>
                      {t("sendTime")}
                      <span className="ms-1.5 font-semibold text-muted">({timezone})</span>
                    </>
                  }
                  htmlFor="send-time"
                >
                  <Input
                    id="send-time"
                    type="time"
                    value={sendTime}
                    onChange={(e) => setSendTime(e.target.value)}
                    dir="ltr"
                  />
                </Field>
              )}

              <p className="text-xs text-text-main/90 bg-bg-soft border border-line rounded-lg px-3 py-2">
                <span className="font-bold text-muted">{t("recurrencePreview")}: </span>
                <span dir="auto">{recurrencePreview || "—"}</span>
              </p>
            </div>
          ) : (
            <Field label={t("deliveryDateTime")} htmlFor="one-off-time">
              <Input
                id="one-off-time"
                type="datetime-local"
                value={oneOffTime}
                onChange={(e) => setOneOffTime(e.target.value)}
                dir="ltr"
              />
            </Field>
          )}

          <Field
            label={
              <>
                {t("messageText")}{" "}
                {!scheduleMedia && !scheduleMediaHost && <span className="text-danger">*</span>}
              </>
            }
            htmlFor="schedule-message"
          >
            <Textarea
              id="schedule-message"
              rows={3}
              placeholder={t("messagePlaceholder")}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
          </Field>

          {/* Optional media — image, video, audio or document */}
          <div className="space-y-1.5">
            <span className="block text-xs font-bold text-text-main">
              {t("scheduleAttachMedia")}
            </span>
            <div className="flex flex-wrap items-center gap-2">
              {scheduleMediaHost || scheduleMedia ? (
                <span className="inline-flex max-w-full items-center gap-2 rounded-xl border border-brand-blue/40 bg-brand-blue/10 ps-3 pe-1 text-xs text-text-main sm:text-sm">
                  <Paperclip size={14} className="shrink-0 text-brand-cyan" />
                  <span className="max-w-[220px] truncate">
                    {scheduleMediaHost?.name ?? scheduleMedia?.name}
                  </span>
                  <IconButton
                    label={t("scheduleRemoveMedia")}
                    variant="ghost"
                    icon={<X size={14} />}
                    onClick={clearScheduleMedia}
                  />
                </span>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<Paperclip size={14} className="text-brand-cyan" />}
                  onClick={() =>
                    canHostUploadForm() ? void pickHostMedia() : mediaInputRef.current?.click()
                  }
                >
                  {t("scheduleAttachMedia")}
                </Button>
              )}
              <span className="text-[11px] text-muted">
                {t("scheduleMediaHint").replace("{max}", String(MEDIA_MAX_MB))}
              </span>
            </div>
            {!canHostUploadForm() && (
              <input
                ref={mediaInputRef}
                type="file"
                className="sr-only"
                onChange={(event) => {
                  const file = event.target.files?.[0] ?? null;
                  event.target.value = "";
                  if (!file) return;
                  if (file.size > MEDIA_MAX_BYTES) {
                    toast(
                      t("feedbackFileTooLarge").replace("{max}", String(MEDIA_MAX_MB)),
                      "error",
                    );
                    return;
                  }
                  setScheduleMedia(file);
                }}
              />
            )}
          </div>
        </div>
      </Dialog>

      <Dialog
        isOpen={!!detailSchedule}
        onClose={() => setDetailSchedule(null)}
        title={t("scheduleDetails")}
        maxWidth="560px"
        footer={
          <div className="flex w-full items-center justify-between gap-2">
            {detailSchedule?.lastDeliveryStatus === "failed" ? (
              <IconButton
                label={t("retryDelivery")}
                icon={<RefreshCw size={16} />}
                onClick={() => {
                  const id = detailSchedule.id;
                  setDetailSchedule(null);
                  void handleRetry(id);
                }}
              />
            ) : (
              <span />
            )}
            <div className="flex items-center gap-2">
              <Button variant="secondary" onClick={() => setDetailSchedule(null)}>
                {t("close")}
              </Button>
              <OverflowMenu label={t("moreActions")}>
                <MenuItem
                  danger
                  icon={<Trash2 size={16} />}
                  onSelect={() => {
                    const id = detailSchedule?.id;
                    setDetailSchedule(null);
                    if (id) void handleDelete(id);
                  }}
                >
                  {t("delete")}
                </MenuItem>
              </OverflowMenu>
            </div>
          </div>
        }
      >
        {detailSchedule && (
          <div className="flex flex-col gap-3.5 py-1 text-xs sm:text-sm">
            <DetailRow label={t("thTarget")}>
              <bdi>
                {renderContactLines(
                  {
                    targetJid: detailSchedule.targetJid,
                    targetKind: detailSchedule.targetKind,
                    targetLabel: detailSchedule.targetLabel,
                    targetPhone: detailSchedule.targetPhone,
                    savedName: detailSchedule.savedName,
                    pushName: detailSchedule.pushName,
                    phone: detailSchedule.phone,
                  },
                  "font-semibold",
                  false,
                )}
              </bdi>
            </DetailRow>
            <DetailRow label={t("thMessage")}>
              {detailSchedule.message ? (
                <span className="whitespace-pre-wrap break-words">{detailSchedule.message}</span>
              ) : (
                <span className="text-muted">—</span>
              )}
            </DetailRow>
            {detailSchedule.media && (
              <DetailRow label={t("detailMedia")}>
                <span className="inline-flex items-center gap-1.5 min-w-0">
                  <Paperclip size={13} className="text-brand-cyan shrink-0" />
                  <span className="truncate">
                    {mediaKindLabel(t, detailSchedule.media.kind)}
                    {detailSchedule.media.fileName ? ` · ${detailSchedule.media.fileName}` : ""}
                  </span>
                </span>
              </DetailRow>
            )}
            <DetailRow label={t("thSchedule")}>
              <span dir="auto">
                {scheduleWhen(detailSchedule, language)}
              </span>
            </DetailRow>
            <DetailRow label={t("thType")}>
              {detailSchedule.type === "recurring" ? t("typeRecurring") : t("typeOnce")}
            </DetailRow>
            <DetailRow label={t("thDelivery")}>
              <StatusPill
                tone={
                  detailSchedule.lastDeliveryStatus === "failed"
                    ? "danger"
                    : detailSchedule.status === "active"
                      ? "ok"
                      : "neutral"
                }
              >
                {detailSchedule.lastDeliveryStatus === "failed" ? (
                  <AlertCircle size={13} />
                ) : (
                  <CheckCircle2 size={13} />
                )}
                <span>
                  {detailSchedule.lastDeliveryStatus === "failed"
                    ? t("deliveryFailed")
                    : detailSchedule.status === "active"
                      ? t("deliveryActive")
                      : detailSchedule.status}
                </span>
              </StatusPill>
            </DetailRow>
            {detailSchedule.lastRunAt && (
              <DetailRow label={t("detailLastRun")}>
                {new Date(detailSchedule.lastRunAt).toLocaleString(
                  intlLocale(language, { ar: "ar-EG", en: "en-GB" }),
                )}
              </DetailRow>
            )}
            {detailSchedule.lastError && (
              <DetailRow label={t("detailError")}>
                <span className="text-danger break-words" dir="auto">
                  {detailSchedule.lastError}
                </span>
              </DetailRow>
            )}
            {detailSchedule.createdAt && (
              <DetailRow label={t("detailCreated")}>
                {new Date(detailSchedule.createdAt).toLocaleString(
                  intlLocale(language, { ar: "ar-EG", en: "en-GB" }),
                )}
              </DetailRow>
            )}
          </div>
        )}
      </Dialog>
    </div>
  );
};

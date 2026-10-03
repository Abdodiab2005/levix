// file: frontend/src/views/SchedulesView.tsx

import {
  AlertCircle,
  BookUser,
  Calendar,
  CheckCircle2,
  Paperclip,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  User,
  Users,
  X,
} from "lucide-react";
import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import { Modal } from "../components/Modal";
import type { ViewTab } from "../components/Sidebar";
import { useToast } from "../components/Toasts";
import { useI18n } from "../context/I18nContext";
import type { ScheduleItem } from "../types";
import {
  canPickHostSource,
  type HostSource,
  pickHostSource,
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

const WEEKDAY_FULL_EN = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const WEEKDAY_FULL_AR = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
const HOURLY_INTERVALS = [1, 2, 3, 4, 6, 8, 12];

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

function joinWeekdayNames(days: number[], ar: boolean) {
  const names = days.map((day) => (ar ? WEEKDAY_FULL_AR[day] : WEEKDAY_FULL_EN[day]));
  if (ar) return names.join(" و");
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function arabicEveryHours(n: number) {
  if (n === 1) return "كل ساعة";
  if (n === 2) return "كل ساعتين";
  if (n >= 3 && n <= 10) return `كل ${n} ساعات`;
  return `كل ${n} ساعة`;
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
  ar: boolean,
): string | null {
  const timeOk = /^\d{1,2}:\d{2}$/.test(time);
  const zone = timezone || "UTC";
  if (kind === "hourly") {
    if (!Number.isInteger(everyHours) || !HOURLY_INTERVALS.includes(everyHours)) return null;
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
    if (ar) {
      const body = `${arabicEveryHours(everyHours)} عند الدقيقة ${minute}`;
      return `${body} (${zone})`;
    }
    const body =
      everyHours === 1
        ? `Every hour at minute ${minute}`
        : `Every ${everyHours} hours at minute ${minute}`;
    return `${body} (${zone})`;
  }
  if (!timeOk) return null;
  const [h, m] = time.split(":").map(Number);
  if (h > 23 || m > 59) return null;
  const hhmm = `${pad2(h)}:${pad2(m)}`;
  if (kind === "daily") {
    return ar ? `يومياً الساعة ${hhmm} (${zone})` : `Daily at ${hhmm} (${zone})`;
  }
  if (kind === "weekly") {
    const days = [...new Set(weekdays.filter((d) => d >= 0 && d <= 6))].sort((a, b) => a - b);
    if (!days.length) return null;
    const names = joinWeekdayNames(days, ar);
    return ar ? `كل يوم ${names} الساعة ${hhmm} (${zone})` : `Every ${names} at ${hhmm} (${zone})`;
  }
  if (kind === "monthly") {
    if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) return null;
    return ar
      ? `كل شهر في اليوم ${dayOfMonth} الساعة ${hhmm} (${zone})`
      : `Every month on day ${dayOfMonth} at ${hhmm} (${zone})`;
  }
  return null;
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
  const ar = language === "ar";

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
        ar,
      ),
    [repeatKind, sendTime, weekdays, dayOfMonth, everyHours, hourlyMinute, timezone, ar],
  );

  const loadSchedules = async () => {
    try {
      const res = await api.getSchedules();
      if (res?.schedules) {
        setSchedules(res.schedules);
        if (res.timezone) setTimezone(res.timezone);
      }
    } catch (err: any) {
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
  }, [isConnected]);

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
      toast(
        language === "ar"
          ? "واتساب غير متصل، يرجى بدء الاتصال أولاً"
          : "WhatsApp is disconnected, please connect first",
        "warning",
      );
      return;
    }
    try {
      await api.retrySchedule(id);
      toast(language === "ar" ? "تمت إعادة محاولة الإرسال" : "Delivery retry triggered", "info");
      loadSchedules();
    } catch (err: any) {
      toast(err.message, "error");
    }
  };

  const handlePickPhoneContact = async () => {
    const host = (window as { LevixHost?: { pickContact?: () => void } }).LevixHost;
    if (!host?.pickContact) {
      toast(
        language === "ar"
          ? "دليل الهاتف متاح من تطبيق أندرويد فقط"
          : "Phone book is available in the Android app",
        "info",
      );
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
      toast(
        language === "ar"
          ? "الرقم غير صالح. استخدم رقمًا مع كود الدولة."
          : "That number is not valid. Use a number with country code.",
        "error",
      );
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
      const picked = await pickHostSource();
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
      toast(
        language === "ar"
          ? "يلزم اتصال واتساب لجدولة الرسائل"
          : "Active WhatsApp connection is required to schedule messages",
        "warning",
      );
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
      toast(
        language === "ar" ? "يرجى اختيار المحادثة المستهدفة" : "Please select a recipient chat",
        "warning",
      );
      return;
    }
    if (!message.trim() && !scheduleMedia && !scheduleMediaHost) {
      toast(
        language === "ar"
          ? "يرجى كتابة نص الرسالة أو إرفاق ملف"
          : "Please write the message text or attach a file",
        "warning",
      );
      return;
    }

    if (scheduleType === "once" && (!oneOffTime || new Date(oneOffTime).getTime() <= Date.now())) {
      toast(
        language === "ar"
          ? "يرجى تحديد وقت وتاريخ مستقبلي صالح"
          : "Please select a valid future date and time",
        "warning",
      );
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
                {language === "ar" ? "واتساب غير متصل حالياً" : "WhatsApp is Disconnected"}
              </h3>
              <p className="text-xs sm:text-sm text-text-main/80 mt-0.5">
                {language === "ar"
                  ? "يلزم وجود اتصال نشط بواتساب لجدولة الرسائل وإرسالها واختيار جهات الاتصال."
                  : "An active WhatsApp connection is required to schedule messages, fetch chats, and deliver automated jobs."}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => onNavigate?.("connection")}
            className="inline-flex items-center justify-center gap-2 px-4 h-11 rounded-xl bg-warn hover:bg-warn/90 text-bg font-bold text-xs sm:text-sm shadow-sm transition-all shrink-0"
          >
            <span>{language === "ar" ? "الذهاب للاتصال" : "Go to Connection"}</span>
          </button>
        </div>
      )}

      {/* Header Card */}
      <div className="rounded-2xl border border-line bg-panel p-4 sm:p-6 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3.5">
          <div className="w-12 h-12 rounded-2xl bg-brand-cyan/10 text-brand-cyan flex items-center justify-center shrink-0">
            <Calendar size={24} />
          </div>
          <div>
            <div className="flex items-center gap-3 flex-wrap">
              <h2 className="text-lg md:text-xl font-bold text-text-main">{t("schedules")}</h2>
              <span
                className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold border ${
                  isLimitReached
                    ? "bg-warn/15 text-warn border-warn/30"
                    : "bg-brand-cyan/10 text-brand-cyan border-brand-cyan/20"
                }`}
              >
                {schedules.length} / {MAX_SCHEDULES} {t("scheduledCount")}
              </span>
            </div>
            <p className="text-xs md:text-sm text-muted mt-1">
              {t("timezoneLabel")}:{" "}
              <code className="text-brand-cyan font-mono font-semibold px-1.5 py-0.5 rounded bg-bg-soft border border-line">
                {timezone}
              </code>{" "}
              · {t("headerSubtitle")}
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={handleOpenAddModal}
          disabled={isLimitReached || !isConnected}
          className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-5 h-12 sm:h-11 rounded-xl bg-brand-blue hover:bg-brand-blue/90 text-white font-bold text-xs sm:text-sm shadow-md shadow-brand-blue/20 transition-all focus-visible:ring-2 focus-visible:ring-brand-blue/50 shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Plus size={18} />
          <span>
            {!isConnected
              ? language === "ar"
                ? "يلزم اتصال واتساب"
                : "Connection Required"
              : isLimitReached
                ? t("limitReached")
                : t("scheduleNewMsg")}
          </span>
        </button>
      </div>

      {/* Table Container */}
      <div className="rounded-2xl border border-line bg-panel overflow-hidden shadow-sm overflow-x-auto">
        <table className="w-full min-w-[680px] text-start border-collapse text-sm">
          <thead>
            <tr className="bg-panel-raised border-b border-line text-xs font-bold text-muted uppercase tracking-wider">
              <th className="px-5 py-4 text-start">{t("thTarget")}</th>
              <th className="px-5 py-4 text-start">{t("thMessage")}</th>
              <th className="px-5 py-4 text-start">{t("thSchedule")}</th>
              <th className="px-5 py-4 text-start">{t("thType")}</th>
              <th className="px-5 py-4 text-start">{t("thDelivery")}</th>
              <th className="px-5 py-4 text-center">{t("thActions")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line/40">
            {loading ? (
              <tr>
                <td colSpan={6} className="text-center py-16 text-muted">
                  <div className="flex flex-col items-center justify-center gap-2">
                    <div className="w-6 h-6 border-2 border-brand-cyan border-t-transparent rounded-full animate-spin" />
                    <span className="text-xs">{t("loading")}</span>
                  </div>
                </td>
              </tr>
            ) : schedules.length === 0 ? (
              <tr>
                <td colSpan={6} className="text-center py-16 text-muted text-xs sm:text-sm">
                  <div className="flex flex-col items-center justify-center gap-2">
                    <Calendar size={28} className="text-muted/40" />
                    <span>{t("noSchedules")}</span>
                  </div>
                </td>
              </tr>
            ) : (
              schedules.map((s) => (
                <tr
                  key={s.id}
                  onClick={() => setDetailSchedule(s)}
                  className="cursor-pointer hover:bg-panel-hover/50 transition-colors"
                >
                  <td className="px-5 py-4 text-xs text-text-main">
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
                        "font-semibold max-w-[12rem]",
                      )}
                    </bdi>
                  </td>
                  <td className="px-5 py-4 max-w-xs text-text-main truncate text-xs sm:text-sm">
                    {s.media && <Paperclip size={12} className="inline me-1 text-brand-cyan" />}
                    {s.message || (s.media?.fileName ? s.media.fileName : "—")}
                  </td>
                  <td className="px-5 py-4 text-xs text-muted">
                    {ar ? s.whenAr || s.when : s.when || s.cronString || "—"}
                  </td>
                  <td className="px-5 py-4">
                    <span
                      className={`inline-flex px-2.5 py-0.5 rounded-lg text-xs font-semibold ${
                        s.type === "recurring"
                          ? "bg-brand-blue/10 text-brand-cyan"
                          : "bg-purple-500/10 text-purple-400"
                      }`}
                    >
                      {s.type === "recurring" ? t("typeRecurring") : t("typeOnce")}
                    </span>
                  </td>
                  <td className="px-5 py-4">
                    <span
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold ${
                        s.lastDeliveryStatus === "failed"
                          ? "bg-danger/10 text-danger border border-danger/25"
                          : s.status === "active"
                            ? "bg-ok/10 text-ok border border-ok/25"
                            : "bg-muted/10 text-muted"
                      }`}
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
                    </span>
                  </td>
                  <td className="px-5 py-4 text-center">
                    <div className="flex items-center justify-center gap-2">
                      {s.lastDeliveryStatus === "failed" && (
                        <button
                          type="button"
                          onClick={() => handleRetry(s.id)}
                          className="inline-flex items-center justify-center w-8 h-8 rounded-lg border border-line bg-panel-raised hover:bg-panel-hover text-brand-cyan transition-colors"
                          title="Retry delivery"
                        >
                          <RefreshCw size={14} />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => handleDelete(s.id)}
                        className="inline-flex items-center justify-center w-8 h-8 rounded-lg border border-danger/25 bg-danger/10 hover:bg-danger/20 text-danger transition-colors"
                        title={t("delete")}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Add Schedule Modal with Chat Search & Select */}
      <Modal
        isOpen={showAddModal}
        onClose={() => setShowAddModal(false)}
        title={t("scheduleNewMsg")}
        maxWidth="560px"
        footer={
          <div className="flex items-center justify-end gap-2.5 w-full">
            <button
              type="button"
              onClick={() => setShowAddModal(false)}
              className="px-4 h-10 rounded-xl border border-line bg-panel-raised hover:bg-panel-hover text-text-main font-bold text-xs sm:text-sm transition-colors"
            >
              {t("cancel")}
            </button>
            <button
              type="button"
              onClick={handleCreateSchedule}
              disabled={
                creating ||
                !selectedRecipient ||
                (!message.trim() && !scheduleMedia && !scheduleMediaHost)
              }
              className="px-5 h-10 rounded-xl bg-brand-blue hover:bg-brand-blue/90 text-white font-bold text-xs sm:text-sm shadow-md shadow-brand-blue/20 transition-all disabled:opacity-50"
            >
              {creating ? t("saving") : t("scheduleAction")}
            </button>
          </div>
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
                <button
                  type="button"
                  onClick={() => setSelectedRecipient(null)}
                  className="p-1 rounded-lg hover:bg-panel text-muted hover:text-danger transition-colors"
                  title={t("changeChat")}
                >
                  <X size={16} />
                </button>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <div className="relative flex-1">
                    <Search size={16} className="absolute start-3 top-3 text-muted" />
                    <input
                      type="search"
                      value={searchRecipient}
                      onChange={(e) => setSearchRecipient(e.target.value)}
                      placeholder={t("searchRecipients")}
                      aria-label={t("searchRecipients")}
                      className="w-full h-10 ps-9 pe-3 rounded-xl border border-line bg-panel-raised text-text-main text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                    />
                  </div>
                  {hasPhoneBookPicker() && (
                    <button
                      type="button"
                      onClick={handlePickPhoneContact}
                      className="inline-flex items-center justify-center gap-1.5 h-10 px-3 rounded-xl border border-line bg-panel-raised hover:bg-panel-hover text-text-main text-xs font-bold shrink-0"
                      title={t("pickPhoneContactHint")}
                    >
                      <BookUser size={15} />
                      <span className="hidden sm:inline">{t("pickPhoneContact")}</span>
                    </button>
                  )}
                </div>

                <div className="max-h-48 overflow-y-auto rounded-xl border border-line bg-panel-raised divide-y divide-line/40">
                  {loadingRecipients ? (
                    <div className="p-4 text-center text-xs text-muted">{t("loading")}</div>
                  ) : filteredRecipients.length === 0 ? (
                    <div className="p-4 text-center text-xs text-muted">
                      {t("noRecipientsFound")}
                    </div>
                  ) : (
                    filteredRecipients.map((rec) => (
                      <button
                        key={rec.id}
                        type="button"
                        onClick={() => setSelectedRecipient(rec)}
                        className="w-full p-2.5 flex items-center justify-between gap-2 hover:bg-panel text-start transition-colors"
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <div className="w-7 h-7 rounded-lg bg-panel border border-line flex items-center justify-center shrink-0 text-muted">
                            {rec.type === "group" ? <Users size={14} /> : <User size={14} />}
                          </div>
                          <div className="min-w-0">
                            {renderContactLines(rec, "text-xs font-bold text-text-main", false)}
                          </div>
                        </div>
                        <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-panel text-muted shrink-0">
                          {rec.type === "group" ? t("groupFallback") : t("contactFallback")}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Schedule Type */}
          <div className="space-y-1.5">
            <label htmlFor="schedule-type" className="block text-xs font-bold text-text-main">
              {t("scheduleType")}
            </label>
            <select
              id="schedule-type"
              className="w-full h-11 px-3.5 rounded-xl border border-line bg-panel-raised text-text-main text-xs sm:text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
              value={scheduleType}
              onChange={(e) => setScheduleType(e.target.value as "recurring" | "once")}
            >
              <option value="recurring">{t("scheduleRecurring")}</option>
              <option value="once">{t("scheduleOnce")}</option>
            </select>
          </div>

          {scheduleType === "recurring" ? (
            <div className="space-y-3 rounded-xl border border-line bg-panel-raised/40 p-3.5">
              <div className="space-y-1.5">
                <label htmlFor="repeat-kind" className="block text-xs font-bold text-text-main">
                  {t("repeat")}
                </label>
                <select
                  id="repeat-kind"
                  className="w-full h-11 px-3.5 rounded-xl border border-line bg-panel-raised text-text-main text-xs sm:text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                  value={repeatKind}
                  onChange={(e) => setRepeatKind(e.target.value as RepeatKind)}
                >
                  <option value="daily">{t("repeatDaily")}</option>
                  <option value="weekly">{t("repeatWeekly")}</option>
                  <option value="monthly">{t("repeatMonthly")}</option>
                  <option value="hourly">{t("repeatHourly")}</option>
                </select>
              </div>

              {repeatKind === "weekly" && (
                <fieldset className="space-y-1.5">
                  <legend className="block text-xs font-bold text-text-main">
                    {t("weekdays")}
                  </legend>
                  <div className="flex flex-wrap gap-1.5">
                    {WEEKDAY_KEYS.map((key, day) => {
                      const selected = weekdays.includes(day);
                      return (
                        <button
                          key={key}
                          type="button"
                          aria-pressed={selected}
                          onClick={() => toggleWeekday(day)}
                          className={`h-9 px-2.5 rounded-lg text-xs font-bold border transition-colors ${
                            selected
                              ? "bg-brand-blue text-white border-brand-blue"
                              : "bg-panel-raised text-text-main border-line hover:bg-panel-hover"
                          }`}
                        >
                          {t(key)}
                        </button>
                      );
                    })}
                  </div>
                </fieldset>
              )}

              {repeatKind === "monthly" && (
                <div className="space-y-1.5">
                  <label htmlFor="day-of-month" className="block text-xs font-bold text-text-main">
                    {t("dayOfMonth")}
                  </label>
                  <input
                    id="day-of-month"
                    type="number"
                    min={1}
                    max={31}
                    inputMode="numeric"
                    className="w-full h-11 px-3.5 rounded-xl border border-line bg-panel-raised text-text-main text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                    value={dayOfMonth}
                    onChange={(e) => setDayOfMonth(Number(e.target.value))}
                  />
                  <p className="text-xs text-muted">{t("monthDayHint")}</p>
                </div>
              )}

              {repeatKind === "hourly" ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <label htmlFor="every-hours" className="block text-xs font-bold text-text-main">
                      {t("everyHours")}
                    </label>
                    <select
                      id="every-hours"
                      className="w-full h-11 px-3.5 rounded-xl border border-line bg-panel-raised text-text-main text-xs sm:text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                      value={everyHours}
                      onChange={(e) => setEveryHours(Number(e.target.value))}
                    >
                      {HOURLY_INTERVALS.map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <label
                      htmlFor="hourly-minute"
                      className="block text-xs font-bold text-text-main"
                    >
                      {t("atMinute")}
                    </label>
                    <input
                      id="hourly-minute"
                      type="number"
                      min={0}
                      max={59}
                      inputMode="numeric"
                      className="w-full h-11 px-3.5 rounded-xl border border-line bg-panel-raised text-text-main text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                      value={hourlyMinute}
                      onChange={(e) => setHourlyMinute(Number(e.target.value))}
                      dir="ltr"
                    />
                  </div>
                </div>
              ) : (
                <div className="space-y-1.5">
                  <label htmlFor="send-time" className="block text-xs font-bold text-text-main">
                    {t("sendTime")}
                    <span className="ms-1.5 font-semibold text-muted">({timezone})</span>
                  </label>
                  <input
                    id="send-time"
                    type="time"
                    className="w-full h-11 px-3.5 rounded-xl border border-line bg-panel-raised text-text-main text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                    value={sendTime}
                    onChange={(e) => setSendTime(e.target.value)}
                    dir="ltr"
                  />
                </div>
              )}

              <p className="text-xs text-text-main/90 bg-bg-soft border border-line rounded-lg px-3 py-2">
                <span className="font-bold text-muted">{t("recurrencePreview")}: </span>
                <span dir="auto">{recurrencePreview || "—"}</span>
              </p>
            </div>
          ) : (
            <div className="space-y-1.5">
              <label htmlFor="one-off-time" className="block text-xs font-bold text-text-main">
                {t("deliveryDateTime")}
              </label>
              <input
                id="one-off-time"
                type="datetime-local"
                className="w-full h-11 px-3.5 rounded-xl border border-line bg-panel-raised text-text-main text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                value={oneOffTime}
                onChange={(e) => setOneOffTime(e.target.value)}
                dir="ltr"
              />
            </div>
          )}

          <div className="space-y-1.5">
            <label htmlFor="schedule-message" className="block text-xs font-bold text-text-main">
              {t("messageText")}{" "}
              {!scheduleMedia && !scheduleMediaHost && <span className="text-danger">*</span>}
            </label>
            <textarea
              id="schedule-message"
              className="w-full p-3.5 rounded-xl border border-line bg-panel-raised text-text-main text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50 resize-y min-h-[90px]"
              rows={3}
              placeholder={t("messagePlaceholder")}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
          </div>

          {/* Optional media — image, video, audio or document */}
          <div className="space-y-1.5">
            <span className="block text-xs font-bold text-text-main">
              {t("scheduleAttachMedia")}
            </span>
            <div className="flex flex-wrap items-center gap-2">
              {scheduleMediaHost || scheduleMedia ? (
                <span className="inline-flex items-center gap-2 ps-3 pe-2 h-10 rounded-xl border border-brand-blue/40 bg-brand-blue/10 text-xs sm:text-sm text-text-main max-w-full">
                  <Paperclip size={14} className="text-brand-cyan shrink-0" />
                  <span className="truncate max-w-[220px]">
                    {scheduleMediaHost?.name ?? scheduleMedia?.name}
                  </span>
                  <button
                    type="button"
                    onClick={clearScheduleMedia}
                    aria-label={t("scheduleRemoveMedia")}
                    className="w-7 h-7 rounded-lg text-muted hover:text-danger hover:bg-danger/10 flex items-center justify-center transition-colors"
                  >
                    <X size={14} />
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() =>
                    canPickHostSource() ? void pickHostMedia() : mediaInputRef.current?.click()
                  }
                  className="inline-flex items-center gap-2 px-3 h-10 rounded-xl border border-line bg-panel-raised text-text-main text-xs sm:text-sm font-bold hover:bg-panel-hover transition-colors focus-visible:ring-2 focus-visible:ring-brand-blue/50"
                >
                  <Paperclip size={14} className="text-brand-cyan shrink-0" />
                  <span>{t("scheduleAttachMedia")}</span>
                </button>
              )}
              <span className="text-[11px] text-muted">
                {t("scheduleMediaHint").replace("{max}", String(MEDIA_MAX_MB))}
              </span>
            </div>
            {!canPickHostSource() && (
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
      </Modal>

      {/* Schedule details — one row tap opens everything the table truncates */}
      <Modal
        isOpen={!!detailSchedule}
        onClose={() => setDetailSchedule(null)}
        title={t("scheduleDetails")}
        maxWidth="560px"
        footer={
          <div className="flex items-center justify-between w-full gap-2">
            {detailSchedule?.lastDeliveryStatus === "failed" ? (
              <button
                type="button"
                onClick={() => {
                  const id = detailSchedule.id;
                  setDetailSchedule(null);
                  void handleRetry(id);
                }}
                className="inline-flex items-center gap-1.5 px-4 h-10 rounded-xl border border-line bg-panel-raised hover:bg-panel-hover text-brand-cyan font-bold text-xs sm:text-sm transition-colors"
              >
                <RefreshCw size={14} />
                <span>{t("retryDelivery")}</span>
              </button>
            ) : (
              <span />
            )}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setDetailSchedule(null)}
                className="px-4 h-10 rounded-xl border border-line bg-panel-raised hover:bg-panel-hover text-text-main font-bold text-xs sm:text-sm transition-colors"
              >
                {t("close")}
              </button>
              <button
                type="button"
                onClick={() => {
                  const id = detailSchedule?.id;
                  setDetailSchedule(null);
                  if (id) void handleDelete(id);
                }}
                className="inline-flex items-center gap-1.5 px-4 h-10 rounded-xl bg-danger hover:bg-danger/90 text-white font-bold text-xs sm:text-sm transition-colors"
              >
                <Trash2 size={14} />
                <span>{t("delete")}</span>
              </button>
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
                {ar ? detailSchedule.whenAr || detailSchedule.when : detailSchedule.when}
              </span>
            </DetailRow>
            <DetailRow label={t("thType")}>
              {detailSchedule.type === "recurring" ? t("typeRecurring") : t("typeOnce")}
            </DetailRow>
            <DetailRow label={t("thDelivery")}>
              <span
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold ${
                  detailSchedule.lastDeliveryStatus === "failed"
                    ? "bg-danger/10 text-danger border border-danger/25"
                    : detailSchedule.status === "active"
                      ? "bg-ok/10 text-ok border border-ok/25"
                      : "bg-muted/10 text-muted"
                }`}
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
              </span>
            </DetailRow>
            {detailSchedule.lastRunAt && (
              <DetailRow label={t("detailLastRun")}>
                {new Date(detailSchedule.lastRunAt).toLocaleString(
                  language === "ar" ? "ar-EG" : "en-GB",
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
                  language === "ar" ? "ar-EG" : "en-GB",
                )}
              </DetailRow>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
};

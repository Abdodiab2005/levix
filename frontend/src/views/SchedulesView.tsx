// file: frontend/src/views/SchedulesView.tsx

import {
  AlertCircle,
  Calendar,
  CheckCircle2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  User,
  Users,
  X,
} from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { Modal } from "../components/Modal";
import type { ViewTab } from "../components/Sidebar";
import { useToast } from "../components/Toasts";
import { useI18n } from "../context/I18nContext";
import type { ScheduleItem } from "../types";

interface RecipientItem {
  id: string;
  name: string;
  type: "group" | "contact";
  phone?: string | null;
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
  const [cronString, setCronString] = useState("0 9 * * *");
  const [oneOffTime, setOneOffTime] = useState("");
  const [creating, setCreating] = useState(false);

  const MAX_SCHEDULES = 3;
  const isLimitReached = schedules.length >= MAX_SCHEDULES;

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
    } catch (err: any) {
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
    setSelectedRecipient(null);
    setSearchRecipient("");
    setMessage("");
    setShowAddModal(true);
    if (!recipients.length) loadRecipients();
  };

  const handleCreateSchedule = async () => {
    if (!selectedRecipient) {
      toast(
        language === "ar" ? "يرجى اختيار المحادثة المستهدفة" : "Please select a recipient chat",
        "warning",
      );
      return;
    }
    if (!message.trim()) {
      toast(
        language === "ar" ? "يرجى كتابة نص الرسالة" : "Please write the message text",
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

    setCreating(true);
    const payload: any = {
      targetJid: selectedRecipient.id,
      message: message.trim(),
      type: scheduleType,
    };

    if (scheduleType === "recurring") {
      payload.cronString = cronString;
    } else {
      payload.scheduledTime = new Date(oneOffTime).getTime();
    }

    try {
      await api.createSchedule(payload);
      toast(t("savedSuccessfully"), "success");
      setShowAddModal(false);
      setSelectedRecipient(null);
      setMessage("");
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
      (r.phone && r.phone.includes(q)) ||
      r.id.toLowerCase().includes(q)
    );
  });

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
                {schedules.length} / {MAX_SCHEDULES} {language === "ar" ? "مجدول" : "scheduled"}
              </span>
            </div>
            <p className="text-xs md:text-sm text-muted mt-1">
              {language === "ar" ? "المنطقة الزمنية:" : "Timezone:"}{" "}
              <code className="text-brand-cyan font-mono font-semibold px-1.5 py-0.5 rounded bg-bg-soft border border-line">
                {timezone}
              </code>{" "}
              ·{" "}
              {language === "ar"
                ? "إرسال دوري ومحدد بالوقت"
                : "Cron & one-off automated message deliveries"}
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
                    <span>
                      {language === "ar"
                        ? "لا توجد رسائل مجدولة حالياً."
                        : "No active schedules found."}
                    </span>
                  </div>
                </td>
              </tr>
            ) : (
              schedules.map((s) => (
                <tr key={s.id} className="hover:bg-panel-hover/50 transition-colors">
                  <td className="px-5 py-4 font-mono text-xs text-text-main">
                    <bdi>
                      {s.targetJid.includes("@g.us") ? (
                        <span className="inline-flex items-center gap-1.5 text-brand-cyan">
                          <Users size={14} />
                          <span>{language === "ar" ? "مجموعة" : "Group"}</span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-ok">
                          <User size={14} />
                          <span>+{s.targetJid.split("@")[0]}</span>
                        </span>
                      )}
                    </bdi>
                  </td>
                  <td className="px-5 py-4 max-w-xs text-text-main truncate text-xs sm:text-sm">
                    {s.message}
                  </td>
                  <td className="px-5 py-4 text-xs font-mono text-muted">
                    {s.when || s.cronString || "—"}
                  </td>
                  <td className="px-5 py-4">
                    <span
                      className={`inline-flex px-2.5 py-0.5 rounded-lg text-xs font-semibold ${
                        s.type === "recurring"
                          ? "bg-brand-blue/10 text-brand-cyan"
                          : "bg-purple-500/10 text-purple-400"
                      }`}
                    >
                      {s.type === "recurring"
                        ? language === "ar"
                          ? "متكرر"
                          : "Recurring"
                        : language === "ar"
                          ? "مرة واحدة"
                          : "Once"}
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
                          ? language === "ar"
                            ? "فشل الإرسال"
                            : "Failed"
                          : s.status === "active"
                            ? language === "ar"
                              ? "نشط"
                              : "Active"
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
              disabled={creating || !selectedRecipient || !message.trim()}
              className="px-5 h-10 rounded-xl bg-brand-blue hover:bg-brand-blue/90 text-white font-bold text-xs sm:text-sm shadow-md shadow-brand-blue/20 transition-all disabled:opacity-50"
            >
              {creating ? t("saving") : language === "ar" ? "جدولة الرسالة" : "Schedule"}
            </button>
          </div>
        }
      >
        <div className="flex flex-col gap-4 py-1">
          {/* Target Recipient Selector (No raw JIDs!) */}
          <div className="space-y-1.5">
            <label className="block text-xs font-bold text-text-main">
              {t("selectRecipient")} <span className="text-danger">*</span>
            </label>

            {selectedRecipient ? (
              <div className="flex items-center justify-between p-3 rounded-xl border border-brand-blue/40 bg-brand-blue/10">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="w-8 h-8 rounded-lg bg-brand-blue/20 text-brand-cyan flex items-center justify-center shrink-0">
                    {selectedRecipient.type === "group" ? <Users size={16} /> : <User size={16} />}
                  </div>
                  <div className="min-w-0">
                    <div className="text-xs sm:text-sm font-bold text-text-main truncate">
                      {selectedRecipient.name}
                    </div>
                    {selectedRecipient.phone && (
                      <div className="text-[11px] text-muted font-mono" dir="ltr">
                        {selectedRecipient.phone}
                      </div>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedRecipient(null)}
                  className="p-1 rounded-lg hover:bg-panel text-muted hover:text-danger transition-colors"
                  title="Change chat"
                >
                  <X size={16} />
                </button>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <div className="relative">
                  <Search size={16} className="absolute start-3 top-3 text-muted" />
                  <input
                    type="text"
                    value={searchRecipient}
                    onChange={(e) => setSearchRecipient(e.target.value)}
                    placeholder={t("searchRecipients")}
                    className="w-full h-10 ps-9 pe-3 rounded-xl border border-line bg-panel-raised text-text-main text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                  />
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
                            <div className="text-xs font-bold text-text-main truncate">
                              {rec.name}
                            </div>
                            {rec.phone && (
                              <div className="text-[10px] text-muted font-mono" dir="ltr">
                                {rec.phone}
                              </div>
                            )}
                          </div>
                        </div>
                        <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-panel text-muted shrink-0">
                          {rec.type === "group"
                            ? language === "ar"
                              ? "مجموعة"
                              : "Group"
                            : language === "ar"
                              ? "محادثة"
                              : "Contact"}
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
            <label className="block text-xs font-bold text-text-main">
              {language === "ar" ? "نوع الجدولة" : "Schedule Type"}
            </label>
            <select
              className="w-full h-11 px-3.5 rounded-xl border border-line bg-panel-raised text-text-main text-xs sm:text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
              value={scheduleType}
              onChange={(e) => setScheduleType(e.target.value as any)}
            >
              <option value="recurring">
                {language === "ar" ? "دوري متكرر (Cron Expression)" : "Recurring (Cron Expression)"}
              </option>
              <option value="once">
                {language === "ar"
                  ? "مرة واحدة (تاريخ ووقت محدد)"
                  : "One-Off (Specific Date & Time)"}
              </option>
            </select>
          </div>

          {scheduleType === "recurring" ? (
            <div className="space-y-1.5">
              <label className="block text-xs font-bold text-text-main">
                {language === "ar"
                  ? "تعبير Cron (دقيقة ساعة يوم شهر يوم-الأسبوع)"
                  : "Cron Expression (5 fields: min hour day month weekday)"}
              </label>
              <input
                type="text"
                className="w-full h-11 px-3.5 rounded-xl border border-line bg-panel-raised font-mono text-text-main text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                value={cronString}
                onChange={(e) => setCronString(e.target.value)}
                placeholder="0 9 * * *"
              />
              <span className="block text-xs text-muted">
                {language === "ar" ? "مثال: " : "e.g. "}
                <code className="text-brand-cyan">0 9 * * *</code> (
                {language === "ar" ? "يومياً الساعة 9:00 صباحاً" : "Every day at 9:00 AM"})
              </span>
            </div>
          ) : (
            <div className="space-y-1.5">
              <label className="block text-xs font-bold text-text-main">
                {language === "ar" ? "موعد وتاريخ الإرسال" : "Delivery Date & Time"}
              </label>
              <input
                type="datetime-local"
                className="w-full h-11 px-3.5 rounded-xl border border-line bg-panel-raised text-text-main text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                value={oneOffTime}
                onChange={(e) => setOneOffTime(e.target.value)}
              />
            </div>
          )}

          {/* Message Text */}
          <div className="space-y-1.5">
            <label className="block text-xs font-bold text-text-main">
              {language === "ar" ? "نص الرسالة" : "Message Text"}{" "}
              <span className="text-danger">*</span>
            </label>
            <textarea
              className="w-full p-3.5 rounded-xl border border-line bg-panel-raised text-text-main text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50 resize-y min-h-[90px]"
              rows={3}
              placeholder={
                language === "ar"
                  ? "اكتب الرسالة التي سيتم إرسالها تلقائياً..."
                  : "Message to be sent automatically..."
              }
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
          </div>
        </div>
      </Modal>
    </div>
  );
};

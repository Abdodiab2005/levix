// file: frontend/src/views/SchedulesView.tsx

import { AlertCircle, Calendar, CheckCircle2, Clock, Plus, RefreshCw, Trash2 } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { Modal } from "../components/Modal";
import { useToast } from "../components/Toasts";
import { useI18n } from "../context/I18nContext";
import type { ScheduleItem } from "../types";

export const SchedulesView: React.FC = () => {
  const { t, language } = useI18n();
  const { toast } = useToast();
  const [schedules, setSchedules] = useState<ScheduleItem[]>([]);
  const [timezone, setTimezone] = useState("UTC");
  const [loading, setLoading] = useState(true);

  // New schedule modal state
  const [showAddModal, setShowAddModal] = useState(false);
  const [targetJid, setTargetJid] = useState("");
  const [message, setMessage] = useState("");
  const [scheduleType, setScheduleType] = useState<"recurring" | "once">("recurring");
  const [cronString, setCronString] = useState("0 9 * * *");
  const [oneOffTime, setOneOffTime] = useState("");

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

  useEffect(() => {
    loadSchedules();
  }, []);

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
    try {
      await api.retrySchedule(id);
      toast("Delivery retry triggered", "info");
      loadSchedules();
    } catch (err: any) {
      toast(err.message, "error");
    }
  };

  const handleCreateSchedule = async () => {
    if (!targetJid || !message) {
      toast("Please specify recipient JID and message content", "warning");
      return;
    }

    const payload: any = {
      targetJid: targetJid.includes("@") ? targetJid : `${targetJid}@s.whatsapp.net`,
      message,
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
      setTargetJid("");
      setMessage("");
      loadSchedules();
    } catch (err: any) {
      toast(err.message, "error");
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Header Card */}
      <div className="rounded-2xl border border-line bg-panel p-5 md:p-6 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3.5">
          <div className="w-12 h-12 rounded-2xl bg-brand-cyan/10 text-brand-cyan flex items-center justify-center shrink-0">
            <Calendar size={24} />
          </div>
          <div>
            <div className="flex items-center gap-3">
              <h2 className="text-lg md:text-xl font-bold text-text-main">{t("schedules")}</h2>
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-brand-cyan/10 text-brand-cyan border border-brand-cyan/20">
                {schedules.length} {language === "ar" ? "مجدول" : "scheduled"}
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
          onClick={() => setShowAddModal(true)}
          className="inline-flex items-center justify-center gap-2 px-5 h-11 rounded-xl bg-brand-blue hover:bg-brand-blue/90 text-white font-bold text-xs md:text-sm shadow-md shadow-brand-blue/20 transition-all focus-visible:ring-2 focus-visible:ring-brand-blue/50 shrink-0 self-start sm:self-auto"
        >
          <Plus size={18} />
          <span>{t("scheduleNewMsg")}</span>
        </button>
      </div>

      {/* Table Container */}
      <div className="rounded-2xl border border-line bg-panel overflow-hidden shadow-sm overflow-x-auto">
        <table className="w-full text-start border-collapse text-sm">
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
                <td colSpan={6} className="text-center py-16 px-4">
                  <div className="max-w-md mx-auto flex flex-col items-center gap-3">
                    <div className="w-14 h-14 rounded-2xl bg-panel-raised flex items-center justify-center text-muted">
                      <Clock size={28} />
                    </div>
                    <h4 className="text-base font-bold text-text-main">
                      {language === "ar" ? "لا توجد رسائل مجدولة" : "No scheduled messages yet"}
                    </h4>
                    <p className="text-xs text-muted leading-relaxed">
                      {language === "ar"
                        ? "يمكنك إنشاء رسائل تذكير دورية أو إرسال رسائل تلقائية في موعد محدد لأي رقم أو مجموعة."
                        : "You can create recurring reminders or schedule one-off announcements to be sent automatically to any contact or group."}
                    </p>
                    <button
                      type="button"
                      onClick={() => setShowAddModal(true)}
                      className="mt-2 inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-brand-blue/10 hover:bg-brand-blue/20 text-brand-cyan font-bold text-xs transition-colors"
                    >
                      <Plus size={16} />
                      <span>{t("scheduleNewMsg")}</span>
                    </button>
                  </div>
                </td>
              </tr>
            ) : (
              schedules.map((s) => (
                <tr key={s.id} className="hover:bg-panel-hover/50 transition-colors">
                  <td className="px-5 py-4 font-mono text-xs text-text-main">
                    <bdi className="px-2 py-1 rounded bg-bg-soft border border-line select-all">
                      {s.targetJid}
                    </bdi>
                  </td>
                  <td className="px-5 py-4 max-w-xs text-text-main">
                    <p className="line-clamp-2 text-xs md:text-sm font-medium">{s.message}</p>
                  </td>
                  <td className="px-5 py-4">
                    <div className="flex items-center gap-2 text-xs font-medium text-text-main">
                      <Clock size={15} className="text-brand-cyan shrink-0" />
                      <span>{s.when}</span>
                    </div>
                  </td>
                  <td className="px-5 py-4">
                    <span className="inline-flex items-center px-2.5 py-1 rounded-lg bg-panel-raised border border-line text-xs font-semibold text-text-main capitalize">
                      {s.type}
                    </span>
                  </td>
                  <td className="px-5 py-4">
                    {s.lastDeliveryStatus === "failed" ? (
                      <span
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-danger/10 text-danger border border-danger/25 text-xs font-semibold"
                        title={s.lastError || "Failed"}
                      >
                        <AlertCircle size={13} />
                        <span>Failed</span>
                      </span>
                    ) : s.lastDeliveryStatus === "success" ? (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-ok/10 text-ok border border-ok/25 text-xs font-semibold">
                        <CheckCircle2 size={13} />
                        <span>Delivered</span>
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-warn/10 text-warn border border-warn/25 text-xs font-semibold">
                        <Clock size={13} />
                        <span>Pending</span>
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-4 text-center">
                    <div className="inline-flex items-center gap-2">
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
                        title="Delete schedule"
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

      {/* Add Schedule Modal */}
      <Modal
        isOpen={showAddModal}
        onClose={() => setShowAddModal(false)}
        title={t("scheduleNewMsg")}
        footer={
          <>
            <button
              type="button"
              onClick={() => setShowAddModal(false)}
              className="px-4 h-10 rounded-xl border border-line bg-panel-raised hover:bg-panel-hover text-text-main font-bold text-xs transition-colors"
            >
              {t("cancel")}
            </button>
            <button
              type="button"
              onClick={handleCreateSchedule}
              className="px-5 h-10 rounded-xl bg-brand-blue hover:bg-brand-blue/90 text-white font-bold text-xs shadow-md shadow-brand-blue/20 transition-all"
            >
              {language === "ar" ? "جدولة الرسالة" : "Schedule"}
            </button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="space-y-1.5">
            <label className="block text-xs font-bold text-text-main">
              {language === "ar"
                ? "المستلم (رقم الهاتف مع كود الدولة أو JID المجموعة)"
                : "Recipient (Phone Number with Country Code or Group JID)"}
            </label>
            <input
              type="text"
              className="w-full h-11 px-3.5 rounded-xl border border-line bg-panel-raised text-text-main text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
              placeholder="e.g. 201012345678 or 120363@g.us"
              value={targetJid}
              onChange={(e) => setTargetJid(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <label className="block text-xs font-bold text-text-main">
              {language === "ar" ? "نوع الجدولة" : "Schedule Type"}
            </label>
            <select
              className="w-full h-11 px-3.5 rounded-xl border border-line bg-panel-raised text-text-main text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
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
                className="w-full h-11 px-3.5 rounded-xl border border-line bg-panel-raised font-mono text-text-main text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                value={cronString}
                onChange={(e) => setCronString(e.target.value)}
                placeholder="0 9 * * *"
              />
              <span className="block text-xs text-muted">
                e.g. <code className="text-brand-cyan">0 9 * * *</code> (Every day at 9:00 AM)
              </span>
            </div>
          ) : (
            <div className="space-y-1.5">
              <label className="block text-xs font-bold text-text-main">
                {language === "ar" ? "موعد الإرسال" : "Delivery Date & Time"}
              </label>
              <input
                type="datetime-local"
                className="w-full h-11 px-3.5 rounded-xl border border-line bg-panel-raised text-text-main text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                value={oneOffTime}
                onChange={(e) => setOneOffTime(e.target.value)}
              />
            </div>
          )}

          <div className="space-y-1.5">
            <label className="block text-xs font-bold text-text-main">
              {language === "ar" ? "نص الرسالة" : "Message Text"}
            </label>
            <textarea
              className="w-full p-3.5 rounded-xl border border-line bg-panel-raised text-text-main text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
              rows={4}
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

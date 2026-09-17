// file: frontend/src/views/SchedulesView.tsx
import React, { useEffect, useState } from "react";
import { Calendar, Plus, Trash2, RefreshCw, AlertCircle, Clock } from "lucide-react";
import { api } from "../api/client";
import { useI18n } from "../context/I18nContext";
import { useToast } from "../components/Toasts";
import { Modal } from "../components/Modal";
import { ScheduleItem } from "../types";

export const SchedulesView: React.FC = () => {
  const { t } = useI18n();
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
      toast("Schedule deleted", "success");
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
      toast("Schedule created successfully", "success");
      setShowAddModal(false);
      setTargetJid("");
      setMessage("");
      loadSchedules();
    } catch (err: any) {
      toast(err.message, "error");
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      <div className="card-glass">
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "16px" }}>
          <div>
            <h2 style={{ fontSize: "1.2rem", fontWeight: 700 }}>{t("schedules")}</h2>
            <p style={{ fontSize: "0.85rem", color: "var(--muted)", marginTop: "4px" }}>
              Timezone: <code style={{ color: "var(--cyan)" }}>{timezone}</code> · Cron &amp; one-off deliveries
            </p>
          </div>

          <button onClick={() => setShowAddModal(true)} className="btn btn-primary">
            <Plus size={16} />
            <span>Schedule Message</span>
          </button>
        </div>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Target</th>
              <th>Message Preview</th>
              <th>Schedule</th>
              <th>Type</th>
              <th>Delivery Status</th>
              <th style={{ textAlign: "center" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={6} style={{ textAlign: "center", padding: "30px", color: "var(--muted)" }}>
                  Loading schedules...
                </td>
              </tr>
            ) : schedules.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ textAlign: "center", padding: "30px", color: "var(--muted)" }}>
                  No scheduled messages found. Create one with the button above!
                </td>
              </tr>
            ) : (
              schedules.map((s) => (
                <tr key={s.id}>
                  <td style={{ fontFamily: "var(--font-mono)", fontSize: "0.85rem" }}>
                    {s.targetJid}
                  </td>
                  <td style={{ maxWidth: "250px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {s.message}
                  </td>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                      <Clock size={14} color="var(--cyan)" />
                      <span>{s.when}</span>
                    </div>
                  </td>
                  <td>
                    <span className="badge badge-info">{s.type}</span>
                  </td>
                  <td>
                    {s.lastDeliveryStatus === "failed" ? (
                      <span className="badge badge-danger" title={s.lastError || "Failed"}>
                        <AlertCircle size={12} /> Failed
                      </span>
                    ) : s.lastDeliveryStatus === "success" ? (
                      <span className="badge badge-ok">Delivered</span>
                    ) : (
                      <span className="badge badge-warn">Pending</span>
                    )}
                  </td>
                  <td style={{ textAlign: "center" }}>
                    <div style={{ display: "inline-flex", gap: "8px" }}>
                      {s.lastDeliveryStatus === "failed" && (
                        <button
                          onClick={() => handleRetry(s.id)}
                          className="btn btn-secondary btn-sm"
                          title="Retry delivery"
                        >
                          <RefreshCw size={14} />
                        </button>
                      )}
                      <button
                        onClick={() => handleDelete(s.id)}
                        className="btn btn-danger btn-sm"
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
        title="Schedule New Message"
        footer={
          <>
            <button onClick={() => setShowAddModal(false)} className="btn btn-secondary">
              {t("cancel")}
            </button>
            <button onClick={handleCreateSchedule} className="btn btn-primary">
              Schedule
            </button>
          </>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          <div className="form-group">
            <label className="form-label">Recipient (Phone Number with Country Code or Group JID)</label>
            <input
              type="text"
              className="form-input"
              placeholder="e.g. 201012345678 or 120363@g.us"
              value={targetJid}
              onChange={(e) => setTargetJid(e.target.value)}
            />
          </div>

          <div className="form-group">
            <label className="form-label">Schedule Type</label>
            <select
              className="form-select"
              value={scheduleType}
              onChange={(e) => setScheduleType(e.target.value as any)}
            >
              <option value="recurring">Recurring (Cron Expression)</option>
              <option value="once">One-Off (Specific Date &amp; Time)</option>
            </select>
          </div>

          {scheduleType === "recurring" ? (
            <div className="form-group">
              <label className="form-label">Cron Expression (5 fields: min hour day month weekday)</label>
              <input
                type="text"
                className="form-input"
                value={cronString}
                onChange={(e) => setCronString(e.target.value)}
                placeholder="0 9 * * *"
              />
              <span style={{ fontSize: "0.78rem", color: "var(--muted)" }}>
                e.g. <code style={{ color: "var(--cyan)" }}>0 9 * * *</code> (Every day at 9:00 AM)
              </span>
            </div>
          ) : (
            <div className="form-group">
              <label className="form-label">Delivery Date &amp; Time</label>
              <input
                type="datetime-local"
                className="form-input"
                value={oneOffTime}
                onChange={(e) => setOneOffTime(e.target.value)}
              />
            </div>
          )}

          <div className="form-group">
            <label className="form-label">Message Text</label>
            <textarea
              className="form-textarea"
              rows={4}
              placeholder="Message to be sent automatically..."
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
          </div>
        </div>
      </Modal>
    </div>
  );
};

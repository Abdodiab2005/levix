// file: frontend/src/views/ConnectionView.tsx
import React, { useState } from "react";
import { Play, Square, RefreshCw, Unlink, RotateCcw, QrCode, AlertCircle, CheckCircle2 } from "lucide-react";
import { api } from "../api/client";
import { useI18n } from "../context/I18nContext";
import { useToast } from "../components/Toasts";
import { Modal } from "../components/Modal";
import { SessionStatus } from "../types";

interface ConnectionViewProps {
  status: SessionStatus | null;
}

export const ConnectionView: React.FC<ConnectionViewProps> = ({ status }) => {
  const { t } = useI18n();
  const { toast } = useToast();
  const [showUnlinkModal, setShowUnlinkModal] = useState(false);
  const [acting, setActing] = useState(false);

  const state = status?.state || "idle";
  const isConnected = state === "connected";
  const isWaitingQr = state === "waiting_for_qr";

  const handleAction = async (actionFn: () => Promise<any>, successMsg: string) => {
    setActing(true);
    try {
      await actionFn();
      toast(successMsg, "success");
    } catch (err: any) {
      toast(err.message, "error");
    } finally {
      setActing(false);
    }
  };

  const confirmUnlink = async () => {
    setShowUnlinkModal(false);
    await handleAction(api.unlinkSession, "Session unlinked successfully.");
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      {/* Session State Card */}
      <div className="card">
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "16px", marginBottom: "20px" }}>
          <div>
            <h2 style={{ fontSize: "1.2rem", fontWeight: 700 }}>{t("connection")}</h2>
            <p style={{ fontSize: "0.85rem", color: "var(--muted)", marginTop: "4px" }}>
              Backend-owned Baileys v7 WhatsApp connection state machine
            </p>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <span className={`badge ${isConnected ? "badge-ok" : isWaitingQr ? "badge-warn" : "badge-info"}`} style={{ fontSize: "0.85rem", padding: "6px 14px" }}>
              <span className="pulse-dot" />
              <span>{t(state as any, state)}</span>
            </span>
          </div>
        </div>

        {/* Retry timer warning */}
        {status?.retryInSeconds ? (
          <div style={{ background: "var(--warn-bg)", border: "1px solid rgba(245, 158, 11, 0.3)", borderRadius: "var(--radius-sm)", padding: "14px 18px", display: "flex", alignItems: "center", gap: "12px", marginBottom: "20px" }}>
            <AlertCircle size={20} color="var(--warn)" />
            <div>
              <div style={{ fontWeight: 600, color: "var(--warn)" }}>Reconnecting soon...</div>
              <div style={{ fontSize: "0.85rem", color: "var(--text)" }}>Next attempt in {status.retryInSeconds} seconds (staged linear backoff)</div>
            </div>
          </div>
        ) : null}

        {/* Action Controls */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: "12px" }}>
          {!isConnected ? (
            <button
              onClick={() => handleAction(api.startSession, t("starting"))}
              disabled={acting || state === "starting"}
              className="btn btn-primary"
            >
              <Play size={16} />
              <span>{t("start")}</span>
            </button>
          ) : (
            <button
              onClick={() => handleAction(api.stopSession, t("stop"))}
              disabled={acting}
              className="btn btn-secondary"
            >
              <Square size={16} />
              <span>{t("stop")}</span>
            </button>
          )}

          <button
            onClick={() => handleAction(api.startSession, t("reconnecting"))}
            disabled={acting}
            className="btn btn-secondary"
          >
            <RefreshCw size={16} />
            <span>{t("reconnect")}</span>
          </button>

          <button
            onClick={() => setShowUnlinkModal(true)}
            disabled={acting}
            className="btn btn-danger"
          >
            <Unlink size={16} />
            <span>{t("unlink")}</span>
          </button>

          <button
            onClick={() => handleAction(api.restartBot, t("restart"))}
            disabled={acting}
            className="btn btn-secondary"
          >
            <RotateCcw size={16} />
            <span>{t("restart")}</span>
          </button>
        </div>
      </div>

      {/* QR Code / Pairing Box */}
      {isWaitingQr && (
        <div className="card" style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", padding: "36px 24px" }}>
          <div style={{ width: "48px", height: "48px", borderRadius: "50%", background: "var(--info-bg)", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: "16px" }}>
            <QrCode size={26} color="var(--cyan)" />
          </div>
          <h3 style={{ fontSize: "1.15rem", fontWeight: 700, marginBottom: "8px" }}>
            {t("waiting_for_qr")}
          </h3>
          <p style={{ fontSize: "0.88rem", color: "var(--muted)", maxWidth: "450px", marginBottom: "24px" }}>
            Open WhatsApp on your phone &gt; Settings &gt; Linked Devices &gt; Link a Device, and scan the QR code below.
          </p>

          {status?.qr ? (
            <div style={{ padding: "16px", background: "#ffffff", borderRadius: "12px", boxShadow: "var(--shadow)" }}>
              <img
                src={`https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=${encodeURIComponent(status.qr)}`}
                alt="WhatsApp QR Code"
                style={{ display: "block", width: "260px", height: "260px" }}
              />
            </div>
          ) : status?.pairingCode ? (
            <div style={{ background: "var(--panel-raised)", padding: "18px 24px", borderRadius: "12px", border: "1px solid var(--line)" }}>
              <div style={{ fontSize: "0.8rem", color: "var(--muted)", marginBottom: "6px" }}>Pairing Code</div>
              <div style={{ fontSize: "1.8rem", fontWeight: 800, letterSpacing: "0.15em", color: "var(--cyan)", fontFamily: "var(--font-mono)" }}>
                {status.pairingCode}
              </div>
            </div>
          ) : (
            <div style={{ color: "var(--muted)", padding: "20px" }}>Generating QR code...</div>
          )}
        </div>
      )}

      {isConnected && (
        <div className="card" style={{ display: "flex", alignItems: "center", gap: "16px", background: "var(--ok-bg)", borderColor: "rgba(16, 185, 129, 0.25)" }}>
          <CheckCircle2 size={24} color="var(--ok)" />
          <div>
            <div style={{ fontWeight: 700, color: "var(--ok)" }}>Bot is actively paired and online</div>
            <div style={{ fontSize: "0.85rem", color: "var(--text)", marginTop: "2px" }}>
              Messages, commands, and scheduled jobs are being delivered in real time.
            </div>
          </div>
        </div>
      )}

      {/* Unlink Confirmation Modal */}
      <Modal
        isOpen={showUnlinkModal}
        onClose={() => setShowUnlinkModal(false)}
        title={t("unlink")}
        footer={
          <>
            <button onClick={() => setShowUnlinkModal(false)} className="btn btn-secondary">
              {t("cancel")}
            </button>
            <button onClick={confirmUnlink} className="btn btn-danger">
              {t("unlink")}
            </button>
          </>
        }
      >
        <p style={{ color: "var(--text)", fontSize: "0.92rem", lineHeight: "1.6" }}>
          Are you sure you want to unlink this WhatsApp session? You will need to re-scan the QR code to connect again.
        </p>
      </Modal>
    </div>
  );
};

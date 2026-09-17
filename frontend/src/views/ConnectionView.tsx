// file: frontend/src/views/ConnectionView.tsx

import { AlertCircle, Play, QrCode, RefreshCw, RotateCcw, Square, Unlink } from "lucide-react";
import QRCode from "qrcode";
import type React from "react";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { Modal } from "../components/Modal";
import { useToast } from "../components/Toasts";
import { useI18n } from "../context/I18nContext";
import type { SessionStatus } from "../types";

interface ConnectionViewProps {
  status: SessionStatus | null;
}

export const ConnectionView: React.FC<ConnectionViewProps> = ({ status }) => {
  const { t } = useI18n();
  const { toast } = useToast();
  const [showUnlinkModal, setShowUnlinkModal] = useState(false);
  const [acting, setActing] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  const state = status?.state || "idle";
  const isConnected = state === "connected";
  const isWaitingQr = state === "waiting_for_qr";

  // Generate QR code locally in offline-first mode
  useEffect(() => {
    if (status?.qr) {
      QRCode.toDataURL(status.qr, {
        width: 260,
        margin: 2,
        color: {
          dark: "#0b1629",
          light: "#ffffff",
        },
      })
        .then((url) => setQrDataUrl(url))
        .catch(() => setQrDataUrl(null));
    } else {
      setQrDataUrl(null);
    }
  }, [status?.qr]);

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
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      {/* Session State Card */}
      <div className="card">
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "14px",
            marginBottom: "18px",
          }}
        >
          <div>
            <h2 style={{ fontSize: "1.15rem", fontWeight: 700 }}>{t("connection")}</h2>
            <p style={{ fontSize: "0.82rem", color: "var(--muted)", marginTop: "3px" }}>
              Baileys v7 WhatsApp connection engine
            </p>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span
              className={`badge ${isConnected ? "badge-ok" : isWaitingQr ? "badge-warn" : "badge-info"}`}
              style={{ fontSize: "0.82rem", padding: "5px 12px" }}
            >
              <span className="pulse-dot" />
              <span>{t(state as any, state)}</span>
            </span>
          </div>
        </div>

        {/* Retry timer warning */}
        {status?.retryInSeconds ? (
          <div
            style={{
              background: "var(--warn-bg)",
              border: "1px solid rgba(245, 158, 11, 0.3)",
              borderRadius: "var(--radius-sm)",
              padding: "12px 16px",
              display: "flex",
              alignItems: "center",
              gap: "10px",
              marginBottom: "16px",
            }}
          >
            <AlertCircle size={18} color="var(--warn)" style={{ flexShrink: 0 }} />
            <div>
              <div style={{ fontWeight: 600, fontSize: "0.88rem", color: "var(--warn)" }}>
                {t("reconnectingSoon")}
              </div>
              <div style={{ fontSize: "0.82rem", color: "var(--text)" }}>
                {t("nextAttemptIn")} {status.retryInSeconds} {t("seconds")}
              </div>
            </div>
          </div>
        ) : null}

        {/* Action Controls */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: "10px" }}>
          {!isConnected ? (
            <button
              onClick={() => handleAction(api.startSession, t("starting"))}
              disabled={acting || state === "starting"}
              className="btn btn-primary"
            >
              <Play size={15} />
              <span>{t("start")}</span>
            </button>
          ) : (
            <button
              onClick={() => handleAction(api.stopSession, t("stop"))}
              disabled={acting}
              className="btn btn-secondary"
            >
              <Square size={15} />
              <span>{t("stop")}</span>
            </button>
          )}

          <button
            onClick={() => handleAction(api.startSession, t("reconnecting"))}
            disabled={acting}
            className="btn btn-secondary"
          >
            <RefreshCw size={15} />
            <span>{t("reconnect")}</span>
          </button>

          <button
            onClick={() => setShowUnlinkModal(true)}
            disabled={acting}
            className="btn btn-danger"
          >
            <Unlink size={15} />
            <span>{t("unlink")}</span>
          </button>

          <button
            onClick={() => handleAction(api.restartBot, t("restart"))}
            disabled={acting}
            className="btn btn-secondary"
          >
            <RotateCcw size={15} />
            <span>{t("restart")}</span>
          </button>
        </div>
      </div>

      {/* QR Code / Pairing Box */}
      {isWaitingQr && (
        <div
          className="card"
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            textAlign: "center",
            padding: "28px 18px",
          }}
        >
          <div
            style={{
              width: "44px",
              height: "44px",
              borderRadius: "50%",
              background: "var(--info-bg)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              marginBottom: "14px",
            }}
          >
            <QrCode size={24} color="var(--cyan)" />
          </div>
          <h3 style={{ fontSize: "1.1rem", fontWeight: 700, marginBottom: "6px" }}>
            {t("waiting_for_qr")}
          </h3>
          <p
            style={{
              fontSize: "0.84rem",
              color: "var(--muted)",
              maxWidth: "420px",
              marginBottom: "20px",
            }}
          >
            {t("scanQrHint")}
          </p>

          {qrDataUrl ? (
            <div
              style={{
                padding: "12px",
                background: "#ffffff",
                borderRadius: "12px",
                boxShadow: "var(--shadow)",
              }}
            >
              <img
                src={qrDataUrl}
                alt="WhatsApp QR Code"
                style={{ display: "block", width: "240px", height: "240px" }}
              />
            </div>
          ) : status?.pairingCode ? (
            <div
              style={{
                background: "var(--panel-raised)",
                padding: "16px 20px",
                borderRadius: "12px",
                border: "1px solid var(--line)",
              }}
            >
              <div style={{ fontSize: "0.78rem", color: "var(--muted)", marginBottom: "6px" }}>
                {t("pairingCode")}
              </div>
              <div
                style={{
                  fontSize: "1.6rem",
                  fontWeight: 800,
                  letterSpacing: "0.15em",
                  color: "var(--cyan)",
                  fontFamily: "var(--font-mono)",
                  direction: "ltr",
                }}
              >
                {status.pairingCode}
              </div>
            </div>
          ) : (
            <div style={{ color: "var(--muted)", fontSize: "0.86rem" }}>{t("starting")}</div>
          )}
        </div>
      )}

      {/* Confirm Unlink Modal */}
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
        <p style={{ fontSize: "0.9rem", color: "var(--text)", lineHeight: "1.6" }}>
          Are you sure you want to unlink this WhatsApp session? You will need to scan a new QR code
          to reconnect.
        </p>
      </Modal>
    </div>
  );
};

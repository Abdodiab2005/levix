// file: frontend/src/views/ConnectionView.tsx

import {
  AlertCircle,
  Database,
  Play,
  QrCode,
  Radio,
  RefreshCw,
  RotateCcw,
  Shield,
  Smartphone,
  Square,
  Unlink,
} from "lucide-react";
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
        width: 280,
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
    <div className="flex flex-col gap-6">
      {/* Primary Connection Hero Card */}
      <div className="rounded-2xl border border-line bg-gradient-to-br from-panel-raised via-panel to-panel p-6 shadow-sm flex flex-col gap-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-5 border-b border-line">
          <div className="flex items-center gap-3.5">
            <div
              className={`w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 border ${
                isConnected
                  ? "bg-ok/15 text-ok border-ok/30 shadow-sm shadow-ok/20"
                  : isWaitingQr
                    ? "bg-warn/15 text-warn border-warn/30 shadow-sm shadow-warn/20"
                    : "bg-info/15 text-info border-info/30 shadow-sm shadow-info/20"
              }`}
            >
              <Radio size={24} />
            </div>
            <div>
              <div className="flex items-center gap-2.5 flex-wrap">
                <h2 className="text-lg sm:text-xl font-extrabold text-text-main">
                  {t("connection")}
                </h2>
                <span className="px-2 py-0.5 rounded-md bg-panel-raised border border-line text-[11px] font-mono font-bold text-muted">
                  Baileys v7
                </span>
              </div>
              <p className="text-xs sm:text-sm text-muted mt-0.5">
                WhatsApp Multi-Device Socket State Machine
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <span
              className={`inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-bold border ${
                isConnected
                  ? "bg-ok/15 text-ok border-ok/30"
                  : isWaitingQr
                    ? "bg-warn/15 text-warn border-warn/30"
                    : "bg-brand-cyan/15 text-brand-cyan border-brand-cyan/30"
              }`}
            >
              <span className="pulse-dot" />
              <span>{t(state as any, state)}</span>
            </span>
          </div>
        </div>

        {/* Retry Alert */}
        {status?.retryInSeconds ? (
          <div className="rounded-xl border border-warn/30 bg-warn/10 p-4 flex items-center gap-3 text-warn">
            <AlertCircle size={20} className="shrink-0" />
            <div className="text-xs sm:text-sm">
              <span className="font-bold">{t("reconnectingSoon")}</span> &bull;{" "}
              <span>
                {t("nextAttemptIn")} {status.retryInSeconds} {t("seconds")}
              </span>
            </div>
          </div>
        ) : null}

        {/* Action Controls */}
        <div className="flex flex-wrap items-center gap-3">
          {!isConnected ? (
            <button
              type="button"
              onClick={() => handleAction(api.startSession, t("starting"))}
              disabled={acting || state === "starting"}
              className="inline-flex items-center justify-center gap-2 px-5 h-11 rounded-xl bg-brand-blue hover:bg-brand-blue/90 text-white font-bold text-xs sm:text-sm shadow-md shadow-brand-blue/25 transition-all focus-visible:ring-2 focus-visible:ring-brand-blue/50 disabled:opacity-50"
            >
              <Play size={16} />
              <span>{t("start")}</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => handleAction(api.stopSession, t("stop"))}
              disabled={acting}
              className="inline-flex items-center justify-center gap-2 px-5 h-11 rounded-xl border border-line bg-panel-raised hover:bg-danger/15 hover:border-danger/40 hover:text-danger text-text-main font-bold text-xs sm:text-sm transition-all focus-visible:ring-2 focus-visible:ring-danger/50 disabled:opacity-50"
            >
              <Square size={16} />
              <span>{t("stop")}</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => handleAction(api.reconnectSession, t("reconnecting"))}
            disabled={acting}
            className="inline-flex items-center justify-center gap-2 px-4 h-11 rounded-xl border border-line bg-panel-raised hover:bg-panel-hover text-text-main font-bold text-xs sm:text-sm transition-all focus-visible:ring-2 focus-visible:ring-brand-blue/50 disabled:opacity-50"
          >
            <RefreshCw size={16} />
            <span>{t("reconnect")}</span>
          </button>

          <button
            type="button"
            onClick={() => setShowUnlinkModal(true)}
            disabled={acting}
            className="inline-flex items-center justify-center gap-2 px-4 h-11 rounded-xl border border-danger/30 bg-danger/10 hover:bg-danger/20 text-danger font-bold text-xs sm:text-sm transition-all focus-visible:ring-2 focus-visible:ring-danger/50 disabled:opacity-50"
          >
            <Unlink size={16} />
            <span>{t("unlink")}</span>
          </button>

          <button
            type="button"
            onClick={() => handleAction(api.restartBot, t("restart"))}
            disabled={acting}
            className="inline-flex items-center justify-center gap-2 px-4 h-11 rounded-xl border border-line bg-panel-raised hover:bg-panel-hover text-text-main font-bold text-xs sm:text-sm transition-all focus-visible:ring-2 focus-visible:ring-brand-blue/50 disabled:opacity-50"
          >
            <RotateCcw size={16} />
            <span>{t("restart")}</span>
          </button>
        </div>
      </div>

      {/* QR Code / Pairing Container */}
      {isWaitingQr && (
        <div className="rounded-2xl border border-line bg-panel p-8 shadow-sm flex flex-col items-center text-center">
          <div className="w-12 h-12 rounded-2xl bg-brand-cyan/15 text-brand-cyan flex items-center justify-center mb-4 border border-brand-cyan/30">
            <QrCode size={26} />
          </div>
          <h3 className="text-lg font-bold text-text-main mb-1.5">{t("waiting_for_qr")}</h3>
          <p className="text-xs sm:text-sm text-muted max-w-md mb-6">
            {t("scanQrHint") ||
              "Open WhatsApp on your phone, go to Linked Devices, and scan this code to link Levix."}
          </p>

          {qrDataUrl ? (
            <div className="p-4 bg-white rounded-2xl shadow-xl border border-line">
              <img src={qrDataUrl} alt="WhatsApp QR Code" className="w-64 h-64 block rounded-lg" />
            </div>
          ) : status?.pairingCode ? (
            <div className="rounded-2xl border border-line bg-panel-raised p-6 max-w-sm w-full">
              <div className="text-xs font-semibold text-muted uppercase tracking-wider mb-2">
                {t("pairingCode")}
              </div>
              <div className="text-3xl font-mono font-extrabold tracking-widest text-brand-cyan">
                {status.pairingCode}
              </div>
            </div>
          ) : (
            <div className="text-sm font-medium text-muted">{t("starting")}</div>
          )}
        </div>
      )}

      {/* Diagnostics and Health Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        <div className="rounded-2xl border border-line bg-panel p-5 shadow-sm space-y-3">
          <div className="flex items-center gap-3 text-text-main">
            <Smartphone size={20} className="text-brand-cyan shrink-0" />
            <h3 className="text-sm font-bold">{t("clientIdentity")}</h3>
          </div>
          <p className="text-xs text-muted">
            {status?.user?.id ? (
              <span>
                {t("linkedAs")}{" "}
                <bdi dir="ltr" className="font-mono font-bold text-text-main">
                  {`+${status.user.id.split("@")[0]}`}
                </bdi>
              </span>
            ) : (
              t("noPhonePaired")
            )}
          </p>
          <div className="pt-2 border-t border-line text-[11px] text-faint font-mono truncate">
            {t("platformWeb")}
          </div>
        </div>

        <div className="rounded-2xl border border-line bg-panel p-5 shadow-sm space-y-3">
          <div className="flex items-center gap-3 text-text-main">
            <Database size={20} className="text-ok shrink-0" />
            <h3 className="text-sm font-bold">{t("datastoreHealth")}</h3>
          </div>
          <p className="text-xs text-muted leading-relaxed">{t("datastoreHealthy")}</p>
          <div className="pt-2 border-t border-line text-[11px] text-faint font-mono truncate">
            {t("databaseNodeSqlite")}
          </div>
        </div>

        <div className="rounded-2xl border border-line bg-panel p-5 shadow-sm space-y-3">
          <div className="flex items-center gap-3 text-text-main">
            <Shield size={20} className="text-brand-blue shrink-0" />
            <h3 className="text-sm font-bold">{t("reconnectPolicy")}</h3>
          </div>
          <p className="text-xs text-muted leading-relaxed">{t("reconnectPolicyDesc")}</p>
          <div className="pt-2 border-t border-line text-[11px] text-faint font-mono truncate">
            {t("maxAttemptsAutoPause")}
          </div>
        </div>
      </div>

      {/* Confirm Unlink Modal */}
      <Modal
        isOpen={showUnlinkModal}
        onClose={() => setShowUnlinkModal(false)}
        title={t("unlink")}
        footer={
          <div className="flex items-center justify-end gap-3 w-full">
            <button
              type="button"
              onClick={() => setShowUnlinkModal(false)}
              className="px-4 h-10 rounded-xl border border-line bg-panel-raised hover:bg-panel-hover text-text-main font-bold text-xs sm:text-sm transition-colors"
            >
              {t("cancel")}
            </button>
            <button
              type="button"
              onClick={confirmUnlink}
              className="px-4 h-10 rounded-xl bg-danger hover:bg-danger/90 text-white font-bold text-xs sm:text-sm shadow-md shadow-danger/25 transition-colors"
            >
              {t("unlink")}
            </button>
          </div>
        }
      >
        <p className="text-sm text-text-main leading-relaxed">
          Are you sure you want to unlink this WhatsApp session? You will need to scan a new QR code
          or enter a new pairing code to reconnect.
        </p>
      </Modal>
    </div>
  );
};

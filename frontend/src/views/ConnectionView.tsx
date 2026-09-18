// file: frontend/src/views/ConnectionView.tsx

import {
  AlertCircle,
  Check,
  CheckCircle2,
  Copy,
  Key,
  Phone,
  Play,
  QrCode,
  Radio,
  RefreshCw,
  RotateCcw,
  Smartphone,
  Square,
  Unlink,
} from "lucide-react";
import * as QRCode from "qrcode";
import type { FC } from "react";
import type React from "react";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { Modal } from "../components/Modal";
import { useToast } from "../components/Toasts";
import { useI18n } from "../context/I18nContext";
import type { SessionStatus } from "../types";

interface ConnectionViewProps {
  status: SessionStatus | null;
  onRefresh?: () => Promise<void>;
  onStatusUpdate?: (status: Partial<SessionStatus>) => void;
}

export const ConnectionView: FC<ConnectionViewProps> = ({
  status,
  onRefresh,
  onStatusUpdate,
}) => {
  const { t, language } = useI18n();
  const { toast } = useToast();
  const [showUnlinkModal, setShowUnlinkModal] = useState(false);
  const [acting, setActing] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [pairingMethod, setPairingMethod] = useState<"pairing" | "qr">("pairing");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [copiedCode, setCopiedCode] = useState(false);

  const state = status?.state || "idle";
  const isConnected = state === "connected";
  const isWaitingQr = state === "waiting_for_qr";
  const isStarting = state === "starting" || state === "linking";
  const isReconnecting = state === "reconnecting";
  const canUnlink = Boolean(status?.canUnlink);

  // Generate QR code locally in offline-first mode
  useEffect(() => {
    if (status?.qr) {
      const toDataURL =
        QRCode.toDataURL ||
        (QRCode as { default?: { toDataURL?: typeof QRCode.toDataURL } }).default?.toDataURL;
      if (typeof toDataURL === "function") {
        toDataURL(status.qr, {
          width: 280,
          margin: 2,
          color: {
            dark: "#0b1629",
            light: "#ffffff",
          },
        })
          .then((url: string) => setQrDataUrl(url))
          .catch(() => setQrDataUrl(null));
      }
    } else {
      setQrDataUrl(null);
    }
  }, [status?.qr]);

  // If waiting for QR but no QR is stored yet, poll rapidly until it arrives
  useEffect(() => {
    if (isWaitingQr && !status?.qr && !status?.pairingCode) {
      const timer = setInterval(() => {
        onRefresh?.();
      }, 1500);
      return () => clearInterval(timer);
    }
  }, [isWaitingQr, status?.qr, status?.pairingCode, onRefresh]);

  const handleAction = async (actionFn: () => Promise<unknown>, successMsg: string) => {
    setActing(true);
    try {
      const res = await actionFn();
      if (res && typeof res === "object" && "session" in res) {
        onStatusUpdate?.(res.session as Partial<SessionStatus>);
      }
      toast(successMsg, "success");
      await onRefresh?.();
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setActing(false);
    }
  };

  const handleStartPairing = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const cleanPhone = phoneNumber.replace(/\D/g, "");
    if (!cleanPhone) {
      toast(
        language === "ar"
          ? "يرجى إدخال رقم الهاتف مع كود الدولة أولاً."
          : "Please enter your phone number with country code.",
        "error",
      );
      return;
    }
    if (cleanPhone.startsWith("0")) {
      toast(
        language === "ar"
          ? "يرجى حذف الصفر في البداية وكتابة كود الدولة (مثلاً: 2010... وليس 010...)"
          : "Drop the leading 0 and include the country code (e.g. 2010... not 010...).",
        "error",
      );
      return;
    }
    await handleAction(
      () => api.startSession({ method: "pairing", phone: cleanPhone }),
      language === "ar" ? "جاري طلب كود الربط من واتساب..." : "Requesting pairing code...",
    );
  };

  const handleStartQr = async () => {
    await handleAction(
      () => api.startSession({ method: "qr" }),
      language === "ar" ? "جاري بدء الاتصال برمز QR..." : "Starting QR code connection...",
    );
  };

  const handleSwitchToPhone = async () => {
    await handleAction(
      api.stopSession,
      language === "ar" ? "تم الإلغاء، أدخل رقم هاتفك" : "Cancelled, enter your phone number",
    );
    setPairingMethod("pairing");
  };

  const copyPairingCode = () => {
    if (status?.pairingCode) {
      navigator.clipboard.writeText(status.pairingCode.replace(/\s+/g, ""));
      setCopiedCode(true);
      toast(language === "ar" ? "تم نسخ كود الربط!" : "Pairing code copied!", "success");
      setTimeout(() => setCopiedCode(false), 2500);
    }
  };

  const confirmUnlink = async () => {
    setShowUnlinkModal(false);
    await handleAction(
      api.unlinkSession,
      language === "ar" ? "تم إلغاء ربط الجلسة بنجاح" : "Session unlinked successfully.",
    );
  };

  const rawPhone = status?.user?.id ? status.user.id.split("@")[0].split(":")[0] : null;

  return (
    <div className="flex flex-col gap-5 sm:gap-6">
      {/* Primary Connection Hero Card */}
      <div className="rounded-2xl border border-line bg-gradient-to-br from-panel-raised via-panel to-panel p-4 sm:p-6 shadow-sm flex flex-col gap-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-line">
          <div className="flex items-center gap-3.5">
            <div
              className={`w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 border ${
                isConnected
                  ? "bg-ok/15 text-ok border-ok/30 shadow-sm shadow-ok/20"
                  : isWaitingQr
                    ? "bg-warn/15 text-warn border-warn/30 shadow-sm shadow-warn/20"
                    : isStarting || isReconnecting
                      ? "bg-brand-blue/15 text-brand-blue border-brand-blue/30 shadow-sm shadow-brand-blue/20"
                      : "bg-info/15 text-info border-info/30 shadow-sm shadow-info/20"
              }`}
            >
              <Radio size={24} />
            </div>
            <div>
              <h2 className="text-lg sm:text-xl font-extrabold text-text-main">
                {t("connection")}
              </h2>
              <p className="text-xs sm:text-sm text-muted mt-0.5">
                {isConnected ? t("sessionActive") : t("sessionOffline")}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3 self-start sm:self-auto">
            <span
              className={`inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-bold border ${
                isConnected
                  ? "bg-ok/15 text-ok border-ok/30"
                  : isWaitingQr
                    ? "bg-warn/15 text-warn border-warn/30"
                    : isStarting || isReconnecting
                      ? "bg-brand-blue/15 text-brand-blue border-brand-blue/30 animate-pulse"
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
          <div className="rounded-xl border border-warn/30 bg-warn/10 p-3.5 flex items-center gap-3 text-warn">
            <AlertCircle size={20} className="shrink-0" />
            <div className="text-xs sm:text-sm">
              <span className="font-bold">
                {language === "ar" ? "إعادة الاتصال قريباً" : "Reconnecting soon"}
              </span>{" "}
              &bull;{" "}
              <span>
                {language === "ar"
                  ? `المحاولة التالية خلال ${status.retryInSeconds} ثانية`
                  : `Next attempt in ${status.retryInSeconds}s`}
              </span>
            </div>
          </div>
        ) : null}

        {/* Connected Info Header when Active */}
        {isConnected && rawPhone && (
          <div className="rounded-xl border border-ok/30 bg-ok/10 p-3.5 sm:p-4 flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-10 h-10 rounded-xl bg-ok/20 text-ok flex items-center justify-center shrink-0">
                <CheckCircle2 size={20} />
              </div>
              <div className="min-w-0">
                <div className="text-xs text-muted font-medium">{t("connectedNumber")}</div>
                <div className="text-sm sm:text-base font-mono font-bold text-text-main" dir="ltr">
                  +{rawPhone}
                </div>
              </div>
            </div>
            <span className="text-xs font-bold text-ok px-2.5 py-1 rounded-lg bg-ok/15 border border-ok/30 shrink-0">
              {language === "ar" ? "متصل" : "Online"}
            </span>
          </div>
        )}

        {/* Action Controls: strictly conditional based on state */}
        <div>
          {/* 1. When CONNECTED: Show Stop, Reconnect, Unlink, Restart */}
          {isConnected && (
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 sm:gap-3">
              <button
                type="button"
                onClick={() => handleAction(api.stopSession, t("stop"))}
                disabled={acting}
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-6 h-12 sm:h-11 rounded-xl border border-danger/40 bg-danger/10 hover:bg-danger/20 text-danger font-bold text-sm transition-all focus-visible:ring-2 focus-visible:ring-danger/50 disabled:opacity-50"
              >
                <Square size={16} />
                <span>{t("stop")}</span>
              </button>

              <div className="flex items-center gap-2.5 w-full sm:w-auto">
                <button
                  type="button"
                  onClick={() => handleAction(api.reconnectSession, t("reconnecting"))}
                  disabled={acting}
                  className="flex-1 sm:flex-initial inline-flex items-center justify-center gap-1.5 sm:gap-2 px-4 h-11 rounded-xl border border-line bg-panel-raised hover:bg-panel-hover text-text-main font-bold text-xs sm:text-sm transition-all focus-visible:ring-2 focus-visible:ring-brand-blue/50 disabled:opacity-50"
                  title={t("reconnect")}
                >
                  <RefreshCw size={15} />
                  <span>{t("reconnect")}</span>
                </button>

                <button
                  type="button"
                  onClick={() => setShowUnlinkModal(true)}
                  disabled={acting}
                  className="flex-1 sm:flex-initial inline-flex items-center justify-center gap-1.5 sm:gap-2 px-4 h-11 rounded-xl border border-danger/30 bg-danger/10 hover:bg-danger/20 text-danger font-bold text-xs sm:text-sm transition-all focus-visible:ring-2 focus-visible:ring-danger/50 disabled:opacity-50"
                  title={t("unlink")}
                >
                  <Unlink size={15} />
                  <span>{t("unlink")}</span>
                </button>

                <button
                  type="button"
                  onClick={() => handleAction(api.restartBot, t("restart"))}
                  disabled={acting}
                  className="flex-1 sm:flex-initial inline-flex items-center justify-center gap-1.5 sm:gap-2 px-4 h-11 rounded-xl border border-line bg-panel-raised hover:bg-panel-hover text-text-main font-bold text-xs sm:text-sm transition-all focus-visible:ring-2 focus-visible:ring-brand-blue/50 disabled:opacity-50"
                  title={t("restart")}
                >
                  <RotateCcw size={15} />
                  <span>{t("restart")}</span>
                </button>
              </div>
            </div>
          )}

          {/* 2. When STARTING or LINKING or WAITING FOR QR or RECONNECTING: Show Cancel/Stop & Restart */}
          {(isStarting || isWaitingQr || isReconnecting) && (
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 sm:gap-3 w-full sm:w-auto">
              <button
                type="button"
                onClick={() => handleAction(api.stopSession, t("stop"))}
                disabled={acting}
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-6 h-12 sm:h-11 rounded-xl border border-danger/40 bg-danger/10 hover:bg-danger/20 text-danger font-bold text-sm transition-all focus-visible:ring-2 focus-visible:ring-danger/50 disabled:opacity-50"
              >
                <Square size={16} />
                <span>{language === "ar" ? "إلغاء المحاولة" : "Cancel Attempt"}</span>
              </button>

              <button
                type="button"
                onClick={() => handleAction(api.restartBot, t("restart"))}
                disabled={acting}
                className="inline-flex items-center justify-center gap-1.5 sm:gap-2 px-4 h-11 rounded-xl border border-line bg-panel-raised hover:bg-panel-hover text-text-main font-bold text-xs sm:text-sm transition-all focus-visible:ring-2 focus-visible:ring-brand-blue/50 disabled:opacity-50"
                title={t("restart")}
              >
                <RotateCcw size={15} />
                <span>{t("restart")}</span>
              </button>
            </div>
          )}

          {/* 3. When IDLE, DISCONNECTED, ERROR, LOGGED OUT: Pairing Method Selector & Input Form */}
          {!isConnected && !isStarting && !isWaitingQr && !isReconnecting && (
            <div className="flex flex-col gap-4 w-full">
              {/* Method Selector Tabs */}
              <div className="flex items-center gap-1.5 p-1 rounded-xl bg-panel-raised border border-line w-full sm:w-fit">
                <button
                  type="button"
                  onClick={() => setPairingMethod("pairing")}
                  className={`flex-1 sm:flex-initial inline-flex items-center justify-center gap-2 px-4 h-10 rounded-lg text-xs sm:text-sm font-bold transition-all ${
                    pairingMethod === "pairing"
                      ? "bg-brand-blue text-white shadow-sm shadow-brand-blue/30"
                      : "text-muted hover:text-text-main"
                  }`}
                >
                  <Smartphone size={16} />
                  <span>{language === "ar" ? "كود الربط الرقمي (الهاتف)" : "Pairing Code (Phone)"}</span>
                </button>

                <button
                  type="button"
                  onClick={() => setPairingMethod("qr")}
                  className={`flex-1 sm:flex-initial inline-flex items-center justify-center gap-2 px-4 h-10 rounded-lg text-xs sm:text-sm font-bold transition-all ${
                    pairingMethod === "qr"
                      ? "bg-brand-blue text-white shadow-sm shadow-brand-blue/30"
                      : "text-muted hover:text-text-main"
                  }`}
                >
                  <QrCode size={16} />
                  <span>{language === "ar" ? "مسح رمز QR" : "QR Code Scan"}</span>
                </button>
              </div>

              {/* Method 1: Phone Pairing Form */}
              {pairingMethod === "pairing" && (
                <form onSubmit={handleStartPairing} className="flex flex-col gap-3 max-w-xl w-full">
                  <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5">
                    <div className="relative flex-1">
                      <Phone size={17} className="absolute top-1/2 -translate-y-1/2 start-3.5 text-muted pointer-events-none" />
                      <input
                        type="tel"
                        value={phoneNumber}
                        onChange={(e) => setPhoneNumber(e.target.value)}
                        placeholder={language === "ar" ? "201012345678 (مع كود الدولة)" : "e.g. 201012345678"}
                        dir="ltr"
                        className="w-full h-12 sm:h-11 ps-10 pe-4 rounded-xl border border-line bg-panel-raised text-text-main font-mono text-sm placeholder:text-muted/60 focus:border-brand-blue focus:ring-2 focus:ring-brand-blue/20 outline-none transition-all"
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={acting}
                      className="inline-flex items-center justify-center gap-2 px-6 h-12 sm:h-11 rounded-xl bg-brand-blue hover:bg-brand-blue/90 text-white font-bold text-sm shadow-md shadow-brand-blue/25 transition-all focus-visible:ring-2 focus-visible:ring-brand-blue/50 disabled:opacity-50 shrink-0"
                    >
                      <Key size={16} />
                      <span>{language === "ar" ? "الحصول على كود الربط" : "Get Pairing Code"}</span>
                    </button>
                  </div>
                  <p className="text-xs text-muted leading-relaxed">
                    {language === "ar"
                      ? "💡 أدخل رقم هاتفك مسبوقاً بكود الدولة وبدون 0 في البداية (مثال: 2010... وليس 010...). سيظهر لك كود لإدخاله في واتساب فوراً."
                      : "💡 Enter your number with country code, no leading zeros (e.g. 2010... not 010...). A code will appear to enter into WhatsApp."}
                  </p>
                </form>
              )}

              {/* Method 2: QR Scan Start */}
              {pairingMethod === "qr" && (
                <div className="flex flex-col gap-2 max-w-xl">
                  <button
                    type="button"
                    onClick={handleStartQr}
                    disabled={acting}
                    className="inline-flex items-center justify-center gap-2 px-6 h-12 sm:h-11 rounded-xl bg-brand-blue hover:bg-brand-blue/90 text-white font-bold text-sm shadow-md shadow-brand-blue/25 transition-all focus-visible:ring-2 focus-visible:ring-brand-blue/50 disabled:opacity-50 w-full sm:w-fit"
                  >
                    <QrCode size={18} />
                    <span>{language === "ar" ? "بدء الربط عبر رمز QR" : "Start QR Linking"}</span>
                  </button>
                  <p className="text-xs text-muted">
                    {language === "ar"
                      ? "سيتم إنشاء رمز QR لمسحه من هاتف آخر أو من شاشة الحاسوب عبر كاميرا واتساب."
                      : "Generates a QR code to be scanned using WhatsApp camera on another device or screen."}
                  </p>
                </div>
              )}

              {/* Secondary Controls: Unlink & Restart */}
              <div className="flex items-center gap-2.5 pt-1">
                {canUnlink && (
                  <button
                    type="button"
                    onClick={() => setShowUnlinkModal(true)}
                    disabled={acting}
                    className="inline-flex items-center justify-center gap-1.5 sm:gap-2 px-4 h-11 rounded-xl border border-danger/30 bg-danger/10 hover:bg-danger/20 text-danger font-bold text-xs sm:text-sm transition-all focus-visible:ring-2 focus-visible:ring-danger/50 disabled:opacity-50"
                    title={t("unlink")}
                  >
                    <Unlink size={15} />
                    <span>{t("unlink")}</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => handleAction(api.restartBot, t("restart"))}
                  disabled={acting}
                  className="inline-flex items-center justify-center gap-1.5 sm:gap-2 px-4 h-11 rounded-xl border border-line bg-panel-raised hover:bg-panel-hover text-text-main font-bold text-xs sm:text-sm transition-all focus-visible:ring-2 focus-visible:ring-brand-blue/50 disabled:opacity-50"
                  title={t("restart")}
                >
                  <RotateCcw size={15} />
                  <span>{t("restart")}</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Starting / Linking Progress Feedback Card */}
      {isStarting && (
        <div className="rounded-2xl border border-line bg-panel p-6 sm:p-8 shadow-sm flex flex-col items-center text-center">
          <div className="w-12 h-12 rounded-2xl bg-brand-blue/15 text-brand-blue flex items-center justify-center mb-4 border border-brand-blue/30">
            <RefreshCw size={24} className="animate-spin" />
          </div>
          <h3 className="text-base sm:text-lg font-bold text-text-main mb-1.5">
            {state === "linking"
              ? language === "ar"
                ? "جاري إتمام الربط مع الهاتف..."
                : "Finishing link handshake..."
              : language === "ar"
                ? "جاري بدء تشغيل الجلسة..."
                : "Initializing WhatsApp session..."}
          </h3>
          <p className="text-xs sm:text-sm text-muted max-w-md">
            {language === "ar"
              ? "يتم الآن إنشاء مقبس الاتصال، ستظهر بيانات الربط خلال ثوانٍ معدودة."
              : "Creating connection socket. Pairing details will appear in just a few seconds."}
          </p>
        </div>
      )}

      {/* QR Code / Pairing Container */}
      {isWaitingQr && (
        <div className="rounded-2xl border border-line bg-panel p-6 sm:p-8 shadow-sm flex flex-col items-center text-center max-w-2xl mx-auto w-full">
          {status?.pairingCode ? (
            /* 1. Pairing Code Display with Copy Button & Steps */
            <div className="flex flex-col items-center w-full animate-in fade-in zoom-in-95 duration-300">
              <div className="w-12 h-12 rounded-2xl bg-brand-cyan/15 text-brand-cyan flex items-center justify-center mb-4 border border-brand-cyan/30">
                <Smartphone size={26} />
              </div>
              <h3 className="text-lg sm:text-xl font-bold text-text-main mb-1.5">
                {language === "ar" ? "كود الربط الرقمي مع واتساب" : "WhatsApp Pairing Code"}
              </h3>
              <p className="text-xs sm:text-sm text-muted max-w-md mb-6">
                {language === "ar"
                  ? "أدخل هذا الكود في تطبيق واتساب على هاتفك لتأكيد الربط مباشرة."
                  : "Enter this code into WhatsApp on your phone to complete pairing."}
              </p>

              <div className="rounded-2xl border-2 border-brand-cyan/40 bg-brand-cyan/10 p-5 sm:p-6 w-full max-w-md flex flex-col items-center gap-4 shadow-lg shadow-brand-cyan/10">
                <div className="text-xs font-bold text-brand-cyan uppercase tracking-wider">
                  {language === "ar" ? "كود الربط المكون من 8 خانات" : "8-Digit Pairing Code"}
                </div>
                <div
                  className="text-3xl sm:text-4xl font-mono font-extrabold tracking-widest text-brand-cyan select-all"
                  dir="ltr"
                >
                  {status.pairingCode.length === 8
                    ? `${status.pairingCode.slice(0, 4)} - ${status.pairingCode.slice(4)}`
                    : status.pairingCode}
                </div>
                <button
                  type="button"
                  onClick={copyPairingCode}
                  className="inline-flex items-center justify-center gap-2 px-6 h-11 rounded-xl bg-brand-cyan hover:bg-brand-cyan/90 text-bg font-extrabold text-sm shadow-md shadow-brand-cyan/25 transition-all active:scale-95"
                >
                  {copiedCode ? <Check size={18} /> : <Copy size={18} />}
                  <span>
                    {copiedCode
                      ? language === "ar"
                        ? "تم النسخ بنجاح!"
                        : "Copied!"
                      : language === "ar"
                        ? "نسخ كود الربط"
                        : "Copy Code"}
                  </span>
                </button>
              </div>

              {/* Instructions Box */}
              <div className="mt-6 p-4 rounded-xl border border-line bg-panel-raised text-start w-full max-w-md">
                <div className="text-xs font-bold text-text-main mb-3">
                  {language === "ar" ? "خطوات الإدخال في واتساب:" : "Steps to enter in WhatsApp:"}
                </div>
                <ol className="text-xs text-muted space-y-2 list-decimal list-inside leading-relaxed">
                  <li>{language === "ar" ? "افتح تطبيق واتساب على هاتفك." : "Open WhatsApp on your phone."}</li>
                  <li>
                    {language === "ar"
                      ? "اذهب إلى الإعدادات > الأجهزة المرتبطة > ربط جهاز."
                      : "Go to Settings > Linked Devices > Link a Device."}
                  </li>
                  <li>
                    <strong className="text-text-main">
                      {language === "ar"
                        ? "اضغط على «الربط باستخدام رقم الهاتف بدلاً من ذلك» أسفل الشاشة."
                        : "Tap 'Link with phone number instead' at bottom of screen."}
                    </strong>
                  </li>
                  <li>{language === "ar" ? "اكتب هذا الكود وسيتم ربط البوت مباشرة!" : "Enter the code above to connect immediately!"}</li>
                </ol>
              </div>
            </div>
          ) : qrDataUrl ? (
            /* 2. QR Code Display with Switch to Phone Option */
            <div className="flex flex-col items-center w-full">
              <div className="w-12 h-12 rounded-2xl bg-brand-cyan/15 text-brand-cyan flex items-center justify-center mb-4 border border-brand-cyan/30">
                <QrCode size={26} />
              </div>
              <h3 className="text-lg font-bold text-text-main mb-1.5">{t("waiting_for_qr")}</h3>
              <p className="text-xs sm:text-sm text-muted max-w-md mb-6">
                {language === "ar"
                  ? "افتح واتساب على هاتفك، اذهب إلى الأجهزة المرتبطة، ثم امسح هذا الرمز للربط."
                  : "Open WhatsApp on your phone, go to Linked Devices, and scan this code to link."}
              </p>

              <div className="p-3 sm:p-4 bg-white rounded-2xl shadow-xl border border-line animate-in fade-in zoom-in-95 duration-300">
                <img
                  src={qrDataUrl}
                  alt="WhatsApp QR Code"
                  className="w-56 h-56 sm:w-64 sm:h-64 block rounded-lg"
                />
              </div>

              {/* Helper for users on mobile who can't scan their own screen */}
              <div className="mt-6 pt-5 border-t border-line w-full max-w-md flex flex-col items-center gap-2.5">
                <p className="text-xs text-muted text-center">
                  {language === "ar"
                    ? "هل تستخدم التطبيق من نفس الهاتف ولا تستطيع مسح الرمز؟"
                    : "Using the app on the same phone and can't scan?"}
                </p>
                <button
                  type="button"
                  onClick={handleSwitchToPhone}
                  disabled={acting}
                  className="w-full inline-flex items-center justify-center gap-2 px-4 h-12 sm:h-11 rounded-xl border border-brand-cyan/40 bg-brand-cyan/10 hover:bg-brand-cyan/20 text-brand-cyan font-bold text-xs sm:text-sm transition-all focus-visible:ring-2 focus-visible:ring-brand-cyan/50"
                >
                  <Smartphone size={17} />
                  <span>
                    {language === "ar"
                      ? "الربط برقم الهاتف (كود الربط الرقمي) بدلاً من QR"
                      : "Link with Phone Pairing Code Instead"}
                  </span>
                </button>
              </div>
            </div>
          ) : (
            /* 3. Generating / Waiting Spinner */
            <div className="flex flex-col items-center gap-3 py-8 text-muted">
              <div className="w-9 h-9 border-2 border-brand-cyan border-t-transparent rounded-full animate-spin" />
              <span className="text-xs sm:text-sm font-semibold animate-pulse">
                {language === "ar"
                  ? "جاري تجهيز بيانات الربط من واتساب..."
                  : "Preparing pairing details from WhatsApp..."}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Confirm Unlink Modal */}
      <Modal
        isOpen={showUnlinkModal}
        onClose={() => setShowUnlinkModal(false)}
        title={t("unlink")}
        footer={
          <div className="flex items-center justify-end gap-2.5 w-full">
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
        <p className="text-xs sm:text-sm text-text-main leading-relaxed">
          {language === "ar"
            ? "هل أنت متأكد من رغبتك في إلغاء ربط جلسة واتساب الحالية؟ ستحتاج إلى مسح رمز QR جديد أو إدخال كود ربط لإعادة ربط الحساب."
            : "Are you sure you want to unlink this WhatsApp session? You will need to scan a new QR code or enter a pairing code to reconnect."}
        </p>
      </Modal>
    </div>
  );
};


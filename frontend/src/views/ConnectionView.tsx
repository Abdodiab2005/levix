import { userErrorMessage } from "../utils/userError";
// file: frontend/src/views/ConnectionView.tsx

import {
  AlertCircle,
  Check,
  Copy,
  Key,
  Phone,
  QrCode,
  Radio,
  RefreshCw,
  RotateCcw,
  Smartphone,
  Square,
  Unlink,
} from "lucide-react";
import * as QRCode from "qrcode";
import type React from "react";
import type { FC } from "react";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useToast } from "../components/Toasts";
import {
  Button,
  Callout,
  Card,
  Dialog,
  IconButton,
  Input,
  MenuItem,
  MenuSeparator,
  OverflowMenu,
  SegmentedControl,
  Spinner,
} from "../components/ui";
import { useI18n } from "../context/I18nContext";
import type { SessionStatus } from "../types";
import { fill } from "../utils/fill";
import { ConnectedAccountCard } from "./ConnectedAccountCard";
import { consentReasonText } from "./legal/TermsConsentDialog";

function isAndroidCompanionApp() {
  return typeof window !== "undefined" && Boolean((window as { LevixHost?: unknown }).LevixHost);
}

interface ConnectionViewProps {
  status: SessionStatus | null;
  onRefresh?: () => Promise<unknown>;
  onStatusUpdate?: (status: Partial<SessionStatus>) => void;
  onReviewTerms: () => void;
}

export const ConnectionView: FC<ConnectionViewProps> = ({
  status,
  onRefresh,
  onStatusUpdate,
  onReviewTerms,
}) => {
  const { t } = useI18n();
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
  const isConsentRequired = state === "consent_required";
  const isPaused = state === "paused";
  const isLoggedOut = state === "logged_out";
  /** An attempt or a live socket is running, so Stop / Cancel is meaningful. */
  const isRunning = isConnected || isStarting || isWaitingQr || isReconnecting;
  const linked = Boolean(status?.linked) && !isLoggedOut;
  const needsPairing = !linked;
  const unlinkIncomplete = state === "error" && status?.reason === "unlink_incomplete";
  const showPairing =
    !isConnected &&
    !isStarting &&
    !isWaitingQr &&
    !isReconnecting &&
    !isConsentRequired &&
    needsPairing &&
    !unlinkIncomplete;
  const canUnlink = Boolean(status?.canUnlink);
  const isOnline = status?.isOnline !== false;
  const resumeLabel =
    isPaused || state === "disconnected" || state === "retry_exhausted"
      ? t("connectionResumeSession")
      : t("connectionConnect");

  // Generate QR code locally in offline-first mode
  useEffect(() => {
    if (status?.qr) {
      const toDataURL =
        QRCode.toDataURL ||
        (QRCode as { default?: { toDataURL?: typeof QRCode.toDataURL } }).default?.toDataURL;
      if (typeof toDataURL === "function") {
        const styles = getComputedStyle(document.documentElement);
        const lightTheme = document.documentElement.getAttribute("data-theme") === "light";
        const dark = (
          lightTheme ? styles.getPropertyValue("--text") : styles.getPropertyValue("--bg")
        ).trim();
        const light = (
          lightTheme ? styles.getPropertyValue("--panel") : styles.getPropertyValue("--text")
        ).trim();
        toDataURL(status.qr, {
          width: 280,
          margin: 2,
          color: {
            dark,
            light,
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

  const handleAction = async (
    actionFn: () => Promise<unknown>,
    successMsg: string,
    fallbackKey: string,
  ) => {
    setActing(true);
    try {
      const res = await actionFn();
      if (res && typeof res === "object" && "session" in res) {
        onStatusUpdate?.(res.session as Partial<SessionStatus>);
      }
      toast(successMsg, "success");
      await onRefresh?.();
    } catch (err: unknown) {
      toast(userErrorMessage(t, err, fallbackKey), "error");
    } finally {
      setActing(false);
    }
  };

  const handleStartPairing = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const cleanPhone = phoneNumber.replace(/\D/g, "");
    if (!cleanPhone) {
      toast(t("connectionPhoneRequired"), "error");
      return;
    }
    if (cleanPhone.startsWith("0")) {
      toast(t("connectionDropLeadingZero"), "error");
      return;
    }
    await handleAction(
      () => api.startSession({ method: "pairing", phone: cleanPhone }),
      t("connectionRequestingPairing"),
      "sessionStartError",
    );
  };

  const handleStartQr = async () => {
    await handleAction(
      () => api.startSession({ method: "qr" }),
      t("connectionStartingQr"),
      "sessionStartError",
    );
  };

  const handleSwitchToPhone = async () => {
    await handleAction(api.stopSession, t("connectionCancelledEnterPhone"), "sessionStopError");
    setPairingMethod("pairing");
  };

  const copyPairingCode = () => {
    if (status?.pairingCode) {
      navigator.clipboard.writeText(status.pairingCode.replace(/\s+/g, ""));
      setCopiedCode(true);
      toast(t("connectionPairingCopied"), "success");
      setTimeout(() => setCopiedCode(false), 2500);
    }
  };

  const confirmUnlink = async () => {
    setShowUnlinkModal(false);
    setActing(true);
    try {
      const res = await api.unlinkSession();
      const session =
        res && typeof res === "object" && "session" in res
          ? (res.session as Partial<SessionStatus>)
          : null;
      if (session) onStatusUpdate?.(session);
      if (session?.state === "error" && session.reason === "unlink_incomplete") {
        toast(t("connectionUnlinkIncomplete"), "error");
      } else {
        toast(t("connectionUnlinked"), "success");
      }
      await onRefresh?.();
    } catch (err: unknown) {
      toast(userErrorMessage(t, err, "sessionUnlinkError"), "error");
    } finally {
      setActing(false);
    }
  };

  const hideRestart = isAndroidCompanionApp();
  const hasOverflowItems = !hideRestart || canUnlink;
  const overflowControl = hasOverflowItems ? (
    <OverflowMenu label={t("moreActions")}>
      {!hideRestart && (
        <MenuItem
          icon={<RotateCcw size={16} />}
          onSelect={() => handleAction(api.restartBot, t("restart"), "sessionRestartError")}
          disabled={acting}
        >
          {t("restart")}
        </MenuItem>
      )}
      {!hideRestart && canUnlink && <MenuSeparator />}
      {canUnlink && (
        <MenuItem
          danger
          icon={<Unlink size={16} />}
          onSelect={() => setShowUnlinkModal(true)}
          disabled={acting}
        >
          {t("unlink")}
        </MenuItem>
      )}
    </OverflowMenu>
  ) : null;

  const stopControl = isRunning ? (
    <IconButton
      label={isConnected ? t("connectionStopSession") : t("connectionCancelAttempt")}
      icon={<Square size={16} />}
      onClick={() => handleAction(api.stopSession, t("stop"), "sessionStopError")}
      disabled={acting}
    />
  ) : null;

  const reconnectControl = isConnected ? (
    <IconButton
      label={t("reconnect")}
      icon={<RefreshCw size={16} />}
      onClick={() => handleAction(api.reconnectSession, t("reconnecting"), "sessionReconnectError")}
      disabled={acting}
    />
  ) : null;

  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      <ConnectedAccountCard status={status} variant="expanded" />

      {isConnected && status?.proxyChanged ? (
        <Callout
          tone="info"
          title={t("connectionProxyChangedTitle")}
          action={
            <Button
              variant="secondary"
              size="sm"
              icon={<RefreshCw size={16} />}
              onClick={() =>
                handleAction(api.reconnectSession, t("reconnecting"), "sessionReconnectError")
              }
              disabled={acting}
            >
              {t("connectionProxyReconnect")}
            </Button>
          }
        >
          {t("connectionProxyChangedBody")}
        </Callout>
      ) : null}

      {/* The account card states the session once; this card only acts on it. */}
      <Card className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          <p className="text-xs text-muted sm:text-sm">
            {isConnected
              ? t("sessionActive")
              : isPaused
                ? t("paused")
                : linked
                  ? t("connectionSavedReady")
                  : t("sessionOffline")}
          </p>
          {isRunning && (
            <div className="flex items-center gap-1.5">
              {reconnectControl}
              {stopControl}
              {overflowControl}
            </div>
          )}
        </div>

        {status?.retryInSeconds ? (
          <div className="flex items-center gap-2.5 rounded-xl border border-warn/30 bg-warn/10 p-3 text-warn">
            <AlertCircle size={18} className="shrink-0" />
            <div className="text-xs sm:text-sm">
              <span className="font-bold">{t("connectionReconnectingSoon")}</span> &bull;{" "}
              <span>{fill(t("connectionNextAttempt"), { seconds: status.retryInSeconds })}</span>
            </div>
          </div>
        ) : null}

        {/* Known session (paused / idle / disconnected): resume, never QR or pairing codes */}
        {!isRunning && !isConsentRequired && linked && (
          <div className="flex w-full flex-col gap-3 sm:max-w-xl">
            {isPaused && (
              <p className="text-xs leading-relaxed text-muted sm:text-sm">
                {isOnline ? t("connectionPausedResume") : t("connectionPausedOffline")}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                icon={<Radio size={16} />}
                onClick={() => handleAction(api.startSession, resumeLabel, "sessionStartError")}
                disabled={acting}
                data-tour="connection-start"
              >
                {resumeLabel}
              </Button>
              {overflowControl}
            </div>
          </div>
        )}

        {/* No saved session / logged out: QR or pairing code */}
        {showPairing && (
          <div className="flex w-full flex-col gap-4" data-tour="connection-pairing">
            <SegmentedControl
              aria-label={t("connection")}
              value={pairingMethod}
              onChange={setPairingMethod}
              className="w-full sm:w-fit"
              options={[
                {
                  value: "pairing",
                  label: t("connectionPairingCodePhone"),
                  icon: <Smartphone size={16} />,
                },
                {
                  value: "qr",
                  label: t("connectionQrScan"),
                  icon: <QrCode size={16} />,
                },
              ]}
            />

            {/* Method 1: Phone Pairing Form */}
            {pairingMethod === "pairing" && (
              <form
                onSubmit={handleStartPairing}
                className="flex w-full flex-col gap-3 sm:max-w-xl"
              >
                <div className="relative">
                  <Phone
                    size={17}
                    className="pointer-events-none absolute start-3.5 top-1/2 -translate-y-1/2 text-muted"
                  />
                  <Input
                    type="tel"
                    value={phoneNumber}
                    onChange={(e) => setPhoneNumber(e.target.value)}
                    placeholder={t("connectionPhonePlaceholder")}
                    dir="ltr"
                    className="ps-10"
                  />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="submit"
                    variant="primary"
                    icon={<Key size={16} />}
                    disabled={acting}
                    data-tour="connection-start"
                  >
                    {t("connectionGetPairingCode")}
                  </Button>
                  {overflowControl}
                </div>
                <p className="text-xs leading-relaxed text-muted">{t("connectionPairingHint")}</p>
              </form>
            )}

            {/* Method 2: QR Scan Start */}
            {pairingMethod === "qr" && (
              <div className="flex w-full flex-col gap-2 sm:max-w-xl">
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="primary"
                    icon={<QrCode size={18} />}
                    onClick={handleStartQr}
                    disabled={acting}
                    data-tour="connection-start"
                  >
                    {t("connectionStartQr")}
                  </Button>
                  {overflowControl}
                </div>
                <p className="text-xs text-muted">{t("connectionQrHint")}</p>
              </div>
            )}
          </div>
        )}
      </Card>

      {unlinkIncomplete && (
        <Card className="flex flex-col items-start gap-4">
          <p className="text-sm text-text-main">{t("connectionUnlinkIncompleteHint")}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" onClick={() => setShowUnlinkModal(true)} disabled={acting}>
              {t("connectionUnlinkRetry")}
            </Button>
            {overflowControl}
          </div>
        </Card>
      )}

      {isConsentRequired && (
        <Card className="flex flex-col items-start gap-4">
          <p className="text-sm text-text-main">{consentReasonText(status?.reason, t)}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" onClick={onReviewTerms}>
              {t("legalReviewTerms")}
            </Button>
            {overflowControl}
          </div>
        </Card>
      )}

      {/* Starting / Linking progress: one line, no empty space */}
      {isStarting && (
        <Card className="flex items-center gap-3">
          <RefreshCw size={20} className="shrink-0 animate-spin text-brand-blue" aria-hidden />
          <div className="min-w-0">
            <p className="text-sm font-bold text-text-main">
              {state === "linking" ? t("connectionFinishingLink") : t("connectionInitializing")}
            </p>
            <p className="text-xs text-muted">{t("connectionCreatingSocket")}</p>
          </div>
        </Card>
      )}

      {/* QR Code / Pairing Container */}
      {isWaitingQr && (
        <Card className="mx-auto flex w-full max-w-2xl flex-col items-center text-center">
          {status?.pairingCode ? (
            /* 1. Pairing Code Display with Copy Button & Steps */
            <div className="flex flex-col items-center w-full animate-in fade-in zoom-in-95 duration-300">
              <div className="w-12 h-12 rounded-2xl bg-brand-cyan/15 text-brand-cyan flex items-center justify-center mb-4 border border-brand-cyan/30">
                <Smartphone size={26} />
              </div>
              <h3 className="text-lg sm:text-xl font-bold text-text-main mb-1.5">
                {t("connectionPairingCodeTitle")}
              </h3>
              <p className="text-xs sm:text-sm text-muted max-w-md mb-6">
                {t("connectionPairingCodeBody")}
              </p>

              <div className="rounded-2xl border-2 border-brand-cyan/40 bg-brand-cyan/10 p-5 sm:p-6 w-full max-w-md flex flex-col items-center gap-4 shadow-lg shadow-brand-cyan/10">
                <div className="text-xs font-bold text-brand-cyan uppercase tracking-wider">
                  {t("connectionEightDigit")}
                </div>
                <div
                  className="text-3xl sm:text-4xl font-mono font-extrabold tracking-widest text-brand-cyan select-all"
                  dir="ltr"
                >
                  {status.pairingCode.length === 8
                    ? `${status.pairingCode.slice(0, 4)} - ${status.pairingCode.slice(4)}`
                    : status.pairingCode}
                </div>
                <Button
                  variant="primary"
                  icon={copiedCode ? <Check size={18} /> : <Copy size={18} />}
                  onClick={copyPairingCode}
                >
                  {copiedCode ? t("connectionCopied") : t("connectionCopyCode")}
                </Button>
              </div>

              {/* Instructions Box */}
              <div className="mt-6 p-4 rounded-xl border border-line bg-panel-raised text-start w-full max-w-md">
                <div className="text-xs font-bold text-text-main mb-3">
                  {t("connectionStepsTitle")}
                </div>
                <ol className="text-xs text-muted space-y-2 list-decimal list-inside leading-relaxed">
                  <li>{t("connectionStepOpen")}</li>
                  <li>{t("connectionStepLinkedDevices")}</li>
                  <li>
                    <strong className="text-text-main">{t("connectionStepLinkWithPhone")}</strong>
                  </li>
                  <li>{t("connectionStepEnterCode")}</li>
                </ol>
              </div>
            </div>
          ) : qrDataUrl ? (
            /* 2. QR Code Display with Switch to Phone Option */
            <div className="flex flex-col items-center w-full">
              <div className="w-12 h-12 rounded-2xl bg-brand-cyan/15 text-brand-cyan flex items-center justify-center mb-4 border border-brand-cyan/30">
                <QrCode size={26} />
              </div>
              <h3 className="text-lg font-bold text-text-main mb-1.5">{t("connectionQrScan")}</h3>
              <p className="text-xs sm:text-sm text-muted max-w-md mb-6">
                {t("connectionScanHint")}
              </p>

              <div className="p-3 sm:p-4 bg-panel rounded-2xl shadow-xl border border-line animate-in fade-in zoom-in-95 duration-300">
                <img
                  src={qrDataUrl}
                  alt="WhatsApp QR Code"
                  className="w-56 h-56 sm:w-64 sm:h-64 block rounded-lg"
                />
              </div>

              {/* Helper for users on mobile who can't scan their own screen */}
              <div className="mt-6 pt-5 border-t border-line w-full max-w-md flex flex-col items-center gap-2.5">
                <p className="text-xs text-muted text-center">{t("connectionSamePhone")}</p>
                <Button
                  variant="secondary"
                  icon={<Smartphone size={16} />}
                  onClick={handleSwitchToPhone}
                  disabled={acting}
                >
                  {t("connectionLinkWithPhoneInstead")}
                </Button>
              </div>
            </div>
          ) : (
            /* 3. Generating / Waiting Spinner */
            <div className="flex flex-col items-center gap-3 py-8">
              <Spinner className="size-8" />
              <span className="text-xs sm:text-sm font-semibold text-muted animate-pulse">
                {t("connectionPreparing")}
              </span>
            </div>
          )}
        </Card>
      )}

      {/* Confirm Unlink Modal */}
      <Dialog
        isOpen={showUnlinkModal}
        onClose={() => setShowUnlinkModal(false)}
        title={t("unlink")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowUnlinkModal(false)}>
              {t("cancel")}
            </Button>
            <Button variant="danger" onClick={confirmUnlink}>
              {t("unlink")}
            </Button>
          </>
        }
      >
        <p className="text-xs sm:text-sm text-text-main leading-relaxed">
          {t("connectionUnlinkConfirm")}
        </p>
        <p className="text-xs sm:text-sm text-muted leading-relaxed mt-2">
          {t("unlinkStickersWarning")}
        </p>
      </Dialog>
    </div>
  );
};

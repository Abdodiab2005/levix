import { ExternalLink, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "../../api/client";
import {
  Button,
  Card,
  CardHeader,
  IconButton,
  Spinner,
  StatusPill,
  Toggle,
} from "../../components/ui";
import { useI18n } from "../../context/I18nContext";
import { fill } from "../../utils/fill";
import { PlusFeaturesView } from "../plus/PlusFeaturesView";
import {
  type PlusProductResult,
  type PlusPurchaseResult,
  isAndroidHost,
  plusManage,
  plusProduct,
  plusPurchase,
  plusRestore,
} from "../../utils/hostBridge";

const STATE_LABELS = {
  none: "plusStateNone",
  active: "plusStateActive",
  grace: "plusStateGrace",
  canceled: "plusStateCanceled",
  inactive: "plusStateInactive",
  expired: "plusStateExpired",
  clock: "plusStateClock",
  unverified: "plusStateUnverified",
} as const;
const EXTENSION_LABELS = {
  absent: "plusExtensionAbsent",
  inactive: "plusExtensionInactive",
  active: "plusExtensionActive",
  incompatible: "plusExtensionIncompatible",
  disabled: "plusExtensionDisabled",
  failed: "plusExtensionFailed",
} as const;
const ERROR_LABELS = {
  UNCONFIGURED: "plusNotAvailable",
  UNAVAILABLE: "plusErrorUnavailable",
  PURCHASE_INVALID: "plusErrorPurchaseInvalid",
  ACCOUNT_MISMATCH: "plusErrorAccountMismatch",
  REBIND_LIMIT: "plusErrorRebindLimit",
  RATE_LIMITED: "plusErrorRateLimited",
  UNAVAILABLE_IN_BUILD: "plusNotIncluded",
  NETWORK_ERROR: "plusErrorNetwork",
  SERVICE_TIMEOUT: "plusErrorNetwork",
  SERVICE_DISCONNECTED: "plusErrorUnavailable",
  SERVICE_UNAVAILABLE: "plusErrorUnavailable",
  BILLING_UNAVAILABLE: "plusErrorUnavailable",
  FEATURE_NOT_SUPPORTED: "plusErrorUnavailable",
  ITEM_UNAVAILABLE: "plusErrorUnavailable",
  ITEM_ALREADY_OWNED: "plusErrorAlreadyOwned",
  BUSY: "plusErrorBusy",
  network: "plusErrorNetwork",
} as const;

type PlusStatus = {
  configured: boolean;
  entitlement: { state: keyof typeof STATE_LABELS; until: string | null; reason: string | null };
  extension: { state: keyof typeof EXTENSION_LABELS; id?: string; version?: string };
};
type Operation = "subscribe" | "restore" | "refresh" | "toggle" | "manage" | "reload";
type Notice = "plusPaymentPending" | "plusPurchaseCancelled" | "plusNoPurchases";

function failure(code = "FAILED"): never {
  throw new ApiError(0, code, { code });
}

function errorCode(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 429) return "RATE_LIMITED";
    return error.code || (typeof error.data?.error === "string" ? error.data.error : "FAILED");
  }
  return "network";
}

export function PlusSettings({
  enabled,
  onEnabledChange,
}: {
  enabled: boolean;
  onEnabledChange: (value: boolean) => Promise<void>;
}) {
  const { t, language } = useI18n();
  const android = isAndroidHost();
  const [status, setStatus] = useState<PlusStatus | null>(null);
  const [product, setProduct] = useState<PlusProductResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [productLoading, setProductLoading] = useState(false);
  const [busy, setBusy] = useState<Operation | null>(null);
  const running = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => {
    let live = true;
    async function load() {
      try {
        const next = await api.get<PlusStatus>("/plus/status");
        if (!live) return;
        setStatus(next);
        setLoading(false);
        if (android && next.configured && next.extension.state !== "absent") {
          setProductLoading(true);
          const info = await plusProduct();
          if (!live) return;
          setProduct(info);
          if (!info.ok) setError(info.code || "UNAVAILABLE");
        }
      } catch (err) {
        if (live) setError(errorCode(err));
      } finally {
        if (live) {
          setLoading(false);
          setProductLoading(false);
        }
      }
    }
    void load();
    return () => {
      live = false;
    };
  }, [android]);

  async function readStatus() {
    try {
      const next = await api.get<PlusStatus>("/plus/status");
      setStatus(next);
      return next;
    } catch (err) {
      // Do not leave an old active badge visible when the current state is unknown.
      setStatus(null);
      throw err;
    }
  }

  async function run(operation: Operation, action: () => Promise<void>) {
    if (running.current || productLoading) return;
    running.current = true;
    setBusy(operation);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (err) {
      setError(errorCode(err));
    } finally {
      // Play results and even claim responses never set the displayed entitlement.
      try {
        await readStatus();
      } catch (err) {
        setError(errorCode(err));
      }
      running.current = false;
      setBusy(null);
    }
  }

  async function claim(purchase: PlusPurchaseResult) {
    if (!purchase.ok) {
      if (purchase.status === "cancelled") setNotice("plusPurchaseCancelled");
      else failure(purchase.code);
    } else if (purchase.status === "pending") {
      setNotice("plusPaymentPending");
    } else {
      const result = await api.post<{ ok: boolean; code?: string }>("/plus/claim", {
        purchaseToken: purchase.purchaseToken,
        productId: purchase.productId,
        packageName: purchase.packageName,
      });
      if (!result.ok) failure(result.code);
    }
  }

  function subscribe() {
    void run("subscribe", async () => {
      if (!product?.ok || product.billingPeriod !== "P1M") failure("UNAVAILABLE");
      const prepared = await api.post<{ installationId: string }>("/plus/prepare");
      await claim(await plusPurchase(product.offerToken, prepared.installationId));
    });
  }

  function restore() {
    void run("restore", async () => {
      const result = await plusRestore();
      if (!result.ok) failure(result.code);
      if (result.purchases.length === 0) setNotice("plusNoPurchases");
      let firstError: unknown;
      for (const purchase of result.purchases) {
        try {
          await claim(purchase);
        } catch (err) {
          firstError ??= err;
        }
      }
      if (firstError) throw firstError;
    });
  }

  function refresh() {
    void run("refresh", async () => {
      const result = await api.post<{ ok: boolean; code?: string }>("/plus/refresh");
      if (!result.ok) failure(result.code);
      const info = await plusProduct();
      setProduct(info);
      if (!info.ok) failure(info.code);
    });
  }

  const message = error
    ? t(ERROR_LABELS[error as keyof typeof ERROR_LABELS] || "plusErrorFailed")
    : null;
  if (loading) return <Spinner label={t("loading")} />;
  if (status?.extension.state === "absent")
    return <p className="text-sm text-muted">{t("plusNotIncluded")}</p>;
  if (status && !status.configured)
    return <p className="text-sm text-muted">{t("plusNotAvailable")}</p>;
  if (!status)
    return (
      <Card className="flex items-center justify-between gap-3">
        <p role="alert" className="text-sm text-danger">
          {message || t("plusErrorFailed")}
        </p>
        <IconButton
          label={t("refresh")}
          icon={<RefreshCw size={18} />}
          disabled={!!busy}
          onClick={() =>
            void run("reload", async () => {
              const next = await readStatus();
              if (android && next.configured && next.extension.state !== "absent") {
                const info = await plusProduct();
                setProduct(info);
                if (!info.ok) failure(info.code);
              }
            })
          }
        />
      </Card>
    );

  const until = status.entitlement.until ? new Date(status.entitlement.until) : null;
  const validUntil = until && Number.isFinite(until.getTime());
  const subscribed = ["active", "grace", "canceled"].includes(status.entitlement.state);
  const monthlyProduct = product?.ok && product.billingPeriod === "P1M" ? product : null;
  const disabled = !!busy || productLoading;

  return (
    <Card className="flex flex-col gap-4">
      <CardHeader
        title={t("plusTitle")}
        actions={android ? (
          <>
            <IconButton
              label={t("plusManage")}
              icon={<ExternalLink size={18} />}
              disabled={disabled}
              onClick={() =>
                void run("manage", async () => {
                  const result = plusManage();
                  if (!result.ok) failure(result.code);
                })
              }
            />
            <IconButton
              label={t("refresh")}
              icon={<RefreshCw size={18} />}
              disabled={disabled}
              loading={busy === "refresh"}
              onClick={refresh}
            />
          </>
        ) : undefined}
      />
      <div className="flex flex-wrap items-center gap-2" aria-live="polite">
        <span className="text-sm text-muted">{t("plusStatus")}</span>
        <StatusPill tone={subscribed ? "ok" : "neutral"}>
          {t(STATE_LABELS[status.entitlement.state])}
        </StatusPill>
        {validUntil && (
          <time dateTime={status.entitlement.until || undefined} className="text-sm text-muted">
            {fill(t("plusUntil"), { date: until.toLocaleString(language) })}
          </time>
        )}
      </div>
      <p className="text-sm text-muted">{t(EXTENSION_LABELS[status.extension.state])}</p>
      {!android ? (
        <p className="text-sm text-muted">{t("plusAndroidOnly")}</p>
      ) : (
        <>
          <Toggle
            label={t("plusEnabled")}
            description={t("plusEnabledDescription")}
            checked={enabled}
            disabled={disabled}
            onChange={(value) => void run("toggle", () => onEnabledChange(value))}
          />
          {productLoading && <Spinner label={t("loading")} />}
          {monthlyProduct && (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-text-main">
                {fill(t("plusPrice"), {
                  price: monthlyProduct.formattedPrice,
                  period: t("plusMonthly"),
                })}
              </p>
              {!subscribed && (
                <>
                  <p id="plus-disclosure" className="text-sm text-muted">
                    {fill(t("plusDisclosure"), { price: monthlyProduct.formattedPrice })}
                  </p>
                  <Button
                    variant="primary"
                    className="self-start"
                    aria-describedby="plus-disclosure"
                    disabled={disabled}
                    loading={busy === "subscribe"}
                    onClick={subscribe}
                  >
                    {t("plusSubscribe")}
                  </Button>
                </>
              )}
            </div>
          )}
          <Button
            variant="secondary"
            className="self-start"
            disabled={disabled}
            loading={busy === "restore"}
            onClick={restore}
          >
            {t("plusRestore")}
          </Button>
        </>
      )}
      {notice && (
        <p role="status" className="text-sm text-info">
          {t(notice)}
        </p>
      )}
      {message && (
        <p role="alert" className="text-sm text-danger">
          {message}
        </p>
      )}
      {status.extension.state === "active" && <PlusFeaturesView />}
    </Card>
  );
}

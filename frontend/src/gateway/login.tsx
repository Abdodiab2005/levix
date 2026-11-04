import { useState, type FormEvent } from "react";
import { Button, Field, Input } from "../components/ui";
import { PasswordField, type GatewayKey, type GatewayState, type GatewayText } from "./main";
import { gatewayTranslations } from "../i18n/gateway.generated";
import { navigateAfterAuth, submitGatewayForm } from "./auth-submit.mjs";

type Result = {
  ok?: boolean;
  reason?: string;
  retryAfter?: number;
  attemptsLeft?: number;
  message?: string;
};
type ErrorState = { key: GatewayKey; vars?: Record<string, string | number>; raw?: string };

const RESET_REASON_KEYS: Record<string, GatewayKey> = {
  no_session: "resetErrNoSession",
  send_failed: "resetErrSendFailed",
  no_email: "resetErrNoEmail",
  unverified: "resetErrUnverified",
  rate_limited: "resetErrRateLimited",
  locked: "resetErrLocked",
  invalid: "resetErrInvalid",
  unavailable: "resetErrUnavailable",
  throttled: "resetErrThrottled",
  wrong_code: "resetErrWrongCode",
  address_changed: "resetErrExpired",
  expired: "resetErrExpired",
  no_pending: "resetErrExpired",
  too_many_attempts: "resetErrExpired",
  mismatch: "resetErrMismatch",
  invalid_password: "resetErrInvalidPassword",
};

const RESET_ANDROID_KEYS: Record<string, GatewayKey> = {
  resetErrNoSession: "resetErrNoSessionAndroid",
  resetErrUnverified: "resetErrUnverifiedAndroid",
  resetErrLocked: "resetErrLockedAndroid",
};

async function postJson(url: string, body: object): Promise<Result> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const result = (await response.json()) as Result;
    const retry = Number(response.headers.get("Retry-After"));
    if (!result.retryAfter && Number.isFinite(retry) && retry > 0) result.retryAfter = retry;
    return result;
  } finally {
    window.clearTimeout(timeout);
  }
}

export function Login({ state, t }: { state: GatewayState; t: GatewayText }) {
  const [reset, setReset] = useState(false);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorState | null>(null);
  const [done, setDone] = useState(false);
  const [loginError, setLoginError] = useState(state.error);
  const submitLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    setBusy(true);
    setLoginError(null);
    const result = await submitGatewayForm("/login", form);
    if (result.redirect !== undefined) return navigateAfterAuth(result.redirect);
    setLoginError({ code: result.error.code, message: result.error.message || "" });
    const password = form.elements.namedItem("password") as HTMLInputElement | null;
    if (password) {
      password.value = "";
      password.focus();
    }
    setBusy(false);
  };
  const showError = (key: GatewayKey, vars?: Record<string, string | number>, raw?: string) =>
    setError({
      key: (window as Window & { LevixHost?: object }).LevixHost
        ? RESET_ANDROID_KEYS[key] || key
        : key,
      vars,
      raw,
    });
  const send = async (channel: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await postJson("/reset/request", {
        channel,
        lang: document.documentElement.lang,
      });
      if (result.ok) setSent(true);
      else {
        if (
          result.reason === "throttled" ||
          (result.reason === "rate_limited" && result.retryAfter)
        )
          showError("resetErrThrottled", { n: result.retryAfter || 60 });
        else showError(RESET_REASON_KEYS[result.reason || ""] || "resetErrStart");
      }
    } catch {
      showError("resetErrServer");
    } finally {
      setBusy(false);
    }
  };
  const complete = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const fields = new FormData(event.currentTarget);
    const values = {
      code: String(fields.get("code") ?? ""),
      password: String(fields.get("password") ?? ""),
      confirm: String(fields.get("confirm") ?? ""),
    };
    setBusy(true);
    setError(null);
    try {
      const result = await postJson("/reset/confirm", values);
      if (result.ok) {
        setDone(true);
        showError("resetDone");
        window.setTimeout(() => {
          window.location.href = "/";
        }, 900);
      } else if (result.reason === "wrong_code") {
        showError(
          RESET_REASON_KEYS.wrong_code,
          result.attemptsLeft ? { n: result.attemptsLeft } : undefined,
        );
      } else if (
        ["address_changed", "expired", "no_pending", "too_many_attempts"].includes(
          result.reason || "",
        )
      ) {
        showError(RESET_REASON_KEYS[result.reason || ""]);
        setSent(false);
      } else if (result.reason === "locked") {
        showError(RESET_REASON_KEYS.locked);
        setSent(false);
      } else if (result.reason === "throttled")
        showError(RESET_REASON_KEYS.throttled, { n: result.retryAfter || 60 });
      else if (result.reason === "mismatch") showError(RESET_REASON_KEYS.mismatch);
      else if (result.reason === "invalid_password")
        showError(RESET_REASON_KEYS.invalid_password, undefined, result.message);
      else showError("resetErrFailed");
    } catch {
      showError("resetErrServer");
    } finally {
      setBusy(false);
    }
  };
  return reset ? (
    <>
      <header>
        <Button
          variant="ghost"
          onClick={() => {
            setReset(false);
            setSent(false);
            setError(null);
          }}
        >
          {t("backToSignIn")}
        </Button>
        <p className="mt-4 text-sm text-brand-cyan">{t("resetEyebrow")}</p>
        <h1 className="text-2xl font-bold">{t("resetTitle")}</h1>
        <p className="text-muted">
          {t(
            state.recoveryEmailVerified && state.recoveryEmail
              ? "resetSubtitleChannels"
              : "resetSubtitle",
            { brand: state.brand.name },
          )}
        </p>
      </header>
      {!sent && !done && (
        <div className="space-y-3">
          <Button
            variant="primary"
            className="w-full"
            disabled={busy}
            onClick={() => send("whatsapp")}
          >
            {t("resetSend")}
          </Button>
          {state.recoveryEmailVerified && state.recoveryEmail && (
            <>
              <Button className="w-full" disabled={busy} onClick={() => send("email")}>
                {t("resetSendEmail")}
              </Button>
              <p className="text-sm text-muted">
                {t("resetEmailHint")} <strong dir="ltr">{state.recoveryEmail}</strong>
              </p>
            </>
          )}
        </div>
      )}
      {sent && !done && (
        <form onSubmit={complete} className="space-y-4">
          <Field label={t("resetCodeLabel")} htmlFor="reset-code">
            <Input
              id="reset-code"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              required
              placeholder={t("resetCodePlaceholder")}
            />
          </Field>
          <PasswordField
            id="reset-password"
            name="password"
            label={t("newPassword")}
            minLength={state.minLength}
            autoComplete="new-password"
            t={t}
          />
          <PasswordField
            id="reset-confirm"
            name="confirm"
            label={t("repeatPassword")}
            minLength={state.minLength}
            autoComplete="new-password"
            t={t}
          />
          <Button variant="primary" type="submit" className="w-full" disabled={busy}>
            {t("resetSubmit")}
          </Button>
          <Button
            variant="ghost"
            className="w-full"
            onClick={() => {
              setSent(false);
              setError(null);
            }}
          >
            {t("resetChooseChannel")}
          </Button>
        </form>
      )}
      {error && (
        <p role="alert" className="text-danger">
          {error.raw && document.documentElement.lang === "en"
            ? error.raw
            : t(error.key, error.vars)}
          {error.key === "resetErrWrongCode" && error.vars?.n
            ? ` ${t("resetErrAttemptsLeft", error.vars)}`
            : ""}
        </p>
      )}
    </>
  ) : (
    <>
      <header>
        <p className="text-sm text-brand-cyan">{t("secureAccess")}</p>
        <h1 className="text-2xl font-bold">{t("welcomeBack")}</h1>
        <p className="text-muted">{t("loginSub", { brand: state.brand.name })}</p>
      </header>
      <form action="/login" method="post" onSubmit={submitLogin} className="space-y-5">
        <PasswordField
          id="login-password"
          name="password"
          label={t("passwordLabel")}
          minLength={0}
          autoComplete="current-password"
          t={t}
        />
        <Button type="submit" variant="primary" className="w-full" disabled={busy}>
          {t("openWorkspace")}
        </Button>
      </form>
      {loginError && (
        <p role="alert" className="text-danger">
          {loginError.code && loginError.code in gatewayTranslations.en
            ? t(loginError.code as GatewayKey)
            : loginError.message}
        </p>
      )}
      <Button variant="ghost" onClick={() => setReset(true)}>
        {t("forgotPassword")}
      </Button>
    </>
  );
}

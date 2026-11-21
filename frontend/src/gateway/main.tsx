import { createRoot } from "react-dom/client";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Button, Card, Field, Input, PasswordInput } from "../components/ui";
import { gatewayTranslations } from "../i18n/gateway.generated";
import { resolveLocale } from "../i18n/locale";
import "../index.css";
import "./style.css";
import { Login } from "./login";
import { Qr } from "./qr";
import { I18nProvider } from "../context/I18nContext";
import { renderInlineMarkup } from "./inline-markup";
import { navigateAfterAuth, submitGatewayForm } from "./auth-submit.mjs";

type Language = keyof typeof gatewayTranslations;
export type GatewayKey = keyof typeof gatewayTranslations.en;
export type GatewayText = (key: GatewayKey, vars?: Record<string, string | number>) => string;
export type GatewayMarkupKey = "qrStep1" | "qrStep2" | "qrStep3" | "qrCallout";
export type GatewayMarkup = (key: GatewayMarkupKey) => ReactNode;
export type GatewayState = {
  page: "login" | "setup" | "qr";
  error: { code: string | null; message?: string } | null;
  minLength: number;
  needsCode: boolean;
  recoveryEmail: string | null;
  recoveryEmailVerified: boolean;
  qr?: string;
  brand: { name: string; tagline: string; developer: string; studio: string };
};

const state = JSON.parse(
  document.getElementById("levix-gateway-state")?.textContent || "null",
) as GatewayState;

export function useGatewayText() {
  const [language, setLanguage] = useState<Language>(() =>
    resolveLocale(document.documentElement.lang),
  );
  useEffect(() => {
    const update = () => setLanguage(resolveLocale(document.documentElement.lang));
    window.addEventListener("levix-ui-prefs", update);
    window.addEventListener("storage", update);
    return () => {
      window.removeEventListener("levix-ui-prefs", update);
      window.removeEventListener("storage", update);
    };
  }, []);
  const t = (key: GatewayKey, vars: Record<string, string | number> = {}) => {
    let value: string = gatewayTranslations[language][key] ?? gatewayTranslations.en[key];
    for (const [name, replacement] of Object.entries(vars))
      value = value.split(`{${name}}`).join(String(replacement));
    return value;
  };
  const markup: GatewayMarkup = (key) =>
    renderInlineMarkup(gatewayTranslations[language][key], false);
  return { t, markup, language };
}

export function PasswordField({
  id,
  name,
  label,
  minLength,
  autoComplete,
  t,
}: {
  id: string;
  name: string;
  label: string;
  minLength: number;
  autoComplete: string;
  t: GatewayText;
}) {
  return (
    <Field label={label} htmlFor={id}>
      <PasswordInput
        id={id}
        name={name}
        minLength={minLength || undefined}
        required
        autoComplete={autoComplete}
        placeholder={
          minLength ? t("minLengthPlaceholder", { n: minLength }) : t("passwordPlaceholder")
        }
        showLabel={t("showPassword")}
        hideLabel={t("hidePassword")}
      />
    </Field>
  );
}

function Gateway() {
  const [busy, setBusy] = useState(false);
  const [setupError, setSetupError] = useState(state.error);
  const submitSetup = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    setBusy(true);
    setSetupError(null);
    const result = await submitGatewayForm("/setup", form);
    if (result.redirect !== undefined) return navigateAfterAuth(result.redirect);
    setSetupError({ code: result.error.code });
    const names =
      result.error.code === "wrongSetupCode"
        ? ["code"]
        : ["passwordMismatch", "invalidPassword"].includes(result.error.code)
          ? ["password", "confirm"]
          : [];
    for (const name of names) {
      const input = form.elements.namedItem(name) as HTMLInputElement | null;
      if (input) input.value = "";
    }
    if (names.length) (form.elements.namedItem(names[0]) as HTMLInputElement | null)?.focus();
    setBusy(false);
  };
  const { t, markup } = useGatewayText();
  const host = (window as Window & { LevixHost?: { closePanel?: () => void } }).LevixHost;
  useEffect(() => {
    document.title = t(
      state.page === "login" ? "titleLogin" : state.page === "setup" ? "titleSetup" : "titleQr",
      { brand: state.brand.name },
    );
  });
  useEffect(() => {
    if (state.page === "qr") return;
    const engage = () => document.documentElement.classList.add("screen-guard");
    const release = () => document.documentElement.classList.remove("screen-guard");
    const visibility = () => (document.visibilityState === "hidden" ? engage() : release());
    window.addEventListener("blur", engage);
    window.addEventListener("focus", release);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("blur", engage);
      window.removeEventListener("focus", release);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
  return (
    <main className="gateway-layout flex min-h-dvh items-center justify-center bg-bg px-4 py-3 text-text-main">
      <section className="gateway-content w-full max-w-md space-y-3">
        <Card className="space-y-4 p-5 sm:p-6">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <img src="/brand/mark.svg" alt="" className="size-8 shrink-0" />
              <div className="min-w-0">
                <strong className="block truncate text-sm font-bold text-text-main sm:text-base">
                  {state.brand.name}
                </strong>
                <small className="block truncate text-xs text-muted">{t("tagline")}</small>
              </div>
            </div>
            {state.page !== "qr" && host?.closePanel && (
              <Button variant="ghost" size="sm" onClick={() => host.closePanel?.()}>
                {t("backToApp")}
              </Button>
            )}
          </div>
          {state.page === "login" ? (
            <Login state={state} t={t} />
          ) : state.page === "setup" ? (
            <>
              <header className="space-y-1">
                <h1 className="text-base font-bold text-text-main sm:text-lg">
                  {t("setupWelcome", { brand: state.brand.name })}
                </h1>
                <p className="text-xs text-muted">{t("setupSub", { n: state.minLength })}</p>
              </header>
              <form action="/setup" method="post" onSubmit={submitSetup} className="space-y-3.5">
                {state.needsCode && (
                  <Field
                    label={t("setupCodeLabel")}
                    htmlFor="setup-code"
                    description={t("setupCodeHint", { brand: state.brand.name })}
                  >
                    <Input
                      id="setup-code"
                      name="code"
                      autoComplete="off"
                      required
                      autoFocus
                      placeholder={t("setupCodePlaceholder")}
                    />
                  </Field>
                )}
                <PasswordField
                  id="setup-password"
                  name="password"
                  label={t("setupPasswordLabel")}
                  minLength={state.minLength}
                  autoComplete="new-password"
                  t={t}
                />
                <PasswordField
                  id="setup-confirm"
                  name="confirm"
                  label={t("repeatPassword")}
                  minLength={state.minLength}
                  autoComplete="new-password"
                  t={t}
                />
                <Button type="submit" variant="primary" className="w-full" disabled={busy}>
                  {t("createWorkspaceBtn")}
                </Button>
              </form>
              {setupError && (
                <p role="alert" className="text-xs text-danger">
                  {setupError.code && setupError.code in gatewayTranslations.en
                    ? t(setupError.code as GatewayKey, { n: state.minLength })
                    : t("authErrGeneric")}
                </p>
              )}
            </>
          ) : (
            <Qr initial={state.qr || ""} t={t} markup={markup} />
          )}
        </Card>
        <p className="text-center text-xs text-muted">
          {state.brand.name} {t("by")} {state.brand.developer} · {state.brand.studio}
        </p>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <I18nProvider>
    <Gateway />
  </I18nProvider>,
);

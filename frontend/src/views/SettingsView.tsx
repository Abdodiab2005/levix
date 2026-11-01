// file: frontend/src/views/SettingsView.tsx

import {
  CirclePlay,
  Compass,
  Download,
  FileText,
  Globe,
  HardDrive,
  Key,
  Lock,
  Mail,
  MessageSquareHeart,
  Save,
  Share2,
  Shield,
  Sliders,
  Terminal,
  Trash2,
  Upload,
} from "lucide-react";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "../api/client";
import { FeedbackForm } from "../components/FeedbackForm";
import { useGuidedTour } from "../components/GuidedTour";
import { useToast } from "../components/Toasts";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  Dialog,
  Field,
  FormActions,
  IconButton,
  Input,
  PasswordInput,
  SaveField,
  Select,
  Spinner,
  Tabs,
  Toggle,
  UserText,
  useDirtyForm,
  useSavedValue,
} from "../components/ui";
import { useI18n } from "../context/I18nContext";
import { LOCALES, type Language, translations } from "../i18n/translations";
import { fill } from "../utils/fill";
import { DiagnosticsView } from "./DiagnosticsView";
import { BackupView } from "./BackupView";

type SettingsTab =
  | "general"
  | "integrations"
  | "proxy"
  | "security"
  | "storage"
  | "backup"
  | "feedback"
  | "diagnostics";

const SETTINGS_TABS: SettingsTab[] = [
  "general",
  "integrations",
  "proxy",
  "security",
  "storage",
  "backup",
  "feedback",
  "diagnostics",
];

function tabFromHash(): SettingsTab {
  const parts = window.location.hash.replace(/^#\/?/, "").split("/");
  if (parts[0] === "settings" && parts[1] && SETTINGS_TABS.includes(parts[1] as SettingsTab)) {
    return parts[1] as SettingsTab;
  }
  return "general";
}

const PREFIX_PRESETS = ["!", "/", ".", "#", "$", "?"];

// Marker written by the backend's settingsTransfer service — anything else is
// not a settings file and is refused before it can touch anything.
const EXPORT_FORMAT = "levix-settings";

// UTF-8-safe base64 for handing the export to the Android host bridge.
function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

type RecoveryPhase = "email" | "code";
type TranslationKey = keyof (typeof translations)["en"];

/** The recovery relay accepts only ar and en. Every other panel language sends English. */
function recoveryMailLanguage(lang: Language): "ar" | "en" {
  if (lang === "ar") return "ar";
  return "en";
}

/** Stable relay/route codes become sentences. `backToEmail` means the code is dead. */
function recoveryMessage(
  t: (key: TranslationKey, fallback?: string) => string,
  err: unknown,
): { text: string; backToEmail: boolean } {
  const data = err instanceof ApiError ? err.data : null;
  const code = typeof data?.error === "string" ? data.error : "";
  const backToEmail = code === "expired" || code === "no_pending" || code === "too_many_attempts";
  switch (code) {
    case "invalid_email":
      return { text: t("recoveryErrInvalidEmail"), backToEmail };
    case "wrong_password":
      return { text: t("recoveryErrWrongPassword"), backToEmail };
    case "throttled":
      return {
        text: fill(t("recoveryErrThrottled"), { n: Number(data?.retryAfter) || 60 }),
        backToEmail,
      };
    case "rate_limited":
      return {
        text: data?.retryAfter
          ? fill(t("recoveryErrThrottled"), { n: data.retryAfter })
          : t("recoveryErrRateLimited"),
        backToEmail,
      };
    case "":
    case "unavailable":
      return { text: t("recoveryErrUnavailable"), backToEmail };
    case "invalid":
      return { text: t("recoveryErrInvalid"), backToEmail };
    case "wrong_code": {
      const left =
        data?.attemptsLeft == null
          ? ""
          : ` ${fill(t("recoveryErrAttemptsLeft"), { n: data.attemptsLeft })}`;
      return { text: `${t("recoveryErrWrongCode")}${left}`, backToEmail };
    }
    case "expired":
    case "no_pending":
    case "too_many_attempts":
      return { text: t("recoveryErrExpired"), backToEmail };
    default:
      return { text: t("recoveryErrFailed"), backToEmail: false };
  }
}

/**
 * Recovery email lives on the security tab, beside the password. The address
 * is verified with its own code and is never shown in full — the API returns
 * a mask. A replacement stays pending until that code is verified.
 */
function RecoveryEmailCard() {
  const { t, language } = useI18n();
  const { toast } = useToast();
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [verified, setVerified] = useState(false);
  const [needsVerification, setNeedsVerification] = useState(false);
  const [masked, setMasked] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [phase, setPhase] = useState<RecoveryPhase>("email");
  const [draft, setDraft] = useState("");
  const [current, setCurrent] = useState("");
  const [code, setCode] = useState("");
  const [sending, setSending] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getRecoveryEmail()
      .then((res) => {
        if (cancelled) return;
        setVerified(Boolean(res.verified));
        setNeedsVerification(Boolean(res.needsVerification));
        setMasked(typeof res.masked === "string" ? res.masked : null);
        setLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setLoadError(true);
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function resetDraft() {
    setPhase("email");
    setDraft("");
    setCurrent("");
    setCode("");
    setEmailError(null);
    setCodeError(null);
  }

  function startChange() {
    setEditing(true);
    resetDraft();
  }

  function cancelEdit() {
    setEditing(false);
    resetDraft();
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (sending) return;
    setSending(true);
    if (phase === "email") {
      setEmailError(null);
      try {
        await api.startRecoveryEmail(draft.trim(), current, recoveryMailLanguage(language));
        setPhase("code");
        setCurrent("");
        setCode("");
        setCodeError(null);
      } catch (err) {
        setEmailError(recoveryMessage(t, err).text);
      } finally {
        setSending(false);
      }
      return;
    }

    setCodeError(null);
    try {
      const res = await api.verifyRecoveryEmail(code.trim());
      setVerified(true);
      setNeedsVerification(false);
      setMasked(res.masked);
      setEditing(false);
      resetDraft();
      toast(t("recoveryEmailVerified"), "success");
    } catch (err) {
      const mapped = recoveryMessage(t, err);
      if (mapped.backToEmail) {
        setPhase("email");
        setCode("");
        setCodeError(null);
        setEmailError(mapped.text);
      } else {
        setCodeError(mapped.text);
      }
    } finally {
      setSending(false);
    }
  }

  async function onRemove() {
    setRemoving(true);
    try {
      await api.deleteRecoveryEmail();
      setVerified(false);
      setNeedsVerification(false);
      setMasked(null);
      setEditing(false);
      resetDraft();
      setConfirmRemove(false);
      toast(t("recoveryEmailRemoved"), "success");
    } catch (err) {
      toast(recoveryMessage(t, err).text, "error");
    } finally {
      setRemoving(false);
    }
  }

  const showForm = !loadError && loaded && (!verified || editing || phase === "code");

  return (
    <Card className="flex max-w-xl flex-col gap-4">
      <CardHeader
        icon={<Mail size={20} />}
        title={t("recoveryEmailTitle")}
        description={t("recoveryEmailDesc")}
      />

      <p className="text-xs text-muted">{t("recoveryEmailTokenPolicy")}</p>
      {needsVerification && (
        <p role="status" className="text-sm text-warn">
          {t("recoveryEmailReverify")}
        </p>
      )}

      {loadError ? (
        <p className="text-sm text-danger">{t("recoveryErrFailed")}</p>
      ) : !loaded ? (
        <Spinner className="size-5" label={t("loading")} />
      ) : masked && !editing && phase === "email" ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-bold text-text-main">{t("recoveryEmailCurrent")}</p>
            <UserText dir="ltr" className="font-mono text-sm text-text-main">
              {masked}
            </UserText>
          </div>
          <div className="flex items-center gap-2">
            {verified && (
              <Button variant="secondary" onClick={startChange}>
                {t("recoveryEmailChange")}
              </Button>
            )}
            <IconButton
              label={t("recoveryEmailRemove")}
              variant="danger"
              icon={<Trash2 size={16} />}
              onClick={() => setConfirmRemove(true)}
            />
          </div>
        </div>
      ) : null}

      {showForm && (
        <form onSubmit={onSubmit} className="flex flex-col gap-3.5">
          {verified && masked && (
            <div className="flex flex-col gap-1">
              <p className="text-xs text-muted">{t("recoveryEmailStays")}</p>
              <UserText dir="ltr" className="font-mono text-sm text-text-main">
                {masked}
              </UserText>
            </div>
          )}

          {phase === "email" ? (
            <>
              <Field label={t("recoveryEmailLabel")} htmlFor="recovery-email" error={emailError}>
                <Input
                  id="recovery-email"
                  type="text"
                  inputMode="email"
                  autoComplete="email"
                  technical
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  required
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                />
              </Field>
              <Field
                label={t("currentPassword")}
                description={t("recoveryEmailPasswordHint")}
                htmlFor="recovery-current-password"
              >
                <PasswordInput
                  id="recovery-current-password"
                  autoComplete="current-password"
                  required
                  value={current}
                  onChange={(event) => setCurrent(event.target.value)}
                />
              </Field>
            </>
          ) : (
            <Field
              label={t("recoveryEmailCode")}
              description={t("recoveryEmailCodeSent")}
              htmlFor="recovery-code"
              error={codeError}
            >
              <Input
                id="recovery-code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                technical
                className="font-mono"
                maxLength={6}
                required
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
            </Field>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" variant="primary" loading={sending}>
              {phase === "email" ? t("recoveryEmailSendCode") : t("recoveryEmailVerify")}
            </Button>
            {phase === "code" ? (
              <Button
                variant="ghost"
                onClick={() => {
                  setPhase("email");
                  setCode("");
                  setCodeError(null);
                }}
                disabled={sending}
              >
                {t("cancel")}
              </Button>
            ) : (
              editing && (
                <Button variant="ghost" onClick={cancelEdit} disabled={sending}>
                  {t("cancel")}
                </Button>
              )
            )}
          </div>
        </form>
      )}

      <ConfirmDialog
        isOpen={confirmRemove}
        onClose={() => {
          if (!removing) setConfirmRemove(false);
        }}
        onConfirm={onRemove}
        title={t("recoveryEmailRemoveTitle")}
        description={t("recoveryEmailRemoveDesc")}
        confirmLabel={t("delete")}
        cancelLabel={t("cancel")}
        variant="danger"
        loading={removing}
      />
    </Card>
  );
}

export const SettingsView: React.FC = () => {
  const { t, language, setLanguage } = useI18n();
  const { toast } = useToast();
  const guided = useGuidedTour();
  const [activeTab, setActiveTab] = useState<SettingsTab>(tabFromHash);

  useEffect(() => {
    const handleHash = () => {
      const tab = tabFromHash();
      setActiveTab((prev) => (prev !== tab ? tab : prev));
    };
    window.addEventListener("hashchange", handleHash);
    return () => window.removeEventListener("hashchange", handleHash);
  }, []);

  const handleTabChange = (tab: SettingsTab) => {
    setActiveTab(tab);
    window.location.hash = `settings/${tab}`;
  };
  const [settings, setSettings] = useState<Record<string, any>>({});
  const [configuredKeys, setConfiguredKeys] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);

  // Prefix management state
  const [prefix, setPrefix] = useState<string>("!");
  const [prefixInput, setPrefixInput] = useState<string>("!");
  const [savingPrefix, setSavingPrefix] = useState(false);

  // Password visibility & changes
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [changingPass, setChangingPass] = useState(false);

  // Settings export / import
  const [exportingSettings, setExportingSettings] = useState(false);
  const [applyingImport, setApplyingImport] = useState(false);
  const [importPreview, setImportPreview] = useState<any>(null);
  const importFileRef = useRef<HTMLInputElement>(null);

  const persistSetting = async (key: string, value: any) => {
    await api.updateSetting(key, value);
    const secret = key.endsWith("_api_key") || key === "whatsapp_proxy_password";
    if (secret) {
      setSettings((prev) => ({ ...prev, [key]: "" }));
      setConfiguredKeys((prev) => ({ ...prev, [key]: Boolean(String(value || "").trim()) }));
    } else {
      setSettings((prev) => ({ ...prev, [key]: value }));
    }
  };

  const persistToggle = async (key: string, value: boolean) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    try {
      await api.updateSetting(key, value);
      toast(t("savedSuccessfully"), "success");
    } catch (err: any) {
      toast(err.message, "error");
      await loadSettings();
    }
  };

  const panelLang = useSavedValue<Language>(language);
  const botLang = useSavedValue(String(settings["bot_language"] || "auto"));
  const aiReplyLang = useSavedValue(String(settings["ai_reply_language"] || "follow_bot"));
  const timezone = useSavedValue(String(settings["bot_timezone"] || "Africa/Cairo"));
  const connectionLogLevel = useSavedValue(String(settings["connection_log_level"] || "info"));
  const weatherKey = useSavedValue(String(settings["openweathermap_api_key"] || ""));
  const forwardTtl = useSavedValue(Number(settings["forward_score_ttl_days"] || 30));
  const maxFetch = useSavedValue(Number(settings["max_fetch_bytes"] || 524288));
  const stickerLimit = useSavedValue(Number(settings["sticker_library_limit"] || 1000));
  const autoDeleteKeep = useSavedValue(Number(settings["auto_delete_keep_days"] || 30));
  const delayForm = useDirtyForm({
    min: Number(settings["bot_min_delay_ms"] ?? 400),
    max: Number(settings["bot_max_delay_ms"] ?? 900),
  });
  const proxyForm = useDirtyForm({
    protocol: String(settings["whatsapp_proxy_protocol"] || "http"),
    host: String(settings["whatsapp_proxy_host"] || ""),
    port: Number(settings["whatsapp_proxy_port"] || 0),
    username: String(settings["whatsapp_proxy_username"] || ""),
    password: String(settings["whatsapp_proxy_password"] || ""),
  });

  const handleExportSettings = async () => {
    setExportingSettings(true);
    try {
      const payload = await api.exportSettings();
      const json = JSON.stringify(payload, null, 2);
      const fileName = `levix-settings-${payload.exportedAt?.slice(0, 10) || "export"}.json`;

      // Inside the Android host a blob download is a dead end — the WebView
      // has no download manager wired for blob: URLs, so the file would just
      // vanish. Hand the bytes to the host instead: it saves into
      // Downloads/Levix and answers with the location to show.
      const host = (window as any).LevixHost;
      if (host && typeof host.saveExportFile === "function") {
        const result = JSON.parse(host.saveExportFile(fileName, toBase64(json)));
        if (!result?.ok) throw new Error(result?.error || t("exportSettingsError"));
        toast(`${t("exportSettingsSuccess")} — ${t("exportSavedTo")} ${result.dir}`, "success");
        return;
      }

      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      link.click();
      URL.revokeObjectURL(url);
      toast(t("exportSettingsSuccess"), "success");
    } catch (err: any) {
      toast(err.message || t("exportSettingsError"), "error");
    } finally {
      setExportingSettings(false);
    }
  };

  const handleImportFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    let payload: any;
    try {
      payload = JSON.parse(await file.text());
    } catch {
      toast(t("importSettingsError"), "error");
      return;
    }
    if (payload?.format !== EXPORT_FORMAT) {
      toast(t("importSettingsError"), "error");
      return;
    }
    setImportPreview(payload);
  };

  const handleImportApply = async () => {
    if (!importPreview) return;
    setApplyingImport(true);
    try {
      const report = await api.importSettings(importPreview);
      const bits = [`${report.applied?.length || 0} ${t("importSettingsCount")}`];
      if (report.skipped?.length) {
        bits.push(`${t("importSkipped")}: ${report.skipped.length}`);
      }
      if (report.restartNeeded?.length) {
        bits.push(`${t("importRestartNeeded")}: ${report.restartNeeded.join(", ")}`);
      }
      toast(`${t("importSuccess")} — ${bits.join(" · ")}`, "success");
      setImportPreview(null);
      await loadSettings();
    } catch (err: any) {
      toast(err.message, "error");
    } finally {
      setApplyingImport(false);
    }
  };

  const loadSettings = async () => {
    try {
      const res = await api.getSettings();
      if (res?.settings) {
        const map: Record<string, any> = {};
        const conf: Record<string, boolean> = {};
        res.settings.forEach((s: any) => {
          if (s.type === "secret") {
            conf[s.key] = Boolean(s.configured);
            map[s.key] = "";
          } else {
            map[s.key] = s.value;
          }
        });
        setSettings(map);
        setConfiguredKeys(conf);
      }
      if (res?.prefix) {
        setPrefix(res.prefix);
        setPrefixInput(res.prefix);
      }
    } catch (err: any) {
      toast(err.message, "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSettings();
  }, []);

  const handleSavePrefix = async (valToSave?: string) => {
    const target = (valToSave !== undefined ? valToSave : prefixInput).trim();
    if (!target || target.length > 3) {
      toast(t("prefixValidation"), "error");
      return;
    }

    setSavingPrefix(true);
    try {
      await api.updatePrefix(target);
      setPrefix(target);
      setPrefixInput(target);
      toast(`${t("prefixUpdated")} (${target})`, "success");
    } catch (err: any) {
      toast(err.message, "error");
    } finally {
      setSavingPrefix(false);
    }
  };

  const handlePasswordChange = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      toast(t("passwordMatchError"), "error");
      return;
    }
    if (newPassword.length < 8) {
      toast(t("passwordMinLength"), "error");
      return;
    }

    setChangingPass(true);
    try {
      await api.changePassword(currentPassword, newPassword);
      toast(t("passwordChangedSuccess"), "success");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err: any) {
      toast(err.message, "error");
    } finally {
      setChangingPass(false);
    }
  };

  const saveLabels = {
    saveLabel: t("save"),
    savedLabel: t("saved"),
  };
  const formLabels = {
    saveLabel: t("save"),
    discardLabel: t("discard"),
    unsavedLabel: t("unsavedChanges"),
    savedLabel: t("saved"),
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Spinner className="size-6" label={t("loading")} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 sm:gap-6">
      <Tabs
        value={activeTab}
        onChange={(v) => handleTabChange(v as SettingsTab)}
        aria-label={t("settings")}
        className="overflow-x-auto no-scrollbar"
        options={[
          { value: "general", label: t("tabGeneral"), icon: <Sliders size={17} /> },
          { value: "integrations", label: t("tabIntegrations"), icon: <Key size={17} /> },
          { value: "proxy", label: t("tabProxy"), icon: <Globe size={17} /> },
          { value: "security", label: t("tabSecurity"), icon: <Shield size={17} /> },
          { value: "storage", label: t("tabStorage"), icon: <HardDrive size={17} /> },
          { value: "backup", label: t("tabBackup"), icon: <HardDrive size={17} /> },
          { value: "feedback", label: t("tabFeedback"), icon: <MessageSquareHeart size={17} /> },
          { value: "diagnostics", label: t("tabDiagnostics"), icon: <FileText size={17} /> },
        ]}
      />

      {activeTab === "general" && (
        <div className="flex flex-col gap-5">
          <Card className="flex flex-col gap-4 sm:gap-5" data-tour="settings-general">
            <CardHeader
              icon={<Terminal size={22} />}
              title={t("prefixTitle")}
              description={t("prefixDesc")}
              actions={
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-muted">{t("activePrefix")}:</span>
                  <Badge tone="info" className="font-mono">
                    {prefix}
                  </Badge>
                </div>
              }
            />

            <div className="flex flex-col items-stretch gap-4 sm:flex-row sm:items-center">
              <div className="flex min-w-0 flex-col gap-1.5 sm:max-w-72">
                <span className="text-xs font-semibold text-muted">{t("prefixPresets")}</span>
                <div className="flex max-w-full items-center gap-2 overflow-x-auto no-scrollbar pb-1">
                  {PREFIX_PRESETS.map((p) => {
                    const isCurrent = prefix === p;
                    return (
                      <IconButton
                        key={p}
                        label={p}
                        size="md"
                        variant={isCurrent ? "primary" : "secondary"}
                        className="shrink-0 font-mono"
                        onClick={() => {
                          setPrefixInput(p);
                          handleSavePrefix(p);
                        }}
                      >
                        {p}
                      </IconButton>
                    );
                  })}
                </div>
              </div>

              <Field label={t("changePrefix")} className="min-w-[200px] flex-1">
                <div className="flex items-center gap-2">
                  <Input
                    type="text"
                    className="h-11 w-20 text-center font-mono sm:w-24"
                    maxLength={3}
                    placeholder={t("prefixPlaceholder")}
                    value={prefixInput}
                    onChange={(e) => setPrefixInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleSavePrefix();
                    }}
                  />
                  <Button
                    variant="primary"
                    icon={<Save size={16} />}
                    onClick={() => handleSavePrefix()}
                    disabled={savingPrefix || prefixInput.trim() === prefix}
                    loading={savingPrefix}
                  >
                    {savingPrefix ? t("saving") : t("prefixSaveBtn")}
                  </Button>
                </div>
              </Field>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold text-muted sm:text-sm">
                {t("prefixPreview")}
              </span>
              <Badge tone="info" className="font-mono">
                <code>{prefixInput || prefix}help</code>
              </Badge>
              <Badge tone="info" className="font-mono">
                <code>{prefixInput || prefix}lang ar</code>
              </Badge>
              <Badge tone="info" className="font-mono">
                <code>{prefixInput || prefix}sticker</code>
              </Badge>
            </div>
          </Card>

          <Card className="flex flex-col gap-4">
            <CardHeader
              title={t("settingsBehaviorTitle")}
            />

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <SaveField
                label={t("interfaceLanguage")}
                description={t("interfaceLanguageDesc")}
                htmlFor="panel-language"
                dirty={panelLang.dirty}
                saving={panelLang.status === "saving"}
                justSaved={panelLang.status === "saved"}
                error={panelLang.error}
                onSave={() => panelLang.save(async (next) => setLanguage(next))}
                onRevert={panelLang.revert}
                {...saveLabels}
              >
                <Select
                  id="panel-language"
                  value={panelLang.value}
                  onChange={(e) => {
                    const next = e.target.value;
                    const locale = LOCALES.find((item) => item.code === next);
                    if (locale) panelLang.setValue(locale.code);
                  }}
                >
                  {LOCALES.map((locale) => (
                    <option key={locale.code} value={locale.code}>
                      {`${locale.name} (${t(locale.dir === "rtl" ? "settingsDirRtl" : "settingsDirLtr")})`}
                    </option>
                  ))}
                </Select>
              </SaveField>

              <SaveField
                label={t("botLanguage")}
                description={t("botLanguageDesc")}
                htmlFor="bot-language"
                dirty={botLang.dirty}
                saving={botLang.status === "saving"}
                justSaved={botLang.status === "saved"}
                error={botLang.error}
                onSave={() => botLang.save((next) => persistSetting("bot_language", next))}
                onRevert={botLang.revert}
                {...saveLabels}
              >
                <Select
                  id="bot-language"
                  value={botLang.value}
                  onChange={(e) => botLang.setValue(e.target.value)}
                >
                  <option value="auto">{t("langAuto")}</option>
                  <option value="ar">{t("langAr")}</option>
                  <option value="en">{t("langEn")}</option>
                  <option value="pt-BR">{t("langPtBr")}</option>
                  <option value="es-419">{t("langEs419")}</option>
                </Select>
              </SaveField>

              <SaveField
                label={t("aiReplyLanguage")}
                description={t("aiReplyLanguageDesc")}
                htmlFor="ai-reply-language"
                dirty={aiReplyLang.dirty}
                saving={aiReplyLang.status === "saving"}
                justSaved={aiReplyLang.status === "saved"}
                error={aiReplyLang.error}
                onSave={() => aiReplyLang.save((next) => persistSetting("ai_reply_language", next))}
                onRevert={aiReplyLang.revert}
                {...saveLabels}
              >
                <Select
                  id="ai-reply-language"
                  value={aiReplyLang.value}
                  onChange={(e) => aiReplyLang.setValue(e.target.value)}
                >
                  <option value="follow_bot">{t("aiLangFollowBot")}</option>
                  <option value="auto">{t("langAuto")}</option>
                  <option value="ar">{t("langAr")}</option>
                  <option value="en">{t("langEn")}</option>
                  <option value="pt-BR">{t("langPtBr")}</option>
                  <option value="es-419">{t("langEs419")}</option>
                </Select>
              </SaveField>

              <SaveField
                label={t("botTimezone")}
                description={t("botTimezoneDesc")}
                htmlFor="bot-timezone"
                dirty={timezone.dirty}
                saving={timezone.status === "saving"}
                justSaved={timezone.status === "saved"}
                error={timezone.error}
                onSave={() => timezone.save((next) => persistSetting("bot_timezone", next))}
                onRevert={timezone.revert}
                {...saveLabels}
              >
                <Input
                  id="bot-timezone"
                  type="text"
                  technical
                  className="font-mono"
                  placeholder="Africa/Cairo"
                  value={timezone.value}
                  onChange={(e) => timezone.setValue(e.target.value)}
                />
              </SaveField>
            </div>

            <form
              className="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                void delayForm.save(async (draft) => {
                  if (draft.min > draft.max) throw new Error(t("delayRangeError"));
                  await persistSetting("bot_min_delay_ms", draft.min);
                  await persistSetting("bot_max_delay_ms", draft.max);
                });
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") delayForm.revert();
              }}
            >
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field
                  label={t("botMinDelay")}
                  description={t("delaysDesc")}
                  htmlFor="bot-min-delay"
                >
                  <Input
                    id="bot-min-delay"
                    type="number"
                    value={delayForm.draft.min}
                    onChange={(e) => delayForm.setField("min", Number(e.target.value))}
                  />
                </Field>
                <Field label={t("botMaxDelay")} htmlFor="bot-max-delay">
                  <Input
                    id="bot-max-delay"
                    type="number"
                    value={delayForm.draft.max}
                    onChange={(e) => delayForm.setField("max", Number(e.target.value))}
                  />
                </Field>
              </div>
              <FormActions
                dirty={delayForm.dirty}
                saving={delayForm.status === "saving"}
                justSaved={delayForm.status === "saved"}
                error={delayForm.error}
                onDiscard={delayForm.revert}
                {...formLabels}
              />
            </form>
          </Card>

          <Card className="flex flex-col gap-4">
            <CardHeader
              icon={<Share2 size={20} />}
              title={t("shareSettingsTitle")}
              description={t("shareSettingsDesc")}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                icon={<Upload size={16} />}
                onClick={handleExportSettings}
                loading={exportingSettings}
              >
                {t("exportAction")}
              </Button>
              <Button
                variant="secondary"
                icon={<Download size={16} />}
                onClick={() => importFileRef.current?.click()}
              >
                {t("importSettings")}
              </Button>
            </div>
            <input
              ref={importFileRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={handleImportFile}
            />
          </Card>

          <Card className="flex flex-col gap-4">
            <CardHeader
              icon={<Compass size={20} />}
              title={t("tourReplayTitle")}
              description={t("tourReplayDesc")}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                icon={<CirclePlay size={16} />}
                onClick={() => guided?.startMainTour()}
              >
                {t("tourReplayAction")}
              </Button>
            </div>
          </Card>
        </div>
      )}

      {activeTab === "integrations" && (
        <Card className="flex flex-col gap-5">
          <CardHeader
            icon={<Key size={22} />}
            title={t("tabIntegrations")}
            description={t("integrationsDesc")}
          />

          <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
            <SaveField
              label={t("weatherApiKey")}
              description={t("settingsWeatherDesc")}
              htmlFor="weather-api-key"
              dirty={weatherKey.dirty}
              saving={weatherKey.status === "saving"}
              justSaved={weatherKey.status === "saved"}
              error={weatherKey.error}
              onSave={() =>
                weatherKey.save(async (next) => {
                  await persistSetting("openweathermap_api_key", next);
                  weatherKey.setValue("");
                })
              }
              onRevert={weatherKey.revert}
              {...saveLabels}
            >
              <PasswordInput
                id="weather-api-key"
                className="font-mono"
                placeholder={
                  configuredKeys.openweathermap_api_key ? "••••••••••••" : "OpenWeatherMap API Key"
                }
                value={weatherKey.value}
                onChange={(e) => weatherKey.setValue(e.target.value)}
              />
            </SaveField>
          </div>
        </Card>
      )}

      {activeTab === "proxy" && (
        <Card className="flex flex-col gap-5">
          <div className="flex items-center justify-between gap-3">
            <CardHeader
              className="min-w-0 flex-1"
              icon={<Globe size={22} />}
              title={t("proxyTitle")}
              description={t("proxyDesc")}
            />
            <Toggle
              className="shrink-0"
              checked={Boolean(settings["whatsapp_proxy_enabled"])}
              onChange={(val) => persistToggle("whatsapp_proxy_enabled", val)}
            />
          </div>

          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void proxyForm.save(async (draft) => {
                await persistSetting("whatsapp_proxy_protocol", draft.protocol);
                await persistSetting("whatsapp_proxy_host", draft.host);
                await persistSetting("whatsapp_proxy_port", draft.port);
                await persistSetting("whatsapp_proxy_username", draft.username);
                if (draft.password.trim()) {
                  await persistSetting("whatsapp_proxy_password", draft.password);
                }
                proxyForm.setDraft({ ...draft, password: "" });
              });
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") proxyForm.revert();
            }}
          >
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field label={t("proxyProtocol")} htmlFor="proxy-protocol">
                <Select
                  id="proxy-protocol"
                  value={proxyForm.draft.protocol}
                  onChange={(e) => proxyForm.setField("protocol", e.target.value)}
                >
                  <option value="http">HTTP</option>
                  <option value="https">HTTPS</option>
                  <option value="socks5">SOCKS5</option>
                </Select>
              </Field>

              <Field label={t("proxyHost")} htmlFor="proxy-host">
                <Input
                  id="proxy-host"
                  type="text"
                  technical
                  className="font-mono"
                  placeholder="proxy.example.com"
                  value={proxyForm.draft.host}
                  onChange={(e) => proxyForm.setField("host", e.target.value)}
                />
              </Field>

              <Field label={t("proxyPort")} htmlFor="proxy-port">
                <Input
                  id="proxy-port"
                  type="number"
                  placeholder="1080"
                  value={proxyForm.draft.port}
                  onChange={(e) => proxyForm.setField("port", Number(e.target.value))}
                />
              </Field>

              <Field label={t("proxyUsername")} htmlFor="proxy-username">
                <Input
                  id="proxy-username"
                  type="text"
                  technical
                  className="font-mono"
                  value={proxyForm.draft.username}
                  onChange={(e) => proxyForm.setField("username", e.target.value)}
                />
              </Field>

              <Field label={t("proxyPassword")} htmlFor="proxy-password">
                <PasswordInput
                  id="proxy-password"
                  placeholder={configuredKeys.whatsapp_proxy_password ? "••••••••••••" : undefined}
                  value={proxyForm.draft.password}
                  onChange={(e) => proxyForm.setField("password", e.target.value)}
                />
              </Field>
            </div>
            <FormActions
              dirty={proxyForm.dirty}
              saving={proxyForm.status === "saving"}
              justSaved={proxyForm.status === "saved"}
              error={proxyForm.error}
              onDiscard={proxyForm.revert}
              {...formLabels}
            />
          </form>
        </Card>
      )}

      {activeTab === "security" && (
        <div className="flex flex-col gap-5">
          <Card className="flex max-w-xl flex-col gap-4" data-tour="settings-password">
            <CardHeader icon={<Lock size={20} />} title={t("changePassword")} />

            <form onSubmit={handlePasswordChange} className="flex flex-col gap-3.5">
              <Field label={t("currentPassword")} htmlFor="current-password">
                <PasswordInput
                  id="current-password"
                  required
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                />
              </Field>

              <Field
                label={t("newPassword")}
                description={t("passwordMinLength")}
                htmlFor="new-password"
              >
                <PasswordInput
                  id="new-password"
                  required
                  minLength={8}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                />
              </Field>

              <Field label={t("confirmPassword")} htmlFor="confirm-password">
                <PasswordInput
                  id="confirm-password"
                  required
                  minLength={8}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                />
              </Field>

              <Button
                type="submit"
                variant="primary"
                className="mt-2 w-full self-start sm:w-auto"
                icon={<Save size={16} />}
                disabled={changingPass}
                loading={changingPass}
              >
                {changingPass ? t("saving") : t("save")}
              </Button>
            </form>
          </Card>

          <RecoveryEmailCard />
        </div>
      )}

      {activeTab === "storage" && (
        <Card className="flex flex-col gap-5">
          <CardHeader
            icon={<HardDrive size={22} />}
            title={t("storageTitle")}
            description={t("storageDesc")}
          />

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <SaveField
              label={t("forwardTtl")}
              description={t("forwardTtlDesc")}
              htmlFor="forward-ttl"
              dirty={forwardTtl.dirty}
              saving={forwardTtl.status === "saving"}
              justSaved={forwardTtl.status === "saved"}
              error={forwardTtl.error}
              onSave={() =>
                forwardTtl.save((next) => persistSetting("forward_score_ttl_days", next))
              }
              onRevert={forwardTtl.revert}
              {...saveLabels}
            >
              <Input
                id="forward-ttl"
                type="number"
                value={forwardTtl.value}
                onChange={(e) => forwardTtl.setValue(Number(e.target.value))}
              />
            </SaveField>

            <SaveField
              label={t("maxFetchBytes")}
              description={t("maxFetchBytesDesc")}
              htmlFor="max-fetch-bytes"
              dirty={maxFetch.dirty}
              saving={maxFetch.status === "saving"}
              justSaved={maxFetch.status === "saved"}
              error={maxFetch.error}
              onSave={() => maxFetch.save((next) => persistSetting("max_fetch_bytes", next))}
              onRevert={maxFetch.revert}
              {...saveLabels}
            >
              <Input
                id="max-fetch-bytes"
                type="number"
                value={maxFetch.value}
                onChange={(e) => maxFetch.setValue(Number(e.target.value))}
              />
            </SaveField>

            <SaveField
              label={t("stickerLibraryLimit")}
              htmlFor="sticker-library-limit"
              description={t("stickerLibraryLimitDesc")}
              dirty={stickerLimit.dirty}
              saving={stickerLimit.status === "saving"}
              justSaved={stickerLimit.status === "saved"}
              error={stickerLimit.error}
              onSave={() =>
                stickerLimit.save((next) => persistSetting("sticker_library_limit", next))
              }
              onRevert={stickerLimit.revert}
              {...saveLabels}
            >
              <Input
                id="sticker-library-limit"
                type="number"
                min={1}
                max={100000}
                value={stickerLimit.value}
                onChange={(e) => stickerLimit.setValue(Number(e.target.value))}
              />
            </SaveField>

            <SaveField
              label={t("autoDeleteKeepDays")}
              htmlFor="auto-delete-keep-days"
              description={t("autoDeleteKeepDaysDesc")}
              dirty={autoDeleteKeep.dirty}
              saving={autoDeleteKeep.status === "saving"}
              justSaved={autoDeleteKeep.status === "saved"}
              error={autoDeleteKeep.error}
              onSave={() =>
                autoDeleteKeep.save((next) => persistSetting("auto_delete_keep_days", next))
              }
              onRevert={autoDeleteKeep.revert}
              {...saveLabels}
            >
              <Input
                id="auto-delete-keep-days"
                type="number"
                min={1}
                max={365}
                value={autoDeleteKeep.value}
                onChange={(e) => autoDeleteKeep.setValue(Number(e.target.value))}
              />
            </SaveField>
          </div>
        </Card>
      )}

      {activeTab === "feedback" && (
        <div data-tour="settings-feedback">
          <FeedbackForm />
        </div>
      )}

      {activeTab === "backup" && <BackupView />}

      {activeTab === "diagnostics" && (
        <div data-tour="settings-diagnostics" className="flex flex-col gap-5">
          <Card>
            <SaveField
              label={t("connectionLogLevel")}
              description={t("connectionLogLevelDesc")}
              htmlFor="connection-log-level"
              dirty={connectionLogLevel.dirty}
              saving={connectionLogLevel.status === "saving"}
              justSaved={connectionLogLevel.status === "saved"}
              error={connectionLogLevel.error}
              onSave={() =>
                connectionLogLevel.save((next) => persistSetting("connection_log_level", next))
              }
              onRevert={connectionLogLevel.revert}
              {...saveLabels}
            >
              <Select
                id="connection-log-level"
                value={connectionLogLevel.value}
                onChange={(e) => connectionLogLevel.setValue(e.target.value)}
              >
                <option value="silent">{t("connectionLogOff")}</option>
                <option value="error">{t("connectionLogError")}</option>
                <option value="warn">{t("connectionLogWarn")}</option>
                <option value="info">{t("connectionLogInfo")}</option>
                <option value="debug">{t("connectionLogDebug")}</option>
                <option value="trace">{t("connectionLogTrace")}</option>
              </Select>
            </SaveField>
          </Card>
          <DiagnosticsView />
        </div>
      )}

      {/* Import confirmation: the file is about to overwrite this install's
          settings, so the operator sees what is in it before it lands. */}
      <Dialog
        isOpen={!!importPreview}
        onClose={() => setImportPreview(null)}
        title={t("importTitle")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setImportPreview(null)}>
              {t("cancel")}
            </Button>
            <Button
              variant="primary"
              onClick={handleImportApply}
              disabled={applyingImport}
              loading={applyingImport}
            >
              {t("importApply")}
            </Button>
          </>
        }
      >
        {importPreview && (
          <div className="flex flex-col gap-3 text-xs text-text-main sm:text-sm">
            <p className="text-muted">{t("importSummary")}</p>
            <ul className="flex flex-col gap-1.5 rounded-xl border border-line bg-panel-raised p-4">
              <li>
                {t("importPrefix")}:{" "}
                <span className="font-mono font-bold">{importPreview.commands?.prefix}</span>
              </li>
              <li>
                {Object.keys(importPreview.settings || {}).length} {t("importSettingsCount")}
              </li>
              <li>
                {Object.keys(importPreview.commands?.permissions || {}).length}{" "}
                {t("importPermissionsCount")}
              </li>
              <li>
                {Object.keys(importPreview.commands?.aliases || {}).length}{" "}
                {t("importAliasesCount")}
              </li>
              <li>
                {(importPreview.commands?.disabled || []).length} {t("importDisabledCount")}
              </li>
            </ul>
          </div>
        )}
      </Dialog>
    </div>
  );
};

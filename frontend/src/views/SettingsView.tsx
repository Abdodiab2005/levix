// file: frontend/src/views/SettingsView.tsx

import {
  Download,
  Eye,
  EyeOff,
  Globe,
  HardDrive,
  Key,
  Lock,
  MessageSquareHeart,
  Save,
  Share2,
  Shield,
  Sliders,
  Terminal,
  Upload,
} from "lucide-react";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { FeedbackForm } from "../components/FeedbackForm";
import { Modal } from "../components/Modal";
import { useToast } from "../components/Toasts";
import { Toggle } from "../components/Toggle";
import { useI18n } from "../context/I18nContext";
import { cn } from "../utils/cn";

type SettingsTab = "general" | "integrations" | "proxy" | "security" | "storage" | "feedback";

const PREFIX_PRESETS = ["!", "/", ".", "#", "$", "?"];

// Marker written by the backend's settingsTransfer service — anything else is
// not a settings file and is refused before it can touch anything.
const EXPORT_FORMAT = "levix-settings";

export const SettingsView: React.FC = () => {
  const { t, language, setLanguage } = useI18n();
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");
  const [settings, setSettings] = useState<Record<string, any>>({});
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

  // Secret toggles
  const [showProxyPass, setShowProxyPass] = useState(false);
  const [showPanelPass, setShowPanelPass] = useState(false);
  const [showWeatherKey, setShowWeatherKey] = useState(false);
  const [showYoutubeKey, setShowYoutubeKey] = useState(false);

  // Settings export / import
  const [exportingSettings, setExportingSettings] = useState(false);
  const [applyingImport, setApplyingImport] = useState(false);
  const [importPreview, setImportPreview] = useState<any>(null);
  const importFileRef = useRef<HTMLInputElement>(null);

  const handleExportSettings = async () => {
    setExportingSettings(true);
    try {
      const payload = await api.exportSettings();
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `levix-settings-${payload.exportedAt?.slice(0, 10) || "export"}.json`;
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
        res.settings.forEach((s: any) => {
          map[s.key] = s.value;
        });
        setSettings(map);
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

  const updateSetting = async (key: string, value: any) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    try {
      await api.updateSetting(key, value);
      toast(t("savedSuccessfully"), "success");
    } catch (err: any) {
      toast(err.message, "error");
    }
  };

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

  if (loading) {
    return (
      <div className="flex items-center justify-center p-12 text-muted">
        <div className="w-6 h-6 border-2 border-brand-cyan border-t-transparent rounded-full animate-spin mr-2" />
        <span className="text-sm font-semibold">{t("loading")}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 sm:gap-6">
      {/* Settings Navigation Bar - Mobile-first horizontal scroll */}
      <div
        role="tablist"
        aria-label="Settings Categories"
        className="flex items-center gap-1.5 p-1.5 rounded-2xl bg-panel border border-line overflow-x-auto no-scrollbar shadow-sm"
      >
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "general"}
          onClick={() => setActiveTab("general")}
          className={cn(
            "flex items-center gap-2 px-3.5 py-2.5 min-h-[44px] rounded-xl font-bold text-xs sm:text-sm whitespace-nowrap transition-all focus-visible:ring-2 focus-visible:ring-brand-blue/50",
            activeTab === "general"
              ? "bg-brand-blue text-white shadow-md shadow-brand-blue/25"
              : "text-muted hover:text-text-main hover:bg-panel-hover",
          )}
        >
          <Sliders size={17} className="shrink-0" />
          <span>{t("tabGeneral")}</span>
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "integrations"}
          onClick={() => setActiveTab("integrations")}
          className={cn(
            "flex items-center gap-2 px-3.5 py-2.5 min-h-[44px] rounded-xl font-bold text-xs sm:text-sm whitespace-nowrap transition-all focus-visible:ring-2 focus-visible:ring-brand-blue/50",
            activeTab === "integrations"
              ? "bg-brand-blue text-white shadow-md shadow-brand-blue/25"
              : "text-muted hover:text-text-main hover:bg-panel-hover",
          )}
        >
          <Key size={17} className="shrink-0" />
          <span>{t("tabIntegrations")}</span>
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "proxy"}
          onClick={() => setActiveTab("proxy")}
          className={cn(
            "flex items-center gap-2 px-3.5 py-2.5 min-h-[44px] rounded-xl font-bold text-xs sm:text-sm whitespace-nowrap transition-all focus-visible:ring-2 focus-visible:ring-brand-blue/50",
            activeTab === "proxy"
              ? "bg-brand-blue text-white shadow-md shadow-brand-blue/25"
              : "text-muted hover:text-text-main hover:bg-panel-hover",
          )}
        >
          <Globe size={17} className="shrink-0" />
          <span>{t("tabProxy")}</span>
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "security"}
          onClick={() => setActiveTab("security")}
          className={cn(
            "flex items-center gap-2 px-3.5 py-2.5 min-h-[44px] rounded-xl font-bold text-xs sm:text-sm whitespace-nowrap transition-all focus-visible:ring-2 focus-visible:ring-brand-blue/50",
            activeTab === "security"
              ? "bg-brand-blue text-white shadow-md shadow-brand-blue/25"
              : "text-muted hover:text-text-main hover:bg-panel-hover",
          )}
        >
          <Shield size={17} className="shrink-0" />
          <span>{t("tabSecurity")}</span>
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "storage"}
          onClick={() => setActiveTab("storage")}
          className={cn(
            "flex items-center gap-2 px-3.5 py-2.5 min-h-[44px] rounded-xl font-bold text-xs sm:text-sm whitespace-nowrap transition-all focus-visible:ring-2 focus-visible:ring-brand-blue/50",
            activeTab === "storage"
              ? "bg-brand-blue text-white shadow-md shadow-brand-blue/25"
              : "text-muted hover:text-text-main hover:bg-panel-hover",
          )}
        >
          <HardDrive size={17} className="shrink-0" />
          <span>{t("tabStorage")}</span>
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "feedback"}
          onClick={() => setActiveTab("feedback")}
          className={cn(
            "flex items-center gap-2 px-3.5 py-2.5 min-h-[44px] rounded-xl font-bold text-xs sm:text-sm whitespace-nowrap transition-all focus-visible:ring-2 focus-visible:ring-brand-blue/50",
            activeTab === "feedback"
              ? "bg-brand-blue text-white shadow-md shadow-brand-blue/25"
              : "text-muted hover:text-text-main hover:bg-panel-hover",
          )}
        >
          <MessageSquareHeart size={17} className="shrink-0" />
          <span>{t("tabFeedback")}</span>
        </button>
      </div>

      {/* ====================================================================
          TAB 1: General & Prefix
         ==================================================================== */}
      {activeTab === "general" && (
        <div className="flex flex-col gap-5">
          {/* Hero Prefix Customization Card */}
          <div className="rounded-2xl border border-line bg-gradient-to-br from-panel-raised to-panel p-4 sm:p-6 shadow-sm flex flex-col gap-4 sm:gap-5">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-line">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 sm:w-11 sm:h-11 rounded-xl bg-brand-cyan/10 text-brand-cyan flex items-center justify-center shrink-0">
                  <Terminal size={22} />
                </div>
                <div>
                  <h3 className="text-base sm:text-lg font-bold text-text-main">
                    {t("prefixTitle")}
                  </h3>
                  <p className="text-xs sm:text-sm text-muted mt-0.5">{t("prefixDesc")}</p>
                </div>
              </div>

              <div className="flex items-center gap-2 self-start sm:self-auto">
                <span className="text-xs text-muted font-semibold">{t("activePrefix")}:</span>
                <span className="inline-flex items-center justify-center px-3 py-1 rounded-lg bg-brand-cyan/15 text-brand-cyan font-mono font-bold text-base border border-brand-cyan/30 shadow-sm">
                  {prefix}
                </span>
              </div>
            </div>

            {/* Quick Presets & Custom Input */}
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-4 pt-1">
              <div className="flex flex-col gap-1.5">
                <span className="text-xs text-muted font-semibold">{t("prefixPresets")}</span>
                <div className="flex items-center gap-2 flex-wrap">
                  {PREFIX_PRESETS.map((p) => {
                    const isCurrent = prefix === p;
                    return (
                      <button
                        key={p}
                        type="button"
                        className={cn(
                          "w-10 h-10 sm:w-11 sm:h-11 rounded-xl border font-mono font-bold text-sm transition-all flex items-center justify-center focus-visible:ring-2 focus-visible:ring-brand-blue/50",
                          isCurrent
                            ? "bg-brand-cyan text-slate-900 border-brand-cyan shadow-sm"
                            : "bg-panel-raised border-line text-text-main hover:bg-panel-hover",
                        )}
                        onClick={() => {
                          setPrefixInput(p);
                          handleSavePrefix(p);
                        }}
                      >
                        {p}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="flex flex-col gap-1.5 flex-1 min-w-[200px]">
                <span className="text-xs text-muted font-semibold">{t("changePrefix")}</span>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    className="w-20 sm:w-24 h-11 px-3 text-center font-mono font-bold text-base rounded-xl border border-line bg-panel text-text-main focus:outline-none focus:ring-2 focus:ring-brand-blue/50 shrink-0"
                    maxLength={3}
                    placeholder={t("prefixPlaceholder")}
                    value={prefixInput}
                    onChange={(e) => setPrefixInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleSavePrefix();
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => handleSavePrefix()}
                    disabled={savingPrefix || prefixInput.trim() === prefix}
                    className="inline-flex items-center justify-center gap-2 px-4 h-11 rounded-xl bg-brand-blue hover:bg-brand-blue/90 text-white font-bold text-xs sm:text-sm whitespace-nowrap transition-all shadow-md shadow-brand-blue/20 focus-visible:ring-2 focus-visible:ring-brand-blue/50 disabled:opacity-50"
                  >
                    <Save size={16} />
                    <span>{savingPrefix ? t("saving") : t("prefixSaveBtn")}</span>
                  </button>
                </div>
              </div>
            </div>

            {/* Live Command Syntax Preview */}
            <div className="rounded-xl bg-bg-soft/70 border border-line p-3 flex flex-wrap items-center gap-2 text-xs sm:text-sm">
              <span className="font-semibold text-muted">{t("prefixPreview")}</span>
              <div className="px-2 py-0.5 rounded-lg bg-panel border border-line font-mono font-medium text-brand-cyan text-xs">
                <code>{prefixInput || prefix}help</code>
              </div>
              <div className="px-2 py-0.5 rounded-lg bg-panel border border-line font-mono font-medium text-brand-cyan text-xs">
                <code>{prefixInput || prefix}lang ar</code>
              </div>
              <div className="px-2 py-0.5 rounded-lg bg-panel border border-line font-mono font-medium text-brand-cyan text-xs">
                <code>{prefixInput || prefix}sticker</code>
              </div>
            </div>
          </div>

          {/* Bot Behavior & Localization */}
          <div className="rounded-2xl border border-line bg-panel p-4 sm:p-6 shadow-sm flex flex-col gap-4">
            <h3 className="text-base sm:text-lg font-bold text-text-main">
              {language === "ar" ? "سلوك النظام والردود" : "System Behavior & Delays"}
            </h3>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {/* Interface Language */}
              <div className="space-y-1.5">
                <label className="block text-xs sm:text-sm font-bold text-text-main">
                  {t("interfaceLanguage")}
                </label>
                <select
                  className="w-full h-11 px-3 rounded-xl border border-line bg-panel-raised text-text-main text-xs sm:text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                  value={language}
                  onChange={(e) => setLanguage(e.target.value as any)}
                >
                  <option value="ar">العربية (RTL - اليمين لليسار)</option>
                  <option value="en">English (LTR - Left to Right)</option>
                </select>
                <span className="block text-[11px] text-muted">{t("interfaceLanguageDesc")}</span>
              </div>

              {/* Bot Response Language */}
              <div className="space-y-1.5">
                <label className="block text-xs sm:text-sm font-bold text-text-main">
                  {t("botLanguage")}
                </label>
                <select
                  className="w-full h-11 px-3 rounded-xl border border-line bg-panel-raised text-text-main text-xs sm:text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                  value={settings["bot_language"] || "auto"}
                  onChange={(e) => updateSetting("bot_language", e.target.value)}
                >
                  <option value="auto">{t("langAuto")}</option>
                  <option value="ar">{t("langAr")}</option>
                  <option value="en">{t("langEn")}</option>
                </select>
                <span className="block text-[11px] text-muted">{t("botLanguageDesc")}</span>
              </div>

              {/* Timezone */}
              <div className="space-y-1.5">
                <label className="block text-xs sm:text-sm font-bold text-text-main">
                  {t("botTimezone")}
                </label>
                <input
                  type="text"
                  className="w-full h-11 px-3.5 rounded-xl border border-line bg-panel-raised font-mono text-text-main text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                  placeholder="Africa/Cairo"
                  value={settings["bot_timezone"] || "Africa/Cairo"}
                  onChange={(e) => setSettings({ ...settings, bot_timezone: e.target.value })}
                  onBlur={(e) => updateSetting("bot_timezone", e.target.value)}
                />
                <span className="block text-[11px] text-muted">{t("botTimezoneDesc")}</span>
              </div>

              {/* Reply Delays */}
              <div className="space-y-1.5">
                <label className="block text-xs sm:text-sm font-bold text-text-main">
                  {t("botMinDelay")}
                </label>
                <input
                  type="number"
                  className="w-full h-11 px-3.5 rounded-xl border border-line bg-panel-raised text-text-main text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                  value={settings["bot_min_delay_ms"] || 400}
                  onChange={(e) =>
                    setSettings({ ...settings, bot_min_delay_ms: Number(e.target.value) })
                  }
                  onBlur={(e) => updateSetting("bot_min_delay_ms", Number(e.target.value))}
                />
                <span className="block text-[11px] text-muted">{t("delaysDesc")}</span>
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs sm:text-sm font-bold text-text-main">
                  {t("botMaxDelay")}
                </label>
                <input
                  type="number"
                  className="w-full h-11 px-3.5 rounded-xl border border-line bg-panel-raised text-text-main text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                  value={settings["bot_max_delay_ms"] || 900}
                  onChange={(e) =>
                    setSettings({ ...settings, bot_max_delay_ms: Number(e.target.value) })
                  }
                  onBlur={(e) => updateSetting("bot_max_delay_ms", Number(e.target.value))}
                />
              </div>
            </div>
          </div>

          {/* Share settings: export / import */}
          <div className="rounded-2xl border border-line bg-panel p-4 sm:p-6 shadow-sm flex flex-col gap-4">
            <div className="flex items-center gap-3 pb-3 border-b border-line">
              <div className="w-10 h-10 rounded-xl bg-brand-blue/10 text-brand-blue flex items-center justify-center shrink-0">
                <Share2 size={20} />
              </div>
              <div>
                <h3 className="text-base sm:text-lg font-bold text-text-main">
                  {t("shareSettingsTitle")}
                </h3>
                <p className="text-xs sm:text-sm text-muted mt-0.5">{t("shareSettingsDesc")}</p>
              </div>
            </div>

            <div className="flex flex-col sm:flex-row gap-3">
              <button
                type="button"
                onClick={handleExportSettings}
                disabled={exportingSettings}
                className="flex-1 inline-flex items-center justify-center gap-2 px-5 h-11 rounded-xl bg-brand-blue hover:bg-brand-blue/90 text-white font-bold text-xs sm:text-sm shadow-md shadow-brand-blue/20 transition-all focus-visible:ring-2 focus-visible:ring-brand-blue/50 disabled:opacity-50"
              >
                <Download size={16} />
                <span>{t("exportSettings")}</span>
              </button>

              <button
                type="button"
                onClick={() => importFileRef.current?.click()}
                className="flex-1 inline-flex items-center justify-center gap-2 px-5 h-11 rounded-xl border border-line bg-panel-raised hover:bg-panel-hover text-text-main font-bold text-xs sm:text-sm transition-all focus-visible:ring-2 focus-visible:ring-brand-blue/50"
              >
                <Upload size={16} />
                <span>{t("importSettings")}</span>
              </button>
              <input
                ref={importFileRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={handleImportFile}
              />
            </div>
          </div>
        </div>
      )}

      {/* ====================================================================
          TAB 2: Integrations & API Keys
         ==================================================================== */}
      {activeTab === "integrations" && (
        <div className="rounded-2xl border border-line bg-panel p-4 sm:p-6 shadow-sm flex flex-col gap-5">
          <div className="flex items-center gap-3.5 pb-4 border-b border-line">
            <div className="w-11 h-11 rounded-xl bg-brand-cyan/10 text-brand-cyan flex items-center justify-center shrink-0">
              <Key size={22} />
            </div>
            <div>
              <h3 className="text-base sm:text-lg font-bold text-text-main">
                {t("tabIntegrations")}
              </h3>
              <p className="text-xs sm:text-sm text-muted mt-0.5">{t("integrationsDesc")}</p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {/* OpenWeatherMap API Key */}
            <div className="rounded-xl border border-line bg-panel-raised p-4 flex flex-col justify-between gap-3">
              <div>
                <label className="block text-xs sm:text-sm font-bold text-text-main mb-1">
                  {t("weatherApiKey")}
                </label>
                <p className="text-xs text-muted mb-3">
                  {language === "ar"
                    ? "مطلوب لتشغيل أمر الطقس والأحوال الجوية !weather"
                    : "Required for the !weather forecast command"}
                </p>
                <div className="relative">
                  <input
                    type={showWeatherKey ? "text" : "password"}
                    className="w-full h-11 px-3.5 pe-11 rounded-xl border border-line bg-panel text-text-main font-mono text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                    placeholder="OpenWeatherMap API Key"
                    value={settings["openweathermap_api_key"] || ""}
                    onChange={(e) =>
                      setSettings({ ...settings, openweathermap_api_key: e.target.value })
                    }
                    onBlur={(e) => updateSetting("openweathermap_api_key", e.target.value)}
                  />
                  <button
                    type="button"
                    onClick={() => setShowWeatherKey(!showWeatherKey)}
                    className="absolute top-1.5 end-1.5 w-8 h-8 rounded-lg flex items-center justify-center text-muted hover:text-text-main transition-colors"
                  >
                    {showWeatherKey ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>
            </div>

            {/* YouTube Data API Key */}
            <div className="rounded-xl border border-line bg-panel-raised p-4 flex flex-col justify-between gap-3">
              <div>
                <label className="block text-xs sm:text-sm font-bold text-text-main mb-1">
                  {t("youtubeApiKey")}
                </label>
                <p className="text-xs text-muted mb-3">
                  {language === "ar"
                    ? "مطلوب لأدوات البحث ومعلومات الفيديوهات من يوتيوب"
                    : "Required for YouTube search and video tools"}
                </p>
                <div className="relative">
                  <input
                    type={showYoutubeKey ? "text" : "password"}
                    className="w-full h-11 px-3.5 pe-11 rounded-xl border border-line bg-panel text-text-main font-mono text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                    placeholder="YouTube Data API Key"
                    value={settings["youtube_api_key"] || ""}
                    onChange={(e) => setSettings({ ...settings, youtube_api_key: e.target.value })}
                    onBlur={(e) => updateSetting("youtube_api_key", e.target.value)}
                  />
                  <button
                    type="button"
                    onClick={() => setShowYoutubeKey(!showYoutubeKey)}
                    className="absolute top-1.5 end-1.5 w-8 h-8 rounded-lg flex items-center justify-center text-muted hover:text-text-main transition-colors"
                  >
                    {showYoutubeKey ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ====================================================================
          TAB 3: WhatsApp Proxy
         ==================================================================== */}
      {activeTab === "proxy" && (
        <div className="rounded-2xl border border-line bg-panel p-4 sm:p-6 shadow-sm flex flex-col gap-5">
          <div className="flex items-center justify-between gap-3 pb-4 border-b border-line">
            <div className="flex items-center gap-3.5 min-w-0 flex-1">
              <div className="w-11 h-11 rounded-xl bg-blue-500/10 text-brand-blue flex items-center justify-center shrink-0">
                <Globe size={22} />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-base sm:text-lg font-bold text-text-main truncate">
                  {t("proxyTitle")}
                </h3>
                <p className="text-xs sm:text-sm text-muted mt-0.5 truncate">{t("proxyDesc")}</p>
              </div>
            </div>
            <div className="shrink-0">
              <Toggle
                checked={Boolean(settings["whatsapp_proxy_enabled"])}
                onChange={(val) => updateSetting("whatsapp_proxy_enabled", val)}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <label className="block text-xs sm:text-sm font-bold text-text-main">
                {t("proxyProtocol")}
              </label>
              <select
                className="w-full h-11 px-3.5 rounded-xl border border-line bg-panel-raised text-text-main text-xs sm:text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                value={settings["whatsapp_proxy_protocol"] || "http"}
                onChange={(e) => updateSetting("whatsapp_proxy_protocol", e.target.value)}
              >
                <option value="http">HTTP</option>
                <option value="https">HTTPS</option>
                <option value="socks5">SOCKS5</option>
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs sm:text-sm font-bold text-text-main">
                {t("proxyHost")}
              </label>
              <input
                type="text"
                className="w-full h-11 px-3.5 rounded-xl border border-line bg-panel-raised font-mono text-text-main text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                placeholder="proxy.example.com"
                value={settings["whatsapp_proxy_host"] || ""}
                onChange={(e) => setSettings({ ...settings, whatsapp_proxy_host: e.target.value })}
                onBlur={(e) => updateSetting("whatsapp_proxy_host", e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs sm:text-sm font-bold text-text-main">
                {t("proxyPort")}
              </label>
              <input
                type="number"
                className="w-full h-11 px-3.5 rounded-xl border border-line bg-panel-raised text-text-main text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                placeholder="1080"
                value={settings["whatsapp_proxy_port"] || ""}
                onChange={(e) =>
                  setSettings({ ...settings, whatsapp_proxy_port: Number(e.target.value) })
                }
                onBlur={(e) => updateSetting("whatsapp_proxy_port", Number(e.target.value))}
              />
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs sm:text-sm font-bold text-text-main">
                {t("proxyUsername")}
              </label>
              <input
                type="text"
                className="w-full h-11 px-3.5 rounded-xl border border-line bg-panel-raised font-mono text-text-main text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                value={settings["whatsapp_proxy_username"] || ""}
                onChange={(e) =>
                  setSettings({ ...settings, whatsapp_proxy_username: e.target.value })
                }
                onBlur={(e) => updateSetting("whatsapp_proxy_username", e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs sm:text-sm font-bold text-text-main">
                {t("proxyPassword")}
              </label>
              <div className="relative">
                <input
                  type={showProxyPass ? "text" : "password"}
                  className="w-full h-11 px-3.5 pe-11 rounded-xl border border-line bg-panel-raised text-text-main text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                  value={settings["whatsapp_proxy_password"] || ""}
                  onChange={(e) =>
                    setSettings({ ...settings, whatsapp_proxy_password: e.target.value })
                  }
                  onBlur={(e) => updateSetting("whatsapp_proxy_password", e.target.value)}
                />
                <button
                  type="button"
                  onClick={() => setShowProxyPass(!showProxyPass)}
                  className="absolute top-1.5 end-1.5 w-8 h-8 rounded-lg flex items-center justify-center text-muted hover:text-text-main transition-colors"
                >
                  {showProxyPass ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ====================================================================
          TAB 4: Security & Password
         ==================================================================== */}
      {activeTab === "security" && (
        <div className="flex flex-col gap-5">
          <div className="rounded-2xl border border-line bg-panel p-4 sm:p-6 shadow-sm flex flex-col gap-4 max-w-xl">
            <div className="flex items-center gap-3 pb-3 border-b border-line">
              <Lock size={20} className="text-ok" />
              <h3 className="text-base sm:text-lg font-bold text-text-main">
                {t("changePassword")}
              </h3>
            </div>

            <form onSubmit={handlePasswordChange} className="flex flex-col gap-3.5">
              <div className="space-y-1.5">
                <label className="block text-xs sm:text-sm font-bold text-text-main">
                  {t("currentPassword")}
                </label>
                <div className="relative">
                  <input
                    type={showPanelPass ? "text" : "password"}
                    className="w-full h-11 px-3.5 pe-11 rounded-xl border border-line bg-panel-raised text-text-main text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                    required
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                  />
                  <button
                    type="button"
                    aria-label={language === "ar" ? "إظهار كلمة السر" : "Show password"}
                    onClick={() => setShowPanelPass(!showPanelPass)}
                    className="absolute top-1.5 end-1.5 w-8 h-8 rounded-lg flex items-center justify-center text-muted hover:text-text-main transition-colors"
                  >
                    {showPanelPass ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs sm:text-sm font-bold text-text-main">
                  {t("newPassword")}
                </label>
                <div className="relative">
                  <input
                    type={showPanelPass ? "text" : "password"}
                    className="w-full h-11 px-3.5 pe-11 rounded-xl border border-line bg-panel-raised text-text-main text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                    required
                    minLength={8}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                  />
                  <button
                    type="button"
                    aria-label={language === "ar" ? "إظهار كلمة السر" : "Show password"}
                    onClick={() => setShowPanelPass(!showPanelPass)}
                    className="absolute top-1.5 end-1.5 w-8 h-8 rounded-lg flex items-center justify-center text-muted hover:text-text-main transition-colors"
                  >
                    {showPanelPass ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
                <span className="block text-[11px] text-muted">{t("passwordMinLength")}</span>
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs sm:text-sm font-bold text-text-main">
                  {t("confirmPassword")}
                </label>
                <div className="relative">
                  <input
                    type={showPanelPass ? "text" : "password"}
                    className="w-full h-11 px-3.5 pe-11 rounded-xl border border-line bg-panel-raised text-text-main text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                    required
                    minLength={8}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                  />
                  <button
                    type="button"
                    aria-label={language === "ar" ? "إظهار كلمة السر" : "Show password"}
                    onClick={() => setShowPanelPass(!showPanelPass)}
                    className="absolute top-1.5 end-1.5 w-8 h-8 rounded-lg flex items-center justify-center text-muted hover:text-text-main transition-colors"
                  >
                    {showPanelPass ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={changingPass}
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-6 h-11 rounded-xl bg-brand-blue hover:bg-brand-blue/90 text-white font-bold text-xs sm:text-sm shadow-md shadow-brand-blue/20 transition-all focus-visible:ring-2 focus-visible:ring-brand-blue/50 disabled:opacity-50 self-start mt-2"
              >
                <Save size={16} />
                <span>{changingPass ? t("saving") : t("save")}</span>
              </button>
            </form>
          </div>
        </div>
      )}

      {/* ====================================================================
          TAB 5: Storage & Media
         ==================================================================== */}
      {activeTab === "storage" && (
        <div className="rounded-2xl border border-line bg-panel p-4 sm:p-6 shadow-sm flex flex-col gap-5">
          <div className="flex items-center gap-3.5 pb-4 border-b border-line">
            <div className="w-11 h-11 rounded-xl bg-purple-500/10 text-purple-400 flex items-center justify-center shrink-0">
              <HardDrive size={22} />
            </div>
            <div>
              <h3 className="text-base sm:text-lg font-bold text-text-main">{t("storageTitle")}</h3>
              <p className="text-xs sm:text-sm text-muted mt-0.5">{t("storageDesc")}</p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="block text-xs sm:text-sm font-bold text-text-main">
                {t("forwardTtl")}
              </label>
              <input
                type="number"
                className="w-full h-11 px-3.5 rounded-xl border border-line bg-panel-raised text-text-main text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                value={settings["forward_score_ttl_days"] || 30}
                onChange={(e) =>
                  setSettings({ ...settings, forward_score_ttl_days: Number(e.target.value) })
                }
                onBlur={(e) => updateSetting("forward_score_ttl_days", Number(e.target.value))}
              />
              <span className="block text-[11px] text-muted">{t("forwardTtlDesc")}</span>
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs sm:text-sm font-bold text-text-main">
                {t("maxFetchBytes")}
              </label>
              <input
                type="number"
                className="w-full h-11 px-3.5 rounded-xl border border-line bg-panel-raised text-text-main text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                value={settings["max_fetch_bytes"] || 524288}
                onChange={(e) =>
                  setSettings({ ...settings, max_fetch_bytes: Number(e.target.value) })
                }
                onBlur={(e) => updateSetting("max_fetch_bytes", Number(e.target.value))}
              />
              <span className="block text-[11px] text-muted">{t("maxFetchBytesDesc")}</span>
            </div>
          </div>
        </div>
      )}

      {/* ====================================================================
          TAB 6: Feedback & support — the operator's line to the developer
         ==================================================================== */}
      {activeTab === "feedback" && <FeedbackForm />}

      {/* Import confirmation: the file is about to overwrite this install's
          settings, so the operator sees what is in it before it lands. */}
      <Modal
        isOpen={!!importPreview}
        onClose={() => setImportPreview(null)}
        title={t("importTitle")}
        footer={
          <div className="flex gap-3 justify-end">
            <button
              type="button"
              onClick={() => setImportPreview(null)}
              className="px-5 h-10 rounded-xl border border-line text-muted hover:text-text-main font-bold text-xs sm:text-sm transition-colors"
            >
              {language === "ar" ? "إلغاء" : "Cancel"}
            </button>
            <button
              type="button"
              onClick={handleImportApply}
              disabled={applyingImport}
              className="px-5 h-10 rounded-xl bg-brand-blue hover:bg-brand-blue/90 text-white font-bold text-xs sm:text-sm shadow-md shadow-brand-blue/20 transition-all disabled:opacity-50"
            >
              {t("importApply")}
            </button>
          </div>
        }
      >
        {importPreview && (
          <div className="flex flex-col gap-3 text-xs sm:text-sm text-text-main">
            <p className="text-muted">{t("importSummary")}</p>
            <ul className="flex flex-col gap-1.5 bg-panel-raised rounded-xl border border-line p-4">
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
      </Modal>
    </div>
  );
};

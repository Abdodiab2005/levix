// file: frontend/src/views/SettingsView.tsx

import {
  Bot,
  Eye,
  EyeOff,
  Globe,
  HardDrive,
  Lock,
  Save,
  Shield,
  Sliders,
  Sparkles,
  Terminal,
} from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useToast } from "../components/Toasts";
import { Toggle } from "../components/Toggle";
import { useI18n } from "../context/I18nContext";
import { cn } from "../utils/cn";

type SettingsTab = "general" | "ai" | "proxy" | "security" | "storage";

const PREFIX_PRESETS = ["!", "/", ".", "#", "$", "?"];

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
  const [showPassword, setShowPassword] = useState(false);
  const [changingPass, setChangingPass] = useState(false);

  // Proxy secret visibility
  const [showProxyPass, setShowProxyPass] = useState(false);

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

  return (
    <div className="flex flex-col gap-6">
      {/* Sleek Tabs Navigation Strip */}
      <div
        className="flex items-center gap-2 p-1.5 bg-panel/75 backdrop-blur-md border border-line rounded-2xl overflow-x-auto scrollbar-none shadow-sm"
        role="tablist"
        aria-label="Settings Categories"
      >
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "general"}
          onClick={() => setActiveTab("general")}
          className={cn(
            "flex items-center gap-2.5 px-4 py-2.5 min-h-[44px] rounded-xl font-bold text-xs md:text-sm whitespace-nowrap transition-all focus-visible:ring-2 focus-visible:ring-brand-blue/50",
            activeTab === "general"
              ? "bg-brand-blue text-white shadow-md shadow-brand-blue/25"
              : "text-muted hover:text-text-main hover:bg-panel-hover",
          )}
        >
          <Sliders size={18} className="shrink-0" />
          <span>{t("tabGeneral")}</span>
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "ai"}
          onClick={() => setActiveTab("ai")}
          className={cn(
            "flex items-center gap-2.5 px-4 py-2.5 min-h-[44px] rounded-xl font-bold text-xs md:text-sm whitespace-nowrap transition-all focus-visible:ring-2 focus-visible:ring-brand-blue/50",
            activeTab === "ai"
              ? "bg-brand-blue text-white shadow-md shadow-brand-blue/25"
              : "text-muted hover:text-text-main hover:bg-panel-hover",
          )}
        >
          <Bot size={18} className="shrink-0" />
          <span>{t("tabAI")}</span>
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "proxy"}
          onClick={() => setActiveTab("proxy")}
          className={cn(
            "flex items-center gap-2.5 px-4 py-2.5 min-h-[44px] rounded-xl font-bold text-xs md:text-sm whitespace-nowrap transition-all focus-visible:ring-2 focus-visible:ring-brand-blue/50",
            activeTab === "proxy"
              ? "bg-brand-blue text-white shadow-md shadow-brand-blue/25"
              : "text-muted hover:text-text-main hover:bg-panel-hover",
          )}
        >
          <Globe size={18} className="shrink-0" />
          <span>{t("tabProxy")}</span>
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "security"}
          onClick={() => setActiveTab("security")}
          className={cn(
            "flex items-center gap-2.5 px-4 py-2.5 min-h-[44px] rounded-xl font-bold text-xs md:text-sm whitespace-nowrap transition-all focus-visible:ring-2 focus-visible:ring-brand-blue/50",
            activeTab === "security"
              ? "bg-brand-blue text-white shadow-md shadow-brand-blue/25"
              : "text-muted hover:text-text-main hover:bg-panel-hover",
          )}
        >
          <Shield size={18} className="shrink-0" />
          <span>{t("tabSecurity")}</span>
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "storage"}
          onClick={() => setActiveTab("storage")}
          className={cn(
            "flex items-center gap-2.5 px-4 py-2.5 min-h-[44px] rounded-xl font-bold text-xs md:text-sm whitespace-nowrap transition-all focus-visible:ring-2 focus-visible:ring-brand-blue/50",
            activeTab === "storage"
              ? "bg-brand-blue text-white shadow-md shadow-brand-blue/25"
              : "text-muted hover:text-text-main hover:bg-panel-hover",
          )}
        >
          <HardDrive size={18} className="shrink-0" />
          <span>{t("tabStorage")}</span>
        </button>
      </div>

      {/* ====================================================================
          TAB 1: General & Prefix
         ==================================================================== */}
      {activeTab === "general" && (
        <div className="flex flex-col gap-5">
          {/* Hero Prefix Customization Card */}
          <div className="rounded-2xl border border-line bg-gradient-to-br from-panel-raised to-panel p-6 shadow-sm flex flex-col gap-5">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-line">
              <div className="flex items-center gap-3.5">
                <div className="w-11 h-11 rounded-xl bg-brand-cyan/10 text-brand-cyan flex items-center justify-center shrink-0">
                  <Terminal size={22} />
                </div>
                <div>
                  <h3 className="text-base md:text-lg font-bold text-text-main">
                    {t("prefixTitle")}
                  </h3>
                  <p className="text-xs md:text-sm text-muted mt-0.5">{t("prefixDesc")}</p>
                </div>
              </div>

              <div className="flex items-center gap-2.5">
                <span className="text-xs md:text-sm text-muted font-semibold">
                  {t("activePrefix")}:
                </span>
                <span className="inline-flex items-center justify-center px-3 py-1 rounded-lg bg-brand-cyan/15 text-brand-cyan font-mono font-bold text-base border border-brand-cyan/30 shadow-sm">
                  {prefix}
                </span>
              </div>
            </div>

            {/* Quick Presets & Custom Input */}
            <div className="flex flex-wrap items-center gap-4 pt-1">
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
                          "w-11 h-11 rounded-xl border font-mono font-bold text-sm transition-all flex items-center justify-center focus-visible:ring-2 focus-visible:ring-brand-blue/50",
                          isCurrent
                            ? "bg-brand-cyan text-slate-900 border-brand-cyan shadow-sm"
                            : "bg-panel-raised border-line text-text-main hover:bg-panel-hover",
                        )}
                        title={`Select ${p}`}
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

              <div className="flex flex-col gap-1.5 flex-1 min-w-[240px]">
                <span className="text-xs text-muted font-semibold">{t("changePrefix")}</span>
                <div className="flex items-center gap-2.5 flex-wrap sm:flex-nowrap">
                  <input
                    type="text"
                    className="w-24 sm:w-28 h-11 px-3 text-center font-mono font-bold text-base rounded-xl border border-line bg-panel text-text-main focus:outline-none focus:ring-2 focus:ring-brand-blue/50 shrink-0"
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
                    className="inline-flex items-center justify-center gap-2 px-4 sm:px-5 h-11 rounded-xl bg-brand-blue hover:bg-brand-blue/90 text-white font-bold text-xs md:text-sm whitespace-nowrap shrink-0 transition-all shadow-md shadow-brand-blue/20 focus-visible:ring-2 focus-visible:ring-brand-blue/50 disabled:opacity-50"
                  >
                    <Save size={17} className="shrink-0" />
                    <span className="whitespace-nowrap">
                      {savingPrefix ? t("saving") : t("prefixSaveBtn")}
                    </span>
                  </button>
                </div>
              </div>
            </div>

            {/* Live Command Syntax Preview */}
            <div className="rounded-xl bg-bg-soft/70 border border-line p-3.5 flex flex-wrap items-center gap-2.5 text-xs md:text-sm">
              <span className="font-semibold text-muted">{t("prefixPreview")}</span>
              <div className="px-2.5 py-1 rounded-lg bg-panel border border-line font-mono font-medium text-brand-cyan">
                <code>{prefixInput || prefix}help</code>
              </div>
              <div className="px-2.5 py-1 rounded-lg bg-panel border border-line font-mono font-medium text-brand-cyan">
                <code>{prefixInput || prefix}ping</code>
              </div>
              <div className="px-2.5 py-1 rounded-lg bg-panel border border-line font-mono font-medium text-brand-cyan">
                <code>{prefixInput || prefix}gemini</code>
              </div>
              <div className="px-2.5 py-1 rounded-lg bg-panel border border-line font-mono font-medium text-brand-cyan">
                <code>{prefixInput || prefix}sticker</code>
              </div>
            </div>
          </div>

          {/* Bot Behavior & Localization */}
          <div className="rounded-2xl border border-line bg-panel p-5 md:p-6 shadow-sm flex flex-col gap-5">
            <h3 className="text-base md:text-lg font-bold text-text-main">
              {language === "ar" ? "سلوك الردود والنظام" : "Bot Behavior & Delays"}
            </h3>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
              {/* Interface Language */}
              <div className="space-y-1.5">
                <label className="block text-xs md:text-sm font-bold text-text-main">
                  {t("interfaceLanguage")}
                </label>
                <select
                  className="w-full h-11 px-3.5 rounded-xl border border-line bg-panel-raised text-text-main text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                  value={language}
                  onChange={(e) => setLanguage(e.target.value as any)}
                >
                  <option value="ar">العربية (RTL - اليمين لليسار)</option>
                  <option value="en">English (LTR - Left to Right)</option>
                </select>
                <span className="block text-xs text-muted">{t("interfaceLanguageDesc")}</span>
              </div>

              {/* Bot Response Language */}
              <div className="space-y-1.5">
                <label className="block text-xs md:text-sm font-bold text-text-main">
                  {t("botLanguage")}
                </label>
                <select
                  className="w-full h-11 px-3.5 rounded-xl border border-line bg-panel-raised text-text-main text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                  value={settings["bot_language"] || "auto"}
                  onChange={(e) => updateSetting("bot_language", e.target.value)}
                >
                  <option value="auto">{t("langAuto")}</option>
                  <option value="ar">{t("langAr")}</option>
                  <option value="en">{t("langEn")}</option>
                </select>
                <span className="block text-xs text-muted">{t("botLanguageDesc")}</span>
              </div>

              {/* Timezone */}
              <div className="space-y-1.5">
                <label className="block text-xs md:text-sm font-bold text-text-main">
                  {t("botTimezone")}
                </label>
                <input
                  type="text"
                  className="w-full h-11 px-3.5 rounded-xl border border-line bg-panel-raised font-mono text-text-main text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                  placeholder="Africa/Cairo"
                  value={settings["bot_timezone"] || "Africa/Cairo"}
                  onChange={(e) => setSettings({ ...settings, bot_timezone: e.target.value })}
                  onBlur={(e) => updateSetting("bot_timezone", e.target.value)}
                />
                <span className="block text-xs text-muted">{t("botTimezoneDesc")}</span>
              </div>

              {/* Server Port */}
              <div className="space-y-1.5">
                <label className="block text-xs md:text-sm font-bold text-text-main">
                  {t("botPort")}
                </label>
                <input
                  type="number"
                  className="w-full h-11 px-3.5 rounded-xl border border-line bg-panel-raised text-text-main text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                  value={settings["port"] || 3001}
                  onChange={(e) => setSettings({ ...settings, port: Number(e.target.value) })}
                  onBlur={(e) => updateSetting("port", Number(e.target.value))}
                />
                <span className="block text-xs text-warn">{t("botPortHint")}</span>
              </div>

              {/* Reply Delays */}
              <div className="space-y-1.5">
                <label className="block text-xs md:text-sm font-bold text-text-main">
                  {t("botMinDelay")}
                </label>
                <input
                  type="number"
                  className="w-full h-11 px-3.5 rounded-xl border border-line bg-panel-raised text-text-main text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                  value={settings["bot_min_delay_ms"] || 400}
                  onChange={(e) =>
                    setSettings({ ...settings, bot_min_delay_ms: Number(e.target.value) })
                  }
                  onBlur={(e) => updateSetting("bot_min_delay_ms", Number(e.target.value))}
                />
                <span className="block text-xs text-muted">{t("delaysDesc")}</span>
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs md:text-sm font-bold text-text-main">
                  {t("botMaxDelay")}
                </label>
                <input
                  type="number"
                  className="w-full h-11 px-3.5 rounded-xl border border-line bg-panel-raised text-text-main text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                  value={settings["bot_max_delay_ms"] || 900}
                  onChange={(e) =>
                    setSettings({ ...settings, bot_max_delay_ms: Number(e.target.value) })
                  }
                  onBlur={(e) => updateSetting("bot_max_delay_ms", Number(e.target.value))}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ====================================================================
          TAB 2: AI Assistant
         ==================================================================== */}
      {activeTab === "ai" && (
        <div className="flex flex-col gap-5">
          <div className="rounded-2xl border border-line bg-panel p-5 md:p-6 shadow-sm flex flex-col gap-5">
            <div className="flex items-center justify-between gap-4 pb-4 border-b border-line">
              <div className="flex items-center gap-3.5">
                <div className="w-11 h-11 rounded-xl bg-brand-cyan/10 text-brand-cyan flex items-center justify-center shrink-0">
                  <Sparkles size={22} />
                </div>
                <div>
                  <h3 className="text-base md:text-lg font-bold text-text-main">
                    {t("aiAgentEnabled")}
                  </h3>
                  <p className="text-xs md:text-sm text-muted mt-0.5">
                    {language === "ar"
                      ? "تمكين أدوات البحث واستدعاء الوظائف والذاكرة التراكمية"
                      : "Enable tool calling, web search, and markdown long-term memory"}
                  </p>
                </div>
              </div>
              <Toggle
                checked={settings["ai_agent"] !== false}
                onChange={(val) => updateSetting("ai_agent", val)}
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
              {/* Provider Selection */}
              <div className="space-y-1.5">
                <label className="block text-xs md:text-sm font-bold text-text-main">
                  {t("aiProvider")}
                </label>
                <select
                  className="w-full h-11 px-3.5 rounded-xl border border-line bg-panel-raised text-text-main text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                  value={settings["ai_provider"] || "gemini"}
                  onChange={(e) => updateSetting("ai_provider", e.target.value)}
                >
                  <option value="gemini">Google Gemini (Recommended / مستحسن)</option>
                  <option value="openai">OpenAI / Groq / Compatible</option>
                  <option value="anthropic">Anthropic Claude</option>
                </select>
              </div>

              {/* Gemini Model */}
              <div className="space-y-1.5">
                <label className="block text-xs md:text-sm font-bold text-text-main">
                  {t("modelName")}
                </label>
                <input
                  type="text"
                  className="w-full h-11 px-3.5 rounded-xl border border-line bg-panel-raised font-mono text-text-main text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                  value={settings["gemini_model"] || "gemini-3.7-flash"}
                  onChange={(e) => setSettings({ ...settings, gemini_model: e.target.value })}
                  onBlur={(e) => updateSetting("gemini_model", e.target.value)}
                />
              </div>

              {/* Gemini API Key */}
              <div className="space-y-1.5 col-span-full">
                <label className="block text-xs md:text-sm font-bold text-text-main">
                  {settings["ai_provider"] === "openai"
                    ? "OpenAI API Key"
                    : settings["ai_provider"] === "anthropic"
                      ? "Anthropic API Key"
                      : "Gemini API Key"}
                </label>
                <div className="relative">
                  <input
                    type={showPassword ? "text" : "password"}
                    className="w-full h-11 px-3.5 pe-12 rounded-xl border border-line bg-panel-raised font-mono text-text-main text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                    placeholder={
                      settings["ai_provider"] === "gemini" && settings["gemini_api_key"]
                        ? "(Configured / مفتاح محفوظ)"
                        : "AIzaSy..."
                    }
                    value={
                      settings["ai_provider"] === "openai"
                        ? settings["openai_api_key"] || ""
                        : settings["ai_provider"] === "anthropic"
                          ? settings["anthropic_api_key"] || ""
                          : settings["gemini_api_key"] || ""
                    }
                    onChange={(e) => {
                      const keyName =
                        settings["ai_provider"] === "openai"
                          ? "openai_api_key"
                          : settings["ai_provider"] === "anthropic"
                            ? "anthropic_api_key"
                            : "gemini_api_key";
                      setSettings({ ...settings, [keyName]: e.target.value });
                    }}
                    onBlur={(e) => {
                      const keyName =
                        settings["ai_provider"] === "openai"
                          ? "openai_api_key"
                          : settings["ai_provider"] === "anthropic"
                            ? "anthropic_api_key"
                            : "gemini_api_key";
                      if (e.target.value) updateSetting(keyName, e.target.value);
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute top-1.5 end-1.5 inline-flex items-center justify-center w-8 h-8 rounded-lg border border-line bg-panel hover:bg-panel-hover text-text-main transition-colors"
                    aria-label="Toggle password visibility"
                  >
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
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
        <div className="rounded-2xl border border-line bg-panel p-5 md:p-6 shadow-sm flex flex-col gap-5">
          <div className="flex items-center justify-between gap-4 pb-4 border-b border-line">
            <div className="flex items-center gap-3.5">
              <div className="w-11 h-11 rounded-xl bg-brand-blue/10 text-brand-blue flex items-center justify-center shrink-0">
                <Globe size={22} />
              </div>
              <div>
                <h3 className="text-base md:text-lg font-bold text-text-main">{t("proxyTitle")}</h3>
                <p className="text-xs md:text-sm text-muted mt-0.5">{t("proxyDesc")}</p>
              </div>
            </div>
            <Toggle
              checked={Boolean(settings["proxy_enabled"])}
              onChange={(val) => updateSetting("proxy_enabled", val)}
            />
          </div>

          <div className="p-3.5 rounded-xl bg-warn/10 border border-warn/25 text-warn text-xs md:text-sm font-medium">
            {t("proxyApplyHint")}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            <div className="space-y-1.5">
              <label className="block text-xs md:text-sm font-bold text-text-main">
                {t("proxyProtocol")}
              </label>
              <select
                className="w-full h-11 px-3.5 rounded-xl border border-line bg-panel-raised text-text-main text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                value={settings["proxy_type"] || "http"}
                onChange={(e) => updateSetting("proxy_type", e.target.value)}
              >
                <option value="http">HTTP</option>
                <option value="https">HTTPS</option>
                <option value="socks5">SOCKS5</option>
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs md:text-sm font-bold text-text-main">
                {t("proxyHost")}
              </label>
              <input
                type="text"
                className="w-full h-11 px-3.5 rounded-xl border border-line bg-panel-raised font-mono text-text-main text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                placeholder="127.0.0.1 or proxy.example.com"
                value={settings["proxy_host"] || ""}
                onChange={(e) => setSettings({ ...settings, proxy_host: e.target.value })}
                onBlur={(e) => updateSetting("proxy_host", e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs md:text-sm font-bold text-text-main">
                {t("proxyPort")}
              </label>
              <input
                type="number"
                className="w-full h-11 px-3.5 rounded-xl border border-line bg-panel-raised text-text-main text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                placeholder="1080"
                value={settings["proxy_port"] || ""}
                onChange={(e) => setSettings({ ...settings, proxy_port: Number(e.target.value) })}
                onBlur={(e) => updateSetting("proxy_port", Number(e.target.value))}
              />
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs md:text-sm font-bold text-text-main">
                {t("proxyUsername")}
              </label>
              <input
                type="text"
                className="w-full h-11 px-3.5 rounded-xl border border-line bg-panel-raised font-mono text-text-main text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                value={settings["proxy_username"] || ""}
                onChange={(e) => setSettings({ ...settings, proxy_username: e.target.value })}
                onBlur={(e) => updateSetting("proxy_username", e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs md:text-sm font-bold text-text-main">
                {t("proxyPassword")}
              </label>
              <div className="relative">
                <input
                  type={showProxyPass ? "text" : "password"}
                  className="w-full h-11 px-3.5 pe-12 rounded-xl border border-line bg-panel-raised text-text-main text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                  value={settings["proxy_password"] || ""}
                  onChange={(e) => setSettings({ ...settings, proxy_password: e.target.value })}
                  onBlur={(e) => updateSetting("proxy_password", e.target.value)}
                />
                <button
                  type="button"
                  onClick={() => setShowProxyPass(!showProxyPass)}
                  className="absolute top-1.5 end-1.5 inline-flex items-center justify-center w-8 h-8 rounded-lg border border-line bg-panel hover:bg-panel-hover text-text-main transition-colors"
                  aria-label="Toggle proxy password visibility"
                >
                  {showProxyPass ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ====================================================================
          TAB 4: Security & Access
         ==================================================================== */}
      {activeTab === "security" && (
        <div className="flex flex-col gap-5">
          <div className="rounded-2xl border border-line bg-panel p-5 md:p-6 shadow-sm flex flex-col gap-5 max-w-xl">
            <div className="flex items-center gap-3 pb-3 border-b border-line">
              <Lock size={20} className="text-ok" />
              <h3 className="text-base md:text-lg font-bold text-text-main">
                {t("changePassword")}
              </h3>
            </div>

            <form onSubmit={handlePasswordChange} className="flex flex-col gap-4">
              <div className="space-y-1.5">
                <label className="block text-xs md:text-sm font-bold text-text-main">
                  {t("currentPassword")}
                </label>
                <input
                  type="password"
                  className="w-full h-11 px-3.5 rounded-xl border border-line bg-panel-raised text-text-main text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                  required
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                />
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs md:text-sm font-bold text-text-main">
                  {t("newPassword")}
                </label>
                <input
                  type="password"
                  className="w-full h-11 px-3.5 rounded-xl border border-line bg-panel-raised text-text-main text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                  required
                  minLength={8}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                />
                <span className="block text-xs text-muted">{t("passwordMinLength")}</span>
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs md:text-sm font-bold text-text-main">
                  {t("confirmPassword")}
                </label>
                <input
                  type="password"
                  className="w-full h-11 px-3.5 rounded-xl border border-line bg-panel-raised text-text-main text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                  required
                  minLength={8}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                />
              </div>

              <button
                type="submit"
                disabled={changingPass}
                className="inline-flex items-center justify-center gap-2 px-6 h-11 rounded-xl bg-brand-blue hover:bg-brand-blue/90 text-white font-bold text-sm shadow-md shadow-brand-blue/20 transition-all focus-visible:ring-2 focus-visible:ring-brand-blue/50 disabled:opacity-50 self-start mt-2"
              >
                <Save size={17} />
                <span>{changingPass ? t("saving") : t("save")}</span>
              </button>
            </form>
          </div>

          <div className="rounded-2xl border border-line bg-panel p-5 md:p-6 shadow-sm flex flex-col gap-4 max-w-xl">
            <h3 className="text-base md:text-lg font-bold text-text-main pb-3 border-b border-line">
              {language === "ar" ? "إعدادات البروكسي العكسي والنطاقات" : "Reverse Proxy & CORS"}
            </h3>

            <div className="space-y-1.5">
              <label className="block text-xs md:text-sm font-bold text-text-main">
                Trust Proxy Hops
              </label>
              <input
                type="text"
                className="w-full h-11 px-3.5 rounded-xl border border-line bg-panel-raised font-mono text-text-main text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                placeholder="0, 1, or loopback"
                value={settings["trust_proxy"] || ""}
                onChange={(e) => setSettings({ ...settings, trust_proxy: e.target.value })}
                onBlur={(e) => updateSetting("trust_proxy", e.target.value)}
              />
              <span className="block text-xs text-muted">
                Number of reverse proxy hops (e.g. 1 behind Cloudflare/Nginx)
              </span>
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs md:text-sm font-bold text-text-main">
                Allowed Dashboard Origin
              </label>
              <input
                type="text"
                className="w-full h-11 px-3.5 rounded-xl border border-line bg-panel-raised font-mono text-text-main text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                placeholder="https://bot.example.com"
                value={settings["dashboard_origin"] || ""}
                onChange={(e) => setSettings({ ...settings, dashboard_origin: e.target.value })}
                onBlur={(e) => updateSetting("dashboard_origin", e.target.value)}
              />
            </div>
          </div>
        </div>
      )}

      {/* ====================================================================
          TAB 5: Storage & Media
         ==================================================================== */}
      {activeTab === "storage" && (
        <div className="rounded-2xl border border-line bg-panel p-5 md:p-6 shadow-sm flex flex-col gap-5">
          <div className="flex items-center gap-3.5 pb-4 border-b border-line">
            <div className="w-11 h-11 rounded-xl bg-purple-500/10 text-purple-400 flex items-center justify-center shrink-0">
              <HardDrive size={22} />
            </div>
            <div>
              <h3 className="text-base md:text-lg font-bold text-text-main">{t("storageTitle")}</h3>
              <p className="text-xs md:text-sm text-muted mt-0.5">{t("storageDesc")}</p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            <div className="space-y-1.5">
              <label className="block text-xs md:text-sm font-bold text-text-main">
                {t("forwardTtl")}
              </label>
              <input
                type="number"
                className="w-full h-11 px-3.5 rounded-xl border border-line bg-panel-raised text-text-main text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                value={settings["forward_score_ttl_days"] || 30}
                onChange={(e) =>
                  setSettings({ ...settings, forward_score_ttl_days: Number(e.target.value) })
                }
                onBlur={(e) => updateSetting("forward_score_ttl_days", Number(e.target.value))}
              />
              <span className="block text-xs text-muted">{t("forwardTtlDesc")}</span>
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs md:text-sm font-bold text-text-main">
                {t("maxFetchBytes")}
              </label>
              <input
                type="number"
                className="w-full h-11 px-3.5 rounded-xl border border-line bg-panel-raised text-text-main text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                value={settings["max_fetch_bytes"] || 524288}
                onChange={(e) =>
                  setSettings({ ...settings, max_fetch_bytes: Number(e.target.value) })
                }
                onBlur={(e) => updateSetting("max_fetch_bytes", Number(e.target.value))}
              />
              <span className="block text-xs text-muted">{t("maxFetchBytesDesc")}</span>
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs md:text-sm font-bold text-text-main">
                {t("ffmpegPath")}
              </label>
              <input
                type="text"
                className="w-full h-11 px-3.5 rounded-xl border border-line bg-panel-raised font-mono text-text-main text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                placeholder="/usr/bin/ffmpeg"
                value={settings["ffmpeg_path"] || ""}
                onChange={(e) => setSettings({ ...settings, ffmpeg_path: e.target.value })}
                onBlur={(e) => updateSetting("ffmpeg_path", e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs md:text-sm font-bold text-text-main">
                {t("weatherApiKey")}
              </label>
              <input
                type="text"
                className="w-full h-11 px-3.5 rounded-xl border border-line bg-panel-raised font-mono text-text-main text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                placeholder="API Key for !weather"
                value={settings["openweathermap_api_key"] || ""}
                onChange={(e) =>
                  setSettings({ ...settings, openweathermap_api_key: e.target.value })
                }
                onBlur={(e) => updateSetting("openweathermap_api_key", e.target.value)}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

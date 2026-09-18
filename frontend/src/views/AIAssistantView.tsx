import {
  AlertCircle,
  AlertTriangle,
  Bot,
  Check,
  CheckCircle2,
  Database,
  Eye,
  FileText,
  Globe,
  Mic,
  RefreshCw,
  Save,
  Sparkles,
  Volume2,
} from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { api, type NormalizedModel } from "../api/client";
import { Modal } from "../components/Modal";
import { useToast } from "../components/Toasts";
import { Toggle } from "../components/Toggle";
import { useI18n } from "../context/I18nContext";

interface ProviderPreset {
  id: string;
  name: string;
  descKey: string;
  provider: "gemini" | "openai" | "anthropic";
  defaultModel: string;
  defaultBaseUrl: string;
  keySetting: string;
  modelSetting: string;
  baseUrlSetting?: string;
}

export const AIAssistantView: React.FC = () => {
  const { t, language } = useI18n();
  const { toast } = useToast();

  const [settings, setSettings] = useState<Record<string, any>>({});
  const [configuredKeys, setConfiguredKeys] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);

  // Model discovery state
  const [discoveryState, setDiscoveryState] = useState<
    Record<
      string,
      {
        live: boolean;
        requiresApiKey: boolean;
        fallback?: boolean;
        models: NormalizedModel[];
        error?: string;
        cached?: boolean;
      }
    >
  >({});
  const [fetchingModels, setFetchingModels] = useState(false);
  const [isCustomModel, setIsCustomModel] = useState(false);

  // Persona & Memory modals
  const [personaModalOpen, setPersonaModalOpen] = useState(false);
  const [personaText, setPersonaText] = useState("");
  const [_memoryFiles, setMemoryFiles] = useState<string[]>([]);
  const [selectedMemoryFile, setSelectedMemoryFile] = useState<string | null>(null);
  const [memoryContent, setMemoryContent] = useState("");

  const presets: ProviderPreset[] = [
    {
      id: "gemini",
      name: "Google Gemini",
      descKey: "providerGeminiDesc",
      provider: "gemini",
      defaultModel: "gemini-3.7-flash",
      defaultBaseUrl: "",
      keySetting: "gemini_api_key",
      modelSetting: "gemini_model",
      baseUrlSetting: "gemini_base_url",
    },
    {
      id: "groq",
      name: "Groq Cloud",
      descKey: "providerGroqDesc",
      provider: "openai",
      defaultModel: "llama-3.3-70b-versatile",
      defaultBaseUrl: "https://api.groq.com/openai/v1",
      keySetting: "openai_api_key",
      modelSetting: "openai_model",
      baseUrlSetting: "openai_base_url",
    },
    {
      id: "openai",
      name: "OpenAI",
      descKey: "providerOpenAIDesc",
      provider: "openai",
      defaultModel: "gpt-4o-mini",
      defaultBaseUrl: "https://api.openai.com/v1",
      keySetting: "openai_api_key",
      modelSetting: "openai_model",
      baseUrlSetting: "openai_base_url",
    },
    {
      id: "ollama",
      name: "Ollama (Local)",
      descKey: "providerOllamaDesc",
      provider: "openai",
      defaultModel: "llama3.2",
      defaultBaseUrl: "http://localhost:11434/v1",
      keySetting: "openai_api_key",
      modelSetting: "openai_model",
      baseUrlSetting: "openai_base_url",
    },
    {
      id: "anthropic",
      name: "Anthropic Claude",
      descKey: "providerAnthropicDesc",
      provider: "anthropic",
      defaultModel: "claude-sonnet-4-5",
      defaultBaseUrl: "https://api.anthropic.com",
      keySetting: "anthropic_api_key",
      modelSetting: "anthropic_model",
      baseUrlSetting: "anthropic_base_url",
    },
  ];

  const loadSettings = async () => {
    try {
      const res = await api.getSettings();
      if (res?.settings) {
        const map: Record<string, any> = {};
        const conf: Record<string, boolean> = {};
        res.settings.forEach((s: any) => {
          map[s.key] = s.value;
          if (s.type === "secret") {
            conf[s.key] = Boolean(s.configured);
          }
        });
        setSettings(map);
        setConfiguredKeys(conf);
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

  const updateSetting = async (key: string, value: any, quiet = false) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    try {
      const res = await api.updateSetting(key, value);
      if (!quiet) toast(t("savedSuccessfully"), "success");
      if (key.endsWith("_api_key")) {
        setSettings((prev) => ({ ...prev, [key]: "" }));
        setConfiguredKeys((prev) => ({ ...prev, [key]: Boolean(value) }));
      }
      if (res?.settings && Array.isArray(res.settings)) {
        const next: Record<string, any> = {};
        const conf: Record<string, boolean> = {};
        res.settings.forEach((s: any) => {
          if (s.type === "secret") {
            conf[s.key] = Boolean(s.configured);
            next[s.key] = "";
          } else {
            next[s.key] = s.value;
          }
        });
        setSettings((prev) => ({ ...prev, ...next }));
        setConfiguredKeys((prev) => ({ ...prev, ...conf }));
      }
    } catch (err: any) {
      toast(err.message, "error");
    }
  };

  // Determine active preset based on current settings
  const currentProvider = settings["ai_provider"] || "gemini";
  const selectedPreset =
    presets.find((p) => {
      if (p.provider !== currentProvider) return false;
      if (p.id === "gemini") return true;
      if (p.id === "anthropic") return true;
      if (p.id === "groq" && settings["openai_base_url"]?.includes("groq.com")) return true;
      if (p.id === "ollama" && settings["openai_base_url"]?.includes("11434")) return true;
      if (
        p.id === "openai" &&
        (!settings["openai_base_url"] || settings["openai_base_url"].includes("api.openai.com"))
      )
        return true;
      return false;
    }) || presets[0];

  const selectPreset = async (p: ProviderPreset) => {
    const newSettings: Record<string, any> = {
      ...settings,
      ai_provider: p.provider,
    };

    if (p.baseUrlSetting) {
      newSettings[p.baseUrlSetting] = p.defaultBaseUrl;
    }
    if (p.defaultModel) {
      newSettings[p.modelSetting] = p.defaultModel;
    }

    setSettings(newSettings);

    try {
      await api.updateSetting("ai_provider", p.provider);
      if (p.baseUrlSetting) {
        await api.updateSetting(p.baseUrlSetting, p.defaultBaseUrl);
      }
      if (p.defaultModel) {
        await api.updateSetting(p.modelSetting, p.defaultModel);
      }
      toast(
        language === "ar" ? `تم التبديل إلى ${p.name}` : `Switched provider to ${p.name}`,
        "success",
      );
    } catch (err: any) {
      toast(err.message, "error");
    }
  };

  const handleFetchModels = async (forceRefresh = false) => {
    setFetchingModels(true);
    const typedKey = String(settings[selectedPreset.keySetting] || "").trim();
    const hasStoredKey = Boolean(configuredKeys[selectedPreset.keySetting]);

    try {
      const payload: {
        provider: string;
        apiKey?: string;
        baseUrl?: string;
        refresh?: boolean;
      } = {
        provider: selectedPreset.provider,
        refresh: forceRefresh,
      };
      if (typedKey) payload.apiKey = typedKey;
      if (selectedPreset.baseUrlSetting && settings[selectedPreset.baseUrlSetting]) {
        payload.baseUrl = settings[selectedPreset.baseUrlSetting];
      }

      const res = await api.fetchAiModels(payload);

      if (res && (res.success || res.fallback)) {
        setDiscoveryState((prev) => ({
          ...prev,
          [selectedPreset.id]: {
            live: Boolean(res.live),
            requiresApiKey: Boolean(res.requiresApiKey),
            fallback: Boolean(res.fallback),
            models: res.models || [],
            cached: Boolean(res.cached),
            error: res.success ? undefined : res.error?.message,
          },
        }));

        if (res.live && res.success) {
          toast(
            language === "ar"
              ? `تم التحقق بنجاح وجلب ${res.models.length} نموذجاً متاحاً لحسابك`
              : `Discovered ${res.models.length} live models available for your account`,
            "success",
          );
        } else if (res.requiresApiKey) {
          if (forceRefresh) {
            toast(
              language === "ar"
                ? "يرجى إدخال مفتاح API أولاً لاكتشاف النماذج المتاحة لحسابك"
                : "Enter an API key to discover account models",
              "info",
            );
          }
        } else if (!res.success && res.error) {
          toast(res.error.message || "Failed to discover models", "error");
        }
      } else if (res && !res.success && res.error) {
        setDiscoveryState((prev) => ({
          ...prev,
          [selectedPreset.id]: {
            live: false,
            requiresApiKey: !(hasStoredKey || typedKey),
            fallback: true,
            models: res.models || [],
            error: res.error?.message,
          },
        }));

        toast(res.error.message || "Failed to discover models", "error");
      }
    } catch (err: any) {
      toast(err.message || "Failed to fetch models", "error");
    } finally {
      setFetchingModels(false);
    }
  };

  useEffect(() => {
    if (!loading) {
      handleFetchModels(false);
    }
  }, [selectedPreset.id, configuredKeys[selectedPreset.keySetting], loading]);

  const currentModelList: NormalizedModel[] = discoveryState[selectedPreset.id]?.models || [];
  const isLiveVerified = Boolean(discoveryState[selectedPreset.id]?.live);
  const requiresApiKey = Boolean(
    discoveryState[selectedPreset.id]?.requiresApiKey ??
      !configuredKeys[selectedPreset.keySetting],
  );

  const currentModelVal = settings[selectedPreset.modelSetting] || selectedPreset.defaultModel;

  const currentModelObj: NormalizedModel = currentModelList.find(
    (m) => m.id.toLowerCase() === currentModelVal.toLowerCase(),
  ) || {
    id: currentModelVal,
    displayName: currentModelVal,
    provider: selectedPreset.provider,
    recommended: false,
    capabilities: {
      textInput: true,
      textOutput: true,
      vision: false,
      audioInput: false,
      stt: false,
      videoInput: false,
      pdfInput: false,
    },
    capabilitySource: "unknown",
  };

  const supportsVision = Boolean(currentModelObj.capabilities.vision);
  const supportsStt = Boolean(currentModelObj.capabilities.stt);

  // Independent capability auto-disabling and clearing of stale incompatible configuration
  useEffect(() => {
    if (loading) return;

    if (!supportsVision && settings["ai_vision_enabled"]) {
      updateSetting("ai_vision_enabled", false, true);
    }

    if (!supportsStt && settings["ai_stt_enabled"]) {
      updateSetting("ai_stt_enabled", false, true);
    }
  }, [currentModelVal, supportsVision, supportsStt, loading]);

  const openPersonaEditor = async () => {
    try {
      const res = await api.getPersona();
      const persona = res?.persona;
      setPersonaText(
        typeof persona === "string" ? persona : persona?.body || "",
      );
      setPersonaModalOpen(true);
    } catch (err: any) {
      toast(err.message, "error");
    }
  };

  const savePersona = async () => {
    try {
      await api.updatePersona(personaText);
      toast(
        language === "ar" ? "تم تحديث برومبت الشخصية بنجاح!" : "Persona updated successfully!",
        "success",
      );
      setPersonaModalOpen(false);
    } catch (err: any) {
      toast(err.message, "error");
    }
  };

  const loadMemoryFiles = async () => {
    try {
      const res = await api.getMemoryFiles();
      const names =
        res?.files ||
        (res?.scopes || []).map((s) => s.scope);
      setMemoryFiles(names);
    } catch (err: any) {
      toast(err.message, "error");
    }
  };

  const viewMemoryFile = async (name: string) => {
    try {
      const res = await api.getMemoryFile(name);
      setMemoryContent(res?.content || "");
    } catch (err: any) {
      toast(err.message, "error");
    }
  };

  const saveMemoryFile = async () => {
    if (!selectedMemoryFile) return;
    try {
      await api.updateMemoryFile(selectedMemoryFile, memoryContent);
      toast(language === "ar" ? "تم حفظ ملف الذاكرة بنجاح!" : "Memory file updated!", "success");
      setSelectedMemoryFile(null);
    } catch (err: any) {
      toast(err.message, "error");
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-12 text-muted">
        <div className="w-6 h-6 border-2 border-brand-cyan border-t-transparent rounded-full animate-spin mr-2" />
        <span className="text-sm font-semibold">{t("starting")}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 sm:gap-6">
      {/* Master Toggle Header Card */}
      <div className="rounded-2xl border border-line bg-gradient-to-br from-panel-raised via-panel to-panel p-4 sm:p-6 shadow-sm flex flex-col gap-3.5">
        {/* Top Row: Bot icon + Title & Subtitle on Start, Toggle Switch on End */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <div className="w-11 h-11 sm:w-12 sm:h-12 rounded-2xl bg-gradient-to-br from-brand-blue to-brand-cyan text-white flex items-center justify-center shrink-0 shadow-md shadow-brand-blue/20">
              <Bot size={22} className="sm:w-6 sm:h-6" />
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="text-base sm:text-xl font-extrabold text-text-main truncate">
                {t("aiTitle")}
              </h2>
              <p className="text-xs sm:text-sm text-muted truncate">{t("aiSubtitle")}</p>
            </div>
          </div>

          {/* Toggle Switch in corner */}
          <div className="shrink-0 flex items-center gap-2 bg-panel/60 border border-line/70 rounded-xl px-2.5 py-1.5 shadow-xs">
            <span className="text-xs font-bold text-muted hidden sm:inline">
              {Boolean(settings["ai_agent"])
                ? language === "ar"
                  ? "مفعل"
                  : "Enabled"
                : language === "ar"
                  ? "معطل"
                  : "Disabled"}
            </span>
            <Toggle
              checked={Boolean(settings["ai_agent"])}
              onChange={(val) => updateSetting("ai_agent", val)}
            />
          </div>
        </div>

        {/* Dedicated State Badge */}
        <div className="flex items-center gap-2 pt-1 border-t border-line/40">
          <span
            className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold border ${
              Boolean(settings["ai_agent"])
                ? "bg-ok/15 text-ok border-ok/30"
                : "bg-danger/10 text-danger border-danger/25"
            }`}
          >
            <span className="pulse-dot" />
            <span>
              {Boolean(settings["ai_agent"])
                ? t("aiAgentEnabled")
                : language === "ar"
                  ? "مساعد الذكاء الاصطناعي معطل"
                  : "AI Assistant Disabled"}
            </span>
          </span>
        </div>
      </div>

      {/* Quick Setup & Active Provider Card */}
      <div className="rounded-2xl border border-line bg-panel p-4 sm:p-6 shadow-sm flex flex-col gap-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-line">
          <div className="flex items-center gap-2.5">
            <Sparkles size={18} className="text-brand-cyan shrink-0" />
            <h3 className="text-base sm:text-lg font-bold text-text-main">{t("aiProvider")}</h3>
          </div>
          <div className="flex items-center gap-2 self-start sm:self-auto">
            <span className="text-xs text-muted font-medium">
              {language === "ar" ? "المزود النشط:" : "Active:"}
            </span>
            <span className="text-xs font-bold text-brand-cyan px-2.5 py-1 rounded-lg bg-brand-cyan/10 border border-brand-cyan/25">
              {selectedPreset.name} &bull; <span className="font-mono">{currentModelVal}</span>
            </span>
          </div>
        </div>

        {/* Provider Selector: clean, mobile-first responsive segmented cards */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5 sm:gap-3">
          {presets.map((p) => {
            const isSelected = selectedPreset.id === p.id;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => selectPreset(p)}
                className={`p-3.5 rounded-xl border text-start transition-all flex flex-col justify-between gap-2.5 focus-visible:ring-2 focus-visible:ring-brand-blue/50 ${
                  isSelected
                    ? "bg-brand-blue/15 border-brand-blue/60 shadow-sm ring-1 ring-brand-blue/40"
                    : "bg-panel-raised border-line hover:bg-panel-hover"
                }`}
              >
                <div className="flex items-center justify-between w-full">
                  <span className="font-bold text-xs sm:text-sm text-text-main">{p.name}</span>
                  {isSelected ? (
                    <span className="w-5 h-5 rounded-full bg-brand-blue text-white flex items-center justify-center shrink-0">
                      <Check size={12} strokeWidth={3} />
                    </span>
                  ) : (
                    <span className="w-2 h-2 rounded-full bg-line" />
                  )}
                </div>
                <span className="text-[10px] sm:text-[11px] font-mono text-muted truncate block">
                  {p.defaultModel}
                </span>
              </button>
            );
          })}
        </div>

        {/* Warning banner if API key is missing */}
        {requiresApiKey && (
          <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/25 flex items-start gap-3">
            <AlertTriangle size={18} className="text-amber-500 shrink-0 mt-0.5" />
            <div className="text-xs text-text-main">
              <p className="font-bold">{t("connectKeyFirstPrompt")}</p>
              <p className="text-muted mt-0.5">
                {language === "ar"
                  ? "النماذج المعروضة أدناه هي نماذج مقترحة من الدليل المحلي وليست مؤكدة لحسابك حتى يتم ربط المفتاح."
                  : "Models shown below are catalog recommendations and are not verified for your account until a key is configured."}
              </p>
            </div>
          </div>
        )}

        {/* Discovery error banner if discovery failed */}
        {discoveryState[selectedPreset.id]?.error && (
          <div className="p-3 rounded-xl bg-danger/10 border border-danger/25 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-xs text-danger font-semibold">
              <AlertCircle size={16} className="shrink-0" />
              <span>{discoveryState[selectedPreset.id]?.error}</span>
            </div>
            <button
              type="button"
              onClick={() => handleFetchModels(true)}
              className="text-xs font-bold underline hover:opacity-80 shrink-0"
            >
              {t("refreshModels")}
            </button>
          </div>
        )}

        {/* Dynamic Provider Inputs: key first, then URL, then model */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-4 border-t border-line">
          {/* API Key */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label htmlFor="input-api-key" className="block text-xs font-bold text-muted">
                {t("apiKey")}
              </label>
              {configuredKeys[selectedPreset.keySetting] && (
                <span className="text-[10px] text-ok font-semibold flex items-center gap-1">
                  <CheckCircle2 size={11} />
                  {language === "ar" ? "محفوظ" : "Saved"}
                </span>
              )}
            </div>
            <input
              id="input-api-key"
              type="password"
              className="w-full h-11 px-3.5 rounded-xl border border-line bg-panel-raised text-text-main font-mono text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
              value={settings[selectedPreset.keySetting] || ""}
              onChange={(e) =>
                setSettings({ ...settings, [selectedPreset.keySetting]: e.target.value })
              }
              onBlur={(e) => updateSetting(selectedPreset.keySetting, e.target.value)}
              placeholder={
                configuredKeys[selectedPreset.keySetting]
                  ? "••••••••••••"
                  : language === "ar"
                    ? "أدخل المفتاح"
                    : "Enter API key"
              }
            />
          </div>

          {/* Base URL (if applicable) */}
          {selectedPreset.baseUrlSetting && (
            <div className="space-y-1.5">
              <label htmlFor="input-base-url" className="block text-xs font-bold text-muted">
                {t("baseUrl")}
              </label>
              <input
                id="input-base-url"
                type="text"
                className="w-full h-11 px-3.5 rounded-xl border border-line bg-panel-raised text-text-main font-mono text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                value={settings[selectedPreset.baseUrlSetting] || ""}
                onChange={(e) => {
                  if (selectedPreset.baseUrlSetting) {
                    setSettings({ ...settings, [selectedPreset.baseUrlSetting]: e.target.value });
                  }
                }}
                onBlur={(e) => {
                  if (selectedPreset.baseUrlSetting) {
                    updateSetting(selectedPreset.baseUrlSetting, e.target.value);
                  }
                }}
                placeholder={selectedPreset.defaultBaseUrl}
              />
            </div>
          )}

          {/* Model Name Selector / Input */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <label htmlFor="input-model-name" className="block text-xs font-bold text-muted">
                  {t("modelName")}
                </label>
                {isLiveVerified ? (
                  <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-ok/15 text-ok border border-ok/30">
                    {t("sourceLive")}
                  </span>
                ) : (
                  <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-brand-cyan/15 text-brand-cyan border border-brand-cyan/30">
                    {t("sourceSeed")}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setIsCustomModel(!isCustomModel)}
                  className="text-[11px] text-brand-cyan hover:underline font-semibold"
                >
                  {isCustomModel
                    ? language === "ar"
                      ? "القائمة"
                      : "List"
                    : language === "ar"
                      ? "مخصص"
                      : "Custom"}
                </button>
                <button
                  type="button"
                  onClick={() => handleFetchModels(true)}
                  disabled={fetchingModels}
                  className="inline-flex items-center gap-1 text-[11px] text-brand-blue hover:text-brand-blue/80 font-bold"
                  title={t("refreshModels")}
                >
                  <RefreshCw size={11} className={fetchingModels ? "animate-spin" : ""} />
                  <span>{fetchingModels ? t("refreshing") : t("refreshModels")}</span>
                </button>
              </div>
            </div>

            {isCustomModel ? (
              <input
                id="input-model-name"
                type="text"
                className="w-full h-11 px-3.5 rounded-xl border border-line bg-panel-raised text-text-main font-mono text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                value={settings[selectedPreset.modelSetting] || ""}
                onChange={(e) =>
                  setSettings({ ...settings, [selectedPreset.modelSetting]: e.target.value })
                }
                onBlur={(e) => updateSetting(selectedPreset.modelSetting, e.target.value)}
                placeholder={selectedPreset.defaultModel}
              />
            ) : (
              <select
                id="input-model-name"
                className="w-full h-11 px-3.5 rounded-xl border border-line bg-panel-raised text-text-main font-mono text-xs sm:text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                value={currentModelVal}
                onChange={(e) => {
                  updateSetting(selectedPreset.modelSetting, e.target.value);
                }}
              >
                <optgroup label={isLiveVerified ? t("modelsAvailableLive") : t("modelsRecommendedSeed")}>
                  {currentModelList.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.displayName && m.displayName !== m.id ? `${m.displayName} (${m.id})` : m.id}
                      {m.recommended ? " ★" : ""}
                    </option>
                  ))}
                </optgroup>
                {!currentModelList.some((m) => m.id.toLowerCase() === currentModelVal.toLowerCase()) && (
                  <option value={currentModelVal}>{currentModelVal} (current)</option>
                )}
              </select>
            )}
          </div>
        </div>

        {/* Dedicated Model Capabilities Status Card */}
        <div className="p-3.5 rounded-xl border border-line bg-panel-raised/60 flex flex-col gap-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="font-bold text-text-main flex items-center gap-1.5">
              <Sparkles size={14} className="text-brand-cyan shrink-0" />
              {language === "ar" ? "القدرات:" : "Capabilities:"}{" "}
              <span className="font-mono text-brand-cyan">{currentModelObj.displayName || currentModelVal}</span>
            </span>
            <span
              className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                currentModelObj.capabilitySource === "provider"
                  ? "bg-ok/15 text-ok border-ok/30"
                  : currentModelObj.capabilitySource === "seed"
                    ? "bg-brand-blue/15 text-brand-blue border-brand-blue/30"
                    : "bg-muted/15 text-muted border-line"
              }`}
            >
              {currentModelObj.capabilitySource === "provider"
                ? t("sourceLive")
                : currentModelObj.capabilitySource === "seed"
                  ? t("sourceSeed")
                  : t("sourceUnknown")}
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 text-xs">
            {/* Vision */}
            <div
              className={`p-2 rounded-lg border flex items-center justify-between ${
                supportsVision ? "bg-ok/10 border-ok/25 text-ok" : "bg-panel border-line text-muted"
              }`}
            >
              <div className="flex items-center gap-1.5 font-medium">
                <Eye size={14} />
                <span>{t("capVision")}</span>
              </div>
              <span className="text-[10px] font-bold">
                {supportsVision ? t("supported") : t("unsupported")}
              </span>
            </div>

            {/* Speech / STT */}
            <div
              className={`p-2 rounded-lg border flex items-center justify-between ${
                supportsStt ? "bg-ok/10 border-ok/25 text-ok" : "bg-panel border-line text-muted"
              }`}
            >
              <div className="flex items-center gap-1.5 font-medium">
                <Mic size={14} />
                <span>{t("capStt")}</span>
              </div>
              <span className="text-[10px] font-bold">
                {supportsStt ? t("supported") : t("unsupported")}
              </span>
            </div>

            {/* Audio Input */}
            <div
              className={`p-2 rounded-lg border flex items-center justify-between ${
                currentModelObj.capabilities.audioInput
                  ? "bg-ok/10 border-ok/25 text-ok"
                  : "bg-panel border-line text-muted"
              }`}
            >
              <div className="flex items-center gap-1.5 font-medium">
                <Volume2 size={14} />
                <span>{t("capAudio")}</span>
              </div>
              <span className="text-[10px] font-bold">
                {currentModelObj.capabilities.audioInput ? t("supported") : t("unsupported")}
              </span>
            </div>

            {/* Text I/O */}
            <div
              className={`p-2 rounded-lg border flex items-center justify-between ${
                currentModelObj.capabilities.textInput && currentModelObj.capabilities.textOutput
                  ? "bg-ok/10 border-ok/25 text-ok"
                  : "bg-panel border-line text-muted"
              }`}
            >
              <div className="flex items-center gap-1.5 font-medium">
                <FileText size={14} />
                <span>{t("capText")}</span>
              </div>
              <span className="text-[10px] font-bold">
                {currentModelObj.capabilities.textInput && currentModelObj.capabilities.textOutput
                  ? t("supported")
                  : t("unsupported")}
              </span>
            </div>

            <div
              className={`p-2 rounded-lg border flex items-center justify-between ${
                currentModelObj.capabilities.pdfInput
                  ? "bg-ok/10 border-ok/25 text-ok"
                  : "bg-panel border-line text-muted"
              }`}
            >
              <div className="flex items-center gap-1.5 font-medium">
                <FileText size={14} />
                <span>{t("capPdf")}</span>
              </div>
              <span className="text-[10px] font-bold">
                {currentModelObj.capabilities.pdfInput ? t("supported") : t("unsupported")}
              </span>
            </div>

            <div
              className={`p-2 rounded-lg border flex items-center justify-between ${
                currentModelObj.capabilities.videoInput
                  ? "bg-ok/10 border-ok/25 text-ok"
                  : "bg-panel border-line text-muted"
              }`}
            >
              <div className="flex items-center gap-1.5 font-medium">
                <Eye size={14} />
                <span>{t("capVideo")}</span>
              </div>
              <span className="text-[10px] font-bold">
                {currentModelObj.capabilities.videoInput ? t("supported") : t("unsupported")}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Model Capabilities & Toggles */}
      <div className="rounded-2xl border border-line bg-panel p-4 sm:p-6 shadow-sm flex flex-col gap-4">
        <h3 className="text-base font-bold text-text-main">{t("capabilities")}</h3>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {/* Vision Toggle */}
          <div className="relative rounded-xl border border-line bg-panel-raised p-4 flex flex-col justify-between gap-3">
            <div className="absolute top-3.5 end-3.5">
              <Toggle
                checked={Boolean(settings["ai_vision_enabled"]) && supportsVision}
                disabled={!supportsVision}
                onChange={(val) => {
                  if (supportsVision) updateSetting("ai_vision_enabled", val);
                }}
              />
            </div>
            <div className="pe-12">
              <div className="flex items-center gap-2 text-text-main mb-1">
                <Eye size={17} className={supportsVision ? "text-brand-cyan shrink-0" : "text-muted shrink-0"} />
                <span className="font-bold text-sm">{t("aiVision")}</span>
              </div>
              <p className="text-xs text-muted leading-relaxed">{t("aiVisionDesc")}</p>
              {!supportsVision && (
                <p className="text-[11px] text-amber-500 font-semibold mt-2 flex items-center gap-1">
                  <AlertTriangle size={13} className="shrink-0" />
                  <span>{t("visionUnsupportedNotice")}</span>
                </p>
              )}
            </div>
          </div>

          {/* STT Toggle (Speech-to-Text) */}
          <div className="relative rounded-xl border border-line bg-panel-raised p-4 flex flex-col justify-between gap-3">
            <div className="absolute top-3.5 end-3.5">
              <Toggle
                checked={Boolean(settings["ai_stt_enabled"] ?? true) && supportsStt}
                disabled={!supportsStt}
                onChange={(val) => {
                  if (supportsStt) updateSetting("ai_stt_enabled", val);
                }}
              />
            </div>
            <div className="pe-12">
              <div className="flex items-center gap-2 text-text-main mb-1">
                <Mic size={17} className={supportsStt ? "text-purple-400 shrink-0" : "text-muted shrink-0"} />
                <span className="font-bold text-sm">{t("aiSttEnabled")}</span>
              </div>
              <p className="text-xs text-muted leading-relaxed">{t("aiSttEnabledDesc")}</p>
              {!supportsStt && (
                <p className="text-[11px] text-amber-500 font-semibold mt-2 flex items-center gap-1">
                  <AlertTriangle size={13} className="shrink-0" />
                  <span>{t("sttUnsupportedNotice")}</span>
                </p>
              )}
            </div>
          </div>

          {/* STT Provider Selector */}
          <div className="rounded-xl border border-line bg-panel-raised p-4 flex flex-col justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-text-main mb-1">
                <Mic size={17} className="text-purple-400 shrink-0" />
                <span className="font-bold text-sm">{t("aiStt")}</span>
              </div>
              <p className="text-xs text-muted leading-relaxed">{t("sttDesc")}</p>
            </div>
            <select
              className="w-full h-10 px-3 rounded-lg border border-line bg-panel text-text-main text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-brand-blue/50 disabled:opacity-50"
              value={settings["ai_stt_provider"] || "auto"}
              disabled={!supportsStt}
              onChange={(e) => {
                if (supportsStt) updateSetting("ai_stt_provider", e.target.value);
              }}
            >
              <option value="auto">{t("sttAuto")}</option>
              <option value="gemini">{t("sttGemini")}</option>
              <option value="openai">{t("sttOpenAI")}</option>
            </select>
          </div>

          {/* Bot Language Selector */}
          <div className="rounded-xl border border-line bg-panel-raised p-4 flex flex-col justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-text-main mb-1">
                <Globe size={17} className="text-ok shrink-0" />
                <span className="font-bold text-sm">{t("botLanguage")}</span>
              </div>
              <p className="text-xs text-muted leading-relaxed">{t("botLanguageDesc")}</p>
            </div>
            <select
              className="w-full h-10 px-3 rounded-lg border border-line bg-panel text-text-main text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
              value={settings["bot_language"] || "auto"}
              onChange={(e) => updateSetting("bot_language", e.target.value)}
            >
              <option value="auto">{t("langAuto")}</option>
              <option value="ar">{t("langAr")}</option>
              <option value="en">{t("langEn")}</option>
            </select>
          </div>
        </div>
      </div>

      {/* Persona Prompt & Long-term Memory Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-5">
        <div className="rounded-2xl border border-line bg-panel p-4 sm:p-6 shadow-sm flex flex-col justify-between gap-4">
          <div>
            <div className="flex items-center gap-2.5 text-text-main mb-2">
              <FileText size={20} className="text-brand-blue shrink-0" />
              <h3 className="text-base font-bold">{t("personaPrompt")}</h3>
            </div>
            <p className="text-xs sm:text-sm text-muted leading-relaxed">{t("personaDesc")}</p>
          </div>
          <button
            type="button"
            onClick={openPersonaEditor}
            className="w-full h-11 rounded-xl border border-line bg-panel-raised hover:bg-panel-hover text-text-main font-bold text-xs sm:text-sm transition-colors focus-visible:ring-2 focus-visible:ring-brand-blue/50 flex items-center justify-center gap-2"
          >
            <span>{t("editPersona")}</span>
          </button>
        </div>

        <div className="rounded-2xl border border-line bg-panel p-4 sm:p-6 shadow-sm flex flex-col justify-between gap-4">
          <div>
            <div className="flex items-center gap-2.5 text-text-main mb-2">
              <Database size={20} className="text-brand-cyan shrink-0" />
              <h3 className="text-base font-bold">{t("memoryFiles")}</h3>
            </div>
            <p className="text-xs sm:text-sm text-muted leading-relaxed">{t("memoryDesc")}</p>
          </div>
          <button
            type="button"
            onClick={() => {
              loadMemoryFiles();
              setSelectedMemoryFile("global");
              viewMemoryFile("global");
            }}
            className="w-full h-11 rounded-xl border border-line bg-panel-raised hover:bg-panel-hover text-text-main font-bold text-xs sm:text-sm transition-colors focus-visible:ring-2 focus-visible:ring-brand-blue/50 flex items-center justify-center gap-2"
          >
            <span>{t("manageMemory")}</span>
          </button>
        </div>
      </div>

      {/* Persona Prompt Modal */}
      <Modal
        isOpen={personaModalOpen}
        onClose={() => setPersonaModalOpen(false)}
        title={t("personaPrompt")}
        maxWidth="750px"
        footer={
          <div className="flex items-center justify-end gap-2.5 w-full">
            <button
              type="button"
              onClick={() => setPersonaModalOpen(false)}
              className="px-4 h-10 rounded-xl border border-line bg-panel-raised hover:bg-panel-hover text-text-main font-bold text-xs sm:text-sm transition-colors"
            >
              {t("cancel")}
            </button>
            <button
              type="button"
              onClick={savePersona}
              className="px-5 h-10 rounded-xl bg-brand-blue hover:bg-brand-blue/90 text-white font-bold text-xs sm:text-sm shadow-md shadow-brand-blue/25 transition-colors flex items-center gap-2"
            >
              <Save size={16} />
              <span>{t("save")}</span>
            </button>
          </div>
        }
      >
        <textarea
          className="w-full rounded-xl border border-line bg-panel-raised p-3.5 text-text-main font-mono text-xs sm:text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
          rows={12}
          value={personaText}
          onChange={(e) => setPersonaText(e.target.value)}
        />
      </Modal>

      {/* Memory File Modal */}
      <Modal
        isOpen={Boolean(selectedMemoryFile)}
        onClose={() => setSelectedMemoryFile(null)}
        title={`Memory File: ${selectedMemoryFile || ""}`}
        maxWidth="750px"
        footer={
          <div className="flex items-center justify-end gap-2.5 w-full">
            <button
              type="button"
              onClick={() => setSelectedMemoryFile(null)}
              className="px-4 h-10 rounded-xl border border-line bg-panel-raised hover:bg-panel-hover text-text-main font-bold text-xs sm:text-sm transition-colors"
            >
              {t("cancel")}
            </button>
            <button
              type="button"
              onClick={saveMemoryFile}
              className="px-5 h-10 rounded-xl bg-brand-blue hover:bg-brand-blue/90 text-white font-bold text-xs sm:text-sm shadow-md shadow-brand-blue/25 transition-colors flex items-center gap-2"
            >
              <Save size={16} />
              <span>{t("save")}</span>
            </button>
          </div>
        }
      >
        <textarea
          className="w-full rounded-xl border border-line bg-panel-raised p-3.5 text-text-main font-mono text-xs sm:text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
          rows={12}
          value={memoryContent}
          onChange={(e) => setMemoryContent(e.target.value)}
        />
      </Modal>
    </div>
  );
};

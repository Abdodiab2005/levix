// file: frontend/src/views/AIAssistantView.tsx

import {
  Bot,
  Check,
  Database,
  Eye,
  FileText,
  Globe,
  Key,
  Mic,
  RefreshCw,
  Save,
  Sparkles,
} from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { api } from "../api/client";
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

const SEEDED_MODELS: Record<string, string[]> = {
  gemini: [
    "gemini-3.7-flash",
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "gemini-2.0-flash",
    "gemini-2.0-flash-thinking-exp",
  ],
  groq: [
    "llama-3.3-70b-versatile",
    "llama-3.1-70b-versatile",
    "llama-3.1-8b-instant",
    "qwen-2.5-32b",
    "deepseek-r1-distill-llama-70b",
  ],
  openai: ["gpt-4o", "gpt-4o-mini", "o3-mini", "o1", "gpt-4.5-preview"],
  ollama: ["llama3.3", "llama3.2", "qwen2.5", "deepseek-r1", "mistral"],
  anthropic: [
    "claude-3-7-sonnet-20250219",
    "claude-3-5-sonnet-20241022",
    "claude-3-5-haiku-20241022",
  ],
};

export const AIAssistantView: React.FC = () => {
  const { t, language } = useI18n();
  const { toast } = useToast();

  const [settings, setSettings] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);

  // Model fetching state
  const [fetchedModels, setFetchedModels] = useState<Record<string, string[]>>({});
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
      defaultModel: "gpt-4o",
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
      defaultModel: "claude-3-7-sonnet-20250219",
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
        res.settings.forEach((s: any) => {
          map[s.key] = s.value;
        });
        setSettings(map);
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

  const handleFetchModels = async () => {
    setFetchingModels(true);
    try {
      const res = await api.fetchAiModels({
        provider: selectedPreset.provider,
        apiKey: settings[selectedPreset.keySetting],
        baseUrl: selectedPreset.baseUrlSetting
          ? settings[selectedPreset.baseUrlSetting]
          : undefined,
      });

      if (res?.models && res.models.length > 0) {
        setFetchedModels((prev) => ({ ...prev, [selectedPreset.id]: res.models }));
        toast(
          language === "ar"
            ? `تم جلب ${res.models.length} نموذجاً متاحاً`
            : `Fetched ${res.models.length} available models`,
          "success",
        );
      } else {
        toast(
          language === "ar"
            ? "لم يتم العثور على نماذج جديدة، تم الإبقاء على القائمة الافتراضية"
            : "No extra models returned; using seeded list",
          "info",
        );
      }
    } catch (err: any) {
      toast(err.message || "Failed to fetch models", "error");
    } finally {
      setFetchingModels(false);
    }
  };

  // Real-time auto-fetch from live provider endpoint when API key is configured
  useEffect(() => {
    const key = settings[selectedPreset.keySetting];
    if (key && !fetchedModels[selectedPreset.id] && !fetchingModels) {
      handleFetchModels();
    }
  }, [selectedPreset.id, settings[selectedPreset.keySetting]]);

  const availableModelList =
    fetchedModels[selectedPreset.id] ||
    SEEDED_MODELS[selectedPreset.id] ||
    SEEDED_MODELS[selectedPreset.provider] ||
    [];

  const currentModelVal = settings[selectedPreset.modelSetting] || selectedPreset.defaultModel;

  const openPersonaEditor = async () => {
    try {
      const res = await api.getPersona();
      setPersonaText(res?.persona || "");
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
      setMemoryFiles(res?.files || []);
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

        {/* Dynamic Provider Inputs with Fetch Models Button */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-4 border-t border-line">
          {/* Model Name Selector / Input */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor="input-model-name" className="block text-xs font-bold text-muted">
                {t("modelName")}
              </label>
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
                  onClick={handleFetchModels}
                  disabled={fetchingModels}
                  className="inline-flex items-center gap-1 text-[11px] text-brand-blue hover:text-brand-blue/80 font-bold"
                  title={t("fetchModels")}
                >
                  <RefreshCw size={11} className={fetchingModels ? "animate-spin" : ""} />
                  <span>{fetchingModels ? t("fetchingModels") : t("fetchModels")}</span>
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
                {/* Available / Seeded models */}
                {availableModelList.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
                {!availableModelList.includes(currentModelVal) && (
                  <option value={currentModelVal}>{currentModelVal} (حالي)</option>
                )}
              </select>
            )}
          </div>

          {/* API Key */}
          <div className="space-y-1.5">
            <label htmlFor="input-api-key" className="block text-xs font-bold text-muted">
              {t("apiKey")}
            </label>
            <input
              id="input-api-key"
              type="password"
              className="w-full h-11 px-3.5 rounded-xl border border-line bg-panel-raised text-text-main font-mono text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
              value={settings[selectedPreset.keySetting] || ""}
              onChange={(e) =>
                setSettings({ ...settings, [selectedPreset.keySetting]: e.target.value })
              }
              onBlur={(e) => updateSetting(selectedPreset.keySetting, e.target.value)}
              placeholder="(set or update API key)"
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
                checked={Boolean(settings["ai_vision_enabled"])}
                onChange={(val) => updateSetting("ai_vision_enabled", val)}
              />
            </div>
            <div className="pe-12">
              <div className="flex items-center gap-2 text-text-main mb-1">
                <Eye size={17} className="text-brand-cyan shrink-0" />
                <span className="font-bold text-sm">{t("aiVision")}</span>
              </div>
              <p className="text-xs text-muted leading-relaxed">{t("aiVisionDesc")}</p>
            </div>
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
              className="w-full h-10 px-3 rounded-lg border border-line bg-panel text-text-main text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
              value={settings["ai_stt_provider"] || "auto"}
              onChange={(e) => updateSetting("ai_stt_provider", e.target.value)}
            >
              <option value="auto">{t("sttAuto")}</option>
              <option value="gemini">{t("sttGemini")}</option>
              <option value="openai">{t("sttOpenAI")}</option>
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
              setSelectedMemoryFile("general.md");
              viewMemoryFile("general.md");
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

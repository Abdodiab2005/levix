// file: frontend/src/views/AIAssistantView.tsx

import { Bot, Check, Database, Eye, FileText, Globe, Key, Mic, Save, Sparkles } from "lucide-react";
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

export const AIAssistantView: React.FC = () => {
  const { t } = useI18n();
  const { toast } = useToast();

  const [settings, setSettings] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

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
      toast(`Switched provider to ${p.name}`, "success");
    } catch (err: any) {
      toast(err.message, "error");
    }
  };

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
      toast("Persona updated successfully!", "success");
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
      toast("Memory file updated!", "success");
      setSelectedMemoryFile(null);
    } catch (err: any) {
      toast(err.message, "error");
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-12 text-muted">
        <div className="pulse-dot mr-2" />
        <span className="text-sm font-semibold">{t("starting")}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Master Toggle Header Card */}
      <div className="rounded-2xl border border-line bg-gradient-to-br from-panel-raised via-panel to-panel p-6 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-5">
        <div className="flex items-center gap-4 min-w-0 flex-1">
          <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-brand-blue to-brand-cyan text-white flex items-center justify-center shrink-0 shadow-md shadow-brand-blue/20">
            <Bot size={24} />
          </div>
          <div className="min-w-0">
            <h2 className="text-lg sm:text-xl font-extrabold text-text-main truncate">
              {t("aiTitle")}
            </h2>
            <p className="text-xs sm:text-sm text-muted mt-0.5 truncate">{t("aiSubtitle")}</p>
          </div>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <Toggle
            checked={Boolean(settings["ai_agent"])}
            onChange={(val) => updateSetting("ai_agent", val)}
            label={t("aiAgentEnabled")}
          />
        </div>
      </div>

      {/* Quick Setup Wizard Card */}
      <div className="rounded-2xl border border-line bg-panel p-6 shadow-sm flex flex-col gap-5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <Sparkles size={18} className="text-brand-cyan shrink-0" />
            <h3 className="text-base font-bold text-text-main">{t("quickSetup")}</h3>
          </div>
          <span className="text-xs text-muted font-medium">
            Active: <strong className="text-brand-cyan">{selectedPreset.name}</strong>
          </span>
        </div>

        {/* 5-Column Responsive Presets Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3.5">
          {presets.map((p) => {
            const isActive = selectedPreset.id === p.id;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => selectPreset(p)}
                className={`text-start rounded-xl border p-4 transition-all flex flex-col justify-between gap-2 min-h-[105px] relative focus-visible:ring-2 focus-visible:ring-brand-blue/50 ${
                  isActive
                    ? "border-brand-cyan bg-gradient-to-b from-brand-blue/15 to-brand-cyan/5 shadow-md shadow-brand-cyan/10"
                    : "border-line bg-panel-raised hover:bg-panel-hover hover:border-line-soft"
                }`}
              >
                <div className="flex items-center justify-between w-full">
                  <span className="font-bold text-xs sm:text-sm text-text-main">
                    <bdi>{p.name}</bdi>
                  </span>
                  {isActive && (
                    <span className="w-5 h-5 rounded-full bg-brand-cyan/20 text-brand-cyan flex items-center justify-center shrink-0">
                      <Check size={13} strokeWidth={3} />
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-muted line-clamp-2 leading-relaxed">
                  {t(p.descKey as any, p.name)}
                </p>
              </button>
            );
          })}
        </div>

        {/* Dynamic Provider Inputs */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-5 border-t border-line">
          <div className="space-y-1.5">
            <label htmlFor="input-model-name" className="block text-xs font-bold text-muted">
              {t("modelName")}
            </label>
            <input
              id="input-model-name"
              type="text"
              className="w-full h-11 px-3.5 rounded-xl border border-line bg-panel-raised text-text-main font-mono text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
              value={settings[selectedPreset.modelSetting] || ""}
              onChange={(e) =>
                setSettings({ ...settings, [selectedPreset.modelSetting]: e.target.value })
              }
              onBlur={(e) => updateSetting(selectedPreset.modelSetting, e.target.value)}
              placeholder={selectedPreset.defaultModel}
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="input-api-key" className="block text-xs font-bold text-muted">
              {t("apiKey")}
            </label>
            <input
              id="input-api-key"
              type="password"
              className="w-full h-11 px-3.5 rounded-xl border border-line bg-panel-raised text-text-main font-mono text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
              value={settings[selectedPreset.keySetting] || ""}
              onChange={(e) =>
                setSettings({ ...settings, [selectedPreset.keySetting]: e.target.value })
              }
              onBlur={(e) => updateSetting(selectedPreset.keySetting, e.target.value)}
              placeholder="(set or update API key)"
            />
          </div>

          {selectedPreset.baseUrlSetting && (
            <div className="space-y-1.5">
              <label htmlFor="input-base-url" className="block text-xs font-bold text-muted">
                {t("baseUrl")}
              </label>
              <input
                id="input-base-url"
                type="text"
                className="w-full h-11 px-3.5 rounded-xl border border-line bg-panel-raised text-text-main font-mono text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
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
      <div className="rounded-2xl border border-line bg-panel p-6 shadow-sm flex flex-col gap-4">
        <h3 className="text-base font-bold text-text-main">{t("capabilities")}</h3>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {/* Vision Toggle */}
          <div className="rounded-xl border border-line bg-panel-raised p-4 flex flex-col justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-text-main mb-1.5">
                <Eye size={17} className="text-brand-cyan shrink-0" />
                <span className="font-bold text-sm">{t("aiVision")}</span>
              </div>
              <p className="text-xs text-muted leading-relaxed">{t("aiVisionDesc")}</p>
            </div>
            <Toggle
              checked={Boolean(settings["ai_vision_enabled"])}
              onChange={(val) => updateSetting("ai_vision_enabled", val)}
            />
          </div>

          {/* Bot Language Selector */}
          <div className="rounded-xl border border-line bg-panel-raised p-4 flex flex-col justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-text-main mb-1.5">
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
              <div className="flex items-center gap-2 text-text-main mb-1.5">
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
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <div className="rounded-2xl border border-line bg-panel p-6 shadow-sm flex flex-col justify-between gap-4">
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

        <div className="rounded-2xl border border-line bg-panel p-6 shadow-sm flex flex-col justify-between gap-4">
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
          <div className="flex items-center justify-end gap-3 w-full">
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
          className="w-full rounded-xl border border-line bg-panel-raised p-4 text-text-main font-mono text-xs sm:text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
          rows={14}
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
          <div className="flex items-center justify-end gap-3 w-full">
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
          className="w-full rounded-xl border border-line bg-panel-raised p-4 text-text-main font-mono text-xs sm:text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
          rows={12}
          value={memoryContent}
          onChange={(e) => setMemoryContent(e.target.value)}
        />
      </Modal>
    </div>
  );
};

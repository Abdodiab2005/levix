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
  const [memoryFiles, setMemoryFiles] = useState<string[]>([]);
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
        res.settings.forEach((s) => {
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

  const activeProvider = settings["ai_provider"] || "gemini";
  const activeBaseUrl = settings["openai_base_url"] || "";

  // Identify matching preset
  const selectedPreset =
    presets.find((p) => {
      if (activeProvider === "gemini") return p.id === "gemini";
      if (activeProvider === "anthropic") return p.id === "anthropic";
      if (activeProvider === "openai") {
        if (activeBaseUrl.includes("groq")) return p.id === "groq";
        if (activeBaseUrl.includes("localhost") || activeBaseUrl.includes("11434"))
          return p.id === "ollama";
        return p.id === "openai";
      }
      return false;
    }) || presets[0];

  const selectPreset = async (preset: ProviderPreset) => {
    setSaving(true);
    try {
      await api.updateSetting("ai_provider", preset.provider);
      if (preset.defaultModel) {
        await api.updateSetting(preset.modelSetting, preset.defaultModel);
      }
      if (preset.baseUrlSetting && preset.defaultBaseUrl) {
        await api.updateSetting(preset.baseUrlSetting, preset.defaultBaseUrl);
      }
      setSettings((prev) => ({
        ...prev,
        ai_provider: preset.provider,
        [preset.modelSetting]: preset.defaultModel,
        ...(preset.baseUrlSetting ? { [preset.baseUrlSetting]: preset.defaultBaseUrl } : {}),
      }));
      toast(`Switched to ${preset.name}`, "success");
    } catch (err: any) {
      toast(err.message, "error");
    } finally {
      setSaving(false);
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
      toast("Persona prompt updated!", "success");
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
      setSelectedMemoryFile(name);
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

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      {/* Header card with master toggle */}
      <div className="card-glass">
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "16px",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "14px",
              flex: 1,
              minWidth: "240px",
            }}
          >
            <div
              style={{
                width: "44px",
                height: "44px",
                borderRadius: "12px",
                background: "var(--grad-primary)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <Bot size={24} color="#fff" />
            </div>
            <div>
              <h2 style={{ fontSize: "1.15rem", fontWeight: 700 }}>{t("aiTitle")}</h2>
              <p style={{ fontSize: "0.82rem", color: "var(--muted)", marginTop: "3px" }}>
                {t("aiSubtitle")}
              </p>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "12px", flexShrink: 0 }}>
            <Toggle
              checked={Boolean(settings["ai_agent"])}
              onChange={(val) => updateSetting("ai_agent", val)}
              label={t("aiAgentEnabled")}
            />
          </div>
        </div>
      </div>

      {/* Quick Setup Wizard */}
      <div className="card">
        <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "16px" }}>
          <Sparkles size={18} color="var(--cyan)" style={{ flexShrink: 0 }} />
          <h3 style={{ fontSize: "1rem", fontWeight: 700 }}>{t("quickSetup")}</h3>
        </div>

        <div className="provider-grid">
          {presets.map((p) => {
            const isActive = selectedPreset.id === p.id;
            return (
              <div
                key={p.id}
                className={`provider-card ${isActive ? "active" : ""}`}
                onClick={() => selectPreset(p)}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "8px",
                  }}
                >
                  <span style={{ fontWeight: 700, fontSize: "0.92rem" }}>
                    <bdi>{p.name}</bdi>
                  </span>
                  {isActive && <Check size={16} color="var(--cyan)" style={{ flexShrink: 0 }} />}
                </div>
                <p style={{ fontSize: "0.78rem", color: "var(--muted)", lineHeight: "1.4" }}>
                  {t(p.descKey as any, p.name)}
                </p>
              </div>
            );
          })}
        </div>

        {/* Dynamic Provider Inputs */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
            gap: "16px",
            marginTop: "16px",
          }}
        >
          <div className="form-group">
            <label className="form-label">{t("modelName")}</label>
            <input
              type="text"
              className="form-input input-technical"
              value={settings[selectedPreset.modelSetting] || ""}
              onChange={(e) =>
                setSettings({ ...settings, [selectedPreset.modelSetting]: e.target.value })
              }
              onBlur={(e) => updateSetting(selectedPreset.modelSetting, e.target.value)}
              placeholder={selectedPreset.defaultModel}
            />
          </div>

          <div className="form-group">
            <label className="form-label">{t("apiKey")}</label>
            <input
              type="password"
              className="form-input input-technical"
              value={settings[selectedPreset.keySetting] || ""}
              onChange={(e) =>
                setSettings({ ...settings, [selectedPreset.keySetting]: e.target.value })
              }
              onBlur={(e) => updateSetting(selectedPreset.keySetting, e.target.value)}
              placeholder="(set or update API key)"
            />
          </div>

          {selectedPreset.baseUrlSetting &&
            (() => {
              const baseUrlKey = selectedPreset.baseUrlSetting;
              return (
                <div className="form-group">
                  <label className="form-label">{t("baseUrl")}</label>
                  <input
                    type="text"
                    className="form-input input-technical"
                    value={settings[baseUrlKey] || ""}
                    onChange={(e) => setSettings({ ...settings, [baseUrlKey]: e.target.value })}
                    onBlur={(e) => updateSetting(baseUrlKey, e.target.value)}
                    placeholder={selectedPreset.defaultBaseUrl}
                  />
                </div>
              );
            })()}
        </div>
      </div>

      {/* Model Capabilities & Toggles */}
      <div className="card" style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        <h3 style={{ fontSize: "1rem", fontWeight: 700 }}>{t("capabilities")}</h3>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
            gap: "16px",
          }}
        >
          {/* Vision Toggle */}
          <div
            style={{
              padding: "14px",
              borderRadius: "var(--radius-sm)",
              background: "var(--panel-raised)",
              border: "1px solid var(--line)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
              <Eye size={17} color="var(--blue-bright)" style={{ flexShrink: 0 }} />
              <span style={{ fontWeight: 600, fontSize: "0.9rem" }}>{t("aiVision")}</span>
            </div>
            <p
              style={{
                fontSize: "0.8rem",
                color: "var(--muted)",
                marginBottom: "12px",
                lineHeight: "1.4",
              }}
            >
              {t("aiVisionDesc")}
            </p>
            <Toggle
              checked={Boolean(settings["ai_vision_enabled"])}
              onChange={(val) => updateSetting("ai_vision_enabled", val)}
            />
          </div>

          {/* Bot Language Selector */}
          <div
            style={{
              padding: "14px",
              borderRadius: "var(--radius-sm)",
              background: "var(--panel-raised)",
              border: "1px solid var(--line)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
              <Globe size={17} color="var(--ok)" style={{ flexShrink: 0 }} />
              <span style={{ fontWeight: 600, fontSize: "0.9rem" }}>{t("botLanguage")}</span>
            </div>
            <p
              style={{
                fontSize: "0.8rem",
                color: "var(--muted)",
                marginBottom: "12px",
                lineHeight: "1.4",
              }}
            >
              {t("botLanguageDesc")}
            </p>
            <select
              className="form-select"
              value={settings["bot_language"] || "auto"}
              onChange={(e) => updateSetting("bot_language", e.target.value)}
            >
              <option value="auto">{t("langAuto")}</option>
              <option value="ar">{t("langAr")}</option>
              <option value="en">{t("langEn")}</option>
            </select>
          </div>

          {/* STT Provider Selector */}
          <div
            style={{
              padding: "14px",
              borderRadius: "var(--radius-sm)",
              background: "var(--panel-raised)",
              border: "1px solid var(--line)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
              <Mic size={17} color="var(--purple)" style={{ flexShrink: 0 }} />
              <span style={{ fontWeight: 600, fontSize: "0.9rem" }}>{t("aiStt")}</span>
            </div>
            <p
              style={{
                fontSize: "0.8rem",
                color: "var(--muted)",
                marginBottom: "12px",
                lineHeight: "1.4",
              }}
            >
              {t("sttDesc")}
            </p>
            <select
              className="form-select"
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

      {/* Persona Prompt & Long-term Memory Actions */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
          gap: "16px",
        }}
      >
        <div
          className="card"
          style={{ display: "flex", flexDirection: "column", justifyContent: "space-between" }}
        >
          <div>
            <div
              style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "8px" }}
            >
              <FileText size={18} color="var(--blue-bright)" style={{ flexShrink: 0 }} />
              <h3 style={{ fontSize: "1rem", fontWeight: 700 }}>{t("personaPrompt")}</h3>
            </div>
            <p style={{ fontSize: "0.82rem", color: "var(--muted)", lineHeight: "1.5" }}>
              {t("personaDesc")}
            </p>
          </div>
          <div style={{ marginTop: "16px" }}>
            <button
              onClick={openPersonaEditor}
              className="btn btn-secondary"
              style={{ width: "100%" }}
            >
              {t("editPersona")}
            </button>
          </div>
        </div>

        <div
          className="card"
          style={{ display: "flex", flexDirection: "column", justifyContent: "space-between" }}
        >
          <div>
            <div
              style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "8px" }}
            >
              <Database size={18} color="var(--cyan)" style={{ flexShrink: 0 }} />
              <h3 style={{ fontSize: "1rem", fontWeight: 700 }}>{t("memoryFiles")}</h3>
            </div>
            <p style={{ fontSize: "0.82rem", color: "var(--muted)", lineHeight: "1.5" }}>
              {t("memoryDesc")}
            </p>
          </div>
          <div style={{ marginTop: "16px" }}>
            <button
              onClick={() => {
                loadMemoryFiles();
                setSelectedMemoryFile("general.md");
                viewMemoryFile("general.md");
              }}
              className="btn btn-secondary"
              style={{ width: "100%" }}
            >
              {t("manageMemory")}
            </button>
          </div>
        </div>
      </div>

      {/* Persona Prompt Modal */}
      <Modal
        isOpen={personaModalOpen}
        onClose={() => setPersonaModalOpen(false)}
        title={t("personaPrompt")}
        maxWidth="750px"
        footer={
          <>
            <button onClick={() => setPersonaModalOpen(false)} className="btn btn-secondary">
              {t("cancel")}
            </button>
            <button onClick={savePersona} className="btn btn-primary">
              <Save size={15} />
              <span>{t("save")}</span>
            </button>
          </>
        }
      >
        <textarea
          className="form-textarea input-technical"
          rows={14}
          value={personaText}
          onChange={(e) => setPersonaText(e.target.value)}
          style={{ fontSize: "0.84rem", lineHeight: "1.5" }}
        />
      </Modal>

      {/* Memory File Modal */}
      <Modal
        isOpen={Boolean(selectedMemoryFile)}
        onClose={() => setSelectedMemoryFile(null)}
        title={`Memory File: ${selectedMemoryFile || ""}`}
        maxWidth="750px"
        footer={
          <>
            <button onClick={() => setSelectedMemoryFile(null)} className="btn btn-secondary">
              {t("cancel")}
            </button>
            <button onClick={saveMemoryFile} className="btn btn-primary">
              <Save size={15} />
              <span>{t("save")}</span>
            </button>
          </>
        }
      >
        <textarea
          className="form-textarea input-technical"
          rows={12}
          value={memoryContent}
          onChange={(e) => setMemoryContent(e.target.value)}
          style={{ fontSize: "0.84rem" }}
        />
      </Modal>
    </div>
  );
};

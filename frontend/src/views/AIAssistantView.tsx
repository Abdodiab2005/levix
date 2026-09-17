// file: frontend/src/views/AIAssistantView.tsx
import React, { useEffect, useState } from "react";
import { Bot, Sparkles, Eye, Mic, Globe, Key, FileText, Database, Check, Save } from "lucide-react";
import { api } from "../api/client";
import { useI18n } from "../context/I18nContext";
import { useToast } from "../components/Toasts";
import { Toggle } from "../components/Toggle";
import { Modal } from "../components/Modal";

interface ProviderPreset {
  id: string;
  name: string;
  desc: string;
  provider: "gemini" | "openai" | "anthropic";
  defaultModel: string;
  defaultBaseUrl: string;
  keySetting: string;
  modelSetting: string;
  baseUrlSetting?: string;
  supportsVision: boolean;
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
      desc: t("providerGeminiDesc"),
      provider: "gemini",
      defaultModel: "gemini-3.7-flash",
      defaultBaseUrl: "",
      keySetting: "gemini_api_key",
      modelSetting: "gemini_model",
      baseUrlSetting: "gemini_base_url",
      supportsVision: true,
    },
    {
      id: "groq",
      name: "Groq Cloud",
      desc: t("providerGroqDesc"),
      provider: "openai",
      defaultModel: "llama-3.3-70b-versatile",
      defaultBaseUrl: "https://api.groq.com/openai/v1",
      keySetting: "openai_api_key",
      modelSetting: "openai_model",
      baseUrlSetting: "openai_base_url",
      supportsVision: true,
    },
    {
      id: "openai",
      name: "OpenAI",
      desc: t("providerOpenAIDesc"),
      provider: "openai",
      defaultModel: "gpt-4o",
      defaultBaseUrl: "https://api.openai.com/v1",
      keySetting: "openai_api_key",
      modelSetting: "openai_model",
      baseUrlSetting: "openai_base_url",
      supportsVision: true,
    },
    {
      id: "ollama",
      name: "Ollama (Local)",
      desc: t("providerOllamaDesc"),
      provider: "openai",
      defaultModel: "llama3.2",
      defaultBaseUrl: "http://localhost:11434/v1",
      keySetting: "openai_api_key",
      modelSetting: "openai_model",
      baseUrlSetting: "openai_base_url",
      supportsVision: true,
    },
    {
      id: "anthropic",
      name: "Anthropic Claude",
      desc: t("providerAnthropicDesc"),
      provider: "anthropic",
      defaultModel: "claude-3-7-sonnet-20250219",
      defaultBaseUrl: "https://api.anthropic.com",
      keySetting: "anthropic_api_key",
      modelSetting: "anthropic_model",
      baseUrlSetting: "anthropic_base_url",
      supportsVision: true,
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
  let selectedPreset = presets.find((p) => {
    if (activeProvider === "gemini") return p.id === "gemini";
    if (activeProvider === "anthropic") return p.id === "anthropic";
    if (activeProvider === "openai") {
      if (activeBaseUrl.includes("groq")) return p.id === "groq";
      if (activeBaseUrl.includes("localhost") || activeBaseUrl.includes("11434")) return p.id === "ollama";
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
    <div style={{ display: "flex", flexDirection: "column", gap: "28px" }}>
      {/* Header card with master toggle */}
      <div className="card-glass">
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "20px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
            <div style={{ width: "48px", height: "48px", borderRadius: "12px", background: "var(--grad-primary)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Bot size={26} color="#fff" />
            </div>
            <div>
              <h2 style={{ fontSize: "1.25rem", fontWeight: 700 }}>{t("aiTitle")}</h2>
              <p style={{ fontSize: "0.85rem", color: "var(--muted)", marginTop: "4px" }}>{t("aiSubtitle")}</p>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
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
        <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "18px" }}>
          <Sparkles size={20} color="var(--cyan)" />
          <h3 style={{ fontSize: "1.05rem", fontWeight: 700 }}>{t("quickSetup")}</h3>
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
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ fontWeight: 700, fontSize: "0.95rem" }}>{p.name}</span>
                  {isActive && <Check size={18} color="var(--cyan)" />}
                </div>
                <p style={{ fontSize: "0.8rem", color: "var(--muted)", lineHeight: "1.4" }}>
                  {p.desc}
                </p>
              </div>
            );
          })}
        </div>

        {/* Dynamic Provider Inputs */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "20px", marginTop: "20px" }}>
          <div className="form-group">
            <label className="form-label">{t("modelName")}</label>
            <input
              type="text"
              className="form-input"
              value={settings[selectedPreset.modelSetting] || ""}
              onChange={(e) => setSettings({ ...settings, [selectedPreset.modelSetting]: e.target.value })}
              onBlur={(e) => updateSetting(selectedPreset.modelSetting, e.target.value)}
              placeholder={selectedPreset.defaultModel}
            />
          </div>

          <div className="form-group">
            <label className="form-label">{t("apiKey")}</label>
            <input
              type="password"
              className="form-input"
              value={settings[selectedPreset.keySetting] || ""}
              onChange={(e) => setSettings({ ...settings, [selectedPreset.keySetting]: e.target.value })}
              onBlur={(e) => updateSetting(selectedPreset.keySetting, e.target.value)}
              placeholder="(set or update API key)"
            />
          </div>

          {selectedPreset.baseUrlSetting && (() => {
            const baseUrlKey = selectedPreset.baseUrlSetting;
            return (
              <div className="form-group">
                <label className="form-label">{t("baseUrl")}</label>
                <input
                  type="text"
                  className="form-input"
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
      <div className="card" style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
        <h3 style={{ fontSize: "1.05rem", fontWeight: 700 }}>Capabilities & Toggles</h3>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "24px" }}>
          {/* Vision Toggle */}
          <div style={{ padding: "16px", borderRadius: "var(--radius-sm)", background: "var(--panel-raised)", border: "1px solid var(--line)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "10px" }}>
              <Eye size={18} color="var(--blue-bright)" />
              <span style={{ fontWeight: 600 }}>{t("aiVision")}</span>
            </div>
            <p style={{ fontSize: "0.82rem", color: "var(--muted)", marginBottom: "14px" }}>
              {t("aiVisionDesc")}
            </p>
            <Toggle
              checked={Boolean(settings["ai_vision_enabled"])}
              onChange={(val) => updateSetting("ai_vision_enabled", val)}
            />
          </div>

          {/* Bot Language Selector */}
          <div style={{ padding: "16px", borderRadius: "var(--radius-sm)", background: "var(--panel-raised)", border: "1px solid var(--line)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "10px" }}>
              <Globe size={18} color="var(--ok)" />
              <span style={{ fontWeight: 600 }}>{t("botLanguage")}</span>
            </div>
            <p style={{ fontSize: "0.82rem", color: "var(--muted)", marginBottom: "14px" }}>
              Set bot response language directly or via command <code style={{ color: "var(--cyan)" }}>!lang</code>
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
          <div style={{ padding: "16px", borderRadius: "var(--radius-sm)", background: "var(--panel-raised)", border: "1px solid var(--line)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "10px" }}>
              <Mic size={18} color="var(--purple)" />
              <span style={{ fontWeight: 600 }}>{t("aiStt")}</span>
            </div>
            <p style={{ fontSize: "0.82rem", color: "var(--muted)", marginBottom: "14px" }}>
              Speech-to-text transcription engine for voice notes
            </p>
            <select
              className="form-select"
              value={settings["ai_stt_provider"] || "auto"}
              onChange={(e) => updateSetting("ai_stt_provider", e.target.value)}
            >
              <option value="auto">Auto (Matches active provider)</option>
              <option value="gemini">Google Gemini Audio API</option>
              <option value="openai">OpenAI / Groq Whisper API</option>
            </select>
          </div>
        </div>
      </div>

      {/* Persona Prompt & Long-term Memory Actions */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "20px" }}>
        <div className="card" style={{ display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "10px" }}>
              <FileText size={20} color="var(--blue-bright)" />
              <h3 style={{ fontSize: "1.05rem", fontWeight: 700 }}>{t("personaPrompt")}</h3>
            </div>
            <p style={{ fontSize: "0.85rem", color: "var(--muted)", lineHeight: "1.5" }}>
              Edit the live system prompt that shapes your AI assistant's persona, tone, and behavior.
            </p>
          </div>
          <div style={{ marginTop: "20px" }}>
            <button onClick={openPersonaEditor} className="btn btn-secondary" style={{ width: "100%" }}>
              Edit System Prompt
            </button>
          </div>
        </div>

        <div className="card" style={{ display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "10px" }}>
              <Database size={20} color="var(--cyan)" />
              <h3 style={{ fontSize: "1.05rem", fontWeight: 700 }}>{t("memoryFiles")}</h3>
            </div>
            <p style={{ fontSize: "0.85rem", color: "var(--muted)", lineHeight: "1.5" }}>
              Inspect and manage markdown memory documents stored inside the data directory.
            </p>
          </div>
          <div style={{ marginTop: "20px" }}>
            <button
              onClick={() => {
                loadMemoryFiles();
                setSelectedMemoryFile("general.md");
                viewMemoryFile("general.md");
              }}
              className="btn btn-secondary"
              style={{ width: "100%" }}
            >
              Manage Memory Files
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
              <Save size={16} />
              <span>{t("save")}</span>
            </button>
          </>
        }
      >
        <textarea
          className="form-textarea"
          rows={16}
          value={personaText}
          onChange={(e) => setPersonaText(e.target.value)}
          style={{ fontFamily: "var(--font-mono)", fontSize: "0.85rem", lineHeight: "1.5" }}
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
              <Save size={16} />
              <span>{t("save")}</span>
            </button>
          </>
        }
      >
        <textarea
          className="form-textarea"
          rows={14}
          value={memoryContent}
          onChange={(e) => setMemoryContent(e.target.value)}
          style={{ fontFamily: "var(--font-mono)", fontSize: "0.85rem" }}
        />
      </Modal>
    </div>
  );
};

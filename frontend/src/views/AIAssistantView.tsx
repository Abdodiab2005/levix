import {
  AlertCircle,
  AlertTriangle,
  Bot,
  Check,
  CheckCircle2,
  ChevronLeft,
  Database,
  Eye,
  FileText,
  Globe,
  History,
  MessageSquare,
  Mic,
  RefreshCw,
  Save,
  Sparkles,
  Volume2,
} from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { api, type NormalizedModel } from "../api/client";
import { useToast } from "../components/Toasts";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Dialog,
  EmptyState,
  Field,
  IconButton,
  Input,
  LoadingState,
  Select,
  Spinner,
  StatusPill,
  Textarea,
  Toggle,
} from "../components/ui";
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
  const [memoryScopes, setMemoryScopes] = useState<
    Array<{ scope: string; label: string; entries: number }>
  >([]);
  const [selectedMemoryFile, setSelectedMemoryFile] = useState<string | null>(null);
  const [memoryContent, setMemoryContent] = useState("");
  const [memoryLoading, setMemoryLoading] = useState(false);

  // Conversation inspector (read-only)
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [conversations, setConversations] = useState<
    Array<{ chatId: string; turns: number; updatedAt: number | null }>
  >([]);
  const [selectedConversation, setSelectedConversation] = useState<string | null>(null);
  const [conversation, setConversation] = useState<{
    chatId: string;
    updatedAt: number | null;
    truncated: boolean;
    messages: Array<{
      role: "user" | "model";
      kind: "text" | "media" | "tool" | "toolResult";
      text?: string;
      mimeType?: string | null;
      name?: string;
    }>;
  } | null>(null);
  const [inspectorLoading, setInspectorLoading] = useState(false);

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

  // `cacheOnly` is the silent load on open: the cached live list, or the
  // recommended one, and never a request to the provider.
  const handleFetchModels = async (forceRefresh = false, cacheOnly = false) => {
    setFetchingModels(true);
    const typedKey = String(settings[selectedPreset.keySetting] || "").trim();
    const hasStoredKey = Boolean(configuredKeys[selectedPreset.keySetting]);

    try {
      const payload: {
        provider: string;
        apiKey?: string;
        baseUrl?: string;
        refresh?: boolean;
        cacheOnly?: boolean;
      } = {
        provider: selectedPreset.provider,
        refresh: forceRefresh,
        cacheOnly,
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

        // Model discovery stays silent on success — the model list updating
        // in place is the feedback. Toasts are for problems only.
        if (!res.live && res.requiresApiKey && forceRefresh) {
          toast(
            language === "ar"
              ? "يرجى إدخال مفتاح API أولاً لاكتشاف النماذج المتاحة لحسابك"
              : "Enter an API key to discover account models",
            "info",
          );
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
      if (!cacheOnly) toast(err.message || "Failed to fetch models", "error");
    } finally {
      setFetchingModels(false);
    }
  };

  // Live discovery is a manual step (the refresh buttons). Opening the view
  // only fills the list from the cache or the recommended models, so the
  // dropdown is never empty and no provider request or toast happens.
  useEffect(() => {
    if (!loading) handleFetchModels(false, true);
  }, [selectedPreset.id, loading]);

  const currentModelList: NormalizedModel[] = discoveryState[selectedPreset.id]?.models || [];
  const isLiveVerified = Boolean(discoveryState[selectedPreset.id]?.live);
  const requiresApiKey = Boolean(
    discoveryState[selectedPreset.id]?.requiresApiKey ?? !configuredKeys[selectedPreset.keySetting],
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

  // "Unknown" is not "unsupported": a model the registry has never seen (a
  // gateway's own ids, a brand-new Gemini drop) must NOT lock the toggles or
  // trigger the auto-disable below — otherwise changing the base URL to a
  // custom endpoint silently switches vision/STT off and keeps them off.
  // Only catalog/live metadata that explicitly says the capability is missing
  // locks the feature, and only while auto-detection is enabled.
  const capsKnown =
    currentModelObj.capabilitySource === "provider" || currentModelObj.capabilitySource === "seed";
  const autoDetect = settings["ai_auto_detect_capabilities"] !== false;
  const visionLocked = capsKnown && autoDetect && !supportsVision;
  const sttLocked = capsKnown && autoDetect && !supportsStt;

  // Independent capability auto-disabling and clearing of stale incompatible configuration
  useEffect(() => {
    if (loading) return;

    if (visionLocked && settings["ai_vision_enabled"]) {
      updateSetting("ai_vision_enabled", false, true);
    }

    if (sttLocked && settings["ai_stt_enabled"]) {
      updateSetting("ai_stt_enabled", false, true);
    }
  }, [currentModelVal, visionLocked, sttLocked, loading]);

  const openPersonaEditor = async () => {
    try {
      const res = await api.getPersona();
      const persona = res?.persona;
      setPersonaText(typeof persona === "string" ? persona : persona?.body || "");
      setPersonaModalOpen(true);
    } catch (err: any) {
      toast(err.message, "error");
    }
  };

  const savePersona = async () => {
    try {
      await api.updatePersona(personaText);
      toast(
        language === "ar" ? "تم تحديث توجيه الشخصية بنجاح!" : "Persona updated successfully!",
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
      const scopes = (res?.scopes || []).map((s) => ({
        scope: s.scope,
        label: s.label,
        entries: s.entries ?? 0,
      }));
      // The server always lists global first; keep that guarantee if the
      // response is ever empty or the request fails, so the editor can still
      // create the file with its first save.
      setMemoryScopes(
        scopes.some((s) => s.scope === "global")
          ? scopes
          : [{ scope: "global", label: "Global memory", entries: 0 }, ...scopes],
      );
    } catch (err: any) {
      setMemoryScopes([{ scope: "global", label: "Global memory", entries: 0 }]);
      toast(err.message, "error");
    }
  };

  const openMemoryScope = async (scope: string) => {
    setSelectedMemoryFile(scope);
    setMemoryContent("");
    setMemoryLoading(true);
    try {
      const res = await api.getMemoryFile(scope);
      setMemoryContent(res?.content || "");
    } catch (err: any) {
      toast(err.message, "error");
    } finally {
      setMemoryLoading(false);
    }
  };

  const openMemoryManager = async () => {
    setSelectedMemoryFile("global");
    setMemoryLoading(true);
    await loadMemoryFiles();
    try {
      const res = await api.getMemoryFile("global");
      setMemoryContent(res?.content || "");
    } catch (err: any) {
      toast(err.message, "error");
    } finally {
      setMemoryLoading(false);
    }
  };

  const saveMemoryFile = async () => {
    if (!selectedMemoryFile) return;
    try {
      await api.updateMemoryFile(selectedMemoryFile, memoryContent);
      toast(language === "ar" ? "تم حفظ ملف الذاكرة بنجاح!" : "Memory file updated!", "success");
      loadMemoryFiles();
      setSelectedMemoryFile(null);
    } catch (err: any) {
      toast(err.message, "error");
    }
  };

  const openInspector = async () => {
    setInspectorOpen(true);
    setSelectedConversation(null);
    setConversation(null);
    setInspectorLoading(true);
    try {
      const res = await api.getAiConversations();
      setConversations(res?.conversations || []);
    } catch (err: any) {
      toast(err.message, "error");
    } finally {
      setInspectorLoading(false);
    }
  };

  const openConversation = async (chatId: string) => {
    setSelectedConversation(chatId);
    setConversation(null);
    setInspectorLoading(true);
    try {
      const res = await api.getAiConversation(chatId);
      setConversation(res || null);
    } catch (err: any) {
      toast(err.message, "error");
    } finally {
      setInspectorLoading(false);
    }
  };

  const formatStamp = (ts: number | null) =>
    ts
      ? new Date(ts).toLocaleString(language === "ar" ? "ar-EG" : "en-GB", {
          dateStyle: "medium",
          timeStyle: "short",
        })
      : "—";

  if (loading) {
    return <LoadingState text={t("starting")} />;
  }

  return (
    <div className="flex flex-col gap-5 sm:gap-6">
      <Card className="flex flex-col gap-3.5">
        <CardHeader
          icon={<Bot size={20} />}
          title={t("aiTitle")}
          description={t("aiSubtitle")}
          actions={
            <div className="flex items-center gap-2">
              <span className="hidden text-xs font-bold text-muted sm:inline">
                {settings["ai_agent"]
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
                aria-label={t("aiTitle")}
              />
            </div>
          }
        />
        <div className="border-t border-line pt-3">
          <StatusPill tone={settings["ai_agent"] ? "ok" : "danger"} dot pulse>
            {settings["ai_agent"]
              ? t("aiAgentEnabled")
              : language === "ar"
                ? "مساعد الذكاء الاصطناعي معطل"
                : "AI Assistant Disabled"}
          </StatusPill>
        </div>
      </Card>

      <Card className="flex flex-col gap-5">
        <CardHeader
          icon={<Sparkles size={18} />}
          title={t("aiProvider")}
          actions={
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-muted">
                {language === "ar" ? "المزود النشط:" : "Active:"}
              </span>
              <Badge tone="info">
                {selectedPreset.name}
                {" • "}
                <span className="font-mono">{currentModelVal}</span>
              </Badge>
            </div>
          }
        />

        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-3 lg:grid-cols-5">
          {presets.map((p) => {
            const isSelected = selectedPreset.id === p.id;
            return (
              <Button
                key={p.id}
                variant={isSelected ? "primary" : "secondary"}
                aria-pressed={isSelected}
                onClick={() => selectPreset(p)}
                className="h-auto w-full flex-col items-stretch justify-between gap-2.5 px-3.5 py-3.5"
              >
                <span className="flex w-full items-center justify-between">
                  <span className="text-xs font-bold sm:text-sm">{p.name}</span>
                  {isSelected ? (
                    <Check size={14} strokeWidth={3} />
                  ) : (
                    <span className="size-2 rounded-full bg-current opacity-40" />
                  )}
                </span>
                <span className="block truncate text-start font-mono text-[10px] opacity-80 sm:text-[11px]">
                  {p.defaultModel}
                </span>
              </Button>
            );
          })}
        </div>

        {requiresApiKey && (
          <div className="flex items-start gap-3 rounded-xl border border-warn/25 bg-warn/10 p-3.5">
            <AlertTriangle size={18} className="mt-0.5 shrink-0 text-warn" />
            <div className="text-xs text-text-main">
              <p className="font-bold">{t("connectKeyFirstPrompt")}</p>
              <p className="mt-0.5 text-muted">
                {language === "ar"
                  ? "النماذج المعروضة أدناه هي نماذج مقترحة من الدليل المحلي وليست مؤكدة لحسابك حتى يتم ربط المفتاح."
                  : "Models shown below are catalog recommendations and are not verified for your account until a key is configured."}
              </p>
            </div>
          </div>
        )}

        {discoveryState[selectedPreset.id]?.error && (
          <div className="flex items-center justify-between gap-3 rounded-xl border border-danger/25 bg-danger/10 p-3">
            <div className="flex min-w-0 items-center gap-2 text-xs font-semibold text-danger">
              <AlertCircle size={16} className="shrink-0" />
              <span className="min-w-0">{discoveryState[selectedPreset.id]?.error}</span>
            </div>
            <IconButton
              variant="ghost"
              label={t("refreshModels")}
              icon={<RefreshCw size={16} />}
              onClick={() => handleFetchModels(true)}
              loading={fetchingModels}
            />
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 border-t border-line pt-4 md:grid-cols-3">
          <Field
            className="min-w-0"
            htmlFor="input-api-key"
            label={
              <span className="flex w-full items-center justify-between gap-2">
                <span>{t("apiKey")}</span>
                {configuredKeys[selectedPreset.keySetting] && (
                  <Badge tone="ok">
                    <CheckCircle2 size={11} />
                    {language === "ar" ? "محفوظ" : "Saved"}
                  </Badge>
                )}
              </span>
            }
          >
            <Input
              id="input-api-key"
              type="password"
              className="font-mono"
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
          </Field>

          {selectedPreset.baseUrlSetting && (
            <Field className="min-w-0" label={t("baseUrl")} htmlFor="input-base-url">
              <Input
                id="input-base-url"
                type="text"
                className="font-mono"
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
            </Field>
          )}

          <div className="flex min-w-0 flex-col gap-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <label htmlFor="input-model-name" className="text-xs font-bold text-text-main">
                  {t("modelName")}
                </label>
                <Badge tone={isLiveVerified ? "ok" : "info"}>
                  {isLiveVerified ? t("sourceLive") : t("sourceSeed")}
                </Badge>
              </div>
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="sm" onClick={() => setIsCustomModel(!isCustomModel)}>
                  {isCustomModel
                    ? language === "ar"
                      ? "القائمة"
                      : "List"
                    : language === "ar"
                      ? "مخصص"
                      : "Custom"}
                </Button>
                <IconButton
                  variant="ghost"
                  label={t("refreshModels")}
                  icon={<RefreshCw size={16} />}
                  onClick={() => handleFetchModels(true)}
                  loading={fetchingModels}
                />
              </div>
            </div>

            {isCustomModel ? (
              <Input
                id="input-model-name"
                type="text"
                className="font-mono"
                value={settings[selectedPreset.modelSetting] || ""}
                onChange={(e) =>
                  setSettings({ ...settings, [selectedPreset.modelSetting]: e.target.value })
                }
                onBlur={(e) => updateSetting(selectedPreset.modelSetting, e.target.value)}
                placeholder={selectedPreset.defaultModel}
              />
            ) : (
              <Select
                id="input-model-name"
                className="font-mono"
                value={currentModelVal}
                onChange={(e) => {
                  updateSetting(selectedPreset.modelSetting, e.target.value);
                }}
              >
                <optgroup
                  label={isLiveVerified ? t("modelsAvailableLive") : t("modelsRecommendedSeed")}
                >
                  {currentModelList.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.displayName && m.displayName !== m.id
                        ? `${m.displayName} (${m.id})`
                        : m.id}
                      {m.recommended ? " ★" : ""}
                    </option>
                  ))}
                </optgroup>
                {!currentModelList.some(
                  (m) => m.id.toLowerCase() === currentModelVal.toLowerCase(),
                ) && <option value={currentModelVal}>{currentModelVal} (current)</option>}
              </Select>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-2.5 rounded-xl border border-line bg-panel-raised/60 p-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="flex items-center gap-1.5 font-bold text-text-main">
              <Sparkles size={14} className="shrink-0 text-brand-cyan" />
              {language === "ar" ? "القدرات:" : "Capabilities:"}{" "}
              <span className="font-mono text-brand-cyan">
                {currentModelObj.displayName || currentModelVal}
              </span>
            </span>
            <Badge
              tone={
                currentModelObj.capabilitySource === "provider"
                  ? "ok"
                  : currentModelObj.capabilitySource === "seed"
                    ? "info"
                    : "neutral"
              }
            >
              {currentModelObj.capabilitySource === "provider"
                ? t("sourceLive")
                : currentModelObj.capabilitySource === "seed"
                  ? t("sourceSeed")
                  : t("sourceUnknown")}
            </Badge>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 text-xs">
            {[
              { icon: Eye, label: t("capVision"), on: supportsVision },
              { icon: Mic, label: t("capStt"), on: supportsStt },
              {
                icon: Volume2,
                label: t("capAudio"),
                on: Boolean(currentModelObj.capabilities.audioInput),
              },
              {
                icon: FileText,
                label: t("capText"),
                on: Boolean(
                  currentModelObj.capabilities.textInput && currentModelObj.capabilities.textOutput,
                ),
              },
              {
                icon: FileText,
                label: t("capPdf"),
                on: Boolean(currentModelObj.capabilities.pdfInput),
              },
              {
                icon: Eye,
                label: t("capVideo"),
                on: Boolean(currentModelObj.capabilities.videoInput),
              },
            ].map(({ icon: Icon, label, on }) => (
              <div
                key={label}
                className={`p-2 rounded-lg border flex items-center justify-between ${
                  capsKnown && on
                    ? "bg-ok/10 border-ok/25 text-ok"
                    : "bg-panel border-line text-muted"
                }`}
              >
                <div className="flex items-center gap-1.5 font-medium">
                  <Icon size={14} />
                  <span>{label}</span>
                </div>
                <span className="text-[10px] font-bold">
                  {capsKnown ? (on ? t("supported") : t("unsupported")) : "—"}
                </span>
              </div>
            ))}
          </div>
        </div>
      </Card>

      <Card className="flex flex-col gap-4">
        <CardHeader title={t("capabilities")} />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="flex flex-col gap-3 rounded-xl border border-line bg-panel-raised p-4">
            <Toggle
              checked={visionLocked ? false : Boolean(settings["ai_vision_enabled"])}
              disabled={visionLocked}
              onChange={(val) => {
                if (!visionLocked) updateSetting("ai_vision_enabled", val);
              }}
              label={
                <span className="inline-flex items-center gap-2">
                  <Eye
                    size={17}
                    className={visionLocked ? "shrink-0 text-muted" : "shrink-0 text-brand-cyan"}
                  />
                  {t("aiVision")}
                </span>
              }
              description={t("aiVisionDesc")}
            />
            {visionLocked && (
              <p className="flex items-center gap-1 text-[11px] font-semibold text-warn">
                <AlertTriangle size={13} className="shrink-0" />
                <span>{t("visionUnsupportedNotice")}</span>
              </p>
            )}
          </div>

          <div className="flex flex-col gap-3 rounded-xl border border-line bg-panel-raised p-4">
            <Toggle
              checked={sttLocked ? false : Boolean(settings["ai_stt_enabled"] ?? true)}
              disabled={sttLocked}
              onChange={(val) => {
                if (!sttLocked) updateSetting("ai_stt_enabled", val);
              }}
              label={
                <span className="inline-flex items-center gap-2">
                  <Mic
                    size={17}
                    className={sttLocked ? "shrink-0 text-muted" : "shrink-0 text-brand-purple"}
                  />
                  {t("aiSttEnabled")}
                </span>
              }
              description={t("aiSttEnabledDesc")}
            />
            {sttLocked && (
              <p className="flex items-center gap-1 text-[11px] font-semibold text-warn">
                <AlertTriangle size={13} className="shrink-0" />
                <span>{t("sttUnsupportedNotice")}</span>
              </p>
            )}
          </div>

          <div className="flex flex-col justify-between gap-3 rounded-xl border border-line bg-panel-raised p-4">
            <div>
              <div className="mb-1 flex items-center gap-2 text-text-main">
                <Mic size={17} className="shrink-0 text-brand-purple" />
                <span className="text-sm font-bold">{t("aiStt")}</span>
              </div>
              <p className="text-xs leading-relaxed text-muted">{t("sttDesc")}</p>
            </div>
            <Select
              aria-label={t("aiStt")}
              value={settings["ai_stt_provider"] || "auto"}
              disabled={sttLocked}
              onChange={(e) => {
                if (!sttLocked) updateSetting("ai_stt_provider", e.target.value);
              }}
            >
              <option value="auto">{t("sttAuto")}</option>
              <option value="gemini">{t("sttGemini")}</option>
              <option value="openai">{t("sttOpenAI")}</option>
            </Select>
          </div>

          <div className="flex flex-col justify-between gap-3 rounded-xl border border-line bg-panel-raised p-4">
            <div>
              <div className="mb-1 flex items-center gap-2 text-text-main">
                <Globe size={17} className="shrink-0 text-ok" />
                <span className="text-sm font-bold">{t("botLanguage")}</span>
              </div>
              <p className="text-xs leading-relaxed text-muted">{t("botLanguageDesc")}</p>
            </div>
            <Select
              aria-label={t("botLanguage")}
              value={settings["bot_language"] || "auto"}
              onChange={(e) => updateSetting("bot_language", e.target.value)}
            >
              <option value="auto">{t("langAuto")}</option>
              <option value="ar">{t("langAr")}</option>
              <option value="en">{t("langEn")}</option>
            </Select>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-4 sm:gap-5 md:grid-cols-2 lg:grid-cols-3">
        <Card className="flex flex-col justify-between gap-4">
          <CardHeader
            icon={<FileText size={20} />}
            title={t("personaPrompt")}
            description={t("personaDesc")}
          />
          <Button variant="secondary" className="w-full" onClick={openPersonaEditor}>
            {t("editPersona")}
          </Button>
        </Card>

        <Card className="flex flex-col justify-between gap-4">
          <CardHeader
            icon={<Database size={20} />}
            title={t("memoryFiles")}
            description={t("memoryDesc")}
          />
          <Button variant="secondary" className="w-full" onClick={openMemoryManager}>
            {t("manageMemory")}
          </Button>
        </Card>

        <Card className="flex flex-col justify-between gap-4">
          <CardHeader
            icon={<History size={20} />}
            title={t("aiInspector")}
            description={t("aiInspectorDesc")}
          />
          <Button variant="secondary" className="w-full" onClick={openInspector}>
            {t("openInspector")}
          </Button>
        </Card>
      </div>

      <Dialog
        isOpen={personaModalOpen}
        onClose={() => setPersonaModalOpen(false)}
        title={t("personaPrompt")}
        maxWidth="750px"
        footer={
          <>
            <Button variant="secondary" onClick={() => setPersonaModalOpen(false)}>
              {t("cancel")}
            </Button>
            <Button variant="primary" icon={<Save size={16} />} onClick={savePersona}>
              {t("save")}
            </Button>
          </>
        }
      >
        <Textarea
          className="font-mono"
          rows={12}
          value={personaText}
          onChange={(e) => setPersonaText(e.target.value)}
        />
      </Dialog>

      <Dialog
        isOpen={Boolean(selectedMemoryFile)}
        onClose={() => setSelectedMemoryFile(null)}
        title={t("memoryFiles")}
        maxWidth="900px"
        footer={
          <>
            <Button variant="secondary" onClick={() => setSelectedMemoryFile(null)}>
              {t("cancel")}
            </Button>
            <Button
              variant="primary"
              icon={<Save size={16} />}
              onClick={saveMemoryFile}
              disabled={memoryLoading}
            >
              {t("save")}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4 md:flex-row">
          <div className="flex shrink-0 flex-col gap-1.5 md:max-h-[420px] md:w-60 md:overflow-y-auto">
            {memoryScopes.map((s) => {
              const isGlobal = s.scope === "global";
              const active = selectedMemoryFile === s.scope;
              return (
                <Button
                  key={s.scope}
                  variant={active ? "primary" : "secondary"}
                  aria-pressed={active}
                  onClick={() => openMemoryScope(s.scope)}
                  className="h-auto w-full flex-col items-stretch gap-1 px-2.5 py-2.5"
                >
                  <span className="flex min-w-0 items-center gap-2 text-xs font-bold">
                    {isGlobal ? (
                      <Globe size={14} className="shrink-0" />
                    ) : (
                      <MessageSquare size={14} className="shrink-0" />
                    )}
                    <span className="truncate">{isGlobal ? t("memoryGlobalScope") : s.scope}</span>
                  </span>
                  <span className="block text-start text-[10px] opacity-80">
                    {isGlobal ? t("memoryGlobalScopeHint") : t("memoryChatScopeHint")}
                    {" · "}
                    {t("memoryEntriesCount").replace("{n}", String(s.entries))}
                  </span>
                </Button>
              );
            })}
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <p className="text-[11px] leading-relaxed text-muted">{t("memoryProseHint")}</p>
            {memoryLoading ? (
              <div className="flex min-h-[340px] items-center justify-center">
                <Spinner className="size-6" label={t("starting")} />
              </div>
            ) : (
              <Textarea
                className="min-h-[340px] flex-1 font-mono"
                rows={12}
                value={memoryContent}
                onChange={(e) => setMemoryContent(e.target.value)}
                placeholder={t("memoryEditorPlaceholder")}
              />
            )}
          </div>
        </div>
      </Dialog>

      <Dialog
        isOpen={inspectorOpen}
        onClose={() => setInspectorOpen(false)}
        title={t("aiInspector")}
        maxWidth="750px"
        footer={
          <Button variant="secondary" onClick={() => setInspectorOpen(false)}>
            {t("cancel")}
          </Button>
        }
      >
        {inspectorLoading ? (
          <div className="flex min-h-[280px] items-center justify-center">
            <Spinner className="size-6" label={t("starting")} />
          </div>
        ) : !selectedConversation ? (
          conversations.length === 0 ? (
            <EmptyState
              icon={<MessageSquare size={20} />}
              text={t("noConversations")}
              className="py-8"
            />
          ) : (
            <div className="flex flex-col gap-1.5">
              {conversations.map((row) => (
                <Button
                  key={row.chatId}
                  variant="secondary"
                  onClick={() => openConversation(row.chatId)}
                  className="h-auto w-full flex-col items-stretch gap-1 px-3 py-3"
                >
                  <span className="flex items-center gap-2 text-xs font-bold">
                    <MessageSquare size={14} className="shrink-0 text-brand-blue" />
                    <span className="truncate font-mono">{row.chatId}</span>
                  </span>
                  <span className="block text-start text-[10px] text-muted">
                    {t("convTurns").replace("{n}", String(row.turns))} ·{" "}
                    {formatStamp(row.updatedAt)}
                  </span>
                </Button>
              ))}
            </div>
          )
        ) : (
          <div className="flex flex-col gap-2.5">
            <div className="flex items-center justify-between gap-2">
              <Button
                variant="ghost"
                size="sm"
                icon={<ChevronLeft size={16} className="rtl:rotate-180" />}
                onClick={() => setSelectedConversation(null)}
              >
                {t("backToList")}
              </Button>
              <span className="truncate font-mono text-[10px] text-muted">
                {selectedConversation}
              </span>
            </div>
            {conversation?.truncated && (
              <p className="text-[11px] font-semibold text-warn">{t("convTruncated")}</p>
            )}
            <div className="flex max-h-[420px] flex-col gap-1.5 overflow-y-auto">
              {conversation?.messages.length === 0 && (
                <EmptyState text={t("noConversations")} className="py-6" />
              )}
              {conversation?.messages.map((m, i) => (
                <div
                  key={i}
                  className={`rounded-xl border p-2.5 text-xs ${
                    m.kind === "tool" || m.kind === "toolResult"
                      ? "border-line bg-panel font-mono text-muted"
                      : m.role === "model"
                        ? "border-brand-blue/25 bg-brand-blue/10 text-text-main"
                        : "border-line bg-panel-raised text-text-main"
                  }`}
                >
                  {m.kind === "text" && (
                    <p className="whitespace-pre-wrap break-words leading-relaxed">{m.text}</p>
                  )}
                  {m.kind === "media" && <span>📎 {m.mimeType || t("convMedia")}</span>}
                  {m.kind === "tool" && <span>⚙️ {m.name}</span>}
                  {m.kind === "toolResult" && <span>↩️ {m.name}</span>}
                </div>
              ))}
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
};

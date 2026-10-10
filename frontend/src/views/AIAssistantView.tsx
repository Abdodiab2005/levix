import {
  AlertCircle,
  AlertTriangle,
  Bot,
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
  FormActions,
  IconButton,
  Input,
  LoadingState,
  PageHeader,
  SaveField,
  Select,
  Spinner,
  Textarea,
  Toggle,
  useDirtyForm,
  useSavedValue,
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

const PRESETS: ProviderPreset[] = [
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

function presetFromSettings(settings: Record<string, any>): ProviderPreset {
  const currentProvider = settings["ai_provider"] || "gemini";
  return (
    PRESETS.find((p) => {
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
    }) || PRESETS[0]
  );
}

export const AIAssistantView: React.FC = () => {
  const { t, language } = useI18n();
  const { toast } = useToast();

  const [settings, setSettings] = useState<Record<string, any>>({});
  const [configuredKeys, setConfiguredKeys] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);

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

  const [personaModalOpen, setPersonaModalOpen] = useState(false);
  const [personaText, setPersonaText] = useState("");
  const [memoryScopes, setMemoryScopes] = useState<
    Array<{ scope: string; label: string; entries: number }>
  >([]);
  const [selectedMemoryFile, setSelectedMemoryFile] = useState<string | null>(null);
  const [memoryContent, setMemoryContent] = useState("");
  const [memoryLoading, setMemoryLoading] = useState(false);

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

  const savedPreset = presetFromSettings(settings);
  const providerForm = useDirtyForm({
    presetId: savedPreset.id,
    apiKey: "",
    baseUrl: savedPreset.baseUrlSetting
      ? String(settings[savedPreset.baseUrlSetting] || savedPreset.defaultBaseUrl)
      : "",
    model: String(settings[savedPreset.modelSetting] || savedPreset.defaultModel),
  });
  const sttProvider = useSavedValue(String(settings["ai_stt_provider"] || "auto"));
  const botLang = useSavedValue(String(settings["bot_language"] || "auto"));

  const selectedPreset = PRESETS.find((p) => p.id === providerForm.draft.presetId) || savedPreset;

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
            map[s.key] = "";
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
      await api.updateSetting(key, value);
      if (!quiet) toast(t("savedSuccessfully"), "success");
    } catch (err: any) {
      toast(err.message, "error");
    }
  };

  const persistSetting = async (key: string, value: any) => {
    await api.updateSetting(key, value);
    if (key.endsWith("_api_key")) {
      setSettings((prev) => ({ ...prev, [key]: "" }));
      setConfiguredKeys((prev) => ({ ...prev, [key]: Boolean(value) }));
    } else {
      setSettings((prev) => ({ ...prev, [key]: value }));
    }
  };

  const applyPreset = (id: string) => {
    const next = PRESETS.find((p) => p.id === id);
    if (!next) return;
    const current = PRESETS.find((p) => p.id === providerForm.draft.presetId) || savedPreset;
    providerForm.setDraft({
      presetId: next.id,
      apiKey: next.keySetting === current.keySetting ? providerForm.draft.apiKey : "",
      baseUrl: next.defaultBaseUrl,
      model: next.defaultModel,
    });
  };

  const handleFetchModels = async (forceRefresh = false, cacheOnly = false) => {
    setFetchingModels(true);
    const typedKey = String(providerForm.draft.apiKey || "").trim();
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
      if (selectedPreset.baseUrlSetting && providerForm.draft.baseUrl) {
        payload.baseUrl = providerForm.draft.baseUrl;
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

        if (!res.live && res.requiresApiKey && forceRefresh) {
          toast(t("connectKeyFirstPrompt"), "info");
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

  useEffect(() => {
    if (!loading) handleFetchModels(false, true);
  }, [selectedPreset.id, loading]);

  const currentModelList: NormalizedModel[] = discoveryState[selectedPreset.id]?.models || [];
  const isLiveVerified = Boolean(discoveryState[selectedPreset.id]?.live);
  const requiresApiKey = Boolean(
    discoveryState[selectedPreset.id]?.requiresApiKey ?? !configuredKeys[selectedPreset.keySetting],
  );

  const savedModelVal = settings[savedPreset.modelSetting] || savedPreset.defaultModel;
  const currentModelVal = providerForm.draft.model || selectedPreset.defaultModel;

  const modelForCaps = (id: string): NormalizedModel =>
    currentModelList.find((m) => m.id.toLowerCase() === id.toLowerCase()) || {
      id,
      displayName: id,
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

  const currentModelObj = modelForCaps(currentModelVal);
  const savedModelObj = modelForCaps(savedModelVal);

  const supportsVision = Boolean(currentModelObj.capabilities.vision);
  const supportsStt = Boolean(currentModelObj.capabilities.stt);
  const savedSupportsVision = Boolean(savedModelObj.capabilities.vision);
  const savedSupportsStt = Boolean(savedModelObj.capabilities.stt);

  const capsKnown =
    currentModelObj.capabilitySource === "provider" || currentModelObj.capabilitySource === "seed";
  const savedCapsKnown =
    savedModelObj.capabilitySource === "provider" || savedModelObj.capabilitySource === "seed";
  const autoDetect = settings["ai_auto_detect_capabilities"] !== false;
  const visionLocked = savedCapsKnown && autoDetect && !savedSupportsVision;
  const sttLocked = savedCapsKnown && autoDetect && !savedSupportsStt;

  useEffect(() => {
    if (loading) return;

    if (visionLocked && settings["ai_vision_enabled"]) {
      updateSetting("ai_vision_enabled", false, true);
    }

    if (sttLocked && settings["ai_stt_enabled"]) {
      updateSetting("ai_stt_enabled", false, true);
    }
  }, [savedModelVal, visionLocked, sttLocked, loading]);

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

  const capabilityBadges = [
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
  ];

  if (loading) {
    return <LoadingState text={t("starting")} />;
  }

  const agentOn = Boolean(settings["ai_agent"]);

  return (
    <div className="flex flex-col gap-3 sm:gap-4">
      <PageHeader icon={<Bot size={20} />} title={t("aiTitle")} description={t("aiSubtitle")} />

      <Card>
        <div className="flex min-h-10 items-center justify-between gap-4">
          <span className="text-sm font-semibold text-text-main">{t("aiAgentEnabled")}</span>
          <div className="flex items-center gap-3">
            <span className="text-xs font-bold text-muted">
              {agentOn ? t("toggleOn") : t("toggleOff")}
            </span>
            <Toggle
              checked={agentOn}
              onChange={(val) => updateSetting("ai_agent", val)}
              aria-label={t("aiAgentEnabled")}
            />
          </div>
        </div>
      </Card>

      <Card className="flex flex-col gap-3">
        <CardHeader icon={<Sparkles size={18} />} title={t("aiProvider")} />

        <div className="flex flex-wrap items-center gap-2">
          <Select
            aria-label={t("aiProvider")}
            className="min-w-0 flex-1 sm:max-w-xs"
            value={providerForm.draft.presetId}
            onChange={(e) => applyPreset(e.target.value)}
          >
            {PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
          <span className="font-mono text-xs text-muted">{currentModelVal}</span>
        </div>

        {requiresApiKey && <p className="text-xs text-warn">{t("connectKeyFirstPrompt")}</p>}

        {discoveryState[selectedPreset.id]?.error && (
          <div className="flex items-center justify-between gap-3">
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

        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void providerForm.save(async (draft) => {
              const p = PRESETS.find((item) => item.id === draft.presetId) || selectedPreset;
              await persistSetting("ai_provider", p.provider);
              if (p.baseUrlSetting) {
                await persistSetting(p.baseUrlSetting, draft.baseUrl);
              }
              await persistSetting(p.modelSetting, draft.model);
              if (draft.apiKey.trim()) {
                await persistSetting(p.keySetting, draft.apiKey.trim());
              }
              providerForm.setDraft({ ...draft, apiKey: "" });
            });
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") providerForm.revert();
          }}
        >
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <Field
              className="min-w-0"
              htmlFor="input-api-key"
              label={
                <span className="flex w-full items-center justify-between gap-2">
                  <span>{t("apiKey")}</span>
                  {configuredKeys[selectedPreset.keySetting] && (
                    <Badge tone="ok">
                      <CheckCircle2 size={11} />
                      {t("saved")}
                    </Badge>
                  )}
                </span>
              }
            >
              <Input
                id="input-api-key"
                type="password"
                className="font-mono"
                value={providerForm.draft.apiKey}
                onChange={(e) => providerForm.setField("apiKey", e.target.value)}
                placeholder={
                  configuredKeys[selectedPreset.keySetting] ? "••••••••••••" : t("enterApiKey")
                }
              />
            </Field>

            {selectedPreset.baseUrlSetting && (
              <Field className="min-w-0" label={t("baseUrl")} htmlFor="input-base-url">
                <Input
                  id="input-base-url"
                  type="text"
                  className="font-mono"
                  value={providerForm.draft.baseUrl}
                  onChange={(e) => providerForm.setField("baseUrl", e.target.value)}
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
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setIsCustomModel(!isCustomModel)}
                  >
                    {isCustomModel ? t("modelListToggle") : t("modelCustomToggle")}
                  </Button>
                  <IconButton
                    type="button"
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
                  value={providerForm.draft.model}
                  onChange={(e) => providerForm.setField("model", e.target.value)}
                  placeholder={selectedPreset.defaultModel}
                />
              ) : (
                <Select
                  id="input-model-name"
                  className="font-mono"
                  value={currentModelVal}
                  onChange={(e) => providerForm.setField("model", e.target.value)}
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
          <FormActions
            dirty={providerForm.dirty}
            saving={providerForm.status === "saving"}
            justSaved={providerForm.status === "saved"}
            error={providerForm.error}
            onDiscard={providerForm.revert}
            {...formLabels}
          />
        </form>

        <div className="flex flex-wrap items-center gap-1.5">
          {capabilityBadges.map(({ icon: Icon, label, on }) => (
            <Badge key={label} tone={capsKnown && on ? "ok" : "neutral"}>
              <Icon size={12} />
              {label}
              {capsKnown ? (on ? ` · ${t("supported")}` : ` · ${t("unsupported")}`) : ""}
            </Badge>
          ))}
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
      </Card>

      <Card className="flex flex-col gap-3">
        <CardHeader title={t("capabilities")} />
        <div className="flex flex-col divide-y divide-line">
          <div className="py-2">
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
              <p className="mt-1 flex items-center gap-1 text-[11px] font-semibold text-warn">
                <AlertTriangle size={13} className="shrink-0" />
                <span>{t("visionUnsupportedNotice")}</span>
              </p>
            )}
          </div>

          <div className="py-2">
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
              <p className="mt-1 flex items-center gap-1 text-[11px] font-semibold text-warn">
                <AlertTriangle size={13} className="shrink-0" />
                <span>{t("sttUnsupportedNotice")}</span>
              </p>
            )}
          </div>

          <div className="py-2">
            <SaveField
              label={t("aiStt")}
              description={t("sttDesc")}
              htmlFor="ai-stt-provider"
              dirty={sttProvider.dirty}
              saving={sttProvider.status === "saving"}
              justSaved={sttProvider.status === "saved"}
              error={sttProvider.error}
              onSave={() => sttProvider.save((next) => persistSetting("ai_stt_provider", next))}
              onRevert={sttProvider.revert}
              {...saveLabels}
            >
              <Select
                id="ai-stt-provider"
                aria-label={t("aiStt")}
                value={sttProvider.value}
                disabled={sttLocked}
                onChange={(e) => sttProvider.setValue(e.target.value)}
              >
                <option value="auto">{t("sttAuto")}</option>
                <option value="gemini">{t("sttGemini")}</option>
                <option value="openai">{t("sttOpenAI")}</option>
              </Select>
            </SaveField>
          </div>

          <div className="py-2">
            <SaveField
              label={t("botLanguage")}
              description={t("botLanguageDesc")}
              htmlFor="ai-bot-language"
              dirty={botLang.dirty}
              saving={botLang.status === "saving"}
              justSaved={botLang.status === "saved"}
              error={botLang.error}
              onSave={() => botLang.save((next) => persistSetting("bot_language", next))}
              onRevert={botLang.revert}
              {...saveLabels}
            >
              <Select
                id="ai-bot-language"
                aria-label={t("botLanguage")}
                value={botLang.value}
                onChange={(e) => botLang.setValue(e.target.value)}
              >
                <option value="auto">{t("langAuto")}</option>
                <option value="ar">{t("langAr")}</option>
                <option value="en">{t("langEn")}</option>
              </Select>
            </SaveField>
          </div>
        </div>
      </Card>

      <Card className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          icon={<FileText size={16} />}
          onClick={openPersonaEditor}
          title={t("personaDesc")}
        >
          {t("editPersona")}
        </Button>
        <Button
          variant="secondary"
          icon={<Database size={16} />}
          onClick={openMemoryManager}
          title={t("memoryDesc")}
        >
          {t("manageMemory")}
        </Button>
        <Button
          variant="secondary"
          icon={<History size={16} />}
          onClick={openInspector}
          title={t("aiInspectorDesc")}
        >
          {t("openInspector")}
        </Button>
      </Card>

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

import { Check, Eye, FileText, Mic, Type, Video, Volume2, X } from "lucide-react";
import type { ModelCapabilities } from "../../api/client";
import { Badge, InfoTip } from "../../components/ui";
import { useI18n } from "../../context/I18nContext";
import type { translations } from "../../i18n/translations";

export interface ModelCapabilityIndicatorsProps {
  capabilities: Partial<ModelCapabilities> | null | undefined;
  capabilitySource: "provider" | "seed" | "unknown" | string | null | undefined;
}

type CapabilityState = "supported" | "unsupported" | "unknown";
type TranslationKey = keyof (typeof translations)["en"];

interface CapabilityDef {
  key: string;
  icon: typeof FileText;
  labelKey: TranslationKey;
  supportedDescKey: TranslationKey;
  unsupportedDescKey: TranslationKey;
  getValue: (caps: Partial<ModelCapabilities> | null | undefined) => boolean | null | undefined;
}

const FIXED_CAPABILITIES: readonly CapabilityDef[] = [
  {
    key: "text",
    icon: Type,
    labelKey: "capText",
    supportedDescKey: "capSupportedDesc",
    unsupportedDescKey: "capUnsupportedDesc",
    getValue: (caps) =>
      caps?.textInput != null && caps?.textOutput != null
        ? Boolean(caps.textInput && caps.textOutput)
        : null,
  },
  {
    key: "vision",
    icon: Eye,
    labelKey: "capVision",
    supportedDescKey: "capSupportedDesc",
    unsupportedDescKey: "capUnsupportedDesc",
    getValue: (caps) => caps?.vision,
  },
  {
    key: "audioInput",
    icon: Volume2,
    labelKey: "capAudio",
    supportedDescKey: "capSupportedDesc",
    unsupportedDescKey: "capUnsupportedDesc",
    getValue: (caps) => caps?.audioInput,
  },
  {
    key: "stt",
    icon: Mic,
    labelKey: "capStt",
    supportedDescKey: "capSupportedDesc",
    unsupportedDescKey: "capUnsupportedDesc",
    getValue: (caps) => caps?.stt,
  },
  {
    key: "pdfInput",
    icon: FileText,
    labelKey: "capPdf",
    supportedDescKey: "capSupportedDesc",
    unsupportedDescKey: "capUnsupportedDesc",
    getValue: (caps) => caps?.pdfInput,
  },
  {
    key: "videoInput",
    icon: Video,
    labelKey: "capVideo",
    supportedDescKey: "capSupportedDesc",
    unsupportedDescKey: "capUnsupportedDesc",
    getValue: (caps) => caps?.videoInput,
  },
];

function resolveCapabilityState(
  val: boolean | null | undefined,
  source: string | null | undefined,
): CapabilityState {
  if (source === "unknown" || !source || val == null) {
    return "unknown";
  }
  return val ? "supported" : "unsupported";
}

export function ModelCapabilityIndicators({
  capabilities,
  capabilitySource,
}: ModelCapabilityIndicatorsProps) {
  const { t } = useI18n();

  const sourceTone =
    capabilitySource === "provider" ? "ok" : capabilitySource === "seed" ? "info" : "neutral";

  const sourceText =
    capabilitySource === "provider"
      ? t("sourceLive")
      : capabilitySource === "seed"
        ? t("sourceSeed")
        : t("sourceUnknown");

  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex flex-wrap items-center gap-1 sm:gap-1.5">
        {FIXED_CAPABILITIES.map((def) => {
          const rawVal = def.getValue(capabilities);
          const state = resolveCapabilityState(rawVal, capabilitySource);
          const Icon = def.icon;

          const stateLabel =
            state === "supported"
              ? t("supported")
              : state === "unsupported"
                ? t("unsupported")
                : t("sourceUnknown");

          const accessibleLabel = `${t(def.labelKey)}: ${stateLabel}`;

          const tooltipContent = (
            <span className="flex flex-col gap-1 text-xs">
              <span className="flex items-center gap-1.5 font-bold text-text-main">
                {state === "supported" && (
                  <Check size={13} strokeWidth={2.5} className="text-ok shrink-0" />
                )}
                {state === "unsupported" && (
                  <X size={13} strokeWidth={2.5} className="text-danger shrink-0" />
                )}
                {state === "unknown" && <span className="font-mono text-faint shrink-0">?</span>}
                <span>{accessibleLabel}</span>
              </span>
              <span className="text-[11px] text-muted">
                {state === "supported"
                  ? t(def.supportedDescKey)
                  : state === "unsupported"
                    ? t(def.unsupportedDescKey)
                    : t("capUnknownDesc")}
              </span>
            </span>
          );

          return (
            <InfoTip
              key={def.key}
              label={accessibleLabel}
              content={tooltipContent}
              className="size-10 min-h-10 min-w-10 rounded-lg p-0"
            >
              <span className="relative inline-flex size-5 items-center justify-center">
                <Icon
                  size={18}
                  className={
                    state === "supported"
                      ? "text-ok"
                      : state === "unsupported"
                        ? "text-muted/60"
                        : "text-muted/40"
                  }
                />
                {state === "supported" && (
                  <span
                    aria-hidden
                    className="absolute -bottom-1 -end-1 flex size-3.5 items-center justify-center rounded-full bg-panel-raised text-ok ring-1 ring-line"
                  >
                    <Check size={9} strokeWidth={3} />
                  </span>
                )}
                {state === "unsupported" && (
                  <span
                    aria-hidden
                    className="absolute -bottom-1 -end-1 flex size-3.5 items-center justify-center rounded-full bg-panel-raised text-danger ring-1 ring-line"
                  >
                    <X size={9} strokeWidth={3} />
                  </span>
                )}
                {state === "unknown" && (
                  <span
                    aria-hidden
                    className="absolute -bottom-1 -end-1 flex size-3.5 items-center justify-center rounded-full bg-panel-raised text-faint ring-1 ring-line font-mono text-[9px] font-bold leading-none"
                  >
                    ?
                  </span>
                )}
              </span>
            </InfoTip>
          );
        })}
      </div>

      <Badge tone={sourceTone}>{sourceText}</Badge>
    </div>
  );
}

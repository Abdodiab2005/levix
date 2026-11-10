// file: frontend/src/views/plus/types.ts
// The panel_api v1 contract the Levix Plus runtime implements behind
// /dashboard/api/plus/ext.

export const PLUS_LOCALES = ["ar", "en", "pt-BR", "es-419"] as const;
export type PlusLocale = (typeof PLUS_LOCALES)[number];

/** Native names. They are the same in every UI language, like the Android picker. */
export const LOCALE_NAMES: Record<PlusLocale, string> = {
  ar: "العربية",
  en: "English",
  "pt-BR": "Português (Brasil)",
  "es-419": "Español (Latinoamérica)",
};

export function isPlusLocale(value: string): value is PlusLocale {
  return (PLUS_LOCALES as readonly string[]).includes(value);
}

export type PlusTemplateMode = "auto" | "original";

export type PlusTemplateOverride = {
  mode: PlusTemplateMode;
  source: { locale: PlusLocale; text: string };
  values: Partial<Record<PlusLocale, string>>;
  manual: PlusLocale[];
  translated: PlusLocale[];
  failed: PlusLocale[];
  updatedAt: string | number;
};

export type PlusTemplateKey = {
  key: string;
  placeholders: string[];
  catalog: Partial<Record<PlusLocale, string>>;
  override: PlusTemplateOverride | null;
};

export type PlusTemplatesResponse = {
  keys: PlusTemplateKey[];
  limit: number;
  used: number;
};

export type PlusTemplateSave = {
  mode: PlusTemplateMode;
  locale: PlusLocale;
  text: string;
  manual?: Partial<Record<PlusLocale, string>>;
};

export type PlusPreset = {
  id: string;
  name: string;
  description: string;
  preview: Array<{ key: string; text: string }>;
};

export type PlusPresetsResponse = {
  presets: PlusPreset[];
  active: string | null;
};

export type PlusVisibility = {
  hideWatermark: boolean;
  hideProgress: "none" | "all" | "selected";
  commands: string[];
};

export type AutoReplyTrigger = "all" | "mention" | "keywords";

export type AutoReplyChat = {
  jid: string;
  enabled: boolean;
  trigger: AutoReplyTrigger;
  keywords: string[];
  instructions: string;
  cooldownSeconds: number;
  perSenderPerHour: number;
  perChatPerHour: number;
  globalMemory?: {
    read: boolean;
    write: boolean;
  };
};

export type AutoReplyConfig = {
  enabled: boolean;
  killSwitch: boolean;
  globalPerHour: number;
  chats: AutoReplyChat[];
};

export type PlusStatusResponse = {
  configured: boolean;
  entitlement: { state: string; until: string | null; reason: string | null };
  extension: {
    state: "absent" | "inactive" | "active" | "incompatible" | "disabled" | "failed";
    id?: string;
    version?: string;
  };
};

/** Contract limits, shared by the editor and the validation. */
export const PLUS_LIMITS = {
  templateText: 1000,
  templates: 150,
  autoReplyChats: 100,
  keywords: 20,
  keywordChars: 40,
  instructions: 1000,
  globalPerHour: { min: 1, max: 200 },
  cooldownSeconds: { min: 0, max: 3600 },
  perSenderPerHour: { min: 1, max: 60 },
  perChatPerHour: { min: 1, max: 200 },
} as const;

/** digits@s.whatsapp.net · digits@lid · digits@g.us */
export const CHAT_JID_PATTERN = /^(?:\d+@s\.whatsapp\.net|\d+@lid|\d+@g\.us)$/;

export function isGroupJid(jid: string): boolean {
  return jid.endsWith("@g.us");
}

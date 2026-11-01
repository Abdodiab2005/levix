// file: frontend/src/types/index.ts

import type { Language } from "../i18n/translations";

export interface BrandInfo {
  name: string;
  tagline: string;
  author: string;
  repo: string;
  version?: string;
}

export type SessionState =
  | "idle"
  | "starting"
  | "waiting_for_qr"
  | "linking"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "paused"
  | "retry_exhausted"
  | "logged_out"
  | "error";

export interface SessionStatus {
  state: SessionState;
  status?: string;
  qr?: string | null;
  pairingCode?: string | null;
  retryInSeconds?: number | null;
  error?: string | null;
  proxyChanged?: boolean;
  canStart?: boolean;
  canStop?: boolean;
  canUnlink?: boolean;
  linked?: boolean;
  connected?: boolean;
  isOnline?: boolean;
  terminal?: boolean;
  hasQr?: boolean;
  hasPairingCode?: boolean;
  user?: {
    id: string;
    name?: string;
  } | null;
}

export interface DashboardStats {
  totalGroups: number;
  totalUsers: number;
  commandCount: number;
  uptime: number;
  activeSchedules: number;
  version: string;
}

export interface SettingItem {
  key: string;
  value: any;
  type: "string" | "number" | "boolean" | "json";
  description: string;
  category: "general" | "ai" | "proxy" | "security" | "storage";
  secret?: boolean;
  restart?: boolean;
}

/** The four levels runtime-config.PERMISSION_LEVELS stores. */
export type PermissionLevel = "MEMBERS" | "ADMINS_ONLY" | "ADMINS_OWNER" | "OWNER_ONLY";

export interface CommandItem {
  name: string;
  aliases: string[];
  description: string;
  descriptions?: Partial<Record<Language, string>>;
  usage?: string | null;
  usages?: Partial<Record<Language, string>> | null;
  /** "general", or "group" for a `group/<name>` sub-command. */
  category?: string;
  /** The permissions key: the name, or `group:<name>` for a sub-command. */
  key?: string;
  chat: "all" | "group" | "private";
  permission: PermissionLevel;
  defaultPermission: PermissionLevel;
  /** Declares `userAdminRequired` — a real WhatsApp group admin, so the level is fixed. */
  permissionLocked?: boolean;
  enabled: boolean;
  overridden: boolean;
}

export interface ScheduleMedia {
  kind: "image" | "video" | "audio" | "document" | string;
  mimeType?: string;
  fileName?: string | null;
}

export interface ScheduleItem {
  id: string;
  type: "recurring" | "once";
  targetJid: string;
  targetLabel?: string;
  targetKind?: "group" | "contact" | string;
  targetPhone?: string | null;
  savedName?: string | null;
  pushName?: string | null;
  phone?: string | null;
  message: string;
  cronString?: string;
  scheduledTime?: number;
  when: string;
  whenAr?: string;
  whenByLocale?: Partial<Record<Language, string>>;
  status: "active" | "paused" | "completed";
  createdAt?: number;
  lastRunAt?: number;
  lastDeliveryStatus?: "success" | "failed";
  lastError?: string;
  media?: ScheduleMedia;
}

/** The effective per-group moderation policy (POLICY-DESIGN section 1). */
export interface ModerationPolicy {
  mode: "simple" | "severity";
  limit: number;
  limitAction: "KICK" | "FLAG";
  features: {
    antilink: "DELETE" | "WARN" | "KICK" | null;
    media: "DELETE" | "WARN" | "KICK" | null;
    forbidden: "DELETE" | "WARN" | "KICK" | null;
    antispam: "WARN" | "KICK" | null;
  };
  hitMerge: "max" | "sum";
  weights: { antilink: number; media: number; forbidden: number; antispam: number; manual: number };
  flagAt: number;
  kickAt: number;
  decay: { mode: "off" | "expire" | "step"; days: number };
  membership: "keep" | "clear";
  flag: {
    notify: "group" | "silent";
    mentionAdmins: boolean;
    cooldownMinutes: number;
    whileFlagged: "record" | "hold" | "escalate";
    escalateAfter: number;
  };
}

/** Dotted field name -> visible. A missing key is visible. */
export type ModerationPolicyVisibility = Record<string, boolean>;

export interface ModerationPolicyFieldError {
  field: string;
  code: "unknown" | "type" | "enum" | "range" | "conflict" | string;
  message: string;
}

export interface GroupItem {
  id: string;
  jid: string;
  subject: string | null;
  memberCount: number | null;
  /**
   * The effective policy from the GET. The panel may also send a sparse patch
   * (Partial) — PATCH /groups/:id accepts both shapes.
   */
  moderation_policy?: Partial<ModerationPolicy>;
  moderation_policy_visibility?: ModerationPolicyVisibility;
  antilink: { enabled: boolean; mode: string; allowed_domains: string[]; action?: string };
  antispam: { enabled: boolean; time_window: number; message_count: number; action?: string };
  media_control: { enabled: boolean; blocked_types: string[]; action?: string };
  welcome_system: { enabled: boolean; messages: string[] };
  warn_system: { max_warnings: number; action: string };
  join_requests: { auto_approve_enabled: boolean };
  rules: string;
  mediaRestriction: string;
  welcomeEnabled: boolean;
  forbidden_words?: { enabled: boolean; count: number; action?: string };
  moderation_summary?: Partial<Record<Language, string>>;
  flagged_members?: FlaggedMember[];
}

export interface FlaggedMember {
  user_id: string;
  name: string;
  phone: string | null;
  warn_count: number;
  last_rule: string;
  flagged_at: number;
  reasons: string[];
}

export interface LogItem {
  time: string;
  level: "info" | "warn" | "error" | "debug";
  msg: string;
  context?: any;
}

export interface Sticker {
  id: string;
  name: string;
  animated: boolean;
  width: number;
  height: number;
  durationMs: number;
  fileSize: number;
  sourceMime: string;
  source: string;
  favorite: boolean;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  packIds: string[];
  url: string;
  thumbUrl: string;
}

export interface Pack {
  id: string;
  name: string;
  count: number;
  coverUrl: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface EditOptions {
  fit?: "contain" | "cover";
  zoom?: number;
  panX?: number;
  panY?: number;
  rotate?: 0 | 90 | 180 | 270;
  background?: string;
  removeBackground?: { mode: "plain"; tolerance?: number } | null;
  trim?: { start: number; duration: number } | null;
}

/** Panel create job. `MEDIA_HUB` is the Android handoff; everything else is an upload. */
export type StickerJobSource = "PANEL_UPLOAD" | "MEDIA_HUB";

export interface StickerUpload {
  uploadId: string;
  kind: string;
  mime: string;
  width: number;
  height: number;
  durationMs: number;
  animated: boolean;
  size: number;
}

export interface StickerList {
  items: Sticker[];
  total: number;
}

export interface StickerBulkResult {
  affected: number;
  skipped: Array<{ id: string; code: string }>;
}

export interface StickerFile {
  blob: Blob;
  fileName: string | null;
  /** Set on a PNG export of an animated sticker (X-Levix-Animated: 1). */
  animated: boolean;
}

export interface Job {
  id: string;
  state: "queued" | "running" | "done" | "failed";
  stage: "probing" | "decoding" | "encoding" | "optimizing" | null;
  progress: number;
  error: { code: string; message?: string; packs?: Array<{ id: string; name: string }> } | null;
  sticker: Sticker | null;
  created: boolean | null;
  qualityReduced: boolean | null;
}

export type AutoDeleteMatch = "contains" | "word" | "exact";
export type AutoDeleteChatScope = "all" | "groups" | "private";
export type AutoDeleteSenderMode = "everyone" | "selected";

export interface AutoDeleteSenders {
  mode: AutoDeleteSenderMode;
  list: string[];
}

export interface AutoDeleteRuleInput {
  name?: string | null;
  enabled?: boolean;
  keywords?: string[];
  match?: AutoDeleteMatch;
  chatScope?: AutoDeleteChatScope;
  senders?: AutoDeleteSenders;
  includeOwn?: boolean;
  forEveryone?: boolean;
  keepCopy?: boolean;
}

export interface AutoDeleteRule {
  id: number;
  name: string | null;
  enabled: boolean;
  keywords: string[];
  match: AutoDeleteMatch;
  chatScope: AutoDeleteChatScope;
  senders: AutoDeleteSenders;
  includeOwn: boolean;
  forEveryone: boolean;
  keepCopy: boolean;
  deletedCount: number;
  lastDeletedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface AutoDeleteLogEntry {
  id: number;
  ruleId: number;
  chatJid: string;
  sender: string | null;
  text: string;
  mediaType: string;
  mode: string;
  createdAt: number;
}

export interface Capabilities {
  webp: boolean;
  animated: boolean;
  gif: boolean;
  mp4: boolean;
  backgroundRemoval: string[];
  limits: {
    uploadBytes: number;
    videoSeconds: number;
    stickerSeconds: number;
    maxSide: number;
    libraryMax: number;
    packsMax: number;
  };
}

export interface ClientDiagnostics {
  schema?: number;
  nativeApp?: string;
  android?: string;
  device?: string;
  abi?: string;
  webview?: string;
  screen?: string;
  language?: Language;
  theme?: "light" | "dark";
  connectivity?: "wifi" | "cellular" | "ethernet" | "vpn" | "none" | "unknown";
  memory?: "ok" | "low" | "unknown";
  storage?: "ok" | "low" | "unknown";
  [key: string]: any;
}

export interface DiagnosticsObject {
  schema: number;
  levix?: string;
  node?: string;
  platform?: string;
  nativeApp?: string;
  android?: string;
  device?: string;
  abi?: string;
  webview?: string;
  screen?: string;
  language?: Language;
  theme?: "light" | "dark";
  connectivity?: "wifi" | "cellular" | "ethernet" | "vpn" | "none" | "unknown";
  memory?: "ok" | "low" | "unknown";
  storage?: "ok" | "low" | "unknown";
  [key: string]: any;
}

export type CrashReportCategory =
  | "android-crash"
  | "android-anr"
  | "android-native"
  | "web-error"
  | "web-rejection"
  | "react-render"
  | "node-uncaught"
  | "node-rejection";

export interface Breadcrumb {
  at: string;
  kind: "nav" | "lifecycle" | "action";
  name: string;
}

export interface CrashReportInput {
  category: CrashReportCategory;
  error: {
    type: string;
    message: string;
    stack: string[] | string;
  };
  screen: string;
  breadcrumbs: Breadcrumb[];
  device: Record<string, any>;
}

export interface CrashReportItem {
  schema: 1;
  id: string;
  fingerprint: string;
  createdAt: string;
  category: CrashReportCategory;
  error: {
    type: string;
    message: string;
    stack: string[];
  };
  screen: string;
  app?: {
    levix?: string;
    nativeApp?: string;
    node?: string;
    platform?: string;
  };
  device?: Record<string, any>;
  breadcrumbs: Breadcrumb[];
  /** The sanitized technical log tail that the send uploads. */
  debugLog?: string;
  /** Server id of that frozen tail. Send passes it back; the panel does not show it. */
  debugLogId?: string;
  status?: "pending" | "failed";
  lastError?: string | null;
}

export interface SentCrashReportItem {
  id: string;
  sentAt: string;
  category: string;
  type: string;
}

// file: frontend/src/types/index.ts

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
  dataDir: string;
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
  descriptions?: { en?: string; ar?: string };
  usage?: string | null;
  usages?: { en?: string; ar?: string } | null;
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

export interface ScheduleItem {
  id: string;
  type: "recurring" | "once";
  targetJid: string;
  targetLabel?: string;
  targetKind?: "group" | "contact" | string;
  targetPhone?: string | null;
  message: string;
  cronString?: string;
  scheduledTime?: number;
  when: string;
  status: "active" | "paused" | "completed";
  lastRunAt?: number;
  lastDeliveryStatus?: "success" | "failed";
  lastError?: string;
}

export interface GroupItem {
  id?: string;
  jid: string;
  subject: string;
  memberCount: number;
  participants?: number | null;
  antilink?: boolean | { enabled?: boolean };
  antilinkEnabled?: boolean;
  mediaRestriction?: string;
  welcomeEnabled?: boolean;
}

export interface LogItem {
  time: string;
  level: "info" | "warn" | "error" | "debug";
  msg: string;
  context?: any;
}

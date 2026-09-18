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

export interface CommandItem {
  name: string;
  aliases: string[];
  description: string;
  chat: "all" | "group" | "private";
  permission: "MEMBERS" | "ADMIN_ONLY" | "OWNER_ONLY";
  defaultPermission: "MEMBERS" | "ADMIN_ONLY" | "OWNER_ONLY";
  enabled: boolean;
  overridden: boolean;
}

export interface ScheduleItem {
  id: string;
  type: "recurring" | "once";
  targetJid: string;
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
  jid: string;
  subject: string;
  memberCount: number;
  antilink?: boolean;
  mediaRestriction?: string;
  welcomeEnabled?: boolean;
}

export interface LogItem {
  time: string;
  level: "info" | "warn" | "error" | "debug";
  msg: string;
  context?: any;
}

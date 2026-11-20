// file: frontend/src/utils/accountCardState.ts
import type { MessageKey } from "../i18n/translations";
import type { SessionStatus } from "../types";

export type AccountCardTone = "ok" | "warn" | "danger" | "neutral";

/** The one action the account card offers for the current session state. */
export type AccountCardAction = "manage" | "connect" | "reconnect";

export interface AccountCardState {
  /** Badge tone. The label always carries the state as text too. */
  tone: AccountCardTone;
  /** i18n key of the status line. */
  labelKey: MessageKey;
  /** True only while WhatsApp is connected and a profile can exist. */
  showProfile: boolean;
  action: AccountCardAction;
  /** The session snapshot has not arrived yet; render a skeleton. */
  loading: boolean;
  /** An operation is in flight, so the indicator may pulse. */
  pulsing: boolean;
  /** Retry attempt reported by the session, when it reports one. */
  attempt: number | null;
  maxAttempts: number | null;
}

/** `attempt` and `maxAttempts` ride in `SessionStatus`'s wire snapshot. */
type SessionLike = SessionStatus & { attempt?: number | null; maxAttempts?: number | null };

const loadingState = (): AccountCardState => ({
  tone: "neutral",
  labelKey: "accountCardLoading",
  showProfile: false,
  action: "manage",
  loading: true,
  pulsing: false,
  attempt: null,
  maxAttempts: null,
});

const positive = (value: number | null | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;

/**
 * Normalize a socket user JID by stripping any `:device` suffix.
 * Returns null for invalid or non-user JIDs.
 */
export function normalizeAccountId(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const match = /^(\d+)(?::\d+)?@(s\.whatsapp\.net|lid)$/.exec(trimmed);
  if (!match) return null;
  return `${match[1]}@${match[2]}`;
}

export interface RetainedProfileSnapshot<T = unknown> {
  accountId: string | null;
  phone?: string | null;
  profile: T;
}

/**
 * True when an unlink, logout, QR pairing flow or account switch has invalidated
 * the previously cached profile so it must never be shown again.
 */
export function shouldClearSavedProfile(
  status: SessionLike | null,
  saved: RetainedProfileSnapshot | null,
): boolean {
  if (!saved || !status) return true;
  if (status.state === "logged_out" || status.state === "waiting_for_qr") return true;
  if (status.linked === false || status.canUnlink === false) return true;
  if (status.state === "error" && status.reason === "unlink_incomplete") return true;
  const currentId = normalizeAccountId(status.user?.id);
  if (currentId && saved.accountId && currentId !== saved.accountId) return true;
  return false;
}

/**
 * True when the card should keep displaying the last good profile for the same
 * linked account (while connected, or while connecting/reconnecting) instead of
 * flashing "unavailable".
 */
export function canDisplaySavedProfile(
  status: SessionLike | null,
  saved: RetainedProfileSnapshot | null,
): boolean {
  if (!status || !saved || shouldClearSavedProfile(status, saved)) return false;
  if (status.state === "connected" && status.connected !== false) return true;
  if (
    status.linked !== false &&
    (status.state === "reconnecting" || status.state === "starting" || status.state === "linking")
  ) {
    return true;
  }
  return false;
}

/**
 * Map a session snapshot to what the account card shows. Pure: the component
 * owns no session logic, and every non-connected state is a status line rather
 * than a profile.
 */
export function mapSessionToCard(status: SessionLike | null): AccountCardState {
  if (!status) return loadingState();

  const attempt = positive(status.attempt);
  const maxAttempts = positive(status.maxAttempts);
  const base = { attempt, maxAttempts, loading: false };

  switch (status.state) {
    case "connected":
      return {
        ...base,
        tone: "ok",
        labelKey: "connected",
        showProfile: true,
        action: "manage",
        pulsing: false,
      };
    case "starting":
    case "linking":
      return {
        ...base,
        tone: "neutral",
        labelKey: "accountCardConnecting",
        showProfile: false,
        action: "manage",
        pulsing: true,
      };
    case "waiting_for_qr":
      return {
        ...base,
        tone: "warn",
        labelKey: "accountCardWaitingQr",
        showProfile: false,
        action: "manage",
        pulsing: true,
      };
    case "reconnecting":
      return {
        ...base,
        tone: "warn",
        labelKey: "accountCardReconnecting",
        showProfile: false,
        action: "reconnect",
        pulsing: true,
      };
    case "idle":
    case "disconnected":
      return {
        ...base,
        tone: "neutral",
        labelKey: "accountCardNotConnected",
        showProfile: false,
        action: "connect",
        pulsing: false,
      };
    case "paused":
      return {
        ...base,
        tone: "neutral",
        labelKey: "accountCardPaused",
        showProfile: false,
        action: "connect",
        pulsing: false,
      };
    case "retry_exhausted":
      return {
        ...base,
        tone: "danger",
        labelKey: "accountCardRetryExhausted",
        showProfile: false,
        action: "connect",
        pulsing: false,
      };
    case "logged_out":
      return {
        ...base,
        tone: "danger",
        labelKey: "accountCardLoggedOut",
        showProfile: false,
        action: "connect",
        pulsing: false,
      };
    case "consent_required":
      return {
        ...base,
        tone: "warn",
        labelKey: "accountCardConsentRequired",
        showProfile: false,
        action: "connect",
        pulsing: false,
      };
    case "error":
      return {
        ...base,
        tone: "danger",
        labelKey: "accountCardError",
        showProfile: false,
        action: "connect",
        pulsing: false,
      };
    default:
      return {
        ...base,
        tone: "neutral",
        labelKey: "accountCardNotConnected",
        showProfile: false,
        action: "connect",
        pulsing: false,
      };
  }
}

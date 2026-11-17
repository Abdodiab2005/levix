// file: frontend/src/utils/plusAccess.ts
// Pure mapping from the server's /plus/status answer to what the panel may
// show. The server decides entitlement. Nothing here reads a local flag.

export type PlusEntitlementState =
  | "none"
  | "active"
  | "grace"
  | "canceled"
  | "inactive"
  | "expired"
  | "clock"
  | "unverified";

export type PlusExtensionState =
  | "absent"
  | "inactive"
  | "active"
  | "incompatible"
  | "disabled"
  | "failed";

export interface PlusStatus {
  configured: boolean;
  entitlement: { state: PlusEntitlementState; until: string | null; reason: string | null };
  extension: { state: PlusExtensionState; id?: string; version?: string };
}

/** Loose input: the answer may carry a state this build does not know yet. */
export interface PlusStatusInput {
  configured?: boolean | null;
  entitlement?: { state?: string | null } | null;
  extension?: { state?: string | null } | null;
}

export type PlusAccess = "unavailable" | "unknown" | "locked" | "active";

/** The same set PlusSettings treats as subscribed. Do not widen it. */
export const PLUS_SUBSCRIBED_STATES: readonly string[] = ["active", "grace", "canceled"];

/** Entitlement states that mean "not subscribed", shown as locked. */
const LOCKED_STATES: readonly string[] = [
  "none",
  "inactive",
  "expired",
  "pending",
  "on_hold",
  "billing_retry",
];

export function isPlusSubscribed(state: string | null | undefined): boolean {
  return typeof state === "string" && PLUS_SUBSCRIBED_STATES.includes(state);
}

/**
 * Whether Plus is offered on this platform. Same rules the Settings tab used:
 * the Android host says so, else the extension must not be absent, else a
 * failed first read means no. `null` while nothing is known yet.
 */
export function plusAvailableFrom(input: {
  hostConfigured: boolean;
  status: PlusStatusInput | null | undefined;
  failed: boolean;
  previous?: boolean | null;
}): boolean | null {
  if (input.hostConfigured) return true;
  if (input.status) return input.status.extension?.state !== "absent";
  if (input.failed) return input.previous === true;
  return input.previous ?? null;
}

/**
 * "unavailable": Plus is not offered here. "unknown": loading, or the
 * verification is not settled. "locked": not subscribed. "active": subscribed
 * and the extension is running. A state this code does not know is "unknown".
 */
export function accessFromStatus(
  status: PlusStatusInput | null | undefined,
  available: boolean | null = null,
): PlusAccess {
  if (available === false) return "unavailable";
  if (!status) return "unknown";
  const extension = status.extension?.state;
  if (extension === "absent") return "unavailable";
  if (status.configured === false) return "unavailable";

  const entitlement = status.entitlement?.state;
  if (typeof entitlement !== "string") return "unknown";
  if (isPlusSubscribed(entitlement)) {
    if (extension === "active") return "active";
    if (typeof extension !== "string") return "unknown";
    // Subscribed, but the features are not running: do not unlock anything.
    return "locked";
  }
  if (LOCKED_STATES.includes(entitlement)) return "locked";
  return "unknown";
}

export const PLUS_FEATURE_TABS = ["messages", "presets", "visibility", "autoReply"] as const;
export type PlusFeatureTab = (typeof PLUS_FEATURE_TABS)[number];

export function isPlusFeatureTab(value: string | null | undefined): value is PlusFeatureTab {
  return typeof value === "string" && (PLUS_FEATURE_TABS as readonly string[]).includes(value);
}

/** The feature tab named in `#plus/<tab>`, or null. */
export function plusTabFromHash(hash: string): PlusFeatureTab | null {
  const parts = hash.replace(/^#\/?/, "").split("/");
  return parts[0] === "plus" && isPlusFeatureTab(parts[1]) ? parts[1] : null;
}

/** The hash that opens the Plus page, on a feature tab when one is given. */
export function plusHash(tab?: PlusFeatureTab | null): string {
  return tab ? `#plus/${tab}` : "#plus";
}

/** `#settings/plus` moved to `#plus`. Returns the new hash, or null. */
export function legacyPlusRedirect(hash: string): string | null {
  const parts = hash.replace(/^#\/?/, "").split("/");
  if (parts[0] !== "settings" || parts[1] !== "plus") return null;
  return isPlusFeatureTab(parts[2]) ? `#plus/${parts[2]}` : "#plus";
}

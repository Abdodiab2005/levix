// file: frontend/src/views/plus/plusUiLogic.ts
import type { PlusLocale, PlusTemplateMode } from "./types";

export function showsPlusUntil(state: string): boolean {
  return state === "active" || state === "grace" || state === "canceled";
}

/**
 * Entitlement states in which an owned, acknowledged Play subscription means the
 * server record may be stale. "inactive" covers a subscription that came back with
 * the same purchase token, for example after account hold or pause.
 */
const RECOVERY_REFRESH_STATES: ReadonlySet<string> = new Set([
  "none",
  "expired",
  "unverified",
  "inactive",
]);

/**
 * The verifier answers from its cached Play state for up to 10 minutes unless an
 * RTDN updates it, so a repeated refresh for the same purchases sooner rarely
 * changes the answer.
 */
export const RECOVERY_REFRESH_COOLDOWN_MS = 5 * 60_000;

/** Allows one recovery refresh per set of purchase tokens per cooldown. */
export function createRecoveryRefreshGate(
  cooldownMs = RECOVERY_REFRESH_COOLDOWN_MS,
  now: () => number = Date.now,
) {
  const last = new Map<string, number>();
  return {
    take(tokens: string[]): boolean {
      const key = [...tokens].sort().join("\n");
      const at = now();
      const previous = last.get(key);
      if (previous !== undefined && at - previous < cooldownMs) return false;
      last.set(key, at);
      return true;
    },
  };
}

export type RecoveryGate = ReturnType<typeof createRecoveryRefreshGate>;

export interface RecoveryPurchase {
  status: string;
  acknowledged: boolean;
  purchaseToken: string;
}

/**
 * Foreground recovery of Play purchases. Unacknowledged purchases are claimed.
 * An acknowledged purchase only asks the server to re-verify; the displayed
 * entitlement always comes from the server, never from the Play result.
 */
export async function recoverPlusPurchases<P extends RecoveryPurchase>({
  purchases,
  state,
  claim,
  readState,
  refresh,
  gate,
}: {
  purchases: P[];
  state: string | undefined;
  claim: (fresh: P[]) => Promise<void>;
  readState: () => Promise<string | undefined>;
  refresh: () => Promise<void>;
  gate: RecoveryGate;
}): Promise<"claimed" | "refreshed" | "skipped" | "none"> {
  const owned = purchases.filter((purchase) => purchase.status === "purchased");
  const fresh = owned.filter((purchase) => !purchase.acknowledged);
  const acknowledged = owned.filter((purchase) => purchase.acknowledged);
  if (fresh.length > 0) await claim(fresh);
  if (acknowledged.length === 0) return fresh.length > 0 ? "claimed" : "none";
  const current = fresh.length > 0 ? await readState() : state;
  if (!current || !RECOVERY_REFRESH_STATES.has(current)) {
    return fresh.length > 0 ? "claimed" : "none";
  }
  if (!gate.take(acknowledged.map((purchase) => purchase.purchaseToken))) return "skipped";
  await refresh();
  return "refreshed";
}

export function createRequestGeneration() {
  let generation = 0;
  return {
    begin: () => ++generation,
    isCurrent: (token: number) => token === generation,
  };
}

/**
 * Reads may overlap, but only the newest one calls `show`. A read that fails after a
 * newer read began settles with the newer read's outcome, so its caller cannot report
 * an error over a status the newer read already displayed. `cancel` makes every
 * pending read stale and lets a stale failure reject with its own error.
 */
export function createLatestReader<T>(fetch: () => Promise<T>, show: (value: T | null) => void) {
  const reads = createRequestGeneration();
  let latest: Promise<T> | null = null;
  return {
    read(): Promise<T> {
      const token = reads.begin();
      const request = fetch().then(
        (value) => {
          if (reads.isCurrent(token)) show(value);
          return value;
        },
        (err) => {
          if (reads.isCurrent(token)) {
            // Only the latest read can clear the displayed value.
            show(null);
            throw err;
          }
          if (latest) return latest;
          throw err;
        },
      );
      latest = request;
      return request;
    },
    cancel() {
      reads.begin();
      latest = null;
    },
  };
}

export interface WriteQueue {
  enqueue<T>(task: () => Promise<T>): Promise<T>;
}

export function createWriteQueue(): WriteQueue {
  let tail = Promise.resolve();
  return {
    enqueue<T>(task: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        tail = tail
          .catch(() => {})
          .then(async () => {
            try {
              const res = await task();
              resolve(res);
            } catch (err) {
              reject(err);
            }
          });
      });
    },
  };
}

export function samplePlaceholderValue(name: string): string {
  if (name === "name") return "Levix";
  if (name === "count") return "3";
  return `<${name}>`;
}

export function substitutePlaceholders(template: string): string {
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name) =>
    samplePlaceholderValue(name),
  );
}

export function getDraftText(
  locale: PlusLocale,
  mode: PlusTemplateMode,
  sourceLocale: PlusLocale,
  sourceText: string,
  manual: Partial<Record<PlusLocale, string>>,
): string {
  if (mode === "original") {
    return sourceText;
  }
  if (locale === sourceLocale) {
    return sourceText;
  }
  return manual[locale]?.trim() || "";
}

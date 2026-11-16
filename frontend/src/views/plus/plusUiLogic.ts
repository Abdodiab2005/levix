// file: frontend/src/views/plus/plusUiLogic.ts
import type { PlusLocale, PlusTemplateMode } from "./types";

export function showsPlusUntil(state: string): boolean {
  return state === "active" || state === "grace" || state === "canceled";
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

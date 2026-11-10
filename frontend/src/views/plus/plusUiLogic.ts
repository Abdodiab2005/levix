// file: frontend/src/views/plus/plusUiLogic.ts
import type { PlusLocale, PlusTemplateMode } from "./types";

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

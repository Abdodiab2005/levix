// file: frontend/src/components/DebugLogPreview.tsx

import type React from "react";
import { useI18n } from "../context/I18nContext";
import { formatByteSize } from "../utils/byteSize";
import { Disclosure } from "./ui";

/**
 * The technical debug log, as both previews show it: a collapsed disclosure
 * with its size, and preformatted wrapped text once opened. The same bytes the
 * backend forwards with the send, never the raw log files.
 */
export const DebugLogPreview: React.FC<{ debugLog?: string | null }> = ({ debugLog }) => {
  const { t } = useI18n();
  if (!debugLog) return null;
  const bytes = new TextEncoder().encode(debugLog).length;

  return (
    <div className="w-full min-w-0">
      <Disclosure
        summary={
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="min-w-0 break-words text-sm font-semibold text-text-main">
              {t("debugLogSectionLabel")}
            </span>
            <span className="text-xs text-muted tabular-nums">{formatByteSize(bytes, t)}</span>
          </span>
        }
      >
        <p className="mb-2 text-xs leading-relaxed text-muted">{t("debugLogHint")}</p>
        <pre
          dir="ltr"
          className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-panel-raised p-2.5 font-mono text-[11px] leading-relaxed text-text-main select-text"
        >
          {debugLog}
        </pre>
      </Disclosure>
    </div>
  );
};

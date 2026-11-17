// file: frontend/src/components/ui/code-text.tsx
import { Copy } from "lucide-react";
import { useState } from "react";
import { useI18n } from "../../context/I18nContext";
import { cn } from "../../utils/cn";
import { IconButton } from "./button";

export interface CodeTextProps {
  /** Exact token. Nothing is added, reversed, or translated. */
  children: string;
  className?: string;
  /** Copy `children` with the clipboard. Failure is a translated status, never a throw. */
  copy?: boolean;
  /** Accessible name for the copy button. Defaults to the shared Copy label. */
  copyLabel?: string;
}

/**
 * A command, prefix, timezone id, cron expression, phone number, or `{placeholder}`.
 * `<bdi dir="ltr">` keeps the token in source order inside an RTL page.
 */
export function CodeText({ children, className, copy = false, copyLabel }: CodeTextProps) {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);

  const token = (
    <bdi dir="ltr" className={cn("min-w-0 break-words font-mono", className)}>
      {children}
    </bdi>
  );

  if (!copy) return token;

  async function onCopy() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(children);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }

  return (
    <span className="inline-flex max-w-full items-center gap-1">
      {token}
      <IconButton
        variant="ghost"
        label={copyLabel ?? t("copy")}
        icon={<Copy size={16} />}
        onClick={() => void onCopy()}
      />
      {failed && (
        <span role="status" className="text-xs text-danger">
          {t("copyFailed")}
        </span>
      )}
    </span>
  );
}

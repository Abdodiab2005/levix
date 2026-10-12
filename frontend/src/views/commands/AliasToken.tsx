// file: frontend/src/views/commands/AliasToken.tsx

import { X } from "lucide-react";
import { IconButton } from "../../components/ui";
import { useI18n } from "../../context/I18nContext";
import { ARABIC_SCRIPT } from "./shared";

/**
 * One alias, prefixed, as a chip. The token is a technical identifier, so it
 * reads LTR even when the alias is Arabic (`!حساب`), and a marker names the
 * script when it is not the panel's own, so it never reads as untranslated UI.
 */
export function AliasToken({
  alias,
  prefix,
  onRemove,
  removeLabel,
}: {
  alias: string;
  prefix: string;
  onRemove?: () => void;
  removeLabel?: string;
}) {
  const { t, language } = useI18n();
  const isArabic = ARABIC_SCRIPT.test(alias);
  const otherScript = isArabic !== (language === "ar");
  return (
    <span className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-panel-raised px-2 py-0.5 text-[11px] text-muted">
      <span dir="ltr" className="font-mono">
        {prefix}
        {alias}
      </span>
      {otherScript && (
        <span className="font-sans text-[9px] font-bold uppercase tracking-wide text-brand-cyan/80">
          {isArabic ? "AR" : "EN"}
        </span>
      )}
      {onRemove && (
        <IconButton
          variant="ghost"
          label={removeLabel ?? t("delete")}
          icon={<X size={14} />}
          onMouseDown={(event) => event.preventDefault()}
          onClick={onRemove}
        />
      )}
    </span>
  );
}

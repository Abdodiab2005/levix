import { Eye, EyeOff } from "lucide-react";
import { forwardRef, useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "../../context/I18nContext";
import { cn } from "../../utils/cn";
import { IconButton } from "./button";
import { Input, type InputProps } from "./field";

export interface PasswordInputProps extends Omit<InputProps, "type" | "technical"> {}

export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(
  function PasswordInput(
    {
      className,
      dir = "ltr",
      spellCheck = false,
      autoCapitalize = "off",
      autoCorrect = "off",
      disabled,
      ...props
    },
    ref,
  ) {
    const { t } = useI18n();
    const [visible, setVisible] = useState(false);
    const inputRef = useRef<HTMLInputElement | null>(null);
    const selectionRef = useRef<{ start: number; end: number } | null>(null);

    useLayoutEffect(() => {
      const selection = selectionRef.current;
      const input = inputRef.current;
      if (!selection || !input) return;
      input.focus({ preventScroll: true });
      input.setSelectionRange(selection.start, selection.end);
      selectionRef.current = null;
    });

    return (
      // A grid overlay, not absolute insets: the legacy-WebView build turns
      // `end-*` into :lang() selectors, which ignore this wrapper's dir.
      <span dir={dir} className="grid w-full min-w-0 items-center">
        <Input
          {...props}
          ref={(node) => {
            inputRef.current = node;
            if (typeof ref === "function") ref(node);
            else if (ref) ref.current = node;
          }}
          type={visible ? "text" : "password"}
          dir={dir}
          spellCheck={spellCheck}
          autoCapitalize={autoCapitalize}
          autoCorrect={autoCorrect}
          disabled={disabled}
          className={cn("col-start-1 row-start-1 pe-12 text-start", className)}
        />
        <IconButton
          label={visible ? t("hideSecret") : t("showSecret")}
          icon={visible ? <EyeOff size={18} /> : <Eye size={18} />}
          pressed={visible}
          variant="ghost"
          disabled={disabled}
          className="col-start-1 row-start-1 me-0.5 justify-self-end"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            const input = inputRef.current;
            if (input) {
              selectionRef.current = {
                start: input.selectionStart ?? input.value.length,
                end: input.selectionEnd ?? input.value.length,
              };
            }
            setVisible((current) => !current);
          }}
        />
      </span>
    );
  },
);

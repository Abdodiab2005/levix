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
      <span className="relative block min-w-0 w-full">
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
          className={cn("pe-12 text-start", className)}
        />
        <IconButton
          label={visible ? t("hideSecret") : t("showSecret")}
          icon={visible ? <EyeOff size={18} /> : <Eye size={18} />}
          pressed={visible}
          variant="ghost"
          disabled={disabled}
          className="absolute end-0.5 top-1/2 -translate-y-1/2"
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

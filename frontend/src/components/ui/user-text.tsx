// file: frontend/src/components/ui/user-text.tsx
import { type ComponentPropsWithoutRef, forwardRef, type Ref } from "react";
import { cn } from "../../utils/cn";

/**
 * Text an operator or a user typed: a pack name, a sticker's name, a group
 * subject, a message. It sets `dir="auto"` so a name that mixes Arabic and
 * Latin ("Eid عيد 2025") lays out from its own first strong character inside
 * either an LTR or an RTL UI, and it never clips a name silently.
 *
 * `lines` clamps to that many lines (dense cards and chips); a clamped element
 * gets the full text as its `title` when the child is a string.
 */
type UserTextTag = "span" | "p" | "bdi" | "strong" | "em";

export interface UserTextProps extends Omit<ComponentPropsWithoutRef<"span">, "as"> {
  /** Element to render. Defaults to `span`. */
  as?: UserTextTag;
  /** Clamp to this many lines. Omit to let the text wrap in full. */
  lines?: 1 | 2 | 3;
}

const CLAMP: Record<1 | 2 | 3, string> = {
  1: "line-clamp-1",
  2: "line-clamp-2",
  3: "line-clamp-3",
};

/** A name or a message: `dir="auto"`, wrapping, and an optional line clamp with a `title`. */
export const UserText = forwardRef<HTMLElement, UserTextProps>(function UserText(
  { as = "span", lines, title, className, children, dir, ...props },
  ref,
) {
  const shared = {
    ...props,
    dir: dir ?? "auto",
    title: title ?? (lines !== undefined && typeof children === "string" ? children : undefined),
    className: cn(
      "min-w-0 whitespace-normal break-words",
      lines !== undefined && CLAMP[lines],
      className,
    ),
    children,
  };
  if (as === "p") return <p ref={ref as Ref<HTMLParagraphElement>} {...shared} />;
  if (as === "bdi") return <bdi ref={ref as Ref<HTMLElement>} {...shared} />;
  if (as === "strong") return <strong ref={ref as Ref<HTMLElement>} {...shared} />;
  if (as === "em") return <em ref={ref as Ref<HTMLElement>} {...shared} />;
  return <span ref={ref as Ref<HTMLSpanElement>} {...shared} />;
});

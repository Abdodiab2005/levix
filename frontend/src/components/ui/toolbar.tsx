// file: frontend/src/components/ui/toolbar.tsx
import { type ComponentPropsWithoutRef, forwardRef } from "react";
import { cn } from "../../utils/cn";

/** A wrapping row: search grows, then filter, sort, and overflow sit at the end. */
export const Toolbar = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<"div">>(function Toolbar(
  { className, ...props },
  ref,
) {
  return (
    <div ref={ref} className={cn("flex flex-wrap items-center gap-2", className)} {...props} />
  );
});

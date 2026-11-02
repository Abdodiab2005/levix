import { createElement, type ReactNode } from "react";
import { parseInlineMarkup } from "./inline-markup-parse";

export function renderInlineMarkup(value: string, trust: boolean): ReactNode {
  return parseInlineMarkup(value).map((segment, index) =>
    segment.kind === "text"
      ? segment.value
      : createElement(
          segment.kind,
          {
            key: index,
            className:
              segment.kind === "span" && trust
                ? "me-2 inline-block size-2 rounded-full bg-brand-cyan"
                : "font-bold text-text-main",
          },
          segment.value,
        ),
  );
}

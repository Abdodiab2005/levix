// Only exact, attribute-free catalog pairs become elements. Everything else stays text.
export type InlineSegment = { kind: "text" | "strong" | "span"; value: string };

export function parseInlineMarkup(value: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  const allowedPair = /<(strong|span)>([\s\S]*?)<\/\1>/g;
  let start = 0;
  for (const match of value.matchAll(allowedPair)) {
    const at = match.index ?? 0;
    if (at > start) segments.push({ kind: "text", value: value.slice(start, at) });
    segments.push({ kind: match[1] as "strong" | "span", value: match[2] });
    start = at + match[0].length;
  }
  if (start < value.length) segments.push({ kind: "text", value: value.slice(start) });
  return segments;
}

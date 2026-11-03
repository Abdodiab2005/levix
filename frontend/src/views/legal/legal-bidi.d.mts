export function ltrSegments(text: string): Array<{ text: string; ltr: boolean }>;

export function templateSegments(
  template: string,
  vars: Record<string, string | number>,
): Array<{ text: string; ltr: boolean }>;

/** Replace `{name}` placeholders in a translated string. */
export function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key: string) =>
    Object.hasOwn(vars, key) ? String(vars[key]) : match,
  );
}

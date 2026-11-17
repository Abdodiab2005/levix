import { readFileSync } from "node:fs";
import { join } from "node:path";
import { equal, finish, ok, ROOT, section, throws } from "./harness.mjs";

/**
 * Validates strictly #rrggbb hex format and returns rgb integers (0-255).
 * Throws a descriptive error on any non-#rrggbb format.
 */
export function parseHex(hex) {
  if (typeof hex !== "string" || !/^#[0-9a-fA-F]{6}$/.test(hex)) {
    throw new Error(`Invalid color format: "${hex}". Expected #rrggbb.`);
  }
  return {
    r: Number.parseInt(hex.slice(1, 3), 16),
    g: Number.parseInt(hex.slice(3, 5), 16),
    b: Number.parseInt(hex.slice(5, 7), 16),
  };
}

/**
 * Converts an 8-bit sRGB channel (0-255) to linear light value.
 * WCAG 2.1 relative luminance definition.
 */
export function srgbChannelToLinear(c8bit) {
  const c = c8bit / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * Calculates WCAG 2.1 relative luminance of an sRGB #rrggbb color.
 */
export function relativeLuminance(hex) {
  const { r, g, b } = parseHex(hex);
  return (
    0.2126 * srgbChannelToLinear(r) +
    0.7152 * srgbChannelToLinear(g) +
    0.0722 * srgbChannelToLinear(b)
  );
}

/**
 * Calculates WCAG 2.1 contrast ratio between two #rrggbb colors.
 */
export function contrastRatio(hex1, hex2) {
  const l1 = relativeLuminance(hex1);
  const l2 = relativeLuminance(hex2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Extracts property-value declarations from a CSS rule block by selector.
 */
export function parseBlockDeclarations(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`${escaped}\\s*\\{([^}]+)\\}`, "m");
  const match = css.match(regex);
  if (!match) {
    throw new Error(`Selector "${selector}" not found in CSS`);
  }
  const body = match[1];
  const decls = {};
  for (const rawLine of body.split(";")) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const prop = trimmed.slice(0, colon).trim();
    const val = trimmed.slice(colon + 1).trim();
    decls[prop] = val;
  }
  return decls;
}

const cssPath = join(ROOT, "frontend/src/index.css");
const rawCss = readFileSync(cssPath, "utf8");
const cleanCss = rawCss.replace(/\/\*[\s\S]*?\*\//g, "");

const themeBlock = parseBlockDeclarations(cleanCss, "@theme");
const rootBlock = parseBlockDeclarations(cleanCss, ":root");
const lightBlock = parseBlockDeclarations(cleanCss, '[data-theme="light"]');

const palettes = {
  light: lightBlock,
  dark: rootBlock,
};

export function resolveToken(token, theme) {
  const themeProp = `--color-${token}`;
  const themeVal = themeBlock[themeProp];
  if (!themeVal) {
    throw new Error(`Token "${token}" (${themeProp}) not found in @theme block`);
  }
  const palette = palettes[theme];
  if (!palette) {
    throw new Error(`Unknown theme "${theme}"`);
  }
  const varMatch = themeVal.match(/^var\((--[^)]+)\)$/);
  const raw = varMatch ? palette[varMatch[1]] : themeVal;
  if (!raw) {
    throw new Error(`Variable for token "${token}" not found in ${theme} palette`);
  }
  parseHex(raw);
  return raw;
}

const tokens = ["ok", "warn", "danger", "info", "muted", "faint", "text-main"];
const surfaces = ["panel", "panel-raised"];

section("WCAG relative luminance formula and hex handling");
equal("pure black luminance is 0", relativeLuminance("#000000"), 0);
equal("pure white luminance is 1", Math.round(relativeLuminance("#ffffff")), 1);
equal("black/white contrast ratio is 21:1", Math.round(contrastRatio("#ffffff", "#000000")), 21);

throws("parseHex rejects 3-digit hex (#fff)", () => parseHex("#fff"));
throws("parseHex rejects 8-digit hex (#10b981ff)", () => parseHex("#10b981ff"));
throws("parseHex rejects rgb() color", () => parseHex("rgb(16, 185, 129)"));
throws("parseHex rejects named color", () => parseHex("transparent"));
throws("parseHex rejects invalid hex chars", () => parseHex("#10b98z"));
throws("parseHex rejects empty string", () => parseHex(""));

section("CSS token definitions and theme-aware references in index.css");
equal("--color-ok references var(--ok)", themeBlock["--color-ok"], "var(--ok)");
equal("--color-warn references var(--warn)", themeBlock["--color-warn"], "var(--warn)");
equal("--color-danger references var(--danger)", themeBlock["--color-danger"], "var(--danger)");
equal("--color-info references var(--info)", themeBlock["--color-info"], "var(--info)");

equal("dark theme (:root) --ok is #10b981", rootBlock["--ok"], "#10b981");
equal("dark theme (:root) --warn is #f59e0b", rootBlock["--warn"], "#f59e0b");
equal("dark theme (:root) --danger is #f87171", rootBlock["--danger"], "#f87171");
equal("dark theme (:root) --info is #60a5fa", rootBlock["--info"], "#60a5fa");

equal("light theme ([data-theme=\"light\"]) --ok is #047857", lightBlock["--ok"], "#047857");
equal("light theme ([data-theme=\"light\"]) --warn is #b45309", lightBlock["--warn"], "#b45309");
equal("light theme ([data-theme=\"light\"]) --danger is #b91c1c", lightBlock["--danger"], "#b91c1c");
equal("light theme ([data-theme=\"light\"]) --info is #1d4ed8", lightBlock["--info"], "#1d4ed8");

section("light theme contrast (>= 4.5:1 against panel and panel-raised)");
for (const surface of surfaces) {
  const surfaceColor = resolveToken(surface, "light");
  for (const token of tokens) {
    const tokenColor = resolveToken(token, "light");
    const ratio = contrastRatio(tokenColor, surfaceColor);
    ok(
      `light theme: ${token} (${tokenColor}) on ${surface} (${surfaceColor}) contrast ${ratio.toFixed(2)}:1 >= 4.5:1`,
      ratio >= 4.5,
    );
  }
}

section("dark theme contrast (>= 4.5:1 against panel and panel-raised)");
for (const surface of surfaces) {
  const surfaceColor = resolveToken(surface, "dark");
  for (const token of tokens) {
    const tokenColor = resolveToken(token, "dark");
    const ratio = contrastRatio(tokenColor, surfaceColor);
    ok(
      `dark theme: ${token} (${tokenColor}) on ${surface} (${surfaceColor}) contrast ${ratio.toFixed(2)}:1 >= 4.5:1`,
      ratio >= 4.5,
    );
  }
}

section("white text on solid fills (>= 4.5:1 in both themes)");
for (const theme of ["light", "dark"]) {
  const fillColor = resolveToken("danger-fill", theme);
  const ratio = contrastRatio("#ffffff", fillColor);
  ok(
    `${theme} theme: white on danger-fill (${fillColor}) contrast ${ratio.toFixed(2)}:1 >= 4.5:1`,
    ratio >= 4.5,
  );
}
const brand = themeBlock["--color-brand-blue"];
ok(`white on brand-blue (${brand}) >= 4.5:1`, contrastRatio("#ffffff", brand) >= 4.5);

finish();

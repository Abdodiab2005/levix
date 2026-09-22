import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import browserslist from "browserslist";
import { browserslistToTargets, transform } from "lightningcss";
import postcss, { type AtRule, type Container, type Rule } from "postcss";
import path from "node:path";

// The oldest engine the panel has to render on.
//
// The Android host opens the panel in the system WebView, and the 32-bit
// (armeabi-v7a) devices the APK still supports carry a Chromium years behind
// the desktop browsers Tailwind v4 emits for.
const LEGACY_QUERY = "chrome >= 87, android >= 87, safari >= 14, ios_saf >= 14";
const LEGACY_TARGETS = browserslistToTargets(browserslist(LEGACY_QUERY));

// Tailwind v4 wraps every reset and every utility in `@layer`. A WebView
// without cascade layers (pre-Chrome 99) treats those as unknown at-rules and
// drops the whole block, which leaves the panel styled by nothing but the
// unlayered rules in src/index.css — white text on the themed background, bare
// UA buttons and underlined links, exactly the unstyled panel the APK showed.
//
// Unwrapping is safe here because Tailwind's physical order already is its
// layer order (properties, theme, base, components, utilities), so plain source
// order reproduces the same cascade. It is what Tailwind v3 emitted for years.
//
// PostCSS does the unwrapping rather than Lightning CSS's visitor API: that
// visitor cannot round-trip the `@property` rules Tailwind emits.
const flattenCascadeLayers = postcss([
  {
    postcssPlugin: "levix:flatten-cascade-layers",
    AtRule: {
      layer(rule: AtRule) {
        // `@layer a, b;` declares order only — it has no body to keep.
        if (rule.nodes) rule.replaceWith(rule.nodes);
        else rule.remove();
      },
    },
  },
]);

// `translate`, `rotate` and `scale` as standalone properties need Chrome 104,
// and Tailwind v4 reaches for them in every translate/rotate/scale utility. An
// older WebView drops the declaration, which is why the mobile sidebar stopped
// working once the panel started being styled at all: `max-md:-translate-x-full`
// never moved it off-screen, so the drawer sat over the page permanently, its
// close button did nothing (as far as React went it was already closed) and no
// backdrop was mounted to catch taps — they fell straight through to whatever
// button was behind it.
//
// So re-express those utilities as `transform`, the way Tailwind v3 did. Every
// rule generated below carries the same composite string, so two utilities on
// one element (`rtl:rotate-180` next to `group-hover:translate-x-0.5`, say)
// still compose through the custom properties instead of clobbering each other.
const LEGACY_TRANSFORM =
  "translateX(var(--lx-tx,0)) translateY(var(--lx-ty,0)) rotate(var(--lx-rot,0deg)) " +
  "scaleX(var(--lx-sx,1)) scaleY(var(--lx-sy,1))";

// These have to be per-element: custom properties inherit by default, and a
// child with its own `scale-95` would otherwise also pick up its parent's
// translation. Tailwind keeps its own `--tw-*` from inheriting with `@property`;
// a universal rule does the same job without depending on that being supported.
const LEGACY_TRANSFORM_RESET =
  "*,::before,::after{--lx-tx:0;--lx-ty:0;--lx-rot:0deg;--lx-sx:1;--lx-sy:1}";

/**
 * Copy one component of a `translate`/`scale` value, giving any bare `var()` an
 * explicit fallback. Tailwind registers those properties with `@property`, so
 * the fallback is normally dead weight — but if one ever did come back unset,
 * a `var()` with nothing to fall back to would poison the whole `transform`.
 */
function withFallback(component: string, initial: string): string {
  return /^var\(\s*--[\w-]+\s*\)$/.test(component)
    ? component.replace(/\)$/, `,${initial})`)
    : component;
}

/** Split a declaration value on top-level whitespace, keeping `var(...)` whole. */
function splitComponents(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of value.trim()) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && /\s/.test(ch)) {
      if (current) parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current) parts.push(current);
  return parts;
}

/**
 * `scaleX()` only accepted a `<number>` until the same Chrome that shipped the
 * individual properties, so fold Tailwind's percentages down to a ratio. The
 * factor is usually behind a `var()` the same rule declares, so look there too.
 */
function scaleFactor(component: string, own: Map<string, string>): string {
  const reference = /^var\(\s*(--[\w-]+)\s*\)$/.exec(component);
  const literal = reference ? own.get(reference[1]) : component;
  if (literal === undefined) return withFallback(component, "1");
  const percentage = /^(-?[\d.]+)%$/.exec(literal.trim());
  return percentage ? String(Number(percentage[1]) / 100) : literal;
}

/**
 * Build the `@supports not (translate: 0px)` block that re-states every
 * `translate`/`rotate`/`scale` rule as a `transform`. Engines that do have the
 * individual properties skip the block entirely — they must, because `transform`
 * composes with them rather than overriding, and would move everything twice.
 *
 * Returns "" when the stylesheet has no such rule.
 */
function legacyTransformFallback(css: string, fail: (message: string) => never): string {
  const root = postcss.parse(css);
  // One bucket per chain of enclosing at-rules, so a `@media` around the
  // original rule survives. Insertion order keeps the chains in source order.
  const chains = new Map<string, { open: string; rules: string[] }>();

  root.walkDecls((decl) => {
    if (decl.prop !== "translate" && decl.prop !== "rotate" && decl.prop !== "scale") return;
    const rule = decl.parent as Container | undefined;
    if (!rule || rule.type !== "rule") {
      fail(`\`${decl.prop}\` outside a style rule (in ${rule?.type ?? "?"}) has no fallback`);
    }

    const own = new Map<string, string>();
    (rule as Rule).walkDecls(/^--/, (d) => {
      own.set(d.prop, d.value);
    });
    const components = splitComponents(decl.value);
    let fallback: string;
    if (decl.prop === "translate" && components.length <= 2) {
      fallback = `--lx-tx:${withFallback(components[0], "0")};--lx-ty:${
        components[1] === undefined ? "0" : withFallback(components[1], "0")
      }`;
    } else if (decl.prop === "scale" && components.length <= 2) {
      const x = scaleFactor(components[0], own);
      fallback = `--lx-sx:${x};--lx-sy:${
        components[1] === undefined ? x : scaleFactor(components[1], own)
      }`;
    } else if (decl.prop === "rotate" && components.length === 1) {
      fallback = `--lx-rot:${withFallback(components[0], "0deg")}`;
    } else {
      // Tailwind only emits the shapes above; anything else (a rotation axis, a
      // z translation) would silently lose part of the transform, so stop.
      fail(`cannot downlevel \`${decl.prop}: ${decl.value}\` to transform`);
    }

    const ancestors: string[] = [];
    for (let node = rule.parent; node && node.type !== "root"; node = node.parent) {
      if (node.type !== "atrule") fail(`unexpected ${node.type} around \`${decl.prop}\``);
      const { name, params } = node as AtRule;
      // A keyframe step would have to be re-stated whole, not just its
      // transform: a duplicate `@keyframes` replaces the original outright, so
      // copying one declaration out of a step would drop the rest of it.
      if (/keyframes$/.test(name)) fail(`\`${decl.prop}\` inside @${name} ${params} has no fallback`);
      ancestors.unshift(`@${name} ${params}`);
    }
    const key = ancestors.join("\u0000");
    let chain = chains.get(key);
    if (!chain) {
      chain = { open: ancestors.map((a) => `${a}{`).join(""), rules: [] };
      chains.set(key, chain);
    }
    chain.rules.push(`${(rule as Rule).selector}{${fallback};transform:${LEGACY_TRANSFORM}}`);
  });

  if (chains.size === 0) return "";
  const body = [...chains.values()]
    .map((chain) => chain.open + chain.rules.join("") + "}".repeat(chain.open.split("{").length - 1))
    .join("");
  return `@supports not (translate:0px){${LEGACY_TRANSFORM_RESET}${body}}`;
}

/**
 * Rewrite the emitted CSS for those WebViews: flatten `@layer`, downlevel the
 * colour syntax Tailwind v4 leans on (`oklch()`, `color-mix()`), which Lightning
 * CSS emits as a plain fallback plus an `@supports` block for the engines that
 * do understand it, then append the `transform` fallback for its individual
 * `translate`/`rotate`/`scale` properties.
 *
 * Runs `post` so it sees the finished bundle — Tailwind's own plugin is `pre`
 * and generates its utilities during `transform`.
 */
function legacyCssPlugin(): Plugin {
  return {
    name: "levix:legacy-css",
    apply: "build",
    enforce: "post",
    async generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== "asset" || !chunk.fileName.endsWith(".css")) continue;
        const source =
          typeof chunk.source === "string"
            ? chunk.source
            : Buffer.from(chunk.source).toString("utf8");
        const flattened = await flattenCascadeLayers.process(source, {
          from: undefined,
        });
        const { code } = transform({
          filename: chunk.fileName,
          code: Buffer.from(flattened.css),
          minify: true,
          targets: LEGACY_TARGETS,
        });
        const out = code.toString();
        // Cheap guards: a Tailwind upgrade that emits layers some other way, or
        // a transform shape this build cannot downlevel, should fail here rather
        // than render a broken panel on a phone nobody tests on.
        if (/@layer[\s{]/.test(out)) {
          this.error(`${chunk.fileName} still contains @layer after flattening`);
        }
        const fail = (message: string): never =>
          this.error(`${chunk.fileName}: ${message}`) as never;
        chunk.source = out + legacyTransformFallback(out, fail);
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), legacyCssPlugin()],
  base: "/dashboard/",
  build: {
    outDir: path.resolve(__dirname, "../public/dashboard"),
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash].[ext]",
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/dashboard/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
      "/socket.io": {
        target: "http://localhost:3001",
        ws: true,
      },
      "/logout": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
});

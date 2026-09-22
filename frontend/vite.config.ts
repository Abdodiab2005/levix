import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import browserslist from "browserslist";
import { browserslistToTargets, transform } from "lightningcss";
import postcss, { type AtRule } from "postcss";
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

/**
 * Rewrite the emitted CSS for those WebViews: flatten `@layer`, then downlevel
 * the colour syntax Tailwind v4 leans on (`oklch()`, `color-mix()`), which
 * Lightning CSS emits as a plain fallback plus an `@supports` block for the
 * engines that do understand it.
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
        // Cheap guard: a Tailwind upgrade that emits layers some other way
        // should fail the build here, not render an unstyled panel on a phone.
        if (/@layer[\s{]/.test(out)) {
          this.error(`${chunk.fileName} still contains @layer after flattening`);
        }
        chunk.source = out;
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

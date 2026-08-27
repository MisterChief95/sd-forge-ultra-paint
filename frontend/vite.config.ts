/**
 * Vite config for the Ultra Paint frontend (Phase 2.R).
 *
 * This builds a standalone static SPA, no SvelteKit -- see PLAN.md §6a for why
 * (one embedded page with no routing/SSR to justify a framework on top of
 * Vite). Output goes to `dist/` and is served by the extension's own FastAPI
 * route (`scripts/ultra_paint_api.py`, `StaticFiles` mount at
 * `/ultra_paint/app`, T16) rather than through Gradio's component system.
 *
 * `base` MUST match the FastAPI mount prefix exactly (trailing slash
 * included) so Vite's emitted asset URLs (`/ultra_paint/app/assets/...`)
 * resolve correctly once served from that prefix instead of site root.
 */
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";

// Forge backend origin for `npm run dev` -- override with
// `ULTRA_PAINT_BACKEND` if it's not running on the default port.
const BACKEND_ORIGIN = process.env.ULTRA_PAINT_BACKEND ?? "http://127.0.0.1:7860";

export default defineConfig({
  base: "/ultra_paint/app/",
  plugins: [svelte(), tailwindcss()],
  server: {
    proxy: {
      "/ultra_paint/api": BACKEND_ORIGIN,
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    // Single-entry embedded app -- no routes to code-split to, so the whole
    // bundle loads on first paint regardless. Silence the default 500kB hint.
    chunkSizeWarningLimit: 1024,
  },
});

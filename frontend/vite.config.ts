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

export default defineConfig({
  base: "/ultra_paint/app/",
  plugins: [svelte(), tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
});

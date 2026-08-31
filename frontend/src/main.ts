/**
 * sd-forge-ultra-paint -- Vite/Svelte entry point (Phase 2.R).
 *
 * Replaces the old Gradio-bootstrap entry (`window.UltraPaintBootstrap`,
 * esbuild-bundled into `../javascript/ultra-paint.mjs`). The app now runs as
 * a standalone SPA loaded in its own `<iframe>` document -- see
 * `javascript/ultra-paint-iframe.js` (T15) for the host-side mount, and
 * `scripts/ultra_paint_api.py` (T16) for the FastAPI static route that
 * serves this build's `dist/`.
 */
import { mount } from "svelte";

import "./app.css";
import App from "./App.svelte";
import { getActiveUltraPaintApp } from "./app/UltraPaintApp";
import { filterStore } from "./state/filterStore.svelte";
import { layerStore } from "./state/layerStore.svelte";
import { paintToolStore } from "./state/paintToolStore.svelte";
import { previewStore } from "./state/previewStore.svelte";

const target = document.getElementById("app");
if (!target) {
  throw new Error("[ultra-paint] #app mount point not found");
}

const app = mount(App, { target });

if (import.meta.env.DEV) {
  (
    window as unknown as {
      __ultraPaintTest?: unknown;
    }
  ).__ultraPaintTest = {
    getActiveUltraPaintApp,
    layerStore,
    paintToolStore,
    filterStore,
    previewStore,
  };
}

export default app;

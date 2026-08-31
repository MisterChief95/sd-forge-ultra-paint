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
import { Graphics } from "pixi.js";
import type { RenderTexture } from "pixi.js";

import "./app.css";
import App from "./App.svelte";
import { getActiveUltraPaintApp } from "./app/UltraPaintApp";
import { TiledRasterCanvas } from "./canvas/TiledRasterCanvas";
import type { TileEditTransaction } from "./canvas/TiledRasterCanvas";
import { blitTexture } from "./canvas/TileRasterOps";
import { LayerNode } from "./scene/LayerNode";
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
    getRendererName() {
      return getActiveUltraPaintApp()?.app?.renderer.name ?? "unavailable";
    },
    layerStore,
    paintToolStore,
    filterStore,
    previewStore,
    createTiledRasterCanvas(tileSize = 64) {
      const renderer = getActiveUltraPaintApp()?.app?.renderer;
      if (!renderer) throw new Error("Ultra Paint renderer is not ready");
      return new TiledRasterCanvas(renderer, tileSize);
    },
    createTiledRasterLayerNode(surface: TiledRasterCanvas) {
      return new LayerNode(
        {
          id: "test-tiled-raster",
          name: "Test tiled raster",
          kind: "raster",
          visible: true,
          locked: false,
          preserveAlpha: false,
          opacity: 1,
          blendMode: "normal",
          transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
          parentId: null,
          image: { source: "paint", width: 0, height: 0 },
        },
        surface,
      );
    },
    renderTileColor(target: RenderTexture, color: number) {
      const renderer = getActiveUltraPaintApp()?.app?.renderer;
      if (!renderer) throw new Error("Ultra Paint renderer is not ready");
      const fill = new Graphics().rect(0, 0, target.width, target.height).fill(color);
      try {
        renderer.render({
          container: fill,
          target,
          clear: true,
          clearColor: [0, 0, 0, 0],
        });
      } finally {
        fill.destroy();
      }
    },
    blitTextureToSurface(
      surface: TiledRasterCanvas,
      source: RenderTexture,
      transaction: TileEditTransaction,
      x: number,
      y: number,
    ) {
      const renderer = getActiveUltraPaintApp()?.app?.renderer;
      if (!renderer) throw new Error("Ultra Paint renderer is not ready");
      return blitTexture(renderer, surface, source, transaction, x, y);
    },
    async readTilePixel(target: RenderTexture, x = 0, y = 0) {
      const renderer = getActiveUltraPaintApp()?.app?.renderer;
      if (!renderer) throw new Error("Ultra Paint renderer is not ready");
      // `extract.pixels()`'s `frame` option is ignored by the installed Pixi
      // build (always returns the full target), so index the full buffer
      // ourselves rather than relying on it to crop.
      const { pixels, width } = await renderer.extract.pixels({ target });
      const offset = (y * width + x) * 4;
      return Array.from(pixels.slice(offset, offset + 4));
    },
  };
}

export default app;

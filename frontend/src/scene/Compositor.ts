/**
 * sd-forge-ultra-paint -- flattens the layer tree to a PNG data URL.
 *
 * This is what the Python bridge will eventually hand to img2img/inpaint, so
 * the output must be exactly `width x height` document pixels with no canvas
 * background, no device-pixel-ratio scaling, and no view pan/zoom baked in.
 *
 * PixiJS v8 API notes (v7 habits do not transfer):
 *  - `renderer.extract.base64()` exists but is ASYNC. `extract.canvas()` is
 *    synchronous and returns an `ICanvas`, so we go through that to keep
 *    `flatten()` synchronous as the callers expect.
 *  - `ICanvas.toDataURL` is an OPTIONAL member of the interface (a worker
 *    `OffscreenCanvas` only has `convertToBlob`), hence the runtime guard.
 *  - `AbstractRenderer.render({container})` computes its render transform
 *    from `container.updateLocalTransform()` / `.localTransform` ONLY -- it
 *    does NOT compose with the container's real ancestor chain (confirmed
 *    against `pixi.js`'s own source, not assumed). That's why resetting
 *    `documentRootContainer`'s own transform below is sufficient to
 *    neutralise pan/zoom applied to `UltraPaintApp`'s `world` container
 *    (`documentRootContainer`'s parent): the render call never looks at
 *    `world`'s transform in the first place. It also means a `.mask`
 *    assigned to `documentRootContainer` MUST be cleared for the duration of
 *    this render if the mask object itself lives outside
 *    `documentRootContainer`'s own subtree (as `UltraPaintApp`'s
 *    document-bounds mask does, sitting on a sibling under `world`) --
 *    otherwise the mask clips using whatever transform it last got from the
 *    normal per-frame render loop (which DOES include `world`'s live
 *    pan/zoom), against content that this call is rendering in a
 *    freshly-reset, un-panned/unzoomed space. The two spaces disagree unless
 *    the user happens to be at the default 1:1 centered view, silently
 *    corrupting the exported composite the rest of the time.
 */

import {
  ColorMatrixFilter,
  Container,
  Matrix,
  Rectangle,
  RenderTexture,
  Sprite,
} from "pixi.js";
import type { Application } from "pixi.js";
import { getTileRendererCapabilities, PREFERRED_TILE_SIZE } from "../canvas/rendererCapabilities";
import type { LayerStore } from "../state/layerStore.svelte";
import type { BoundaryBox } from "../state/schema";
import { toPixiBlendMode } from "../util/blendModes";

export class Compositor {
  /**
   * Render `documentRootContainer` into an offscreen `RenderTexture` and
   * return it as a `data:image/png;base64,...` string.
   *
   * An explicit render transform selects each document-space chunk, so neither
   * viewport pan/zoom nor the document root's cached render state can leak in.
   */
  public static flatten(
    app: Application,
    documentRootContainer: Container,
    box: BoundaryBox,
    requestedChunkSize?: number,
  ): string {
    if (!app.renderer) {
      throw new Error("[ultra-paint] flatten() called before app.init()");
    }
    if (box.width <= 0 || box.height <= 0) {
      throw new Error(
        `[ultra-paint] flatten() needs a positive size, got ${box.width}x${box.height}`,
      );
    }

    const capabilities = getTileRendererCapabilities(app.renderer);
    const chunkSize = requestedChunkSize ?? capabilities.selectedTileSize ?? PREFERRED_TILE_SIZE;
    if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
      throw new RangeError(`flatten() needs a positive integer chunk size, got ${chunkSize}`);
    }
    if (
      capabilities.maxTextureDimension2D !== null &&
      chunkSize > capabilities.maxTextureDimension2D
    ) {
      throw new RangeError(
        `flatten() chunk ${chunkSize} exceeds renderer limit ${capabilities.maxTextureDimension2D}`,
      );
    }

    const output = document.createElement("canvas");
    output.width = box.width;
    output.height = box.height;
    if (output.width !== box.width || output.height !== box.height) {
      throw new RangeError(
        `flatten() output ${box.width}x${box.height} exceeds this browser's canvas limit`,
      );
    }
    const context = output.getContext("2d");
    if (!context) throw new Error("[ultra-paint] could not create the flatten output canvas");

    const root = documentRootContainer;

    // The document-bounds mask is a viewport sibling in another coordinate
    // space, so it must not participate in this standalone render.
    const previousMask = root.mask;
    root.mask = null;
    const transform = new Matrix();

    try {
      for (let offsetY = 0; offsetY < box.height; offsetY += chunkSize) {
        for (let offsetX = 0; offsetX < box.width; offsetX += chunkSize) {
          const width = Math.min(chunkSize, box.width - offsetX);
          const height = Math.min(chunkSize, box.height - offsetY);
          transform.set(1, 0, 0, 1, -box.x - offsetX, -box.y - offsetY);
          const chunk = RenderTexture.create({
            width,
            height,
            resolution: 1,
            antialias: false,
          });
          try {
            app.renderer.render({
              container: root,
              target: chunk,
              transform,
              clear: true,
              clearColor: [0, 0, 0, 0],
            });
            const canvas = app.renderer.extract.canvas({
              target: chunk,
              frame: new Rectangle(0, 0, width, height),
              resolution: 1,
            });
            context.drawImage(canvas as CanvasImageSource, offsetX, offsetY);
          } finally {
            chunk.destroy(true);
          }
        }
      }
      return output.toDataURL("image/png");
    } finally {
      root.mask = previousMask;
    }
  }

  /**
   * Same render, returned as a `Texture` instead of a data URL.
   *
   * Useful for "merge visible" / "flatten to new layer" operations in a later
   * phase. The caller owns the returned texture and must `destroy(true)` it.
   */
  public static flattenToTexture(
    app: Application,
    documentRootContainer: Container,
    box: BoundaryBox,
  ): RenderTexture {
    const root = documentRootContainer;
    const prev = {
      x: root.x,
      y: root.y,
      scaleX: root.scale.x,
      scaleY: root.scale.y,
      rotation: root.rotation,
      mask: root.mask,
    };
    root.position.set(-box.x, -box.y);
    root.scale.set(1, 1);
    root.rotation = 0;
    root.mask = null;

    const renderTexture = RenderTexture.create({
      width: box.width,
      height: box.height,
      resolution: 1,
      antialias: false,
    });
    try {
      app.renderer.render({
        container: root,
        target: renderTexture,
        clear: true,
        clearColor: [0, 0, 0, 0],
      });
      return renderTexture;
    } finally {
      root.position.set(prev.x, prev.y);
      root.scale.set(prev.scaleX, prev.scaleY);
      root.rotation = prev.rotation;
      root.mask = prev.mask;
    }
  }

  /**
   * Flatten visible mask coverage to opaque black/white PNG data.
   *
   * The temporary sprites deliberately use the store textures directly,
   * never the hatch-filtered display sprites owned by `LayerTree`.
   */
  public static flattenMask(app: Application, store: LayerStore, box: BoundaryBox): string | null {
    const doc = store.getDocument();
    const byId = new Map(doc.layers.map((layer) => [layer.id, layer]));
    const masks = doc.layerOrder
      .map((id) => byId.get(id))
      .filter((layer) => layer !== undefined && layer.kind === "mask" && layer.visible);
    if (masks.length === 0) return null;
    if (box.width <= 0 || box.height <= 0) {
      throw new Error(
        `[ultra-paint] flattenMask() needs a positive size, got ${box.width}x${box.height}`,
      );
    }

    const root = new Container({ label: "ultra-paint:mask-export" });
    root.position.set(-box.x, -box.y);
    const filters: ColorMatrixFilter[] = [];

    // Pixi draws last-child-on-top; document index 0 is the top.
    for (let index = masks.length - 1; index >= 0; index -= 1) {
      const layer = masks[index];
      if (!layer) continue;
      const texture = store.getTexture(layer.id);
      if (!texture) continue;

      const layerContainer = new Container({ label: `mask-export:${layer.id}` });
      const transform = layer.transform;
      layerContainer.position.set(transform.x, transform.y);
      layerContainer.scale.set(transform.scaleX, transform.scaleY);
      layerContainer.rotation = transform.rotation;
      layerContainer.alpha = layer.opacity;
      layerContainer.blendMode = toPixiBlendMode(layer.blendMode);

      const sprite = new Sprite({ texture, label: `mask-export-sprite:${layer.id}` });

      const filter = new ColorMatrixFilter();
      filter.matrix = [0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0];
      layerContainer.filters = [filter];
      filters.push(filter);
      layerContainer.addChild(sprite);
      root.addChild(layerContainer);
    }

    const renderTexture = RenderTexture.create({
      width: box.width,
      height: box.height,
      resolution: 1,
      antialias: false,
    });

    try {
      app.renderer.render({
        container: root,
        target: renderTexture,
        clear: true,
        clearColor: [0, 0, 0, 1],
      });
      const canvas = app.renderer.extract.canvas({
        target: renderTexture,
        frame: new Rectangle(0, 0, box.width, box.height),
        resolution: 1,
      });
      if (typeof canvas.toDataURL !== "function") {
        throw new Error("[ultra-paint] canvas.toDataURL is unavailable in this environment");
      }
      return canvas.toDataURL("image/png");
    } finally {
      for (const filter of filters) filter.destroy();
      root.destroy({ children: true });
      renderTexture.destroy(true);
    }
  }
}

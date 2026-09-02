import { Container, Matrix, Rectangle, RenderTexture, Sprite, Texture } from "pixi.js";
import type { Renderer } from "pixi.js";

import { getTileRendererCapabilities, PREFERRED_TILE_SIZE } from "./rendererCapabilities";
import type { TileEditTransaction, TileVisit } from "./TiledRasterCanvas";
import { TiledRasterCanvas } from "./TiledRasterCanvas";
import type { PixelBounds } from "./TileGrid";

/**
 * Composite a decoded/generated texture into persistent tiles at layer-local
 * coordinates. The source remains caller-owned and may be destroyed afterward.
 */
export function blitTexture(
  renderer: Renderer,
  surface: TiledRasterCanvas,
  source: Texture,
  transaction: TileEditTransaction,
  x = 0,
  y = 0,
): PixelBounds {
  const bounds = { x, y, width: source.width, height: source.height };
  surface.edit(bounds, { allocation: "allocate-missing", transaction }, (tile) => {
    const root = new Container();
    const sprite = new Sprite({ texture: source });
    sprite.position.set(x - tile.originX, y - tile.originY);
    root.addChild(sprite);
    try {
      renderer.render({
        container: root,
        target: tile.target,
        clear: false,
      });
    } finally {
      root.destroy({ children: true, texture: false, textureSource: false });
    }
  });
  transaction.includeBounds(bounds);
  return bounds;
}

/**
 * Render every tile into a CPU-owned canvas sized to the surface's logical
 * bounds, for read-only paths (single-image source export, pixel scanning)
 * that need one flattened snapshot.
 *
 * A sparse layer can be wider or taller than the renderer's max texture
 * dimension, so this never allocates one monolithic `RenderTexture` sized to
 * the whole layer. Instead it renders device-safe chunks (mirroring
 * `Compositor`'s chunked flatten) and stitches each into the output canvas,
 * destroying every chunk texture as it goes.
 */
export function flattenToCanvas(
  renderer: Renderer,
  surface: TiledRasterCanvas,
  requestedChunkSize?: number,
): { canvas: HTMLCanvasElement; originX: number; originY: number } {
  const bounds = surface.bounds ?? { x: 0, y: 0, width: 1, height: 1 };
  const width = Math.max(1, bounds.width);
  const height = Math.max(1, bounds.height);

  const capabilities = getTileRendererCapabilities(renderer);
  const chunkSize = requestedChunkSize ?? capabilities.selectedTileSize ?? PREFERRED_TILE_SIZE;
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
    throw new RangeError(`flattenToCanvas() needs a positive integer chunk size, got ${chunkSize}`);
  }
  if (
    capabilities.maxTextureDimension2D !== null &&
    chunkSize > capabilities.maxTextureDimension2D
  ) {
    throw new RangeError(
      `flattenToCanvas() chunk ${chunkSize} exceeds renderer limit ${capabilities.maxTextureDimension2D}`,
    );
  }

  const output = document.createElement("canvas");
  output.width = width;
  output.height = height;
  if (output.width !== width || output.height !== height) {
    throw new RangeError(
      `flattenToCanvas() output ${width}x${height} exceeds this browser's canvas limit`,
    );
  }
  const context = output.getContext("2d");
  if (!context) throw new Error("[ultra-paint] could not create the flattenToCanvas output canvas");

  const root = new Container();
  surface.visitAll((tile) => {
    const sprite = new Sprite({ texture: tile.target });
    sprite.position.set(tile.originX - bounds.x, tile.originY - bounds.y);
    root.addChild(sprite);
  });

  try {
    const transform = new Matrix();
    for (let offsetY = 0; offsetY < height; offsetY += chunkSize) {
      for (let offsetX = 0; offsetX < width; offsetX += chunkSize) {
        const chunkWidth = Math.min(chunkSize, width - offsetX);
        const chunkHeight = Math.min(chunkSize, height - offsetY);
        transform.set(1, 0, 0, 1, -offsetX, -offsetY);
        const chunk = RenderTexture.create({
          width: chunkWidth,
          height: chunkHeight,
          resolution: 1,
          antialias: false,
        });
        try {
          renderer.render({
            container: root,
            target: chunk,
            transform,
            clear: true,
            clearColor: [0, 0, 0, 0],
          });
          const chunkCanvas = renderer.extract.canvas({
            target: chunk,
            frame: new Rectangle(0, 0, chunkWidth, chunkHeight),
            resolution: 1,
          });
          context.drawImage(chunkCanvas as CanvasImageSource, offsetX, offsetY);
        } finally {
          chunk.destroy(true);
        }
      }
    }
  } finally {
    root.destroy({ children: true, texture: false, textureSource: false });
  }

  return { canvas: output, originX: bounds.x, originY: bounds.y };
}

/**
 * Copy every allocated tile of `source` into a fresh, grid-aligned
 * `TiledRasterCanvas` with identical bounds/origin -- no full-boundary-box
 * intermediate texture is ever allocated. `perTile`, when given, replaces
 * each tile's pixels (e.g. mask luminance conversion) instead of a straight
 * GPU copy; its returned texture is caller-owned and destroyed here after
 * the blit.
 */
export function copyTiledSurfaceTileByTile(
  renderer: Renderer,
  source: TiledRasterCanvas,
  perTile?: (tile: TileVisit) => Texture,
): TiledRasterCanvas {
  const dest = new TiledRasterCanvas(renderer, source.tileSize);
  const transaction = dest.beginEdit(perTile ? "convert-mask" : "convert-control");
  try {
    source.visitAll((tile) => {
      const region = {
        x: tile.originX,
        y: tile.originY,
        width: source.tileSize,
        height: source.tileSize,
      };
      dest.edit(region, { allocation: "allocate-missing", transaction }, (destTile) => {
        const texture = perTile ? perTile(tile) : tile.target;
        const sprite = new Sprite({ texture });
        try {
          renderer.render({
            container: sprite,
            target: destTile.target,
            clear: true,
            clearColor: [0, 0, 0, 0],
          });
        } finally {
          sprite.destroy({ children: false, texture: false, textureSource: false });
          if (perTile) texture.destroy(true);
        }
      });
    });
    if (source.bounds) transaction.includeBounds(source.bounds);
    transaction.commit().destroy();
    return dest;
  } catch (error) {
    transaction.rollback();
    dest.destroy();
    throw error;
  }
}

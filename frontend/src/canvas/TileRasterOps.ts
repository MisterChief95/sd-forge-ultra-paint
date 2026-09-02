import { Container, RenderTexture, Sprite, Texture } from "pixi.js";
import type { Renderer } from "pixi.js";

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
 * Render every tile into one fresh `RenderTexture` sized to the surface's
 * logical bounds, for read-only paths (single-image source export) that
 * genuinely need a monolithic snapshot. Caller owns the result.
 */
export function flattenToTexture(renderer: Renderer, surface: TiledRasterCanvas): RenderTexture {
  const bounds = surface.bounds ?? { x: 0, y: 0, width: 1, height: 1 };
  const texture = RenderTexture.create({
    width: Math.max(1, bounds.width),
    height: Math.max(1, bounds.height),
    resolution: 1,
    antialias: false,
  });
  const root = new Container();
  surface.visitAll((tile) => {
    const sprite = new Sprite({ texture: tile.target });
    sprite.position.set(tile.originX - bounds.x, tile.originY - bounds.y);
    root.addChild(sprite);
  });
  try {
    renderer.render({ container: root, target: texture, clear: true, clearColor: [0, 0, 0, 0] });
    return texture;
  } catch (error) {
    texture.destroy(true);
    throw error;
  } finally {
    root.destroy({ children: true, texture: false, textureSource: false });
  }
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

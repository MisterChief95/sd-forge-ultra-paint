import { Container, Graphics, Sprite } from "pixi.js";
import type { Filter } from "pixi.js";

import type { TileStructureEvent, TileVisit } from "./TiledRasterCanvas";
import { TiledRasterCanvas } from "./TiledRasterCanvas";
import type { PixelBounds, TileCoord } from "./TileGrid";

/**
 * Scene-only projection of a TiledRasterCanvas.
 *
 * The surface owns textures; this view owns only sprites. Its container stays
 * in layer-local coordinates so LayerNode can apply one transform to every tile.
 */
export class TiledRasterView {
  public readonly container: Container;

  readonly #sprites = new Map<string, Sprite>();

  readonly #visibleKeys = new Set<string>();

  private readonly unsubscribe: () => void;

  private filters: readonly Filter[] | null = null;

  /** Null means compositor/all-tiles mode. */
  private visibleRegion: PixelBounds | null = null;

  /** Debug-only outline over each currently-attached tile; null while hidden. */
  private debugBorders: Graphics | null = null;

  /** Sample mode applied to every tile texture, current and future. */
  private scaleMode: "linear" | "nearest" = "linear";

  private destroyed = false;

  constructor(
    private readonly surface: TiledRasterCanvas,
    label = "tiled-raster-view",
  ) {
    this.container = new Container({ label });
    this.container.eventMode = "none";
    surface.visitAll((tile) => this.add(tile));
    this.unsubscribe = surface.subscribe(this.handleStructureEvent);
  }

  public get spriteCount(): number {
    return this.#sprites.size;
  }

  public get visibleSpriteCount(): number {
    return this.#visibleKeys.size;
  }

  /**
   * Restrict attached sprites to one layer-local viewport region. Passing null
   * restores all tiles for compositor/export work; storage is never affected.
   */
  public setVisibleRegion(region: PixelBounds | null): void {
    if (this.destroyed) return;
    const next = new Set<string>();
    const collect = (tile: TileVisit) => next.add(this.surface.grid.key(tile.coord));
    if (region) this.surface.visit(region, collect);
    else this.surface.visitAll(collect);

    for (const key of this.#visibleKeys) {
      if (!next.has(key)) this.#sprites.get(key)?.removeFromParent();
    }
    for (const key of next) {
      if (this.#visibleKeys.has(key)) continue;
      const sprite = this.#sprites.get(key);
      if (sprite) this.container.addChild(sprite);
    }
    this.#visibleKeys.clear();
    for (const key of next) this.#visibleKeys.add(key);
    this.visibleRegion = region ? { ...region } : null;
    this.redrawDebugBorders();
  }

  /**
   * Hide one tile's persistent sprite so a live stroke overlay can stand in for
   * it. An eraser preview *replaces* a tile rather than adding to it: left
   * visible underneath, the untouched tile shows straight through the preview's
   * newly-transparent pixels and nothing appears to change on screen.
   */
  public setTileHidden(coord: TileCoord, hidden: boolean): void {
    if (this.destroyed) return;
    const sprite = this.#sprites.get(this.surface.grid.key(coord));
    if (sprite) sprite.visible = !hidden;
  }

  /** Debug-only: outline every currently-attached tile in green. */
  public setDebugBorders(visible: boolean): void {
    if (this.destroyed) return;
    if (!visible) {
      this.debugBorders?.destroy();
      this.debugBorders = null;
      return;
    }
    if (!this.debugBorders) {
      this.debugBorders = new Graphics({ label: "tile-debug-borders" });
      this.debugBorders.eventMode = "none";
      this.container.addChild(this.debugBorders);
    }
    this.redrawDebugBorders();
  }

  /** Toggle smooth (linear) vs. crisp (nearest) sampling for every tile, current and future. */
  public setAntialiased(enabled: boolean): void {
    if (this.destroyed) return;
    this.scaleMode = enabled ? "linear" : "nearest";
    for (const sprite of this.#sprites.values()) {
      sprite.texture.source.scaleMode = this.scaleMode;
    }
  }

  /** Apply display-only filters per tile, avoiding one sparse-span filter target. */
  public setFilters(filters: readonly Filter[] | null): void {
    if (this.destroyed) return;
    this.filters = filters;
    for (const sprite of this.#sprites.values()) {
      sprite.filters = filters ? [...filters] : null;
    }
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.unsubscribe();
    for (const sprite of this.#sprites.values()) {
      sprite.removeFromParent();
      sprite.filters = null;
      sprite.destroy({ texture: false, textureSource: false });
    }
    this.#sprites.clear();
    this.#visibleKeys.clear();
    this.filters = null;
    this.debugBorders?.destroy();
    this.debugBorders = null;
    this.container.destroy({ children: false });
  }

  private readonly handleStructureEvent = (event: TileStructureEvent): void => {
    if (this.destroyed) return;
    const key = this.surface.grid.key(event.coord);
    const existing = this.#sprites.get(key);

    if (!event.target) {
      if (!existing) return;
      this.#sprites.delete(key);
      this.#visibleKeys.delete(key);
      existing.removeFromParent();
      existing.filters = null;
      existing.destroy({ texture: false, textureSource: false });
      this.redrawDebugBorders();
      return;
    }

    if (existing) {
      existing.texture = event.target;
      existing.texture.source.scaleMode = this.scaleMode;
      return;
    }
    this.add({
      coord: event.coord,
      originX: event.coord.x * this.surface.tileSize,
      originY: event.coord.y * this.surface.tileSize,
      target: event.target,
    });
    this.redrawDebugBorders();
  };

  private add(tile: TileVisit): void {
    const key = this.surface.grid.key(tile.coord);
    if (this.#sprites.has(key)) {
      throw new Error(`tile sprite already exists at ${key}`);
    }
    const sprite = new Sprite({
      texture: tile.target,
      label: `tile:${key}`,
      x: tile.originX,
      y: tile.originY,
    });
    sprite.texture.source.scaleMode = this.scaleMode;
    if (this.filters) sprite.filters = [...this.filters];
    this.#sprites.set(key, sprite);
    if (this.isVisible(tile.coord)) {
      this.#visibleKeys.add(key);
      this.container.addChild(sprite);
      // `addChild` on an existing child moves it to the end, so this keeps the
      // debug outline drawn on top of every tile sprite added afterward.
      if (this.debugBorders) this.container.addChild(this.debugBorders);
    }
  }

  private isVisible(coord: TileCoord): boolean {
    if (!this.visibleRegion) return true;
    const range = this.surface.grid.rangeFor(this.visibleRegion);
    return (
      coord.x >= range.minX &&
      coord.x <= range.maxX &&
      coord.y >= range.minY &&
      coord.y <= range.maxY
    );
  }

  /** Redraw the debug outline over exactly the currently-attached tiles. */
  private redrawDebugBorders(): void {
    const graphics = this.debugBorders;
    if (!graphics) return;
    graphics.clear();
    const size = this.surface.tileSize;
    for (const key of this.#visibleKeys) {
      const sprite = this.#sprites.get(key);
      if (!sprite) continue;
      graphics.rect(sprite.x + 0.5, sprite.y + 0.5, size - 1, size - 1);
    }
    graphics.stroke({ width: 1, color: 0x00ff00, alignment: 0.5 });
  }
}

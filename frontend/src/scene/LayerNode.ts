/**
 * sd-forge-ultra-paint -- one PixiJS `Container` per document layer.
 *
 * Every layer, raster or group, gets exactly one `Container`. That container is
 * where visual state lives (alpha / blendMode / visible / transform), because:
 *
 *  - PixiJS v8 leaves (`Sprite`, `Graphics`, `Text`, `Mesh`) must NOT have
 *    children. Giving each layer its own `Container` means a raster layer can
 *    later gain a mask, an outline, or paint strokes without restructuring.
 *  - `Container.alpha`/`.blendMode` propagate down the subtree, so a group and
 *    a raster layer behave identically from `LayerTree`'s point of view.
 *
 * `LayerNode` never touches its own children ordering -- `LayerTree` owns the
 * hierarchy and attaches child nodes' containers into `this.container`.
 */

import { Container, Sprite } from "pixi.js";
import type { Filter, Texture } from "pixi.js";

import { TiledRasterCanvas } from "../canvas/TiledRasterCanvas";
import { TiledRasterView } from "../canvas/TiledRasterView";
import type { PixelBounds, TileCoord } from "../canvas/TileGrid";
import type { Layer, LayerId, LayerKind } from "../state/schema";
import { toPixiBlendMode } from "../util/blendModes";
import { ControlLayerDisplayFilter } from "./ControlLayerDisplayFilter";
import { MaskHatchFilter } from "./MaskHatchFilter";

export class LayerNode {
  /** The display object `LayerTree` parents into the scene graph. */
  public readonly container: Container;

  public readonly id: LayerId;

  public readonly kind: LayerKind;

  /** Present for paintable raster, mask, and control layers. */
  private sprite: Sprite | null = null;

  private tiledView: TiledRasterView | null = null;

  private texture: Texture | null = null;

  private previewOverride: Texture | null = null;

  private previewSprite: Sprite | null = null;

  private lastLayer: Layer | null = null;

  private maskHatchFilter: MaskHatchFilter | null = null;

  private controlDisplayFilter: ControlLayerDisplayFilter | null = null;

  /** Persists across `setTiledSurface()` swaps so a repaint doesn't drop the debug outline. */
  private tileDebugBordersVisible = false;

  /** Persists across `setTiledSurface()` swaps so a repaint doesn't drop the sample mode. */
  private tileAntialiasingEnabled = true;

  private destroyed = false;

  constructor(layer: Layer, pixels?: Texture | TiledRasterCanvas) {
    this.id = layer.id;
    this.kind = layer.kind;

    this.container = new Container({ label: `layer:${layer.id}` });

    switch (layer.kind) {
      case "raster":
      case "mask":
      case "control":
        if (!pixels) {
          throw new Error(`[ultra-paint] ${layer.kind} layer "${layer.id}" created without pixels`);
        }
        if (pixels instanceof TiledRasterCanvas) {
          this.tiledView = new TiledRasterView(pixels, `tiles:${layer.id}`);
          this.tiledView.setAntialiased(this.tileAntialiasingEnabled);
          this.container.addChild(this.tiledView.container);
        } else {
          this.sprite = new Sprite({
            texture: pixels,
            label: `sprite:${layer.id}`,
          });
          this.texture = pixels;
          this.container.addChild(this.sprite);
        }
        break;
      case "group":
        break;
      default: {
        const exhaustive: never = layer;
        throw new Error(`[ultra-paint] unsupported layer kind: ${String(exhaustive)}`);
      }
    }

    this.update(layer);
  }

  /**
   * Re-apply visual state from the store.
   *
   * Mutates the existing display objects in place; it never rebuilds the
   * `Container` or `Sprite`, so identity (and therefore the scene graph
   * position established by `LayerTree`) is stable across updates.
   */
  public update(layer: Layer): void {
    if (this.destroyed) return;
    this.lastLayer = layer;

    const c = this.container;

    c.visible = layer.visible;
    c.alpha = layer.opacity;
    c.blendMode = layer.kind === "control" ? "normal" : toPixiBlendMode(layer.blendMode);

    const t = layer.transform;
    c.position.set(t.x, t.y);
    c.scale.set(t.scaleX, t.scaleY);
    c.rotation = t.rotation;

    if (this.previewOverride) return;
    if (this.sprite && this.texture) this.sprite.texture = this.texture;
    this.applyDisplayTreatment(layer);
  }

  private applyDisplayTreatment(layer: Layer): void {
    const c = this.container;
    switch (layer.kind) {
      case "mask":
        if (!this.maskHatchFilter) {
          this.maskHatchFilter = new MaskHatchFilter(layer.color);
        } else {
          this.maskHatchFilter.setColor(layer.color);
        }
        // Monolithic content filters at the layer container; tiled content
        // filters each sprite so Pixi never allocates one sparse-span target.
        this.setPersistentFilters([this.maskHatchFilter]);
        break;
      case "control":
        if (this.maskHatchFilter) {
          this.maskHatchFilter.destroy();
          this.maskHatchFilter = null;
        }
        if (!this.controlDisplayFilter) {
          this.controlDisplayFilter = new ControlLayerDisplayFilter();
        }
        c.blendMode = "normal";
        this.setPersistentFilters([this.controlDisplayFilter]);
        break;
      case "raster":
      case "group":
        if (this.maskHatchFilter) {
          this.maskHatchFilter.destroy();
          this.maskHatchFilter = null;
        }
        if (this.controlDisplayFilter) {
          this.controlDisplayFilter.destroy();
          this.controlDisplayFilter = null;
        }
        this.setPersistentFilters(null);
        break;
      default: {
        const exhaustive: never = layer;
        throw new Error(`[ultra-paint] unsupported layer kind: ${String(exhaustive)}`);
      }
    }
  }

  /**
   * Swap the texture of a paintable layer (repaint, regenerate, upscale...).
   * No-op for groups.
   */
  public setTexture(texture: Texture): void {
    if (this.destroyed || this.kind === "group") return;
    this.tiledView?.destroy();
    this.tiledView = null;
    if (!this.sprite) {
      this.sprite = new Sprite({ texture, label: `sprite:${this.id}` });
      this.container.addChild(this.sprite);
    }
    this.texture = texture;
    this.sprite.texture = texture;
    this.sprite.visible = !this.previewOverride;
    if (this.lastLayer && !this.previewOverride) this.applyDisplayTreatment(this.lastLayer);
  }

  /** Switch a paintable node to a tile-sprite projection without changing its transform. */
  public setTiledSurface(surface: TiledRasterCanvas): void {
    if (this.destroyed || this.kind === "group") return;
    this.sprite?.removeFromParent();
    this.sprite?.destroy({ texture: false, textureSource: false });
    this.sprite = null;
    this.texture = null;
    this.tiledView?.destroy();
    this.tiledView = new TiledRasterView(surface, `tiles:${this.id}`);
    this.tiledView.container.visible = !this.previewOverride;
    this.tiledView.setDebugBorders(this.tileDebugBordersVisible);
    this.tiledView.setAntialiased(this.tileAntialiasingEnabled);
    this.container.addChild(this.tiledView.container);
    if (this.lastLayer && !this.previewOverride) this.applyDisplayTreatment(this.lastLayer);
  }

  /** Display-only tile selection in layer-local coordinates; null restores all tiles. */
  public setTiledVisibleRegion(region: PixelBounds | null): void {
    this.tiledView?.setVisibleRegion(region);
  }

  /** Hide one persistent tile sprite while a stroke overlay stands in for it. */
  public setTileSpriteHidden(coord: TileCoord, hidden: boolean): void {
    this.tiledView?.setTileHidden(coord, hidden);
  }

  /** Debug-only: outline this layer's tiles in green. No-op for non-tiled layers. */
  public setTileDebugBorders(visible: boolean): void {
    this.tileDebugBordersVisible = visible;
    this.tiledView?.setDebugBorders(visible);
  }

  /** Toggle smooth vs. crisp tile sampling. No-op for non-tiled layers. */
  public setTileAntialiasing(enabled: boolean): void {
    this.tileAntialiasingEnabled = enabled;
    this.tiledView?.setAntialiased(enabled);
  }

  /** Temporarily display an undecorated filter result without changing store-owned pixels. */
  public setPreviewOverride(texture: Texture | null): void {
    if (this.destroyed || (!this.sprite && !this.tiledView)) return;
    this.previewOverride = texture;
    if (this.sprite) this.sprite.visible = !texture;
    if (this.tiledView) this.tiledView.container.visible = !texture;
    if (texture) {
      if (this.previewSprite) {
        this.previewSprite.texture = texture;
      } else {
        this.previewSprite = new Sprite({
          texture,
          label: `preview:${this.id}`,
        });
        this.container.addChild(this.previewSprite);
      }
      this.container.filters = null;
      this.tiledView?.setFilters(null);
      return;
    }
    this.previewSprite?.removeFromParent();
    this.previewSprite?.destroy({ texture: false, textureSource: false });
    this.previewSprite = null;
    if (this.lastLayer) this.applyDisplayTreatment(this.lastLayer);
  }

  /**
   * Free this node's own GPU objects.
   *
   * Deliberately does NOT use `destroy({ children: true })`: for a group, the
   * container's children are OTHER nodes' containers, which `LayerTree`
   * destroys individually. Recursing here would double-destroy them. The
   * texture is left alone -- `LayerStore` owns texture lifetimes.
   */
  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    this.container.removeChildren();
    this.container.filters = null;
    this.previewOverride = null;
    this.lastLayer = null;
    this.texture = null;
    this.previewSprite?.destroy({ texture: false, textureSource: false });
    this.previewSprite = null;
    this.tiledView?.destroy();
    this.tiledView = null;
    this.sprite?.destroy({ texture: false, textureSource: false });
    this.sprite = null;
    this.maskHatchFilter?.destroy();
    this.maskHatchFilter = null;
    this.controlDisplayFilter?.destroy();
    this.controlDisplayFilter = null;
    this.container.destroy({ children: false });
  }

  public get isDestroyed(): boolean {
    return this.destroyed;
  }

  private setPersistentFilters(filters: readonly Filter[] | null): void {
    if (this.tiledView) {
      this.container.filters = null;
      this.tiledView.setFilters(filters);
      return;
    }
    this.container.filters = filters ? [...filters] : null;
  }
}

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
import type { Texture } from "pixi.js";

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

  private texture: Texture | null = null;

  private previewOverride: Texture | null = null;

  private lastLayer: Layer | null = null;

  private maskHatchFilter: MaskHatchFilter | null = null;

  private controlDisplayFilter: ControlLayerDisplayFilter | null = null;

  private destroyed = false;

  constructor(layer: Layer, texture?: Texture) {
    this.id = layer.id;
    this.kind = layer.kind;

    this.container = new Container({ label: `layer:${layer.id}` });

    switch (layer.kind) {
      case "raster":
      case "mask":
      case "control":
        if (!texture) {
          throw new Error(
            `[ultra-paint] ${layer.kind} layer "${layer.id}" created without a texture`,
          );
        }
        this.sprite = new Sprite({
          texture,
          label: `sprite:${layer.id}`,
        });
        this.texture = texture;
        this.container.addChild(this.sprite);
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
        // Filter the owning container so temporary live-preview siblings
        // inherit the same mask display treatment as the persistent sprite.
        // Reassign after a preview override temporarily cleared the list.
        c.filters = [this.maskHatchFilter];
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
        c.filters = [this.controlDisplayFilter];
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
        c.filters = null;
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
    if (this.destroyed || !this.sprite) return;
    this.texture = texture;
    if (!this.previewOverride) this.sprite.texture = texture;
  }

  /** Temporarily display an undecorated filter result without changing store-owned pixels. */
  public setPreviewOverride(texture: Texture | null): void {
    if (this.destroyed || !this.sprite) return;
    this.previewOverride = texture;
    if (texture) {
      this.sprite.texture = texture;
      this.container.filters = null;
      return;
    }
    if (this.texture) this.sprite.texture = this.texture;
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
    this.maskHatchFilter?.destroy();
    this.maskHatchFilter = null;
    this.controlDisplayFilter?.destroy();
    this.controlDisplayFilter = null;
    this.previewOverride = null;
    this.lastLayer = null;
    this.texture = null;
    this.sprite?.destroy({ texture: false, textureSource: false });
    this.sprite = null;
    this.container.destroy({ children: false });
  }

  public get isDestroyed(): boolean {
    return this.destroyed;
  }
}

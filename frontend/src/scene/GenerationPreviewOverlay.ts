/**
 * Shows the currently selected, unapplied generation preview as a sprite
 * over the document, matching the boundary box. While a preview is shown,
 * the boundary box guide is hidden. As long as a preview is *selected*
 * (whether currently shown or toggled off for an A/B look at the canvas),
 * every mask/control layer stays hidden too -- each layer's own `visible`
 * flag is left untouched and only restored once the preview is discarded
 * or applied (see `setGuideLayersHidden`). This same pass also enforces the
 * standalone "hide all masks" toggle (`LayerStore.masksHidden`), which
 * stays in effect regardless of preview.
 */

import { Container, Sprite, Texture } from "pixi.js";

import type { BoundaryBoxOverlay } from "./BoundaryBoxOverlay";
import type { LayerTree } from "./LayerTree";
import type { LayerStore, Unsubscribe } from "../state/layerStore.svelte";
import { previewStore, type PreviewUnsubscribe } from "../state/previewStore.svelte";

export class GenerationPreviewOverlay {
  public readonly container = new Container({ label: "ultra-paint:generation-preview" });

  private readonly sprite = new Sprite();

  private readonly textureCache = new Map<string, Texture>();

  private unsubscribeStore: Unsubscribe | null = null;

  private unsubscribePreview: PreviewUnsubscribe | null = null;

  private loadToken = 0;

  public constructor(
    private readonly store: LayerStore,
    private readonly tree: LayerTree,
    private readonly boundaryBoxOverlay: BoundaryBoxOverlay,
  ) {
    this.container.eventMode = "none";
    this.container.visible = false;
    this.container.addChild(this.sprite);
    // Registered after LayerTree's own store subscription (LayerTree is
    // constructed first), so mask visibility forced here on each doc
    // change is applied after -- not clobbered by -- the tree's reconcile.
    this.unsubscribeStore = store.subscribe(() => this.applyState());
    this.unsubscribePreview = previewStore.subscribe(() => this.applyState());
    this.applyState();
  }

  public destroy(): void {
    this.unsubscribeStore?.();
    this.unsubscribeStore = null;
    this.unsubscribePreview?.();
    this.unsubscribePreview = null;
    this.setGuideLayersHidden(false);
    this.boundaryBoxOverlay.container.visible = true;
    for (const texture of this.textureCache.values()) texture.destroy(true);
    this.textureCache.clear();
    this.container.destroy({ children: true });
  }

  private applyState(): void {
    const preview = previewStore.selected;
    // Guide layers stay hidden for the whole review (toggling the preview
    // off to compare against the canvas shouldn't pop masks back in) --
    // only restored once the preview is discarded or applied.
    const pending = preview !== null;
    const active = pending && previewStore.visible;

    this.setGuideLayersHidden(pending);
    this.boundaryBoxOverlay.container.visible = !active;
    this.evictStaleTextures();

    if (!active || !preview) {
      this.container.visible = false;
      return;
    }

    this.container.visible = true;
    this.positionToBoundaryBox();
    void this.loadTexture(preview.id, preview.dataUrl);
  }

  /**
   * Sizing the sprite against Pixi's 1x1 placeholder texture (before the
   * real preview texture loads) would scale it up ~1000x, and that scale
   * sticks around after the real texture is assigned (`.texture` doesn't
   * touch `.scale`). Only size once a real texture is in place, and redo it
   * every time one loads.
   */
  private positionToBoundaryBox(): void {
    const box = this.store.getDocument().boundaryBox;
    this.container.position.set(box.x, box.y);
    if (this.sprite.texture !== Texture.EMPTY) {
      this.sprite.width = box.width;
      this.sprite.height = box.height;
    }
  }

  /** Force mask/control containers hidden while `previewPending` (a
   * generation is selected for review, shown or not), or while
   * `LayerStore.masksHidden` is set (masks only) -- without touching the
   * layer's own `visible` flag, so it's restored exactly as it was once
   * neither condition applies. */
  private setGuideLayersHidden(previewPending: boolean): void {
    for (const layer of this.store.getDocument().layers) {
      if (layer.kind !== "mask" && layer.kind !== "control") continue;
      const node = this.tree.getNode(layer.id);
      if (!node) continue;
      const forcedHidden =
        previewPending || (layer.kind === "mask" && this.store.masksHidden);
      node.container.visible = forcedHidden ? false : layer.visible;
    }
  }

  private evictStaleTextures(): void {
    const live = new Set(previewStore.previews.map((preview) => preview.id));
    for (const [id, texture] of this.textureCache) {
      if (live.has(id)) continue;
      // The sprite can still be pointing at this texture (e.g. right after
      // `discardAll()` clears every preview while this one was on screen).
      // Destroying it out from under the sprite leaves `sprite.texture`
      // referencing a Texture whose `.source` is now null -- the next
      // render throws mid-frame and permanently stalls Pixi's ticker,
      // since it only reschedules the next `requestAnimationFrame` after
      // a clean `update()` (see Ticker._tick).
      if (this.sprite.texture === texture) this.sprite.texture = Texture.EMPTY;
      texture.destroy(true);
      this.textureCache.delete(id);
    }
  }

  private async loadTexture(id: string, dataUrl: string): Promise<void> {
    const token = ++this.loadToken;
    let texture = this.textureCache.get(id);
    if (!texture) {
      const response = await fetch(dataUrl);
      const blob = await response.blob();
      const bitmap = await createImageBitmap(blob);
      texture = Texture.from(bitmap, true);
      this.textureCache.set(id, texture);
    }
    if (token !== this.loadToken || previewStore.selected?.id !== id) return;
    this.sprite.texture = texture;
    this.positionToBoundaryBox();
  }
}

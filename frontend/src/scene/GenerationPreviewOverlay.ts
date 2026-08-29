/**
 * Shows the currently selected, unapplied generation preview as a sprite
 * over the document, matching the boundary box. While a preview is shown,
 * the boundary box guide is hidden. As long as a preview is *selected*
 * (whether currently shown or toggled off for an A/B look at the canvas),
 * every mask/control layer stays hidden too -- each layer's own `visible`
 * flag is left untouched and only restored once the preview is discarded
 * or applied (see `setGuideLayersHidden`). This same pass also enforces the
 * standalone "hide all masks"/"hide all layers" toggles
 * (`LayerStore.masksHidden`/`layersHidden`), which stay in effect
 * regardless of preview.
 */

import { Container, Sprite, Texture } from "pixi.js";

import type { BoundaryBoxOverlay } from "./BoundaryBoxOverlay";
import type { LayerTree } from "./LayerTree";
import type { LayerStore, Unsubscribe } from "../state/layerStore.svelte";
import {
  generationRuntimeStore,
  type GenerationRuntimeUnsubscribe,
} from "../state/generationRuntimeStore.svelte";
import { previewStore, type PreviewUnsubscribe } from "../state/previewStore.svelte";

export class GenerationPreviewOverlay {
  public readonly container = new Container({ label: "ultra-paint:generation-preview" });

  private readonly sprite = new Sprite();

  private readonly textureCache = new Map<string, Texture>();

  private unsubscribeStore: Unsubscribe | null = null;

  private unsubscribePreview: PreviewUnsubscribe | null = null;

  private unsubscribeRuntime: GenerationRuntimeUnsubscribe | null = null;

  private loadToken = 0;

  // Live mid-generation preview: swapped out on every progress poll, so it
  // gets its own single-slot cache rather than `textureCache` (which is
  // keyed by stable preview id and evicted by set membership).
  private liveTexture: Texture | null = null;

  private liveDataUrl: string | null = null;

  private liveLoadToken = 0;

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
    this.unsubscribeRuntime = generationRuntimeStore.subscribe(() => this.applyState());
    this.applyState();
  }

  public destroy(): void {
    this.unsubscribeStore?.();
    this.unsubscribeStore = null;
    this.unsubscribePreview?.();
    this.unsubscribePreview = null;
    this.unsubscribeRuntime?.();
    this.unsubscribeRuntime = null;
    this.setGuideLayersHidden(false);
    this.boundaryBoxOverlay.container.visible = true;
    for (const texture of this.textureCache.values()) texture.destroy(true);
    this.textureCache.clear();
    this.liveTexture?.destroy(true);
    this.liveTexture = null;
    this.container.destroy({ children: true });
  }

  private applyState(): void {
    // A live sampling frame takes priority over a completed-but-unapplied
    // preview: once a job is running there's nothing left to compare the old
    // preview against, and the whole point is to watch this one cook.
    const liveImage =
      generationRuntimeStore.generating && generationRuntimeStore.progress?.current_image
        ? generationRuntimeStore.progress.current_image
        : null;
    const preview = liveImage ? null : previewStore.selected;

    // Guide layers stay hidden for the whole review (toggling the preview
    // off to compare against the canvas shouldn't pop masks back in) --
    // only restored once the preview is discarded or applied.
    const pending = liveImage !== null || preview !== null;
    const active = liveImage !== null || (preview !== null && previewStore.visible);

    this.setGuideLayersHidden(pending);
    // Hidden for the whole review (not just while actively shown): an
    // Upscale preview's own size can differ from the boundary box, so the
    // box would otherwise sit in the way -- misleadingly framing the old
    // size -- even while the preview is toggled off for an A/B look.
    this.boundaryBoxOverlay.container.visible = !pending;
    this.evictStaleTextures();

    if (!liveImage && this.liveTexture) {
      // Job ended (or hasn't produced its first frame yet) -- free the live
      // texture now rather than leaning on the next job's swap-and-destroy.
      if (this.sprite.texture === this.liveTexture) this.sprite.texture = Texture.EMPTY;
      this.liveTexture.destroy(true);
      this.liveTexture = null;
      this.liveDataUrl = null;
    }

    if (!active) {
      this.container.visible = false;
      return;
    }

    this.container.visible = true;
    this.positionToBoundaryBox(liveImage !== null);
    if (liveImage) {
      void this.loadLiveTexture(liveImage);
    } else if (preview) {
      void this.loadTexture(preview.id, preview.dataUrl);
    }
  }

  /**
   * Sizing the sprite against Pixi's 1x1 placeholder texture (before the
   * real preview texture loads) would scale it up ~1000x, and that scale
   * sticks around after the real texture is assigned (`.texture` doesn't
   * touch `.scale`). Only size once a real texture is in place, and redo it
   * every time one loads.
   *
   * Sized to the texture's own native dimensions, not the boundary box --
   * an ordinary generation always returns an image the same size as the box
   * (`generation.py` resizes back to canvas size), but Upscale intentionally
   * doesn't, and this sprite is the only preview of that result before
   * Apply creates the real, differently-sized layer.
   *
   * A live sampling frame is the exception: Forge's live-preview decode runs
   * at the *latent* resolution (roughly 1/8 the target), not the canvas
   * size, so it's stretched to fill the boundary box instead -- a plain GPU
   * stretch (`loadLiveTexture` sets nearest-neighbor sampling), no
   * server-side resampling needed for a preview that's replaced every poll.
   */
  private positionToBoundaryBox(stretchToBox = false): void {
    const box = this.store.getDocument().boundaryBox;
    this.container.position.set(box.x, box.y);
    if (this.sprite.texture === Texture.EMPTY) return;
    if (stretchToBox) {
      this.sprite.width = box.width;
      this.sprite.height = box.height;
    } else {
      this.sprite.width = this.sprite.texture.width;
      this.sprite.height = this.sprite.texture.height;
    }
  }

  /** Force layer containers hidden while `previewPending` (a generation is
   * selected for review, shown or not) -- mask/control layers only -- or
   * while `LayerStore.masksHidden`/`layersHidden` is set (masks or regular
   * layers respectively) -- without touching the layer's own `visible`
   * flag, so it's restored exactly as it was once neither condition
   * applies. */
  private setGuideLayersHidden(previewPending: boolean): void {
    for (const layer of this.store.getDocument().layers) {
      const node = this.tree.getNode(layer.id);
      if (!node) continue;
      const forcedHidden =
        (previewPending && (layer.kind === "mask" || layer.kind === "control")) ||
        (layer.kind === "mask" && this.store.masksHidden) ||
        (layer.kind === "control" && this.store.controlsHidden) ||
        (layer.kind !== "mask" && layer.kind !== "control" && this.store.layersHidden);
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

  /**
   * Progress is polled every `POLL_INTERVAL_MS` (generationController.svelte.ts)
   * regardless of Forge's own "every N steps" live-preview cadence, so most
   * polls repeat the same data URL -- skip re-decoding when it hasn't moved.
   */
  private async loadLiveTexture(dataUrl: string): Promise<void> {
    if (dataUrl === this.liveDataUrl) return;
    this.liveDataUrl = dataUrl;
    const token = ++this.liveLoadToken;

    const response = await fetch(dataUrl);
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);
    const texture = Texture.from(bitmap, true);
    // Forge decodes the live preview at latent resolution (~1/8 the target),
    // then this sprite is stretched up to the boundary box -- nearest
    // sampling keeps that stretch a crisp, blocky "pixels, but bigger"
    // rather than a blurred bilinear smear.
    texture.source.scaleMode = "nearest";

    if (token !== this.liveLoadToken || dataUrl !== this.liveDataUrl) {
      texture.destroy(true);
      return;
    }
    const previous = this.liveTexture;
    this.liveTexture = texture;
    this.sprite.texture = texture;
    this.positionToBoundaryBox(true);
    // Same torn-frame hazard as `evictStaleTextures` -- only destroy the old
    // one once the sprite has moved off it.
    previous?.destroy(true);
  }
}

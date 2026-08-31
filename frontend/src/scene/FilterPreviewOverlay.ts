/** Bridges one pending filter preview into its existing layer scene node. */

import { Texture } from "pixi.js";

import type { LayerStore } from "../state/layerStore.svelte";
import { filterStore, type FilterUnsubscribe } from "../state/filterStore.svelte";
import type { LayerId } from "../state/schema";
import type { LayerTree } from "./LayerTree";

export class FilterPreviewOverlay {
  private readonly textureCache = new Map<string, Texture>();

  private readonly textureLoads = new Map<string, Promise<Texture>>();

  private readonly unsubscribe: FilterUnsubscribe;

  private readonly unsubscribeStore: () => void;

  private overrideLayerId: LayerId | null = null;

  private overrideKey: string | null = null;

  private loadToken = 0;

  private destroyed = false;

  public constructor(
    private readonly store: LayerStore,
    private readonly tree: LayerTree,
  ) {
    this.unsubscribe = filterStore.subscribe(() => this.applyState());
    this.unsubscribeStore = store.subscribe(() => this.applyState());
    this.applyState();
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.loadToken += 1;
    this.unsubscribe();
    this.unsubscribeStore();
    this.clearOverride();
    for (const texture of this.textureCache.values()) texture.destroy(true);
    this.textureCache.clear();
  }

  private applyState(): void {
    const layerId = filterStore.targetLayerId;
    const dataUrl = filterStore.previewDataUrl;
    const layer = layerId ? this.store.getLayer(layerId) : undefined;

    if (layerId && !layer) {
      filterStore.cancel();
      return;
    }

    this.loadToken += 1;
    if (!layerId || !dataUrl || layer?.kind !== "control") {
      this.clearOverride();
      this.evictStaleTextures(null);
      return;
    }

    if (this.overrideLayerId !== null && this.overrideLayerId !== layerId) {
      this.clearOverride();
    }

    const key = this.cacheKey(layerId, dataUrl);
    this.evictStaleTextures(key);
    void this.loadTexture(layerId, dataUrl, key, this.loadToken);
  }

  private clearOverride(): void {
    if (this.overrideLayerId !== null) {
      this.tree.getNode(this.overrideLayerId)?.setPreviewOverride(null);
    }
    this.overrideLayerId = null;
    this.overrideKey = null;
  }

  private evictStaleTextures(liveKey: string | null): void {
    for (const [key, texture] of this.textureCache) {
      if (key === liveKey || key === this.overrideKey) continue;
      texture.destroy(true);
      this.textureCache.delete(key);
    }
  }

  private async loadTexture(
    layerId: LayerId,
    dataUrl: string,
    key: string,
    token: number,
  ): Promise<void> {
    let texture = this.textureCache.get(key);
    try {
      if (!texture) {
        texture = await this.loadTextureOnce(key, dataUrl);
      }

      if (
        token !== this.loadToken ||
        filterStore.targetLayerId !== layerId ||
        filterStore.previewDataUrl !== dataUrl
      ) {
        this.evictStaleTextures(this.currentKey());
        return;
      }

      const node = this.tree.getNode(layerId);
      if (!node) return;
      node.setPreviewOverride(texture);
      this.overrideLayerId = layerId;
      this.overrideKey = key;
      this.evictStaleTextures(key);
    } catch (error) {
      if (!this.destroyed) {
        console.warn("[ultra-paint] filter preview texture decode failed:", error);
      }
    }
  }

  private loadTextureOnce(key: string, dataUrl: string): Promise<Texture> {
    const existing = this.textureLoads.get(key);
    if (existing) return existing;

    const load = (async () => {
      const response = await fetch(dataUrl);
      const blob = await response.blob();
      const bitmap = await createImageBitmap(blob);
      const texture = Texture.from(bitmap, true);
      if (this.destroyed) {
        texture.destroy(true);
        throw new Error("[ultra-paint] filter preview overlay was destroyed during decode");
      }
      this.textureCache.set(key, texture);
      return texture;
    })().finally(() => {
      this.textureLoads.delete(key);
    });
    this.textureLoads.set(key, load);
    return load;
  }

  private currentKey(): string | null {
    const layerId = filterStore.targetLayerId;
    const dataUrl = filterStore.previewDataUrl;
    return layerId && dataUrl ? this.cacheKey(layerId, dataUrl) : null;
  }

  private cacheKey(layerId: LayerId, dataUrl: string): string {
    return `${layerId}\u0000${dataUrl}`;
  }
}

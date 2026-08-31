import type { Application, Container } from "pixi.js";

import type { LayerTree } from "../scene/LayerTree";
import type { LayerStore } from "../state/layerStore.svelte";
import type { BrushSettings } from "../state/paintToolStore.svelte";
import type { LayerId } from "../state/schema";
import { ConsistentOpacityStroke } from "./ConsistentOpacityStroke";
import type { StrokeSession } from "./StrokeController";
import type { TileEditRecorder } from "./TiledConsistentOpacityStroke";
import { TiledConsistentOpacityStroke } from "./TiledConsistentOpacityStroke";

/** Creates brush-specific consumers for the shared stroke-capture pipeline. */
export class BrushEngine {
  constructor(
    private readonly app: Application,
    private readonly documentRoot: Container,
    private readonly tree: LayerTree,
    private readonly store: LayerStore,
    private readonly history: TileEditRecorder,
  ) {}

  /** Begin painting into `layerId`, snapshotting settings for this stroke. */
  public beginStroke(layerId: LayerId, settings: Readonly<BrushSettings>): StrokeSession | null {
    const node = this.tree.getNode(layerId);
    const layer = this.store.getLayer(layerId);
    if (
      !node ||
      !layer ||
      (node.kind !== "raster" && node.kind !== "mask" && node.kind !== "control")
    ) {
      return null;
    }

    const texture = this.store.getTexture(layerId);
    if (texture) {
      return new ConsistentOpacityStroke(
        this.app,
        this.documentRoot,
        node.container,
        this.store,
        layerId,
        texture,
        settings,
        {
          color: settings.color,
          commitBlendMode: "normal",
          livePreview: "overlay",
          allowGrowth: true,
          preserveAlpha: layer.preserveAlpha,
          setPreviewTexture: (previewTexture) => node.setTexture(previewTexture),
        },
      );
    }

    const surface = this.store.getTiledSurface(layerId);
    if (!surface) return null;
    return new TiledConsistentOpacityStroke(
      this.app,
      this.documentRoot,
      node,
      this.store,
      this.history,
      layerId,
      surface,
      settings,
      { mode: "brush", color: settings.color, preserveAlpha: layer.preserveAlpha },
    );
  }
}

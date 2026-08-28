import type { Application, Container } from "pixi.js";

import type { LayerTree } from "../scene/LayerTree";
import type { LayerStore } from "../state/layerStore.svelte";
import type { BrushSettings } from "../state/paintToolStore.svelte";
import type { LayerId } from "../state/schema";
import { ConsistentOpacityStroke } from "./ConsistentOpacityStroke";
import type { StrokeSession } from "./StrokeController";

/** Creates brush-specific consumers for the shared stroke-capture pipeline. */
export class BrushEngine {
  constructor(
    private readonly app: Application,
    private readonly documentRoot: Container,
    private readonly tree: LayerTree,
    private readonly store: LayerStore,
  ) {}

  /** Begin painting into `layerId`, snapshotting settings for this stroke. */
  public beginStroke(layerId: LayerId, settings: Readonly<BrushSettings>): StrokeSession | null {
    const texture = this.store.getTexture(layerId);
    const node = this.tree.getNode(layerId);
    const layer = this.store.getLayer(layerId);
    if (
      !texture ||
      !node ||
      !layer ||
      (node.kind !== "raster" && node.kind !== "mask" && node.kind !== "control")
    ) {
      return null;
    }

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
}

import type { Application, Container } from "pixi.js";

import type { LayerTree } from "../scene/LayerTree";
import type { LayerStore } from "../state/layerStore.svelte";
import type { BrushSettings } from "../state/paintToolStore.svelte";
import type { LayerId } from "../state/schema";
import type { StrokeSession } from "./StrokeController";
import type { TileEditRecorder } from "./TiledConsistentOpacityStroke";
import { TiledConsistentOpacityStroke } from "./TiledConsistentOpacityStroke";

/** Creates eraser-specific consumers for the shared stroke-capture pipeline. */
export class EraserEngine {
  constructor(
    private readonly app: Application,
    private readonly documentRoot: Container,
    private readonly tree: LayerTree,
    private readonly store: LayerStore,
    private readonly history: TileEditRecorder,
  ) {}

  /** Begin erasing from `layerId`, snapshotting settings for this stroke. */
  public beginStroke(layerId: LayerId, settings: Readonly<BrushSettings>): StrokeSession | null {
    const node = this.tree.getNode(layerId);
    if (!node || (node.kind !== "raster" && node.kind !== "mask" && node.kind !== "control")) {
      return null;
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
      { mode: "eraser", color: "#ffffff", preserveAlpha: false },
    );
  }
}

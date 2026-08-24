import type { Application, Container } from "pixi.js";

import type { LayerTree } from "../scene/LayerTree";
import type { LayerStore } from "../state/layerStore.svelte";
import type { BrushSettings } from "../state/paintToolStore.svelte";
import type { LayerId } from "../state/schema";
import { ConsistentOpacityStroke } from "./ConsistentOpacityStroke";
import type { StrokeSession } from "./StrokeController";

/** Creates eraser-specific consumers for the shared stroke-capture pipeline. */
export class EraserEngine {
    constructor(
        private readonly app: Application,
        private readonly documentRoot: Container,
        private readonly tree: LayerTree,
        private readonly store: LayerStore,
    ) {}

    /** Begin erasing from `layerId`, snapshotting settings for this stroke. */
    public beginStroke(
        layerId: LayerId,
        settings: Readonly<BrushSettings>,
    ): StrokeSession | null {
        const texture = this.store.getTexture(layerId);
        const node = this.tree.getNode(layerId);
        if (
            !texture ||
            !node ||
            (node.kind !== "raster" && node.kind !== "mask")
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
                color: "#ffffff",
                commitBlendMode: "erase",
                livePreview: "replace-layer-texture",
                setPreviewTexture: (previewTexture) =>
                    node.setTexture(previewTexture),
            },
        );
    }
}

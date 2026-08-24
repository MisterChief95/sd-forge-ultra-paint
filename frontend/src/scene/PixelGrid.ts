/** Lightweight document-space pixel grid rendered below all layer content. */

import { Container, Graphics } from "pixi.js";

const ZOOMED_IN_SPACING = 8;
const DEFAULT_SPACING = 32;
const ZOOMED_OUT_SPACING = 64;
const ZOOMED_IN_THRESHOLD = 2;
const ZOOMED_OUT_THRESHOLD = 1.5;
const GRID_HALF_LINE_COUNT = 1024;

export class PixelGrid {
    public readonly container = new Container({ label: "ultra-paint:pixel-grid" });

    private readonly lines = new Graphics();
    private spacing: number;

    public constructor(
        private readonly documentRoot: Container,
        // Retain the ignored rest parameter temporarily so existing construction
        // sites remain source-compatible while the grid no longer depends on state.
        ..._unused: unknown[]
    ) {
        this.container.addChild(this.lines);
        this.spacing = this.spacingForZoom();
        this.redraw(this.spacing);
        this.container.onRender = () => {
            const nextSpacing = this.spacingForZoom();
            if (nextSpacing === this.spacing) return;

            this.spacing = nextSpacing;
            this.redraw(nextSpacing);
        };
    }

    public destroy(): void {
        this.container.onRender = null;
        this.container.destroy({ children: true });
    }

    /** Show or hide the grid without changing its zoom-tier state. */
    public setVisible(visible: boolean): void {
        this.container.visible = visible;
    }

    /** Whether the grid is currently rendered. */
    public isVisible(): boolean {
        return this.container.visible;
    }

    private redraw(spacing: number): void {
        // Keep a generously large grid around the document origin. Its extent is
        // proportional to the active spacing, so every zoom tier draws only a
        // bounded number of lines while covering a large on-screen area.
        const extent = GRID_HALF_LINE_COUNT * spacing;

        this.lines.clear();
        for (let x = -extent; x <= extent; x += spacing) {
            this.lines.moveTo(x, -extent).lineTo(x, extent);
        }
        for (let y = -extent; y <= extent; y += spacing) {
            this.lines.moveTo(-extent, y).lineTo(extent, y);
        }
        this.lines.stroke({ width: 1, color: 0x5b8def, alpha: 0.12 });
    }

    private spacingForZoom(): number {
        const zoom = this.worldScale();
        if (zoom >= ZOOMED_IN_THRESHOLD) return ZOOMED_IN_SPACING;
        if (zoom >= ZOOMED_OUT_THRESHOLD) return DEFAULT_SPACING;
        return ZOOMED_OUT_SPACING;
    }

    private worldScale(): number {
        return Math.max(0.0001, this.documentRoot.parent?.scale.x ?? 1);
    }
}

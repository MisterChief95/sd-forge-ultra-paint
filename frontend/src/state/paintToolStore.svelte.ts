/**
 * Rune-backed paint settings with a dual API: Svelte consumers read reactive
 * getters, while the existing stroke pipeline can keep subscribe(). Listeners
 * are notifications over the same $state object, never a second copy of state.
 */

/** Available paint-canvas tools. Only brush and eraser create stroke sessions. */
export type PaintTool = "brush" | "eraser" | "boundary-box";

export interface BrushSettings {
    /** Brush radius in document pixels. */
    radius: number;
    /** Fully opaque core, from 0 (none) to 1 (the full radius). */
    hardness: number;
    /** CSS hex color. Alpha is stored separately in {@link opacity}. */
    color: string;
    /** Per-stamp alpha from 0 to 1, independent of layer opacity. */
    opacity: number;
}

export interface PaintToolState {
    activeTool: PaintTool;
    brush: BrushSettings;
    /** Captured boundary-box width/height ratio, or null when unlocked. */
    boundaryAspectRatio: number | null;
}

export type PaintToolListener = (state: Readonly<PaintToolState>) => void;
export type PaintToolUnsubscribe = () => void;

const DEFAULT_STATE: PaintToolState = {
    activeTool: "brush",
    boundaryAspectRatio: null,
    brush: {
        radius: 20,
        hardness: 0.75,
        color: "#ffffff",
        opacity: 1,
    },
};

export class PaintToolStore {
    /** Deep reactive because this object contains serializable plain data only. */
    private _state = $state<PaintToolState>({
        ...DEFAULT_STATE,
        brush: { ...DEFAULT_STATE.brush },
    });

    private readonly listeners = new Set<PaintToolListener>();

    /** Reactive state getter for Svelte consumers. Treat as immutable. */
    public get state(): Readonly<PaintToolState> {
        return this._state;
    }

    /** Convenience reactive getter for tool-selection controls. */
    public get activeTool(): PaintTool {
        return this._state.activeTool;
    }

    /** Convenience reactive getter for brush controls. */
    public get brush(): Readonly<BrushSettings> {
        return this._state.brush;
    }

    /** Ratio captured when the boundary-box aspect lock was enabled. */
    public get boundaryAspectRatio(): number | null {
        return this._state.boundaryAspectRatio;
    }

    /** Legacy method form retained for non-Svelte consumers. */
    public getState(): Readonly<PaintToolState> {
        return this._state;
    }

    public setActiveTool(activeTool: PaintTool): void {
        if (this._state.activeTool === activeTool) return;
        this._state.activeTool = activeTool;
        this.emit();
    }

    public setBoundaryAspectRatio(ratio: number | null): void {
        const next =
            ratio !== null && Number.isFinite(ratio) && ratio > 0
                ? ratio
                : null;
        if (this._state.boundaryAspectRatio === next) return;
        this._state.boundaryAspectRatio = next;
        this.emit();
    }

    /** Patch brush settings, clamping numeric values to their supported range. */
    public setBrushSettings(patch: Partial<BrushSettings>): void {
        const current = this._state.brush;
        const next: BrushSettings = {
            radius:
                patch.radius === undefined
                    ? current.radius
                    : Math.max(1, Math.min(512, patch.radius)),
            hardness:
                patch.hardness === undefined
                    ? current.hardness
                    : Math.max(0, Math.min(1, patch.hardness)),
            color:
                patch.color === undefined || !/^#[0-9a-f]{6}$/i.test(patch.color)
                    ? current.color
                    : patch.color.toLowerCase(),
            opacity:
                patch.opacity === undefined
                    ? current.opacity
                    : Math.max(0, Math.min(1, patch.opacity)),
        };

        if (
            next.radius === current.radius &&
            next.hardness === current.hardness &&
            next.color === current.color &&
            next.opacity === current.opacity
        ) {
            return;
        }

        this._state.brush = next;
        this.emit();
    }

    /** Subscribe to tool-setting changes. Returns an unsubscribe function. */
    public subscribe(fn: PaintToolListener): PaintToolUnsubscribe {
        this.listeners.add(fn);
        return () => {
            this.listeners.delete(fn);
        };
    }

    private emit(): void {
        for (const fn of [...this.listeners]) {
            fn(this._state);
        }
    }
}

/** Shared default instance used by the app and Svelte UI. */
export const paintToolStore = new PaintToolStore();

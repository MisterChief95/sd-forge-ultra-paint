export type ScaleMode = "none" | "auto" | "manual";

export interface GenerationSettings {
    scaleMode: ScaleMode;
    manualWidth: number;
    manualHeight: number;
    maskBlur: number;
    inpaintPadding: number;
    softInpaintingEnabled: boolean;
}

const DEFAULT_SETTINGS: GenerationSettings = {
    scaleMode: "none",
    manualWidth: 1024,
    manualHeight: 1024,
    maskBlur: 4,
    inpaintPadding: 32,
    softInpaintingEnabled: false,
};

export class GenerationSettingsStore {
    private _state = $state<GenerationSettings>({ ...DEFAULT_SETTINGS });

    public get scaleMode(): ScaleMode {
        return this._state.scaleMode;
    }

    public get manualWidth(): number {
        return this._state.manualWidth;
    }

    public get manualHeight(): number {
        return this._state.manualHeight;
    }

    public get maskBlur(): number {
        return this._state.maskBlur;
    }

    public get inpaintPadding(): number {
        return this._state.inpaintPadding;
    }

    public get softInpaintingEnabled(): boolean {
        return this._state.softInpaintingEnabled;
    }

    public setScaleMode(scaleMode: ScaleMode): void {
        this._state.scaleMode = scaleMode;
    }

    public setManualWidth(width: number): void {
        this._state.manualWidth = normaliseManualDimension(
            width,
            this._state.manualWidth,
        );
    }

    public setManualHeight(height: number): void {
        this._state.manualHeight = normaliseManualDimension(
            height,
            this._state.manualHeight,
        );
    }

    public setMaskBlur(value: number): void {
        this._state.maskBlur = normaliseRange(
            value,
            this._state.maskBlur,
            0,
            64,
        );
    }

    public setInpaintPadding(value: number): void {
        this._state.inpaintPadding = normaliseRange(
            value,
            this._state.inpaintPadding,
            0,
            256,
        );
    }

    public setSoftInpaintingEnabled(enabled: boolean): void {
        this._state.softInpaintingEnabled = enabled;
    }
}

function normaliseManualDimension(value: number, fallback: number): number {
    if (!Number.isFinite(value)) return fallback;
    return Math.max(1, Math.min(16384, Math.round(value)));
}

function normaliseRange(
    value: number,
    fallback: number,
    minimum: number,
    maximum: number,
): number {
    if (!Number.isFinite(value)) return fallback;
    return Math.max(minimum, Math.min(maximum, Math.round(value)));
}

export const generationSettingsStore = new GenerationSettingsStore();

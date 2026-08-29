export type ScaleMode = "none" | "auto" | "manual";
export type InpaintArea = "whole" | "masked" | "coherence";
/**
 * "random": send -1 every generation (backend rolls a fresh seed each time);
 * `seedValue` is display-only, refreshed from the response.
 * "reuse": send the frozen `seedValue` every generation, unchanged.
 * "manual": send the user-edited `seedValue` every generation, unchanged.
 */
export type SeedMode = "random" | "reuse" | "manual";

export interface GenerationSettings {
  scaleMode: ScaleMode;
  autoBaseWidth: number;
  manualWidth: number;
  manualHeight: number;
  maskBlur: number;
  inpaintPadding: number;
  inpaintArea: InpaintArea;
  softInpaintingEnabled: boolean;
  /**
   * Global inpaint ControlNet (e.g. Anima's LLLite Inpaint Adapter): most
   * models don't need this, but a few require their dedicated inpainting
   * ControlNet model rather than relying on `p.mask` alone. Reuses the
   * already-composited mask/init image as the unit's control input --
   * there is no per-layer setup because the composited mask layers already
   * are the mask this unit needs.
   */
  inpaintControlNetEnabled: boolean;
  /** ControlNet model filename, from `GET /controlnet/model_list`. */
  inpaintControlNetModel: string;
  /** ControlNet unit weight. Forge allows negative weights (inverted influence), hence -2..2. */
  inpaintControlNetWeight: number;
  /**
   * Coherence Pass (InvokeAI-style): width in pixels of the blend ring
   * straddling the mask boundary that gets a second, low-strength
   * denoising pass to smooth the seam. Only used when `inpaintArea` is
   * `"coherence"`.
   */
  coherenceEdgeSize: number;
  seedMode: SeedMode;
  /** The seed shown in the seed box and sent when `seedMode` isn't `"random"`. */
  seedValue: number;
}

const DEFAULT_SETTINGS: GenerationSettings = {
  scaleMode: "none",
  autoBaseWidth: 1024,
  manualWidth: 1024,
  manualHeight: 1024,
  maskBlur: 4,
  inpaintPadding: 32,
  inpaintArea: "coherence",
  softInpaintingEnabled: false,
  inpaintControlNetEnabled: false,
  inpaintControlNetModel: "",
  inpaintControlNetWeight: 1,
  coherenceEdgeSize: 32,
  seedMode: "random",
  seedValue: -1,
};

export class GenerationSettingsStore {
  private _state = $state<GenerationSettings>({ ...DEFAULT_SETTINGS });

  public get snapshot(): GenerationSettings {
    return $state.snapshot(this._state);
  }

  public restore(value: Record<string, unknown>): void {
    if (isScaleMode(value.scaleMode)) this.setScaleMode(value.scaleMode);
    if (typeof value.autoBaseWidth === "number") this.setAutoBaseWidth(value.autoBaseWidth);
    if (typeof value.manualWidth === "number") this.setManualWidth(value.manualWidth);
    if (typeof value.manualHeight === "number") this.setManualHeight(value.manualHeight);
    if (typeof value.maskBlur === "number") this.setMaskBlur(value.maskBlur);
    if (typeof value.inpaintPadding === "number") this.setInpaintPadding(value.inpaintPadding);
    if (isInpaintArea(value.inpaintArea)) this.setInpaintArea(value.inpaintArea);
    if (typeof value.softInpaintingEnabled === "boolean") {
      this.setSoftInpaintingEnabled(value.softInpaintingEnabled);
    }
    if (typeof value.inpaintControlNetEnabled === "boolean") {
      this.setInpaintControlNetEnabled(value.inpaintControlNetEnabled);
    }
    if (typeof value.inpaintControlNetModel === "string") {
      this.setInpaintControlNetModel(value.inpaintControlNetModel);
    }
    if (typeof value.inpaintControlNetWeight === "number") {
      this.setInpaintControlNetWeight(value.inpaintControlNetWeight);
    }
    if (typeof value.coherenceEdgeSize === "number") {
      this.setCoherenceEdgeSize(value.coherenceEdgeSize);
    }
    if (isSeedMode(value.seedMode)) this.setSeedMode(value.seedMode);
    if (typeof value.seedValue === "number") this.setSeedValue(value.seedValue);
  }

  public get scaleMode(): ScaleMode {
    return this._state.scaleMode;
  }

  public get manualWidth(): number {
    return this._state.manualWidth;
  }

  public get autoBaseWidth(): number {
    return this._state.autoBaseWidth;
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

  public get inpaintArea(): InpaintArea {
    return this._state.inpaintArea;
  }

  public get softInpaintingEnabled(): boolean {
    return this._state.softInpaintingEnabled;
  }

  public setScaleMode(scaleMode: ScaleMode): void {
    this._state.scaleMode = scaleMode;
  }

  public setAutoBaseWidth(width: number): void {
    this._state.autoBaseWidth = normaliseRange(width, this._state.autoBaseWidth, 512, 2048);
  }

  public setManualWidth(width: number): void {
    this._state.manualWidth = normaliseManualDimension(width, this._state.manualWidth);
  }

  public setManualHeight(height: number): void {
    this._state.manualHeight = normaliseManualDimension(height, this._state.manualHeight);
  }

  public setMaskBlur(value: number): void {
    this._state.maskBlur = normaliseRange(value, this._state.maskBlur, 0, 64);
  }

  public setInpaintPadding(value: number): void {
    this._state.inpaintPadding = normaliseRange(value, this._state.inpaintPadding, 0, 256);
  }

  public setInpaintArea(inpaintArea: InpaintArea): void {
    this._state.inpaintArea = inpaintArea;
  }

  public setSoftInpaintingEnabled(enabled: boolean): void {
    this._state.softInpaintingEnabled = enabled;
  }

  public get inpaintControlNetEnabled(): boolean {
    return this._state.inpaintControlNetEnabled;
  }

  public get inpaintControlNetModel(): string {
    return this._state.inpaintControlNetModel;
  }

  public setInpaintControlNetEnabled(enabled: boolean): void {
    this._state.inpaintControlNetEnabled = enabled;
  }

  public setInpaintControlNetModel(model: string): void {
    this._state.inpaintControlNetModel = model;
  }

  public get inpaintControlNetWeight(): number {
    return this._state.inpaintControlNetWeight;
  }

  public setInpaintControlNetWeight(weight: number): void {
    if (!Number.isFinite(weight)) return;
    this._state.inpaintControlNetWeight = Math.max(-2, Math.min(2, weight));
  }

  public get coherenceEdgeSize(): number {
    return this._state.coherenceEdgeSize;
  }

  public setCoherenceEdgeSize(value: number): void {
    this._state.coherenceEdgeSize = normaliseRange(value, this._state.coherenceEdgeSize, 0, 256);
  }

  public get seedMode(): SeedMode {
    return this._state.seedMode;
  }

  public setSeedMode(mode: SeedMode): void {
    this._state.seedMode = mode;
  }

  public get seedValue(): number {
    return this._state.seedValue;
  }

  public setSeedValue(value: number): void {
    if (!Number.isFinite(value)) return;
    this._state.seedValue = Math.trunc(value);
  }
}

function normaliseManualDimension(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(16384, Math.round(value)));
}

function normaliseRange(value: number, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}

function isScaleMode(value: unknown): value is ScaleMode {
  return value === "none" || value === "auto" || value === "manual";
}

function isInpaintArea(value: unknown): value is InpaintArea {
  return value === "whole" || value === "masked" || value === "coherence";
}

function isSeedMode(value: unknown): value is SeedMode {
  return value === "random" || value === "reuse" || value === "manual";
}

export const generationSettingsStore = new GenerationSettingsStore();

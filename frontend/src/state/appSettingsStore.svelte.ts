/** What a lone finger does on the canvas. "auto" paints until a pen is used, then pans. */
export type TouchMode = "auto" | "paint" | "pan";

/** Per-device preferences (pen calibration differs by hardware), persisted in localStorage. */
export interface AppSettings {
  tagAutocomplete: boolean;
  /** -100 (firm: more force needed) .. 100 (light: little force needed); 0 is linear. */
  pressureSensitivity: number;
  /** Pen pressure floor, 0..0.9, so light strokes never vanish. */
  pressureMin: number;
  /** Stroke low-pass strength, 0 (raw input) .. 0.9 (heavy stabilizing). */
  smoothing: number;
  touchMode: TouchMode;
}

const STORAGE_KEY = "ultra-paint:app-settings";

const DEFAULTS: AppSettings = {
  tagAutocomplete: true,
  pressureSensitivity: 0,
  pressureMin: 0,
  smoothing: 0.5,
  touchMode: "auto",
};

export class AppSettingsStore {
  private _state = $state<AppSettings>(readStoredSettings());

  public get tagAutocomplete(): boolean {
    return this._state.tagAutocomplete;
  }

  public get pressureSensitivity(): number {
    return this._state.pressureSensitivity;
  }

  public get pressureMin(): number {
    return this._state.pressureMin;
  }

  public get smoothing(): number {
    return this._state.smoothing;
  }

  public get touchMode(): TouchMode {
    return this._state.touchMode;
  }

  public setTagAutocomplete(enabled: boolean): void {
    this._state.tagAutocomplete = enabled;
    this.persist();
  }

  public setPressureSensitivity(value: number): void {
    this._state.pressureSensitivity = clamp(value, -100, 100);
    this.persist();
  }

  public setPressureMin(value: number): void {
    this._state.pressureMin = clamp(value, 0, 0.9);
    this.persist();
  }

  public setSmoothing(value: number): void {
    this._state.smoothing = clamp(value, 0, 0.9);
    this.persist();
  }

  public setTouchMode(mode: TouchMode): void {
    this._state.touchMode = mode;
    this.persist();
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify($state.snapshot(this._state)));
    } catch {
      // Persistence is optional and must not prevent the UI from working.
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : min;
}

function readStoredSettings(): AppSettings {
  let stored: Partial<AppSettings> | null = null;
  try {
    stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
  } catch {
    // Missing or unavailable storage uses defaults.
  }
  const number = (value: unknown, fallback: number, min: number, max: number) =>
    typeof value === "number" ? clamp(value, min, max) : fallback;
  return {
    tagAutocomplete: stored?.tagAutocomplete !== false,
    pressureSensitivity: number(
      stored?.pressureSensitivity,
      DEFAULTS.pressureSensitivity,
      -100,
      100,
    ),
    pressureMin: number(stored?.pressureMin, DEFAULTS.pressureMin, 0, 0.9),
    smoothing: number(stored?.smoothing, DEFAULTS.smoothing, 0, 0.9),
    touchMode:
      stored?.touchMode === "paint" || stored?.touchMode === "pan" ? stored.touchMode : "auto",
  };
}

export const appSettingsStore = new AppSettingsStore();

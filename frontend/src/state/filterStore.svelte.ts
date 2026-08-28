/** State for one pending, unapplied layer-filter operation. */

import type { LayerId } from "./schema";

export type FilterType = "controlnet-preprocessor";
export type FilterListener = () => void;
export type FilterUnsubscribe = () => void;

interface FilterParams {
  module: string;
  thresholdA: number;
  thresholdB: number;
}

const DEFAULT_FILTER_TYPE: FilterType = "controlnet-preprocessor";
const DEFAULT_PARAMS: FilterParams = {
  module: "none",
  thresholdA: 64,
  thresholdB: 64,
};

export class FilterStore {
  private _targetLayerId = $state<LayerId | null>(null);

  private _filterType = $state<FilterType>(DEFAULT_FILTER_TYPE);

  private _module = $state(DEFAULT_PARAMS.module);

  private _thresholdA = $state(DEFAULT_PARAMS.thresholdA);

  private _thresholdB = $state(DEFAULT_PARAMS.thresholdB);

  private _previewDataUrl = $state<string | null>(null);

  private _pending = $state(false);

  private _error = $state<string | null>(null);

  private readonly listeners = new Set<FilterListener>();

  public get targetLayerId(): LayerId | null {
    return this._targetLayerId;
  }

  public get filterType(): FilterType {
    return this._filterType;
  }

  public get module(): string {
    return this._module;
  }

  public get thresholdA(): number {
    return this._thresholdA;
  }

  public get thresholdB(): number {
    return this._thresholdB;
  }

  public get previewDataUrl(): string | null {
    return this._previewDataUrl;
  }

  public get pending(): boolean {
    return this._pending;
  }

  public get error(): string | null {
    return this._error;
  }

  public get active(): boolean {
    return this._targetLayerId !== null;
  }

  public begin(layerId: LayerId): void {
    this.reset();
    this._targetLayerId = layerId;
    this.emit();
  }

  public setParams(patch: Partial<FilterParams>): void {
    if (patch.module !== undefined) this._module = patch.module;
    if (patch.thresholdA !== undefined) this._thresholdA = patch.thresholdA;
    if (patch.thresholdB !== undefined) this._thresholdB = patch.thresholdB;
    this.emit();
  }

  public setPreviewResult(dataUrl: string | null): void {
    this._previewDataUrl = dataUrl;
    this._pending = false;
    this._error = null;
    this.emit();
  }

  public setPending(pending: boolean): void {
    this._pending = pending;
    this.emit();
  }

  public setError(message: string | null): void {
    this._error = message;
    this.emit();
  }

  public cancel(): void {
    this.reset();
    this.emit();
  }

  public subscribe(fn: FilterListener): FilterUnsubscribe {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  public emit(): void {
    for (const fn of [...this.listeners]) fn();
  }

  private reset(): void {
    this._targetLayerId = null;
    this._filterType = DEFAULT_FILTER_TYPE;
    this._module = DEFAULT_PARAMS.module;
    this._thresholdA = DEFAULT_PARAMS.thresholdA;
    this._thresholdB = DEFAULT_PARAMS.thresholdB;
    this._previewDataUrl = null;
    this._pending = false;
    this._error = null;
  }
}

export const filterStore = new FilterStore();

export interface GenerationProgress {
  sampling_step?: number;
  sampling_steps?: number;
  current_image?: string | null;
}

interface GenerationRuntimeState {
  generating: boolean;
  interrupting: boolean;
  saving: boolean;
  current: number;
  total: number;
  progress: GenerationProgress | null;
  resolutionStep: number | null;
}

const INITIAL_STATE: GenerationRuntimeState = {
  generating: false,
  interrupting: false,
  saving: false,
  current: 0,
  total: 0,
  progress: null,
  resolutionStep: null,
};

export type GenerationRuntimeListener = () => void;
export type GenerationRuntimeUnsubscribe = () => void;

export class GenerationRuntimeStore {
  private _state = $state<GenerationRuntimeState>({ ...INITIAL_STATE });

  // Runes give reactivity for free inside .svelte components, but the Pixi
  // overlay (GenerationPreviewOverlay) is plain TS outside that reactive
  // context -- same subscribe/emit shape as PreviewStore, for the same reason.
  private readonly listeners = new Set<GenerationRuntimeListener>();

  public subscribe(fn: GenerationRuntimeListener): GenerationRuntimeUnsubscribe {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(): void {
    for (const fn of [...this.listeners]) fn();
  }

  public get generating(): boolean {
    return this._state.generating;
  }

  public get interrupting(): boolean {
    return this._state.interrupting;
  }

  public get saving(): boolean {
    return this._state.saving;
  }

  public get current(): number {
    return this._state.current;
  }

  public get total(): number {
    return this._state.total;
  }

  public get progress(): GenerationProgress | null {
    return this._state.progress;
  }

  public get resolutionStep(): number | null {
    return this._state.resolutionStep;
  }

  public get progressPercent(): number {
    const total = this._state.progress?.sampling_steps ?? 0;
    const current = this._state.progress?.sampling_step ?? 0;
    if (total <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((current / total) * 100)));
  }

  public setGenerating(value: boolean): void {
    this._state.generating = value;
    this.emit();
  }

  public setInterrupting(value: boolean): void {
    this._state.interrupting = value;
  }

  public setSaving(value: boolean): void {
    this._state.saving = value;
  }

  public setBatch(current: number, total: number): void {
    this._state.current = current;
    this._state.total = total;
  }

  public setProgress(value: GenerationProgress | null): void {
    this._state.progress = value;
    this.emit();
  }

  public setResolutionStep(value: number | null): void {
    this._state.resolutionStep = value;
  }

  public resetBatch(): void {
    this._state.generating = false;
    this._state.interrupting = false;
    this._state.current = 0;
    this._state.total = 0;
    this._state.progress = null;
    this.emit();
  }
}

export const generationRuntimeStore = new GenerationRuntimeStore();

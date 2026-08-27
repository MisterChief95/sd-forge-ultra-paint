/**
 * Rune-backed store for unapplied generation results shown in the floating
 * preview strip (GenerationPreviewBar.svelte). Deliberately separate from
 * LayerStore -- these images are not layers (not undoable, not in the layer
 * panel) until the user hits Apply.
 */

export interface GenerationPreview {
  readonly id: string;
  readonly dataUrl: string;
}

export type PreviewListener = () => void;
export type PreviewUnsubscribe = () => void;

function newPreviewId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === "function") {
    return `preview-${c.randomUUID()}`;
  }
  return `preview-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export class PreviewStore {
  private _previews = $state<GenerationPreview[]>([]);

  private _selectedId = $state<string | null>(null);

  private _visible = $state(true);

  private readonly listeners = new Set<PreviewListener>();

  public get previews(): readonly GenerationPreview[] {
    return this._previews;
  }

  public get selectedId(): string | null {
    return this._selectedId;
  }

  public get selected(): GenerationPreview | null {
    return this._previews.find((preview) => preview.id === this._selectedId) ?? null;
  }

  public get visible(): boolean {
    return this._visible;
  }

  public get hasPreviews(): boolean {
    return this._previews.length > 0;
  }

  /** Add a newly generated image to the strip and select it. */
  public add(dataUrl: string): string {
    const id = newPreviewId();
    this._previews = [...this._previews, { id, dataUrl }];
    this._selectedId = id;
    this._visible = true;
    this.emit();
    return id;
  }

  /** Select an existing preview to display on the canvas. */
  public select(id: string): void {
    if (this._selectedId === id || !this._previews.some((preview) => preview.id === id)) {
      return;
    }
    this._selectedId = id;
    this._visible = true;
    this.emit();
  }

  /** Show/hide the selected preview on the canvas without discarding it. */
  public toggleVisible(): void {
    this._visible = !this._visible;
    this.emit();
  }

  /** Discard one preview. Selects the next nearest remaining preview, if any. */
  public discard(id: string): void {
    const at = this._previews.findIndex((preview) => preview.id === id);
    if (at === -1) return;

    this._previews = this._previews.filter((preview) => preview.id !== id);
    if (this._selectedId === id) {
      const next = this._previews[Math.min(at, this._previews.length - 1)];
      this._selectedId = next?.id ?? null;
      this._visible = true;
    }
    this.emit();
  }

  /** Discard every preview and return the UI to its normal state. */
  public discardAll(): void {
    this._previews = [];
    this._selectedId = null;
    this._visible = true;
    this.emit();
  }

  public subscribe(fn: PreviewListener): PreviewUnsubscribe {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(): void {
    for (const fn of [...this.listeners]) fn();
  }
}

/** Shared default instance used by the app and Svelte UI. */
export const previewStore = new PreviewStore();

import type { Renderer } from "pixi.js";

import type { LayerStore, Unsubscribe } from "../state/layerStore.svelte";
import {
  decodePortableDocument,
  encodePortableDocument,
  validateProjectManifest,
  type DecodedPortableProject,
} from "../state/projectCodec";

const AUTOSAVE_URL = "/ultra_paint/api/autosave";
const QUIET_INTERVAL_MS = 25_000;
const MAX_INTERVAL_MS = 120_000;
const ACTIVE_STROKE_RETRY_MS = 500;

interface CurrentAutosave {
  checkpointId: string;
}

export async function fetchAutosavedDocument(
  renderer: Renderer,
  controlModels: readonly string[],
): Promise<DecodedPortableProject | null> {
  const currentResponse = await fetch(`${AUTOSAVE_URL}/current`, { cache: "no-store" });
  if (currentResponse.status === 204) return null;
  if (!currentResponse.ok)
    throw new Error(`autosave pointer request failed (${currentResponse.status})`);
  const current = (await currentResponse.json()) as Partial<CurrentAutosave>;
  if (typeof current.checkpointId !== "string" || !/^[0-9a-f]{32}$/.test(current.checkpointId)) {
    throw new Error("Autosave pointer is invalid.");
  }

  const checkpointUrl = `${AUTOSAVE_URL}/checkpoints/${current.checkpointId}`;
  const manifestResponse = await fetch(`${checkpointUrl}/manifest`, { cache: "no-store" });
  if (!manifestResponse.ok) {
    throw new Error(`autosave manifest request failed (${manifestResponse.status})`);
  }
  const manifest = validateProjectManifest(await manifestResponse.json());
  const assets = new Map<string, Uint8Array>();
  for (const asset of manifest.pixelAssets) {
    const response = await fetch(`${checkpointUrl}/${asset.path}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`autosave pixel request failed (${response.status})`);
    assets.set(asset.path, new Uint8Array(await response.arrayBuffer()));
  }
  return await decodePortableDocument(
    renderer,
    manifest,
    (path) => assets.get(path),
    controlModels,
  );
}

async function uploadAutosave(
  renderer: Renderer,
  store: LayerStore,
  expectedRevision: number,
  canSave: () => boolean,
  signal: AbortSignal,
): Promise<boolean> {
  const encoded = await encodePortableDocument(renderer, store, __ULTRA_PAINT_VERSION__);
  if (signal.aborted || store.projectRevision !== expectedRevision || !canSave()) return false;

  const form = new FormData();
  form.append(
    "manifest",
    new Blob([JSON.stringify(encoded.manifest)], { type: "application/json" }),
    "manifest.json",
  );
  for (const asset of encoded.assets) {
    form.append(
      asset.path,
      new Blob([new Uint8Array(asset.data)], { type: "image/png" }),
      asset.path,
    );
  }
  const response = await fetch(AUTOSAVE_URL, { method: "POST", body: form, signal });
  if (!response.ok) throw new Error(`autosave upload failed (${response.status})`);
  return true;
}

/** Debounced, single-flight persistence for committed document revisions. */
export class AutosaveController {
  private readonly unsubscribe: Unsubscribe;

  private readonly abortController = new AbortController();

  private timer: number | null = null;

  private lastSavedRevision: number;

  private dirtySince: number | null = null;

  private inFlight = false;

  private destroyed = false;

  public constructor(
    private readonly renderer: Renderer,
    private readonly store: LayerStore,
    private readonly canSave: () => boolean,
  ) {
    this.lastSavedRevision = store.projectRevision;
    this.unsubscribe = store.subscribeProjectRevisions(this.handleMutation);
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.unsubscribe();
    this.abortController.abort();
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
  }

  private readonly handleMutation = (): void => {
    if (this.destroyed || this.store.projectRevision === this.lastSavedRevision) return;
    this.dirtySince ??= Date.now();
    this.schedule();
  };

  private schedule(): void {
    if (this.destroyed || this.dirtySince === null) return;
    if (this.timer !== null) window.clearTimeout(this.timer);
    const now = Date.now();
    const delay = Math.max(0, Math.min(QUIET_INTERVAL_MS, this.dirtySince + MAX_INTERVAL_MS - now));
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delay);
  }

  private async flush(): Promise<void> {
    if (this.destroyed) return;
    if (this.inFlight) return;
    if (!this.canSave()) {
      this.timer = window.setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, ACTIVE_STROKE_RETRY_MS);
      return;
    }

    const revision = this.store.projectRevision;
    if (revision === this.lastSavedRevision) {
      this.dirtySince = null;
      return;
    }
    this.dirtySince = null;
    this.inFlight = true;
    try {
      const uploaded = await uploadAutosave(
        this.renderer,
        this.store,
        revision,
        this.canSave,
        this.abortController.signal,
      );
      if (uploaded) this.lastSavedRevision = revision;
    } catch (error) {
      if (!this.destroyed) console.warn("[ultra-paint] autosave failed:", error);
    } finally {
      this.inFlight = false;
      if (!this.destroyed && this.store.projectRevision !== this.lastSavedRevision) {
        this.dirtySince ??= Date.now();
        this.schedule();
      }
    }
  }
}

import type { Renderer } from "pixi.js";

import type { LayerStore, Unsubscribe } from "../state/layerStore.svelte";
import {
  decodePortableDocument,
  encodePortableDocument,
  validateProjectManifest,
  type DecodedPortableProject,
} from "../state/projectCodec";
import { toastStore } from "../state/toastStore.svelte";

const AUTOSAVE_URL = "/ultra_paint/api/autosave";
const QUIET_INTERVAL_MS = 25_000;
const MAX_INTERVAL_MS = 120_000;
const ACTIVE_STROKE_RETRY_MS = 500;
// Browsers allow ~6 concurrent HTTP/1.1 requests per origin.
const RESTORE_FETCH_CONCURRENCY = 6;
// One failure is often a transient blip that the next attempt clears; a
// streak means the user's work is genuinely not being saved.
const FAILURES_BEFORE_WARNING = 2;

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
  const pending = [...manifest.pixelAssets];
  const worker = async (): Promise<void> => {
    for (let asset = pending.shift(); asset; asset = pending.shift()) {
      try {
        const response = await fetch(`${checkpointUrl}/${asset.path}`, { cache: "no-store" });
        if (!response.ok) throw new Error(`autosave pixel request failed (${response.status})`);
        assets.set(asset.path, new Uint8Array(await response.arrayBuffer()));
      } catch (error) {
        pending.length = 0; // stop the other workers; the restore already failed
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: RESTORE_FETCH_CONCURRENCY }, worker));
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

  private consecutiveFailures = 0;

  public constructor(
    private readonly renderer: Renderer,
    private readonly store: LayerStore,
    private readonly canSave: () => boolean,
  ) {
    this.lastSavedRevision = store.projectRevision;
    this.unsubscribe = store.subscribeProjectRevisions(this.handleMutation);
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
    window.addEventListener("pagehide", this.flushNow);
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.unsubscribe();
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    window.removeEventListener("pagehide", this.flushNow);
    this.abortController.abort();
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
  }

  private readonly handleMutation = (): void => {
    if (this.destroyed || this.store.projectRevision === this.lastSavedRevision) return;
    this.dirtySince ??= Date.now();
    this.schedule();
  };

  // A hidden tab may be discarded (or lose its GPU context) without further
  // notice, so save immediately instead of waiting out the quiet interval.
  private readonly handleVisibilityChange = (): void => {
    if (document.visibilityState === "hidden") this.flushNow();
  };

  private readonly flushNow = (): void => {
    if (this.destroyed || this.dirtySince === null) return;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    void this.flush();
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
      if (uploaded) {
        this.lastSavedRevision = revision;
        if (this.consecutiveFailures >= FAILURES_BEFORE_WARNING) {
          toastStore.success("Autosave recovered.");
        }
        this.consecutiveFailures = 0;
      }
    } catch (error) {
      if (!this.destroyed) {
        console.warn("[ultra-paint] autosave failed:", error);
        this.consecutiveFailures += 1;
        if (this.consecutiveFailures === FAILURES_BEFORE_WARNING) {
          toastStore.error("Autosave is failing. Save your project to keep recent changes.");
        }
      }
    } finally {
      this.inFlight = false;
      if (!this.destroyed && this.store.projectRevision !== this.lastSavedRevision) {
        this.dirtySince ??= Date.now();
        this.schedule();
      }
    }
  }
}

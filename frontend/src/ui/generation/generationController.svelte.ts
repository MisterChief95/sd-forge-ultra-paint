import { getActiveUltraPaintApp, type UltraPaintApp } from "../../app/UltraPaintApp";
import { generationRuntimeStore } from "../../state/generationRuntimeStore.svelte";
import {
  generationSettingsStore,
  type ScaleMode,
} from "../../state/generationSettingsStore.svelte";
import { previewStore } from "../../state/previewStore.svelte";
import {
  fetchGenerationOptions,
  fetchGenerationProgress,
  GenerationApiError,
  interruptGeneration,
  requestGeneration,
  saveFlattenedImage,
  type ControlLayerPayload,
  type GenerationOptions,
  type GenerationParameters,
} from "./generationApi";

/** Visible control layers, captured with the rest of a queued generation. */
function collectControlLayers(app: UltraPaintApp): ControlLayerPayload[] {
  const payloads: ControlLayerPayload[] = [];
  for (const layer of app.getStore().document.layers) {
    if (layer.kind !== "control" || !layer.visible) continue;
    const image = app.layerSourceDataURL(layer.id);
    if (!image) continue;
    payloads.push({
      image,
      model: layer.model,
      weight: layer.weight,
      guidanceStart: layer.guidanceStart,
      guidanceEnd: layer.guidanceEnd,
      controlMode: layer.controlMode,
      pixelPerfect: layer.pixelPerfect,
      resizeMode: layer.resizeMode,
      enabled: true,
    });
  }
  return payloads;
}

const POLL_INTERVAL_MS = 750;
const MAX_PROGRESS_POLLS = 1200;

export interface GenerateInput extends Omit<GenerationParameters, "seed"> {
  scaleMode: ScaleMode;
}

type NotificationKind = "info" | "success" | "error";

interface QueuedGeneration {
  compositeImage: string;
  maskImage: string | null;
  parameters: GenerationParameters;
  controlLayers: ControlLayerPayload[];
  updateRandomSeed: boolean;
}

export interface GenerationControllerBindings {
  setOptions(value: GenerationOptions): void;
  notify(kind: NotificationKind, message: string): void;
}

export interface GenerationController {
  loadOptions(): Promise<void>;
  generate(input: GenerateInput): void;
  saveImage(): Promise<void>;
  cancelCurrent(): Promise<void>;
  cancelRemaining(): void;
  cancelAll(): Promise<void>;
  destroy(): void;
}

export function createGenerationController(
  bindings: GenerationControllerBindings,
): GenerationController {
  // ponytail: base64 payloads stay in this plain FIFO; make them reactive only if a queue inspector
  // ever needs to display individual jobs.
  let queued: QueuedGeneration[] = [];
  let destroyed = false;
  let draining = false;
  let progressRunId = 0;
  let activeCancelled = false;
  let batchCurrent = 0;
  let batchTotal = 0;

  async function loadOptions(): Promise<void> {
    try {
      const options = await fetchGenerationOptions();
      if (!destroyed) bindings.setOptions(options);
    } catch (error) {
      console.warn("[ultra-paint] could not load generation options:", error);
    }
  }

  function generate(input: GenerateInput): void {
    const app = getActiveUltraPaintApp();
    if (!app) {
      bindings.notify("error", "The painting canvas is not ready yet.");
      return;
    }
    if (input.scaleMode === "auto" && input.targetResolution === null) {
      bindings.notify("error", "The model's resolution step is not available yet.");
      return;
    }

    let compositeImage: string;
    let maskImage: string | null = null;
    try {
      compositeImage = app.flattenToDataURL();
      if (input.generationMode === "img2img") maskImage = app.flattenMaskToDataURL();
    } catch (error) {
      console.error("[ultra-paint] flatten failed:", error);
      bindings.notify("error", "The painting canvas is not ready yet.");
      return;
    }

    const seedMode = generationSettingsStore.seedMode;
    queued.push({
      compositeImage,
      maskImage,
      parameters: {
        ...input,
        seed: seedMode === "random" ? -1 : generationSettingsStore.seedValue,
      },
      controlLayers: collectControlLayers(app),
      updateRandomSeed: seedMode === "random",
    });

    batchTotal += 1;
    generationRuntimeStore.setBatch(batchCurrent || 1, batchTotal);
    if (!draining) void drainQueue();
  }

  async function drainQueue(): Promise<void> {
    if (draining) return;
    draining = true;
    generationRuntimeStore.setGenerating(true);

    while (!destroyed && queued.length > 0) {
      const job = queued.shift();
      if (!job) break;
      batchCurrent += 1;
      activeCancelled = false;
      generationRuntimeStore.setInterrupting(false);
      generationRuntimeStore.setProgress(null);
      generationRuntimeStore.setBatch(batchCurrent, batchTotal);
      const runId = ++progressRunId;
      void pollProgress(runId);

      try {
        const { images, seeds } = await requestGeneration(
          job.compositeImage,
          job.maskImage,
          job.parameters,
          job.controlLayers,
        );
        if (runId === progressRunId) progressRunId += 1;
        if (activeCancelled) continue;

        if (job.updateRandomSeed && seeds.length > 0 && seeds[0] !== undefined) {
          generationSettingsStore.setSeedValue(seeds[0]);
        }
        for (const image of images) {
          if (typeof image === "string") previewStore.add(image);
        }
      } catch (error) {
        if (!destroyed && !activeCancelled) {
          bindings.notify("error", error instanceof Error ? error.message : "Generation failed.");
        }
      } finally {
        if (runId === progressRunId) progressRunId += 1;
      }
    }

    draining = false;
    batchCurrent = 0;
    batchTotal = 0;
    generationRuntimeStore.resetBatch();
  }

  async function saveImage(): Promise<void> {
    if (generationRuntimeStore.saving) return;
    const app = getActiveUltraPaintApp();
    if (!app) {
      bindings.notify("error", "The painting canvas is not ready yet.");
      return;
    }

    let image: string;
    try {
      image = app.flattenToDataURL();
    } catch (error) {
      console.error("[ultra-paint] flatten failed:", error);
      bindings.notify("error", "The painting canvas is not ready yet.");
      return;
    }

    generationRuntimeStore.setSaving(true);
    try {
      const path = await saveFlattenedImage(image);
      if (!destroyed) bindings.notify("success", `Saved to ${path}`);
    } catch (error) {
      if (!destroyed) {
        bindings.notify("error", error instanceof Error ? error.message : "Save failed.");
      }
    } finally {
      if (!destroyed) generationRuntimeStore.setSaving(false);
    }
  }

  async function cancelCurrent(notify = true): Promise<void> {
    if (!draining || generationRuntimeStore.interrupting) return;
    activeCancelled = true;
    generationRuntimeStore.setInterrupting(true);
    try {
      await interruptGeneration();
      if (notify) {
        bindings.notify(
          "info",
          queued.length > 0
            ? `Cancelling the current generation; ${queued.length} queued remaining.`
            : "Cancelling the current generation.",
        );
      }
    } catch (error) {
      activeCancelled = false;
      generationRuntimeStore.setInterrupting(false);
      const message =
        error instanceof GenerationApiError
          ? `Cancel request failed (${error.status}).`
          : "Cancel request failed.";
      bindings.notify("error", message);
    }
  }

  function cancelRemaining(): void {
    const removed = clearRemaining();
    bindings.notify(
      "info",
      removed > 0
        ? `Removed ${removed} queued generation${removed === 1 ? "" : "s"}.`
        : "There are no queued generations to remove.",
    );
  }

  async function cancelAll(): Promise<void> {
    const removed = clearRemaining();
    if (!draining) {
      bindings.notify(
        "info",
        removed > 0
          ? `Removed ${removed} queued generation${removed === 1 ? "" : "s"}.`
          : "There are no active or queued generations.",
      );
      return;
    }
    bindings.notify(
      "info",
      removed > 0
        ? `Removed ${removed} queued generation${removed === 1 ? "" : "s"}; cancelling the current generation.`
        : "Cancelling the current generation.",
    );
    await cancelCurrent(false);
  }

  function clearRemaining(): number {
    const removed = queued.length;
    queued = [];
    batchTotal = batchCurrent;
    generationRuntimeStore.setBatch(batchCurrent, batchTotal);
    return removed;
  }

  function destroy(): void {
    destroyed = true;
    queued = [];
    progressRunId += 1;
    generationRuntimeStore.resetBatch();
  }

  async function pollProgress(runId: number): Promise<void> {
    for (let poll = 0; poll < MAX_PROGRESS_POLLS; poll += 1) {
      if (destroyed || runId !== progressRunId) return;
      try {
        const next = await fetchGenerationProgress();
        if (!destroyed && runId === progressRunId) generationRuntimeStore.setProgress(next);
      } catch (error) {
        if (error instanceof GenerationApiError) {
          console.warn(`[ultra-paint] progress request failed (${error.status})`);
        } else {
          console.warn("[ultra-paint] progress polling failed:", error);
        }
      }
      await wait(POLL_INTERVAL_MS);
    }

    if (!destroyed && runId === progressRunId) {
      console.warn("[ultra-paint] progress polling reached its safety cutoff");
    }
  }

  return { loadOptions, generate, saveImage, cancelCurrent, cancelRemaining, cancelAll, destroy };
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

import { getActiveUltraPaintApp, type UltraPaintApp } from "../../app/UltraPaintApp";
import type { ScaleMode } from "../../state/generationSettingsStore.svelte";
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
  type ProgressResponse,
} from "./generationApi";

/** Visible control layers, serialized to the wire payload `requestGeneration` sends. */
function collectControlLayers(app: UltraPaintApp): ControlLayerPayload[] {
  const payloads: ControlLayerPayload[] = [];
  for (const layer of app.getStore().document.layers) {
    if (layer.kind !== "control" || !layer.visible) continue;
    const image = app.layerSourceDataURL(layer.id);
    if (!image) continue;
    payloads.push({
      image,
      maskImage: layer.maskLayerId ? app.layerSourceDataURL(layer.maskLayerId) : null,
      model: layer.model,
      preprocessor: layer.preprocessor,
      preprocessorResolution: layer.preprocessorResolution,
      preprocessorThresholdA: layer.preprocessorThresholdA,
      preprocessorThresholdB: layer.preprocessorThresholdB,
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

export interface GenerateInput extends GenerationParameters {
  scaleMode: ScaleMode;
}

export interface GenerationControllerBindings {
  readonly generating: boolean;
  readonly saving: boolean;
  readonly interrupting: boolean;
  setGenerating(value: boolean): void;
  setSaving(value: boolean): void;
  setInterrupting(value: boolean): void;
  setErrorMessage(value: string | null): void;
  setSaveMessage(value: string | null): void;
  setProgress(value: ProgressResponse | null): void;
  setOptions(value: GenerationOptions): void;
}

export interface GenerationController {
  loadOptions(): Promise<void>;
  generate(input: GenerateInput): Promise<void>;
  saveImage(): Promise<void>;
  cancelGeneration(): Promise<void>;
  destroy(): void;
}

export function createGenerationController(
  bindings: GenerationControllerBindings,
): GenerationController {
  let destroyed = false;
  let progressRunId = 0;
  let saveMessageTimer: number | null = null;

  async function loadOptions(): Promise<void> {
    try {
      const options = await fetchGenerationOptions();
      if (!destroyed) bindings.setOptions(options);
    } catch (error) {
      console.warn("[ultra-paint] could not load generation options:", error);
    }
  }

  async function generate(input: GenerateInput): Promise<void> {
    if (bindings.generating) return;
    bindings.setErrorMessage(null);
    bindings.setProgress(null);

    const app = getActiveUltraPaintApp();
    if (!app) {
      bindings.setErrorMessage("The painting canvas is not ready yet.");
      return;
    }
    if (input.scaleMode === "auto" && input.targetResolution === null) {
      bindings.setErrorMessage("The model's resolution step is not available yet.");
      return;
    }

    let compositeImage: string;
    let maskImage: string | null = null;
    try {
      compositeImage = app.flattenToDataURL();
      if (input.generationMode === "img2img") {
        maskImage = app.flattenMaskToDataURL();
      }
    } catch (error) {
      console.error("[ultra-paint] flatten failed:", error);
      bindings.setErrorMessage("The painting canvas is not ready yet.");
      return;
    }

    bindings.setGenerating(true);
    const runId = ++progressRunId;
    void pollProgress(runId);

    try {
      const images = await requestGeneration(
        compositeImage,
        maskImage,
        input,
        collectControlLayers(app),
      );
      if (runId === progressRunId) progressRunId += 1;

      for (const image of images) {
        if (typeof image !== "string") continue;
        const activeApp = getActiveUltraPaintApp();
        if (!activeApp) {
          throw new Error("The painting canvas closed before results were added.");
        }
        const id = await activeApp.addImageFromDataURL(
          image,
          "Generated",
          "generated",
        );
        activeApp.getStore().setSelectedLayerId(id);
      }
    } catch (error) {
      if (!destroyed) {
        bindings.setErrorMessage(
          error instanceof Error ? error.message : "Generation failed.",
        );
      }
    } finally {
      if (runId === progressRunId) progressRunId += 1;
      if (!destroyed) {
        bindings.setGenerating(false);
        bindings.setInterrupting(false);
      }
    }
  }

  async function saveImage(): Promise<void> {
    if (bindings.saving) return;
    bindings.setErrorMessage(null);
    bindings.setSaveMessage(null);

    const app = getActiveUltraPaintApp();
    if (!app) {
      bindings.setErrorMessage("The painting canvas is not ready yet.");
      return;
    }

    let image: string;
    try {
      image = app.flattenToDataURL();
    } catch (error) {
      console.error("[ultra-paint] flatten failed:", error);
      bindings.setErrorMessage("The painting canvas is not ready yet.");
      return;
    }

    bindings.setSaving(true);
    try {
      const path = await saveFlattenedImage(image);
      if (destroyed) return;
      bindings.setSaveMessage(`Saved to ${path}`);
      if (saveMessageTimer !== null) window.clearTimeout(saveMessageTimer);
      saveMessageTimer = window.setTimeout(() => {
        bindings.setSaveMessage(null);
        saveMessageTimer = null;
      }, 4000);
    } catch (error) {
      if (!destroyed) {
        bindings.setErrorMessage(
          error instanceof Error ? error.message : "Save failed.",
        );
      }
    } finally {
      if (!destroyed) bindings.setSaving(false);
    }
  }

  async function cancelGeneration(): Promise<void> {
    if (!bindings.generating || bindings.interrupting) return;
    bindings.setInterrupting(true);
    try {
      await interruptGeneration();
    } catch (error) {
      if (error instanceof GenerationApiError) {
        console.warn(`[ultra-paint] interrupt request failed (${error.status})`);
      } else {
        console.warn("[ultra-paint] interrupt request failed:", error);
      }
    }
  }

  function destroy(): void {
    destroyed = true;
    progressRunId += 1;
    if (saveMessageTimer !== null) window.clearTimeout(saveMessageTimer);
  }

  async function pollProgress(runId: number): Promise<void> {
    for (let poll = 0; poll < MAX_PROGRESS_POLLS; poll += 1) {
      if (destroyed || !bindings.generating || runId !== progressRunId) return;
      try {
        const next = await fetchGenerationProgress();
        if (!destroyed && runId === progressRunId) bindings.setProgress(next);
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

  return { loadOptions, generate, saveImage, cancelGeneration, destroy };
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

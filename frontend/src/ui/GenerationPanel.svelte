<script lang="ts">
  import { onDestroy, onMount } from "svelte";

  import { generationSettingsStore } from "../state/generationSettingsStore.svelte";
  import { generationRuntimeStore } from "../state/generationRuntimeStore.svelte";
  import { layerStore } from "../state/layerStore.svelte";
  import { toastStore } from "../state/toastStore.svelte";
  import { registerGenerationActions } from "../input/actionMap";
  import { calculateAutoResolution, type Resolution } from "../util/autoResolution";
  import Accordion from "./lib/Accordion.svelte";
  import BoundaryBoxControls from "./generation/BoundaryBoxControls.svelte";
  import GenerationActionsAndStatus from "./generation/GenerationActionsAndStatus.svelte";
  import InpaintControls from "./generation/InpaintControls.svelte";
  import LoraControls from "./generation/LoraControls.svelte";
  import ModelControls from "./generation/ModelControls.svelte";
  import PromptFields from "./generation/PromptFields.svelte";
  import SamplingControls from "./generation/SamplingControls.svelte";
  import { createGenerationController } from "./generation/generationController.svelte";
  import {
    fetchPersistedGenerationSettings,
    persistGenerationSettings,
    type GenerationOptions,
  } from "./generation/generationApi";
  import { buildLoraPrompt, type SelectedLora } from "./generation/lora";

  const SETTINGS_DEBOUNCE_MS = 1000;

  let prompt = $state("");
  let negativePrompt = $state("");
  let samplers = $state<string[]>([]);
  let schedulers = $state<string[]>([]);
  let models = $state<string[]>([]);
  let modules = $state<string[]>([]);
  let samplerName = $state("");
  let scheduler = $state("");
  let modelName = $state("");
  let moduleNames = $state<string[]>([]);
  let modelOptionsLoaded = $state(false);
  let resolutionStep = $state<number | null>(null);
  let isVideoModel = $state(false);
  let steps = $state(20);
  let cfgScale = $state(7);
  let denoisingStrength = $state(0.75);
  let selectedLoras = $state<SelectedLora[]>([]);
  let persistenceReady = $state(false);
  let restoredPersistedSettings = false;
  let persistenceTimer: number | null = null;
  let pendingSettings: Record<string, unknown> | null = null;
  let saveInFlight = false;

  const enabledLoraCount = $derived(selectedLoras.filter((lora) => lora.enabled).length);

  const autoTargetResolution = $derived.by((): Resolution | null => {
    if (resolutionStep === null) return null;
    const box = layerStore.document.boundaryBox;
    return calculateAutoResolution(
      box.width,
      box.height,
      generationSettingsStore.autoBaseWidth,
      resolutionStep,
    );
  });

  const selectedTargetResolution = $derived.by((): Resolution | null => {
    switch (generationSettingsStore.scaleMode) {
      case "none":
        return null;
      case "auto":
        return autoTargetResolution;
      case "manual":
        return {
          width: generationSettingsStore.manualWidth,
          height: generationSettingsStore.manualHeight,
        };
    }
  });

  const generationMode = $derived(layerStore.hasVisibleRasterContent ? "img2img" : "txt2img");

  $effect(() => {
    if (!persistenceReady) return;
    scheduleSettingsSave(settingsSnapshot());
  });

  const controller = createGenerationController({
    notify(kind, message) {
      toastStore[kind](message);
    },
    setOptions(value: GenerationOptions) {
      samplers = value.samplers;
      schedulers = value.schedulers;
      models = value.models;
      modules = value.modules;
      samplerName = samplers.includes(samplerName) ? samplerName : "";
      scheduler = schedulers.includes(scheduler) ? scheduler : "";
      modelName =
        restoredPersistedSettings && models.includes(modelName) ? modelName : value.selectedModel;
      moduleNames = restoredPersistedSettings
        ? moduleNames.filter((module) => modules.includes(module))
        : value.selectedModules;
      modelOptionsLoaded = true;
      resolutionStep = value.resolutionStep;
      isVideoModel = value.isVideoModel;
    },
  });

  onMount(() => {
    void initialiseSettings();
    return registerGenerationActions({
      isGenerating: () => generationRuntimeStore.generating,
      generate,
      save: () => void controller.saveImage(),
      cancelCurrent: () => void controller.cancelCurrent(),
      cancelRemaining: () => controller.cancelRemaining(),
      cancelAll: () => void controller.cancelAll(),
    });
  });

  onDestroy(() => {
    if (persistenceTimer !== null) window.clearTimeout(persistenceTimer);
    controller.destroy();
  });

  function generate(): void {
    void controller.generate({
      generationMode,
      prompt: buildLoraPrompt(prompt, selectedLoras),
      negativePrompt,
      steps,
      cfgScale,
      denoisingStrength,
      maskBlur: generationSettingsStore.maskBlur,
      inpaintPadding: generationSettingsStore.inpaintPadding,
      inpaintFullRes: generationSettingsStore.inpaintArea === "masked",
      // The Coherence Pass option hides the Soft Inpainting checkbox (they
      // don't compose), but the underlying setting persists -- force it off
      // here rather than relying on the UI never sending a stale `true`.
      softInpaintingEnabled:
        generationSettingsStore.inpaintArea === "coherence"
          ? false
          : generationSettingsStore.softInpaintingEnabled,
      inpaintControlNetEnabled: generationSettingsStore.inpaintControlNetEnabled,
      inpaintControlNetModel: generationSettingsStore.inpaintControlNetModel,
      inpaintControlNetWeight: generationSettingsStore.inpaintControlNetWeight,
      coherencePassEnabled: generationSettingsStore.inpaintArea === "coherence",
      coherenceEdgeSize: generationSettingsStore.coherenceEdgeSize,
      coherencePassFast: generationSettingsStore.coherencePassFast,
      samplerName,
      scheduler,
      modelName: modelOptionsLoaded ? modelName : "",
      moduleNames: modelOptionsLoaded ? moduleNames : null,
      targetResolution: selectedTargetResolution,
      scaleMode: generationSettingsStore.scaleMode,
    });
  }

  function addActivationWords(value: string): void {
    const words = value.trim();
    if (!words) return;
    prompt = [prompt.trim(), words].filter(Boolean).join(", ");
  }

  async function initialiseSettings(): Promise<void> {
    try {
      const stored = await fetchPersistedGenerationSettings();
      if (stored) restorePersistedSettings(stored);
    } catch {
      // Persistence must not prevent the Generation panel from loading.
    }
    persistenceReady = true;
    await controller.loadOptions();
  }

  function settingsSnapshot(): Record<string, unknown> {
    const box = layerStore.document.boundaryBox;
    return {
      version: 1,
      boundaryBox: { ...box },
      prompt,
      negativePrompt,
      samplerName,
      scheduler,
      modelName,
      moduleNames,
      steps,
      cfgScale,
      denoisingStrength,
      selectedLoras,
      generationSettings: generationSettingsStore.snapshot,
    };
  }

  function scheduleSettingsSave(settings: Record<string, unknown>): void {
    pendingSettings = settings;
    if (persistenceTimer !== null) window.clearTimeout(persistenceTimer);
    persistenceTimer = window.setTimeout(() => {
      persistenceTimer = null;
      void flushSettingsSave();
    }, SETTINGS_DEBOUNCE_MS);
  }

  async function flushSettingsSave(keepalive = false): Promise<void> {
    if (saveInFlight || pendingSettings === null) return;
    const settings = pendingSettings;
    pendingSettings = null;
    saveInFlight = true;
    try {
      await persistGenerationSettings(settings, keepalive);
    } catch {
      // Keep the panel usable if disk persistence is temporarily unavailable.
    } finally {
      saveInFlight = false;
      if (pendingSettings !== null && persistenceTimer === null) {
        persistenceTimer = window.setTimeout(() => {
          persistenceTimer = null;
          void flushSettingsSave();
        }, 0);
      }
    }
  }

  function flushSettingsOnPageHide(): void {
    if (!persistenceReady) return;
    if (persistenceTimer !== null) {
      window.clearTimeout(persistenceTimer);
      persistenceTimer = null;
    }
    pendingSettings = null;
    void persistGenerationSettings(settingsSnapshot(), true).catch(() => {
      // The page is leaving; there is no useful UI error to show here.
    });
  }

  function restorePersistedSettings(stored: Record<string, unknown>): void {
    if (stored.version !== 1) return;

    restoredPersistedSettings = true;
    restoreBoundaryBox(stored.boundaryBox);
    prompt = stringValue(stored.prompt, prompt);
    negativePrompt = stringValue(stored.negativePrompt, negativePrompt);
    samplerName = stringValue(stored.samplerName, samplerName);
    scheduler = stringValue(stored.scheduler, scheduler);
    modelName = stringValue(stored.modelName, modelName);
    moduleNames = stringArray(stored.moduleNames);
    steps = numberValue(stored.steps, steps, 1, 150, true);
    cfgScale = numberValue(stored.cfgScale, cfgScale, 1, 30);
    denoisingStrength = numberValue(stored.denoisingStrength, denoisingStrength, 0, 1);
    selectedLoras = selectedLoraArray(stored.selectedLoras);
    if (isRecord(stored.generationSettings)) {
      generationSettingsStore.restore(stored.generationSettings);
    }
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function restoreBoundaryBox(value: unknown): void {
    if (!isRecord(value)) return;
    const { x, y, width, height } = value;
    if (
      !isSafeInteger(x) ||
      !isSafeInteger(y) ||
      !isSafeInteger(width) ||
      !isSafeInteger(height) ||
      width < 1 ||
      width > 8192 ||
      height < 1 ||
      height > 8192
    ) {
      return;
    }
    layerStore.restoreBoundaryBox({ x, y, width, height });
  }

  function isSafeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value);
  }

  function stringValue(value: unknown, fallback: string): string {
    return typeof value === "string" ? value : fallback;
  }

  function stringArray(value: unknown): string[] {
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  }

  function numberValue(
    value: unknown,
    fallback: number,
    minimum: number,
    maximum: number,
    integer = false,
  ): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
    const clamped = Math.max(minimum, Math.min(maximum, value));
    return integer ? Math.round(clamped) : clamped;
  }

  function selectedLoraArray(value: unknown): SelectedLora[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item): SelectedLora[] => {
      if (
        !isRecord(item) ||
        typeof item.name !== "string" ||
        typeof item.promptName !== "string" ||
        typeof item.activationText !== "string" ||
        typeof item.preferredWeight !== "number" ||
        typeof item.enabled !== "boolean" ||
        typeof item.weight !== "number" ||
        !Number.isFinite(item.preferredWeight) ||
        !Number.isFinite(item.weight)
      ) {
        return [];
      }
      return [
        {
          name: item.name,
          promptName: item.promptName,
          activationText: item.activationText,
          preferredWeight: item.preferredWeight,
          enabled: item.enabled,
          weight: item.weight,
        },
      ];
    });
  }
</script>

<svelte:window onpagehide={flushSettingsOnPageHide} />

<section
  class="box-border flex h-full w-full flex-col gap-3 p-3 text-xs"
  style="color: var(--upaint-text); font-family: var(--upaint-font);"
  aria-labelledby="upaint-generation-title"
>
  <header class="border-b pb-2" style="border-color: var(--upaint-border);">
    <h2 id="upaint-generation-title" class="m-0 text-sm font-semibold">Generation</h2>
  </header>

  {#if isVideoModel}
    <p
      class="m-0 border px-2 py-1.5 text-xs text-(--upaint-danger)"
      style="border-color: var(--upaint-danger); border-radius: var(--upaint-radius-sm);"
      role="alert"
    >
      A Wan/video model is loaded. Generate will be rejected; select a supported image model first.
    </p>
  {/if}

  <GenerationActionsAndStatus
    generating={generationRuntimeStore.generating}
    interrupting={generationRuntimeStore.interrupting}
    current={generationRuntimeStore.current}
    total={generationRuntimeStore.total}
    progress={generationRuntimeStore.progress}
    progressPercent={generationRuntimeStore.progressPercent}
    onGenerate={generate}
    onCancelCurrent={() => void controller.cancelCurrent()}
    onCancelRemaining={() => controller.cancelRemaining()}
    onCancelAll={() => void controller.cancelAll()}
  />

  <p class="m-0 text-(--upaint-text-muted)" role="status">
    Generation mode: {generationMode === "txt2img" ? "Text to image" : "Image to image"}
  </p>

  <PromptFields bind:prompt bind:negativePrompt />

  <div class="-mx-3 flex flex-col">
    <Accordion open title="Model">
      <div class="p-2">
        <ModelControls {models} {modules} bind:modelName bind:moduleNames />
      </div>
    </Accordion>

    <Accordion title="Bounding Box">
      <div class="p-2">
        <BoundaryBoxControls
          scaleMode={generationSettingsStore.scaleMode}
          autoBaseWidth={generationSettingsStore.autoBaseWidth}
          manualWidth={generationSettingsStore.manualWidth}
          manualHeight={generationSettingsStore.manualHeight}
          {autoTargetResolution}
          onScaleModeChange={(value) => generationSettingsStore.setScaleMode(value)}
          onAutoBaseWidthChange={(value) => generationSettingsStore.setAutoBaseWidth(value)}
          onManualWidthChange={(value) => generationSettingsStore.setManualWidth(value)}
          onManualHeightChange={(value) => generationSettingsStore.setManualHeight(value)}
        />
      </div>
    </Accordion>

    <Accordion title="LoRAs" count={enabledLoraCount}>
      <div class="p-2">
        <LoraControls
          {selectedLoras}
          onSelectedLorasChange={(value) => (selectedLoras = value)}
          onAddActivationWords={addActivationWords}
        />
      </div>
    </Accordion>

    <Accordion open title="Sampling">
      <div class="p-2">
        <SamplingControls
          {samplers}
          {schedulers}
          bind:samplerName
          bind:scheduler
          bind:steps
          bind:cfgScale
          bind:denoisingStrength
          denoisingDisabled={generationMode === "txt2img"}
          seedMode={generationSettingsStore.seedMode}
          seedValue={generationSettingsStore.seedValue}
          onSeedModeChange={(value) => generationSettingsStore.setSeedMode(value)}
          onSeedValueChange={(value) => generationSettingsStore.setSeedValue(value)}
        />
      </div>
    </Accordion>

    <Accordion title="Inpainting">
      <div class="p-2">
        <InpaintControls
          maskBlur={generationSettingsStore.maskBlur}
          inpaintPadding={generationSettingsStore.inpaintPadding}
          inpaintArea={generationSettingsStore.inpaintArea}
          softInpaintingEnabled={generationSettingsStore.softInpaintingEnabled}
          inpaintControlNetEnabled={generationSettingsStore.inpaintControlNetEnabled}
          inpaintControlNetModel={generationSettingsStore.inpaintControlNetModel}
          inpaintControlNetWeight={generationSettingsStore.inpaintControlNetWeight}
          coherenceEdgeSize={generationSettingsStore.coherenceEdgeSize}
          coherencePassFast={generationSettingsStore.coherencePassFast}
          onMaskBlurChange={(value) => generationSettingsStore.setMaskBlur(value)}
          onInpaintPaddingChange={(value) => generationSettingsStore.setInpaintPadding(value)}
          onInpaintAreaChange={(value) => generationSettingsStore.setInpaintArea(value)}
          onSoftInpaintingChange={(value) =>
            generationSettingsStore.setSoftInpaintingEnabled(value)}
          onInpaintControlNetEnabledChange={(value) =>
            generationSettingsStore.setInpaintControlNetEnabled(value)}
          onInpaintControlNetModelChange={(value) =>
            generationSettingsStore.setInpaintControlNetModel(value)}
          onInpaintControlNetWeightChange={(value) =>
            generationSettingsStore.setInpaintControlNetWeight(value)}
          onCoherenceEdgeSizeChange={(value) => generationSettingsStore.setCoherenceEdgeSize(value)}
          onCoherencePassFastChange={(value) => generationSettingsStore.setCoherencePassFast(value)}
        />
      </div>
    </Accordion>
  </div>
</section>

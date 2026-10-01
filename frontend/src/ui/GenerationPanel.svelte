<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { flip } from "svelte/animate";

  import { registerHandOffSaver } from "../app/popOut";
  import { isHandedOff } from "../state/documentInteractionLock.svelte";
  import { generationSettingsStore } from "../state/generationSettingsStore.svelte";
  import { generationRuntimeStore } from "../state/generationRuntimeStore.svelte";
  import { layerStore } from "../state/layerStore.svelte";
  import { toastStore } from "../state/toastStore.svelte";
  import { uiLayoutStore } from "../state/uiLayoutStore.svelte";
  import { registerGenerationActions } from "../input/actionMap";
  import { calculateAutoResolution, type Resolution } from "../util/autoResolution";
  import Accordion from "./lib/Accordion.svelte";
  import Button from "./lib/Button.svelte";
  import Icon from "./lib/Icon.svelte";
  import Select from "./lib/Select.svelte";
  import SliderNumberInput from "./lib/SliderNumberInput.svelte";
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
    type BackendFeatures,
    type GenerationOptions,
  } from "./generation/generationApi";
  import { fetchExtensionManifests, type ExtensionManifest } from "./generation/extensionsApi";
  import ExtensionSection, {
    deriveDefaultExtensionValues,
    type ExtensionValues,
  } from "./generation/ExtensionSection.svelte";
  import { buildLoraPrompt, type SelectedLora } from "./generation/lora";
  import { autoFormatPromptSpacing } from "./generation/promptFormat";
  import { applyStyles } from "./generation/stylesApi";
  import { stylesStore } from "../state/stylesStore.svelte";

  const SETTINGS_DEBOUNCE_MS = 1000;
  const DEFAULT_SECTION_ORDER = [
    "generation.model",
    "generation.bounding-box",
    "generation.loras",
    "generation.sampling",
    "generation.composition",
    "generation.extensions",
    "generation.upscale",
  ] as const;
  type SectionId = (typeof DEFAULT_SECTION_ORDER)[number];

  const SECTION_LABELS: Record<SectionId, string> = {
    "generation.model": "Model",
    "generation.bounding-box": "Bounding Box",
    "generation.loras": "LoRAs",
    "generation.sampling": "Sampling",
    "generation.composition": "Composition",
    "generation.extensions": "Extensions",
    "generation.upscale": "Upscale",
  };

  let prompt = $state("");
  let negativePrompt = $state("");
  let negativeEnabled = $state(true);
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
  // Assume everything is available until `/options` says otherwise.
  let features = $state<BackendFeatures>({ controlnet: true, softInpainting: true, loras: true });
  let steps = $state(20);
  let cfgScale = $state(7);
  let denoisingStrength = $state(0.75);
  let upscalers = $state<string[]>([]);
  let upscalerName = $state("");
  let upscaleMultiplier = $state(1.5);
  let upscaleDenoisingStrength = $state(0.4);
  let upscaleAdvancedEnabled = $state(false);
  let upscaleSteps = $state(20);
  let upscaleCfgScale = $state(7);
  let upscaleSamplerName = $state("");
  let upscaleScheduler = $state("");
  let selectedLoras = $state<SelectedLora[]>([]);
  let extensionManifests = $state<ExtensionManifest[]>([]);
  let extensionValues = $state<Record<string, ExtensionValues>>({});
  let persistenceReady = $state(false);
  let restoredPersistedSettings = false;
  let restoredExtensionValues: Record<string, Record<string, unknown>> | null = null;
  let persistenceTimer: number | null = null;
  let pendingSettings: Record<string, unknown> | null = null;
  let saveInFlight = false;
  let sectionOrder = $state<SectionId[]>(normaliseSectionOrder(uiLayoutStore.panelOrder));
  let draggingSectionId = $state<SectionId | null>(null);
  let dropAnchorId = $state<SectionId | null>(null);
  let dropBefore = $state(true);
  let dropLineOffset = $state(0);
  let prefersReducedMotion = $state(false);
  let moveAnnouncement = $state("");

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

  const visibleSectionOrder = $derived(
    sectionOrder.filter(
      (id) =>
        (id !== "generation.extensions" || extensionManifests.length > 0) &&
        (id !== "generation.loras" || features.loras),
    ),
  );

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
      upscalers = value.upscalers;
      samplerName = samplers.includes(samplerName) ? samplerName : "";
      scheduler = schedulers.includes(scheduler) ? scheduler : "";
      upscaleSamplerName = samplers.includes(upscaleSamplerName) ? upscaleSamplerName : "";
      upscaleScheduler = schedulers.includes(upscaleScheduler) ? upscaleScheduler : "";
      upscalerName = upscalers.includes(upscalerName) ? upscalerName : "";
      modelName =
        restoredPersistedSettings && models.includes(modelName) ? modelName : value.selectedModel;
      moduleNames = restoredPersistedSettings
        ? moduleNames.filter((module) => modules.includes(module))
        : value.selectedModules;
      modelOptionsLoaded = true;
      resolutionStep = value.resolutionStep;
      generationRuntimeStore.setResolutionStep(value.resolutionStep);
      isVideoModel = value.isVideoModel;
      features = value.features;
    },
  });

  onMount(() => {
    const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateReducedMotion = (): void => {
      prefersReducedMotion = reducedMotionQuery.matches;
    };
    updateReducedMotion();
    reducedMotionQuery.addEventListener("change", updateReducedMotion);

    void initialiseSettings();
    const unregisterActions = registerGenerationActions({
      isGenerating: () => generationRuntimeStore.generating,
      generate,
      save: () => void controller.saveImage(),
      cancelCurrent: () => void controller.cancelCurrent(),
      cancelRemaining: () => controller.cancelRemaining(),
      cancelAll: () => void controller.cancelAll(),
    });
    const unregisterHandOffSaver = registerHandOffSaver(async () => {
      if (!persistenceReady) return true;
      if (persistenceTimer !== null) window.clearTimeout(persistenceTimer);
      persistenceTimer = null;
      pendingSettings = null;
      await persistGenerationSettings(settingsSnapshot());
      return true;
    });
    return () => {
      reducedMotionQuery.removeEventListener("change", updateReducedMotion);
      unregisterActions();
      unregisterHandOffSaver();
    };
  });

  onDestroy(() => {
    if (persistenceTimer !== null) window.clearTimeout(persistenceTimer);
    controller.destroy();
  });

  /** Prompts as sent to Forge: selected styles applied, negative blank when off. */
  function effectivePrompts(): { prompt: string; negativePrompt: string } {
    const { selected, styles } = stylesStore;
    return {
      prompt: buildLoraPrompt(
        applyStyles(prompt, selected, styles, "prompt"),
        features.loras ? selectedLoras : [],
      ),
      negativePrompt: negativeEnabled
        ? applyStyles(negativePrompt, selected, styles, "negative_prompt")
        : "",
    };
  }

  function generate(): void {
    prompt = autoFormatPromptSpacing(prompt);
    negativePrompt = autoFormatPromptSpacing(negativePrompt);
    void controller.generate({
      generationMode,
      ...effectivePrompts(),
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
      coherenceAlgorithm: generationSettingsStore.coherenceAlgorithm,
      samplerName,
      scheduler,
      modelName: modelOptionsLoaded ? modelName : "",
      moduleNames: modelOptionsLoaded ? moduleNames : null,
      targetResolution: selectedTargetResolution,
      scaleMode: generationSettingsStore.scaleMode,
      extensions: extensionValues,
    });
  }

  function normaliseSectionOrder(stored: string[] | null): SectionId[] {
    const known = new Set<string>(DEFAULT_SECTION_ORDER);
    const restored = stored?.filter(
      (id, index): id is SectionId => known.has(id) && stored.indexOf(id) === index,
    );
    return [...(restored ?? []), ...DEFAULT_SECTION_ORDER.filter((id) => !restored?.includes(id))];
  }

  function handleSectionDragStart(event: DragEvent, id: SectionId): void {
    draggingSectionId = id;
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", id);
    }
  }

  function clearSectionDragState(): void {
    draggingSectionId = null;
    dropAnchorId = null;
  }

  function headerRectFor(section: HTMLElement): DOMRect | null {
    return (
      section
        .querySelector<HTMLElement>(":scope > section > [data-accordion-header]")
        ?.getBoundingClientRect() ?? null
    );
  }

  function handleSectionDragOver(event: DragEvent, id: SectionId): void {
    if (draggingSectionId === null || draggingSectionId === id) return;
    const section = event.currentTarget as HTMLElement;
    const headerRect = headerRectFor(section);
    if (!headerRect) return;

    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    dropAnchorId = id;
    dropBefore = event.clientY < headerRect.top + headerRect.height / 2;
    dropLineOffset =
      (dropBefore ? headerRect.top : headerRect.bottom) - section.getBoundingClientRect().top;
  }

  function handleSectionDragLeave(event: DragEvent, id: SectionId): void {
    const section = event.currentTarget as HTMLElement;
    if (event.relatedTarget instanceof Node && section.contains(event.relatedTarget)) return;
    if (dropAnchorId === id) dropAnchorId = null;
  }

  function handleSectionDrop(event: DragEvent, anchorId: SectionId): void {
    event.preventDefault();
    const draggedId = draggingSectionId;
    const headerRect = headerRectFor(event.currentTarget as HTMLElement);
    const before = headerRect ? event.clientY < headerRect.top + headerRect.height / 2 : dropBefore;
    clearSectionDragState();
    if (draggedId === null || draggedId === anchorId) return;

    const reduced = sectionOrder.filter((id) => id !== draggedId);
    const anchorIndex = reduced.indexOf(anchorId);
    if (anchorIndex === -1) return;
    moveSection(draggedId, before ? anchorIndex : anchorIndex + 1);
  }

  function handleSectionGripKeydown(event: KeyboardEvent, id: SectionId): void {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    event.preventDefault();
    const currentIndex = sectionOrder.indexOf(id);
    const nextIndex = currentIndex + (event.key === "ArrowUp" ? -1 : 1);
    if (currentIndex === -1 || nextIndex < 0 || nextIndex >= sectionOrder.length) return;
    moveSection(id, nextIndex);
  }

  function moveSection(id: SectionId, index: number): void {
    const currentIndex = sectionOrder.indexOf(id);
    if (currentIndex === -1 || currentIndex === index) return;
    const reordered = sectionOrder.filter((sectionId) => sectionId !== id);
    reordered.splice(index, 0, id);
    sectionOrder = reordered;
    uiLayoutStore.setPanelOrder(sectionOrder);
    moveAnnouncement = `${SECTION_LABELS[id]} moved to position ${index + 1} of ${sectionOrder.length}`;
  }

  function upscale(): void {
    prompt = autoFormatPromptSpacing(prompt);
    negativePrompt = autoFormatPromptSpacing(negativePrompt);
    void controller.upscale({
      ...effectivePrompts(),
      denoisingStrength: upscaleDenoisingStrength,
      steps: upscaleAdvancedEnabled ? upscaleSteps : steps,
      cfgScale: upscaleAdvancedEnabled ? upscaleCfgScale : cfgScale,
      samplerName: upscaleAdvancedEnabled ? upscaleSamplerName : samplerName,
      scheduler: upscaleAdvancedEnabled ? upscaleScheduler : scheduler,
      modelName: modelOptionsLoaded ? modelName : "",
      moduleNames: modelOptionsLoaded ? moduleNames : null,
      upscalerName,
      sizeMultiplier: upscaleMultiplier,
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
    await controller.loadOptions();
    try {
      extensionManifests = await fetchExtensionManifests();
      const defaults = deriveDefaultExtensionValues(extensionManifests);
      extensionValues = restoredExtensionValues
        ? mergeExtensionValues(defaults, restoredExtensionValues)
        : defaults;
    } catch (error) {
      console.warn("[ultra-paint] could not load extension manifests:", error);
      // Keep stored values in the snapshot so a failed fetch can't wipe them.
      extensionValues = (restoredExtensionValues ?? {}) as Record<string, ExtensionValues>;
    }
    // Only now is the snapshot complete enough to save.
    persistenceReady = true;
  }

  function settingsSnapshot(): Record<string, unknown> {
    return {
      version: 1,
      prompt,
      negativePrompt,
      negativeEnabled,
      selectedStyles: [...stylesStore.selected],
      samplerName,
      scheduler,
      modelName,
      moduleNames,
      steps,
      cfgScale,
      denoisingStrength,
      upscalerName,
      upscaleMultiplier,
      upscaleDenoisingStrength,
      upscaleAdvancedEnabled,
      upscaleSteps,
      upscaleCfgScale,
      upscaleSamplerName,
      upscaleScheduler,
      selectedLoras,
      extensions: extensionValues,
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
    // A handed-off copy's settings are stale; the tab that took over owns them.
    if (!persistenceReady || isHandedOff()) return;
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
    prompt = stringValue(stored.prompt, prompt);
    negativePrompt = stringValue(stored.negativePrompt, negativePrompt);
    negativeEnabled = stored.negativeEnabled !== false;
    if (Array.isArray(stored.selectedStyles)) {
      stylesStore.selected = stored.selectedStyles.filter(
        (name): name is string => typeof name === "string",
      );
    }
    samplerName = stringValue(stored.samplerName, samplerName);
    scheduler = stringValue(stored.scheduler, scheduler);
    modelName = stringValue(stored.modelName, modelName);
    moduleNames = stringArray(stored.moduleNames);
    steps = numberValue(stored.steps, steps, 1, 150, true);
    cfgScale = numberValue(stored.cfgScale, cfgScale, 1, 30);
    denoisingStrength = numberValue(stored.denoisingStrength, denoisingStrength, 0, 1);
    upscalerName = stringValue(stored.upscalerName, upscalerName);
    upscaleMultiplier = numberValue(stored.upscaleMultiplier, upscaleMultiplier, 0.25, 4);
    upscaleDenoisingStrength = numberValue(
      stored.upscaleDenoisingStrength,
      upscaleDenoisingStrength,
      0,
      1,
    );
    upscaleAdvancedEnabled =
      typeof stored.upscaleAdvancedEnabled === "boolean"
        ? stored.upscaleAdvancedEnabled
        : upscaleAdvancedEnabled;
    upscaleSteps = numberValue(stored.upscaleSteps, upscaleSteps, 1, 150, true);
    upscaleCfgScale = numberValue(stored.upscaleCfgScale, upscaleCfgScale, 1, 30);
    upscaleSamplerName = stringValue(stored.upscaleSamplerName, upscaleSamplerName);
    upscaleScheduler = stringValue(stored.upscaleScheduler, upscaleScheduler);
    selectedLoras = selectedLoraArray(stored.selectedLoras);
    restoredExtensionValues = extensionValuesRecord(stored.extensions);
    if (isRecord(stored.generationSettings)) {
      generationSettingsStore.restore(stored.generationSettings);
    }
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function extensionValuesRecord(value: unknown): Record<string, Record<string, unknown>> | null {
    if (!isRecord(value)) return null;
    const result: Record<string, Record<string, unknown>> = {};
    for (const [id, entry] of Object.entries(value)) {
      if (isRecord(entry) && typeof entry.enabled === "boolean") {
        result[id] = entry;
      }
    }
    return result;
  }

  function mergeExtensionValues(
    defaults: Record<string, ExtensionValues>,
    restored: Record<string, Record<string, unknown>>,
  ): Record<string, ExtensionValues> {
    return Object.fromEntries(
      Object.entries(defaults).map(([id, defaultValues]) => [
        id,
        restored[id] ? { ...defaultValues, ...restored[id] } : defaultValues,
      ]),
    );
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
  aria-label="Generation"
>
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
    progressPercent={generationRuntimeStore.progressPercent}
    onGenerate={generate}
    onCancelCurrent={() => void controller.cancelCurrent()}
    onCancelRemaining={() => controller.cancelRemaining()}
    onCancelAll={() => void controller.cancelAll()}
  />

  <div
    class="-mx-3 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3"
    style="scrollbar-gutter: stable;"
  >
    <p class="m-0 text-(--upaint-text-muted)" role="status">
      Generation mode: {generationMode === "txt2img" ? "Text to image" : "Image to image"}
    </p>

    <PromptFields bind:prompt bind:negativePrompt bind:negativeEnabled />

    <div class="-mx-3 flex flex-col">
      {#each visibleSectionOrder as id (id)}
        <div
          class={`relative ${draggingSectionId === id ? "opacity-40" : ""}`}
          style="transition: opacity var(--upaint-transition);"
          data-generation-section={id}
          role="group"
          aria-label={`${SECTION_LABELS[id]} generation section`}
          animate:flip={{ duration: prefersReducedMotion ? 0 : 160 }}
          ondragover={(event) => handleSectionDragOver(event, id)}
          ondragleave={(event) => handleSectionDragLeave(event, id)}
          ondrop={(event) => handleSectionDrop(event, id)}
        >
          {#snippet headerLeading()}
            <button
              type="button"
              class="flex h-6 w-5 cursor-grab items-center justify-center border-0 bg-transparent p-0 text-(--upaint-text-muted) focus-visible:outline-2 focus-visible:outline-(--upaint-accent) active:cursor-grabbing"
              draggable="true"
              aria-label={`Move ${SECTION_LABELS[id]} section`}
              aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
              title={`Move ${SECTION_LABELS[id]} section`}
              ondragstart={(event) => handleSectionDragStart(event, id)}
              ondragend={clearSectionDragState}
              onkeydown={(event) => handleSectionGripKeydown(event, id)}
            >
              <Icon name="grip" />
            </button>
          {/snippet}

          {#if dropAnchorId === id}
            <span
              class="pointer-events-none absolute right-1 left-1 z-10 h-0.5 bg-(--upaint-accent)"
              style={`top: ${dropLineOffset}px; border-radius: var(--upaint-radius-sm);`}
              aria-hidden="true"
            ></span>
          {/if}

          {#if id === "generation.model"}
            <Accordion open title="Model" persistKey={id} {headerLeading}>
              <div class="p-2">
                <ModelControls {models} {modules} bind:modelName bind:moduleNames />
              </div>
            </Accordion>
          {:else if id === "generation.bounding-box"}
            <Accordion title="Bounding Box" persistKey={id} {headerLeading}>
              <div class="p-2">
                <BoundaryBoxControls
                  scaleMode={generationSettingsStore.scaleMode}
                  autoBaseWidth={generationSettingsStore.autoBaseWidth}
                  manualWidth={generationSettingsStore.manualWidth}
                  manualHeight={generationSettingsStore.manualHeight}
                  onScaleModeChange={(value) => generationSettingsStore.setScaleMode(value)}
                  onAutoBaseWidthChange={(value) => generationSettingsStore.setAutoBaseWidth(value)}
                  onManualWidthChange={(value) => generationSettingsStore.setManualWidth(value)}
                  onManualHeightChange={(value) => generationSettingsStore.setManualHeight(value)}
                />
              </div>
            </Accordion>
          {:else if id === "generation.loras"}
            <Accordion title="LoRAs" count={enabledLoraCount} persistKey={id} {headerLeading}>
              <div class="p-2">
                <LoraControls
                  {selectedLoras}
                  onSelectedLorasChange={(value) => (selectedLoras = value)}
                  onAddActivationWords={addActivationWords}
                />
              </div>
            </Accordion>
          {:else if id === "generation.sampling"}
            <Accordion open title="Sampling" persistKey={id} {headerLeading}>
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
          {:else if id === "generation.composition"}
            <Accordion title="Composition" persistKey={id} {headerLeading}>
              <div class="p-2">
                <InpaintControls
                  softInpaintingAvailable={features.softInpainting}
                  controlNetAvailable={features.controlnet}
                  maskBlur={generationSettingsStore.maskBlur}
                  inpaintPadding={generationSettingsStore.inpaintPadding}
                  inpaintArea={generationSettingsStore.inpaintArea}
                  softInpaintingEnabled={generationSettingsStore.softInpaintingEnabled}
                  inpaintControlNetEnabled={generationSettingsStore.inpaintControlNetEnabled}
                  inpaintControlNetModel={generationSettingsStore.inpaintControlNetModel}
                  inpaintControlNetWeight={generationSettingsStore.inpaintControlNetWeight}
                  coherenceEdgeSize={generationSettingsStore.coherenceEdgeSize}
                  coherenceAlgorithm={generationSettingsStore.coherenceAlgorithm}
                  onMaskBlurChange={(value) => generationSettingsStore.setMaskBlur(value)}
                  onInpaintPaddingChange={(value) =>
                    generationSettingsStore.setInpaintPadding(value)}
                  onInpaintAreaChange={(value) => generationSettingsStore.setInpaintArea(value)}
                  onSoftInpaintingChange={(value) =>
                    generationSettingsStore.setSoftInpaintingEnabled(value)}
                  onInpaintControlNetEnabledChange={(value) =>
                    generationSettingsStore.setInpaintControlNetEnabled(value)}
                  onInpaintControlNetModelChange={(value) =>
                    generationSettingsStore.setInpaintControlNetModel(value)}
                  onInpaintControlNetWeightChange={(value) =>
                    generationSettingsStore.setInpaintControlNetWeight(value)}
                  onCoherenceEdgeSizeChange={(value) =>
                    generationSettingsStore.setCoherenceEdgeSize(value)}
                  onCoherenceAlgorithmChange={(value) =>
                    generationSettingsStore.setCoherenceAlgorithm(value)}
                />
              </div>
            </Accordion>
          {:else if id === "generation.extensions"}
            <Accordion title="Extensions" persistKey={id} {headerLeading}>
              <div class="pl-2">
                <ExtensionSection
                  manifests={extensionManifests}
                  values={extensionValues}
                  onValuesChange={(next) => (extensionValues = next)}
                />
              </div>
            </Accordion>
          {:else}
            <Accordion title="Upscale" persistKey={id} {headerLeading}>
              <div class="flex flex-col gap-3 p-2">
                <label class="flex min-w-0 flex-col gap-1 text-(--upaint-text-muted)">
                  Upscaler
                  <Select bind:value={upscalerName}>
                    <option value="">Default</option>
                    {#each upscalers as upscalerOption (upscalerOption)}
                      <option value={upscalerOption}>{upscalerOption}</option>
                    {/each}
                  </Select>
                </label>

                <SliderNumberInput
                  label="Size multiplier"
                  bind:value={upscaleMultiplier}
                  min={0.25}
                  max={4}
                  sliderStep={0.25}
                  numberStep={0.25}
                />

                <SliderNumberInput
                  label="Denoising strength"
                  bind:value={upscaleDenoisingStrength}
                  min={0}
                  max={1}
                  sliderStep={0.01}
                />

                <Accordion title="Advanced">
                  {#snippet headerActions()}
                    <label
                      class="flex cursor-pointer items-center gap-1 text-[11px] text-(--upaint-text-muted)"
                    >
                      <input
                        type="checkbox"
                        bind:checked={upscaleAdvancedEnabled}
                        class="m-0 h-3.5 w-3.5 accent-(--upaint-accent) focus-visible:ring-2 focus-visible:ring-(--upaint-accent)"
                      />
                      Enabled
                    </label>
                  {/snippet}

                  <div class="flex flex-col gap-2 p-2">
                    <div class="grid grid-cols-2 gap-2">
                      <label class="flex min-w-0 flex-col gap-1 text-(--upaint-text-muted)">
                        Sampler
                        <Select bind:value={upscaleSamplerName} disabled={!upscaleAdvancedEnabled}>
                          <option value="">Default</option>
                          {#each samplers as sampler (sampler)}
                            <option value={sampler}>{sampler}</option>
                          {/each}
                        </Select>
                      </label>

                      <label class="flex min-w-0 flex-col gap-1 text-(--upaint-text-muted)">
                        Scheduler
                        <Select bind:value={upscaleScheduler} disabled={!upscaleAdvancedEnabled}>
                          <option value="">Default</option>
                          {#each schedulers as schedulerOption (schedulerOption)}
                            <option value={schedulerOption}>{schedulerOption}</option>
                          {/each}
                        </Select>
                      </label>
                    </div>

                    <SliderNumberInput
                      label="Steps"
                      bind:value={upscaleSteps}
                      min={1}
                      max={150}
                      sliderStep={1}
                      disabled={!upscaleAdvancedEnabled}
                    />

                    <SliderNumberInput
                      label="CFG scale"
                      bind:value={upscaleCfgScale}
                      min={1}
                      max={30}
                      sliderStep={0.5}
                      disabled={!upscaleAdvancedEnabled}
                    />
                  </div>
                </Accordion>

                <Button
                  variant="primary"
                  class="w-full"
                  onclick={upscale}
                  disabled={generationRuntimeStore.generating}
                >
                  Upscale
                </Button>
              </div>
            </Accordion>
          {/if}
        </div>
      {/each}
    </div>

    <p class="sr-only" aria-live="polite" aria-atomic="true">{moveAnnouncement}</p>
  </div>
</section>

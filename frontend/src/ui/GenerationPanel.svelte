<script lang="ts">
  import { onDestroy, onMount } from "svelte";

  import { generationSettingsStore } from "../state/generationSettingsStore.svelte";
  import { layerStore } from "../state/layerStore.svelte";
  import { registerGenerationActions } from "../input/actionMap";
  import { calculateAutoResolution, type Resolution } from "../util/autoResolution";
  import Accordion from "./lib/Accordion.svelte";
  import GenerationActionsAndStatus from "./generation/GenerationActionsAndStatus.svelte";
  import InpaintControls from "./generation/InpaintControls.svelte";
  import LoraControls from "./generation/LoraControls.svelte";
  import PromptFields from "./generation/PromptFields.svelte";
  import ResolutionSettings from "./generation/ResolutionSettings.svelte";
  import SamplingControls from "./generation/SamplingControls.svelte";
  import { createGenerationController } from "./generation/generationController.svelte";
  import type { GenerationOptions, ProgressResponse } from "./generation/generationApi";
  import {
    buildLoraPrompt,
    type SelectedLora,
  } from "./generation/lora";

  let prompt = $state("");
  let negativePrompt = $state("");
  let samplers = $state<string[]>([]);
  let schedulers = $state<string[]>([]);
  let samplerName = $state("");
  let scheduler = $state("");
  let resolutionStep = $state<number | null>(null);
  let isVideoModel = $state(false);
  let steps = $state(20);
  let cfgScale = $state(7);
  let denoisingStrength = $state(0.75);
  let generating = $state(false);
  let saving = $state(false);
  let interrupting = $state(false);
  let errorMessage = $state<string | null>(null);
  let saveMessage = $state<string | null>(null);
  let progress = $state<ProgressResponse | null>(null);
  let selectedLoras = $state<SelectedLora[]>([]);

  const enabledLoraCount = $derived(
    selectedLoras.filter((lora) => lora.enabled).length,
  );

  const progressPercent = $derived.by(() => {
    const total = progress?.sampling_steps ?? 0;
    const current = progress?.sampling_step ?? 0;
    if (total <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((current / total) * 100)));
  });

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

  const generationMode = $derived(
    layerStore.hasVisibleRasterContent ? "img2img" : "txt2img",
  );

  const controller = createGenerationController({
    get generating() {
      return generating;
    },
    get saving() {
      return saving;
    },
    get interrupting() {
      return interrupting;
    },
    setGenerating(value) {
      generating = value;
    },
    setSaving(value) {
      saving = value;
    },
    setInterrupting(value) {
      interrupting = value;
    },
    setErrorMessage(value) {
      errorMessage = value;
    },
    setSaveMessage(value) {
      saveMessage = value;
    },
    setProgress(value) {
      progress = value;
    },
    setOptions(value: GenerationOptions) {
      samplers = value.samplers;
      schedulers = value.schedulers;
      resolutionStep = value.resolutionStep;
      isVideoModel = value.isVideoModel;
    },
  });

  onMount(() => {
    void controller.loadOptions();
    return registerGenerationActions({
      isGenerating: () => generating,
      generate,
      cancel: () => void controller.cancelGeneration(),
    });
  });

  onDestroy(() => {
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
      samplerName,
      scheduler,
      targetResolution: selectedTargetResolution,
      scaleMode: generationSettingsStore.scaleMode,
    });
  }

  function addActivationWords(value: string): void {
    const words = value.trim();
    if (!words) return;
    prompt = [prompt.trim(), words].filter(Boolean).join(", ");
  }
</script>

<section
  class="box-border flex h-full w-full flex-col gap-3 p-3 text-xs"
  style="color: var(--upaint-text); font-family: var(--upaint-font);"
  aria-labelledby="upaint-generation-title"
>
  <header class="border-b pb-2" style="border-color: var(--upaint-border);">
    <h2 id="upaint-generation-title" class="m-0 text-sm font-semibold">
      Generation
    </h2>
  </header>

  {#if isVideoModel}
    <p
      class="m-0 border px-2 py-1.5 text-xs text-(--upaint-danger)"
      style="border-color: var(--upaint-danger); border-radius: var(--upaint-radius-sm);"
      role="alert"
    >
      A Wan/video model is loaded. Generate will be rejected; select a supported
      image model first.
    </p>
  {/if}

  <GenerationActionsAndStatus
    {generating}
    {saving}
    {interrupting}
    {progress}
    {progressPercent}
    {saveMessage}
    {errorMessage}
    onGenerate={generate}
    onSave={() => void controller.saveImage()}
    onCancel={() => void controller.cancelGeneration()}
  />

  <p class="m-0 text-(--upaint-text-muted)" role="status">
    Generation mode: {generationMode === "txt2img" ? "Text to image" : "Image to image"}
  </p>

  <PromptFields bind:prompt bind:negativePrompt />

  <Accordion title="LoRAs" count={enabledLoraCount}>
    <LoraControls
      {selectedLoras}
      onSelectedLorasChange={(value) => (selectedLoras = value)}
      onAddActivationWords={addActivationWords}
    />
  </Accordion>

  <Accordion open title="Sampling" >
    <SamplingControls
      {samplers}
      {schedulers}
      bind:samplerName
      bind:scheduler
      bind:steps
      bind:cfgScale
      bind:denoisingStrength
      denoisingDisabled={generationMode === "txt2img"}
    />
  </Accordion>

  <Accordion title="Bounding Box">
    <ResolutionSettings
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
  </Accordion>

  <Accordion title="Inpainting" >
    <InpaintControls
      maskBlur={generationSettingsStore.maskBlur}
      inpaintPadding={generationSettingsStore.inpaintPadding}
      inpaintArea={generationSettingsStore.inpaintArea}
      softInpaintingEnabled={generationSettingsStore.softInpaintingEnabled}
      inpaintControlNetEnabled={generationSettingsStore.inpaintControlNetEnabled}
      inpaintControlNetModel={generationSettingsStore.inpaintControlNetModel}
      inpaintControlNetWeight={generationSettingsStore.inpaintControlNetWeight}
      coherenceEdgeSize={generationSettingsStore.coherenceEdgeSize}
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
      onCoherenceEdgeSizeChange={(value) =>
        generationSettingsStore.setCoherenceEdgeSize(value)}
    />
  </Accordion>
</section>

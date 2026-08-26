<script lang="ts">
  import type { InpaintArea } from "../../state/generationSettingsStore.svelte";

  interface Props {
    maskBlur: number;
    inpaintPadding: number;
    inpaintArea: InpaintArea;
    softInpaintingEnabled: boolean;
    inpaintControlNetEnabled: boolean;
    inpaintControlNetModel: string;
    inpaintControlNetWeight: number;
    coherenceEdgeSize: number;
    coherencePassFast: boolean;
    onMaskBlurChange: (value: number) => void;
    onInpaintPaddingChange: (value: number) => void;
    onInpaintAreaChange: (value: InpaintArea) => void;
    onSoftInpaintingChange: (value: boolean) => void;
    onInpaintControlNetEnabledChange: (value: boolean) => void;
    onInpaintControlNetModelChange: (value: string) => void;
    onInpaintControlNetWeightChange: (value: number) => void;
    onCoherenceEdgeSizeChange: (value: number) => void;
    onCoherencePassFastChange: (value: boolean) => void;
  }

  import SliderNumberInput from "../lib/SliderNumberInput.svelte";
  import { fetchControlModels } from "./controlnetApi";

  let {
    maskBlur,
    inpaintPadding,
    inpaintArea,
    softInpaintingEnabled,
    inpaintControlNetEnabled,
    inpaintControlNetModel,
    inpaintControlNetWeight,
    coherenceEdgeSize,
    coherencePassFast,
    onMaskBlurChange,
    onInpaintPaddingChange,
    onInpaintAreaChange,
    onSoftInpaintingChange,
    onInpaintControlNetEnabledChange,
    onInpaintControlNetModelChange,
    onInpaintControlNetWeightChange,
    onCoherenceEdgeSizeChange,
    onCoherencePassFastChange,
  }: Props = $props();

  let controlModels = $state<string[]>([]);
  let controlModelsFetched = $state(false);

  $effect(() => {
    void fetchControlModels().then((models) => {
      controlModels = models;
      controlModelsFetched = true;
    });
  });

  function handleAreaChange(event: Event): void {
    const value = (event.currentTarget as HTMLSelectElement).value;
    if (value === "whole" || value === "masked" || value === "coherence") {
      onInpaintAreaChange(value);
    }
  }
</script>

<label class="flex flex-col gap-1 text-(--upaint-text-muted)">
  Inpaint area
  <select
    class="border bg-(--upaint-surface) px-2 py-1.5 text-xs text-(--upaint-text) outline-none focus:border-(--upaint-accent)"
    style="border-color: var(--upaint-border); border-radius: var(--upaint-radius-sm);"
    value={inpaintArea}
    onchange={handleAreaChange}
  >
    <option value="whole">Whole BB</option>
    <option value="masked">Only masked</option>
    <option value="coherence">Coherence Pass</option>
  </select>
</label>

<SliderNumberInput label="Mask blur" value={maskBlur} min={0} max={64} sliderStep={4} numberStep={1} onValueInput={onMaskBlurChange} />

{#if inpaintArea === "masked"}
  <SliderNumberInput label="Context padding" value={inpaintPadding} min={0} max={256} sliderStep={8} numberStep={1} onValueInput={onInpaintPaddingChange} />
{:else if inpaintArea === "coherence"}
  <SliderNumberInput label="Edge size" value={coherenceEdgeSize} min={0} max={256} sliderStep={8} numberStep={1} onValueInput={onCoherenceEdgeSizeChange} />
  <label class="flex cursor-pointer items-center gap-2 text-(--upaint-text-muted)">
    <input
      class="m-0 h-4 w-4 accent-(--upaint-accent)"
      type="checkbox"
      checked={coherencePassFast}
      onchange={(event) => onCoherencePassFastChange(event.currentTarget.checked)}
    />
    Fast (latent-space, experimental)
  </label>
{/if}

{#if inpaintArea !== "coherence"}
  <label class="flex cursor-pointer items-center gap-2 text-(--upaint-text-muted)">
    <input class="m-0 h-4 w-4 accent-(--upaint-accent)" type="checkbox" checked={softInpaintingEnabled} onchange={(event) => onSoftInpaintingChange(event.currentTarget.checked)} />
    Soft inpainting
  </label>
{/if}

<label class="flex cursor-pointer items-center gap-2 text-(--upaint-text-muted)">
  <input
    class="m-0 h-4 w-4 accent-(--upaint-accent)"
    type="checkbox"
    checked={inpaintControlNetEnabled}
    onchange={(event) => onInpaintControlNetEnabledChange(event.currentTarget.checked)}
  />
  Inpaint ControlNet (Anima LLLite, etc.)
</label>

{#if inpaintControlNetEnabled}
  <label class="flex flex-col gap-1 text-(--upaint-text-muted)">
    Inpaint ControlNet model
    <select
      class="border bg-(--upaint-surface) px-2 py-1.5 text-xs text-(--upaint-text) outline-none focus:border-(--upaint-accent)"
      style="border-color: var(--upaint-border); border-radius: var(--upaint-radius-sm);"
      value={inpaintControlNetModel}
      onchange={(event) =>
        onInpaintControlNetModelChange((event.currentTarget as HTMLSelectElement).value)}
    >
      <option value="">None</option>
      {#if inpaintControlNetModel && !controlModels.includes(inpaintControlNetModel)}
        <option value={inpaintControlNetModel}>{inpaintControlNetModel}</option>
      {/if}
      {#each controlModels as model (model)}
        <option value={model}>{model}</option>
      {/each}
    </select>
    <span class="text-[11px]">
      Uses the composited inpaint mask directly -- no control layer needed. Most models don't
      need this; a few (Anima's LLLite Inpaint Adapter) require it.
    </span>
    {#if controlModelsFetched && controlModels.length === 0}
      <p class="m-0 text-[11px] text-(--upaint-danger)">
        No ControlNet models found -- is a ControlNet model installed, and is the ControlNet
        extension enabled?
      </p>
    {/if}
  </label>

  <SliderNumberInput
    label="Inpaint ControlNet weight"
    value={inpaintControlNetWeight}
    min={-2}
    max={2}
    sliderStep={0.05}
    numberStep={0.05}
    onValueInput={onInpaintControlNetWeightChange}
  />
{/if}

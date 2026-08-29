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
    onMaskBlurChange: (value: number) => void;
    onInpaintPaddingChange: (value: number) => void;
    onInpaintAreaChange: (value: InpaintArea) => void;
    onSoftInpaintingChange: (value: boolean) => void;
    onInpaintControlNetEnabledChange: (value: boolean) => void;
    onInpaintControlNetModelChange: (value: string) => void;
    onInpaintControlNetWeightChange: (value: number) => void;
    onCoherenceEdgeSizeChange: (value: number) => void;
  }

  import CheckboxField from "../lib/CheckboxField.svelte";
  import Select from "../lib/Select.svelte";
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
    onMaskBlurChange,
    onInpaintPaddingChange,
    onInpaintAreaChange,
    onSoftInpaintingChange,
    onInpaintControlNetEnabledChange,
    onInpaintControlNetModelChange,
    onInpaintControlNetWeightChange,
    onCoherenceEdgeSizeChange,
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

<div class="flex flex-col gap-2">
  <label class="flex flex-col gap-1 text-(--upaint-text-muted)">
    Inpaint area
    <Select surface="base" value={inpaintArea} onchange={handleAreaChange}>
      <option value="whole">Whole BB</option>
      <option value="masked">Only masked</option>
      <option value="coherence">Coherence Pass</option>
    </Select>
  </label>

  <SliderNumberInput
    label="Mask blur"
    value={maskBlur}
    min={0}
    max={64}
    sliderStep={4}
    numberStep={1}
    onValueInput={onMaskBlurChange}
  />

  {#if inpaintArea === "masked"}
    <SliderNumberInput
      label="Context padding"
      value={inpaintPadding}
      min={0}
      max={256}
      sliderStep={8}
      numberStep={1}
      onValueInput={onInpaintPaddingChange}
    />
  {:else if inpaintArea === "coherence"}
    <SliderNumberInput
      label="Edge size"
      value={coherenceEdgeSize}
      min={0}
      max={256}
      sliderStep={8}
      numberStep={1}
      onValueInput={onCoherenceEdgeSizeChange}
    />
  {/if}

  {#if inpaintArea !== "coherence"}
    <CheckboxField
      label="Soft inpainting"
      checked={softInpaintingEnabled}
      onchange={(event) => onSoftInpaintingChange(event.currentTarget.checked)}
    />
  {/if}

  <CheckboxField
    label="Inpaint ControlNet"
    checked={inpaintControlNetEnabled}
    onchange={(event) => onInpaintControlNetEnabledChange(event.currentTarget.checked)}
  />

  {#if inpaintControlNetEnabled}
    <label class="flex flex-col gap-1 text-(--upaint-text-muted)">
      Inpaint ControlNet model
      <Select
        surface="base"
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
      </Select>
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
</div>

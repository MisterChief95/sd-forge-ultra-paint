<script lang="ts">
  interface Props {
    samplers: string[];
    schedulers: string[];
    samplerName: string;
    scheduler: string;
    steps: number;
    cfgScale: number;
    denoisingStrength: number;
    denoisingDisabled?: boolean;
  }

  import SliderNumberInput from "../lib/SliderNumberInput.svelte";

  let {
    samplers,
    schedulers,
    samplerName = $bindable(),
    scheduler = $bindable(),
    steps = $bindable(),
    cfgScale = $bindable(),
    denoisingStrength = $bindable(),
    denoisingDisabled = false,
  }: Props = $props();
</script>

<div class="grid grid-cols-2 gap-2">
  <label class="flex min-w-0 flex-col gap-1 text-(--upaint-text-muted)">
    Sampler
    <select bind:value={samplerName} class="min-w-0 border bg-(--upaint-surface-raised) px-2 py-1.5 text-xs text-(--upaint-text) outline-none focus:border-(--upaint-accent)" style="border-color: var(--upaint-border); border-radius: var(--upaint-radius-sm);">
      <option value="">Default</option>
      {#each samplers as sampler (sampler)}
        <option value={sampler}>{sampler}</option>
      {/each}
    </select>
  </label>

  <label class="flex min-w-0 flex-col gap-1 text-(--upaint-text-muted)">
    Scheduler
    <select bind:value={scheduler} class="min-w-0 border bg-(--upaint-surface-raised) px-2 py-1.5 text-xs text-(--upaint-text) outline-none focus:border-(--upaint-accent)" style="border-color: var(--upaint-border); border-radius: var(--upaint-radius-sm);">
      <option value="">Default</option>
      {#each schedulers as schedulerOption (schedulerOption)}
        <option value={schedulerOption}>{schedulerOption}</option>
      {/each}
    </select>
  </label>
</div>

<SliderNumberInput label="Steps" bind:value={steps} min={1} max={150} sliderStep={1} />

<SliderNumberInput label="CFG scale" bind:value={cfgScale} min={1} max={30} sliderStep={0.5} />

<SliderNumberInput label="Denoising strength" bind:value={denoisingStrength} min={0} max={1} sliderStep={0.01} disabled={denoisingDisabled} />

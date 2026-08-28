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
    seedMode: SeedMode;
    seedValue: number;
    onSeedModeChange: (mode: SeedMode) => void;
    onSeedValueChange: (value: number) => void;
  }

  import type { SeedMode } from "../../state/generationSettingsStore.svelte";
  import Button from "../lib/Button.svelte";
  import NumberInput from "../lib/NumberInput.svelte";
  import Select from "../lib/Select.svelte";
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
    seedMode,
    seedValue,
    onSeedModeChange,
    onSeedValueChange,
  }: Props = $props();

  function toggleSeedMode(mode: "random" | "reuse"): void {
    onSeedModeChange(seedMode === mode ? "manual" : mode);
  }
</script>

<div class="flex flex-col gap-2">
  <div class="grid grid-cols-2 gap-2">
    <label class="flex min-w-0 flex-col gap-1 text-(--upaint-text-muted)">
      Sampler
      <Select bind:value={samplerName}>
        <option value="">Default</option>
        {#each samplers as sampler (sampler)}
          <option value={sampler}>{sampler}</option>
        {/each}
      </Select>
    </label>

    <label class="flex min-w-0 flex-col gap-1 text-(--upaint-text-muted)">
      Scheduler
      <Select bind:value={scheduler}>
        <option value="">Default</option>
        {#each schedulers as schedulerOption (schedulerOption)}
          <option value={schedulerOption}>{schedulerOption}</option>
        {/each}
      </Select>
    </label>
  </div>

  <SliderNumberInput label="Steps" bind:value={steps} min={1} max={150} sliderStep={1} />

  <SliderNumberInput label="CFG scale" bind:value={cfgScale} min={1} max={30} sliderStep={0.5} />

  <SliderNumberInput
    label="Denoising strength"
    bind:value={denoisingStrength}
    min={0}
    max={1}
    sliderStep={0.01}
    disabled={denoisingDisabled}
  />

  <div class="flex flex-col gap-1 text-(--upaint-text-muted)">
    Seed
    <div class="flex items-center gap-1">
      <NumberInput
        class="flex-1"
        step="1"
        value={seedValue}
        disabled={seedMode !== "manual"}
        aria-label="Seed value"
        oninput={(event) =>
          onSeedValueChange(Number((event.currentTarget as HTMLInputElement).value))}
      />
      <Button
        size="icon"
        pressed={seedMode === "random"}
        title="Random seed each generation"
        aria-label="Random seed each generation"
        onclick={() => toggleSeedMode("random")}
      >
        <svg
          class="h-3.5 w-3.5"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.3"
          aria-hidden="true"
        >
          <rect x="2.25" y="2.25" width="11.5" height="11.5" rx="1.5" />
          <circle cx="5.25" cy="5.25" r="0.85" fill="currentColor" stroke="none" />
          <circle cx="10.75" cy="5.25" r="0.85" fill="currentColor" stroke="none" />
          <circle cx="5.25" cy="10.75" r="0.85" fill="currentColor" stroke="none" />
          <circle cx="10.75" cy="10.75" r="0.85" fill="currentColor" stroke="none" />
          <circle cx="8" cy="8" r="0.85" fill="currentColor" stroke="none" />
        </svg>
      </Button>
      <Button
        size="icon"
        pressed={seedMode === "reuse"}
        title="Reuse this exact seed every generation"
        aria-label="Reuse this exact seed every generation"
        onclick={() => toggleSeedMode("reuse")}
      >
        <svg
          class="h-3.5 w-3.5"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.3"
          aria-hidden="true"
        >
          <path d="M8 2.25a5.75 5.75 0 0 1 5.4 3.75" stroke-linecap="round" />
          <path d="M13.75 4.25v2.5h-2.5" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M8 13.75a5.75 5.75 0 0 1-5.4-3.75" stroke-linecap="round" />
          <path d="M2.25 11.75v-2.5h2.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </Button>
    </div>
  </div>
</div>

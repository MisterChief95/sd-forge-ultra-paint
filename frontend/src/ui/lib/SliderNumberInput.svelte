<script lang="ts">
  import Slider from "./Slider.svelte";

  interface Props {
    label: string;
    value: number;
    min: number;
    max: number;
    sliderStep: number;
    numberStep?: number;
    ariaLabel?: string;
    disabled?: boolean;
    onValueInput?: (value: number) => void;
  }

  let {
    label,
    value = $bindable(),
    min,
    max,
    sliderStep,
    numberStep = sliderStep,
    ariaLabel = label,
    disabled = false,
    onValueInput,
  }: Props = $props();

  function updateValue(next: number): void {
    value = next;
    onValueInput?.(next);
  }

  function handleNumberInput(event: Event): void {
    const next = Number((event.currentTarget as HTMLInputElement).value);
    if (Number.isFinite(next)) updateValue(next);
  }
</script>

<div class="flex w-full min-w-0 flex-col gap-1 text-(--upaint-text-muted)">
  <div class="flex items-baseline justify-between gap-2">
    <span class="min-w-0">{label}</span>
    <input
      class="w-[58px] shrink-0 border bg-(--upaint-surface-raised) px-1.5 py-1 text-right text-xs text-(--upaint-text) outline-none focus:border-(--upaint-accent)"
      style="border-color: var(--upaint-border); border-radius: var(--upaint-radius-sm);"
      type="number"
      {min}
      {max}
      step={numberStep}
      {value}
      {disabled}
      aria-label={ariaLabel}
      oninput={handleNumberInput}
    />
  </div>
  <Slider
    bind:value
    min={min}
    max={max}
    step={sliderStep}
    inputClass="m-0 h-4 w-full cursor-pointer accent-(--upaint-accent)"
    ariaLabel={ariaLabel}
    {disabled}
    onValueInput={onValueInput}
  />
</div>

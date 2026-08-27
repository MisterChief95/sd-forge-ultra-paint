<script lang="ts">
  import NumberInput from "./NumberInput.svelte";
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
    <NumberInput
      class="w-14.5 shrink-0 px-1.5 py-1"
      {min}
      {max}
      step={numberStep}
      bind:value
      {disabled}
      aria-label={ariaLabel}
      oninput={handleNumberInput}
    />
  </div>
  <Slider
    bind:value
    {min}
    {max}
    step={sliderStep}
    inputClass="m-0 h-4 w-full cursor-pointer accent-(--upaint-accent)"
    {ariaLabel}
    {disabled}
    {onValueInput}
  />
</div>

<script lang="ts">
  interface Props {
    value: number;
    min: number;
    max: number;
    step: number;
    inputClass?: string;
    title?: string;
    ariaLabel?: string;
    disabled?: boolean;
    onValueInput?: (value: number) => void;
  }

  let {
    value = $bindable(),
    min,
    max,
    step,
    inputClass = "m-0 h-4 min-w-0 cursor-pointer accent-(--upaint-accent)",
    title,
    ariaLabel,
    disabled = false,
    onValueInput,
  }: Props = $props();

  function handleInput(event: Event): void {
    const next = Number((event.currentTarget as HTMLInputElement).value);
    if (!Number.isFinite(next)) return;
    value = next;
    onValueInput?.(next);
  }
</script>

<input
  class={inputClass}
  type="range"
  {min}
  {max}
  {step}
  {value}
  {title}
  aria-label={ariaLabel}
  {disabled}
  oninput={handleInput}
/>

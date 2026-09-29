<script lang="ts">
  import Select from "../lib/Select.svelte";
  import SliderNumberInput from "../lib/SliderNumberInput.svelte";
  import type { ExtensionInputSpec } from "./extensionsApi";

  interface Props {
    spec: ExtensionInputSpec;
    value: unknown;
    onValueChange: (key: string, value: unknown) => void;
  }

  let { spec, value, onValueChange }: Props = $props();
</script>

{#if spec.type === "number"}
  <SliderNumberInput
    label={spec.label}
    value={value as number}
    min={spec.min ?? 0}
    max={spec.max ?? 100}
    sliderStep={spec.step ?? 1}
    onValueInput={(next) => onValueChange(spec.key, next)}
  />
  {#if spec.info}
    <span class="text-[11px] text-(--upaint-text-muted)">{spec.info}</span>
  {/if}
{:else if spec.type === "boolean"}
  <label class="flex cursor-pointer items-center gap-1 text-[11px] text-(--upaint-text-muted)">
    <input
      type="checkbox"
      checked={value as boolean}
      onchange={(event) => onValueChange(spec.key, event.currentTarget.checked)}
      class="m-0 h-3.5 w-3.5 accent-(--upaint-accent) focus-visible:ring-2 focus-visible:ring-(--upaint-accent)"
    />
    {spec.label}
  </label>
  {#if spec.info}
    <span class="text-[11px] text-(--upaint-text-muted)">{spec.info}</span>
  {/if}
{:else if spec.type === "select"}
  <label class="flex min-w-0 flex-col gap-1 text-(--upaint-text-muted)">
    {spec.label}
    <Select
      value={value as string}
      onchange={(event) =>
        onValueChange(spec.key, (event.currentTarget as HTMLSelectElement).value)}
    >
      {#each spec.options as option (option.value)}
        <option value={option.value}>{option.label}</option>
      {/each}
    </Select>
    {#if spec.info}
      <span class="text-[11px] text-(--upaint-text-muted)">{spec.info}</span>
    {/if}
  </label>
{:else}
  <label class="flex min-w-0 flex-col gap-1 text-(--upaint-text-muted)">
    {spec.label}
    <input
      type="text"
      value={value as string}
      maxlength={spec.maxLength}
      placeholder={spec.placeholder}
      oninput={(event) => onValueChange(spec.key, event.currentTarget.value)}
      class="min-w-0 border border-(--upaint-border) bg-(--upaint-surface-raised) px-2 py-1.5 text-xs text-(--upaint-text) outline-none transition-colors focus:border-(--upaint-accent) focus-visible:ring-2 focus-visible:ring-(--upaint-accent) disabled:cursor-not-allowed disabled:opacity-50"
      style:border-radius="var(--upaint-radius-sm)"
    />
    {#if spec.info}
      <span class="text-[11px] text-(--upaint-text-muted)">{spec.info}</span>
    {/if}
  </label>
{/if}

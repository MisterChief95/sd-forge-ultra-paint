<script lang="ts">
  import type { HTMLInputAttributes } from "svelte/elements";

  type Props = Omit<HTMLInputAttributes, "class" | "type" | "value"> & {
    value?: number;
    surface?: "base" | "raised";
    class?: string;
  };

  let { value = $bindable(), surface = "raised", class: className = "", ...rest }: Props = $props();

  const inputClass = $derived(
    `min-w-0 border border-(--upaint-border) px-2 py-1.5 text-right text-xs tabular-nums text-(--upaint-text) outline-none transition-colors focus:border-(--upaint-accent) focus-visible:ring-2 focus-visible:ring-(--upaint-accent) disabled:cursor-not-allowed disabled:opacity-50 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none ${surface === "base" ? "bg-(--upaint-surface)" : "bg-(--upaint-surface-raised)"} ${className}`,
  );
</script>

<input
  {...rest}
  bind:value
  type="number"
  class={inputClass}
  style:border-radius="var(--upaint-radius-sm)"
/>

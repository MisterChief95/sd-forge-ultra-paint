<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLSelectAttributes } from "svelte/elements";

  type Props = Omit<HTMLSelectAttributes, "children" | "class" | "value"> & {
    value?: string | number;
    surface?: "base" | "raised";
    class?: string;
    children?: Snippet;
  };

  let {
    value = $bindable(),
    surface = "raised",
    class: className = "",
    children,
    ...rest
  }: Props = $props();

  const selectClass = $derived(
    `min-w-0 cursor-pointer border border-(--upaint-border) px-2 py-1.5 text-xs text-(--upaint-text) outline-none transition-colors focus:border-(--upaint-accent) focus-visible:ring-2 focus-visible:ring-(--upaint-accent) disabled:cursor-not-allowed disabled:opacity-50 ${surface === "base" ? "bg-(--upaint-surface)" : "bg-(--upaint-surface-raised)"} ${className}`,
  );
</script>

<select {...rest} bind:value class={selectClass} style:border-radius="var(--upaint-radius-sm)">
  {@render children?.()}
</select>

<script lang="ts">
  import Icon from "./Icon.svelte";

  interface Props {
    label: string;
    /** Longer labels are cut with an ellipsis; the full text stays in the tooltip. */
    maxLength?: number;
    onRemove: () => void;
  }

  let { label, maxLength = 20, onRemove }: Props = $props();

  const shown = $derived(label.length > maxLength ? `${label.slice(0, maxLength)}…` : label);
</script>

<!-- Hover/focus turns the chip red and lays a faint "x" over the label. -->
<button
  type="button"
  class="group relative inline-flex cursor-pointer items-center rounded-full border border-(--upaint-border) bg-(--upaint-surface) px-2 py-0.5 text-[11px] leading-tight text-(--upaint-text) outline-none transition-colors hover:border-(--upaint-danger) hover:bg-(--upaint-danger) focus-visible:border-(--upaint-danger) focus-visible:bg-(--upaint-danger)"
  title={label}
  aria-label={`Remove ${label}`}
  onclick={onRemove}
>
  <span class="transition-opacity group-hover:opacity-40 group-focus-visible:opacity-40"
    >{shown}</span
  >
  <span
    class="pointer-events-none absolute inset-0 flex items-center justify-center text-white opacity-0 transition-opacity group-hover:opacity-70 group-focus-visible:opacity-70"
    aria-hidden="true"
  >
    <Icon name="x" size={12} />
  </span>
</button>

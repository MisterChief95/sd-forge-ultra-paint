<script lang="ts">
  import type { HTMLInputAttributes } from "svelte/elements";

  type Props = Omit<HTMLInputAttributes, "checked" | "class" | "type"> & {
    label: string;
    checked?: boolean;
    class?: string;
  };

  let { label, checked = $bindable(false), class: className = "", ...rest }: Props = $props();
</script>

<label class={`flex cursor-pointer items-center gap-2 text-(--upaint-text-muted) ${className}`}>
  <input
    {...rest}
    bind:checked
    type="checkbox"
    class="m-0 h-4 w-4 accent-(--upaint-accent) focus-visible:ring-2 focus-visible:ring-(--upaint-accent)"
  />
  <span>{label}</span>
</label>

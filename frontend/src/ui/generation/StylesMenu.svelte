<script lang="ts">
  import { onMount } from "svelte";

  import { stylesStore } from "../../state/stylesStore.svelte";
  import Icon from "../lib/Icon.svelte";

  interface Props {
    onEdit: () => void;
    class?: string;
  }

  let { onEdit, class: className = "" }: Props = $props();

  const POPOVER_ID = "upaint-styles-menu";
  let popoverEl = $state<HTMLDivElement | undefined>(undefined);
  let top = $state(0);
  let left = $state(0);

  onMount(() => stylesStore.load());

  function place(event: MouseEvent): void {
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
    top = bounds.bottom + 4;
    // Right-align under the button (min-w-48 menu), kept inside the viewport.
    left = Math.max(8, bounds.right - 192);
  }

  const itemClass =
    "flex w-full cursor-pointer items-center justify-between gap-2 px-2 py-1.5 text-left hover:bg-(--upaint-surface-raised) focus-visible:bg-(--upaint-surface-raised) focus-visible:outline-none";
</script>

<button
  type="button"
  class={className}
  title="Styles"
  aria-label="Styles"
  aria-haspopup="menu"
  popovertarget={POPOVER_ID}
  onclick={place}>&lt;/&gt;</button
>

<!-- Stays open while picking so several styles can be toggled in one go. -->
<div
  bind:this={popoverEl}
  id={POPOVER_ID}
  popover="auto"
  role="menu"
  aria-label="Styles"
  class="fixed inset-auto m-0 max-h-60 min-w-48 overflow-y-auto border bg-(--upaint-surface) p-0 text-xs text-(--upaint-text) shadow-lg"
  style="top: {top}px; left: {left}px; border-color: var(--upaint-border); border-radius: var(--upaint-radius);"
>
  <button
    type="button"
    role="menuitem"
    class={itemClass}
    onclick={() => {
      popoverEl?.hidePopover();
      onEdit();
    }}
  >
    Edit
  </button>
  <hr class="m-0 border-t" style="border-color: var(--upaint-border);" />
  {#each stylesStore.styles as style (style.name)}
    {@const chosen = stylesStore.selected.includes(style.name)}
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={chosen}
      class={itemClass}
      onclick={() => stylesStore.toggle(style.name)}
    >
      <span class="truncate">{style.name}</span>
      {#if chosen}<Icon name="check" size={12} />{/if}
    </button>
  {:else}
    <div class="px-2 py-1.5 text-(--upaint-text-muted)">No styles</div>
  {/each}
</div>

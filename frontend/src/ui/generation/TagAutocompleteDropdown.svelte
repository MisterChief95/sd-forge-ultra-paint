<script lang="ts">
  import type { TagEntry } from "./tagAutocomplete";

  interface Props {
    items?: TagEntry[];
    selectedIndex?: number;
    loading?: boolean;
    top?: number;
    left?: number;
    onSelect?: (entry: TagEntry) => void;
  }

  let {
    items = [],
    selectedIndex = -1,
    loading = false,
    top = 0,
    left = 0,
    onSelect,
  }: Props = $props();

  let listEl = $state<HTMLUListElement | undefined>(undefined);
  let popoverEl = $state<HTMLDivElement | undefined>(undefined);

  $effect(() => {
    if (selectedIndex < 0 || !listEl) return;
    const el = listEl.children[selectedIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  });

  // Rendered in the top layer via the Popover API instead of being
  // absolutely positioned inside the panel, so a caret near the panel's
  // edge can't force the (non-scrolling) panel to grow and clip.
  $effect(() => {
    popoverEl?.showPopover();
  });
</script>

<div
  bind:this={popoverEl}
  popover="manual"
  class="m-0 max-h-52 min-w-48 overflow-y-auto border bg-(--upaint-surface) text-xs text-(--upaint-text) shadow-lg"
  style="inset: auto; top: {top}px; left: {left}px; border-color: var(--upaint-border); border-radius: var(--upaint-radius);"
  role="listbox"
>
  {#if loading}
    <div class="px-2 py-1.5 text-(--upaint-text-muted) italic">Loading tags…</div>
  {:else if items.length === 0}
    <div class="px-2 py-1.5 text-(--upaint-text-muted)">No matches</div>
  {:else}
    <ul bind:this={listEl}>
      {#each items as item, index (item.name)}
        <li>
          <button
            type="button"
            class={`flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left hover:bg-(--upaint-surface-raised) ${index === selectedIndex ? "bg-(--upaint-surface-raised)" : ""}`}
            role="option"
            aria-selected={index === selectedIndex}
            onmousedown={(event) => {
              // mousedown (not click) so this fires before the textarea's blur handler closes the dropdown.
              event.preventDefault();
              onSelect?.(item);
            }}
          >
            <span>{item.name}</span>
            {#if item.aliases.length > 0}
              <span class="truncate text-(--upaint-text-muted)">{item.aliases[0]}</span>
            {/if}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

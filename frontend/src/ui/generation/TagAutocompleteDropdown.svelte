<script lang="ts">
  import type { TagEntry } from "./tagAutocomplete";

  interface Props {
    items?: TagEntry[];
    selectedIndex?: number;
    loading?: boolean;
    onSelect?: (entry: TagEntry) => void;
  }

  let { items = [], selectedIndex = -1, loading = false, onSelect }: Props = $props();

  let listEl = $state<HTMLUListElement | undefined>(undefined);

  $effect(() => {
    if (selectedIndex < 0 || !listEl) return;
    const el = listEl.children[selectedIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  });
</script>

<div
  class="absolute top-full left-0 z-20 mt-1 max-h-52 w-full min-w-48 overflow-y-auto border bg-(--upaint-surface) text-xs text-(--upaint-text) shadow-lg"
  style="border-color: var(--upaint-border); border-radius: var(--upaint-radius);"
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

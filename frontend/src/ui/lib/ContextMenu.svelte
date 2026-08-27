<script module lang="ts">
  export type ContextMenuItem =
    | { divider: true }
    | { label: string; action: () => void; disabled?: boolean; destructive?: boolean };
</script>

<script lang="ts">
  interface Props {
    open?: boolean;
    x?: number;
    y?: number;
    items?: ContextMenuItem[];
  }

  let { open = $bindable(false), x = 0, y = 0, items = [] }: Props = $props();

  // Measured after render so the menu can clamp itself inside the viewport
  // instead of overflowing when opened near an edge (e.g. a corner button).
  let measuredWidth = $state(0);
  let measuredHeight = $state(0);
  const GAP = 8;
  const clampedX = $derived(Math.max(GAP, Math.min(x, window.innerWidth - measuredWidth - GAP)));
  const clampedY = $derived(Math.max(GAP, Math.min(y, window.innerHeight - measuredHeight - GAP)));

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      open = false;
    }
  }
</script>

{#if open}
  <div
    class="fixed inset-0 z-50"
    role="presentation"
    tabindex="-1"
    onclick={() => (open = false)}
    oncontextmenu={(event) => {
      event.preventDefault();
      open = false;
    }}
    onkeydown={handleKeydown}
  >
    <div
      class="absolute min-w-44 overflow-hidden border bg-(--upaint-surface) p-1 text-xs text-(--upaint-text) shadow-lg"
      style={`left: ${clampedX}px; top: ${clampedY}px; border-color: var(--upaint-border); border-radius: var(--upaint-radius);`}
      bind:clientWidth={measuredWidth}
      bind:clientHeight={measuredHeight}
      role="menu"
      tabindex="-1"
      aria-label="Context menu"
      onclick={(event) => event.stopPropagation()}
      onkeydown={(event) => event.stopPropagation()}
    >
      {#each items as item, index (index)}
        {#if "divider" in item}
          <hr class="my-1 border-t" style="border-color: var(--upaint-border);" />
        {:else}
          <button
            type="button"
            class={`flex w-full items-center rounded px-2 py-1.5 text-left hover:bg-(--upaint-surface-raised) disabled:cursor-not-allowed disabled:opacity-40 ${item.destructive ? "text-(--upaint-danger)" : ""}`}
            disabled={item.disabled}
            role="menuitem"
            onclick={() => {
              if (item.disabled) return;
              open = false;
              item.action();
            }}
          >
            {item.label}
          </button>
        {/if}
      {/each}
    </div>
  </div>
{/if}

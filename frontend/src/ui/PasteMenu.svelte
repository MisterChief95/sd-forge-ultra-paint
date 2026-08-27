<script lang="ts">
  import Button from "./lib/Button.svelte";

  export type PasteLayerKind = "mask" | "raster" | "control";

  interface Props {
    open: boolean;
    onChoose: (kind: PasteLayerKind) => void;
    onCancel: () => void;
  }

  let { open, onChoose, onCancel }: Props = $props();

  const quadrants: { kind: PasteLayerKind; label: string }[] = [
    { kind: "mask", label: "Mask Layer" },
    { kind: "raster", label: "Raster Layer" },
    { kind: "control", label: "Control Layer" },
  ];

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
  }
</script>

{#if open}
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
    role="presentation"
    tabindex="-1"
    onclick={onCancel}
    onkeydown={handleKeydown}
  >
    <div
      role="menu"
      aria-label="Paste as"
      tabindex="-1"
      class="grid grid-cols-2 gap-1 border p-1 text-xs text-(--upaint-text) shadow-lg"
      style="border-color: var(--upaint-border); border-radius: var(--upaint-radius); background: var(--upaint-surface);"
      onclick={(event) => event.stopPropagation()}
      onkeydown={(event) => event.stopPropagation()}
    >
      {#each quadrants as quadrant (quadrant.kind)}
        <Button
          role="menuitem"
          class="h-20 w-28 flex-col gap-1"
          onclick={() => onChoose(quadrant.kind)}
        >
          {quadrant.label}
        </Button>
      {/each}
      <Button
        role="menuitem"
        class="h-20 w-28 flex-col gap-1 text-(--upaint-text-muted)"
        onclick={onCancel}
      >
        Cancel
      </Button>
    </div>
  </div>
{/if}

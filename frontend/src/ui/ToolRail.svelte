<script lang="ts">
  /**
   * Vertical tool rail beside the canvas: tool selection, brush colors, and
   * undo/redo.
   * Per-tool settings live in the top bar (`PaintToolbar`), which switches its
   * options to match the active tool.
   */
  import { getActiveUltraPaintApp } from "../app/UltraPaintApp";
  import { isDocumentMutationLocked } from "../state/documentInteractionLock.svelte";
  import { layerStore } from "../state/layerStore.svelte";
  import { paintToolStore, type PaintTool } from "../state/paintToolStore.svelte";
  import Button from "./lib/Button.svelte";
  import Icon, { type IconName } from "./lib/Icon.svelte";

  const LOCKED = "Document edits are locked while previewing";

  const selectedLayer = $derived.by(() => {
    const id = layerStore.selectedLayerId;
    return id ? layerStore.getLayer(id) : undefined;
  });
  const transformLayer = $derived.by(() => {
    if (layerStore.selectedLayerIds.length !== 1) return undefined;
    return layerStore.getLayer(layerStore.selectedLayerIds[0]!);
  });
  const fillDisabled = $derived(selectedLayer?.kind !== "raster" || selectedLayer.locked);
  const lassoDisabled = $derived(selectedLayer?.kind !== "mask" || selectedLayer.locked);
  const transformDisabled = $derived(!transformLayer || transformLayer.locked);
</script>

{#snippet tool(
  id: PaintTool,
  icon: IconName,
  label: string,
  title: string,
  shortcut?: string,
  disabledReason?: string | false,
)}
  <Button
    size="icon"
    pressed={paintToolStore.activeTool === id}
    title={disabledReason || (shortcut ? `${title} (${shortcut})` : title)}
    aria-label={label}
    aria-keyshortcuts={shortcut}
    disabled={Boolean(disabledReason)}
    onclick={() => paintToolStore.setActiveTool(id)}
  >
    <Icon name={icon} size={16} />
  </Button>
{/snippet}

<div
  class="flex w-9 shrink-0 select-none flex-col pointer-coarse:w-11 items-center gap-1 overflow-y-auto border py-1.5"
  style="border-color: var(--upaint-border); border-radius: var(--upaint-radius-lg); background: var(--upaint-surface);"
  role="toolbar"
  aria-orientation="vertical"
  aria-label="Painting tools"
>
  {@render tool("brush", "brush", "Brush", "Brush", "B")}
  {@render tool("eraser", "eraser", "Eraser", "Eraser", "E")}
  {@render tool(
    "eyedropper",
    "eyedropper",
    "Eyedropper (hold Alt to switch temporarily)",
    "Eyedropper (hold Alt to switch temporarily)",
  )}
  <Button
    size="icon"
    title={isDocumentMutationLocked()
      ? LOCKED
      : fillDisabled
        ? "Select an unlocked raster layer to fill"
        : "Fill the selected layer (Shift+F)"}
    aria-label="Fill the selected layer"
    aria-keyshortcuts="Shift+F"
    disabled={isDocumentMutationLocked() || fillDisabled}
    onclick={() => getActiveUltraPaintApp()?.fillSelectedLayer()}
  >
    <Icon name="fill" size={16} />
  </Button>
  {@render tool(
    "lasso",
    paintToolStore.lassoMode === "polygonal" ? "lasso-polygon" : "lasso",
    "Lasso mask coverage",
    "Lasso mask coverage",
    undefined,
    isDocumentMutationLocked()
      ? LOCKED
      : lassoDisabled && "Select an unlocked mask layer to use Lasso",
  )}

  <span class="my-0.5 h-px w-5 bg-(--upaint-border)" aria-hidden="true"></span>

  {@render tool(
    "transform",
    "transform",
    "Transform Layer",
    "Move, rotate, or scale the selected layer",
    "V",
    isDocumentMutationLocked()
      ? LOCKED
      : transformDisabled && "Select one unlocked layer to transform",
  )}
  {@render tool("pan", "pan", "Pan", "Pan the canvas (or hold Space / middle mouse)")}
  {@render tool(
    "boundary-box",
    "boundary-box",
    "Boundary Box",
    "Move or resize the boundary box",
    "R",
  )}

  <span class="my-0.5 h-px w-5 bg-(--upaint-border)" aria-hidden="true"></span>

  <div class="relative h-9 w-8" title="Primary / secondary color (X swaps)">
    <input
      class="absolute left-0 top-0 z-1 h-6 w-6 cursor-pointer border bg-(--upaint-surface-raised) p-0.5"
      style="border-color: var(--upaint-border); border-radius: var(--upaint-radius-sm);"
      type="color"
      value={paintToolStore.brush.color}
      aria-label="Primary brush color"
      oninput={(event) => paintToolStore.setBrushSettings({ color: event.currentTarget.value })}
    />
    <input
      class="absolute right-0 bottom-0 h-6 w-6 cursor-pointer border bg-(--upaint-surface-raised) p-0.5"
      style="border-color: var(--upaint-border); border-radius: var(--upaint-radius-sm);"
      type="color"
      value={paintToolStore.secondaryColor}
      aria-label="Secondary brush color"
      oninput={(event) => paintToolStore.setSecondaryColor(event.currentTarget.value)}
    />
  </div>
  <Button
    size="icon"
    variant="ghost"
    title="Swap primary and secondary colors (X)"
    aria-label="Swap primary and secondary colors"
    aria-keyshortcuts="X"
    onclick={() => paintToolStore.swapColors()}
  >
    <Icon name="swap" size={14} />
  </Button>

  <span class="my-0.5 h-px w-5 bg-(--upaint-border)" aria-hidden="true"></span>

  <!-- Keyboard-free devices (tablets) have no other way to undo/redo. -->
  <Button
    size="icon"
    variant="ghost"
    title="Undo (Ctrl+Z)"
    aria-label="Undo"
    aria-keyshortcuts="Control+Z"
    disabled={isDocumentMutationLocked()}
    onclick={() => getActiveUltraPaintApp()?.undo()}
  >
    <Icon name="undo" size={16} />
  </Button>
  <Button
    size="icon"
    variant="ghost"
    title="Redo (Ctrl+Shift+Z)"
    aria-label="Redo"
    aria-keyshortcuts="Control+Shift+Z Control+Y"
    disabled={isDocumentMutationLocked()}
    onclick={() => getActiveUltraPaintApp()?.redo()}
  >
    <Icon name="redo" size={16} />
  </Button>
</div>

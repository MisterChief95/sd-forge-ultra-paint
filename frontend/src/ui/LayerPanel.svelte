<script lang="ts">
  import { tick } from "svelte";

  import { getActiveUltraPaintApp } from "../app/UltraPaintApp";
  import { layerStore } from "../state/layerStore.svelte";
  import type { Document, Layer, LayerId, MaskLayer } from "../state/schema";
  import { BLEND_MODE_ORDER, isBlendMode } from "../util/blendModes";
  import Accordion from "./lib/Accordion.svelte";
  import ContextMenu, { type ContextMenuItem } from "./lib/ContextMenu.svelte";
  import Slider from "./lib/Slider.svelte";
  import ControlLayerSettings from "./ControlLayerSettings.svelte";

  const THUMB_SIZE = 34;
  const THUMBNAIL_DEBOUNCE_MS = 1000;
  let thumbnailUrls = $state<Record<LayerId, string | null>>({});
  const thumbnailVersions = new Map<LayerId, number>();
  const thumbnailTimers = new Map<LayerId, ReturnType<typeof setTimeout>>();

  let editingId = $state<LayerId | null>(null);
  let renameDraft = $state("");
  let renameInput = $state<HTMLInputElement | null>(null);
  let draggingId = $state<LayerId | null>(null);
  let dropAnchorId = $state<LayerId | null>(null);
  let dropBefore = $state(false);
  let layersOpen = $state(true);
  let masksOpen = $state(true);
  let controlsOpen = $state(true);
  let expandedControlId = $state<LayerId | null>(null);
  let showControlOnly = $state(false);
  let contextMenuOpen = $state(false);
  let contextMenuX = $state(0);
  let contextMenuY = $state(0);
  let contextMenuItems = $state<ContextMenuItem[]>([]);
  let actionMessage = $state("");

  const orderedRootLayers = $derived(
    layerStore.document.layerOrder
      .map((id) => layerStore.document.layers.find((layer) => layer.id === id))
      .filter((layer): layer is Layer => layer !== undefined),
  );
  const regularLayers = $derived(
    showControlOnly
      ? []
      : orderedRootLayers.filter((layer) => layer.kind !== "mask" && layer.kind !== "control"),
  );
  const maskLayers = $derived(
    orderedRootLayers.filter((layer): layer is MaskLayer => layer.kind === "mask"),
  );
  const visibleMaskLayers = $derived(showControlOnly ? [] : maskLayers);
  const controlLayers = $derived(orderedRootLayers.filter((layer) => layer.kind === "control"));
  const opacitySelection = $derived(
    layerStore.selectedLayerIds.length === 1
      ? layerStore.getLayer(layerStore.selectedLayerIds[0]!)
      : undefined,
  );

  $effect(() => {
    const liveIds = new Set(layerStore.document.layers.map((layer) => layer.id));
    for (const id of thumbnailVersions.keys()) {
      if (!liveIds.has(id)) thumbnailVersions.delete(id);
    }
    for (const [id, timer] of thumbnailTimers) {
      if (!liveIds.has(id)) {
        clearTimeout(timer);
        thumbnailTimers.delete(id);
      }
    }
    if (Object.keys(thumbnailUrls).some((id) => !liveIds.has(id))) {
      thumbnailUrls = Object.fromEntries(
        Object.entries(thumbnailUrls).filter(([id]) => liveIds.has(id)),
      );
    }
  });

  function prettyBlendMode(mode: string): string {
    const spaced = mode.replace(/-/g, " ");
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
  }

  /** Debounced GPU-side downsample of a layer's render texture, so a burst of quick strokes samples once. */
  function scheduleThumbnail(id: LayerId): void {
    if (thumbnailTimers.has(id)) return;
    const timer = setTimeout(() => {
      thumbnailTimers.delete(id);
      const version = layerStore.getTextureVersion(id);
      const url = getActiveUltraPaintApp()?.getLayerThumbnail(id, THUMB_SIZE) ?? null;
      thumbnailVersions.set(id, version);
      thumbnailUrls = { ...thumbnailUrls, [id]: url };
    }, THUMBNAIL_DEBOUNCE_MS);
    thumbnailTimers.set(id, timer);
  }

  function thumbnailFor(layer: Layer): string | null {
    if (layer.kind === "group" || layer.kind === "mask") return null;
    if (thumbnailVersions.get(layer.id) !== layerStore.getTextureVersion(layer.id)) {
      scheduleThumbnail(layer.id);
    }
    return thumbnailUrls[layer.id] ?? null;
  }

  async function handleFiles(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = "";

    for (const file of files) {
      const app = getActiveUltraPaintApp();
      if (!app) {
        console.error("[ultra-paint] cannot add an image before the app is ready");
        return;
      }
      try {
        const id = await app.addImageFromFile(file, "upload");
        layerStore.setSelectedLayerId(id);
      } catch (error) {
        console.error(`[ultra-paint] could not add "${file.name}":`, error);
      }
    }
  }

  async function handleAddBlankLayer(): Promise<void> {
    const app = getActiveUltraPaintApp();
    if (!app) {
      console.error("[ultra-paint] cannot add a blank layer before the app is ready");
      return;
    }
    try {
      const id = await app.addBlankLayer();
      layerStore.setSelectedLayerId(id);
    } catch (error) {
      console.error("[ultra-paint] could not add a blank layer:", error);
    }
  }

  function handleAddMaskLayer(): void {
    const id = layerStore.addMaskLayer();
    layerStore.setSelectedLayerId(id);
    masksOpen = true;
  }

  async function handleControlFiles(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = "";

    for (const file of files) {
      const app = getActiveUltraPaintApp();
      if (!app) {
        console.error("[ultra-paint] cannot add a control layer before the app is ready");
        return;
      }
      try {
        const id = await app.addControlLayerFromFile(file);
        layerStore.setSelectedLayerId(id);
        controlsOpen = true;
        expandedControlId = id;
      } catch (error) {
        console.error(`[ultra-paint] could not add control layer "${file.name}":`, error);
      }
    }
  }

  function isInteractiveTarget(target: EventTarget | null): boolean {
    return target instanceof Element && target.closest("input, select, button, textarea") !== null;
  }

  function selectRow(event: MouseEvent, layer: Layer): void {
    if (isInteractiveTarget(event.target)) return;
    selectLayer(layer, event.shiftKey || event.ctrlKey || event.metaKey);
  }

  function selectLayer(layer: Layer, toggle: boolean): void {
    if (!toggle) {
      layerStore.setSelectedLayerId(layer.id);
      return;
    }
    const selected = layerStore.selectedLayerIds
      .map((id) => layerStore.getLayer(id))
      .filter((candidate): candidate is Layer => candidate !== undefined);
    if (selected.some((candidate) => !shareAccordion(candidate, layer))) {
      layerStore.setSelectedLayerId(layer.id);
      return;
    }
    layerStore.toggleSelectedLayerId(layer.id);
  }

  function openAddMenu(event: MouseEvent): void {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    contextMenuX = rect.left;
    contextMenuY = rect.bottom + 4;
    contextMenuItems = [
      { label: "Raster Layer", action: () => void handleAddBlankLayer() },
      { label: "Mask Layer", action: handleAddMaskLayer },
      {
        label: "Control Layer",
        action: () => document.getElementById("upaint-control-file-input")?.click(),
      },
      { divider: true },
      {
        label: "Insert Image",
        action: () => document.getElementById("upaint-layer-file-input")?.click(),
      },
    ];
    contextMenuOpen = true;
  }

  function openLayerContextMenu(event: MouseEvent, layer: Layer): void {
    event.preventDefault();
    if (!layerStore.selectedLayerIds.includes(layer.id)) {
      layerStore.setSelectedLayerId(layer.id);
    }
    const selected = layerStore.selectedLayerIds
      .map((id) => layerStore.getLayer(id))
      .filter(
        (candidate): candidate is Layer =>
          candidate !== undefined && shareAccordion(candidate, layer),
      );
    const allVisible = selected.every((candidate) => candidate.visible);
    const single = selected.length === 1 ? selected[0] : undefined;
    const mergeable = accordionBucket(layer) === "layers" && selected.length > 1;
    const copyable = single !== undefined && single.kind !== "group";
    contextMenuX = event.clientX;
    contextMenuY = event.clientY;
    contextMenuItems = [
      ...(single ? [{ label: "Rename", action: () => void beginRename(single) }] : []),
      {
        label: allVisible ? "Hide selected" : "Show selected",
        action: () =>
          selected.forEach((candidate) => layerStore.setVisible(candidate.id, !allVisible)),
      },
      ...(mergeable
        ? [{ label: "Merge selected into new layer", action: () => mergeSelected(selected) }]
        : []),
      ...(copyable
        ? [
            {
              label: clipboardSupported()
                ? "Copy layer to clipboard"
                : "Copy layer to clipboard (unsupported)",
              action: () => void copyLayer(single),
              disabled: !clipboardSupported(),
            },
          ]
        : []),
      {
        label: showControlOnly ? "Show all layers" : "Show Control layers only",
        action: () => (showControlOnly = !showControlOnly),
      },
      {
        label: selected.length === 1 ? "Delete layer" : `Delete ${selected.length} selected`,
        action: () => selected.forEach((candidate) => layerStore.removeLayer(candidate.id)),
        destructive: true,
      },
    ];
    contextMenuOpen = true;
  }

  function mergeSelected(selected: readonly Layer[]): void {
    try {
      const app = getActiveUltraPaintApp();
      if (!app) throw new Error("The painting canvas is not ready");
      app.mergeLayersToNewLayer(selected.map((layer) => layer.id));
      actionMessage = `Merged ${selected.length} layers into a new layer.`;
    } catch (error) {
      actionMessage = `Could not merge layers: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  function clipboardSupported(): boolean {
    return typeof ClipboardItem !== "undefined" && typeof navigator.clipboard?.write === "function";
  }

  async function copyLayer(layer: Layer): Promise<void> {
    try {
      const app = getActiveUltraPaintApp();
      if (!app || !clipboardSupported()) throw new Error("PNG clipboard access is unavailable");
      const blob = await app.layerSourcePngBlob(layer.id);
      if (!blob) throw new Error("This layer has no copyable pixel data");
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      actionMessage = `Copied “${layer.name}” to the clipboard.`;
    } catch (error) {
      actionMessage = `Could not copy layer: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  function selectRowFromKeyboard(event: KeyboardEvent, layer: Layer): void {
    if (event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    selectLayer(layer, event.shiftKey || event.ctrlKey || event.metaKey);
  }

  async function beginRename(layer: Layer): Promise<void> {
    layerStore.setSelectedLayerId(layer.id);
    editingId = layer.id;
    renameDraft = layer.name;
    await tick();
    renameInput?.focus();
    renameInput?.select();
  }

  function commitRename(layer: Layer): void {
    if (editingId !== layer.id) return;
    const next = renameDraft.trim();
    editingId = null;
    if (next && next !== layer.name) layerStore.setName(layer.id, next);
  }

  function cancelRename(): void {
    editingId = null;
  }

  function handleRenameKeydown(event: KeyboardEvent, layer: Layer): void {
    if (event.key === "Enter") {
      event.preventDefault();
      commitRename(layer);
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancelRename();
    }
  }

  function handleBlendChange(event: Event, id: LayerId): void {
    const value = (event.currentTarget as HTMLSelectElement).value;
    if (isBlendMode(value)) layerStore.setBlendMode(id, value);
  }

  function toggleLocked(layer: Layer): void {
    layerStore.setLocked(layer.id, !layer.locked);
  }

  function togglePreserveAlpha(layer: Layer): void {
    layerStore.setPreserveAlpha(layer.id, !layer.preserveAlpha);
  }

  function handleMaskColorInput(event: Event, id: LayerId): void {
    layerStore.setMaskColor(id, (event.currentTarget as HTMLInputElement).value);
  }

  /**
   * Keep the row ineligible for native dragging until capture-phase pointerdown
   * proves the gesture began outside a form control. This prevents the browser
   * from ever choosing the row as the slider thumb's drag source; cancelling a
   * later dragstart (the old panel's approach) happens too late in some browsers.
   */
  function armRowDrag(event: PointerEvent): void {
    const row = event.currentTarget as HTMLElement;
    row.draggable = !isInteractiveTarget(event.target);
  }

  function disarmRowDrag(event: PointerEvent): void {
    (event.currentTarget as HTMLElement).draggable = false;
  }

  function handleDragStart(event: DragEvent, id: LayerId): void {
    const row = event.currentTarget as HTMLElement;
    if (!row.draggable) {
      event.preventDefault();
      return;
    }

    draggingId = id;
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", id);
    }
  }

  function clearDragState(event?: DragEvent): void {
    if (event) (event.currentTarget as HTMLElement).draggable = false;
    draggingId = null;
    dropAnchorId = null;
  }

  function isAboveMidpoint(row: HTMLElement, event: DragEvent): boolean {
    const box = row.getBoundingClientRect();
    return event.clientY < box.top + box.height / 2;
  }

  function handleDragOver(event: DragEvent, id: LayerId): void {
    if (draggingId === null || draggingId === id) return;
    const dragged = layerStore.getLayer(draggingId);
    const anchor = layerStore.getLayer(id);
    if (!dragged || !anchor || !shareAccordion(dragged, anchor)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    dropAnchorId = id;
    dropBefore = isAboveMidpoint(event.currentTarget as HTMLElement, event);
  }

  function handleDragLeave(event: DragEvent, id: LayerId): void {
    const row = event.currentTarget as HTMLElement;
    if (event.relatedTarget instanceof Node && row.contains(event.relatedTarget)) {
      return;
    }
    if (dropAnchorId === id) dropAnchorId = null;
  }

  function handleDrop(event: DragEvent, anchor: LayerId): void {
    event.preventDefault();
    const dragged = draggingId;
    const before = isAboveMidpoint(event.currentTarget as HTMLElement, event);
    clearDragState();
    if (dragged === null || dragged === anchor) return;
    dropOnto(layerStore.document, dragged, anchor, before);
  }

  function dropOnto(
    doc: Readonly<Document>,
    dragged: LayerId,
    anchor: LayerId,
    before: boolean,
  ): void {
    const draggedLayer = doc.layers.find((layer) => layer.id === dragged);
    const anchorLayer = doc.layers.find((layer) => layer.id === anchor);
    if (
      !draggedLayer ||
      !anchorLayer ||
      !shareAccordion(draggedLayer, anchorLayer) ||
      !doc.layerOrder.includes(dragged) ||
      !doc.layerOrder.includes(anchor)
    ) {
      return;
    }

    const reduced = doc.layerOrder.filter((id) => id !== dragged);
    const anchorIndex = reduced.indexOf(anchor);
    if (anchorIndex === -1) return;

    layerStore.reorderLayer(dragged, before ? anchorIndex : anchorIndex + 1);
    layerStore.setSelectedLayerId(dragged);
  }

  function accordionBucket(layer: Layer): "mask" | "control" | "layers" {
    if (layer.kind === "mask") return "mask";
    if (layer.kind === "control") return "control";
    return "layers";
  }

  function shareAccordion(a: Layer, b: Layer): boolean {
    return accordionBucket(a) === accordionBucket(b);
  }
</script>

{#snippet layerRows(layers: Layer[])}
  {#each layers as layer (layer.id)}
    {@const thumbnail = thumbnailFor(layer)}
    {@const selected = layerStore.selectedLayerIds.includes(layer.id)}
    {@const dropIndicator =
      dropAnchorId === layer.id
        ? `inset 0 ${dropBefore ? "2px" : "-2px"} 0 0 var(--upaint-accent)`
        : "none"}
    <div
      class={`grid w-full cursor-default grid-cols-[12px_22px_38px_minmax(0,1fr)_auto] grid-rows-[38px_auto] items-center gap-x-1.5 gap-y-1 border-b px-2 py-1.5 ${selected ? "bg-(--upaint-accent-muted)" : "bg-(--upaint-surface-raised)"} ${layer.visible ? "" : "opacity-60"} ${draggingId === layer.id ? "opacity-40" : ""}`}
      style={`border-color: var(--upaint-border); box-shadow: ${dropIndicator}; transition: background-color var(--upaint-transition), opacity var(--upaint-transition);`}
      role="button"
      aria-pressed={selected}
      tabindex="0"
      draggable={false}
      data-layer-id={layer.id}
      data-layer-kind={layer.kind}
      onclick={(event) => selectRow(event, layer)}
      onkeydown={(event) => selectRowFromKeyboard(event, layer)}
      onpointerdowncapture={armRowDrag}
      onpointerup={disarmRowDrag}
      onpointercancel={disarmRowDrag}
      oncontextmenu={(event) => openLayerContextMenu(event, layer)}
      ondragstart={(event) => handleDragStart(event, layer.id)}
      ondragend={clearDragState}
      ondragover={(event) => handleDragOver(event, layer.id)}
      ondragleave={(event) => handleDragLeave(event, layer.id)}
      ondrop={(event) => handleDrop(event, layer.id)}
    >
      <div
        class="flex h-[34px] w-[12px] shrink-0 cursor-grab flex-col items-center justify-center gap-[3px]"
        title="Drag to reorder"
        aria-hidden="true"
      >
        <span class="block h-[2px] w-[10px] rounded-full bg-(--upaint-text-muted)"></span>
        <span class="block h-[2px] w-[10px] rounded-full bg-(--upaint-text-muted)"></span>
        <span class="block h-[2px] w-[10px] rounded-full bg-(--upaint-text-muted)"></span>
      </div>

      <input
        class="m-0 cursor-pointer accent-(--upaint-accent)"
        type="checkbox"
        checked={layer.visible}
        title={layer.visible ? "Hide layer" : "Show layer"}
        aria-label={`Toggle "${layer.name}" visible`}
        onchange={(event) =>
          layerStore.setVisible(layer.id, (event.currentTarget as HTMLInputElement).checked)}
      />

      {#if layer.kind === "group"}
        <div
          class="flex h-[34px] w-[34px] items-center justify-center border bg-(--upaint-surface) text-base text-(--upaint-text-muted)"
          style="border-color: var(--upaint-border); border-radius: var(--upaint-radius-sm);"
          title="Group"
          aria-label="Group layer"
        >
          ▦
        </div>
      {:else if layer.kind === "mask"}
        <div
          class="flex h-[34px] w-[34px] items-center justify-center border bg-(--upaint-surface) text-base text-(--upaint-text-muted)"
          style={`border-color: ${layer.color}; border-radius: var(--upaint-radius-sm); color: ${layer.color};`}
          title="Mask"
          aria-label="Mask layer"
        >
          ▨
        </div>
      {:else if thumbnail}
        <img
          class="h-[34px] w-[34px] border bg-(--upaint-surface) object-contain"
          style="border-color: var(--upaint-border); border-radius: var(--upaint-radius-sm);"
          src={thumbnail}
          alt={`${layer.name} preview`}
          draggable="false"
        />
      {:else}
        <div
          class="flex h-[34px] w-[34px] items-center justify-center border bg-(--upaint-surface) text-base text-(--upaint-text-muted)"
          style="border-color: var(--upaint-border); border-radius: var(--upaint-radius-sm);"
          title="No preview"
          aria-label="No layer preview"
        >
          ▣
        </div>
      {/if}

      {#if editingId === layer.id}
        <input
          bind:this={renameInput}
          bind:value={renameDraft}
          class="min-w-0 border bg-(--upaint-surface) px-1.5 py-1 text-xs text-(--upaint-text) outline-none focus:border-(--upaint-accent)"
          style="border-color: var(--upaint-border); border-radius: var(--upaint-radius-sm);"
          type="text"
          aria-label={`Rename ${layer.name}`}
          onkeydown={(event) => handleRenameKeydown(event, layer)}
          onblur={() => commitRename(layer)}
        />
      {:else}
        <button
          type="button"
          class="min-w-0 cursor-text overflow-hidden border-0 bg-transparent p-0 text-left text-sm text-ellipsis whitespace-nowrap text-(--upaint-text)"
          title={`${layer.name} (click to rename)`}
          onclick={() => void beginRename(layer)}
        >
          {layer.name}
        </button>
      {/if}

      <div class="flex items-center gap-0.5">
        <button
          type="button"
          class={`h-7 w-7 cursor-pointer border text-(--upaint-text) ${layer.locked ? "border-(--upaint-accent)" : "bg-(--upaint-surface)"}`}
          style="border-color: var(--upaint-border); border-radius: var(--upaint-radius-sm);"
          title={layer.locked ? "Unlock layer" : "Lock layer"}
          aria-label={`${layer.locked ? "Unlock" : "Lock"} "${layer.name}"`}
          aria-pressed={layer.locked}
          onclick={() => toggleLocked(layer)}
        >
          <svg
            class="mx-auto h-3 w-3"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.3"
            aria-hidden="true"
          >
            <rect x="3.5" y="7" width="9" height="6.5" rx="1" />
            <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
          </svg>
        </button>
        <button
          type="button"
          class={`h-7 w-7 cursor-pointer border text-(--upaint-text) ${layer.preserveAlpha ? "border-(--upaint-accent)" : "bg-(--upaint-surface)"}`}
          style="border-color: var(--upaint-border); border-radius: var(--upaint-radius-sm);"
          title={layer.preserveAlpha
            ? "Stop preserving transparency"
            : "Preserve transparency (lock alpha)"}
          aria-label={`${layer.preserveAlpha ? "Stop preserving" : "Preserve"} transparency on "${layer.name}"`}
          aria-pressed={layer.preserveAlpha}
          onclick={() => togglePreserveAlpha(layer)}
        >
          <svg class="mx-auto h-3 w-3" viewBox="0 0 16 16" aria-hidden="true">
            <rect x="1" y="1" width="6" height="6" fill="currentColor" opacity="0.9" />
            <rect x="9" y="1" width="6" height="6" fill="currentColor" opacity="0.35" />
            <rect x="1" y="9" width="6" height="6" fill="currentColor" opacity="0.35" />
            <rect x="9" y="9" width="6" height="6" fill="currentColor" opacity="0.9" />
          </svg>
        </button>
        {#if layer.kind === "control"}
          <button
            type="button"
            class={`h-7 w-7 cursor-pointer border text-[10px] text-(--upaint-text) ${expandedControlId === layer.id ? "border-(--upaint-accent)" : "bg-(--upaint-surface)"}`}
            style="border-color: var(--upaint-border); border-radius: var(--upaint-radius-sm);"
            title="ControlNet settings"
            aria-label={`Configure ${layer.name}`}
            aria-pressed={expandedControlId === layer.id}
            onclick={() => (expandedControlId = expandedControlId === layer.id ? null : layer.id)}
          >
            ⚙
          </button>
        {/if}
        <button
          type="button"
          class="h-7 w-7 cursor-pointer border bg-(--upaint-surface) text-base text-(--upaint-danger) hover:border-(--upaint-danger)"
          style="border-color: var(--upaint-border); border-radius: var(--upaint-radius-sm); transition: border-color var(--upaint-transition);"
          title="Delete layer"
          aria-label={`Delete ${layer.name}`}
          onclick={() => layerStore.removeLayer(layer.id)}
        >
          ×
        </button>
      </div>

      {#if layer.kind === "mask"}
        <label
          class="col-span-5 flex items-center gap-2 border-t pt-1.5 text-[11px] text-(--upaint-text-muted)"
          style="border-color: var(--upaint-border);"
        >
          Display color
          <input
            class="h-6 w-12 cursor-pointer border bg-transparent p-0.5"
            style="border-color: var(--upaint-border); border-radius: var(--upaint-radius-sm);"
            type="color"
            value={layer.color}
            title="Mask display color"
            aria-label={`Display color of "${layer.name}"`}
            oninput={(event) => handleMaskColorInput(event, layer.id)}
          />
        </label>
      {/if}

      {#if layer.kind === "control" && expandedControlId === layer.id}
        <ControlLayerSettings {layer} {maskLayers} />
      {/if}
    </div>
  {/each}
{/snippet}

<div
  class="box-border flex h-full w-full flex-col text-xs"
  style="color: var(--upaint-text); font-family: var(--upaint-font);"
>
  <header
    class="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2.5"
    style="border-color: var(--upaint-border);"
  >
    <h2 class="m-0 mr-auto text-sm font-semibold">Layers &amp; Masks</h2>
    <button
      type="button"
      class="cursor-pointer border border-(--upaint-accent) bg-(--upaint-accent) px-2.5 py-1 text-xs font-medium text-(--upaint-text) hover:bg-(--upaint-accent-muted)"
      style="border-radius: var(--upaint-radius-sm); transition: background-color var(--upaint-transition);"
      title="Add a layer"
      aria-label="Add a layer"
      onclick={openAddMenu}
    >
      +
    </button>
    <input
      id="upaint-control-file-input"
      class="hidden"
      type="file"
      accept="image/*"
      multiple
      onchange={(event) => void handleControlFiles(event)}
    />
    <input
      id="upaint-layer-file-input"
      class="hidden"
      type="file"
      accept="image/*"
      multiple
      onchange={(event) => void handleFiles(event)}
    />
  </header>

  <div
    class="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-3 py-2"
    style="border-color: var(--upaint-border);"
  >
    <div class="flex min-w-[140px] flex-1 items-center gap-1.5">
      <span class="w-12 shrink-0 text-(--upaint-text-muted)">Opacity</span>
      <Slider
        value={opacitySelection ? Math.round(opacitySelection.opacity * 100) : 100}
        min={0}
        max={100}
        step={1}
        disabled={!opacitySelection}
        title="Opacity of the selected layer"
        ariaLabel="Opacity of the selected layer"
        onValueInput={(value) =>
          opacitySelection && layerStore.setOpacity(opacitySelection.id, value / 100)}
      />
      <output class="w-9 shrink-0 text-right text-[11px] tabular-nums text-(--upaint-text-muted)">
        {opacitySelection ? Math.round(opacitySelection.opacity * 100) : 100}%
      </output>
    </div>
    <div class="flex min-w-[140px] flex-1 items-center gap-1.5">
      <span class="w-12 shrink-0 text-(--upaint-text-muted)">Blend</span>
      <select
        class="w-full min-w-0 cursor-pointer border bg-(--upaint-surface) px-1 py-1 text-[11px] text-(--upaint-text) outline-none focus:border-(--upaint-accent) disabled:cursor-not-allowed disabled:opacity-50"
        style="border-color: var(--upaint-border); border-radius: var(--upaint-radius-sm);"
        value={opacitySelection?.blendMode ?? "normal"}
        disabled={!opacitySelection}
        title="Blend mode of the selected layer"
        aria-label="Blend mode of the selected layer"
        onchange={(event) => opacitySelection && handleBlendChange(event, opacitySelection.id)}
      >
        {#each BLEND_MODE_ORDER as mode (mode)}
          <option value={mode}>{prettyBlendMode(mode)}</option>
        {/each}
      </select>
    </div>
  </div>

  <div class="flex min-h-0 flex-1 flex-col overflow-y-auto" style="scrollbar-gutter: stable;">
    {#if regularLayers.length > 0}
      <Accordion
        bind:open={layersOpen}
        title="Layers"
        count={regularLayers.length}
        id="upaint-regular-layer-list"
        data-layer-section="layers"
      >
        {@render layerRows(regularLayers)}
      </Accordion>
    {/if}

    {#if visibleMaskLayers.length > 0}
      <Accordion
        bind:open={masksOpen}
        title="Masks"
        count={visibleMaskLayers.length}
        id="upaint-mask-layer-list"
        data-layer-section="masks"
      >
        {@render layerRows(visibleMaskLayers)}
      </Accordion>
    {/if}

    {#if controlLayers.length > 0}
      <Accordion
        bind:open={controlsOpen}
        title="Control"
        count={controlLayers.length}
        id="upaint-control-layer-list"
        data-layer-section="controls"
      >
        {@render layerRows(controlLayers)}
      </Accordion>
    {/if}

    {#if regularLayers.length === 0 && visibleMaskLayers.length === 0 && controlLayers.length === 0}
      <div class="px-2 py-5 text-center text-(--upaint-text-muted)">
        No layers yet -- use + to add one.
      </div>
    {/if}
  </div>

  {#if actionMessage}
    <div
      class="shrink-0 border-t px-3 py-2 text-[11px] text-(--upaint-text-muted)"
      style="border-color: var(--upaint-border);"
      role="status"
    >
      {actionMessage}
    </div>
  {/if}

  <ContextMenu
    bind:open={contextMenuOpen}
    x={contextMenuX}
    y={contextMenuY}
    items={contextMenuItems}
  />
</div>

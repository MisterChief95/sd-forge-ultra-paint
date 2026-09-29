<script lang="ts">
  /**
   * Root shell (Phase 2.R, T22).
   *
   * Three-pane layout mirroring the old Gradio tab's column arrangement
   * (settings / canvas / layers), now built as plain Tailwind-positioned
   * `<div>`s in this app's own document instead of Gradio `gr.Column`s.
   *
   * DOM CONTRACT (unchanged from the pre-Phase-2.R Gradio version, see
   * PLAN.md §4): `UltraPaintApp` mounts its PixiJS canvas into `#upaint-root`.
   * The old DOM-based layer panel / paint toolbar mounts
   * (`#upaint-root-panel` / `#upaint-root-toolbar`) are no longer driven by
   * `UltraPaintApp` itself (see the T22 note at the top of
   * `app/UltraPaintApp.ts`) -- `<LayerPanel>`/`<PaintToolbar>` (T19/T20) are
   * mounted directly as children here instead, inside those same-id wrapper
   * elements (kept for id stability / doc-contract continuity, not because
   * anything still queries them externally).
   *
   * `#upaint-settings-panel` is new in Phase 2.R (no Gradio equivalent to
   * preserve) -- T21's generation-settings components mount there.
   */
  import { onDestroy, onMount } from "svelte";
  import type { Action } from "svelte/action";

  import { UltraPaintApp } from "./app/UltraPaintApp";
  import { handleInputKeyDown } from "./input/actionMap";
  import { isDocumentMutationLocked } from "./state/documentInteractionLock.svelte";
  import { uiLayoutStore } from "./state/uiLayoutStore.svelte";
  import BoundaryInfoOverlay from "./ui/BoundaryInfoOverlay.svelte";
  import FilterBar from "./ui/FilterBar.svelte";
  import GenerationPanel from "./ui/GenerationPanel.svelte";
  import GenerationPreviewBar from "./ui/GenerationPreviewBar.svelte";
  import LayerPanel from "./ui/LayerPanel.svelte";
  import PaintToolbar from "./ui/PaintToolbar.svelte";
  import PasteMenu, { type PasteLayerKind } from "./ui/PasteMenu.svelte";
  import ToastViewport from "./ui/ToastViewport.svelte";
  import ToolRail from "./ui/ToolRail.svelte";
  import ViewportControls from "./ui/ViewportControls.svelte";

  let ultraPaintApp: UltraPaintApp | null = null;
  let pasteFile: File | null = $state(null);

  function handlePasteRequest(file: File): void {
    pasteFile = file;
  }

  function closePasteMenu(): void {
    pasteFile = null;
  }

  function handlePasteChoice(kind: PasteLayerKind): void {
    const file = pasteFile;
    const app = ultraPaintApp;
    closePasteMenu();
    if (!file || !app || isDocumentMutationLocked()) return;

    const add =
      kind === "mask"
        ? app.addMaskLayerFromFile(file)
        : kind === "control"
          ? app.addControlLayerFromFile(file)
          : app.addImageFromFile(file);
    void add
      .then((id) => app.getStore().setSelectedLayerId(id))
      .catch((error) => console.error("[ultra-paint] could not paste image:", error));
  }

  // Collapse/width state lives in uiLayoutStore so it persists and so the
  // toolbar's panel toggles can drive it. Collapsed panels stay mounted
  // (`hidden`) because GenerationPanel owns prompt/controller state and
  // registers the generate shortcut.
  const leftPanel = $derived(uiLayoutStore.sidePanel("left"));
  const rightPanel = $derived(uiLayoutStore.sidePanel("right"));
  let leftDragStartWidth = 0;
  let rightDragStartWidth = 0;

  onMount(() => {
    ultraPaintApp = new UltraPaintApp("upaint-root");
    ultraPaintApp.pasteRequestHandler = handlePasteRequest;
  });

  onDestroy(() => {
    ultraPaintApp?.destroy();
    ultraPaintApp = null;
  });

  function handleKeyDown(event: KeyboardEvent): void {
    handleInputKeyDown(event, ultraPaintApp);
  }

  // Define the shape of the parameters passed to the action
  interface DragParams {
    orientation: "vertical" | "horizontal";
  }

  // Custom events this action dispatches. Named "sep*" (not "drag*") so they
  // don't collide with the native HTML drag-and-drop `ondrag`/`ondragstart`
  // attributes -- Svelte 5 has no `on:` directive to disambiguate anymore.
  interface DragAttributes {
    onsepDragStart?: (e: CustomEvent<string>) => void;
    onsepDrag?: (e: CustomEvent<number>) => void;
    onsepDragEnd?: (e: CustomEvent<string>) => void;
  }

  export const onDrag: Action<HTMLElement, DragParams, DragAttributes> = (node, params) => {
    let dragStart: number | null = null;

    // Type-safe ternary to pick the correct property name
    const attr = params.orientation === "vertical" ? "screenX" : "screenY";

    const mouseDownAction = (e: MouseEvent) => {
      e.preventDefault();
      node.dispatchEvent(new CustomEvent("sepDragStart", { detail: "hello" }));
      dragStart = e[attr];
    };

    const mouseMoveAction = (e: MouseEvent) => {
      if (dragStart !== null) {
        const delta = e[attr] - dragStart;
        node.dispatchEvent(new CustomEvent("sepDrag", { detail: delta }));
      }
    };

    const mouseUpAction = () => {
      dragStart = null;
      node.dispatchEvent(new CustomEvent("sepDragEnd", { detail: "hello" }));
    };

    node.addEventListener("mousedown", mouseDownAction);
    document.addEventListener("mousemove", mouseMoveAction);
    document.addEventListener("mouseup", mouseUpAction);

    return {
      destroy() {
        node.removeEventListener("mousedown", mouseDownAction);
        document.removeEventListener("mousemove", mouseMoveAction);
        document.removeEventListener("mouseup", mouseUpAction);
      },
    };
  };
</script>

<svelte:window onkeydown={handleKeyDown} />

<div class="flex h-full w-full overflow-hidden" style="background: var(--upaint-bg);">
  <aside
    id="upaint-settings-panel"
    class="shrink-0 overflow-y-auto"
    style="width: {leftPanel.width}px; border-right: 1px solid var(--upaint-border); background: var(--upaint-surface);"
    aria-label="Generation settings"
    hidden={leftPanel.collapsed}
  >
    <GenerationPanel />
  </aside>

  {#if !leftPanel.collapsed}
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize generation settings"
      class="w-1 h-full shrink-0 cursor-col-resize hover:bg-(--upaint-accent)"
      use:onDrag={{ orientation: "vertical" }}
      onsepDragStart={() => (leftDragStartWidth = leftPanel.width)}
      onsepDrag={(e) => uiLayoutStore.setSidePanelWidth("left", leftDragStartWidth + e.detail)}
    ></div>
  {/if}

  <div class="flex min-w-0 flex-1 flex-col gap-1 p-1">
    <div id="upaint-root-toolbar" class="shrink-0">
      <PaintToolbar />
    </div>
    <div class="flex min-h-0 flex-1 gap-1">
      <ToolRail />
      <div class="relative min-w-0 flex-1">
        <div id="upaint-root" class="h-full w-full"></div>
        <BoundaryInfoOverlay />
        <ViewportControls />
        <GenerationPreviewBar />
        <FilterBar />
        <PasteMenu
          open={pasteFile !== null}
          onChoose={handlePasteChoice}
          onCancel={closePasteMenu}
        />
      </div>
    </div>
  </div>

  {#if !rightPanel.collapsed}
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize layers panel"
      class="w-1 h-full shrink-0 cursor-col-resize hover:bg-(--upaint-accent)"
      use:onDrag={{ orientation: "vertical" }}
      onsepDragStart={() => (rightDragStartWidth = rightPanel.width)}
      onsepDrag={(e) => uiLayoutStore.setSidePanelWidth("right", rightDragStartWidth - e.detail)}
    ></div>
  {/if}

  <aside
    id="upaint-root-panel"
    class="shrink-0 overflow-y-auto"
    style="width: {rightPanel.width}px; border-left: 1px solid var(--upaint-border); background: var(--upaint-surface);"
    aria-label="Layers"
    hidden={rightPanel.collapsed}
  >
    <LayerPanel />
  </aside>
</div>

<ToastViewport />
